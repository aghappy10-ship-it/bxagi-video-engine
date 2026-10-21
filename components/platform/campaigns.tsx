'use client';
/* eslint-disable @next/next/no-img-element -- Authenticated material thumbnails use the platform content endpoint. */
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, ChevronRight, FileImage, FolderOpen, Layers3, Pause, Play, Plus, RefreshCw, Search, Wallet } from 'lucide-react';
import { contentUrl, post } from './api';
import { operationOutcome } from './metrics.mjs';
import { queuedJobNotice } from './remote-jobs.mjs';
import { Badge, Button, Empty, Panel, Status } from './ui';
import { CHANNELS, dateLabel, money, type Row } from './types';
import type { PlatformState } from './use-platform';
import { DeliveryGroupForm } from '../../features/delivery/group-form';
import { BudgetEditor, GroupBudgetEditor, DeliveryStats, UnitActions, UnitDetail, type UnitOperation } from '../../features/delivery/unit-detail';
import { budgetChange, deliveryGroups, displayNumber, errorText, groupStatus, unitCanLaunch, unitCanPause, unitCanSync, unitMetrics, type DeliveryData, type DeliveryGroup } from '../../features/delivery/model';
import styles from '../../features/delivery/delivery.module.css';

export const CampaignForm = DeliveryGroupForm;

function readLocation() {
    if (typeof window === 'undefined') return { group: '', unit: '' };
    const search = new URLSearchParams(window.location.search);
    return { group: search.get('deliveryGroup') || '', unit: search.get('deliveryUnit') || '' };
}
function BudgetDelta({ state, campaign }: { state: PlatformState; campaign: Row }) {
    const change = budgetChange(state.data as DeliveryData, campaign);
    if (!change || change.before == null || change.after == null) return <span className={styles.muted}>暂无调整</span>;
    const delta = change.after - change.before;
    return <div className={delta > 0 ? styles.positive : delta < 0 ? styles.negative : styles.muted} title={change.reason}>
        <strong>{delta > 0 ? '↑' : delta < 0 ? '↓' : '—'} {delta === 0 ? '保持预算' : `${delta > 0 ? '+' : ''}${money(delta)}`}</strong>
        <small>{money(change.before)} → {money(change.after)}</small><small>{change.actor} · {dateLabel(change.event.createdAt)}</small>
    </div>;
}

export function Campaigns({ state, onCreate, onPerformance }: {
    state: PlatformState; onCreate: () => void; onPerformance: () => void;
}) {
    const [location, setLocation] = useState(readLocation);
    const [filter, setFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [budgetCampaign, setBudgetCampaign] = useState<Row>();
    const [groupEditor, setGroupEditor] = useState<'budget' | 'append' | null>(null);
    const [batchResults, setBatchResults] = useState<{ id: string; name: string; message: string; error: boolean }[]>([]);
    const groups = deliveryGroups(state.data as DeliveryData);
    const group = groups.find(row => row.id === location.group) || groups.find(row => row.campaigns.some(unit => unit.id === location.unit));
    const unit = group?.campaigns.find(row => row.id === location.unit);
    useEffect(() => { const handler = () => setLocation(readLocation()); window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, []);
    function navigate(groupId = '', unitId = '') {
        const url = new URL(window.location.href);
        if (groupId) url.searchParams.set('deliveryGroup', groupId); else url.searchParams.delete('deliveryGroup');
        if (unitId) url.searchParams.set('deliveryUnit', unitId); else url.searchParams.delete('deliveryUnit');
        window.history.pushState({}, '', url); setLocation({ group: groupId, unit: unitId }); setBatchResults([]);
    }
    async function operate(campaign: Row, operation: UnitOperation) {
        if (operation === 'launch' && !state.data.bxagi.connected) { state.openBxagiLogin(); return; }
        const result = await state.run(`${operation}-${campaign.id}`, () => post(`/campaigns/${encodeURIComponent(campaign.id)}/${operation}`, {}));
        const outcome = String(result?.provider || '').toLowerCase() === 'bxagi' ? queuedJobNotice(result, operation === 'launch' ? '投放员工执行任务' : '员工任务') : operationOutcome(result, operation);
        if (outcome?.error) state.setError(outcome.error);
        else if (outcome?.notice) state.setNotice(outcome.notice);
    }
    async function operateGroup(target: DeliveryGroup, operation: UnitOperation) {
        if (operation === 'launch' && !state.data.bxagi.connected) { state.openBxagiLogin(); return; }
        const units = target.campaigns.filter(row => operation === 'launch' ? unitCanLaunch(row, state.data) : operation === 'pause' ? unitCanPause(row) : unitCanSync(row));
        const result = await state.run(`${operation}-group-${target.id}`, async () => {
            const outcomes: { id: string; name: string; message: string; error: boolean }[] = [];
            for (const campaign of units) {
                try {
                    const response = await post(`/campaigns/${encodeURIComponent(campaign.id)}/${operation}`, {});
                    const outcome = String(response?.provider || '').toLowerCase() === 'bxagi' ? queuedJobNotice(response, '投放员工执行任务') : operationOutcome(response, operation);
                    outcomes.push({ id: campaign.id, name: campaign.name, message: outcome?.error || outcome?.notice || '请求已返回，请查看实际状态', error: !!outcome?.error });
                } catch (error) {
                    outcomes.push({ id: campaign.id, name: campaign.name, message: error instanceof Error ? error.message : '请求未完成，请核对当前状态', error: true });
                }
            }
            return outcomes;
        });
        if (result) { setBatchResults(result); state.setNotice(`已逐条处理 ${result.length} 个投放请求，结果见下方。`); }
    }
    const records = groups.filter(row => {
        const text = `${row.name} ${state.data.projects.find(project => project.id === row.projectId)?.title || ''}`.toLowerCase();
        return text.includes(search.toLowerCase()) && (filter === 'all' || row.campaigns.some(campaign => campaign.status === filter));
    });
    return <>
        {unit ? <UnitDetail key={unit.id} state={state} campaign={unit} back={() => navigate(group!.id)} operate={operate} editBudget={setBudgetCampaign} onPerformance={onPerformance}/> : group ? <div className={styles.stack}>
            <div className={styles.breadcrumb}><button onClick={() => navigate()}><ArrowLeft size={13}/> 素材包投放</button><ChevronRight size={13}/><span>{group.name}</span></div>
            <div className={styles.header}><div><h2>{group.name}</h2><p>{state.data.projects.find(row => row.id === group.projectId)?.title} · {group.campaigns.length} 个投放单元 · {group.legacy ? '历史计划归档' : '逐条独立执行'}</p></div><div className={styles.actions}><Badge tone={groupStatus(group).tone}>{groupStatus(group).label}</Badge><Button secondary onClick={onPerformance}>整体数据<ArrowUpRight size={14}/></Button></div></div>
            <DeliveryStats state={state} campaigns={group.campaigns}/>
            <Panel title="素材包预算" subtitle={group.legacy ? '历史计划保留原预算，各计划之间尚未设置共享包额度。' : '所有成品共用包级额度，每条素材保留自己的投放和预算记录。'} action={!group.legacy && <div className={styles.actions}><Button secondary onClick={() => setGroupEditor('budget')} disabled={!!state.busy}><Wallet size={14}/>调整包额度</Button><Button secondary onClick={() => setGroupEditor('append')} disabled={!!state.busy}><Plus size={14}/>添加成品</Button></div>}>
                <div className="bx-budget-row" style={{ borderBottom: 0, padding: 0 }}><div><small>包每日额度</small><strong>{group.legacy ? '独立计划预算' : money(group.dailyBudget)}</strong></div><div><small>已分配每日预算</small><strong>{money(group.campaigns.reduce((sum, row) => sum + Number(row.dailyBudget || 0), 0))}</strong></div><div><small>包总预算阈值</small><strong>{group.legacy ? '独立计划预算' : money(group.totalBudget)}</strong></div><div><small>投放单元</small><strong>{group.campaigns.length} <small style={{ display: 'inline' }}>条</small></strong></div></div>
            </Panel>
            <Panel title="包内成品投放" subtitle="成品分别由员工投放。点击名称查看完整效果、配置和调整记录。" action={<div className={styles.actions}>
                <Button disabled={!!state.busy || !group.campaigns.some(row => unitCanLaunch(row, state.data))} busy={state.busy === `launch-group-${group.id}`} onClick={() => operateGroup(group, 'launch')}><Play size={14}/>开始全部待投放</Button>
                <Button secondary disabled={!!state.busy || !group.campaigns.some(unitCanPause)} busy={state.busy === `pause-group-${group.id}`} onClick={() => operateGroup(group, 'pause')}><Pause size={14}/>暂停投放中</Button>
            </div>}>
                <div className="bx-table-scroll"><table className={`bx-table ${styles.table}`}><thead><tr><th>成品 / 版本</th><th>渠道 / 状态</th><th>当前日预算</th><th>最近预算变化</th><th>已同步消耗</th><th>曝光 / 转化</th><th>投产比</th><th>操作</th></tr></thead><tbody>{group.campaigns.map(campaign => {
                    const creative = state.data.creatives.find(row => row.id === campaign.creativeIds?.[0]);
                    const metrics = unitMetrics(state.data, [campaign]);
                    const shared = campaign.creativeIds?.length > 1;
                    return <tr key={campaign.id}><td><div className={styles.unitTitle}><span className={styles.thumb}>{creative?.mimeType?.startsWith('image/') ? <img src={contentUrl('creatives', creative.id)} alt="" loading="lazy"/> : creative?.mimeType?.startsWith('video/') ? <video src={contentUrl('creatives', creative.id)} muted playsInline preload="metadata" aria-label={`${creative.title || creative.filename} 缩略预览`}/> : <FileImage size={20}/>}</span><div className={styles.cellTitle}><button className={styles.packageLink} onClick={() => navigate(group.id, campaign.id)}>{shared ? campaign.name : creative?.title || creative?.filename || campaign.name}<ChevronRight size={12}/></button><small>{shared ? `${campaign.creativeIds.length} 条素材共享预算与报表` : creative?.metadata?.productionVersion?.batchId ? `批次 ${String(creative.metadata.productionVersion.batchId).slice(-8)}` : creative?.variantId || '已归档版本'}</small></div></div></td>
                        <td><Status status={campaign.status} context="campaign"/><small>{CHANNELS[campaign.channel] || campaign.channel}</small></td><td><strong>{money(campaign.dailyBudget)}</strong><small>总额 {money(campaign.totalBudget)}</small></td><td><BudgetDelta state={state} campaign={campaign}/></td><td><strong>{metrics.count ? money(metrics.spend) : '—'}</strong><small>{metrics.count ? `${metrics.count} 个每日快照` : '等待报表'}</small></td><td>{displayNumber(metrics.impressions)}<small>转化 {displayNumber(metrics.conversions)}</small></td><td><strong>{metrics.roi == null ? '—' : metrics.roi.toFixed(2)}</strong><small>{metrics.roi == null ? '等待收入回传' : '归因收入 / 消耗'}</small></td><td><UnitActions state={state} campaign={campaign} operate={operate} editBudget={setBudgetCampaign}/>{errorText(campaign) && <small title={errorText(campaign)} style={{ maxWidth: 220, whiteSpace: 'normal', color: '#a1743b' }}>{errorText(campaign)}</small>}</td></tr>;
                })}</tbody></table></div>
                {!group.campaigns.length && <Empty icon={<Layers3 size={26}/>} title="还没有独立投放单元" description="返回素材包配置，完成成品选择并创建投放草稿。"/>}
                <div className={styles.footer}><Button secondary disabled={!!state.busy || !group.campaigns.some(unitCanSync)} onClick={() => operateGroup(group, 'sync')}><RefreshCw size={14}/>同步本包报表</Button></div>
            </Panel>
            {!!batchResults.length && <Panel title="本次逐条执行结果"><div className="bx-table-scroll"><table className="bx-table"><thead><tr><th>投放单元</th><th>本次结果</th></tr></thead><tbody>{batchResults.map(row => <tr key={row.id}><td><button className={styles.packageLink} onClick={() => navigate(group.id, row.id)}>{row.name}</button></td><td style={{ whiteSpace: 'normal' }}><Badge tone={row.error ? 'amber' : 'blue'}>{row.error ? '需要处理' : '已返回'}</Badge> {row.message}</td></tr>)}</tbody></table></div></Panel>}
        </div> : <div className={styles.stack}>
            <div className={styles.header}><div><h2>素材包投放</h2><p>从一个素材包开始，让每条成品拥有独立的预算、执行和效果。</p></div><Button onClick={onCreate} disabled={!state.data.projects.length}><Plus size={16}/>创建素材包投放</Button></div>
            <div className={styles.cards}><div className={styles.card}><span>投放素材包</span><strong>{groups.length}</strong><small>按素材来源管理投放</small></div><div className={styles.card}><span>投放单元</span><strong>{state.data.campaigns.length}</strong><small>独立计划与历史计划</small></div><div className={styles.card}><span>正在投放</span><strong>{state.data.campaigns.filter(row => ['active', 'running'].includes(row.status)).length}</strong><small>以渠道确认状态为准</small></div><div className={styles.card}><span>等待启动</span><strong>{state.data.campaigns.filter(row => unitCanLaunch(row, state.data)).length}</strong><small>启动后由 BXAGI 员工执行</small></div></div>
            <div className="bx-toolbar"><div className="bx-segmented">{[['all', '全部素材包'], ['draft', '待投放'], ['active', '投放中'], ['paused', '已暂停']].map(([key, title]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{title}</button>)}</div><label className="bx-search"><Search size={15}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索素材包或投放名称" aria-label="搜索素材包投放"/></label></div>
            <Panel title="投放工作区" subtitle="进入素材包，查看全部成品的投放情况和预算变化。">{records.length ? <div className="bx-table-scroll"><table className={`bx-table ${styles.table}`}><thead><tr><th>素材包 / 投放</th><th>投放状态</th><th>成品单元</th><th>共享日预算</th><th>已同步消耗</th><th>投产比</th><th>渠道</th><th></th></tr></thead><tbody>{records.map(row => {
                const metrics = unitMetrics(state.data, row.campaigns); const status = groupStatus(row);
                return <tr key={row.id}><td><button className={styles.packageLink} onClick={() => navigate(row.id)}><FolderOpen size={20}/>{row.name}</button><small>{state.data.projects.find(project => project.id === row.projectId)?.title}</small></td><td><Badge tone={status.tone}>{status.label}</Badge></td><td>{row.campaigns.length} 条</td><td>{row.legacy ? '按历史计划分配' : money(row.dailyBudget)}</td><td>{metrics.count ? money(metrics.spend) : '—'}</td><td>{metrics.roi == null ? '—' : metrics.roi.toFixed(2)}</td><td>{[...new Set(row.campaigns.map(campaign => CHANNELS[campaign.channel] || campaign.channel))].join('、') || CHANNELS[row.channel] || '—'}</td><td><Button secondary onClick={() => navigate(row.id)}>进入投放<ChevronRight size={14}/></Button></td></tr>;
            })}</tbody></table></div> : <Empty icon={<Wallet size={28}/>} title={groups.length ? '没有符合筛选条件的投放' : '准备好成品，开始第一包投放'} description={groups.length ? '修改状态筛选或搜索关键词。' : '在素材中心确认优化成品后，选择渠道账户并设置整个素材包的预算。'} action={!groups.length ? <Button onClick={onCreate} disabled={!state.data.projects.length}><Plus size={16}/>创建投放草稿</Button> : undefined}/>}</Panel>
        </div>}
        {budgetCampaign && <BudgetEditor state={state} campaign={state.data.campaigns.find(row => row.id === budgetCampaign.id) || budgetCampaign} onClose={() => setBudgetCampaign(undefined)}/>}
        {group && groupEditor === 'budget' && <GroupBudgetEditor state={state} group={group} onClose={() => setGroupEditor(null)}/>}
        {group && groupEditor === 'append' && <DeliveryGroupForm state={state} group={group} onClose={() => setGroupEditor(null)}/>}
    </>;
}
