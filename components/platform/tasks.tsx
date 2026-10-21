'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Bot, CheckCircle2, Clock3, Layers3, Play, RefreshCw } from 'lucide-react';
import { post } from './api';
import { Employees } from './employees';
import { marketEntries, activationLabel, quoteText } from './market.mjs';
import { remoteJobs, pendingRemoteJob, queuedJobNotice, bxagiUploadLimit } from './remote-jobs.mjs';
import { RemoteJobCards } from './remote-jobs';
import { projectReadyCreatives } from './automation.mjs';
import { Badge, Button, Empty, Field, Panel, Status } from './ui';
import { FORMAT, type Row } from './types';
import type { PlatformState } from './use-platform';
import { ReleaseWorkbench } from './features/releases/workbench';
import { taskViewFromHash } from './features/releases/helpers.mjs';
import { ProductionPresetPicker } from '../../features/production/preset-picker';
import { buildProductionPreset, initialProductionInstructions } from '../../features/production/presets.mjs';
import '../../styles/platform/package-workspace.css';

type Props = { state: PlatformState; selectedProject?: string; onProject: (id: string) => void; onLibrary: (id: string) => void; initialTab?: 'tasks' | 'employees' };
export function Tasks({ state, selectedProject, onProject, onLibrary, initialTab = 'tasks' }: Props) {
    const [tab, setTab] = useState<'tasks' | 'employees' | 'releases'>(initialTab);
    const [optimizationTaskId, setOptimizationTaskId] = useState('');
    useEffect(() => { setOptimizationTaskId(new URLSearchParams(window.location.search).get('optimizationTask') || ''); }, []);
    const [projectId, setProjectId] = useState(selectedProject || state.data.projects[0]?.id || '');
    useEffect(() => { if (selectedProject) { setProjectId(selectedProject); if (initialTab !== 'employees' && new URLSearchParams(window.location.hash.split('?')[1] || '').get('view') !== 'releases') setTab('tasks'); } }, [selectedProject, initialTab]);
    useEffect(() => {
        const selectView = () => { const next = taskViewFromHash(window.location.hash); if (next) setTab(next); };
        selectView(); window.addEventListener('hashchange', selectView);
        return () => window.removeEventListener('hashchange', selectView);
    }, []);
    function selectTab(next: 'tasks' | 'employees' | 'releases') {
        setTab(next);
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#tasks${next === 'tasks' ? '' : `?view=${next}`}`);
    }
    const project = state.data.projects.find(item => item.id === projectId) || state.data.projects[0];
    const jobs = remoteJobs(state.data);
    const pending = jobs.filter(pendingRemoteJob);
    const optimizationTasks = state.data.optimizationTasks.filter(task => task.projectId === project?.id);
    const selectedTask = optimizationTasks.find(task => task.id === optimizationTaskId && task.status === 'pending' && task.metadata?.sourceDecisionId && task.metadata?.approval === 'accepted');
    return <div className="bx-tasks-workspace">
        <div className="bx-toolbar"><div className="bx-segmented" role="group" aria-label="任务中心页面"><button className={tab === 'tasks' ? 'active' : ''} aria-pressed={tab === 'tasks'} onClick={() => selectTab('tasks')}>任务与生产</button><button className={tab === 'releases' ? 'active' : ''} aria-pressed={tab === 'releases'} onClick={() => selectTab('releases')}>批量剧目准备</button><button className={tab === 'employees' ? 'active' : ''} aria-pressed={tab === 'employees'} onClick={() => selectTab('employees')}>员工与大管家</button></div><Badge tone="blue">BXAGI 官方员工</Badge></div>
        {tab === 'employees' ? <Employees state={state}/> : tab === 'releases' ? <ReleaseWorkbench key={state.data.user.id || 'signed-out'} state={state} onProject={onProject} onProduction={id => { setProjectId(id); setOptimizationTaskId(''); selectTab('tasks'); }}/> : <>
            <div className="bx-task-overview"><div><Clock3 size={19}/><span>执行与等待中</span><strong>{pending.length}</strong></div><div><CheckCircle2 size={19}/><span>已完成任务</span><strong>{jobs.filter((job: Row) => job.status === 'completed').length}</strong></div><div><Layers3 size={19}/><span>原始素材包</span><strong>{state.data.projects.length}</strong></div></div>
            {!project ? <Panel><Empty title="先上传一个素材包" description="创建素材包并上传原始文件后，在这里选择成品数量和优化员工。" icon={<Layers3 size={28}/>} action={<Button onClick={() => onProject('')}>前往素材管理<ArrowRight size={15}/></Button>}/></Panel> : <>
                <div className="bx-task-selector"><label htmlFor="task-project">当前素材包</label><select id="task-project" value={project.id} onChange={event => { setProjectId(event.target.value); setOptimizationTaskId(''); }}>{state.data.projects.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select><Button secondary onClick={() => onProject(project.id)}>查看原始资料</Button><Button secondary onClick={() => onLibrary(project.id)}>查看优化成品<ArrowRight size={15}/></Button></div>
                {optimizationTasks.length > 0 && <Panel title="经营建议与后续优化" subtitle="已采纳的素材建议会形成优化任务，确认生产设置后执行。"><div className="bx-task-list">{optimizationTasks.map(task => <article key={task.id}><span className="bx-task-icon"><Bot size={20}/></span><div><h3>{task.title || '下一轮素材优化'}</h3><p>{task.reason || task.metadata?.instructions || '结合真实反馈优化素材。'}</p><small>{task.metadata?.sourceDecisionId ? `来源：经营决策 ${String(task.metadata.sourceDecisionId).slice(-8)}` : '来源：投放效果反馈'}</small></div><Status status={task.status || 'pending'}/>{task.status === 'pending' && task.metadata?.sourceDecisionId && task.metadata?.approval === 'accepted' && <Button secondary={selectedTask?.id !== task.id} onClick={() => { setOptimizationTaskId(task.id); document.getElementById('production-composer')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>{selectedTask?.id === task.id ? '已选择此建议' : '按此建议优化'}</Button>}{task.status === 'completed' && <Button secondary onClick={() => onLibrary(project.id)}>查看新成品</Button>}</article>)}</div></Panel>}
                <ProductionComposer key={`${project.id}:${selectedTask?.id || 'manual'}`} state={state} project={project} onLibrary={onLibrary} optimizationTask={selectedTask} onClearTask={() => setOptimizationTaskId('')}/>
                <Panel title="本素材包的任务记录" subtitle="员工执行、交付回收和等待原因随真实状态更新。" action={<Button secondary disabled={!!state.busy} onClick={() => state.advanceAutomation()}><RefreshCw size={15}/>检查进度</Button>}>
                    {jobs.some((job: Row) => (job.projectId || job.details?.projectId) === project.id) ? <RemoteJobCards state={state} projectId={project.id}/> : <Empty title="等待第一项优化任务" description="选择右侧或上方的生产目标，点击开始优化后，任务会在这里持续更新。" icon={<Bot size={26}/>} />}
                </Panel>
            </>}
        </>}
    </div>;
}
function ProductionComposer({ state, project, onLibrary, optimizationTask, onClearTask }: { state: PlatformState; project: Row; onLibrary: (id: string) => void; optimizationTask?: Row; onClearTask: () => void }) {
    const saved = project.productionSpec || {};
    const [targetCount, setTargetCount] = useState(Number(saved.targetCount) || 3);
    const [mediaType, setMediaType] = useState(saved.mediaType || 'video');
    const [format, setFormat] = useState(saved.format || 'portrait');
    const [employeeMode, setEmployeeMode] = useState(saved.employeeMode || 'auto');
    const [employeeId, setEmployeeId] = useState(saved.employeeId || '');
    const [regenerate, setRegenerate] = useState(false);
    const [instructions, setInstructions] = useState(() => initialProductionInstructions(saved, optimizationTask));
    const [appliedPreset, setAppliedPreset] = useState<string | null>(null);
    const plan = !optimizationTask && appliedPreset ? buildProductionPreset({ presetId: appliedPreset, targetCount, mediaType, format }) : null;
    const submittedInstructions = plan?.instructions || instructions;
    function applyPreset(presetId: string) {
        if (optimizationTask) return;
        setAppliedPreset(presetId);
    }
    function useCustomInstructions(value: string) {
        if (optimizationTask) return;
        setInstructions(value);
        setAppliedPreset(null);
    }
    const assets = state.data.assets.filter(asset => asset.projectId === project.id);
    const market = marketEntries(state.data.employees) as Row[];
    const selectedEmployee = market.find(employee => employee.id === employeeId);
    const jobs = remoteJobs(state.data).filter((job: Row) => (job.projectId || job.details?.projectId) === project.id);
    const pending = jobs.some((job: Row) => pendingRemoteJob(job) && (job.details?.kind === 'production' || job.type === 'production' || job.kind === 'production'));
    const source = project.sourceState;
    const alreadyStarted = !!source?.startedJobId;
    const ready = projectReadyCreatives(project.id, state.data);
    const uploading = source?.status === 'uploading';
    const transferLimit = bxagiUploadLimit(state.data.capabilities);
    const oversized = assets.filter(asset => Number(asset.size) > transferLimit);
    async function start(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!state.data.bxagi.connected) return state.openBxagiLogin();
        const result = await state.run(`production-${project.id}`, async () => {
            let batchId = source?.batchId;
            if (alreadyStarted && regenerate && !optimizationTask) {
                const ids = assets.map(asset => asset.id);
                const opened = await post(`/projects/${project.id}/upload-batches`, { expectedCount: ids.length, reuseAssetIds: ids });
                if (!opened.batch?.id) throw new Error('未取得新的优化批次，请刷新后重试。');
                batchId = opened.batch.id;
                await post(`/projects/${project.id}/upload-batches/${encodeURIComponent(batchId)}/complete`, { assetIds: ids });
            }
            return post(`/projects/${project.id}/production`, { batchId, ...(optimizationTask ? { optimizationTaskId: optimizationTask.id } : {}), productionSpec: { version: 1, targetCount, mediaType, format, employeeMode, ...(employeeMode === 'manual' ? { employeeId } : {}), ...(submittedInstructions.trim() ? { instructions: submittedInstructions.trim() } : {}) } });
        });
        if (result) { setRegenerate(false); onClearTask(); const outcome = queuedJobNotice(result, '素材优化任务'); if (outcome.error) state.setError(outcome.error); else state.setNotice(outcome.notice || '优化任务已提交，成品将归档到优化素材中心。'); }
    }
    const blocked = !assets.length || oversized.length > 0 || uploading || pending || (alreadyStarted && !regenerate && !optimizationTask) || (employeeMode === 'manual' && !selectedEmployee);
    return <div id="production-composer"><Panel title="配置素材优化" subtitle="每个任务围绕同一素材包制作多个独立成品，交付后再安排投放。" className="bx-production-composer">
        <form onSubmit={start}>
            {optimizationTask && <div className="bx-package-next" style={{ margin: '0 0 20px' }}><div><strong>按已采纳的经营建议优化</strong><p>{optimizationTask.reason || optimizationTask.metadata?.instructions}</p></div><Button type="button" secondary onClick={onClearTask}>取消选择</Button></div>}
            <div className="bx-production-layout"><div className="bx-production-config">
                <fieldset className="bx-count-field"><legend>生成几条成品</legend><div>{[1, 2, 3].map(count => <button type="button" key={count} className={targetCount === count ? 'selected' : ''} aria-pressed={targetCount === count} onClick={() => setTargetCount(count)}><strong>{count}</strong><span>条素材</span></button>)}</div><small>每条成品用于独立投放与效果比较。</small></fieldset>
                <div className="bx-form-grid"><Field label="成品类型"><select value={mediaType} onChange={event => setMediaType(event.target.value)}><option value="video">视频</option><option value="image">图片</option></select></Field><Field label="画面比例"><select value={format} onChange={event => setFormat(event.target.value)}>{Object.entries(FORMAT).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></Field></div>
                {!optimizationTask && <ProductionPresetPicker targetCount={targetCount} mediaType={mediaType} format={format} appliedPreset={appliedPreset} disabled={!!state.busy} onApply={applyPreset} onCustom={() => useCustomInstructions(submittedInstructions)}/>}
                <Field label={optimizationTask ? '已采纳的优化要求' : '本次制作要求'} hint={plan ? '数量、类型和画幅变化会同步更新方案；编辑文字后按自定义要求提交。' : '这里的文字会随生产规格交给员工，最多 2000 字。'}><textarea readOnly={!!optimizationTask} value={submittedInstructions} onChange={event => useCustomInstructions(event.target.value)} maxLength={2000} rows={plan ? 8 : 4} placeholder="例如：分别突出外观、使用场景与核心卖点，保持产品本身真实一致。"/></Field>
            </div><div className="bx-production-employee"><div className="bx-production-kicker"><Bot size={18}/>执行员工</div><div className="bx-segmented"><button type="button" className={employeeMode === 'auto' ? 'active' : ''} onClick={() => setEmployeeMode('auto')}>自动匹配</button><button type="button" className={employeeMode === 'manual' ? 'active' : ''} onClick={() => setEmployeeMode('manual')}>手动指定</button></div>{employeeMode === 'auto' ? <div className="bx-auto-employee"><span className="bx-employee-avatar"><Bot size={27}/></span><h3>交给 BXAGI 安排</h3><p>根据本次生产目标与资料，从官方员工市场中匹配对应岗位。</p><Badge tone="blue">按真实能力调度</Badge></div> : <><Field label="选择市场员工"><select required value={employeeId} onChange={event => setEmployeeId(event.target.value)}><option value="">选择对应优化员工</option>{market.map(employee => <option key={employee.id} value={employee.id} disabled={employee.marketVerified !== true}>{employee.name || employee.title || employee.marketId} · {activationLabel(employee)}</option>)}</select></Field>{selectedEmployee && <div className="bx-selected-employee"><strong>{selectedEmployee.name || selectedEmployee.marketId}</strong><p>{selectedEmployee.description || '员工尚未提供岗位介绍。'}</p><Badge>{activationLabel(selectedEmployee)}</Badge><small>{quoteText(selectedEmployee)}</small></div>}{!market.length && <p className="bx-form-note">员工市场尚未读取，可以先使用自动匹配，或在“员工与大管家”中检查连接。</p>}</>}
            </div></div>
            {oversized.length > 0 && <p className="bx-inline-warning">{oversized.length} 份原始文件超过员工单文件 {Math.round(transferLimit / 1024 / 1024)} MiB 转交上限。请压缩或分段后建立新素材包；当前原件已完整保存。</p>}
            {alreadyStarted && !pending && !optimizationTask && <label className="bx-checkbox"><input type="checkbox" checked={regenerate} onChange={event => setRegenerate(event.target.checked)}/><span>使用这些原始资料创建新一批成品（保留已有版本）</span></label>}
            <footer className="bx-production-footer"><div><strong>{uploading ? '请先完成素材上传' : pending ? '已有任务正在执行' : alreadyStarted && !regenerate && !optimizationTask ? '这批资料已安排生产' : `${assets.length} 份原始资料 → ${targetCount} 条优化成品`}</strong><small>{ready.length ? `已有 ${ready.length} 条完整成品可以前往投放。` : '员工交付后，实际文件将出现在 M3 优化素材中心。'}</small></div><div className="bx-inline-actions">{ready.length > 0 && <Button secondary type="button" onClick={() => onLibrary(project.id)}>查看成品</Button>}<Button type="submit" disabled={blocked || !!state.busy} busy={state.busy === `production-${project.id}`}><Play size={16}/>{optimizationTask ? '按建议开始优化' : regenerate ? '生成新一批' : '开始优化'}</Button></div></footer>
        </form>
    </Panel></div>;
}
