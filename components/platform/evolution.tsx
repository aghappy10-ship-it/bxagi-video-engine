'use client';
import { useState } from 'react';
import { BookOpen, CheckCircle2, FlaskConical, GitBranch, RotateCcw } from 'lucide-react';
import { post } from './api';
import { STRATEGY_STATUS } from './insights.mjs';
import { Badge, Button, Empty, Field, Modal, Panel } from './ui';
import { dateLabel, type Row } from './types';
import type { PlatformState } from './use-platform';

export function Evolution({ state, onProject }: { state: PlatformState; onProject?: (id: string) => void }) {
    const [kind, setKind] = useState('material'), [validating, setValidating] = useState<Row | null>(null);
    const strategies: Row[] = (state.data as typeof state.data & { strategies?: Row[] }).strategies || [];
    const visible = strategies.filter(row => row.kind === kind);
    async function validate(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!validating) return;
        const form = new FormData(event.currentTarget);
        const result = await state.run(`strategy-validate-${validating.id}`, () => post(`/strategies/${validating.id}/action`, { action: 'validate', notes: form.get('notes') }), '已核对后续真实数据并保存观察结论，可决定是否发布为员工参考。');
        if (result) setValidating(null);
    }
    return <>
        <Panel title="让每轮投放留下可复用的经验" subtitle="将已采纳的经营建议转为待验证方法，保留真实依据、版本和应用记录。" action={<Badge tone="blue">M8 · 方法与策略积累</Badge>}>
            <div className="bx-stat-grid"><div className="bx-stat"><span>待验证方法</span><strong>{strategies.filter(row => row.status === 'hypothesis').length}</strong><small>等待后续真实结果</small></div><div className="bx-stat"><span>已有观察结果</span><strong>{strategies.filter(row => row.status === 'validated').length}</strong><small>可审阅依据后发布</small></div><div className="bx-stat"><span>已发布参考</span><strong>{strategies.filter(row => row.status === 'active').length}</strong><small>后续员工任务使用</small></div><div className="bx-stat"><span>已回退版本</span><strong>{strategies.filter(row => row.status === 'rolled_back').length}</strong><small>历史依据完整保留</small></div></div>
        </Panel>
        <div className="bx-toolbar"><div className="bx-inline-actions"><Button secondary={kind !== 'material'} aria-pressed={kind === 'material'} onClick={() => setKind('material')}><BookOpen size={16}/>素材创作指导</Button><Button secondary={kind !== 'delivery'} aria-pressed={kind === 'delivery'} onClick={() => setKind('delivery')}><GitBranch size={16}/>投放策略进化</Button></div><small>假设 → 报表验证 → 发布参考 → 持续观察 / 回退</small></div>
        <Panel title={kind === 'material' ? '下一次，应该提供怎样的素材？' : '下一轮，应该怎样分配与调整？'} subtitle={kind === 'material' ? '从素材缺口、版本差异与实际表现形成上传和创作指导。' : '记录整体预算与渠道策略的观察结果，为后续经营决策和员工执行提供参考。'}><p>{kind === 'material' ? '当前以素材包和真实投放记录为依据。画面内容尚未完成自动识别时，不自动断言某种颜色、镜头或风格是爆款原因。' : '发布策略提供参考指令，不会增加预算上限、自动启动投放或替代用户授权。回退后停止用于后续任务，已执行的投放仍在投放中心管理。'}</p></Panel>
        {!visible.length && <Panel><Empty icon={<FlaskConical size={28}/>} title="先从一项已采纳的经营建议开始" description="在经营决策中采纳建议并选择“加入进化验证”。这里将保存基线，等待后续真实报表，逐步形成可复用的方法。"/></Panel>}
        {visible.map(strategy => {
            const validation = strategy.evidence?.validation, baseline = strategy.evidence?.baseline || {};
            return <Panel key={strategy.id} title={strategy.name} subtitle={`${strategy.projectId ? state.data.projects.find(row => row.id === strategy.projectId)?.title || '关联素材包' : '工作区通用'} · 版本 ${strategy.version} · ${dateLabel(strategy.updatedAt || strategy.createdAt)}`} action={<Badge tone={strategy.status === 'active' ? 'green' : strategy.status === 'hypothesis' ? 'amber' : 'neutral'}>{(STRATEGY_STATUS as Record<string, string>)[strategy.status] || strategy.status}</Badge>}>
                <p style={{ fontSize: 15, lineHeight: 1.8 }}>{strategy.definition?.guidance}</p>
                <div className="bx-form-grid"><div><strong>基线依据</strong><p>{baseline.metricIds?.length || 0} 条日报 · 截至 {baseline.lastDate || '暂无投放日报'}</p>{baseline.report?.roi != null && <p>基线投产比 {Number(baseline.report.roi).toFixed(2)}×</p>}<small>原经营建议与实际记录始终保留。</small></div><div><strong>{validation ? '后续观察结果' : '验证条件'}</strong>{validation ? <><p>{validation.days} 个报表日 · {validation.conversions} 次归因转化 · 投产比 {Number(validation.roi).toFixed(2)}×</p><p>{validation.notes}</p><small>{validation.interpretation}</small></> : <><p>基线之后至少 3 个报表日、10 次归因转化，收入完整且口径一致。</p><small>需记录实际改动。数据满足条件代表具备观察依据，不等于策略已被证明有效。</small></>}</div></div>
                {strategy.status === 'active' && <p><Badge tone="green">后续任务参考已开启</Badge><small> 仅对适用素材包的新任务提供指导，保留原有预算和投放权限。</small></p>}
                {strategy.status === 'rolled_back' && <p>已回退于 {dateLabel(strategy.definition?.rolledBackAt)}，后续任务不再引用此版本。</p>}
                <div className="bx-inline-actions" style={{ marginTop: 16 }}>{strategy.status === 'hypothesis' && <Button disabled={!!state.busy} onClick={() => setValidating(strategy)}><FlaskConical size={15}/>检查数据并记录验证</Button>}{strategy.status === 'validated' && <Button disabled={!!state.busy} onClick={() => state.run(`strategy-activate-${strategy.id}`, () => post(`/strategies/${strategy.id}/action`, { action: 'activate' }), '已发布为后续员工任务的参考方法。')}><CheckCircle2 size={15}/>发布为员工参考</Button>}{strategy.status !== 'rolled_back' && <Button secondary disabled={!!state.busy} onClick={() => state.run(`strategy-rollback-${strategy.id}`, () => post(`/strategies/${strategy.id}/action`, { action: 'rollback' }), '已回退策略，后续任务不再引用此版本。')}><RotateCcw size={15}/>{strategy.status === 'active' ? '回退此版本' : '归档此方法'}</Button>}{strategy.projectId && onProject && <Button secondary onClick={() => onProject(strategy.projectId)}>查看素材包</Button>}</div>
            </Panel>;
        })}
        {validating && <Modal title="核对策略观察结果" description="服务端将核对基线之后的真实报表。数据不足时保留待验证状态。" onClose={() => setValidating(null)}><form onSubmit={validate}><Field label="实际改动与观察结论 *" hint="写明本轮改变了什么、观察到了什么，以及仍未排除的影响因素。"><textarea name="notes" rows={5} required maxLength={1000} placeholder="例如：补充产品佩戴细节素材；本轮同时更换了受众，暂时无法将变化完全归因于素材。"/></Field><footer className="bx-modal-footer"><Button secondary type="button" onClick={() => setValidating(null)}>取消</Button><Button type="submit" busy={state.busy === `strategy-validate-${validating.id}`}>核对报表并保存</Button></footer></form></Modal>}
    </>;
}
