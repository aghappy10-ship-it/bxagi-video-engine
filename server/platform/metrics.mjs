/**
 * Pure manual-feedback recommendation rules; never performs advertising writes.
 * The caller is responsible for owner-scoped metrics and campaign lookups.
 */

export function metricDecision(campaign, metric, lifetimeSpend) {
  if (lifetimeSpend >= campaign.totalBudget || metric.spend >= campaign.dailyBudget) {
    return {
      action: 'pause',
      reason: '已达到用户设置的总预算或日预算上限',
      dailyBudget: campaign.dailyBudget,
      execution: 'recommendation_only'
    };
  }
  if (!metric.dataFresh) {
    return {
      action: 'hold',
      reason: '数据尚未确认新鲜度',
      execution: 'recommendation_only'
    };
  }
  const ctrReady = Number.isFinite(metric.impressions) && metric.impressions >= 1000 && Number.isFinite(metric.clicks) && metric.clicks >= 0 && metric.clicks <= metric.impressions;
  const roiReady = metric.hasConversion && metric.roi !== null && metric.spend >= 50 && (metric.conversions ?? 0) >= 3;
  if (!roiReady && ctrReady) {
    return {
      action: 'iterate',
      signal: 'ctr',
      reason: '点击样本达到实验门槛，生成标题与版式对照；转化证据不足，保持预算与ROI判断',
      execution: 'recommendation_only'
    };
  }
  if (!metric.hasConversion || metric.roi === null) {
    return {
      action: 'hold',
      reason: '缺少已确认的转化收入，无法计算ROI',
      execution: 'recommendation_only'
    };
  }
  if (metric.spend < 50 || (metric.conversions ?? 0) < 3) {
    return {
      action: 'hold',
      reason: '已验证样本不足，继续收集效果数据',
      execution: 'recommendation_only'
    };
  }
  if (metric.roi < campaign.targetRoi) {
    return {
      action: 'iterate',
      reason: '已验证ROI低于目标，创建新素材优化任务',
      execution: 'recommendation_only'
    };
  }
  return {
    action: 'scale',
    reason: '已验证ROI达到目标，可在用户上限内调整预算',
    dailyBudget: Math.min(campaign.maxDailyBudget, Math.round(campaign.dailyBudget * 1.15 * 100) / 100),
    execution: 'recommendation_only'
  };
}
