'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, FolderOpen, Layers3, Search, SlidersHorizontal, X } from 'lucide-react';
import { Badge, Button, Empty, Panel } from './ui';
import { projectReadyCreatives, isPrimaryCreative } from './automation.mjs';
import { dateLabel, label, type Row } from './types';
import type { PlatformState } from './use-platform';
import { MEDIA_TYPES, mediaType } from '../../features/library/media';
import { ResourceCard } from '../../features/library/resource-card';
import '../../styles/platform/package-workspace.css';

const primary = (row: Row) => isPrimaryCreative(row);

export function Library({ state, onCampaign, selectedProject, onTasks, onProject }: {
    state: PlatformState; onCampaign: (creative: Row) => void; selectedProject?: string; onTasks?: (id: string) => void; onProject?: (id: string) => void;
}) {
    const [search, setSearch] = useState('');
    const [project, setProject] = useState(selectedProject || 'all');
    const [type, setType] = useState('all');
    const [readiness, setReadiness] = useState('all');
    useEffect(() => { setProject(selectedProject || 'all'); }, [selectedProject]);
    const query = search.trim().toLocaleLowerCase();
    const readyIds = new Set(state.data.projects.flatMap(item => projectReadyCreatives(item.id, state.data).filter(primary).map((row: Row) => row.id)));
    const records = state.data.creatives.filter(row => {
        if (project !== 'all' && row.projectId !== project) return false;
        if (type !== 'all' && mediaType(row) !== type) return false;
        if (readiness === 'ready' && !readyIds.has(row.id)) return false;
        const packageTitle = state.data.projects.find(item => item.id === row.projectId)?.title || '';
        return !query || [label(row), row.filename, packageTitle].join(' ').toLocaleLowerCase().includes(query);
    });
    const packages = state.data.projects.filter(item => records.some(row => row.projectId === item.id));
    const filtered = !!query || project !== 'all' || type !== 'all' || readiness !== 'all';
    function reset() { setSearch(''); setProject('all'); setType('all'); setReadiness('all'); }
    return <div className="bx-library">
        <div className="bx-library-overview"><div><span className="bx-library-eyebrow">M3 · 优化交付</span><h2>从原始资料，变成可投放的创意</h2><p>按素材包与生产批次管理实际成品，预览完整交付后进入投放。</p></div><div className="bx-library-count"><strong>{readyIds.size}</strong><span>条完整主成品</span></div></div>
        <div className="bx-library-controls"><div className="bx-library-tabs" role="group" aria-label="成品状态"><button className={readiness === 'all' ? 'active' : ''} aria-pressed={readiness === 'all'} onClick={() => setReadiness('all')}>全部交付<span>{state.data.creatives.length}</span></button><button className={readiness === 'ready' ? 'active' : ''} aria-pressed={readiness === 'ready'} onClick={() => setReadiness('ready')}>完整主成品<span>{readyIds.size}</span></button></div><div className="bx-library-filters"><label className="bx-library-search"><Search size={17}/><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索成品名称或素材包" aria-label="搜索成品"/>{search && <button type="button" className="bx-icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={14}/></button>}</label><label className="bx-library-filter"><SlidersHorizontal size={15}/><select value={type} onChange={event => setType(event.target.value)} aria-label="筛选成品类型">{MEDIA_TYPES.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><select value={project} onChange={event => setProject(event.target.value)} aria-label="筛选素材包"><option value="all">所有素材包</option>{state.data.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div></div>
        {filtered && <div className="bx-toolbar"><span className="bx-form-note">找到 {records.length} 份交付文件</span><button className="bx-text-button" onClick={reset}>清除筛选<X size={14}/></button></div>}
        {packages.map(item => {
            const rows = records.filter(row => row.projectId === item.id);
            const allReady = state.data.creatives.filter(row => row.projectId === item.id && readyIds.has(row.id));
            const batches = [...new Set(rows.map(row => row.metadata?.sourceJobId || 'imported'))];
            return <Panel key={item.id} className="bx-library-package" title={<span className="bx-projects-section-title"><FolderOpen size={18}/>{item.title}<Badge>{allReady.length} 条可投</Badge></span>} subtitle="原始资料留在 M1，所有优化结果在这里按批次保留。" action={<div className="bx-inline-actions">{onTasks && <Button secondary onClick={() => onTasks(item.id)}>继续优化</Button>}<Button disabled={!allReady.length} onClick={() => onCampaign({ ...allReady[0], projectId: item.id, creativeIds: allReady.map(row => row.id) })}>准备投放 {allReady.length} 条<ArrowRight size={15}/></Button></div>}>
                {batches.map(batchId => {
                    const batch = rows.filter(row => (row.metadata?.sourceJobId || 'imported') === batchId);
                    const job = state.data.jobs.find(row => row.id === batchId);
                    const main = batch.filter(primary);
                    const supporting = batch.filter(row => !primary(row));
                    return <section className="bx-creative-batch" key={batchId}><header><span><Layers3 size={16}/><strong>{batchId === 'imported' ? '手动归档' : job?.title || '员工生产批次'}</strong></span><small>{batchId !== 'imported' && `批次 ${batchId.slice(-8)} · `}{dateLabel(job?.createdAt || batch[0]?.createdAt)}</small></header>{main.length > 0 && <div className="bx-media-grid">{main.map(row => <ResourceCard key={row.id} row={row} kind="creatives" state={state}/>)}</div>}{supporting.length > 0 && <details className="bx-supporting-files"><summary>交付说明与辅助文件 · {supporting.length} 份</summary><div className="bx-media-grid">{supporting.map(row => <ResourceCard key={row.id} row={row} kind="creatives" state={state}/>)}</div></details>}</section>;
                })}
                {onProject && <button className="bx-text-button" onClick={() => onProject(item.id)}>查看这批成品的原始资料<ArrowRight size={14}/></button>}
            </Panel>;
        })}
        {!packages.length && <Panel><Empty icon={<FolderOpen size={28}/>} title={filtered ? '没有匹配的成品' : '等待第一批优化成品'} description={filtered ? '试试其他素材包、文件类型或名称。' : '上传原始资料，在任务中心安排员工优化。实际文件交付后会自动归档在这里。'} action={filtered ? <Button secondary onClick={reset}>清除筛选</Button> : onTasks ? <Button onClick={() => onTasks('')}>进入任务中心<ArrowRight size={15}/></Button> : undefined}/></Panel>}
    </div>;
}
