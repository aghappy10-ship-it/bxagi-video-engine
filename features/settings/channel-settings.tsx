'use client';
import { useState } from 'react';
import { CheckCircle2, KeyRound, LockKeyhole, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { platformRequest, post } from '../../components/platform/api';
import { Badge, Button, Empty, Modal, Panel } from '../../components/platform/ui';
import { dateLabel, type Row } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';
import { channelDefinition, CONNECTION_CHANNELS, connectionState } from './channels';
import { ConnectionForm } from './connection-form';

export function ChannelSettings({ state }: { state: PlatformState }) {
    const [editor, setEditor] = useState<{ connection?: Row; channel?: string } | null>(null);
    const [confirmation, setConfirmation] = useState<{ connection: Row; action: 'delete' | 'disable' } | null>(null);
    const [results, setResults] = useState<Record<string, { message: string; verified: boolean; connection?: Row }>>({});
    const capabilities = Array.isArray(state.data.capabilities.channels) ? state.data.capabilities.channels : [];
    async function test(connection: Row) {
        setResults(previous => { const next = { ...previous }; delete next[connection.id]; return next; });
        const result = await state.run(`test-${connection.id}`, () => post(`/connections/${encodeURIComponent(connection.id)}/test`, {}), '连接检查已返回。');
        if (result) setResults(previous => ({ ...previous, [connection.id]: result }));
    }
    async function confirmAction() {
        if (!confirmation) return;
        const { connection, action } = confirmation;
        const result = await state.run(`${action}-${connection.id}`, () => action === 'delete' ? platformRequest(`/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' }) : post(`/connections/${encodeURIComponent(connection.id)}/disable`, {}), action === 'delete' ? '连接已删除。' : '连接已停用。');
        if (result) setConfirmation(null);
    }
    return <>
        <Panel title="我的渠道账户" subtitle="按账户管理授权，凭据保存与读取验证分别展示。" action={<Button onClick={() => setEditor({})}><Plus size={16}/>添加连接</Button>}>
            {state.data.connections.length ? <div className="bx-settings-connections">{state.data.connections.map(connection => {
                const definition = channelDefinition(connection.channel), status = connectionState(connection), previousResult = results[connection.id];
                const result = previousResult?.connection?.updatedAt === connection.updatedAt && previousResult?.connection?.status === connection.status ? previousResult : undefined;
                const linked = state.data.campaigns.filter(campaign => campaign.connectionId === connection.id).length;
                return <article className="bx-settings-connection" key={connection.id}><div className="bx-settings-connection-main"><span className="bx-connection-icon"><KeyRound size={22}/></span><div><h3>{connection.label || definition.title}</h3><p>{definition.title} · {definition.type}</p><small>账户 {connection.accountId} · {linked} 条关联投放</small><small>授权到期：{connection.expiresAt ? dateLabel(connection.expiresAt) : '未设置'}</small></div><Badge tone={status.tone}>{status.label}</Badge></div>
                    {result && <p className={`bx-settings-result ${result.verified ? 'verified' : ''}`} role="status">{result.verified && <CheckCircle2 size={14}/>} {result.message}</p>}
                    <div className="bx-settings-connection-actions"><Button secondary onClick={() => setEditor({ connection })}><Pencil size={14}/>编辑 / 更新密钥</Button><Button secondary disabled={connection.status === 'disabled' || Boolean(state.busy)} busy={state.busy === `test-${connection.id}`} onClick={() => test(connection)}><RefreshCw size={14}/>验证读取</Button>
                        {connection.status === 'disabled' ? <Button secondary disabled={Boolean(state.busy)} onClick={() => state.run(`enable-${connection.id}`, () => platformRequest(`/connections/${encodeURIComponent(connection.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'configured' }) }), '连接已启用，请验证读取权限。')}><Power size={14}/>启用</Button> : <Button secondary onClick={() => setConfirmation({ connection, action: 'disable' })}><Power size={14}/>停用</Button>}
                        <Button secondary danger onClick={() => setConfirmation({ connection, action: 'delete' })}><Trash2 size={14}/>删除</Button>
                    </div></article>;
            })}</div> : <Empty icon={<KeyRound size={27}/>} title="添加你的第一个渠道账户" description="保存自己的渠道授权，后续在投放中心选择账户并配置预算。" action={<Button onClick={() => setEditor({})}><Plus size={16}/>添加连接</Button>}/>}
            <p className="bx-form-note"><LockKeyhole size={14}/>密钥由服务端加密，已有密钥不会回显。更新时留空可保留原凭据。</p>
        </Panel>
        <Panel title="接入服务与能力" subtitle="已保存配置不代表已获得投放权限，实际执行以账户验证和启动检查为准。"><div className="bx-channel-grid">{Object.entries(CONNECTION_CHANNELS).map(([key, definition]) => {
            const capability = capabilities.find((value: any) => typeof value === 'object' && (value.id || value.channel) === key);
            const implemented = capability?.adapter === 'implemented' || capability?.adapter === 'requires_account_permissions' || capability?.adapterReady === true;
            return <article key={key}><span className="bx-channel-monogram">{definition.title.slice(0, 1)}</span><h3>{definition.title}</h3><small>{definition.type}</small><div className="bx-inline-tags"><Badge tone={implemented ? 'blue' : 'amber'}>{implemented ? '执行适配器可用' : '适配器待接入'}</Badge></div><p>{definition.description}</p><div className="bx-settings-capabilities"><span>配置管理 <strong>可用</strong></span><span>读取验证 <strong>{key === 'oceanengine' ? '可验证' : '待接入'}</strong></span><span>投放 / 报表 / 调整 <strong>{implemented ? '启动时核验' : '待接入'}</strong></span></div><Button secondary onClick={() => setEditor({ channel: key })}><Plus size={14}/>添加配置</Button></article>;
        })}</div></Panel>
        {editor && <ConnectionForm state={state} connection={editor.connection} initialChannel={editor.channel} onClose={() => setEditor(null)}/>}
        {confirmation && <Modal title={confirmation.action === 'delete' ? '删除渠道连接' : '停用渠道连接'} description={confirmation.connection.label || channelDefinition(confirmation.connection.channel).title} onClose={() => setConfirmation(null)}><p>{confirmation.action === 'delete' ? '删除会移除该连接及保存的凭据。有投放记录关联的连接将保留，可改为停用。' : '停用后不能启动新投放或同步该连接。请先暂停关联投放，并完成未确认操作的核对。'}</p><footer className="bx-modal-footer"><Button secondary onClick={() => setConfirmation(null)}>取消</Button><Button danger busy={state.busy === `${confirmation.action}-${confirmation.connection.id}`} onClick={confirmAction}>{confirmation.action === 'delete' ? '确认删除' : '确认停用'}</Button></footer></Modal>}
    </>;
}
