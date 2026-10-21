import { dailySnapshots, metricTotals } from './metrics.mjs';

const finite = value => value != null && Number.isFinite(Number(value));
const sum = (rows, field) => rows.reduce((total, row) => total + (finite(row[field]) ? Number(row[field]) : 0), 0);
export function reportCurrency(row) { return String(row.metadata?.currency || 'CNY').toUpperCase(); }
export function reportAttribution(row) { return String(row.metadata?.attributionWindow || row.metadata?.attribution || 'channel_reported'); }

/** One daily snapshot per execution unit. Parent totals are never added again. */
export function buildInsights(data, filters = {}) {
  const campaigns = data.campaigns || [], projects = data.projects || [];
  const campaignMap = new Map(campaigns.map(row => [row.id, row]));
  const currency = String(filters.currency || 'CNY').toUpperCase();
  const selectedCampaigns = campaigns.filter(row => (!filters.projectId || row.projectId === filters.projectId) && (!filters.channel || row.channel === filters.channel) && (!filters.campaignId || row.id === filters.campaignId));
  const ids = new Set(selectedCampaigns.map(row => row.id));
  const snapshots = dailySnapshots((data.metrics || []).filter(row => ids.has(row.campaignId) && (!filters.from || row.date >= filters.from) && (!filters.to || row.date <= filters.to) && reportCurrency(row) === currency));
  const summarize = rows => {
    const totals = metricTotals(rows), known = rows.filter(row => row.hasConversion === true && finite(row.revenue));
    const attribution = [...new Set(rows.map(reportAttribution))];
    const comparable = attribution.length <= 1;
    const impressionsComplete = rows.length > 0 && rows.every(row => finite(row.impressions));
    const clicksComplete = rows.length > 0 && rows.every(row => finite(row.clicks));
    const conversionsComplete = rows.length > 0 && rows.every(row => row.hasConversion === true && finite(row.conversions));
    const impressions = impressionsComplete ? sum(rows, 'impressions') : null;
    const clicks = clicksComplete ? sum(rows, 'clicks') : null;
    return { ...totals, roi: comparable ? totals.roi : null, knownRevenue: sum(known, 'revenue'), coveredSpend: sum(known, 'spend'), coverage: rows.length ? known.length / rows.length : 0, knownCount: known.length, freshCount: rows.filter(row => row.dataFresh === true).length, conversions: conversionsComplete ? sum(rows, 'conversions') : null, impressions, clicks, ctr: impressions > 0 && clicks != null ? clicks / impressions : null, comparable, attribution, days: new Set(rows.map(row => row.date)).size, updatedAt: rows.map(row => row.updatedAt || row.createdAt || '').sort().at(-1) || null };
  };
  const group = (keyOf, describe) => {
    const buckets = new Map();
    for (const row of snapshots) { const key = keyOf(row); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); }
    return [...buckets].map(([key, rows]) => ({ id: key, ...describe(key), ...summarize(rows) })).sort((a, b) => b.spend - a.spend);
  };
  const byProject = group(row => campaignMap.get(row.campaignId)?.projectId || row.projectId, id => ({ name: projects.find(row => row.id === id)?.title || '未命名素材包', projectId: id }));
  const byChannel = group(row => campaignMap.get(row.campaignId)?.channel || 'unknown', id => ({ channel: id }));
  const byCampaign = group(row => row.campaignId, id => ({ name: campaignMap.get(id)?.name || id, projectId: campaignMap.get(id)?.projectId, channel: campaignMap.get(id)?.channel }));
  const trend = group(row => row.date, id => ({ date: id })).sort((a, b) => a.date.localeCompare(b.date));
  return { ...summarize(snapshots), currency, filters, snapshots, byProject, byChannel, byCampaign, trend, campaignCount: selectedCampaigns.length, reportedCampaignCount: new Set(snapshots.map(row => row.campaignId)).size, activeCount: selectedCampaigns.filter(row => row.status === 'active').length, projectCount: new Set(selectedCampaigns.map(row => row.projectId)).size, latestDate: snapshots[0]?.date || null };
}

export const DECISION_STATUS = { proposed: '待决策', accepted: '已采纳', dismissed: '暂不采纳' };
export const STRATEGY_STATUS = { hypothesis: '待验证', validated: '已验证观察结果', active: '已发布为员工参考', rolled_back: '已回退' };
