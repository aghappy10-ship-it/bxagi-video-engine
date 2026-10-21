'use client';
import { useState } from 'react';
import { ArrowUpRight, Check, Compass, GitBranch, RefreshCw, Sparkles } from 'lucide-react';
import { post } from './api';
import { buildInsights, DECISION_STATUS } from './insights.mjs';
import { Badge, Button, Empty, Panel } from './ui';
import { dateLabel, money, type Row } from './types';
import type { PlatformState } from './use-platform';

export function Decisions({ state, onProject, onCampaign, onTasks }: { state: PlatformState; onProject: (id: string) => void; onCampaign?: (id: string) => void; onTasks?: (projectId: string, taskId?: string) => void }) {
    const [status, setStatus] = useState('proposed');
    const decisions: Row[] = (state.data as typeof state.data & { decisions?: Row[] }).decisions || [];
    const strategies: Row[] = (state.data as typeof state.data & { strategies?: Row[] }).strategies || [];
    const visible = decisions.filter(row => !status || row.status === status);
    const report = buildInsights(state.data);
    return <>
        <Panel title="把经营数据变成下一步行动" subtitle="综合素材包、投放目标与真实反馈，形成可追溯的经营建议。" action={<Button disabled={!!state.busy} busy={state.busy === 'decision-refresh'} onClick={() => state.run('decision-refresh', () => post('/decisions/refresh', {}), '已根据近 30 天真实数据更新经营建议。')}><RefreshCw size={16}/>更新经营建议</Button>}>
            <div className="bx-stat-grid"><div className="bx-stat"><span>等待决策</span><strong>{decisions.filter(row => row.status === 'proposed').length}</strong><small>按数据依据逐项处理</small></div><div className="bx-stat"><span>已采纳行动</span><strong>{decisions.filter(row => row.status === 'accepted').length}</strong><small>优化任务或预算调整草案</small></div><div className="bx-stat"><span>有日报的素材包</span><strong>{report.byProject.length}</strong><small>已同步的实际投放结果</small></div><div className="bx-stat"><span>已发布方法</span><strong>{strategies.filter(row => row.status === 'active').length}</strong><small>供后续员工任务参考</small></div></div>
        </Panel>
        <div className="bx-toolbar"><div className="bx-inline-actions">{[['proposed', '待决策'], ['accepted', '已采纳'], ['dismissed', '暂不采纳'], ['', '全部记录']].map(([value, title]) => <Button key={value} secondary={status !== value} aria-pressed={status === value} onClick={() => setStatus(value)}>{title}</Button>)}</div><Badge tone="blue">M6 · 当前经营行动</Badge></div>
        {!visible.length && <Panel><Empty icon={<Compass size={28}/>} title={decisions.length ? '当前分类暂无建议' : '从真实资料与投放反馈开始'} description="点击更新经营建议，系统将检查生产缺口、数据完整性和投放表现。数据不足时，会明确指出需要补齐的内容。"/></Panel>}
        {visible.map(decision => {
            const evidence = decision.evidence || {}, result = decision.result || {}, isMaterial = decision.type === 'material';
            return <Panel key={decision.id} title={<span className="bx-inline-actions">{isMaterial ? <Sparkles size={19}/> : <Compass size={19}/>} {decision.title}</span>} subtitle={decision.reason} action={<Badge tone={decision.status === 'accepted' ? 'green' : 'neutral'}>{(DECISION_STATUS as Record<string, string>)[decision.status] || '处理中'}</Badge>}>
                <div className="bx-inline-actions" style={{ marginBottom: 14 }}><Badge tone={isMaterial ? 'purple' : decision.type === 'data_quality' ? 'amber' : 'blue'}>{isMaterial ? '素材改进' : decision.type === 'data_quality' ? '数据补齐' : '投放策略'}</Badge><span>{decision.projectId ? state.data.projects.find(row => row.id === decision.projectId)?.title || '关联素材包' : '整个工作区'}</span><small>更新于 {dateLabel(decision.updatedAt || decision.createdAt)}</small></div>
                <div className="bx-form-grid"><div><strong>判断依据</strong><p>{evidence.window ? `${evidence.window.from} 至 ${evidence.window.to}` : '当前素材与投放记录'}</p><p>{evidence.metricIds?.length ? `${evidence.metricIds.length} 条真实日报` : '暂无投放日报依据'}{evidence.report?.days ? ` · ${evidence.report.days} 个报表日` : ''}{evidence.report?.conversions != null ? ` · ${evidence.report.conversions} 次归因转化` : ''}</p>{evidence.report?.spend != null && <p>消耗 {money(evidence.report.spend)}{evidence.report.roi != null ? ` · 投产比 ${Number(evidence.report.roi).toFixed(2)}×` : ''}</p>}</div><div><strong>建议行动</strong><p>{decision.actionPlan?.instructions}</p><small>{decision.actionPlan?.kind === 'budget_draft' ? '采纳后保存调整草案；预算需在投放中心明确执行。' : decision.actionPlan?.kind === 'optimization_task' ? '采纳后创建可追踪的素材优化任务。' : '采纳后记录待补数据事项，可进入投放中心处理。'}</small></div></div>
                {decision.status === 'accepted' && <p><Badge tone="green">{result.execution === 'task_created' ? '优化任务已创建' : result.execution === 'draft_only' ? '预算调整草案已保存' : '已记录待办事项'}</Badge>{result.optimizationTaskId && <small> 任务编号：{result.optimizationTaskId}</small>}</p>}
                <details className="bx-advanced"><summary>查看判断口径与关联依据</summary><p>{evidence.method || '依据当前工作区的真实记录生成。'}</p><p>效果类建议的当前观察门槛：至少 3 个报表日、10 次归因转化，且收入完整、日报已确认新鲜。达到门槛不代表因果证明。</p>{evidence.activeStrategyIds?.length > 0 && <p>参考已发布方法：{evidence.activeStrategyIds.length} 项。</p>}<small>日报记录：{evidence.metricIds?.join('、') || '尚无日报'}</small></details>
                <div className="bx-inline-actions" style={{ marginTop: 16 }}>{decision.status === 'proposed' && <><Button disabled={!!state.busy} busy={state.busy === `decision-accept-${decision.id}`} onClick={() => state.run(`decision-accept-${decision.id}`, () => post(`/decisions/${decision.id}/action`, { action: 'accept' }), decision.actionPlan?.kind === 'budget_draft' ? '已保存预算调整草案，尚未修改渠道预算。' : '已采纳并记录下一步行动。')}><Check size={15}/>采纳建议</Button><Button secondary disabled={!!state.busy} onClick={() => state.run(`decision-dismiss-${decision.id}`, () => post(`/decisions/${decision.id}/action`, { action: 'dismiss' }), '已记录为暂不采纳。')}>暂不采纳</Button></>}{decision.status === 'accepted' && result.optimizationTaskId && onTasks && <Button onClick={() => onTasks(decision.projectId, result.optimizationTaskId)}>进入任务中心优化<ArrowUpRight size={14}/></Button>}{decision.projectId && <Button secondary onClick={() => decision.campaignId && onCampaign ? onCampaign(decision.campaignId) : onProject(decision.projectId)}>查看关联业务<ArrowUpRight size={14}/></Button>}{decision.status === 'accepted' && ['material', 'delivery'].includes(decision.type) && <Button secondary disabled={!!state.busy || strategies.some(row => row.sourceDecisionId === decision.id && row.status !== 'rolled_back')} onClick={() => state.run(`strategy-from-${decision.id}`, () => post('/strategies', { decisionId: decision.id }), '已加入进化中心，等待后续真实报表验证。')}><GitBranch size={15}/>加入进化验证</Button>}</div>
            </Panel>;
        })}
    </>;
}
