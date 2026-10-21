'use client';

import { useState } from 'react';
import { ChevronRight, FolderOpen, Plus, Search } from 'lucide-react';
import { OBJECTIVES, type Bootstrap } from '../../components/platform/types';

export function ProjectNavigation({ data, selectedId, onSelect, onCreate }: {
    data: Bootstrap;
    selectedId: string;
    onSelect: (id: string) => void;
    onCreate: () => void;
}) {
    const [query, setQuery] = useState('');
    const projects = data.projects.filter(project => String(project.title).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

    return <aside className="bx-projects-navigation" aria-label="素材包列表">
        <header><div><FolderOpen size={17}/><strong>素材包</strong><span>{data.projects.length}</span></div><button className="bx-icon-button" type="button" aria-label="新建素材包" title="新建素材包" onClick={onCreate}><Plus size={18}/></button></header>
        <label className="bx-projects-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索素材包" aria-label="搜索素材包"/></label>
        <div className="bx-projects-items">
            {projects.map(project => {
                const assets = data.assets.filter(asset => asset.projectId === project.id).length;
                return <button type="button" key={project.id} className={`bx-projects-item ${project.id === selectedId ? 'selected' : ''}`} aria-current={project.id === selectedId ? 'true' : undefined} onClick={() => onSelect(project.id)}>
                    <span className="bx-projects-item-heading"><strong>{project.title}</strong><ChevronRight size={15}/></span>
                    <small>{OBJECTIVES[project.objective] || project.objective || '目标未记录'}</small>
                    <span className="bx-projects-item-counts">{assets} 份原始素材<span>·</span>{project.sourceState?.status === 'uploading' ? '上传待完成' : '原始资料'}</span>
                </button>;
            })}
            {!projects.length && <p className="bx-projects-navigation-empty">没有匹配的素材包</p>}
        </div>
    </aside>;
}
