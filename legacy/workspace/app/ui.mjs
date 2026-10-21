/** Escaped HTML components shared by the seven pure page renderers. */
export const DISTRIBUTION_URL = 'https://bxagi-video-suite.amberskunk4.chatgpt.site/downloads/BXAGI_Video_MVP.zip';
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[c]);
export const money = v => Number.isFinite(Number(v)) ? `¥${Number(v).toLocaleString('zh-CN', {
  maximumFractionDigits: 2
})}` : '—';
export const dateLabel = v => new Date(v).toLocaleString('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});
const icons = {
  mark: '<path d="M7 5h12l-6 11H1L7 5Zm10 14h12l-6 11H11l6-11Z" fill="currentColor"/>',
  grid: '<rect x="3" y="3" width="6" height="6" rx="1.3"/><rect x="15" y="3" width="6" height="6" rx="1.3"/><rect x="3" y="15" width="6" height="6" rx="1.3"/><rect x="15" y="15" width="6" height="6" rx="1.3"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  send: '<path d="m3 3 18 7-8 3-3 8-7-18Z"/><path d="m3 3 10 10"/>',
  chart: '<path d="M4 3v17h17M8 15l4-5 4 2 5-6"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  settings: '<path d="m9 3-1 3-3 1-2 5 3 2v4l5 3 3-2 3 1 4-5-2-3 1-3-5-4-3 1-3-3Z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v5h16v-5"/>',
  refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 3v5h-5"/>',
  file: '<path d="M5 3h9l5 5v13H5V3Zm9 0v5h5M8 12h8M8 16h6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m8 4 12 8-12 8V4Z"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M6 6h.01M6 17h.01M15 6h3M15 17h3"/>',
  trash: '<path d="M3 6h18M9 3h6M6 6l1 15h10l1-15M10 10v7M14 10v7"/>'
};
export const icon = n => `<svg viewBox="0 0 ${n === 'mark' ? '32 34' : '24 24'}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n] || icons.file}</svg>`;
export function button(label, action, kind = '', ico = '', extra = '') {
  const reasons = {
    'transcribe-server': '连接生产服务并配置本地转写模型后可用。',
    'render-clip': '请先完成或取消当前录制。'
  };
  if (extra.includes('disabled') && !extra.includes('title=')) extra += ` title="${esc(reasons[action] || '请先完成所需的配置与数据准备。')}"`;
  return `<button class="btn ${kind}" data-action="${action}" ${extra}>${ico ? icon(ico) : ''}${label}</button>`;
}
export function empty(ico, title, text, action = '') {
  return `<div class="empty"><div class="empty-icon">${icon(ico)}</div><strong>${title}</strong><p>${text}</p>${action}</div>`;
}
export function header(title, text, actions = '', tag = 'OPERATIONS WORKSPACE') {
  return `<div class="page-head"><div><div class="eyebrow">${tag}</div><h1>${title}</h1><p>${text}</p></div><div class="actions">${actions}</div></div>`;
}
export function jobStatus(s) {
  return {
    queued: '排队中',
    running: '处理中',
    processing: '处理中',
    passed: '验收通过',
    completed: '处理完成',
    failed: '失败',
    rejected: '验收拒绝',
    interrupted: '已中断'
  }[s] || s || '未知';
}
export function actionLabel(a) {
  return {
    hold: '保持观察',
    pause: '建议暂停',
    increase: '建议增加预算',
    approval: '需人工批准'
  }[a] || '保持观察';
}
export function list(values) {
  return Array.isArray(values) ? values : typeof values === 'string' ? [values] : values ? Object.values(values) : [];
}
export function featureText(f) {
  return typeof f === 'string' ? f : f?.name || f?.title || JSON.stringify(f);
}
export function demoNotice(workspace) {
  return workspace.demo ? `<div class="demo-ribbon"><span>当前包含演示数据。所有示例均已标记，不代表真实产能、投放结果或已执行动作。</span>${button('清空演示', 'clear-demo', 'small')}</div>` : '';
}
export function backendStrip(state) {
  return `<div class="backend-strip">${icon('server')}<span>${state.backend.healthy ? '生产服务已连接 · 可使用 FFmpeg 队列与正式验收' : '浏览器本地模式 · 视频导出为草稿；生产服务尚未连接'}</span>${button(state.backend.healthy ? '刷新服务状态' : '连接生产服务', 'health', 'small', 'refresh')}</div>`;
}
export function jobsHtml(state) {
  const jobs = state.jobs.filter(job => state.queueFilter === "all" || (state.queueFilter === "active" ? ["queued", "running", "processing"].includes(job.status) : state.queueFilter === "passed" ? ["passed", "completed"].includes(job.status) : ["failed", "rejected", "interrupted"].includes(job.status)));
  return jobs.length ? jobs.map(j => `<div class="job"><div class="job-top"><strong>${esc(j.title || j.id)}</strong><span class="badge ${['passed', 'completed'].includes(j.status) ? 'green' : ['failed', 'rejected', 'interrupted'].includes(j.status) ? 'red' : 'purple'}">${esc(jobStatus(j.status))}</span></div><p>${esc(j.id)}${j.error ? `<br>${esc(typeof j.error === 'string' ? j.error : JSON.stringify(j.error))}` : ''}</p><div class="actions">${button('查看验收', 'job-detail', 'small', 'shield', `data-id="${esc(j.id)}"`)}${j.output_url && ['passed', 'completed'].includes(j.status) ? button('下载正式 MP4', 'job-download', 'small primary', 'download', `data-id="${esc(j.id)}"`) : ''}</div></div>`).join('') : empty('server', state.jobs.length ? '没有符合筛选条件的任务' : '队列中还没有任务', state.jobs.length ? '选择其他状态查看任务。' : state.backend.healthy ? '选择片段并提交到队列，生产服务会处理真实视频。' : '在设置中连接生产服务，或下载部署包在本地启动。');
}
/** Current progress derives from real workspace state; it is never a simulated output. */
export function workflowStepper({
  workspace,
  state
}) {
  const produced = state.outputs.length > 0 || state.jobs.some(job => state.serverAssetId && job.asset_id === state.serverAssetId && (job.status === 'passed' || job.status === 'completed' && job.output_url));
  const ready = [!!state.file, state.segments.length > 0, workspace.clipPlans.some(clip => clip.selected && !clip.demo), produced];
  const current = ready.findIndex(value => !value);
  const labels = ['导入视频', '准备字幕', '检查片段', '生产导出'];
  const next = !state.file ? ['选择原始视频', workspace.asset ? '重新选择原视频后，已保存的计划会继续保留。' : '从视频和时间轴字幕开始创建自己的素材。', 'to-studio'] : !ready[1] ? ['准备时间轴字幕', '导入配套 SRT，或使用已配置的本地转写模型。', 'to-studio'] : !ready[2] ? ['生成并检查片段计划', '按完整语句规划选段，再调整时间并预览内容。', 'to-studio'] : !produced ? ['生产已选片段', '连接生产服务后提交队列；也可先导出浏览器草稿。', 'to-studio'] : ['查看素材验收', '浏览器草稿与正式生产结果分别保留验收依据。', 'to-quality'];
  return `<div class="workflow-stepper" aria-label="素材生产进度">${labels.map((label, index) => `<div class="workflow-step ${ready[index] ? 'done' : index === current ? 'current' : ''}" ${index === current ? 'aria-current="step"' : ''}><span class="workflow-number" aria-hidden="true">${ready[index] ? '✓' : index + 1}</span><div><strong>${label}</strong><small>${ready[index] ? '已准备' : index === current ? '进行此步骤' : '下一步'}</small></div></div>`).join('')}</div><div class="workflow-next"><div><strong>下一步：${next[0]}</strong><p>${next[1]}</p></div>${button(next[0], next[2], 'small', 'arrow')}</div>`;
}
