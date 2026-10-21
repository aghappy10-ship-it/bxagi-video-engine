'use client';

import { useEffect, useRef, useState } from 'react';
import { Database, RefreshCw, ShieldCheck } from 'lucide-react';
import { platformRequest } from '../../components/platform/api';
import { Badge, Button, Field, Panel } from '../../components/platform/ui';
import { dateLabel } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';
import { CATALOG_CONNECTION_LABELS, catalogErrorMessage } from './helpers.mjs';
import type { CatalogSourceInput, CatalogStatus } from './types';
import { useCatalogStatus } from './use-catalog';
import { CatalogAccessGuide } from './access-guide';
import './catalog.css';

export function ContentSourceSettings({ state, onSaved }: { state: PlatformState; onSaved?: (status: CatalogStatus) => void }) {
    return <SourceSettings key={state.data.user.id} ownerId={state.data.user.id} onSaved={onSaved}/>;
}

function SourceSettings({ ownerId, onSaved }: { ownerId: string; onSaved?: (status: CatalogStatus) => void }) {
    const connection = useCatalogStatus(ownerId);
    if (connection.loading) return <Panel><p role="status">正在读取内容源配置…</p></Panel>;
    if (!connection.status) return <Panel title="暂时无法读取内容源"><p role="alert">{connection.error}</p><Button secondary onClick={connection.refresh}><RefreshCw size={15}/>重新读取</Button></Panel>;
    return <SourceForm status={connection.status} onSaved={next => { connection.accept(next); onSaved?.(next); }}/>;
}

function SourceForm({ status, onSaved }: { status: CatalogStatus; onSaved: (status: CatalogStatus) => void }) {
    const [label, setLabel] = useState(status.source.label || '常读');
    const [distributorId, setDistributorId] = useState(status.source.distributorId || '');
    const [secretKey, setSecretKey] = useState('');
    const [autoSync, setAutoSync] = useState(status.source.autoSync);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [saved, setSaved] = useState(false);
    const pending = useRef(false);
    const life = useRef<AbortController | null>(null);
    const source = status.source;
    const needsSecret = !source.configured || distributorId.trim() !== source.distributorId;
    useEffect(() => { const controller = new AbortController(); life.current = controller; return () => controller.abort(); }, []);

    async function save(event: React.FormEvent) {
        event.preventDefault();
        const controller = life.current;
        if (pending.current || !controller || controller.signal.aborted) return;
        if (!/^\d{1,40}$/.test(distributorId.trim())) { setError('分销商标识应为 1–40 位数字。'); return; }
        if ((needsSecret && !secretKey) || secretKey.length > 2048) { setError('请填写有效的签名密钥，最长 2048 个字符。'); return; }
        pending.current = true; setBusy(true); setError(''); setSaved(false);
        const input: CatalogSourceInput = { label: label.trim() || '常读', distributorId: distributorId.trim(), autoSync };
        if (secretKey) input.secretKey = secretKey;
        try {
            const next = await platformRequest<CatalogStatus>('/catalog/source', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
            if (!controller.signal.aborted) { setSecretKey(''); setSaved(true); onSaved(next); }
        } catch (err) { if (!controller.signal.aborted) setError(catalogErrorMessage(err, '配置未保存，请检查分销商标识和密钥后重试。')); }
        finally { pending.current = false; if (!controller.signal.aborted) setBusy(false); }
    }

    return <Panel className="bx-catalog-source" title={<><Database size={18}/> 常读内容源</>} subtitle="连接后按页读取剧目资料，自动去重并保存到当前账号。">
        <div className="bx-catalog-source-state"><Badge tone={source.connectionStatus === 'verified' ? 'green' : 'amber'}>{CATALOG_CONNECTION_LABELS[source.connectionStatus]}</Badge><span>最近成功读取：{dateLabel(source.lastSuccessAt)}</span></div>
        {!status.integration.configured && <div className="bx-catalog-notice is-warning"><strong>常读取数接口待接通</strong><p>平台管理员完成官方剧目接口适配后，即可验证账号并抓取。保存密钥不代表连接已验证。</p></div>}
        {status.integration.configured && <div className="bx-catalog-notice"><strong>剧目读取协议已就绪</strong><p>保存凭据后到“自动抓剧”开始读取；首次成功响应后才显示“读取已验证”。</p></div>}
        <CatalogAccessGuide/>
        <form onSubmit={save} className="bx-catalog-source-form">
            <div className="bx-form-grid">
                <Field label="内容源名称"><input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} disabled={busy}/></Field>
                <Field label="分销商标识" hint="填写常读商务提供的 distributor_id，不是登录邮箱。"><input required value={distributorId} onChange={event => setDistributorId(event.target.value)} maxLength={40} inputMode="numeric" pattern="[0-9]{1,40}" autoComplete="off" spellCheck={false} disabled={busy}/></Field>
                <Field label="签名密钥" className="full" hint={needsSecret ? '由常读商务提供 secret_key；仅提交到服务端保存。' : '已有密钥已安全保存。留空保留，填写则更新。'}><input type="password" required={needsSecret} value={secretKey} onChange={event => setSecretKey(event.target.value)} autoComplete="new-password" placeholder={needsSecret ? '请输入 secret_key' : '留空保留现有密钥'} maxLength={2048} disabled={busy}/></Field>
            </div>
            <label className="bx-catalog-check"><input type="checkbox" checked={autoSync} onChange={event => setAutoSync(event.target.checked)} disabled={busy}/><span><strong>自动同步新剧资料</strong><small>{status.scheduler.running ? '后台调度已连接，按服务端频率检查新增与更新。' : '后台调度尚未连接；当前仅在自动抓剧页面保持打开时跟进已启动任务。'}</small></span></label>
            <p className="bx-catalog-meta"><ShieldCheck size={14}/>密钥不回显。不同 BXAGI 账号的内容源与剧目资料独立保存。</p>
            {error && <p className="bx-catalog-notice is-error" role="alert">{error}</p>}
            {saved && <p className="bx-catalog-notice" role="status">配置已保存；首次读取成功后显示“读取已验证”。</p>}
            <div className="bx-catalog-actions"><Button type="submit" busy={busy}>保存内容源</Button></div>
        </form>
    </Panel>;
}
