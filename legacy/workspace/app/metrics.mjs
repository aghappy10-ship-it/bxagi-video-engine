import { evaluateCampaign } from '../domain.mjs';
export function totals(workspace, includeDemo = false) {
  const rows = workspace.metrics.filter(m => includeDemo ? m.demo : !m.demo);
  const spend = rows.reduce((s, m) => s + m.spend, 0),
    revenue = rows.reduce((s, m) => s + m.revenue, 0);
  const hasConversion = rows.length > 0 && rows.every(m => m.hasConversion);
  return {
    rows,
    spend,
    revenue,
    hasConversion,
    conversions: hasConversion ? rows.reduce((s, m) => s + m.conversions, 0) : null,
    roi: hasConversion && spend > 0 ? revenue / spend : null
  };
}
export function campaignMetric(workspace, c) {
  const rows = workspace.metrics.filter(m => m.campaignId === c.id);
  const spend = rows.reduce((s, m) => s + m.spend, 0),
    revenue = rows.reduce((s, m) => s + m.revenue, 0),
    hasConversion = rows.length > 0 && rows.every(m => m.hasConversion);
  return {
    spend,
    revenue,
    conversions: hasConversion ? rows.reduce((s, m) => s + m.conversions, 0) : null,
    hasConversion,
    dataFresh: rows.every(m => m.dataFresh),
    rows
  };
}
export function budgetMetric(workspace, c, now = new Date()) {
  const all = workspace.metrics.filter(m => m.campaignId === c.id);
  const canonical = d => {
    const m = String(d || '').match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
  };
  const dated = all.map(m => ({
    ...m,
    period: canonical(m.date)
  })).filter(m => m.period);
  const period = dated.map(m => m.period).sort().at(-1) || null;
  const rows = period ? dated.filter(m => m.period === period) : [];
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const hasConversion = rows.length > 0 && rows.every(m => m.hasConversion);
  return {
    period,
    spend: rows.reduce((s, m) => s + m.spend, 0),
    revenue: rows.reduce((s, m) => s + m.revenue, 0),
    conversions: hasConversion ? rows.reduce((s, m) => s + m.conversions, 0) : null,
    hasConversion,
    dataFresh: !!period && period === today && rows.every(m => m.dataFresh)
  };
}
export function advice(workspace, c, now = new Date()) {
  const m = budgetMetric(workspace, c, now);
  const r = evaluateCampaign({
    ...c,
    ...m
  });
  return {
    ...r,
    period: m.period,
    reason: m.period ? `最近报表日 ${m.period}：${r.reason}` : '缺少有效报表日期，日预算节奏无法核实；保持观察。'
  };
}
