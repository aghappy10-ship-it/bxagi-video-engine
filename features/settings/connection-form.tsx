'use client';
import { useRef, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import { platformRequest, post } from '../../components/platform/api';
import { Button, Field, Modal } from '../../components/platform/ui';
import type { PlatformState } from '../../components/platform/use-platform';
import type { Row } from '../../components/platform/types';
import { channelDefinition, CONNECTION_CHANNELS } from './channels';

function localDate(value: string | null | undefined) {
    if (!value || !Number.isFinite(Date.parse(value))) return '';
    const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function ConnectionForm({ state, connection, initialChannel = 'oceanengine', onClose }: { state: PlatformState; connection?: Row; initialChannel?: string; onClose: () => void }) {
    const [channel, setChannel] = useState(connection?.channel || initialChannel);
    const tokenRef = useRef<HTMLInputElement>(null), secretRef = useRef<HTMLInputElement>(null);
    const definition = channelDefinition(channel);
    async function save(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget), expiry = String(form.get('expiresAt') || ''), accessToken = String(form.get('accessToken') || ''), appSecret = String(form.get('appSecret') || '');
        const payload = { channel, accountId: form.get('accountId'), label: form.get('label'), appId: form.get('appId') || '', ...(accessToken ? { accessToken } : {}), ...(appSecret ? { appSecret } : {}), ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : !definition.expiryRequired ? { expiresAt: null } : {}) };
        if (tokenRef.current) tokenRef.current.value = '';
        if (secretRef.current) secretRef.current.value = '';
        const result = await state.run('save-connection', () => connection ? platformRequest(`/connections/${encodeURIComponent(connection.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) : post('/connections', payload), '账户配置已加密保存；读取权限可单独验证。');
        if (result) onClose();
    }
    return <Modal title={connection ? '管理渠道连接' : '添加渠道连接'} description="配置保存在当前账户的工作区内。已有密钥不会回显。" onClose={onClose}><form onSubmit={save} autoComplete="off"><div className="bx-form-grid">
        <Field label="接入服务 *"><select name="channel" value={channel} onChange={event => setChannel(event.target.value)} disabled={Boolean(connection)}>{Object.entries(CONNECTION_CHANNELS).map(([key, value]) => <option key={key} value={key}>{value.title} · {value.type}</option>)}</select></Field>
        <Field label="账户标签"><input name="label" defaultValue={connection?.label || ''} placeholder="例如：品牌主账户" maxLength={100}/></Field>
        <p className="bx-form-note full">{definition.description}</p>
        <Field label={`${definition.accountLabel} *`} className="full"><input name="accountId" required defaultValue={connection?.accountId || ''} maxLength={200} placeholder={definition.accountLabel}/></Field>
        <Field label={`${definition.tokenLabel}${connection ? '（留空保留）' : ' *'}`} className="full" hint={connection ? '只在更新凭据时填写，提交后清空输入。' : '提交后清空输入，服务端加密保存。'}><input name="accessToken" type="password" ref={tokenRef} required={!connection} autoComplete="new-password" maxLength={16000}/></Field>
        <Field label={`授权到期时间${definition.expiryRequired ? ' *' : '（可选）'}`} className="full"><input name="expiresAt" type="datetime-local" defaultValue={localDate(connection?.expiresAt)} required={definition.expiryRequired}/></Field>
        <Field label={channel === 'volcano' ? '应用 / 资源 ID（可选）' : '应用 ID（可选）'}><input name="appId" defaultValue={connection?.appId || ''} maxLength={200}/></Field>
        <Field label={channel === 'volcano' ? 'Secret Key（使用 AK/SK 时填写）' : `应用密钥${connection ? '（留空保留）' : '（可选）'}`}><input name="appSecret" type="password" ref={secretRef} autoComplete="new-password" maxLength={16000}/></Field>
    </div><footer className="bx-modal-footer"><Button type="button" secondary onClick={onClose}>取消</Button><Button type="submit" busy={state.busy === 'save-connection'}><LockKeyhole size={15}/>加密保存</Button></footer></form></Modal>;
}
