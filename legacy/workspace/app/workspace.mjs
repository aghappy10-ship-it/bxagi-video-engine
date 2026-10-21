import { parseSrt } from '../domain.mjs';
export const WORKSPACE_KEY = 'bxagi.workspace.v1';
export const emptyWorkspace = () => ({
  version: 1,
  asset: null,
  srt: '',
  clipPlans: [],
  campaigns: [],
  metrics: [],
  events: [],
  demo: false
});
export const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export function validateWorkspace(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.clipPlans) || !Array.isArray(raw.campaigns) || !Array.isArray(raw.metrics) || !Array.isArray(raw.events)) throw new Error('工作区文件格式不正确，请导入 BXAGI 导出的 JSON。');
  if (raw.clipPlans.length > 200 || raw.campaigns.length > 1000 || raw.metrics.length > 20000 || raw.events.length > 200) throw new Error('工作区超过容量：最多 200 个片段、1,000 个计划、20,000 条报表与 200 条操作记录。请分开保存工作区。');
  const seen = new Set();
  for (const collection of [raw.clipPlans, raw.campaigns]) for (const row of collection) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || row.id.length > 100 || seen.has(row.id)) throw new Error('工作区存在无效或重复的记录 ID。');
    seen.add(row.id);
  }
  for (const c of raw.campaigns) {
    if (typeof c.name !== 'string' || !c.name.trim() || !['dailyBudget', 'targetRoi', 'maxDailyBudget', 'minSpend'].every(k => typeof c[k] === 'number' && Number.isFinite(c[k])) || c.dailyBudget < 0 || c.targetRoi <= 0 || c.maxDailyBudget < c.dailyBudget || c.minSpend < 0) throw new Error('工作区投放计划数值无效，预算必须是有效的非负数字。');
  }
  const campaignIds = new Set(raw.campaigns.map(c => c.id));
  for (const m of raw.metrics) {
    if (!m || typeof m.campaignId !== 'string' || !campaignIds.has(m.campaignId) || typeof m.spend !== 'number' || !Number.isFinite(m.spend) || m.spend < 0 || typeof m.revenue !== 'number' || !Number.isFinite(m.revenue) || m.revenue < 0 || m.conversions !== null && m.conversions !== undefined && (!Number.isInteger(m.conversions) || m.conversions < 0) || m.hasConversion === true && !Number.isInteger(m.conversions)) throw new Error('工作区报表含无效金额、转化数或关联计划。');
  }
  for (const c of raw.clipPlans) {
    if (typeof c.start !== 'number' || typeof c.end !== 'number' || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.start < 0 || c.end <= c.start) throw new Error('工作区片段时间边界无效。');
  }
  const out = emptyWorkspace();
  out.demo = raw.demo === true;
  out.srt = typeof raw.srt === 'string' ? raw.srt.slice(0, 2000000) : '';
  if (out.srt) parseSrt(out.srt);
  if (raw.asset && typeof raw.asset.name === 'string' && Number.isFinite(raw.asset.duration) && raw.asset.duration > 0) out.asset = {
    name: raw.asset.name.slice(0, 250),
    duration: raw.asset.duration,
    width: number(raw.asset.width),
    height: number(raw.asset.height),
    size: number(raw.asset.size)
  };
  out.clipPlans = raw.clipPlans.slice(0, 200).filter(c => c && typeof c.id === 'string' && Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end > c.start).map(c => ({
    id: c.id.slice(0, 100),
    title: String(c.title || '未命名片段').slice(0, 200),
    start: c.start,
    end: c.end,
    text: String(c.text || '').slice(0, 20000),
    strategy: String(c.strategy || 'hook').slice(0, 30),
    score: number(c.score),
    selected: c.selected !== false,
    demo: c.demo === true
  }));
  out.campaigns = raw.campaigns.slice(0, 1000).filter(c => c && typeof c.id === 'string' && typeof c.name === 'string').map(c => ({
    id: c.id.slice(0, 100),
    name: c.name.slice(0, 200),
    dailyBudget: Math.max(0, number(c.dailyBudget)),
    targetRoi: Math.max(.01, number(c.targetRoi, 2)),
    maxDailyBudget: Math.max(0, number(c.maxDailyBudget, 1000)),
    minSpend: Math.max(0, number(c.minSpend, 100)),
    status: c.status === 'running' ? 'running' : 'paused',
    demo: c.demo === true
  }));
  out.metrics = raw.metrics.slice(0, 20000).filter(m => m && typeof m.campaignId === 'string' && Number.isFinite(m.spend) && m.spend >= 0 && Number.isFinite(m.revenue) && m.revenue >= 0).map(m => ({
    id: String(m.id || uid('metric')).slice(0, 100),
    campaignId: m.campaignId.slice(0, 100),
    spend: m.spend,
    revenue: m.revenue,
    conversions: Number.isFinite(m.conversions) && m.conversions >= 0 ? m.conversions : null,
    hasConversion: m.hasConversion === true && Number.isInteger(m.conversions) && m.conversions >= 0,
    dataFresh: m.dataFresh !== false,
    source: String(m.source || '工作区导入').slice(0, 250),
    date: String(m.date || '').slice(0, 100),
    demo: m.demo === true,
    importedAt: String(m.importedAt || new Date().toISOString()).slice(0, 100)
  }));
  out.events = raw.events.slice(0, 200).filter(e => e && typeof e.title === 'string').map(e => ({
    id: String(e.id || uid('event')).slice(0, 100),
    title: e.title.slice(0, 300),
    detail: String(e.detail || '').slice(0, 1000),
    date: String(e.date || new Date().toISOString()).slice(0, 100),
    type: String(e.type || 'file').slice(0, 30)
  }));
  return out;
}
/** Restore schema v1 without changing its storage identity or mutating the input. */
export function createWorkspaceStore(storage) {
  let current;
  let restoreError = null;
  try {
    const saved = storage?.getItem(WORKSPACE_KEY);
    current = saved ? validateWorkspace(JSON.parse(saved)) : emptyWorkspace();
  } catch (error) {
    current = emptyWorkspace();
    restoreError = error.message;
  }
  return {
    get current() {
      return current;
    },
    get restoreError() {
      return restoreError;
    },
    save() {
      storage?.setItem(WORKSPACE_KEY, JSON.stringify(current));
    },
    replace(raw) {
      current = validateWorkspace(raw);
      this.save();
      return current;
    }
  };
}
export function createRuntimeState(session) {
  return {
    page: 'overview',
    file: null,
    video: null,
    segments: [],
    outputs: [],
    planning: {
      count: 3,
      minDuration: 5,
      maxDuration: 45,
      strategy: 'hook',
      useAi: false,
      format: 'landscape',
      advancedOpen: false
    },
    queueFilter: 'all',
    campaignSearch: '',
    backend: {
      url: session?.getItem('bxagi.api.url') || '',
      token: session?.getItem('bxagi.api.token') || '',
      healthy: false,
      checked: false,
      detail: null,
      llmConfigured: false,
      asrConfigured: false,
      revision: 0
    },
    sourceRevision: 0,
    sourceController: new AbortController(),
    uploadPromise: null,
    srtDraft: null,
    jobs: [],
    rendering: false,
    renderProgress: 0,
    renderController: null,
    previewEnd: null,
    navOpen: false,
    serverAssetId: null,
    pollTimer: null
  };
}
