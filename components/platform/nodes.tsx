'use client';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { ApiError, platformRequest } from './api';
import { Badge, Button, Panel } from './ui';
import { dateLabel, type BxagiNodeState } from './types';
import { nodeConnectionLabel, nodeObservationLabel, nodeHistoryLabel } from './nodes.mjs';
import type { PlatformState } from './use-platform';

export function NodeHealthPanel({ state }: { state: PlatformState }) {
    const owner = state.data.bxagi.connected ? state.data.user.id : '';
    const [result, setResult] = useState<{ owner: string; value: BxagiNodeState } | null>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const revision = useRef(0), identity = useRef(owner);
    identity.current = owner;
    useEffect(() => { revision.current++; setResult(null); setBusy(false); setError(''); }, [owner]);
    const current = result?.owner === owner ? result.value : null;
    async function check() {
        if (!owner || busy) return;
        const requestRevision = ++revision.current, requestOwner = owner;
        const isCurrent = () => requestRevision === revision.current && identity.current === requestOwner;
        setBusy(true); setError('');
        try {
            const value = await platformRequest<BxagiNodeState>('/bxagi/nodes/state');
            if (isCurrent()) setResult({ owner: requestOwner, value });
        } catch (reason) {
            if (!isCurrent()) return;
            setResult(null);
            if (reason instanceof ApiError && reason.status === 401) {
                setError('BXAGI 登录已失效，请重新登录。');
                await state.refresh().catch(() => {});
            } else setError(reason instanceof Error ? reason.message : '节点状态暂未读取，请稍后检查。');
        } finally { if (isCurrent()) setBusy(false); }
    }
    const verified = current?.observationStatus === 'verified' && current.liveVerified === true;
    return <Panel title="执行节点与连接" subtitle="查看当前账号节点的心跳、网关与闲置回收设置" action={<Button secondary busy={busy} disabled={!owner || busy} onClick={check}><RefreshCw size={15}/>检查节点</Button>}>
        <div className="bx-inline-tags"><Badge tone={verified ? 'blue' : 'neutral'}>{owner ? nodeObservationLabel(current) : '登录后检查'}</Badge>{current && <Badge>{current.nodeCount} 个节点</Badge>}</div>
        {current && !verified && <p className="bx-form-note">本次未取得实时节点状态，下面如有记录仅代表上次检查，不据此判断当前在线或离线。</p>}
        {current?.nodes.map(node => <div className="bx-media-job" key={node.nodeId}>
            <div style={{ minWidth: 0 }}><strong style={{ overflowWrap: 'anywhere' }}>{node.nodeId}</strong><div className="bx-inline-tags"><Badge tone={verified && !node.stale && node.status === 'online' && node.gatewayConnected !== false ? 'green' : 'amber'}>{verified ? nodeConnectionLabel(node) : '历史记录 · 待核实'}</Badge><Badge>{node.gatewayConnected === true ? '网关已连接' : node.gatewayConnected === false ? '网关未连接' : '网关状态未提供'}</Badge>{node.cloudGateway === true && <Badge>云端网关特征</Badge>}</div>
                <p>最后心跳：{dateLabel(node.lastHeartbeatAt)}{Number.isFinite(node.heartbeatAgeSeconds) ? ` · 距检查时 ${Math.round(node.heartbeatAgeSeconds!)} 秒` : ''}</p>
                <small>闲置回收周期：{Number.isFinite(node.idleTimeoutMinutes) ? `${node.idleTimeoutMinutes} 分钟` : '上游未提供'}</small>
            </div>
        </div>)}
        {current && <small style={{ display: 'block', marginTop: 12 }}>本次检查：{dateLabel(current.checkedAt)} · 最近成功读取：{dateLabel(current.lastSuccessfulAt)}</small>}
        {!!current?.history?.length && <details className="bx-advanced"><summary>最近连接变化</summary>{current.history.slice(-5).reverse().map((entry, index) => <p key={`${entry.at}-${index}`}><small>{dateLabel(entry.at)}{entry.nodeId ? ` · ${entry.nodeId}` : ''}</small><br/>{nodeHistoryLabel(entry)}</p>)}</details>}
        <p className="bx-form-note">节点连接与员工启用状态分别核实。暂时离线时保留原任务，恢复后继续检查；当前页面只读取状态。</p>
        {error && <div className="bx-message error" role="alert">{error}</div>}
    </Panel>;
}
