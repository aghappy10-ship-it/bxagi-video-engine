'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, DownloadCloud, FileText, FolderOpen, Plus } from 'lucide-react';
import { platformRequest, saveBlob } from './api';
import { Badge, Button, Empty, Panel } from './ui';
import { OBJECTIVES, dateLabel, type Row } from './types';
import type { PlatformState } from './use-platform';
import { ProjectNavigation } from '../../features/projects/project-navigation';
import { ProjectSources } from '../../features/projects/project-files';
import { useProjectFiles } from '../../features/projects/use-project-files';
import { CatalogWorkbench } from '../../features/catalog/catalog-workbench';
import { projectViewFromHash } from '../../features/catalog/helpers.mjs';
import '../../styles/platform/package-workspace.css';
export { NewProject } from '../../features/projects/new-project';

export function Projects({ state, selectedId, onSelect, onCreate, onTasks }: {
    state: PlatformState; selectedId: string; onSelect: (id: string) => void; onCreate: () => void; onTasks?: (id: string) => void;
}) {
    const [view, setView] = useState('packages');
    useEffect(() => {
        const readView = () => setView(projectViewFromHash(window.location.hash));
        readView();
        window.addEventListener('hashchange', readView);
        return () => window.removeEventListener('hashchange', readView);
    }, []);
    function selectView(next: string) {
        setView(next);
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#projects${next === 'catalog' ? '?view=catalog' : ''}`);
    }
    const project = state.data.projects.find(item => item.id === selectedId) || state.data.projects[0];
    const create = state.data.bxagi.connected ? onCreate : state.openBxagiLogin;
    return <div className="bx-catalog-shell"><nav className="bx-catalog-tabs" aria-label="素材管理视图"><button type="button" className={view === 'packages' ? 'active' : ''} aria-current={view === 'packages' ? 'page' : undefined} onClick={() => selectView('packages')}><FolderOpen size={16}/>原始素材包</button><button type="button" className={view === 'catalog' ? 'active' : ''} aria-current={view === 'catalog' ? 'page' : undefined} onClick={() => selectView('catalog')}><DownloadCloud size={16}/>自动抓剧</button></nav>
        {view === 'catalog' ? <CatalogWorkbench state={state}/> : !project ? <Panel className="bx-projects-empty"><Empty icon={<FolderOpen size={32}/>} title="把第一份资料放进素材包" description="一个商品、一段视频或一部短剧都可以成为素材包。先上传原始文件，再安排员工优化。" action={<Button onClick={create}><Plus size={16}/>新建素材包</Button>}/></Panel> : <div className="bx-projects-layout"><ProjectNavigation data={state.data} selectedId={project.id} onSelect={onSelect} onCreate={create}/><SourceWorkspace key={project.id} state={state} project={project} onTasks={onTasks}/></div>}
    </div>;
}
function SourceWorkspace({ state, project, onTasks }: { state: PlatformState; project: Row; onTasks?: (id: string) => void }) {
    const files = useProjectFiles(state, project);
    const assets = state.data.assets.filter(asset => asset.projectId === project.id);
    const source = project.sourceState;
    const uploading = source?.status === 'uploading';
    const facts = Array.isArray(project.facts) ? project.facts.filter((fact: unknown) => typeof fact === 'string' && fact.trim()) : [];
    async function exportPackage() {
        const result = await state.run('export-project', () => platformRequest(`/projects/${project.id}/export`));
        if (result) saveBlob(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), `${project.title}-素材包清单.json`);
    }
    return <div className="bx-projects-workspace">
        <header className="bx-projects-header"><div className="bx-projects-header-copy"><div className="bx-inline-tags"><Badge tone="blue">原始素材包</Badge><Badge tone={uploading ? 'amber' : assets.length ? 'green' : 'neutral'}>{uploading ? '上传待完成' : assets.length ? '资料已保存' : '等待上传'}</Badge></div><h2>{project.title}</h2><p>{project.description || '集中保存本次推广的原始文件与业务资料。'}</p></div><Button secondary disabled={!!state.busy} onClick={exportPackage}><FileText size={15}/>导出清单</Button></header>
        <div className="bx-package-facts"><div><span>原始文件</span><strong>{assets.length}<small>份</small></strong></div><div><span>产品 / 内容</span><strong>{project.productName || '未填写'}</strong></div><div><span>推广目标</span><strong>{OBJECTIVES[project.objective] || '暂未设置'}</strong></div><div><span>最近更新</span><strong>{dateLabel(project.updatedAt || project.createdAt)}</strong></div></div>
        <ProjectSources state={state} assets={assets} files={files}/>
        {files.retryCount !== null && <div className="bx-package-next is-warning" role="status"><div><strong>这一批上传尚未全部完成</strong><p>{files.retryCount ? `还有 ${files.retryCount} 份文件等待上传，已成功的文件会保留。` : '文件已保存，继续确认这一批素材即可。'}</p></div><Button secondary disabled={!!state.busy} onClick={files.retryAssets}>继续上传</Button></div>}
        {(facts.length > 0 || project.audience || project.landingUrl) && <Panel title="素材包补充资料" subtitle="这些内容将随优化任务交给员工。"><div className="bx-package-brief">{project.audience && <p><strong>目标人群</strong>{project.audience}</p>}{project.landingUrl && <p><strong>推广页面</strong><span>{project.landingUrl}</span></p>}{facts.length > 0 && <div><strong>已确认卖点与事实</strong><ul>{facts.map((fact: string, index: number) => <li key={index}>{fact}</li>)}</ul></div>}</div></Panel>}
        <div className="bx-package-next"><span className="bx-package-step">02</span><div><strong>资料准备好，就可以安排优化</strong><p>选择需要的成品数量、比例与员工。上传文件本身不会启动生产。</p></div><Button disabled={!assets.length || uploading || !!state.busy || files.retryCount !== null} onClick={() => onTasks?.(project.id)}>创建优化任务<ArrowRight size={16}/></Button></div>
    </div>;
}
