import { esc, money, icon, button, empty, header, list } from '../app/ui.mjs';
export function insights({
  workspace,
  totals,
  campaignMetric,
  advice
}) {
  const real = totals(),
    demo = totals(true),
    t = real.rows.length ? real : workspace.demo ? demo : real,
    isDemo = !real.rows.length && workspace.demo;
  const campaignsUsed = workspace.campaigns.filter(c => c.demo === isDemo && t.rows.some(m => m.campaignId === c.id));
  const maxRevenue = Math.max(1, ...campaignsUsed.map(c => campaignMetric(c).revenue));
  return `${header('增长分析', '所有图表依据导入数据计算；缺失的指标保持未知。', button('导出分析 JSON', 'export-insights', '', 'download'), 'GROWTH INTELLIGENCE')}${isDemo ? '<div class="notice warning">' + icon('info') + '<span>以下为演示报表计算结果。尚无真实投放数据，不代表任何实际表现。</span></div>' : ''}<div class="grid four">${[['累计消耗', t.rows.length ? money(t.spend) : '—', '按导入记录累计'], ['累计收入', t.rows.length ? money(t.revenue) : '—', '未作跨平台归因去重'], ['收入 / 消耗', t.roi !== null ? t.roi.toFixed(2) : '—', t.roi === null ? '转化资料不全或尚无消耗' : '基于现有报表'], ['转化数量', t.hasConversion ? t.conversions : '—', t.hasConversion ? '已知转化总数' : '转化字段尚不完整']].map(s => `<div class="card stat">
<div class="stat-top">${s[0]}</div>
<div class="stat-num" style="font-size:27px">${s[1]}</div>
<div class="stat-note">${s[2]}</div>
</div>`).join('')}</div>${t.rows.length ? `<div class="grid two section-space">
<div class="card">
<div class="card-head">
<h2>计划收入对比</h2>
<span class="badge ${isDemo ? 'orange' : ''}">${isDemo ? '演示数据' : '导入报表'}</span>
</div>
<div class="card-body" style="padding-top:0">${campaignsUsed.map(c => `<div class="metric-row">
<strong>${esc(c.name)}</strong>
<div class="metric-track" aria-hidden="true">
<span style="width:${campaignMetric(c).revenue / maxRevenue * 100}%">
</span>
</div>
<span class="metric-value">${money(campaignMetric(c).revenue)}</span>
</div>`).join('')}<p class="fine">展示收入的相对大小，不代表增量效果或统计显著性。</p>
</div>
</div>
<div class="card">
<div class="card-head">
<h2>数据完整性</h2>
<span class="badge purple">${t.rows.length} 条记录</span>
</div>
<div class="check-list">${[['转化字段', t.hasConversion, t.hasConversion ? '全部记录包含已知转化数量。' : '至少一条记录缺少转化数，ROI 与预算上调受限。'], ['数据新鲜度', t.rows.every(m => m.dataFresh), t.rows.every(m => m.dataFresh) ? '导入记录标记为新鲜；实际平台延迟需自行确认。' : '存在过期记录，建议保持观察并更新数据。']].map(s => `<div class="check ${s[1] ? 'pass' : ''}">
<span class="check-sign">${s[1] ? '✓' : '?'}</span>
<div>
<strong>${s[0]}</strong>
<p>${s[2]}</p>
</div>
<span class="badge ${s[1] ? 'green' : 'orange'}">${s[1] ? '完整' : '待补充'}</span>
</div>`).join('')}<div class="check">
<span class="check-sign">?</span>
<div>
<strong>自动归因与平台回传</strong>
<p>当前未集成。报表需手动导入，不能推断具体视频的增量贡献。</p>
</div>
<span class="badge orange">待集成</span>
</div>
</div>
</div>
</div>
<div class="card section-space">
<div class="card-head">
<h2>计划表现明细</h2>
<span class="badge">${isDemo ? '演示' : '真实导入'}</span>
</div>
<div class="table-scroll">
<table>
<thead>
<tr>
<th>计划</th>
<th>消耗</th>
<th>收入</th>
<th>转化</th>
<th>ROI</th>
<th>CPA</th>
</tr>
</thead>
<tbody>${campaignsUsed.map(c => {
    const m = campaignMetric(c),
      r = advice(c);
    return `<tr>
<td>
<strong>${esc(c.name)}</strong>
</td>
<td>${money(m.spend)}</td>
<td>${money(m.revenue)}</td>
<td>${m.hasConversion ? m.conversions : '未知'}</td>
<td>${m.hasConversion && m.spend > 0 ? (m.revenue / m.spend).toFixed(2) : '未知'}</td>
<td>${m.hasConversion && m.conversions > 0 ? money(m.spend / m.conversions) : '未知'}</td>
</tr>`;
  }).join('')}</tbody>
</table>
</div>
</div>` : `<div class="card section-space">${empty('chart', '分析从真实数据开始', '导入投放平台的消耗、收入和转化报表后，自动生成计划对比和汇总指标。', button('导入投放报表', 'to-campaigns', 'primary', 'upload'))}</div>`}`;
}
