'use client';
import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, BarChart3, Clock3, Pause, Play, RefreshCw, Wallet } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button, Empty, Field, Modal, Panel, Status, Badge } from '../../components/platform/ui';
import { post } from '../../components/platform/api';
import { RemoteJobCards } from '../../components/platform/remote-jobs';
import { remoteJobs } from '../../components/platform/remote-jobs.mjs';
import { CHANNELS, OBJECTIVES, dateLabel, employeeName, money, type Row } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';
import { MediaPreview } from '../library/media';
import { budgetChange, displayNumber, errorText, unitAudit, unitCanEditBudget, unitCanLaunch, unitCanPause, unitCanSync, unitMetrics, type DeliveryData, type DeliveryGroup } from './model';
import styles from './delivery.module.css';

export type UnitOperation = 'launch' | 'pause' | 'sync';
export function DeliveryStats({ state, campaigns }: { state: PlatformState; campaigns: Row[] }) {
    const metrics = unitMetrics(state.data, campaigns);
    const coverage = new Set(metrics.snapshots.map(row => row.campaignId)).size;
    return <><div className={styles.cards}>
        <div className={styles.card}><span>已同步消耗</span><strong>{metrics.count ? money(metrics.spend) : '—'}</strong><small>{coverage} / {campaigns.length} 条投放已有报表</small></div>
        <div className={styles.card}><span>归因收入</span><strong>{metrics.revenue == null ? '—' : money(metrics.revenue)}</strong><small>{metrics.revenue == null ? '等待完整收入回传' : '已同步报表范围内'}</small></div>
        <div className={styles.card}><span>投产比 ROAS</span><strong>{metrics.roi == null ? '—' : metrics.roi.toFixed(2)}</strong><small>归因收入 ÷ 同期消耗</small></div>
        <div className={styles.card}><span>转化次数</span><strong>{displayNumber(metrics.conversions)}</strong><small>按渠道归因口径统计</small></div>
    </div>{state.data.capabilities?.metricsTruncated && <p className={styles.callout}>当前仅加载最近一批报表，以上为已加载数据范围，不能作为完整历史累计。</p>}</>;
}

export function UnitActions({ state, campaign, operate, editBudget }: { state: PlatformState; campaign: Row; operate: (campaign: Row, operation: UnitOperation) => void; editBudget: (campaign: Row) => void }) {
    return <div className={styles.actions}>
        {unitCanLaunch(campaign, state.data) && <Button disabled={!!state.busy} busy={state.busy === `launch-${campaign.id}`} onClick={() => operate(campaign, 'launch')}><Play size={14}/>{campaign.status === 'paused' ? '恢复投放' : '开始投放'}</Button>}
        {unitCanPause(campaign) && <Button secondary disabled={!!state.busy} busy={state.busy === `pause-${campaign.id}`} onClick={() => operate(campaign, 'pause')}><Pause size={14}/>暂停</Button>}
        {unitCanEditBudget(campaign) && <Button secondary disabled={!!state.busy} onClick={() => editBudget(campaign)}><Wallet size={14}/>调预算</Button>}
    </div>;
}

function Trend({ snapshots }: { snapshots: Row[] }) {
    const [field, setField] = useState('spend');
    const points = [...snapshots].sort((a, b) => String(a.date).localeCompare(String(b.date))).map(row => ({
        date: row.date, value: field === 'roi' ? row.hasConversion && row.revenue != null && Number(row.spend) > 0 ? Number(row.revenue) / Number(row.spend) : null : field === 'revenue' ? row.hasConversion && row.revenue != null ? Number(row.revenue) : null : Number(row.spend),
    }));
    return <div><div className={styles.chartHeading}><span>每日实际报表</span><select value={field} onChange={event => setField(event.target.value)} aria-label="趋势指标"><option value="spend">消耗</option><option value="revenue">归因收入</option><option value="roi">投产比</option></select></div><div className={styles.chart}><ResponsiveContainer width="100%" height="100%"><AreaChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}><CartesianGrid stroke="#e9eef6" strokeDasharray="3 3" vertical={false}/><XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={value => String(value).slice(5)} axisLine={false} tickLine={false}/><YAxis width={45} tick={{ fontSize: 10 }} axisLine={false} tickLine={false}/><Tooltip formatter={value => [value == null ? '待回传' : field === 'roi' ? Number(value).toFixed(2) : money(value), field === 'spend' ? '消耗' : field === 'revenue' ? '归因收入' : '投产比']}/><Area type="linear" dataKey="value" stroke="#527fc2" fill="#e9f0fc" strokeWidth={2} connectNulls={false} dot={{ r: 3 }}/></AreaChart></ResponsiveContainer></div></div>;
}

const ACTION_NAMES: Record<string, string> = {
    'campaign.created': '创建投放草稿', 'campaign.budget_edited': '用户调整预算', 'ads.launched': '渠道投放已启动', 'ads.paused': '投放已暂停', 'ads.resumed': '投放已恢复',
    'ads.auto_increase': '员工上调预算', 'ads.auto_pause': '员工暂停投放', 'ads.budget_guard_reduce': '额度保护：收缩预算', 'ads.budget_guard_pause': '额度保护：暂停投放',
    'ads.resume_budget_set': '恢复前确认预算', 'ads.synced': '渠道效果已同步', 'ads.sync_failed': '报表同步待处理', 'ads.operation_failed': '渠道操作待核对', 'ads.budget_adjusted': '渠道预算已调整', 'ads.budget_changed': '渠道预算已调整',
};

export function UnitDetail({ state, campaign, back, operate, editBudget, onPerformance }: { state: PlatformState; campaign: Row; back: () => void; operate: (campaign: Row, operation: UnitOperation) => void; editBudget: (campaign: Row) => void; onPerformance: () => void }) {
    const [tab, setTab] = useState('performance');
    const creatives = state.data.creatives.filter(row => campaign.creativeIds?.includes(row.id));
    const primary = creatives[0];
    const shared = creatives.length > 1;
    const metrics = unitMetrics(state.data, [campaign]);
    const events = unitAudit(state.data as DeliveryData, campaign);
    const reports = remoteJobs(state.data).filter((job: Row) => job.campaignId === campaign.id || job.details?.campaignId === campaign.id);
    const connection = state.data.connections.find(row => row.id === campaign.connectionId);
    const error = errorText(campaign);
    const lastChange = budgetChange(state.data as DeliveryData, campaign);
    const latest = metrics.snapshots[0];
    return <div className={styles.stack}>
        <div className={styles.breadcrumb}><button onClick={back}><ArrowLeft size={13}/> 返回包内投放</button><span>/</span><span>{primary?.title || campaign.name}</span></div>
        <div className={styles.header}><div><h2>{primary?.title || campaign.name}</h2><p>{CHANNELS[campaign.channel] || campaign.channel} · {connection?.label || connection?.accountId || '渠道账户待配置'} · {shared ? '旧版多素材共享计划' : '独立素材投放'}</p></div><div className={styles.actions}><Status status={campaign.status} context="campaign"/><UnitActions state={state} campaign={campaign} operate={operate} editBudget={editBudget}/></div></div>
        {shared && <p className={styles.callout}>此历史计划包含 {creatives.length} 条成品，预算和报表由整个计划共享，当前数据不代表某一条素材的独立效果。</p>}
        {error && <p className="bx-inline-warning">{error}</p>}
        <DeliveryStats state={state} campaigns={[campaign]}/>
        <div className="bx-toolbar"><div className="bx-segmented">{[['performance', '效果趋势'], ['config', '素材与配置'], ['history', '调整记录'], ['reports', '员工汇报']].map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}</div><span className={styles.muted}>最近同步：{dateLabel(campaign.lastSyncedAt || latest?.updatedAt || latest?.createdAt)}</span></div>
        {tab === 'performance' && <>
            <Panel title="投放效果" subtitle="展示已经同步的每日快照，未回传的指标保留为空。" action={unitCanSync(campaign) ? <Button secondary disabled={!!state.busy} onClick={() => operate(campaign, 'sync')}><RefreshCw size={14}/>同步渠道</Button> : undefined}>
                {metrics.snapshots.length ? <><Trend snapshots={metrics.snapshots}/><div className={styles.cards} style={{ marginTop: 18 }}><div className={styles.card}><span>曝光量</span><strong>{displayNumber(metrics.impressions)}</strong></div><div className={styles.card}><span>点击量</span><strong>{displayNumber(metrics.clicks)}</strong></div><div className={styles.card}><span>点击率 CTR</span><strong>{metrics.impressions && metrics.clicks != null ? `${(metrics.clicks / metrics.impressions * 100).toFixed(2)}%` : '—'}</strong></div><div className={styles.card}><span>转化成本</span><strong>{metrics.conversions && metrics.spend >= 0 ? money(metrics.spend / metrics.conversions) : '—'}</strong></div></div></> : <Empty icon={<BarChart3 size={28}/>} title="等待真实投放效果" description="渠道开始投放并返回报表后，这里会显示消耗、转化和投产比。"/>}
            </Panel>
            {!!metrics.snapshots.length && <Panel title="每日报表明细"><div className="bx-table-scroll"><table className="bx-table"><thead><tr><th>日期</th><th>消耗</th><th>收入</th><th>曝光</th><th>点击</th><th>转化</th><th>投产比</th><th>来源 / 数据状态</th></tr></thead><tbody>{metrics.snapshots.map(row => <tr key={row.id || row.date}><td>{row.date}</td><td>{money(row.spend)}</td><td>{row.hasConversion && row.revenue != null ? money(row.revenue) : '—'}</td><td>{displayNumber(row.impressions)}</td><td>{displayNumber(row.clicks)}</td><td>{row.hasConversion ? displayNumber(row.conversions) : '—'}</td><td>{row.hasConversion && row.revenue != null && Number(row.spend) > 0 ? (Number(row.revenue) / Number(row.spend)).toFixed(2) : '—'}</td><td><Badge tone={row.source === 'manual' ? 'amber' : 'blue'}>{row.source === 'manual' ? '人工核实' : '渠道回传'}</Badge><small>{row.dataFresh ? '已刷新' : '待确认时效'}</small></td></tr>)}</tbody></table></div></Panel>}
        </>}
        {tab === 'config' && <Panel title="素材版本与投放配置"><div className={styles.detailColumns}><div>{primary && <div className={styles.preview}><MediaPreview row={primary} kind="creatives"/></div>}{creatives.length > 1 && <p className={styles.muted}>共享成品：{creatives.map(row => row.title || row.filename).join('、')}</p>}</div><dl className={styles.definition}>
            <dt>素材包</dt><dd>{state.data.projects.find(row => row.id === campaign.projectId)?.title || '—'}</dd><dt>成品版本</dt><dd>{primary?.metadata?.productionVersion?.batchId || primary?.variantId || '归档版本'}</dd><dt>投放员工</dt><dd>{campaign.buyingEmployeeId ? employeeName(state.data, campaign.buyingEmployeeId) : '启动时从 BXAGI 市场匹配'}</dd><dt>渠道账户</dt><dd>{connection?.accountId || '—'}</dd><dt>投放目标</dt><dd>{OBJECTIVES[campaign.objective] || campaign.objective}</dd><dt>当前日预算</dt><dd>{money(campaign.dailyBudget)}</dd><dt>日预算上限</dt><dd>{money(campaign.maxDailyBudget)}</dd><dt>累计预算阈值</dt><dd>{money(campaign.totalBudget)}</dd><dt>目标投产比</dt><dd>{Number(campaign.targetRoi)?.toFixed(2) || '—'}</dd><dt>自动调整</dt><dd>{campaign.autoOptimize ? '允许员工在授权额度内调整' : '由用户确认调整'}</dd><dt>渠道计划 ID</dt><dd>{campaign.remoteId || '尚未创建'}</dd><dt>渠道素材 ID</dt><dd>{campaign.remoteState?.promotionIds?.join('、') || '尚未创建'}</dd><dt>最近预算变更</dt><dd>{lastChange ? `${lastChange.before == null ? '—' : money(lastChange.before)} → ${lastChange.after == null ? '—' : money(lastChange.after)} · ${lastChange.actor}` : '暂无变更记录'}</dd>
        </dl></div></Panel>}
        {tab === 'history' && <Panel title="预算与执行记录" subtitle="区分用户操作、员工建议以及渠道实际确认结果。">{events.length ? <ol className={styles.timeline}>{events.map(row => <li key={row.id}><h3>{ACTION_NAMES[row.action] || row.action}</h3>{row.details?.before?.dailyBudget != null && row.details?.after?.dailyBudget != null && <p>{money(row.details.before.dailyBudget)} → {money(row.details.after.dailyBudget)}</p>}{row.details?.previousBudget != null && (row.details?.budgetGuard?.newBudget ?? row.details?.decision?.newBudget ?? row.details?.newBudget) != null && <p>{money(row.details.previousBudget)} → {money(row.details.budgetGuard?.newBudget ?? row.details.decision?.newBudget ?? row.details.newBudget)}</p>}<p>{row.details?.decision?.reason || row.details?.reason || row.details?.message || '操作已记录'}</p><small>{dateLabel(row.createdAt)}{row.details?.readback ? ' · 渠道结果已核对' : ''}</small></li>)}</ol> : <Empty icon={<Clock3 size={26}/>} title="暂无操作记录" description="投放启动、预算调整、暂停和渠道反馈会记录在这里。"/>}</Panel>}
        {tab === 'reports' && <Panel title="BXAGI 投放员工汇报" subtitle="展示该投放单元的实际员工任务与效果建议。">{reports.length ? <><RemoteJobCards state={state} campaignId={campaign.id}/>{reports.map((job: Row) => {
            const summary = job.details?.decision?.reason || job.details?.result?.summary || job.details?.report?.summary || job.details?.summary;
            return typeof summary === 'string' && summary.trim() ? <div className={styles.report} key={job.id}><strong>{dateLabel(job.updatedAt || job.createdAt)}</strong><p>{summary}</p></div> : null;
        })}</> : <Empty icon={<Clock3 size={26}/>} title="员工尚未提交汇报" description="启动投放后，任务进度和基于真实报表的反馈会归档到这里。"/>}</Panel>}
        <div className={styles.actions}><Button secondary onClick={onPerformance}>查看整体数据中心<ArrowUpRight size={14}/></Button></div>
    </div>;
}

export function BudgetEditor({ state, campaign, onClose }: { state: PlatformState; campaign: Row; onClose: () => void }) {
    const group = (state.data as DeliveryData).deliveryGroups?.find(row => row.id === campaign.deliveryGroupId);
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const result = await state.run(`budget-${campaign.id}`, () => post(`/campaigns/${campaign.id}/budget`, {
            dailyBudget: Number(form.get('dailyBudget')), totalBudget: Number(form.get('totalBudget')),
            maxDailyBudget: Number(form.get('maxDailyBudget')), targetRoi: Number(form.get('targetRoi')),
        }));
        if (!result) return;
        const updated = result.campaign || result;
        if (updated.error || ['needs_reconciliation', 'launch_uncertain'].includes(updated.status)) {
            state.setError(updated.error || '渠道结果仍需核对，请确认当前实际预算。'); return;
        }
        state.setNotice(result.readback ? '预算调整已由渠道确认。' : '投放预算已保存，将在启动或恢复时使用。');
        onClose();
    }
    return <Modal title="调整单条投放预算" description={campaign.name} onClose={onClose} closeDisabled={state.busy === `budget-${campaign.id}`}><form onSubmit={submit}>
        {group && <p className={styles.callout}>本素材包日预算 {money(group.dailyBudget)}，总预算 {money(group.totalBudget)}。调整后，所有子投放分配合计仍须在包额度内。</p>}
        <div className="bx-form-grid"><Field label="每日预算（元）"><input name="dailyBudget" type="number" min="0.01" step="0.01" required defaultValue={campaign.dailyBudget}/></Field><Field label="总预算阈值（元）"><input name="totalBudget" type="number" min="0.01" step="0.01" required defaultValue={campaign.totalBudget}/></Field><Field label="每日最高额度（元）"><input name="maxDailyBudget" type="number" min="0.01" step="0.01" required defaultValue={campaign.maxDailyBudget}/></Field><Field label="目标投产比"><input name="targetRoi" type="number" min="0.01" step="0.01" required defaultValue={campaign.targetRoi || 1.5}/></Field></div>
        <p className="bx-form-note">运行中的投放会向渠道提交预算更新并核对结果。暂停状态保持暂停；结果待核对时禁止重复提交。</p><footer className={styles.footer}><Button secondary type="button" onClick={onClose} disabled={!!state.busy}>取消</Button><Button type="submit" disabled={!!state.busy} busy={state.busy === `budget-${campaign.id}`}>保存预算</Button></footer>
    </form></Modal>;
}

export function GroupBudgetEditor({ state, group, onClose }: { state: PlatformState; group: DeliveryGroup; onClose: () => void }) {
    const assignedDaily = group.campaigns.reduce((sum, row) => sum + Number(row.dailyBudget || 0), 0);
    const assignedTotal = group.campaigns.reduce((sum, row) => sum + Number(row.totalBudget || 0), 0);
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const result = await state.run(`group-budget-${group.id}`, () => post(`/delivery-groups/${encodeURIComponent(group.id)}/budget`, { dailyBudget: Number(form.get('dailyBudget')), totalBudget: Number(form.get('totalBudget')) }));
        if (result) { state.setNotice('素材包额度已更新，各条投放的当前预算保持原分配。'); onClose(); }
    }
    return <Modal title="调整素材包额度" description={group.name} onClose={onClose} closeDisabled={state.busy === `group-budget-${group.id}`}><form onSubmit={submit}>
        <p className={styles.callout}>当前已分配日预算 {money(assignedDaily)}，总预算 {money(assignedTotal)}。提高额度后，可为现有投放调整预算或添加新成品。</p>
        <div className="bx-form-grid"><Field label="素材包日预算上限（元）"><input name="dailyBudget" type="number" min={Math.max(.01, Math.round(assignedDaily * 100) / 100)} step="0.01" defaultValue={group.dailyBudget} required/></Field><Field label="素材包总预算阈值（元）"><input name="totalBudget" type="number" min={Math.max(.01, Math.round(assignedTotal * 100) / 100)} step="0.01" defaultValue={group.totalBudget} required/></Field></div>
        <p className="bx-form-note">降低包额度前，需先降低现有投放分配。此操作仅改变包级额度，不会自动启动或放大任何单条投放。</p>
        <footer className={styles.footer}><Button secondary type="button" onClick={onClose} disabled={!!state.busy}>取消</Button><Button type="submit" disabled={!!state.busy} busy={state.busy === `group-budget-${group.id}`}>保存包额度</Button></footer>
    </form></Modal>;
}
