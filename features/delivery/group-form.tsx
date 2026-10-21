'use client';
import { useRef, useState } from 'react';
import { Check, Layers3 } from 'lucide-react';
import { post } from '../../components/platform/api';
import { Badge, Button, Field, Modal } from '../../components/platform/ui';
import { CHANNELS, OBJECTIVES, money, type Row } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';
import { readyPrimaryCreatives, type DeliveryGroup } from './model';
import styles from './delivery.module.css';

type ChannelConfig = {
    project?: Record<string, unknown>; promotion?: Record<string, unknown>;
    report?: Record<string, unknown>; metricMapping?: Record<string, string>; [key: string]: unknown;
};

export function DeliveryGroupForm({ state, onClose, preset, onCreated, group }: {
    state: PlatformState; onClose: () => void; preset?: Row; onCreated?: (campaignId: string) => void; group?: DeliveryGroup;
}) {
    const initialProjectId = group?.projectId || preset?.projectId || state.data.projects[0]?.id || '';
    const existingIds = new Set(group?.campaigns.flatMap(row => row.creativeIds || []) || []);
    const availableDaily = group ? Math.max(0, Math.round((Number(group.dailyBudget) - group.campaigns.reduce((sum, row) => sum + Number(row.dailyBudget || 0), 0)) * 100) / 100) : 300;
    const availableTotal = group ? Math.max(0, Math.round((Number(group.totalBudget) - group.campaigns.reduce((sum, row) => sum + Number(row.totalBudget || 0), 0)) * 100) / 100) : 1500;
    const [projectId, setProjectId] = useState(initialProjectId);
    const [selected, setSelected] = useState<string[]>(() => readyPrimaryCreatives(initialProjectId, state.data).filter(row => !existingIds.has(row.id)).map(row => row.id));
    const [channel, setChannel] = useState(group?.channel || 'oceanengine');
    const [dailyBudget, setDailyBudget] = useState(String(Math.min(300, availableDaily)));
    const [totalBudget, setTotalBudget] = useState(String(Math.min(1500, availableTotal)));
    const [landingType, setLandingType] = useState('LINK');
    const [partial, setPartial] = useState(false);
    const payloadRef = useRef<Record<string, unknown> | null>(null);
    const [requestId] = useState(() => crypto.randomUUID());
    const creatives = readyPrimaryCreatives(projectId, state.data);
    const project = state.data.projects.find(row => row.id === projectId);
    const connections = state.data.connections.filter(row => row.channel === channel && !['disabled', 'deleted'].includes(row.status));
    const covers = state.data.creatives.filter(row => row.projectId === projectId && row.mimeType === 'image/png' && row.status !== 'rejected' && Number(row.size) > 0);
    const hasVideo = creatives.some(row => selected.includes(row.id) && row.mimeType?.startsWith('video/'));
    const validSelected = selected.filter(id => creatives.some(row => row.id === id));
    const dailyCents = Math.round(Number(dailyBudget) * 100);
    const eachBudget = validSelected.length && Number.isFinite(dailyCents) ? Math.floor(dailyCents / validSelected.length) / 100 : null;

    async function save(payload: Record<string, unknown>) {
        const result = await state.run('create-delivery-group', () => post(group ? `/delivery-groups/${encodeURIComponent(group.id)}/units` : '/delivery-groups', payload));
        if (!result) return;
        if (result.partial) {
            setPartial(true); state.setNotice('部分投放草稿已创建。可按相同配置补齐剩余草稿，当前不会开始投放。'); return;
        }
        state.setNotice(`已${group ? '添加' : '创建'} ${(payload.creativeIds as string[])?.length || 0} 条独立投放草稿，共享素材包预算。点击开始投放后由 BXAGI 员工执行。`);
        onCreated?.(result.campaigns?.[0]?.id || result.group?.id || '');
        onClose();
    }

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        let advanced: ChannelConfig = {};
        try {
            const raw = String(form.get('platformConfig') || '').trim();
            if (raw) advanced = JSON.parse(raw);
            if (!advanced || Array.isArray(advanced) || typeof advanced !== 'object') throw new Error();
        } catch { state.setError('高级配置必须是有效的 JSON 对象。'); return; }
        const daily = Number(dailyBudget), total = Number(totalBudget);
        if (!validSelected.length || !Number.isFinite(daily) || !Number.isFinite(total) || total < daily || dailyCents < validSelected.length) {
            state.setError('请选择成品，并确保总预算不低于日预算、每条成品至少分配 0.01 元。'); return;
        }
        const titles = String(form.get('titles') || '').split('\n').map(value => value.trim()).filter(Boolean);
        if (channel === 'oceanengine' && (titles.length > 10 || titles.some(title => title.length > 100))) { state.setError('最多设置 10 条广告标题，每条最多 100 个字符。'); return; }
        const mapping: Record<string, string> = { projectId: String(form.get('projectDimension') || 'project_id'), spend: String(form.get('spendField') || 'stat_cost') };
        for (const key of ['revenue', 'conversions', 'impressions', 'clicks']) {
            const field = String(form.get(`${key}Field`) || '').trim();
            if (field) mapping[key] = field;
        }
        const config = channel === 'oceanengine' ? {
            budgetUnit: 'yuan',
            ...advanced,
            landingUrl: String(form.get('landingUrl') || '').trim() || project?.landingUrl || undefined,
            titles,
            coverCreativeId: String(form.get('coverCreativeId') || '') || undefined,
            project: {
                ad_type: 'ALL', landing_type: landingType, marketing_goal: 'VIDEO_AND_IMAGE',
                delivery_range: { inventory_catalog: 'UNIVERSAL_SMART' },
                delivery_setting: { bid_type: 'NO_BID', budget_mode: 'BUDGET_MODE_DAY' },
                ...advanced.project,
            },
            promotion: { ...advanced.promotion },
            report: {
                dimensions: [mapping.projectId], metrics: [...new Set(Object.entries(mapping).filter(([key]) => key !== 'projectId').map(([, field]) => field))],
                filters: [], order_by: [], data_topic: String(form.get('reportTopic') || '').trim(), ...advanced.report,
            },
            metricMapping: { ...mapping, ...advanced.metricMapping },
        } : advanced;
        const payload = partial && payloadRef.current ? payloadRef.current : {
            projectId, name: form.get('name'), channel, connectionId: form.get('connectionId'),
            creativeIds: validSelected, dailyBudget: daily, totalBudget: total,
            objective: form.get('objective') || project?.objective || 'views', targetRoi: Number(form.get('targetRoi')),
            autoOptimize: form.get('autoOptimize') === 'on', platformConfig: config,
            ...(group ? { requestId, versionRound: Number(form.get('versionRound')) || 1 } : {}),
        };
        payloadRef.current = payload;
        await save(payload);
    }

    return <Modal title={group ? '添加新成品投放' : '创建素材包投放'} description={group ? '为新交付成品添加独立投放草稿，保留已运行的素材版本。' : '每条成品生成独立投放单元，共享你设置的包级预算。'} onClose={onClose} closeDisabled={state.busy === 'create-delivery-group'}>
        <form onSubmit={submit}>
            <fieldset disabled={partial || state.busy === 'create-delivery-group'} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            {group && <p className={styles.callout}>本包剩余可分配日预算 {money(availableDaily)}，总预算 {money(availableTotal)}。如额度不足，请先调整包额度或其他单元的分配。</p>}
            <div className={styles.sectionTitle}><span className={styles.number}>1</span>素材包与成品</div>
            <div className="bx-form-grid">
                <Field label="素材包 *"><select value={projectId} disabled={partial || !!group} onChange={event => {
                    const id = event.target.value; setProjectId(id); setSelected(readyPrimaryCreatives(id, state.data).map(row => row.id));
                }}>{state.data.projects.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>
                {group ? <Field label="投放轮次" hint="同一成品可显式新增轮次，已有投放保留原版本。"><input name="versionRound" type="number" min="1" step="1" defaultValue={Math.max(0, ...group.campaigns.map(row => Number(row.remoteState?.deliveryUnit?.round) || 1)) + 1}/></Field> : <Field label="投放名称 *"><input name="name" required key={projectId} defaultValue={`${project?.title || '素材包'} · 首轮投放`} maxLength={120}/></Field>}
            </div>
            <div className={styles.options}>{creatives.length ? creatives.map(row => <label className={styles.creativeOption} key={row.id}>
                <input type="checkbox" checked={validSelected.includes(row.id)} disabled={partial} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.id] : previous.filter(id => id !== row.id))}/>
                <span><strong>{row.title || row.filename}</strong><small>{row.mimeType?.startsWith('video/') ? '视频成品' : '图片成品'} · {existingIds.has(row.id) ? '已有关联投放，可选择新增轮次' : row.metadata?.productionVersion?.batchId ? '员工生产版本' : '已归档成品'}</small></span>
                <Badge tone="green"><Check size={11}/> 可投放</Badge>
            </label>) : <p className={styles.callout}>这个素材包还没有可投放成品。请先到任务中心完成优化，再从素材中心进入投放。</p>}</div>
            <div className={styles.sectionTitle}><span className={styles.number}>2</span>渠道与共享预算</div>
            <div className="bx-form-grid">
                <Field label="投放渠道 *"><select value={channel} onChange={event => setChannel(event.target.value)} disabled={partial}>{Object.entries(CHANNELS).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></Field>
                <Field label="渠道账户 *"><select name="connectionId" key={channel} required defaultValue=""><option value="">选择已保存的广告账户</option>{connections.map(row => <option key={row.id} value={row.id}>{row.label || CHANNELS[row.channel]} · {row.accountId}</option>)}</select></Field>
                {!connections.length && <p className="bx-inline-warning full">请先在 M7 系统管理中添加这个渠道的账户配置。</p>}
                <Field label={group ? '本次新增成品日预算合计（元） *' : '素材包每日预算（元） *'}><input type="number" min="0.01" max={group ? availableDaily : undefined} step="0.01" required value={dailyBudget} onChange={event => setDailyBudget(event.target.value)}/></Field>
                <Field label={group ? '本次新增成品总预算合计（元） *' : '素材包总预算（元） *'}><input type="number" min="0.01" max={group ? availableTotal : undefined} step="0.01" required value={totalBudget} onChange={event => setTotalBudget(event.target.value)}/></Field>
                <Field label="投放目标"><select name="objective" defaultValue={project?.objective || 'views'}>{Object.entries(OBJECTIVES).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></Field>
                <Field label="目标投产比" hint="归因收入 ÷ 广告消耗。"><input name="targetRoi" type="number" min="0.01" step="0.01" defaultValue="1.5" required/></Field>
            </div>
            <div className={styles.selection}><div><strong><Layers3 size={14}/> 已选择 {validSelected.length} 条成品</strong><p>初始均分日预算，每条约 {eachBudget == null ? '—' : money(eachBudget)}；分配合计不超过 {money(dailyBudget)}。</p></div><Badge tone="blue">创建后为待投放</Badge></div>
            {channel === 'oceanengine' ? <>
                <div className={styles.sectionTitle}><span className={styles.number}>3</span>推广内容</div>
                <div className="bx-form-grid">
                    <Field label="推广对象"><select value={landingType} onChange={event => setLandingType(event.target.value)}><option value="LINK">网站 / 落地页</option><option value="APP">应用</option><option value="DPA">商品目录</option><option value="MICRO_GAME">小游戏</option><option value="SHOP">店铺</option><option value="NATIVE_ACTION">原生内容</option><option value="QUICK_APP">快应用</option></select></Field>
                    <Field label={landingType === 'LINK' ? '落地页 HTTPS 地址' : '落地页地址（选填）'}><input name="landingUrl" type="url" key={`${projectId}-landing`} defaultValue={project?.landingUrl || ''} placeholder="https://"/></Field>
                    <Field label="广告标题（每行一条，最多 10 条）" className="full"><textarea name="titles" key={`${projectId}-titles`} rows={3} defaultValue={project?.productName || project?.title || ''} maxLength={1010}/></Field>
                    {hasVideo && <Field label="视频封面" className="full" hint="投放前需指定已归档的 PNG 封面。"><select name="coverCreativeId" defaultValue=""><option value="">请选择封面</option>{covers.map(row => <option key={row.id} value={row.id}>{row.title || row.filename}</option>)}</select></Field>}
                </div>
                <details className="bx-advanced"><summary>效果回传配置</summary><p>按该广告账户实际支持的报表主题填写。可先保存草稿，开始投放时会核验配置。</p><div className="bx-form-grid">
                    <Field label="报表主题"><input name="reportTopic" placeholder="账户支持的 data_topic"/></Field>
                    <Field label="项目维度"><input name="projectDimension" defaultValue="project_id"/></Field>
                    <Field label="消耗字段"><input name="spendField" defaultValue="stat_cost"/></Field>
                    <Field label="归因收入字段"><input name="revenueField" placeholder="账户支持的收入指标"/></Field>
                    <Field label="转化次数字段"><input name="conversionsField" placeholder="账户支持的转化指标"/></Field>
                    <Field label="曝光字段"><input name="impressionsField" placeholder="账户支持的曝光指标"/></Field>
                    <Field label="点击字段"><input name="clicksField" placeholder="账户支持的点击指标"/></Field>
                </div></details>
            </> : <p className={styles.callout}>该渠道可保存投放草稿；是否能够执行取决于 M7 中显示的渠道接入能力。</p>}
            <details className="bx-advanced"><summary>高级渠道配置（选填）</summary><p>应用、商品等推广可补充渠道要求的资产和出价参数；高级项目及报表配置会覆盖上方对应设置。</p><Field label="渠道参数 JSON"><textarea name="platformConfig" rows={5} placeholder={'{\n  "project": {},\n  "promotion": {}\n}'}/></Field></details>
            <label className="bx-checkbox"><input name="autoOptimize" type="checkbox"/><span>允许员工依据真实效果，在共享额度内自动优化</span></label>
            <p className="bx-form-note">保存草稿不会消耗广告预算。实际启动前还会校验账户、素材及渠道参数；总预算按报表反馈控制，渠道回传存在延迟。</p>
            </fieldset>
            {partial && <p className="bx-inline-warning">部分草稿已保存。补齐操作将继续使用首次提交的配置，避免重复创建。</p>}
            <footer className={styles.footer}><Button secondary type="button" onClick={onClose} disabled={state.busy === 'create-delivery-group'}>取消</Button>{partial ? <Button type="button" disabled={!!state.busy} busy={state.busy === 'create-delivery-group'} onClick={() => payloadRef.current && save(payloadRef.current)}>补齐剩余草稿</Button> : <Button type="submit" disabled={!validSelected.length || !connections.length || !!state.busy || (!!group && (availableDaily <= 0 || availableTotal <= 0))} busy={state.busy === 'create-delivery-group'}>{group ? '添加投放草稿' : '创建投放草稿'}</Button>}</footer>
        </form>
    </Modal>;
}
