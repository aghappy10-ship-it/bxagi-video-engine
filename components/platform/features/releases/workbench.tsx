'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, ClipboardList, Download, FileStack, Info, ListPlus, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import { ApiError, platformRequest, saveBlob } from '../../api';
import { Badge, Button, Empty, Panel } from '../../ui';
import { dateLabel, money } from '../../types';
import type { PlatformState } from '../../use-platform';
import { BatchImport, type BatchInput } from './batch-import';
import { ItemEditor } from './item-editor';
import { exportFilename, releaseBatchCsv } from './helpers.mjs';
import { PRIORITY_LABELS, PROMOTION_LABELS, type ReleaseBatch, type ReleaseEdit, type ReleaseItem } from './types';
import '../../../../styles/platform/release-workbench.css';

type Props = { state: PlatformState; onProject: (id: string) => void; onProduction: (id: string) => void };
type Editor = { batchId: string; revision: number; item: ReleaseItem };

export function ReleaseWorkbench({ state, onProject, onProduction }: Props) {
    const owner = state.data.user.id;
    const [batches, setBatches] = useState<ReleaseBatch[]>([]);
    const [selectedId, setSelectedId] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [formError, setFormError] = useState('');
    const [conflict, setConflict] = useState(false);
    const [notice, setNotice] = useState('');
    const [creating, setCreating] = useState(false);
    const [editor, setEditor] = useState<Editor | null>(null);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('all');
    const [priority, setPriority] = useState('all');
    const active = useRef(true);
    const mutationPending = useRef(false);
    const loadSequence = useRef(0);
    const requests = useRef(new Set<AbortController>());
    const ownerRef = useRef(owner);
    ownerRef.current = owner;

    const load = useCallback(async () => {
        const sequence = ++loadSequence.current;
        const controller = new AbortController();
        requests.current.add(controller);
        setLoading(true); setError('');
        try {
            const result = await platformRequest<{ batches: ReleaseBatch[] }>('/release-batches', { signal: controller.signal });
            if (!active.current || ownerRef.current !== owner || sequence !== loadSequence.current) return;
            setBatches(result.batches);
            setSelectedId(current => result.batches.some(batch => batch.id === current) ? current : result.batches[0]?.id || '');
        } catch (reason) {
            if (!active.current || controller.signal.aborted || ownerRef.current !== owner || sequence !== loadSequence.current) return;
            setError(reason instanceof Error ? reason.message : '剧目清单读取失败，请重试。');
        } finally {
            requests.current.delete(controller);
            if (active.current && ownerRef.current === owner && sequence === loadSequence.current) setLoading(false);
        }
    }, [owner]);

    useEffect(() => {
        active.current = true;
        setBatches([]); setSelectedId(''); setEditor(null); setCreating(false); setFormError(''); setNotice(''); setConflict(false); setBusy(false);
        if (owner) void load(); else setLoading(false);
        return () => { active.current = false; for (const controller of requests.current) controller.abort(); requests.current.clear(); };
    }, [load, owner]);

    async function mutate(path: string, method: 'POST' | 'PATCH', payload: unknown): Promise<ReleaseBatch | null> {
        if (mutationPending.current) return null;
        mutationPending.current = true;
        const requestOwner = owner;
        const controller = new AbortController();
        requests.current.add(controller);
        setBusy(true); setFormError(''); setNotice(''); setConflict(false);
        try {
            const result = await platformRequest<{ batch: ReleaseBatch }>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
            if (!active.current || ownerRef.current !== requestOwner) return null;
            // Ignore any older list request that might otherwise overwrite this saved revision.
            ++loadSequence.current; setLoading(false);
            setBatches(current => [result.batch, ...current.filter(batch => batch.id !== result.batch.id)]);
            setSelectedId(result.batch.id); setError('');
            return result.batch;
        } catch (reason) {
            if (!active.current || controller.signal.aborted || ownerRef.current !== requestOwner) return null;
            const stale = reason instanceof ApiError && reason.status === 409;
            setConflict(stale);
            setFormError(stale ? '这批资料已在其他窗口更新。可先刷新清单（保留当前输入），再关闭窗口核对最新资料并重新编辑。' : reason instanceof Error ? reason.message : '保存失败，请重试。');
            return null;
        } finally {
            requests.current.delete(controller);
            mutationPending.current = false;
            if (active.current && ownerRef.current === requestOwner) setBusy(false);
        }
    }

    async function create(input: BatchInput) {
        const batch = await mutate('/release-batches', 'POST', input);
        if (batch) { setCreating(false); setQuery(''); setFilter('all'); setPriority('all'); setNotice(`已保存 ${batch.items.length} 部剧的准备清单。`); }
    }
    async function save(edit: ReleaseEdit) {
        if (!editor) return;
        const result = await mutate(`/release-batches/${encodeURIComponent(editor.batchId)}/items/${encodeURIComponent(editor.item.id)}`, 'PATCH', { revision: editor.revision, ...edit });
        if (result) { setEditor(null); setNotice('资料已保存，缺项已重新检查。'); }
    }
    const batch = batches.find(item => item.id === selectedId);
    const projectNames = useMemo(() => new Map(state.data.projects.map(project => [project.id, project.title])), [state.data.projects]);
    const rows = useMemo(() => (batch?.items || []).filter(item => {
        return (!query.trim() || item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
            && (filter === 'all' || (filter === 'ready' ? item.readiness.ready : !item.readiness.ready))
            && (priority === 'all' || priority === item.priority);
    }), [batch, query, filter, priority]);
    function exportBatch() {
        if (!batch) return;
        saveBlob(new Blob([releaseBatchCsv(batch, state.data.projects)], { type: 'text/csv;charset=utf-8' }), exportFilename(batch.title));
        setNotice(`已导出整批 ${batch.items.length} 部剧的准备清单。`);
    }
    if (!owner) return <Panel><Empty title="登录后管理剧目准备" description="每个 BXAGI 账户拥有独立的剧单、素材和推广链接。" action={<Button onClick={state.openBxagiLogin}>登录 BXAGI</Button>}/></Panel>;
    return <div className="bx-release-workbench">
        <section className="bx-release-hero"><div><span className="bx-release-eyebrow">BATCH WORKSPACE</span><h2>一张剧单，统一准备</h2><p>把素材、授权与双链汇集到每部剧，优先解决阻塞项。</p></div><Button onClick={() => { setFormError(''); setCreating(true); }} disabled={busy}><ListPlus size={17}/>导入剧单</Button></section>
        <div className="bx-release-scope"><Info size={16}/><p>常读与创量接口尚未接入；本页管理投放准备，不会创建推广链或发起投放。</p></div>
        {notice && <div className="bx-release-notice" role="status"><CheckCircle2 size={16}/>{notice}</div>}
        {error && <div className="bx-release-error" role="alert"><span>{error}</span><Button secondary onClick={() => void load()} disabled={busy || loading}>重新读取</Button></div>}
        <div className="bx-release-toolbar"><label className="bx-release-batch-select"><span>最近 20 个批次</span><select aria-label="当前剧目批次" value={selectedId} onChange={event => { setSelectedId(event.target.value); setQuery(''); setFilter('all'); setPriority('all'); }} disabled={loading || busy || !batches.length}>{!batches.length && <option value="">尚无准备清单</option>}{batches.map(item => <option key={item.id} value={item.id}>{item.title} · {item.items.length} 部</option>)}</select></label><div className="bx-inline-actions"><Button secondary onClick={() => void load()} busy={loading} disabled={busy || creating || !!editor}><RefreshCw size={15}/>刷新</Button><Button secondary onClick={exportBatch} disabled={!batch || busy}><Download size={15}/>导出整批</Button></div></div>
        {loading && !batch ? <Panel><div className="bx-release-loading" role="status"><RefreshCw className="spin" size={22}/><span>正在读取已保存的剧目清单…</span></div></Panel> : !batch && error ? <Panel><Empty title="清单暂未读取" description="请重新读取以确认当前账户中已保存的批次。" icon={<RefreshCw size={26}/>}/></Panel> : !batch ? <Panel><Empty title="从第一批剧目开始" description="粘贴最多 100 部剧名，为每部设置 1–30 条素材目标。已建清单会保存在当前账户中。" icon={<ClipboardList size={28}/>} action={<Button onClick={() => { setFormError(''); setCreating(true); }}>导入剧单<ArrowRight size={16}/></Button>}/><div className="bx-release-empty-steps"><span><b>01</b>导入与关联素材</span><span><b>02</b>核验授权与双链</span><span><b>03</b>检查投放准备</span></div></Panel> : <>
            <div className="bx-release-stats"><div><span>本批剧目</span><strong>{batch.summary.total}<small>部</small></strong></div><div><span>计划素材目标</span><strong>{batch.summary.targetCount}<small>条</small></strong></div><div className="is-ready"><span>资料齐备</span><strong>{batch.summary.ready}<small>部</small></strong></div><div><span>待补齐</span><strong>{batch.summary.blocked}<small>部</small></strong></div></div>
            <Panel title={batch.title} subtitle={`更新于 ${dateLabel(batch.updatedAt)} · 目标数量用于规划，实际产量以员工交付为准。`} className="bx-release-list">
                <div className="bx-release-filters"><label className="bx-release-search"><Search size={16}/><input aria-label="搜索剧名" placeholder="搜索本批剧名" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="筛选准备状态" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部准备状态</option><option value="blocked">待补齐</option><option value="ready">资料齐备</option></select><select aria-label="筛选优先级" value={priority} onChange={event => setPriority(event.target.value)}><option value="all">全部优先级</option>{Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><span>{rows.length} / {batch.items.length} 部</span></div>
                {rows.length ? <div className="bx-release-table-scroll"><table className="bx-release-table"><thead><tr><th scope="col">剧目 / 素材包</th><th scope="col">成品进度</th><th scope="col">付费 / 免费链</th><th scope="col">计划日预算</th><th scope="col">准备状态</th><th scope="col">操作</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}>
                    <td><div className="bx-release-title"><strong>{item.title}</strong>{item.priority !== 'normal' && <Badge tone={item.priority === 'high' ? 'blue' : 'neutral'}>{PRIORITY_LABELS[item.priority]}</Badge>}</div><small className="bx-release-project"><FileStack size={12}/>{item.projectId ? projectNames.get(item.projectId) || '关联素材包待刷新' : '尚未关联素材包'}</small></td>
                    <td><strong className="bx-release-progress-count">{item.readiness.creativeCount}<span> / {item.targetCount}</span></strong><progress aria-label={`${item.title}成品进度`} max={item.targetCount} value={Math.min(item.readiness.creativeCount, item.targetCount)}/><small>{item.readiness.sourceCount} 份原始资料</small></td>
                    <td><LinkStatus item={item}/><small>{PROMOTION_LABELS[item.promotionMode]}模式</small></td>
                    <td><strong className="bx-release-budget">{item.dailyBudget > 0 ? money(item.dailyBudget) : '待设置'}</strong><small>仅规划，未执行</small></td>
                    <td className="bx-release-readiness"><Badge tone={item.readiness.ready ? 'green' : 'amber'}>{item.readiness.ready ? '资料齐备' : `${item.readiness.blockers.length} 项待补齐`}</Badge>{item.readiness.ready ? <small>未发起投放</small> : <><span title={item.readiness.blockers.join('；')}>{item.readiness.blockers[0] || '等待检查'}{item.readiness.blockers.length > 1 ? ` 等 ${item.readiness.blockers.length} 项` : ''}</span><details><summary>查看待办</summary><ul>{item.readiness.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul>{item.failureReason && <p>{item.failureReason}</p>}</details></>}</td>
                    <td><div className="bx-release-row-actions"><Button secondary onClick={() => { setFormError(''); setConflict(false); setEditor({ batchId: batch.id, revision: batch.revision, item }); }} disabled={busy}><SlidersHorizontal size={14}/>编辑资料</Button><button className="bx-text-button" onClick={() => item.projectId ? onProduction(item.projectId) : onProject('')}>{item.projectId ? '安排素材生产' : '创建素材包'}<ArrowRight size={13}/></button></div></td>
                </tr>)}</tbody></table></div> : <Empty title="没有匹配的剧目" description="调整剧名、准备状态或优先级筛选。" action={<Button secondary onClick={() => { setQuery(''); setFilter('all'); setPriority('all'); }}>清除筛选</Button>}/>}
                <p className="bx-release-table-footnote">“资料齐备”表示手工核验、素材、预算与所需链接均已登记；不代表平台已抢到投放资源。</p>
            </Panel>
        </>}
        {creating && <BatchImport onClose={() => setCreating(false)} onCreate={create} busy={busy} error={formError}/>}
        {editor && <ItemEditor key={`${editor.batchId}:${editor.item.id}:${editor.revision}`} item={editor.item} projects={state.data.projects} busy={busy} error={formError} conflict={conflict} refreshing={loading} onRefresh={() => void load()} onClose={() => setEditor(null)} onSave={save}/>}
    </div>;
}

function LinkStatus({ item }: { item: ReleaseItem }) {
    return <div className="bx-release-link-status">{(['paid', 'free'] as const).map(mode => {
        const link = item[`${mode}Link`];
        const complete = !!(link.id && link.url && link.startEpisode);
        const needed = item.promotionMode === 'both' || item.promotionMode === mode;
        return <span key={mode} className={complete ? 'is-complete' : !needed ? 'is-unused' : ''}><i/>{PROMOTION_LABELS[mode]}{complete ? '已录入' : needed ? '待补齐' : '选填'}</span>;
    })}</div>;
}
