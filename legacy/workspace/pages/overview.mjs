import { fmtTime } from '../domain.mjs';
import { esc, dateLabel, icon, button, empty, header, workflowStepper } from '../app/ui.mjs';
export function overview({
  workspace,
  state,
  totals
}) {
  const t = totals(),
    selected = workspace.clipPlans.filter(c => c.selected),
    productionPassed = state.jobs.filter(j => j.status === 'passed' || j.status === 'completed' && j.output_url).length;
  return `${header('视频生产与投放，一站式协作', '把原始视频转成可验收的素材，再用真实投放数据指导下一次生产。', `${button('加载演示数据', 'load-demo', '', 'spark')}${button('开始生产', 'to-studio', 'primary', 'plus')}`)}${workflowStepper({
    workspace,
    state
  })}<div class="banner">
<div>
<h2>从一段视频，到一次有依据的增长</h2>
<p>上传视频与时间轴字幕，生成片段计划、校验质量并导出。投放计划和预算建议保留在本地，连接生产服务后可运行正式素材队列。</p>
</div>
<div class="banner-mark">${icon('mark')}</div>
</div>
<div class="grid four">${[['待生产片段', selected.length, '条', '已选择的片段计划', 'video'], ['正式验收通过', productionPassed, '条', '来自当前连接的生产队列', 'shield'], ['投放计划', workspace.campaigns.filter(c => !c.demo).length, '个', '本地计划 · 未对平台执行', 'send'], ['真实投放 ROI', t.roi !== null ? t.roi.toFixed(2) : '—', '', t.rows.length ? `${t.rows.length} 条导入记录${!t.hasConversion ? ' · 缺少转化数据' : ''}` : '等待导入平台数据', 'chart']].map(s => `<div class="card stat">
<div class="stat-top">
<span>${s[0]}</span>
<span class="stat-icon">${icon(s[4])}</span>
</div>
<div class="stat-num">${s[1]}<small>${s[2]}</small>
</div>
<div class="stat-note">${s[3]}</div>
</div>`).join('')}</div>
<div class="card section-space">
<div class="card-head">
<h2>生产闭环</h2>
<span class="badge">四个阶段 · 各有验收依据</span>
</div>
<div class="flow">${[['01', 'video', '素材生产', '导入视频 + SRT，按完整语句规划片段。', 'studio', '进入生产'], ['02', 'shield', '质量验收', '检查时间边界、语句与实际解码结果。', 'quality', '查看验收'], ['03', 'send', '投放运营', '建立计划，导入报表并计算预算建议。', 'campaigns', '管理计划'], ['04', 'chart', '增长分析', '汇总真实消耗与收入，反馈内容决策。', 'insights', '查看分析']].map(s => `<div class="flow-step">
<div class="flow-top">
<span class="flow-number">${s[0]}</span>${icon(s[1])}</div>
<h3>${s[2]}</h3>
<p>${s[3]}</p>
<button class="btn small" data-page="${s[4]}">${s[5]}${icon('arrow')}</button>
</div>`).join('')}</div>
</div>
<div class="grid two section-space">
<div class="card">
<div class="card-head">
<h2>最近的片段计划</h2>
<button class="btn small subtle" data-page="studio">全部计划${icon('arrow')}</button>
</div>${workspace.clipPlans.length ? `<div class="table-scroll">
<table>
<thead>
<tr>
<th>素材名称</th>
<th>时长</th>
<th>状态</th>
</tr>
</thead>
<tbody>${workspace.clipPlans.slice(0, 4).map(c => `<tr>
<td>
<strong>${esc(c.title)}</strong>
<span class="sub">${esc(fmtTime(c.start))} — ${esc(fmtTime(c.end))}${c.demo ? ' · 演示' : ''}</span>
</td>
<td>${(c.end - c.start).toFixed(1)}s</td>
<td>
<span class="badge ${c.demo ? 'orange' : 'purple'}">${c.demo ? '演示计划' : '待生产'}</span>
</td>
</tr>`).join('')}</tbody>
</table>
</div>` : empty('video', '等待你的第一段视频', '上传原始视频和字幕后，片段计划会出现在这里。', button('上传素材', 'to-studio', 'small', 'upload'))}</div>
<div class="card">
<div class="card-head">
<h2>工作区动态</h2>
<span class="badge">实际操作记录</span>
</div>${workspace.events.length ? `<div class="feed">${workspace.events.slice(0, 4).map(e => `<div class="feed-row">
<div class="feed-icon">${icon(e.type)}</div>
<div>
<p>${esc(e.title)}</p>
<small>${esc(e.detail)}</small>
</div>
<span class="feed-time">${esc(dateLabel(e.date))}</span>
</div>`).join('')}</div>` : empty('clock', '新的工作区，新的开始', '生产、导入和修改记录将保存在当前浏览器。')}</div>
</div>`;
}
