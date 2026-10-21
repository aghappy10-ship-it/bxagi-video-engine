import { dailySnapshots, metricTotals } from '../../components/platform/metrics.mjs';
import { projectReadyCreatives } from '../../components/platform/automation.mjs';
import { pendingRemoteJob, remoteJobs } from '../../components/platform/remote-jobs.mjs';
import type { Bootstrap, Row } from '../../components/platform/types';

export type DeliveryGroup = Row & { campaigns: Row[]; legacy?: boolean };
export type DeliveryData = Bootstrap & { deliveryGroups?: Row[]; audit?: Row[] };

export function readyPrimaryCreatives(projectId: string, data: Bootstrap): Row[] {
    return (projectReadyCreatives(projectId, data) as Row[]).filter(row => {
        if (!/^(image|video)\//.test(row.mimeType || '')) return false;
        const role = row.deliverableRole || row.metadata?.deliverableRole || row.metadata?.deliveryRole || row.metadata?.role || row.role;
        if (['cover', 'thumbnail', 'notes', 'subtitle', 'auxiliary'].includes(role)) return false;
        if (role === 'primary' || role === 'main') return true;
        return !/^(?:cover|thumbnail|封面)(?:[-_.\s]|$)/i.test(row.filename || '');
    });
}

export function deliveryGroups(data: DeliveryData): DeliveryGroup[] {
    const groups: DeliveryGroup[] = (data.deliveryGroups || []).map(group => ({
        ...group, campaigns: data.campaigns.filter(campaign => campaign.deliveryGroupId === group.id),
    }));
    const seen = new Set(groups.map(group => group.id));
    for (const campaign of data.campaigns) {
        if (campaign.deliveryGroupId && seen.has(campaign.deliveryGroupId)) continue;
        const id = campaign.deliveryGroupId || `legacy:${campaign.projectId}`;
        let group = groups.find(row => row.id === id);
        if (!group) {
            const project = data.projects.find(row => row.id === campaign.projectId);
            group = { id, projectId: campaign.projectId, name: project?.title || campaign.name, legacy: true, campaigns: [] };
            groups.push(group);
        }
        group.campaigns.push(campaign);
    }
    return groups;
}

export function unitCanLaunch(campaign: Row, data: Bootstrap) {
    return ['draft', 'blocked', 'paused', 'failed'].includes(campaign.status)
        && !campaign.operationId && !campaign.remoteState?.writePending
        && !remoteJobs(data).some((job: Row) => (job.campaignId === campaign.id || job.details?.campaignId === campaign.id) && pendingRemoteJob(job));
}
export function unitCanPause(campaign: Row) {
    return ['active', 'running'].includes(campaign.status) && !campaign.operationId && !campaign.remoteState?.writePending;
}
export function unitCanEditBudget(campaign: Row) {
    return ['draft', 'blocked', 'paused', 'active'].includes(campaign.status) && !campaign.operationId && !campaign.remoteState?.writePending;
}
export function unitCanSync(campaign: Row) {
    return ['active', 'paused'].includes(campaign.status) && !!campaign.remoteState?.projectId && !campaign.operationId && !campaign.remoteState?.writePending;
}
export function unitMetrics(data: Bootstrap, campaigns: Row[]) {
    const ids = new Set(campaigns.map(row => row.id));
    const snapshots = dailySnapshots(data.metrics.filter(row => ids.has(row.campaignId))) as Row[];
    const totals = metricTotals(snapshots);
    const completeField = (field: string) => snapshots.length && snapshots.every(row => row[field] != null && Number.isFinite(Number(row[field])))
        ? snapshots.reduce((sum, row) => sum + Number(row[field]), 0) : null;
    return { ...totals, snapshots, impressions: completeField('impressions'), clicks: completeField('clicks'), conversions: snapshots.every(row => row.hasConversion === true) ? completeField('conversions') : null };
}
export function unitAudit(data: DeliveryData, campaign: Row): Row[] {
    return (data.audit || []).filter(row => (row.entityType === 'campaign' && row.entityId === campaign.id) || row.details?.campaignId === campaign.id)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}
export function budgetChange(data: DeliveryData, campaign: Row) {
    const event = unitAudit(data, campaign).find(row => row.action === 'campaign.budget_edited' || ['ads.auto_increase', 'ads.budget_guard_reduce', 'ads.resume_budget_set', 'ads.budget_adjusted'].includes(row.action));
    const change = campaign.remoteState?.lastBudgetAdjustment;
    if (!event || change?.at && String(change.at) > String(event.createdAt || '')) {
        return change ? { event: { id: 'latest-budget', createdAt: change.at }, before: Number(change.previousBudget), after: Number(change.newBudget), actor: change.actor === 'user' ? '用户调整' : '投放员工', reason: change.reason || '渠道已确认预算变更' } : null;
    }
    const details = event.details || {};
    const before = details.before?.dailyBudget ?? details.previousBudget;
    const after = details.after?.dailyBudget ?? details.budgetGuard?.newBudget ?? details.decision?.newBudget ?? details.newBudget ?? details.appliedDailyBudget;
    return { event, before: before != null ? Number(before) : null, after: after != null ? Number(after) : null,
        actor: event.action === 'campaign.budget_edited' ? '用户调整' : event.action?.startsWith('ads.budget_guard') ? '额度保护' : '投放员工',
        reason: details.decision?.reason || details.reason || '已记录预算变更' };
}
export function groupStatus(group: DeliveryGroup) {
    const campaigns = group.campaigns;
    if (!campaigns.length) return { label: '待生成投放单元', tone: 'neutral' };
    const active = campaigns.filter(row => ['active', 'running'].includes(row.status)).length;
    const attention = campaigns.filter(row => ['failed', 'blocked', 'launch_uncertain', 'needs_reconciliation'].includes(row.status)).length;
    if (active) return { label: `${active} 条投放中${attention ? ` · ${attention} 条待处理` : ''}`, tone: attention ? 'amber' : 'green' };
    if (attention) return { label: `${attention} 条待处理`, tone: 'amber' };
    if (campaigns.every(row => row.status === 'paused')) return { label: '全部已暂停', tone: 'neutral' };
    if (campaigns.some(row => row.status === 'launching')) return { label: '投放提交中', tone: 'blue' };
    return { label: '待开始投放', tone: 'neutral' };
}
export function displayNumber(value: unknown) {
    return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('zh-CN');
}
export function errorText(campaign: Row) {
    const reasons = campaign.blockReasons || campaign.reasons;
    return Array.isArray(reasons) && reasons.length ? reasons.join('；') : typeof campaign.lastError === 'string' ? campaign.lastError : campaign.lastError?.message || campaign.error || '';
}
