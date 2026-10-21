import { esc, money, dateLabel, icon, button, empty, header, actionLabel } from '../app/ui.mjs';
export function campaigns({
  workspace,
  state,
  totals,
  campaignMetric,
  advice
}) {
  const t = totals();
  const visibleCampaigns = workspace.campaigns.filter(c => c.name.toLocaleLowerCase().includes(state.campaignSearch.toLocaleLowerCase()));
  return `${header('投放运营', '建立本地投放计划，导入平台报表，让预算决策有数据可依。', `${button('导入投放 CSV', 'import-csv', '', 'upload')}${button('新建投放计划', 'new-campaign', 'primary', 'plus')}`, 'CAMPAIGN OPERATIONS')}<input id="csv-file" class="hidden" type="file" accept=".csv,text/csv">
<div class="notice warning">${icon('info')}<span>当前未接入广告平台。启用、暂停与预算修改只更新本地计划；系统不会发起投放或支出。</span>
</div>
<div class="grid four">${[['真实消耗', t.rows.length ? money(t.spend) : '—', '由导入报表累计'], ['归因收入', t.rows.length ? money(t.revenue) : '—', '按报表 revenue 字段汇总'], ['转化次数', t.hasConversion ? t.conversions : '—', t.rows.length && !t.hasConversion ? '缺少 conversions，无法确认' : '等待真实转化数据'], ['投放计划', workspace.campaigns.length, '仅本地管理状态']].map(s => `<div class="card stat">
<div class="stat-top">${s[0]}</div>
<div class="stat-num" style="font-size:26px">${s[1]}</div>
<div class="stat-note">${s[2]}</div>
</div>`).join('')}</div>
<div class="card section-space">
<div class="card-head">
<div>
<h2>投放计划</h2>
<p>建议基于导入数据，不自动执行。</p>
</div>${button('导出计划 CSV', 'export-campaigns', 'small', 'download')}</div><div class="table-toolbar"><label for="campaign-search">搜索计划<input id="campaign-search" type="search" value="${esc(state.campaignSearch)}" placeholder="输入计划名称"></label><span class="fine">${visibleCampaigns.length} / ${workspace.campaigns.length} 个计划</span></div>${workspace.campaigns.length ? `<div class="table-scroll">
<table>
<thead>
<tr>
<th>计划 / 状态</th>
<th>日预算</th>
<th>消耗 / 收入</th>
<th>ROI / 转化</th>
<th>预算建议</th>
<th>操作</th>
</tr>
</thead>
<tbody>${visibleCampaigns.map(c => {
    const m = campaignMetric(c),
      a = advice(c);
    return `<tr>
<td>
<strong>${esc(c.name)}</strong>
<span class="sub">${c.demo ? '演示 · ' : ''}${c.status === 'running' ? '本地启用' : '本地暂停'}</span>
</td>
<td>${money(c.dailyBudget)}<span class="sub">上限 ${money(c.maxDailyBudget)}</span>
</td>
<td>${m.rows.length ? money(m.spend) : '—'} / ${m.rows.length ? money(m.revenue) : '—'}<span class="sub">${m.rows.length} 条${c.demo ? '示例' : '导入'}记录</span>
</td>
<td>${m.hasConversion && m.spend > 0 ? (m.revenue / m.spend).toFixed(2) : '—'}<span class="sub">转化 ${m.hasConversion ? m.conversions : '未知'}</span>
</td>
<td>
<span class="badge ${a.action === 'pause' ? 'orange' : a.action === 'increase' ? 'green' : 'purple'}">${esc(actionLabel(a.action))}</span>
<span class="sub" style="max-width:260px;white-space:normal;line-height:1.7">${esc(a.reason)}</span>
</td>
<td>
<div class="actions">${button('编辑', 'edit-campaign', 'small', '', `data-id="${esc(c.id)}"`)}${button(c.status === 'running' ? '本地暂停' : '本地启用', 'toggle-campaign', 'small subtle', c.status === 'running' ? 'pause' : 'play', `data-id="${esc(c.id)}"`)}</div>
</td>
</tr>`;
  }).join('')}${!visibleCampaigns.length ? '<tr><td colspan="6"><div class="empty-search">没有匹配的计划，请更换搜索词。</div></td></tr>' : ''}</tbody>
</table>
</div>` : empty('send', '建立第一个投放计划', '设置日预算、目标 ROI 与预算上限。导入真实报表后，系统将给出本地建议。', button('新建计划', 'new-campaign', 'primary', 'plus'))}</div>
<div class="grid two section-space">
<div class="card">
<div class="card-head">
<h2>导入平台报表</h2>
<span class="badge">CSV</span>
</div>
<div class="card-body">
<p class="fine" style="margin-top:0">支持中英文表头。必需列：campaign / 计划、spend / 消耗、revenue / 收入。可选列：conversions / 转化、date / 日期、data_fresh / 数据新鲜度。日预算建议只采用最近的有日期报表；过期或无日期记录仅观察。</p>
<div class="notice">${icon('info')}<span>缺少转化列时转化标记为未知，不按零转化处理；数据过期时不建议加预算。</span>
</div>
<div class="actions">${button('下载导入模板', 'csv-template', '', 'download')}${button('选择 CSV 文件', 'import-csv', 'primary', 'upload')}</div>
</div>
</div>
<div class="card">
<div class="card-head">
<h2>最近的导入</h2>
<span class="badge">${workspace.metrics.length} 条记录</span>
</div>${workspace.metrics.length ? `<div class="feed">${workspace.metrics.slice(-4).reverse().map(m => `<div class="feed-row">
<div class="feed-icon">${icon('file')}</div>
<div>
<p>${esc(workspace.campaigns.find(c => c.id === m.campaignId)?.name || '已删除计划')}${m.demo ? ' · 演示' : ''}</p>
<small>消耗 ${money(m.spend)} · 收入 ${money(m.revenue)} · 转化 ${m.hasConversion ? m.conversions : '未知'}</small>
</div>
<span class="feed-time">${esc(m.date || dateLabel(m.importedAt))}</span>
</div>`).join('')}</div>` : empty('file', '尚未导入报表', '平台数据会作为预算建议和增长分析的计算依据。')}</div>
</div>`;
}
