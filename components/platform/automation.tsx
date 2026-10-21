'use client';
import { CheckCircle2, Download, Workflow } from 'lucide-react';
import { Badge, Button, Panel } from './ui';
import { activeAutomaticFlows, automaticFlowStage, automaticFlowLabel, automaticFlowReason, automaticFlowNeedsUser, archivedFlowFiles, creativeDeliveryState, backgroundSchedulerState } from './automation.mjs';
import { contentUrl, downloadContent } from './api';
import { dateLabel, type Row } from './types';
import { remoteErrorMessage } from './remote-jobs.mjs';
import type { PlatformState } from './use-platform';
export function AutomationFlowCards({ state, projectId, campaignId, onBudget }: {
    state: PlatformState;
    projectId?: string;
    campaignId?: string;
    onBudget?: () => void;
}) {
    const projectFilter = projectId || state.data.campaigns.find(c => c.id === campaignId)?.projectId;
    const flows = activeAutomaticFlows(state.data).filter((flow: Row) => !projectFilter || flow.projectId === projectFilter);
    if (!flows.length)
        return null;
    return <div className="bx-automation-list">{flows.map((flow: Row) => {
            const production = state.data.jobs.find(job => job.id === flow.productionJobId), buying = state.data.jobs.find(job => job.id === flow.buyingJobId);
            const stage = automaticFlowStage(flow), job = (stage === 'buying' || stage === 'feedback') && buying ? buying : production;
            const project = state.data.projects.find(p => p.id === flow.projectId);
            const employee = state.data.employees.find(e => e.id === job?.employeeId || e.id === job?.details?.employeeId) || job?.details?.employee;
            const selection = job?.details?.selection || job?.details?.routing || job?.details?.employeeSelection;
            const reason = remoteErrorMessage(selection?.reason) || (stage === 'production' && Array.isArray(project?.assignment?.basis) ? project.assignment.basis.join('；') : '');
            const files = archivedFlowFiles(flow, state.data) as Row[];
            const partial = files.some(file => creativeDeliveryState(file, state.data).status === 'partial');
            const scheduler = backgroundSchedulerState(state.data.capabilities);
            const needsUser = automaticFlowNeedsUser(flow);
            return <article className="bx-remote-job" key={flow.id}><span className="bx-task-icon"><Workflow size={20}/></span><div style={{minWidth:0}}><h3>智能调度 · {state.data.projects.find(p => p.id === flow.projectId)?.title || '素材与投放流程'}</h3><p>{automaticFlowReason(flow)}</p><div className="bx-inline-tags"><Badge tone={needsUser ? 'amber' : 'blue'}>{automaticFlowLabel(flow)}</Badge>{job && <Badge>{employee?.name || job.employeeId || '员工任务处理中'}</Badge>}{files.length > 0 && <Badge tone={partial ? 'blue' : 'green'}><CheckCircle2 size={12}/>{files.length} 份文件已归档{partial ? ' · 部分交付' : ''}</Badge>}</div>{files.length > 0 && <div className="bx-inline-actions" style={{marginTop:12,flexWrap:'wrap'}}>{files.map(file => <div key={file.id} style={{maxWidth:260}}>{file.mimeType === 'video/mp4' && <video src={contentUrl('creatives',file.id)} controls preload="metadata" style={{width:'100%',maxHeight:220,borderRadius:8}}/>}{file.mimeType?.startsWith('image/') && <img src={contentUrl('creatives',file.id)} alt={file.title || file.filename} style={{maxWidth:'100%',maxHeight:160,borderRadius:8}}/>}<Button secondary busy={state.busy === `download-${file.id}`} onClick={() => state.run(`download-${file.id}`, () => downloadContent('creatives',file.id,file.filename || file.id))}><Download size={14}/>{file.filename || '下载文件'}</Button><small>{creativeDeliveryState(file,state.data).label}</small></div>)}</div>}{partial && <small>已归档文件可预览和下载；完整交付并审核后才能投放。</small>}{reason && <small>调度依据：{reason}</small>}<small>{flow.lastTickAt ? `最近自动检查：${dateLabel(flow.lastTickAt)}` : '流程已保存，等待首次自动检查'}{!needsUser && flow.nextActionAt ? ` · 下一次检查：${dateLabel(flow.nextActionAt)}` : ''}</small><small>{scheduler.label}{scheduler.lastSuccessfulTickAt ? ` · 最近后台运行：${dateLabel(scheduler.lastSuccessfulTickAt)}` : ''}{!scheduler.running ? '；当前由本窗口继续检查，关闭后任务保留。' : ''}</small></div>{flow.waiting?.code === 'awaiting_budget' && onBudget && <Button onClick={onBudget}>设置投放预算</Button>}{flow.waiting?.code === 'login_required' && <Button onClick={state.openBxagiLogin}>重新登录 BXAGI</Button>}</article>;
        })}</div>;
}
