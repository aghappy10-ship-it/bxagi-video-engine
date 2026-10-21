'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, Copy, Link2, Save } from 'lucide-react';
import { Button, Field, Modal } from '../../ui';
import { dateLabel, type Row } from '../../types';
import { FAILURE_STAGES, PRIORITY_LABELS, PROMOTION_LABELS, type PromotionLink, type PromotionMode, type ReleaseEdit, type ReleaseItem } from './types';

export function ItemEditor({ item, projects, busy, error, conflict, refreshing, onRefresh, onClose, onSave }: { item: ReleaseItem; projects: Row[]; busy: boolean; error: string; conflict: boolean; refreshing: boolean; onRefresh: () => void; onClose: () => void; onSave: (edit: ReleaseEdit) => Promise<void> }) {
    const [edit, setEdit] = useState<ReleaseEdit>(() => {
        const { id: _id, readiness: _readiness, verifiedAt: _verifiedAt, ...editable } = item;
        return editable;
    });
    const update = <K extends keyof ReleaseEdit>(key: K, value: ReleaseEdit[K]) => setEdit(old => ({ ...old, [key]: value }));
    async function submit(event: FormEvent) { event.preventDefault(); await onSave(edit); }
    return <Modal title="补齐剧目资料" description={item.title} onClose={onClose} closeDisabled={busy} className="bx-release-modal bx-release-editor">
        <form onSubmit={submit}>
            <fieldset disabled={busy}>
                <section className="bx-release-form-section"><h3><span>01</span>素材与生产目标</h3>
                    <div className="bx-form-grid">
                        <Field label="剧目名称" className="full" hint="修改剧名后，发布状态与推广授权须重新核验。"><input required maxLength={200} value={edit.title} onChange={event => update('title', event.target.value)}/></Field>
                        <Field label="关联原始素材包" className="full" hint="关联后会统计这个素材包的真实原始文件和完整成品。"><select value={edit.projectId} onChange={event => update('projectId', event.target.value)}><option value="">暂未关联</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></Field>
                        <Field label="素材目标（条）"><input type="number" min={1} max={30} step={1} required value={edit.targetCount || ''} onChange={event => update('targetCount', Number(event.target.value))}/></Field>
                        <Field label="准备优先级"><select value={edit.priority} onChange={event => update('priority', event.target.value as ReleaseEdit['priority'])}>{Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                    </div>
                </section>
                <section className="bx-release-form-section"><h3><span>02</span>发布与授权核验</h3><p>请结合常读剧目详情与线下剧单确认在架状态，列表发布时间不能代替核验。</p>
                    <div className="bx-form-grid"><Field label="发布状态"><select value={edit.releaseStatus} onChange={event => update('releaseStatus', event.target.value as ReleaseEdit['releaseStatus'])}><option value="unverified">待核验</option><option value="available">已核验 · 可投放</option><option value="unavailable">已核验 · 不可投放</option></select></Field><Field label="推广授权"><select value={edit.authorizationStatus} onChange={event => update('authorizationStatus', event.target.value as ReleaseEdit['authorizationStatus'])}><option value="unverified">待核验</option><option value="confirmed">已确认授权</option><option value="denied">未获得授权</option></select></Field></div>
                    {item.verifiedAt && <small className="bx-release-verified"><CheckCircle2 size={13}/>上次人工核验：{dateLabel(item.verifiedAt)}</small>}
                </section>
                <section className="bx-release-form-section"><h3><span>03</span>推广链接与预算</h3>
                    <div className="bx-form-grid"><Field label="推广模式"><select value={edit.promotionMode} onChange={event => update('promotionMode', event.target.value as PromotionMode)}>{Object.entries(PROMOTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><Field label="计划日预算（元）" hint="仅保存规划，不扣费、不启动投放。"><input type="number" min={0} max={1000000} step={0.01} required value={edit.dailyBudget} onChange={event => update('dailyBudget', Number(event.target.value))}/></Field></div>
                    <LinkFields label="付费推广链" required={edit.promotionMode !== 'free'} link={edit.paidLink} onChange={link => update('paidLink', link)} episodeLabel="付费起始集"/>
                    <LinkFields label="免费推广链" required={edit.promotionMode !== 'paid'} link={edit.freeLink} onChange={link => update('freeLink', link)} episodeLabel="广告起始集"/>
                </section>
                <section className="bx-release-form-section"><h3><span>04</span>异常与待处理事项</h3>
                    <Field label="异常阶段"><select value={edit.failureStage} onChange={event => update('failureStage', event.target.value)}>{Object.entries(FAILURE_STAGES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                    <Field label="异常说明" hint="问题解决后清空异常记录，系统才会重新判断资料是否齐备。"><textarea value={edit.failureReason} onChange={event => update('failureReason', event.target.value)} maxLength={1000} rows={3} placeholder="例如：待确认授权范围，或某条成品尚未完成交付。"/></Field>
                </section>
            </fieldset>
            {error && <div className="bx-release-error" role="alert"><span>{error}</span>{conflict && <Button type="button" secondary busy={refreshing} onClick={onRefresh}>刷新清单</Button>}</div>}
            <footer className="bx-modal-footer"><Button type="button" secondary onClick={onClose} disabled={busy}>取消</Button><Button type="submit" busy={busy} disabled={conflict}><Save size={16}/>保存资料</Button></footer>
        </form>
    </Modal>;
}

function LinkFields({ label, required, link, onChange, episodeLabel }: { label: string; required: boolean; link: PromotionLink; onChange: (link: PromotionLink) => void; episodeLabel: string }) {
    const [copyStatus, setCopyStatus] = useState('');
    async function copy() {
        try { await navigator.clipboard.writeText(link.url); setCopyStatus('已复制'); }
        catch { setCopyStatus('复制失败，请选中链接手动复制。'); }
    }
    return <div className={`bx-release-link-fields ${required ? '' : 'is-optional'}`}>
        <div className="bx-release-link-title"><strong><Link2 size={15}/>{label}</strong><span>{required ? '当前模式需要' : '选填 · 已有链接仍会保留'}</span></div>
        <div className="bx-form-grid"><Field label="推广链 ID"><input value={link.id} onChange={event => onChange({ ...link, id: event.target.value })} maxLength={80} placeholder="填写已有推广链 ID"/></Field><Field label={episodeLabel}><input type="number" min={1} max={10000} step={1} value={link.startEpisode ?? ''} onChange={event => onChange({ ...link, startEpisode: event.target.value ? Number(event.target.value) : null })} placeholder="例如 2"/></Field></div>
        <Field label="完整推广链接" hint="从常读已有推广链详情复制，保留完整参数；付费和免费链应分别填写。"><textarea value={link.url} onChange={event => { onChange({ ...link, url: event.target.value }); setCopyStatus(''); }} maxLength={8000} rows={2} spellCheck={false} placeholder="aweme://playlet?..."/></Field>
        {link.url && <div className="bx-release-copy"><Button type="button" secondary onClick={copy}><Copy size={13}/>复制链接</Button><small role="status">{copyStatus}</small></div>}
    </div>;
}
