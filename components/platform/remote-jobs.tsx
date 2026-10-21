'use client';
import { useEffect, useRef } from 'react';
import { ArrowUpRight, Clock3, RefreshCw } from 'lucide-react';
import { Badge, Button, Status } from './ui';
import { post } from './api';
import { remoteJobs, pendingRemoteJob, pollableRemoteJob, safeBxagiUrl, remoteJobDescription } from './remote-jobs.mjs';
import type { PlatformState } from './use-platform';
import { automaticAdvanceDelay, backgroundSchedulerState } from './automation.mjs';
import type { Row } from './types';
/** One owner-scoped tick drives the durable workflow; individual jobs are not replayed here. */
export function useRemoteJobSync(state: PlatformState) {
    const stateRef = useRef(state), lastTick = useRef(0), syncing = useRef(false);
    stateRef.current = state;
    useEffect(() => {
        const advance = async (immediate = false) => {
            const current = stateRef.current;
            if (syncing.current || current.loading || current.requiresLogin || !current.data.bxagi.connected || current.busy || document.visibilityState === 'hidden')
                return;
            const delay = automaticAdvanceDelay(current.data);
            if (!immediate && Date.now() - lastTick.current < delay)
                return;
            lastTick.current = Date.now();
            syncing.current = true;
            try {
                if (backgroundSchedulerState(current.data.capabilities).running)
                    await current.refresh();
                else
                    await current.advanceAutomation();
            } catch { /* Preserve the last confirmed state until the next check. */ }
            finally { syncing.current = false; }
        };
        const visible = () => { if (document.visibilityState === 'visible')
            void advance(true); };
        const online = () => { void advance(true); };
        const timer = setInterval(() => { void advance(); }, 5000);
        document.addEventListener('visibilitychange', visible);
        window.addEventListener('online', online);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', online); };
    }, []);
    useEffect(() => { if (!state.loading && !state.requiresLogin && state.data.bxagi.connected && !state.busy) {
        lastTick.current = Date.now();
        if (backgroundSchedulerState(state.data.capabilities).running)
            void state.refresh().catch(() => {});
        else
            void state.advanceAutomation();
    } }, [state.loading, state.requiresLogin, state.data.bxagi.connected, state.busy]);
}
export function RemoteJobCards({ state, projectId, campaignId }: {
    state: PlatformState;
    projectId?: string;
    campaignId?: string;
}) {
    const jobs = remoteJobs(state.data).filter((job: Row) => (!projectId || job.projectId === projectId || job.details?.projectId === projectId) && (!campaignId || job.campaignId === campaignId || job.details?.campaignId === campaignId));
    if (!jobs.length)
        return null;
    const canCollect = (job: Row) => job.details?.kind === 'production' && job.details?.messageAcknowledged === true && !!job.details?.messageSentAt && !job.details?.remoteWritePending && job.status !== 'needs_reconciliation';
    const checkJob = (job: Row) => canCollect(job) ? state.run(`bxagi-sync-${job.id}`, () => post(`/bxagi/jobs/${encodeURIComponent(job.id)}/collect`, {})) : state.advanceAutomation();
    return <div className="bx-remote-jobs">{jobs.slice(0, 12).map((job: Row) => { const inputNeeded = job.status === 'awaiting_user_input'; const unresolved = job.status === 'needs_reconciliation'; const href = safeBxagiUrl(job.remoteUrl || job.details?.remoteUrl || job.details?.workspaceUrl); return <article className="bx-remote-job" key={job.id}><span className="bx-task-icon"><Clock3 size={19}/></span><div><h3>{job.title || job.details?.title || job.name || 'BXAGI 员工任务'}</h3><p>{remoteJobDescription(job)}</p>{(job.employeeName || job.details?.employeeName) && <small>执行员工：{job.employeeName || job.details?.employeeName}</small>}{job.remoteId && <small>远端任务：{job.remoteId}</small>}</div><Status status={job.status}/><div className="bx-inline-actions"><details className="bx-advanced"><summary>任务详情</summary><Button secondary disabled={!!state.busy || !state.data.bxagi?.connected} busy={state.busy === `bxagi-sync-${job.id}`} onClick={() => checkJob(job)}><RefreshCw size={14}/>{canCollect(job) ? '检查并回收成品' : '重新检查工作流'}</Button></details>{href && <a className="bx-text-button" href={href} target="_blank" rel="noreferrer">打开远端任务<ArrowUpRight size={14}/></a>}</div></article>; })}</div>;
}
