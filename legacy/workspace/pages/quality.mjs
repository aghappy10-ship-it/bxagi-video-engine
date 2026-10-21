import { fmtTime, validateClip } from '../domain.mjs';
import { esc, icon, button, empty, header, backendStrip, jobsHtml, list } from '../app/ui.mjs';
export function quality({
  workspace,
  state
}) {
  const duration = state.video?.duration || workspace.asset?.duration || Infinity;
  return `${header('每一条输出，都有验收依据', '规则校验用于发现计划问题；正式输出以生产服务的实际验收结果为准。', button('返回素材生产', 'to-studio', '', 'video'), 'QUALITY CONTROL')}${backendStrip(state)}<div class="notice">${icon('info')}<span>浏览器计划校验不证明输出文件可以完整解码。生产服务只有通过媒体解码与句子边界检查，才开放正式下载。</span>
</div>${workspace.clipPlans.length ? `<div class="grid two">${workspace.clipPlans.map(c => {
    let r;
    try {
      r = validateClip(c, state.segments, duration);
    } catch (e) {
      r = {
        passed: false,
        checks: [],
        errors: [e.message]
      };
    }
    return `<div class="card">
<div class="card-head">
<div>
<h2>${esc(c.title)}</h2>
<p>${fmtTime(c.start)} — ${fmtTime(c.end)} · ${(c.end - c.start).toFixed(1)} 秒${c.demo ? ' · 演示' : ''}</p>
</div>
<span class="badge ${r.sentencePassed ? 'green' : 'orange'}">${r.sentencePassed ? '句界通过 · 待成片验收' : '需要检查'}</span>
</div>
<div class="check-list">${(r.checks || []).map(check => `<div class="check ${check.status}">
<span class="check-sign">${check.status === 'pass' ? '✓' : check.status === 'fail' ? '×' : '?'}</span>
<div>
<strong>${esc(check.name)}</strong>
<p>${esc(check.detail)}</p>
</div>
<span class="badge ${check.status === 'pass' ? 'green' : check.status === 'fail' ? 'red' : 'orange'}">${check.status === 'pass' ? '通过' : check.status === 'fail' ? '失败' : '未验证'}</span>
</div>`).join('')}${r.errors?.length ? `<p class="error-text">${esc(r.errors.join('；'))}</p>` : ''}</div>
</div>`;
  }).join('')}</div>` : `<div class="card">${empty('shield', '还没有待验收的片段', '先生成或手动创建片段计划，时间边界和语句检查会出现在这里。', button('进入素材生产', 'to-studio', 'primary', 'arrow'))}</div>`}<div class="card section-space">
<div class="card-head">
<h2>正式生产验收</h2>${button('刷新队列', 'refresh-jobs', 'small', 'refresh')}</div>
<div class="card-body" id="jobs-list" style="padding-top:0">${jobsHtml(state)}</div>
</div>`;
}
