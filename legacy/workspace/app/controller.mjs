import { createModalManager } from './dialogs.mjs';
import { createPlanningStore } from './planning.mjs';
import { parseSrt, planClips, validateClip, fmtTime, csv } from '../domain.mjs';
import { inspectVideo as inspectSource, renderBrowserClip as renderSource } from '../video-engine.mjs';
import { createWorkspaceStore, createRuntimeState, validateWorkspace, emptyWorkspace, uid, number } from './workspace.mjs';
import * as metrics from './metrics.mjs';
import { validateReportImport } from './imports.mjs';
import { createApiClient, normalizeBaseUrl } from './api-client.mjs';
import { createHashRouter } from './routing.mjs';
import { esc, jobsHtml, jobStatus, actionLabel } from './ui.mjs';
import { renderShell, pageRenderers } from './views.mjs';

/** Browser effects are injected so regressions exercise actual imported modules. */
export function createController(adapters = {}) {
  const document = adapters.document || globalThis.document;
  const window = adapters.window || globalThis.window;
  const localStorage = adapters.localStorage || globalThis.localStorage;
  const sessionStorage = adapters.sessionStorage || globalThis.sessionStorage;
  const inspectVideo = adapters.inspectVideo || inspectSource;
  const renderBrowserClip = adapters.renderBrowserClip || renderSource;
  const modal = createModalManager(document);
  const store = createWorkspaceStore(localStorage);
  let workspace = store.current;
  const planningStore = createPlanningStore(localStorage);
  const state = createRuntimeState(sessionStorage);
  state.planning = {
    ...state.planning,
    ...planningStore.current
  };
  state.restoreError = store.restoreError;
  if (workspace.srt) state.segments = parseSrt(workspace.srt);
  const client = createApiClient({
    getConnection: () => state.backend,
    fetch: adapters.fetch || globalThis.fetch
  });
  const api = adapters.api || client.request;
  const router = createHashRouter({
    window,
    onNavigate: page => {
      state.page = page;
      state.navOpen = false;
      render();
      window.scrollTo?.(0, 0);
    }
  });
  const totals = (demo = false) => metrics.totals(workspace, demo);
  const campaignMetric = c => metrics.campaignMetric(workspace, c);
  const budgetMetric = c => metrics.budgetMetric(workspace, c);
  const advice = c => metrics.advice(workspace, c);
  const model = () => ({
    workspace,
    state,
    totals,
    campaignMetric,
    advice
  });
  function save() {
    store.save();
  }
  function render() {
    capturePlanning();
    const active = document.activeElement;
    const focused = active?.id;
    const caret = typeof active?.selectionStart === 'number' ? {
      start: active.selectionStart,
      end: active.selectionEnd
    } : null;
    const drafts = ['backend-url', 'backend-token'].map(id => ({
      id,
      value: document.getElementById(id)?.value
    }));
    const player = document.getElementById('video-player');
    const playback = player && player.getAttribute?.('src') === state.video?.url ? {
      time: player.currentTime,
      paused: player.paused
    } : null;
    const app = document.getElementById('app');
    if (app) app.innerHTML = renderShell(model());
    for (const draft of drafts) {
      const input = document.getElementById(draft.id);
      if (input && draft.value !== undefined) input.value = draft.value;
    }
    const next = document.getElementById(focused);
    next?.focus?.({
      preventScroll: true
    });
    if (caret) next?.setSelectionRange?.(caret.start, caret.end);
    if (playback) {
      const current = document.getElementById('video-player');
      if (current) {
        current.currentTime = playback.time;
        if (!playback.paused) current.play?.().catch(() => {});
      }
    }
  }
  function capturePlanning() {
    for (const [id, key] of [['clip-count', 'count'], ['clip-min', 'minDuration'], ['clip-max', 'maxDuration'], ['clip-strategy', 'strategy'], ['output-format', 'format']]) {
      const input = document.getElementById(id);
      if (input) state.planning[key] = input.value;
    }
    const ai = document.getElementById('use-ai');
    if (ai) state.planning.useAi = ai.checked;
    const advanced = document.getElementById('studio-advanced');
    if (advanced) state.planning.advancedOpen = advanced.open;
    planningStore.save(state.planning);
  }
  function setPage(page) {
    if (state.page === page) {
      state.navOpen = false;
      render();
      return;
    }
    router.navigate(page);
  }
  function invalidateSource() {
    state.sourceRevision++;
    state.sourceController.abort();
    state.sourceController = new AbortController();
    state.uploadPromise = null;
    state.serverAssetId = null;
  }
  function assertSource(revision, connection = state.backend.revision) {
    if (revision !== state.sourceRevision || connection !== state.backend.revision) throw new Error('原始素材或生产服务已更换，旧请求结果已忽略。');
  }
  function log(title, detail = '', type = 'file') {
    workspace.events.unshift({
      id: uid('event'),
      title,
      detail,
      date: new Date().toISOString(),
      type
    });
    workspace.events = workspace.events.slice(0, 100);
    save();
  }
  function toast(msg) {
    if (adapters.toast) {
      adapters.toast(msg);
      return;
    }
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('visible'), 4500);
  }
  function bind() {
    const root = document.getElementById('app');
    if (!root || root.dataset?.bound) return;
    if (root.dataset) root.dataset.bound = 'true';
    root.addEventListener?.('click', event => {
      const target = event.target.closest?.('[data-page],[data-action]');
      if (!target || !root.contains?.(target) || target.disabled) return;
      event.preventDefault();
      if (target.dataset.page) setPage(target.dataset.page);else runAction(target.dataset.action, target);
    });
    root.addEventListener?.('input', event => {
      const input = event.target;
      if (input.id === 'srt-text') state.srtDraft = input.value;
      if (input.id === 'campaign-search') {
        state.campaignSearch = input.value;
        render();
        return;
      }
      capturePlanning();
    });
    root.addEventListener?.('change', event => {
      const input = event.target;
      switch (input.id) {
        case 'video-file':
          selectVideo(input.files[0]);
          return;
        case 'srt-file':
          loadSrtFile(input.files[0]);
          return;
        case 'csv-file':
          importCsv(input.files[0]);
          return;
        case 'workspace-file':
          importWorkspace(input.files[0]);
          return;
        case 'queue-filter':
          state.queueFilter = input.value;
          render();
          return;
        case 'srt-text':
          try {
            const text = input.value;
            const segments = text.trim() ? parseSrt(text) : [];
            workspace.srt = text;
            state.segments = segments;
            state.srtDraft = null;
            save();
            toast(`已保存字幕，共 ${state.segments.length} 条。`);
          } catch (err) {
            toast(err.message + ' 原先有效的字幕仍然保留。');
          }
          return;
      }
      if (input.classList?.contains('clip-select')) {
        const clip = workspace.clipPlans.find(c => c.id === input.dataset.id);
        if (clip) {
          clip.selected = input.checked;
          save();
          input.closest('.clip')?.classList.toggle('selected', input.checked);
        }
      }
      if (input.classList?.contains('clip-time')) {
        const clip = workspace.clipPlans.find(c => c.id === input.dataset.id);
        if (!clip) return;
        const value = Number(input.value),
          next = {
            ...clip,
            [input.dataset.field]: value
          };
        if (!Number.isFinite(value) || next.start < 0 || next.end <= next.start || workspace.asset && next.end > workspace.asset.duration + .1) {
          input.value = clip[input.dataset.field];
          toast('时间范围无效：需满足 0 ≤ 开始 < 结束 ≤ 视频时长。');
          return;
        }
        clip[input.dataset.field] = value;
        clip.text = state.segments.filter(segment => segment.end > clip.start && segment.start < clip.end).map(segment => segment.text).join(' ');
        save();
        toast('已更新片段边界。');
      }
      capturePlanning();
    });
    root.addEventListener?.('toggle', event => {
      if (event.target.id === 'studio-advanced') {
        state.planning.advancedOpen = event.target.open;
        planningStore.save(state.planning);
      }
    }, true);
    root.addEventListener?.('timeupdate', event => {
      const player = event.target;
      if (player.id === 'video-player' && state.previewEnd !== null && player.currentTime >= state.previewEnd) {
        player.pause();
        state.previewEnd = null;
      }
    }, true);
  }
  async function runAction(action, el) {
    const pageMap = {
      'to-studio': 'studio',
      'to-quality': 'quality',
      'to-campaigns': 'campaigns'
    };
    if (pageMap[action]) {
      setPage(pageMap[action]);
      return;
    }
    const id = el?.dataset.id;
    try {
      switch (action) {
        case 'toggle-nav':
          state.navOpen = !state.navOpen;
          render();
          break;
        case 'close-nav':
          state.navOpen = false;
          render();
          break;
        case 'load-demo':
          await loadDemo();
          break;
        case 'clear-demo':
          clearDemo();
          break;
        case 'plan-local':
          generatePlans(false);
          break;
        case 'plan-server':
          {
            const useAi = state.planning.useAi === true;
            await busy(el, () => generateServerPlans(useAi));
            break;
          }
        case 'plan-ai':
          await busy(el, () => generateServerPlans(true));
          break;
        case 'transcribe-server':
          await busy(el, transcribeServer);
          break;
        case 'add-clip':
          addClip();
          break;
        case 'delete-clip':
          workspace.clipPlans = workspace.clipPlans.filter(c => c.id !== id);
          save();
          render();
          break;
        case 'preview-clip':
          previewClip(id);
          break;
        case 'render-clip':
          await exportClip(id);
          break;
        case 'cancel-render':
          state.renderController?.abort();
          break;
        case 'download-output':
          downloadOutput(Number(el.dataset.index));
          break;
        case 'download-output-report':
          downloadOutputReport(Number(el.dataset.index));
          break;
        case 'export-plans':
          downloadJson({
            version: 1,
            asset: workspace.asset,
            clips: workspace.clipPlans
          }, 'BXAGI_Clip_Plans.json');
          break;
        case 'queue-selected':
          await busy(el, submitQueue);
          break;
        case 'refresh-jobs':
          await busy(el, () => refreshJobs(true));
          break;
        case 'job-detail':
          await busy(el, () => jobDetail(id));
          break;
        case 'job-download':
          await busy(el, () => jobDownload(id));
          break;
        case 'health':
          await busy(el, () => checkHealth(true));
          break;
        case 'save-backend':
          saveBackend();
          await busy(el, () => checkHealth(true));
          break;
        case 'new-campaign':
          campaignModal();
          break;
        case 'edit-campaign':
          campaignModal(id);
          break;
        case 'toggle-campaign':
          toggleCampaign(id);
          break;
        case 'import-csv':
          document.getElementById('csv-file')?.click();
          break;
        case 'csv-template':
          download(new Blob([csv([{
            campaign: '你的计划名称',
            spend: 100,
            revenue: 250,
            conversions: 5,
            date: new Date().toLocaleDateString('sv-SE'),
            data_fresh: 'true'
          }])], {
            type: 'text/csv;charset=utf-8'
          }), 'BXAGI_Import_Template.csv');
          break;
        case 'export-campaigns':
          exportCampaigns();
          break;
        case 'export-insights':
          downloadJson({
            generatedAt: new Date().toISOString(),
            dataType: '手动导入',
            summary: totals(),
            campaigns: workspace.campaigns.filter(c => !c.demo).map(c => ({
              ...c,
              metrics: campaignMetric(c),
              recommendation: advice(c)
            }))
          }, 'BXAGI_Growth_Report.json');
          break;
        case 'export-workspace':
          downloadJson(workspace, 'BXAGI_Workspace.json');
          toast('工作区已导出，不含视频文件或 API 令牌。');
          break;
        case 'import-workspace':
          document.getElementById('workspace-file')?.click();
          break;
        case 'reset-workspace':
          if (await confirmDialog('清空本地工作区', '这会删除当前浏览器保存的字幕、片段计划、投放计划和报表。服务端任务不受影响。', '清空数据', true)) resetWorkspace();
          break;
      }
    } catch (err) {
      toast(err.message || '操作失败，请检查输入。');
    }
  }
  async function busy(el, fn) {
    const label = el?.innerHTML;
    if (el) {
      el.disabled = true;
      el.setAttribute?.('aria-busy', 'true');
      el.textContent = '处理中…';
    }
    try {
      return await fn();
    } finally {
      if (el && el.isConnected) {
        el.disabled = false;
        el.removeAttribute?.('aria-busy');
        el.innerHTML = label;
      }
    }
  }
  async function selectVideo(file) {
    if (!file) return;
    if (state.rendering) {
      toast('请先完成或取消当前录制。');
      return;
    }
    const revision = state.sourceRevision + 1;
    invalidateSource();
    try {
      const v = await inspectVideo(file);
      try {
        assertSource(revision);
      } catch (error) {
        if (v.url) URL.revokeObjectURL(v.url);
        throw error;
      }
      const previousName = workspace.asset?.name;
      const same = workspace.asset && workspace.asset.name === file.name && Math.abs(workspace.asset.duration - v.duration) < .25 && (!workspace.asset.size || workspace.asset.size === file.size) && workspace.asset.width === v.width && workspace.asset.height === v.height;
      if (state.video?.url) URL.revokeObjectURL(state.video.url);
      state.video = v;
      state.file = file;
      state.serverAssetId = null;
      state.outputs = [];
      workspace.asset = {
        name: file.name,
        duration: v.duration,
        width: v.width,
        height: v.height,
        size: file.size
      };
      if (!same) {
        workspace.clipPlans = [];
        if (previousName && !same) {
          workspace.srt = '';
          state.srtDraft = null;
          state.segments = [];
        }
      }
      workspace.demo = workspace.campaigns.some(c => c.demo);
      log('已导入原始视频', `${file.name} · ${fmtTime(v.duration)} · ${v.width}×${v.height}`, 'video');
      render();
      toast(same ? '原始视频已重新加载，保留已保存的片段计划。' : '视频已加载。导入对应 SRT 或手动创建片段。');
    } catch (err) {
      toast(err.message || '无法读取视频元数据，请更换格式或使用生产服务。');
    }
  }
  async function loadSrtFile(file) {
    if (!file) return;
    const revision = state.sourceRevision;
    try {
      const srt = await file.text();
      assertSource(revision);
      const segments = parseSrt(srt);
      workspace.srt = srt;
      state.srtDraft = null;
      state.segments = segments;
      log('已导入时间轴字幕', `${file.name} · ${segments.length} 条`, 'file');
      render();
      toast(`字幕已解析，共 ${segments.length} 条。`);
    } catch (err) {
      toast(err.message);
    }
  }
  function options() {
    capturePlanning();
    const {
      count: rawCount,
      minDuration: rawMin,
      maxDuration: rawMax,
      strategy
    } = state.planning;
    const count = Number(rawCount),
      minDuration = Number(rawMin),
      maxDuration = Number(rawMax);
    if (!Number.isInteger(count) || count < 1 || count > 20 || !Number.isFinite(minDuration) || !Number.isFinite(maxDuration) || minDuration < 1 || maxDuration < minDuration || maxDuration > 600) throw new Error('请输入 1–20 个片段，且 1 ≤ 最短时长 ≤ 最长时长 ≤ 600 秒。');
    return {
      count,
      minDuration,
      maxDuration,
      strategy,
      duration: workspace.asset?.duration || Infinity
    };
  }
  function readSrt() {
    const input = document.getElementById('srt-text');
    const text = input ? input.value : workspace.srt;
    const segments = text.trim() ? parseSrt(text) : [];
    workspace.srt = text;
    state.segments = segments;
    save();
    return state.segments;
  }
  function generatePlans() {
    if (!workspace.asset) throw new Error('请先选择真实视频。');
    readSrt();
    if (!state.segments.length) throw new Error('请先导入或粘贴完整 SRT 字幕。');
    const opts = options(),
      plans = planClips(state.segments, opts);
    if (!plans.length) throw new Error('没有符合时长与完整语句条件的片段。请调整时长，或补充真实 SRT 的句末标点。');
    workspace.clipPlans = plans.map(c => ({
      ...c,
      selected: true,
      demo: false
    }));
    log('已生成片段计划', `${plans.length} 条 · 字幕规则规划`, 'layers');
    render();
    toast(`已生成 ${plans.length} 条片段计划，可调整时间后预览。`);
  }
  function addClip() {
    if (workspace.clipPlans.length >= 200) throw new Error('最多保存 200 个片段，请先导出并清理旧计划。');
    if (!workspace.asset) throw new Error('请先选择真实视频。');
    const start = number(document.getElementById('video-player')?.currentTime, 0),
      end = Math.min(start + Math.min(15, workspace.asset.duration), workspace.asset.duration);
    if (end <= start) throw new Error('播放位置已到视频末尾，请移到前面。');
    workspace.clipPlans.push({
      id: uid('clip'),
      title: `手动片段 ${workspace.clipPlans.length + 1}`,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      text: state.segments.filter(s => s.end > start && s.start < end).map(s => s.text).join(' '),
      strategy: 'manual',
      score: 0,
      selected: true,
      demo: false
    });
    save();
    render();
    toast('已按当前播放位置创建片段，可修改秒数。');
  }
  function previewClip(id) {
    const c = workspace.clipPlans.find(c => c.id === id),
      v = document.getElementById('video-player');
    if (!c || !v) throw new Error('请重新选择对应的视频文件。');
    state.previewEnd = c.end;
    v.currentTime = c.start;
    v.play().catch(() => toast('请点击视频播放器开始播放。'));
    v.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }
  async function exportClip(id) {
    const clip = workspace.clipPlans.find(c => c.id === id);
    if (!clip) throw new Error('片段不存在。');
    if (!state.file || !state.video) throw new Error('请重新选择原始视频文件。视频字节不保存在浏览器工作区。');
    if (clip.demo) throw new Error('演示计划不能直接生产，请上传真实视频生成自己的片段。');
    if (state.rendering) throw new Error('当前已有录制任务。');
    if (clip.end > state.video.duration + .1 || clip.start < 0 || clip.end <= clip.start) throw new Error('片段边界超出实际视频范围。');
    capturePlanning();
    const format = state.planning.format;
    state.rendering = true;
    state.renderProgress = 0;
    state.renderController = new AbortController();
    render();
    try {
      const result = await renderBrowserClip(state.file, clip, {
        format,
        signal: state.renderController.signal,
        onProgress: p => {
          state.renderProgress = Math.max(0, Math.min(1, number(p) / 100));
          const bar = document.getElementById('render-progress'),
            label = document.getElementById('render-percent');
          if (bar) bar.style.width = `${state.renderProgress * 100}%`;
          if (label) label.textContent = `${Math.round(state.renderProgress * 100)}%`;
        }
      });
      if (!result.blob || !result.blob.size) throw new Error('导出文件为空，请检查浏览器支持。');
      const report = {
        version: 1,
        type: 'browser-draft',
        productionPassed: false,
        source: workspace.asset,
        clip: {
          ...clip
        },
        output: {
          mimeType: result.mimeType,
          size: result.blob.size,
          duration: result.duration,
          width: result.width,
          height: result.height
        },
        planChecks: validateClip(clip, state.segments, state.video.duration),
        mediaGate: 'unverified',
        note: '浏览器实际录制草稿，未完成生产服务媒体解码验收。',
        createdAt: new Date().toISOString()
      };
      state.outputs.unshift({
        ...result,
        title: clip.title,
        report
      });
      log('浏览器草稿已导出', `${clip.title} · ${(result.blob.size / 1048576).toFixed(2)} MB · 未正式验收`, 'video');
      toast('已生成实际视频草稿，点击下载视频。');
    } catch (err) {
      toast(err.name === 'AbortError' ? '录制已取消。' : err.message || '录制失败。');
    } finally {
      state.rendering = false;
      state.renderController = null;
      render();
    }
  }
  function safeFilename(title) {
    return String(title || 'BXAGI_Clip').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 90);
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function downloadJson(value, name) {
    download(new Blob([JSON.stringify(value, null, 2)], {
      type: 'application/json;charset=utf-8'
    }), name);
  }
  function downloadOutput(i) {
    const o = state.outputs[i];
    if (!o) throw new Error('当前页面没有该输出文件，请重新生产。');
    download(o.blob, `${safeFilename(o.title)}_draft.${o.extension || 'webm'}`);
  }
  function downloadOutputReport(i) {
    const o = state.outputs[i];
    if (!o) throw new Error('验收报告不存在。');
    downloadJson(o.report, `${safeFilename(o.title)}_draft_report.json`);
  }
  function saveBackend() {
    const url = normalizeBaseUrl(document.getElementById('backend-url')?.value || '');
    const token = document.getElementById('backend-token')?.value.trim() || '';
    client.abortAll();
    clearTimeout(state.pollTimer);
    state.serverAssetId = null;
    state.jobs = [];
    state.backend = {
      ...state.backend,
      url,
      token,
      healthy: false,
      checked: false,
      llmConfigured: false,
      asrConfigured: false,
      revision: state.backend.revision + 1
    };
    sessionStorage.setItem('bxagi.api.url', url);
    sessionStorage.setItem('bxagi.api.token', token);
  }
  async function checkHealth(explicit = false) {
    const revision = state.backend.revision;
    const attempt = state.healthAttempt = (state.healthAttempt || 0) + 1;
    try {
      const data = await api('/api/health', {
        timeout: 10000
      });
      if (data.auth_required) {
        if (!state.backend.token) throw new Error('生产服务要求 API 令牌，请在设置中填写后重试。');
        await api('/api/capabilities', {
          timeout: 10000
        });
      }
      if (revision !== state.backend.revision || attempt !== state.healthAttempt) return false;
      state.backend.healthy = true;
      state.backend.llmConfigured = data.llm_configured === true;
      state.backend.asrConfigured = data.asr_configured === true;
      state.backend.checked = true;
      state.backend.detail = `已连接：${data.service || data.name || 'BXAGI 生产服务'}${data.ffmpeg === false ? ' · FFmpeg 依赖缺失' : ''}${data.version ? ' · ' + data.version : ''}`;
      if (explicit) {
        await refreshJobs(false);
        toast('生产服务连接成功。');
      }
      render();
      return true;
    } catch (err) {
      if (revision !== state.backend.revision || attempt !== state.healthAttempt) return false;
      state.backend.healthy = false;
      state.backend.llmConfigured = false;
      state.backend.asrConfigured = false;
      state.backend.checked = explicit;
      state.backend.detail = err.message;
      if (explicit) {
        render();
        toast(`连接失败：${err.message}`);
      }
      return false;
    }
  }
  async function uploadAsset() {
    const revision = state.sourceRevision,
      connection = state.backend.revision;
    if (!state.backend.healthy && !(await checkHealth(false))) throw new Error('生产服务尚未连接。请在设置中配置地址，或先下载并启动服务。');
    assertSource(revision, connection);
    if (!state.file) throw new Error('请先选择原始视频。');
    if (state.serverAssetId) return state.serverAssetId;
    if (state.uploadPromise?.revision === revision) return state.uploadPromise.promise;
    const file = state.file;
    const promise = (async () => {
      toast('正在上传真实视频到生产服务…');
      const asset = await api('/api/assets', {
        method: 'POST',
        body: file,
        raw: true,
        timeout: 600000,
        signal: state.sourceController.signal,
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(file.name)
        }
      });
      assertSource(revision, connection);
      if (!asset.id) throw new Error('上传结果缺少素材 ID。');
      state.serverAssetId = asset.id;
      log('已上传素材到生产服务', file.name, 'server');
      return asset.id;
    })();
    state.uploadPromise = {
      revision,
      promise
    };
    try {
      return await promise;
    } finally {
      if (state.uploadPromise?.promise === promise) state.uploadPromise = null;
    }
  }
  async function syncAsset() {
    const revision = state.sourceRevision,
      connection = state.backend.revision;
    readSrt();
    if (!state.segments.length) throw new Error('正式生产需要完整 SRT 字幕。');
    const srt = workspace.srt;
    const assetId = await uploadAsset();
    assertSource(revision, connection);
    await api(`/api/assets/${encodeURIComponent(assetId)}/transcript`, {
      method: 'POST',
      body: {
        srt
      },
      signal: state.sourceController.signal
    });
    assertSource(revision, connection);
    if (workspace.srt !== srt || state.srtDraft !== null) throw new Error('字幕已修改，请重新提交当前字幕。');
    return assetId;
  }
  async function transcribeServer() {
    const revision = state.sourceRevision,
      connection = state.backend.revision,
      previousSrt = workspace.srt;
    if (!state.backend.asrConfigured) throw new Error('服务端未配置本地转写模型。请安装 faster-whisper，并设置 BX_WHISPER_MODEL 为本地模型目录。');
    const assetId = await uploadAsset();
    toast('正在使用服务端本地模型转写，请保持页面打开…');
    const result = await api(`/api/assets/${encodeURIComponent(assetId)}/transcribe`, {
      method: 'POST',
      body: {
        engine: 'local'
      },
      timeout: 600000,
      signal: state.sourceController.signal
    });
    assertSource(revision, connection);
    if (workspace.srt !== previousSrt || state.srtDraft !== null) throw new Error('字幕已手动修改，旧转写结果未覆盖当前内容。');
    if (typeof result.srt !== 'string') throw new Error('转写接口没有返回有效 SRT。');
    const segments = parseSrt(result.srt);
    workspace.srt = result.srt;
    state.srtDraft = null;
    state.segments = segments;
    log('本地模型自动转写完成', `${segments.length} 条字幕 · 需要人工校对`, 'file');
    render();
    toast('自动转写完成，请校对文本、标点与时间轴。');
  }
  async function generateServerPlans(useAi = false) {
    const revision = state.sourceRevision,
      connection = state.backend.revision;
    if (useAi && !state.backend.llmConfigured) throw new Error('模型接口尚未配置，请在服务端设置 BX_MODEL_ENABLED、BX_MODEL_BASE_URL、BX_MODEL_API_KEY 与 BX_MODEL_NAME。');
    const opts = options();
    if (useAi && (opts.count > 12 || opts.maxDuration > 300)) throw new Error('模型规划最多 12 个片段，最长 300 秒。');
    const assetId = await syncAsset();
    const expectedSrt = workspace.srt;
    assertSource(revision, connection);
    const result = await api(`/api/assets/${encodeURIComponent(assetId)}/plan`, {
      method: 'POST',
      body: {
        count: opts.count,
        min_duration: opts.minDuration,
        max_duration: opts.maxDuration,
        strategy: opts.strategy,
        use_ai: useAi
      },
      timeout: 120000,
      signal: state.sourceController.signal
    });
    assertSource(revision, connection);
    if (workspace.srt !== expectedSrt || state.srtDraft !== null) throw new Error('字幕已修改，旧规划结果未覆盖当前计划。');
    if (!Array.isArray(result.clips) || !result.clips.length) throw new Error('服务没有生成符合条件的片段，请检查字幕完整语句与时长条件。');
    if (result.clips.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start || c.end > workspace.asset.duration + .1)) throw new Error('服务端返回的片段时间无效。');
    workspace.clipPlans = result.clips.map((c, i) => ({
      ...c,
      id: String(c.id || uid('clip')),
      title: c.title || `服务端片段 ${i + 1}`,
      selected: true,
      demo: false
    }));
    log(useAi ? '模型语义规划完成' : '服务端规则规划完成', `${result.clips.length} 条 · ${result.engine || '字幕规则'}`, 'server');
    render();
    toast('服务端片段计划已生成。');
  }
  async function submitQueue() {
    const revision = state.sourceRevision,
      connection = state.backend.revision;
    const clips = workspace.clipPlans.filter(c => c.selected && !c.demo).map(c => ({
      ...c
    }));
    if (!clips.length) throw new Error('请先选择自己的真实片段计划。');
    for (const c of clips) {
      const r = validateClip(c, state.segments, workspace.asset?.duration || Infinity);
      if (!r.sentencePassed && r.errors?.length) throw new Error(`${c.title} 尚未通过句界检查：${r.errors.join('；')}`);
    }
    capturePlanning();
    const format = state.planning.format;
    const assetId = await syncAsset();
    assertSource(revision, connection);
    const result = await api('/api/jobs', {
      method: 'POST',
      body: {
        asset_id: assetId,
        title: clips.length === 1 ? clips[0].title : `${workspace.asset.name} · ${clips.length} 个片段`,
        clips: clips.map(c => ({
          start: c.start,
          end: c.end
        })),
        format,
        burn_subtitles: false
      },
      signal: state.sourceController.signal
    });
    assertSource(revision, connection);
    log('已提交真实生产任务', `${result.id} · ${clips.length} 个片段`, 'server');
    await refreshJobs(false);
    render();
    toast('任务已提交到生产队列。验收通过后才能下载正式 MP4。');
  }
  async function refreshJobs(explicit = false) {
    if (!state.backend.healthy && !(await checkHealth(false))) {
      if (explicit) throw new Error('未连接生产服务，请先在设置中配置。');
      return;
    }
    const result = await api('/api/jobs');
    state.jobs = Array.isArray(result.jobs) ? result.jobs : [];
    clearTimeout(state.pollTimer);
    if (state.jobs.some(j => ['queued', 'running', 'processing'].includes(j.status))) state.pollTimer = setTimeout(async () => {
      try {
        await refreshJobs(false);
        const list = document.getElementById('jobs-list');
        if (list) {
          list.innerHTML = jobsHtml(state);
        }
      } catch {
        state.backend.healthy = false;
      }
    }, 4000);
    if (explicit) {
      render();
      toast('生产队列已更新。');
    }
  }
  async function jobDetail(id) {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    const gates = job.gates || job.checks || job.validation || {};
    const checks = Array.isArray(gates.checks) ? gates.checks : [];
    const labels = {
      sentence_boundary: '语句完整与边界',
      media_decode: '成片完整解码'
    };
    let html = `<p>任务状态：<strong>${esc(jobStatus(job.status))}</strong></p>`;
    if (job.error) html += `<p class="error-text">${esc(typeof job.error === 'string' ? job.error : JSON.stringify(job.error))}</p>`;
    html += checks.length ? `<div class="check-list">${checks.map(check => `<div class="check ${check.status === 'pass' ? 'pass' : check.status === 'fail' ? 'fail' : ''}"><span class="check-sign">${check.status === 'pass' ? '✓' : check.status === 'fail' ? '×' : '?'}</span><div><strong>${esc(labels[check.name] || check.name || '验收项目')}</strong><p>${esc(check.detail || '等待验收结果')}</p></div><span class="badge ${check.status === 'pass' ? 'green' : check.status === 'fail' ? 'red' : 'orange'}">${check.status === 'pass' ? '通过' : check.status === 'fail' ? '失败' : '待验证'}</span></div>`).join('')}</div>` : '<p class="fine">尚无验收报告。任务完成后将显示语句与成片检查结果。</p>';
    html += `<details class="studio-advanced"><summary>查看原始验收报告</summary><pre class="fine" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify(gates, null, 2))}</pre></details><p class="fine">正式视频下载由服务端验收结果开放。</p>`;
    showModal('生产任务验收', html, [{
      label: '关闭',
      value: 'close'
    }]);
  }
  async function jobDownload(id) {
    const blob = await api(`/api/jobs/${encodeURIComponent(id)}/download`, {
      binary: true,
      timeout: 120000
    });
    download(blob, `BXAGI_${safeFilename(id)}.mp4`);
    toast('已下载服务端正式视频文件。');
  }
  function showModal(title, body, buttons) {
    return modal.mount(title, body, buttons).result;
  }
  async function confirmDialog(title, text, label = '确定', danger = false) {
    if (adapters.confirmDialog) return adapters.confirmDialog(title, text, label, danger);
    return (await showModal(title, `<p>${esc(text)}</p>`, [{
      label: '取消',
      value: 'cancel'
    }, {
      label,
      value: 'confirm',
      primary: !danger,
      danger
    }])) === 'confirm';
  }
  function campaignModal(id) {
    if (!id && workspace.campaigns.length >= 1000) {
      toast('工作区最多保存 1,000 个计划，请先导出并清理。');
      return;
    }
    const c = workspace.campaigns.find(c => c.id === id) || {
      name: '',
      dailyBudget: 100,
      targetRoi: 2,
      maxDailyBudget: 1000,
      minSpend: 100,
      status: 'paused'
    };
    const root = document.getElementById('modal-root');
    modal.dismiss();
    root.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h2 id="modal-title">${id ? '编辑本地投放计划' : '新建本地投放计划'}</h2><form id="campaign-form"><div class="field"><label for="campaign-name">计划名称</label><input id="campaign-name" name="name" required maxlength="200" value="${esc(c.name)}" placeholder="例如：秋季内容测试"></div><div class="field-row"><div class="field"><label for="campaign-budget">日预算 / 元</label><input id="campaign-budget" name="dailyBudget" type="number" min="0" step="0.01" required value="${c.dailyBudget}"></div><div class="field"><label for="campaign-roi">目标 ROI</label><input id="campaign-roi" name="targetRoi" type="number" min="0.01" step="0.01" required value="${c.targetRoi}"></div></div><div class="field-row"><div class="field"><label for="campaign-max">日预算上限 / 元</label><input id="campaign-max" name="maxDailyBudget" type="number" min="0" step="0.01" required value="${c.maxDailyBudget}"></div><div class="field"><label for="campaign-min">最低观察消耗 / 元</label><input id="campaign-min" name="minSpend" type="number" min="0" step="0.01" required value="${c.minSpend}"></div></div><p class="fine">保存仅修改当前浏览器中的计划，不对广告平台执行操作。</p><p id="campaign-error" class="error-text" role="alert"></p><div class="actions"><button class="btn" type="button" id="campaign-cancel">取消</button>${id ? '<button class="btn danger" type="button" id="campaign-delete">删除</button>' : ''}<button class="btn primary" type="submit">保存计划</button></div></form></section></div>`;
    const {
      close
    } = modal.activate(root);
    root.querySelector('#campaign-cancel').onclick = close;
    root.querySelector('.modal-backdrop').onclick = e => {
      if (e.target === e.currentTarget) close();
    };
    root.querySelector('#campaign-name').focus();
    root.querySelector('#campaign-form').onsubmit = e => {
      e.preventDefault();
      const form = new FormData(e.target),
        name = String(form.get('name')).trim(),
        dailyBudget = Number(form.get('dailyBudget')),
        targetRoi = Number(form.get('targetRoi')),
        maxDailyBudget = Number(form.get('maxDailyBudget')),
        minSpend = Number(form.get('minSpend'));
      if (!name || ![dailyBudget, targetRoi, maxDailyBudget, minSpend].every(Number.isFinite) || dailyBudget < 0 || targetRoi <= 0 || maxDailyBudget < dailyBudget || minSpend < 0) {
        root.querySelector('#campaign-error').textContent = '请输入有效数值；预算上限不能低于日预算。';
        return;
      }
      const updated = {
        id: id || uid('campaign'),
        name,
        dailyBudget,
        targetRoi,
        maxDailyBudget,
        minSpend,
        status: c.status,
        demo: c.demo === true
      };
      if (id) workspace.campaigns = workspace.campaigns.map(v => v.id === id ? updated : v);else workspace.campaigns.push(updated);
      log(id ? '已更新本地投放计划' : '已创建本地投放计划', name, 'send');
      close();
      render();
      toast('投放计划已保存，仅本地生效。');
    };
    const del = root.querySelector('#campaign-delete');
    if (del) del.onclick = async () => {
      if (await confirmDialog('删除本地计划', '删除计划会同时移除本工作区中与它关联的导入数据，不影响平台。', '删除计划', true)) {
        workspace.campaigns = workspace.campaigns.filter(c => c.id !== id);
        workspace.metrics = workspace.metrics.filter(m => m.campaignId !== id);
        log('已删除本地投放计划', c.name, 'send');
        render();
        toast('本地计划已删除。');
      }
    };
  }
  function toggleCampaign(id) {
    const c = workspace.campaigns.find(c => c.id === id);
    if (!c) return;
    c.status = c.status === 'running' ? 'paused' : 'running';
    log(`本地计划${c.status === 'running' ? '已启用' : '已暂停'}`, `${c.name} · 未对广告平台执行`, 'send');
    render();
    toast('状态已更新，仅本地生效；未执行广告请求。');
  }
  async function importCsv(file) {
    if (!file) return;
    try {
      if (file.size > 10000000) throw new Error('CSV 超过 10 MB，请分批导入。');
      const text = await file.text();
      const parsed = validateReportImport(workspace, text, file.name);
      if (!(await confirmDialog('导入真实投放报表', `已验证 ${parsed.length} 条记录。导入将追加数据；重复导入相同报表会重复计数，请确认没有导入过该批记录。`, '导入记录'))) return;
      validateReportImport(workspace, text, file.name);
      const campaignsByName = new Map(workspace.campaigns.filter(c => !c.demo).map(c => [c.name, c]));
      for (const row of parsed) {
        let c = campaignsByName.get(row.name);
        if (!c) {
          c = {
            id: uid('campaign'),
            name: row.name,
            dailyBudget: 100,
            targetRoi: 2,
            maxDailyBudget: 1000,
            minSpend: 100,
            status: 'paused',
            demo: false
          };
          workspace.campaigns.push(c);
          campaignsByName.set(c.name, c);
        }
        workspace.metrics.push({
          ...row,
          id: uid('metric'),
          campaignId: c.id,
          source: file.name,
          importedAt: new Date().toISOString(),
          demo: false
        });
      }
      log('已导入真实投放报表', `${file.name} · ${parsed.length} 条记录`, 'chart');
      render();
      toast(`已导入 ${parsed.length} 条记录。缺失转化保留为未知。`);
    } catch (err) {
      toast(err.message);
    }
  }
  function exportCampaigns() {
    const rows = workspace.campaigns.map(c => {
      const m = campaignMetric(c),
        a = advice(c);
      return {
        campaign: c.name,
        status: c.status,
        daily_budget: c.dailyBudget,
        target_roi: c.targetRoi,
        spend: m.spend,
        revenue: m.revenue,
        conversions: m.hasConversion ? m.conversions : '',
        roi: m.hasConversion && m.spend > 0 ? m.revenue / m.spend : '',
        recommendation_period: a.period || '',
        suggestion: actionLabel(a.action),
        reason: a.reason,
        demo: c.demo
      };
    });
    download(new Blob([csv(rows)], {
      type: 'text/csv;charset=utf-8'
    }), 'BXAGI_Campaigns.csv');
  }
  async function importWorkspace(file) {
    if (!file) return;
    try {
      if (file.size > 10000000) throw new Error('工作区文件超过 10 MB。');
      const checked = validateWorkspace(JSON.parse(await file.text()));
      if (!(await confirmDialog('导入工作区', `已验证 ${checked.clipPlans.length} 条片段计划、${checked.campaigns.length} 个计划和 ${checked.metrics.length} 条报表。导入将替换当前工作区；视频文件需重新选择。`, '导入并替换'))) return;
      releaseVideo();
      workspace = store.replace(checked);
      state.srtDraft = null;
      state.segments = workspace.srt ? parseSrt(workspace.srt) : [];
      save();
      log('已导入工作区', file.name, 'file');
      render();
      toast('工作区已导入，请重新选择对应的原始视频。');
    } catch (err) {
      toast(err instanceof SyntaxError ? 'JSON 文件无法解析。' : err.message);
    }
  }
  function releaseVideo() {
    invalidateSource();
    state.renderController?.abort();
    if (state.video?.url) URL.revokeObjectURL(state.video.url);
    state.video = null;
    state.file = null;
    state.outputs = [];
    state.serverAssetId = null;
    state.previewEnd = null;
  }
  function resetWorkspace() {
    releaseVideo();
    workspace = store.replace(emptyWorkspace());
    state.srtDraft = null;
    state.segments = [];
    save();
    render();
    toast('本地工作区已清空。');
  }
  function clearDemo() {
    workspace.clipPlans = workspace.clipPlans.filter(c => !c.demo);
    workspace.campaigns = workspace.campaigns.filter(c => !c.demo);
    workspace.metrics = workspace.metrics.filter(m => !m.demo);
    workspace.demo = false;
    log('已清空演示数据', '', 'layers');
    render();
    toast('演示数据已清空。');
  }
  async function loadDemo() {
    if (workspace.campaigns.length + 2 > 1000 || workspace.metrics.length + 2 > 20000) throw new Error('当前工作区容量不足，请先导出并清理。');
    if (workspace.demo) {
      toast('工作区已包含演示数据，可在顶部清空。');
      return;
    }
    if (!(await confirmDialog('加载标记清晰的演示数据', '追加 2 个示例投放计划与报表。示例仅用于体验，不会执行真实生产或广告动作；不会覆盖自己的片段计划。', '加载演示'))) return;
    const c1 = {
        id: uid('demo'),
        name: '演示 · 产品介绍测试',
        dailyBudget: 200,
        targetRoi: 2,
        maxDailyBudget: 500,
        minSpend: 100,
        status: 'paused',
        demo: true
      },
      c2 = {
        id: uid('demo'),
        name: '演示 · 场景内容测试',
        dailyBudget: 150,
        targetRoi: 2,
        maxDailyBudget: 400,
        minSpend: 100,
        status: 'paused',
        demo: true
      };
    workspace.campaigns.push(c1, c2);
    workspace.metrics.push({
      id: uid('metric'),
      campaignId: c1.id,
      spend: 320,
      revenue: 840,
      conversions: 12,
      hasConversion: true,
      dataFresh: true,
      date: '示例记录',
      source: '内置演示',
      importedAt: new Date().toISOString(),
      demo: true
    }, {
      id: uid('metric'),
      campaignId: c2.id,
      spend: 200,
      revenue: 180,
      conversions: 3,
      hasConversion: true,
      dataFresh: true,
      date: '示例记录',
      source: '内置演示',
      importedAt: new Date().toISOString(),
      demo: true
    });
    workspace.demo = true;
    log('已加载演示数据', '全部示例均已标记，不计入真实指标', 'spark');
    render();
    toast('已加载演示计划与报表，真实指标仍为空。');
  }
  function start() {
    document.querySelector?.('.skip-link')?.addEventListener('click', event => {
      event.preventDefault();
      document.getElementById('main-content')?.focus();
    });
    bind();
    router.start();
    render();
    checkHealth(false);
    window.addEventListener?.('beforeunload', destroy);
  }
  function destroy() {
    modal.dismiss();
    state.sourceController.abort();
    state.renderController?.abort();
    client.abortAll();
    clearTimeout(state.pollTimer);
    router.stop();
    if (state.video?.url) URL.revokeObjectURL(state.video.url);
  }
  return {
    start,
    destroy,
    state,
    render,
    setPage,
    runAction,
    selectVideo,
    loadSrtFile,
    options,
    submitQueue,
    importCsv,
    checkHealth,
    saveBackend,
    transcribeServer,
    generateServerPlans,
    getWorkspace: () => workspace,
    replaceWorkspace(raw) {
      workspace = store.replace(raw);
      state.segments = workspace.srt ? parseSrt(workspace.srt) : [];
    },
    totals,
    campaignMetric,
    budgetMetric,
    advice,
    renderPage: page => pageRenderers[page](model())
  };
}
