import { fmtTime } from '../domain.mjs';
import { esc, icon, button, empty, header, backendStrip, jobsHtml, list, workflowStepper } from '../app/ui.mjs';
export function studio({
  workspace,
  state
}) {
  return `${header('素材生产', '导入真实视频，按字幕时间轴生成计划，并导出可以播放的片段。', button('查看质量验收', 'to-quality', '', 'shield'), 'CONTENT STUDIO')}${workflowStepper({
    workspace,
    state
  })}${backendStrip(state)}<div class="grid studio">
<div class="card studio-import">
<div class="card-head">
<h2>01 / 导入与规划</h2>
<span class="badge">真实文件</span>
</div>
<div class="card-body">
<div class="upload-zone">${icon('upload')}<strong>选择原始视频</strong>
<p>本地文件仅在当前页面保留<br>生产服务支持的视频格式以 FFmpeg 为准</p>
<label class="sr-only" for="video-file">上传原始视频</label>
<input id="video-file" type="file" accept="video/*">
</div>
<p class="fine" style="margin-top:-6px;margin-bottom:16px">体验真实导出：<a href="/samples/bxagi_sample.mp4" download style="color:var(--purple)">合成测试视频</a> · <a href="/samples/bxagi_sample.srt" download style="color:var(--purple)">配套 SRT</a>（测试图样与音调，不是客户案例）</p>${workspace.asset ? `<div class="file-meta">
<strong>${esc(workspace.asset.name)}</strong>
<span>${fmtTime(workspace.asset.duration)} · ${workspace.asset.width} × ${workspace.asset.height} · ${(workspace.asset.size / 1048576).toFixed(1)} MB${!state.file ? ' · 需重新选择视频' : ''}</span>
</div>` : ''}<div class="field">
<label for="srt-file">时间轴字幕（SRT）</label>
<input id="srt-file" type="file" accept=".srt,text/plain">
<small>完整语句判断依赖 SRT；自动转写需要服务端配置本地 faster-whisper 模型。</small>
</div>
<div class="actions" style="margin-bottom:16px">${button("本地模型转写", "transcribe-server", "small", "spark", state.backend.asrConfigured ? "" : "disabled")}</div>
<div class="field">
<label for="srt-text">或粘贴字幕内容</label>
<textarea id="srt-text" rows="6" placeholder="1&#10;00:00:00,000 --> 00:00:08,000&#10;这里是完整的一句字幕。">${esc(state.srtDraft ?? workspace.srt)}</textarea>
<small>${state.segments.length ? `已解析 ${state.segments.length} 条字幕` : '标准 SRT 时间码：00:00:00,000 → 00:00:08,000'}</small>
</div>
<details id="studio-advanced" class="studio-advanced" ${state.planning.advancedOpen ? 'open' : ''}><summary>规划与输出设置<span> ${esc(state.planning.count)} 条 · ${esc(state.planning.format === 'portrait' ? '竖屏' : state.planning.format === 'square' ? '方形' : '横屏')}</span></summary><div class="studio-advanced-body"><div class="field-row">
<div class="field">
<label for="clip-count">计划数量</label>
<input id="clip-count" type="number" min="1" max="20" value="${esc(state.planning.count)}">
</div>
<div class="field">
<label for="clip-min">最短 / 秒</label>
<input id="clip-min" type="number" min="1" max="600" value="${esc(state.planning.minDuration)}">
</div>
<div class="field">
<label for="clip-max">最长 / 秒</label>
<input id="clip-max" type="number" min="1" max="600" value="${esc(state.planning.maxDuration)}">
</div>
</div>
<div class="field">
<label for="clip-strategy">内容策略</label>
<select id="clip-strategy">
<option value="hook" ${state.planning.strategy === 'hook' ? 'selected' : ''}>优先高信息密度</option>
<option value="narrative" ${state.planning.strategy === 'narrative' ? 'selected' : ''}>连贯叙事 · 叙事关键词</option>
<option value="selling" ${state.planning.strategy === 'selling' ? 'selected' : ''}>卖点提取 · 产品关键词</option>
</select>
<small>字幕规则选段；不将规则评分解释为模型理解或转化预测。</small>
</div>
<label class="fine" style="display:flex;align-items:flex-start;gap:7px;margin:0 0 14px">
<input id="use-ai" type="checkbox" ${state.planning.useAi ? 'checked' : ''} ${state.backend.llmConfigured ? '' : 'disabled'}>使用已配置模型选段（仅服务端；字幕会发送至配置的模型）</label>

<p class="fine">模型规划仅在服务端配置接口后可选；显式点击会将字幕发送到所配置的模型。自动转写与模型结果需人工校对。</p>
<div class="divider">
</div>
<div class="field">
<label for="output-format">输出画幅</label>
<select id="output-format">
<option value="landscape" ${state.planning.format === 'landscape' ? 'selected' : ''}>横屏 · 1280 × 720</option>
<option value="portrait" ${state.planning.format === 'portrait' ? 'selected' : ''}>竖屏 · 720 × 1280</option>
<option value="square" ${state.planning.format === 'square' ? 'selected' : ''}>方形 · 720 × 720</option>
</select>
<small>保持原画面比例，空白区域填充；不自动追踪或重构镜头。</small>
</div>
</div></details><div class="actions">${button('生成规则计划', 'plan-local', 'primary', 'spark')}${button('服务端规划', 'plan-server', '', 'server')}</div><div class="notice warning">${icon('info')}<span>浏览器按真实时长录制，导出草稿。正式素材需由生产服务完成解码与语句双重验收。</span>
</div>
</div>
</div>
<div>
<div class="card studio-workspace">
<div class="card-head">
<h2>02 / 预览与片段计划</h2>
<span class="badge purple">${workspace.clipPlans.length} 条计划</span>
</div>
<div class="card-body">
<div class="video-box">${state.video ? `<video id="video-player" src="${esc(state.video.url)}" controls playsinline preload="metadata">
</video>` : empty('video', '视频预览区', '选择视频后可以直接播放与预览选段。')}</div>
<div class="actions" style="margin-bottom:16px">${button('新增手动片段', 'add-clip', '', 'plus')}${button('提交已选到队列', 'queue-selected', 'primary', 'send')}${button('导出片段计划', 'export-plans', 'small', 'download')}</div>${workspace.clipPlans.length ? `<div class="clip-list">${workspace.clipPlans.map(c => `<article class="clip ${c.selected ? 'selected' : ''}" data-clip="${esc(c.id)}">
<div class="clip-head">
<input type="checkbox" class="clip-select" data-id="${esc(c.id)}" ${c.selected ? 'checked' : ''} aria-label="选择 ${esc(c.title)}">
<strong>${esc(c.title)}</strong>
<span class="badge ${c.demo ? 'orange' : 'purple'}">${c.demo ? '演示' : '计划'}</span>
</div>
<div class="field-row">
<div class="field">
<label>开始 / 秒<input class="clip-time" type="number" min="0" step="0.1" data-id="${esc(c.id)}" data-field="start" value="${c.start}">
</label>
</div>
<div class="field">
<label>结束 / 秒<input class="clip-time" type="number" min="0" step="0.1" data-id="${esc(c.id)}" data-field="end" value="${c.end}">
</label>
</div>
</div>
<p>${esc(c.text || '手动选段：上传 SRT 后可校验是否完整覆盖语句。')}</p>
<div class="clip-actions">${button('预览', 'preview-clip', 'small', 'play', `data-id="${esc(c.id)}"`)}${button('导出浏览器草稿', 'render-clip', 'small', 'download', `data-id="${esc(c.id)}" ${state.rendering ? 'disabled' : ''}`)}${button('删除', 'delete-clip', 'small subtle', 'trash', `data-id="${esc(c.id)}"`)}</div>
</article>`).join('')}</div>` : empty('layers', '尚未生成片段计划', '导入视频与 SRT 后，点击生成计划；也可手动设置开始与结束时间。')}${state.rendering ? `<div class="output" id="render-box">
<strong>正在实际录制视频片段</strong>
<div class="progress">
<span id="render-progress" style="width:${state.renderProgress * 100}%">
</span>
</div>
<div class="progress-text">
<span>请保持页面打开</span>
<span id="render-percent">${Math.round(state.renderProgress * 100)}%</span>
</div>
<div class="actions">${button('取消录制', 'cancel-render', 'small danger', 'close')}</div>
</div>` : ''}${state.outputs.map((o, i) => `<div class="output">
<strong>${esc(o.title)} · 浏览器导出草稿</strong>
<p>${esc(o.mimeType)} · ${(o.blob.size / 1048576).toFixed(2)} MB · 真实输出文件。未进行服务端解码验收，不作为正式验收通过素材。</p>
<div class="actions">${button('下载视频', 'download-output', 'small primary', 'download', `data-index="${i}"`)}${button('下载验收报告', 'download-output-report', 'small', 'file', `data-index="${i}"`)}</div>
</div>`).join('')}</div>
</div>
<div class="card section-space">
<div class="card-head">
<h2>03 / 服务端生产队列</h2><label class="queue-filters" for="queue-filter"><span class="sr-only">队列状态筛选</span><select id="queue-filter">${[['all', '全部任务'], ['active', '处理中'], ['passed', '已完成'], ['failed', '失败或拒绝']].map(([value, label]) => `<option value="${value}" ${state.queueFilter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
<div class="actions">${button('刷新队列', 'refresh-jobs', 'small', 'refresh')}</div>
</div>
<div class="card-body" id="jobs-list" style="padding-top:0">${jobsHtml(state)}</div>
</div>
</div>
</div>`;
}
