export function dailySnapshots(metrics=[]) {
  const rows=new Map();
  for(const metric of metrics) {
    const key=`${metric.campaignId}|${metric.date}`;
    const old=rows.get(key);
    const platform=metric.source !== 'manual';
    const oldPlatform=old && old.source !== 'manual';
    if(!old||(platform&&!oldPlatform)||(platform===oldPlatform&&String(metric.updatedAt||metric.createdAt||'')>=String(old.updatedAt||old.createdAt||'')))rows.set(key,metric);
  }
  return Array.from(rows.values()).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}
export function metricTotals(metrics=[]) {
  const snapshots=dailySnapshots(metrics);
  const spend=snapshots.reduce((sum,row)=>sum+(Number(row.spend)||0),0);
  const complete=snapshots.length>0&&snapshots.every(row=>row.hasConversion===true&&row.revenue!=null&&Number.isFinite(Number(row.revenue)));
  const revenue=complete?snapshots.reduce((sum,row)=>sum+Number(row.revenue),0):null;
  return {spend,revenue,roi:complete&&spend>0?revenue/spend:null,count:snapshots.length};
}
export function campaignKnownSpend(metrics=[],campaignId) {
  const rows=metrics.filter(row=>row.campaignId===campaignId);
  const authoritative=rows.filter(row=>row.source==='oceanengine'&&row.metadata?.lifetimeSpend!=null&&Number.isFinite(Number(row.metadata.lifetimeSpend))).sort((a,b)=>String(b.updatedAt||b.createdAt||b.date).localeCompare(String(a.updatedAt||a.createdAt||a.date)))[0];
  if(authoritative)return {spend:Number(authoritative.metadata.lifetimeSpend),source:'channel'};
  const totals=metricTotals(rows);return totals.count?{spend:totals.spend,source:'snapshots'}:null;
}
export function operationOutcome(result,operation='sync') {
  if(!result)return null;const campaign=result.campaign||result;
  if(campaign.error||['blocked','needs_reconciliation','failed'].includes(campaign.status))return {error:campaign.error||campaign.lastError?.message||'操作未完成，请查看渠道状态与配置。'};
  if(operation==='sync'&&!result.metric)return {notice:`本次保留预算：${result.decision?.reason||'未取得可用于优化的完整效果数据。'}`};
  if(operation==='sync')return {notice:`真实渠道快照已保存${result.decision?.reason?`：${result.decision.reason}`:'。'}`};
  return {notice:operation==='launch'?'投放请求已提交，请查看渠道状态与审核结果。':'已取得渠道暂停结果。'};
}
