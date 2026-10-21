'use client';

import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Database, DownloadCloud, Pause, Play, RefreshCw, Search, Settings2 } from 'lucide-react';
import { Badge, Button, Empty, Modal, Panel } from '../../components/platform/ui';
import { dateLabel } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';
import { CATALOG_CONNECTION_LABELS, CATALOG_RUN_LABELS, catalogRunActive } from './helpers.mjs';
import { ContentSourceSettings } from './source-settings';
import type { CatalogItem } from './types';
import { useCatalogItems, useCatalogStatus } from './use-catalog';
import './catalog.css';

const MODES = { paid: '付费', free: '免费', unknown: '未标注' };

export function CatalogWorkbench({ state }: { state: PlatformState }) {
    return <CatalogWorkspace key={state.data.user.id} state={state}/>;
}

function CatalogWorkspace({ state }: { state: PlatformState }) {
    const control = useCatalogStatus(state.data.user.id, true);
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [pagination, setPagination] = useState({ source: '', cursors: [''] });
    const [configure, setConfigure] = useState(false);
    const [selection, setSelection] = useState<{ source: string; item: CatalogItem } | null>(null);
    const status = control.status;
    const sourceKey = status?.source.distributorId || '';
    const selected = selection?.source === sourceKey ? selection.item : null;
    if (selection && selection.source !== sourceKey) setSelection(null);
    const setSelected = (item: CatalogItem | null) => setSelection(item ? { source: sourceKey, item } : null);
    const cursors = pagination.source === sourceKey ? pagination.cursors : [''];
    const run = status?.run;
    const active = catalogRunActive(status);
    const scheduled = status?.source.autoSync && run?.status === 'completed' && !!run.nextRunAt;
    const revision = `${status?.source.distributorId || ''}:${run?.inserted || 0}:${run?.updated || 0}:${run?.finishedAt || ''}`;
    const list = useCatalogItems(state.data.user.id, sourceKey, query, cursors[cursors.length - 1], revision);
    const data = list.data;
    useEffect(() => { const timer = window.setTimeout(() => { setQuery(search.trim()); setPagination({ source: sourceKey, cursors: [''] }); }, 250); return () => window.clearTimeout(timer); }, [search, sourceKey]);

    return <div className="bx-catalog">
        <header className="bx-catalog-hero"><div><span className="bx-catalog-kicker"><DownloadCloud size={15}/>常读 · 自动抓剧</span><h2>新剧资料，自动进入你的素材库</h2><p>接口分页抓取，增量去重与断点续抓。查询已入库剧目，不等待整批同步。</p></div><div className="bx-catalog-actions"><Button secondary onClick={() => setConfigure(true)}><Settings2 size={16}/>配置内容源</Button>{active || scheduled ? <Button secondary busy={control.busy === 'pause'} onClick={() => void control.command('pause')}><Pause size={16}/>{scheduled ? '暂停自动抓取' : '暂停抓取'}</Button> : <Button busy={control.busy === 'sync'} disabled={control.loading || !status?.source.configured || !status?.integration.configured} onClick={() => void control.command('sync')}><Play size={16}/>{run?.status === 'paused' ? '继续抓取' : '开始抓取'}</Button>}</div></header>

        {!control.loading && status && (!status.source.configured || !status.integration.configured) && <div className="bx-catalog-notice is-warning"><strong>{!status.integration.configured ? '常读取数接口待接通' : '先连接你的常读内容源'}</strong><p>{!status.source.configured ? '填写常读提供的分销商标识与签名密钥。' : '账号配置已保存，仍需平台管理员完成官方剧目接口适配。'} 接通并成功读取后，这里将展示真实剧目。</p></div>}
        {control.error && <div className="bx-catalog-notice is-error" role="alert"><span>{control.error}</span><button type="button" className="bx-text-button" onClick={control.refresh}>重试</button></div>}
        <div className="bx-catalog-summary"><div><span>当前匹配的剧目资料</span><strong>{data ? data.total.toLocaleString('zh-CN') : '—'}<small>部</small></strong></div><div><span>本轮抓取</span><strong>{scheduled ? '等待下一轮' : run ? CATALOG_RUN_LABELS[run.status] : control.loading ? '读取中' : '尚未启动'}</strong><small>{run ? `已处理 ${run.processed} 条 · ${run.pages} 页` : '启动后显示真实进度'}</small></div><div><span>本轮入库</span><strong>{run ? run.inserted : '—'}<small>新增</small></strong><small>{run ? `更新 ${run.updated} 条` : '自动识别重复记录'}</small></div><div><span>调度方式</span><strong>{!status ? '待检查' : status.scheduler.running ? '后台运行' : '页面跟进'}</strong><small>{!status ? '正在读取调度状态' : status.scheduler.running ? '以后台健康状态为准' : '后台未连接 · 关闭页面后不保证继续'}</small></div></div>

        <Panel title="剧目资料" subtitle="仅同步剧名、集数与源站状态；不代表已下载视频或已获得推广链接。" action={<Button secondary className="bx-catalog-refresh" disabled={list.loading} onClick={() => { list.refresh(); void control.refresh(); }}><RefreshCw size={15}/>刷新资料</Button>}>
            <div className="bx-catalog-toolbar"><label className="bx-catalog-search"><Search size={17}/><input type="search" aria-label="搜索已入库剧目" placeholder="搜索已入库的剧名或来源 ID" value={search} onChange={event => setSearch(event.target.value)}/></label><span className="bx-catalog-meta">{data && !list.loading ? `服务端查询 ${Math.round(data.queryMs)} ms` : list.loading ? data ? '正在更新资料…' : '正在查询资料…' : '查询已入库资料'}</span></div>
            <div className="bx-catalog-meta bx-catalog-progress" aria-live="polite">{status && <><Badge tone={status.source.connectionStatus === 'verified' ? 'green' : 'amber'}>{CATALOG_CONNECTION_LABELS[status.source.connectionStatus]}</Badge><span>最近成功读取 {dateLabel(status.source.lastSuccessAt)}</span></>}{run?.nextRunAt && (active || scheduled) && <span>下一次读取 {dateLabel(run.nextRunAt)}</span>}</div>
            {run?.status === 'failed' && <div className="bx-catalog-notice is-error">上次抓取失败，已入库资料保留。检查内容源后可重新启动。</div>}
            {list.error && data && <p className="bx-catalog-notice is-error" role="alert">{list.error} 当前展示上次成功读取的资料。</p>}
            {list.loading && !data ? <div className="bx-catalog-empty" role="status">正在读取已入库剧目…</div> : list.error && !data ? <Empty icon={<Database size={28}/>} title="资料暂时无法读取" description={list.error} action={<Button secondary onClick={list.refresh}>重新读取</Button>}/> : !data?.items.length ? <Empty icon={<Database size={28}/>} title={query ? '没有匹配的剧目资料' : '还没有抓取到剧目'} description={query ? '换个剧名或来源 ID 试试。搜索只查询当前账号已入库资料。' : '内容源接通后，点击开始抓取。这里会按页显示真实结果，无需手动输入剧名。'} action={!status?.source.configured ? <Button secondary onClick={() => setConfigure(true)}>配置内容源</Button> : undefined}/> : <div className="bx-catalog-table-wrap"><table className="bx-catalog-table"><thead><tr><th>剧目 / 来源 ID</th><th>集数</th><th>业务类型</th><th>源站发布状态</th><th>发布时间</th><th>资料</th></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td><strong className="bx-catalog-title">{item.title}</strong><span className="bx-catalog-sub">{item.externalId}</span></td><td data-label="集数">{item.episodeCount ?? '—'}</td><td data-label="业务类型"><Badge tone={item.businessMode === 'paid' ? 'blue' : item.businessMode === 'free' ? 'green' : 'neutral'}>{MODES[item.businessMode]}</Badge></td><td data-label="源站发布状态">{item.releaseStatus || '未提供'}</td><td data-label="发布时间">{dateLabel(item.publishedAt)}</td><td data-label="剧目资料"><button className="bx-text-button" type="button" aria-label={`查看《${item.title}》资料`} onClick={() => setSelected(item)}>查看资料<ChevronRight size={14}/></button></td></tr>)}</tbody></table></div>}
            <div className="bx-catalog-pagination"><span>第 {cursors.length} 页 · 每页最多 50 条{data ? ` · 共 ${data.total.toLocaleString('zh-CN')} 条` : ''}</span><div className="bx-catalog-actions"><Button secondary disabled={!data || cursors.length <= 1} onClick={() => setPagination({ source: sourceKey, cursors: cursors.slice(0, -1) })}><ChevronLeft size={14}/>上一页</Button><Button secondary disabled={!data?.nextCursor} onClick={() => { if (data?.nextCursor) setPagination({ source: sourceKey, cursors: [...cursors, data.nextCursor] }); }}>下一页<ChevronRight size={14}/></Button></div></div>
            <p className="bx-catalog-meta">列表响应目标 1–2 秒；上方显示实际服务端查询耗时。源站抓取速度取决于接口响应及限流。</p>
        </Panel>
        {configure && <Modal title="配置内容源" description="为当前 BXAGI 账号连接常读剧目资料。" onClose={() => setConfigure(false)}><ContentSourceSettings state={state} onSaved={next => { control.accept(next); setPagination({ source: next.source.distributorId, cursors: [''] }); setSelected(null); list.refresh(); setConfigure(false); }}/></Modal>}
        {selected && <Modal title={selected.title} description="以下为最近一次从内容源读取的剧目资料。" onClose={() => setSelected(null)}><div className="bx-catalog-detail"><dl className="bx-catalog-detail-grid"><div><dt>来源 ID</dt><dd>{selected.externalId}</dd></div><div><dt>集数</dt><dd>{selected.episodeCount ?? '未提供'}</dd></div><div><dt>业务类型</dt><dd>{MODES[selected.businessMode]}</dd></div><div><dt>源站发布状态</dt><dd>{selected.releaseStatus || '未提供'}</dd></div><div><dt>发布时间</dt><dd>{dateLabel(selected.publishedAt)}</dd></div><div><dt>源站更新时间</dt><dd>{dateLabel(selected.sourceUpdatedAt)}</dd></div><div><dt>最近同步</dt><dd>{dateLabel(selected.lastSeenAt)}</dd></div></dl><p className="bx-catalog-notice">当前记录是剧目资料，尚不包含原始视频或付费／免费推广链。源站状态不等于投放授权。</p><div className="bx-catalog-actions"><Button secondary onClick={() => setSelected(null)}>关闭</Button></div></div></Modal>}
    </div>;
}
