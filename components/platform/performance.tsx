'use client';
import { useMemo, useState } from 'react';
import { ArrowUpRight, BarChart3, CalendarDays } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { buildInsights } from './insights.mjs';
import { Badge, Button, Empty, Field, Panel } from './ui';
import { CHANNELS, dateLabel, money } from './types';
import type { PlatformState } from './use-platform';

const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Hong_Kong' });
const amount = (value: unknown) => value == null ? '—' : money(value);
const ratio = (value: number | null) => value == null ? '—' : `${value.toFixed(2)}×`;
export function Performance({ state, onProject, onCampaign }: { state: PlatformState; onProject: (id: string) => void; onRetry?: () => void; onCampaign?: (id: string) => void }) {
    const [projectId, setProjectId] = useState(''), [channel, setChannel] = useState('');
    const [from, setFrom] = useState(day(-29)), [to, setTo] = useState(day());
    const invalidRange = !!from && !!to && from > to;
    const report = useMemo(() => buildInsights(state.data, { projectId, channel, from, to, currency: 'CNY' }), [state.data, projectId, channel, from, to]);
    const collectionsTruncated = state.data.capabilities?.collectionsTruncated || state.data.capabilities?.metricsTruncated;
    const goCampaign = (id: string, packId: string) => onCampaign ? onCampaign(id) : onProject(packId);
    const trend = report.trend.map((row: any) => ({ ...row, revenue: row.revenue ?? undefined }));
    return <>
        <Panel title={collectionsTruncated ? "已加载数据概览" : "经营数据总览"} subtitle="汇总素材包与渠道的真实日报，查看整体投入、收入和内容表现。" action={<Badge tone={collectionsTruncated ? "amber" : "blue"}>M5 · {collectionsTruncated ? "部分数据" : "全局汇总"}</Badge>}>
            <div className="bx-form-grid">
                <Field label="素材包"><select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">全部素材包</option>{state.data.projects.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}</select></Field>
                <Field label="投放渠道"><select value={channel} onChange={e => setChannel(e.target.value)}><option value="">全部渠道</option>{Object.entries(CHANNELS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field>
                <Field label="开始日期"><input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)}/></Field>
                <Field label="结束日期"><input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)}/></Field>
            </div>
            <div className="bx-toolbar" style={{ marginTop: 16 }}><div className="bx-inline-actions"><Button secondary onClick={() => { setFrom(day(-6)); setTo(day()); }}>近 7 天</Button><Button secondary onClick={() => { setFrom(day(-29)); setTo(day()); }}>近 30 天</Button><Button secondary onClick={() => { setFrom(''); setTo(''); }}>全部已同步日期</Button></div><small>{report.projectCount} 个素材包 · {report.reportedCampaignCount}/{report.campaignCount} 个投放单元有日报 · CNY</small></div>
            {invalidRange && <p role="alert">开始日期不能晚于结束日期，请调整筛选范围。</p>}
        </Panel>
        {collectionsTruncated && <Panel><p role="status">素材包、文件、投放单元或日报数量已达到当前读取上限。以下仅汇总已加载数据，可能缺少部分素材包及其投放记录，不代表整个工作区。经营建议暂停生成，等待完整数据汇总。</p></Panel>}
        <div className="bx-stat-grid">
            <div className="bx-stat"><span>实际消耗</span><strong>{report.count ? money(report.spend) : '—'}</strong><small>按单元、日期去重汇总</small></div>
            <div className="bx-stat"><span>归因收入</span><strong>{amount(report.revenue)}</strong><small>{report.count && report.revenue == null ? `已知部分 ${money(report.knownRevenue)}，其余待回传` : '渠道归因口径，非跨渠道去重订单'}</small></div>
            <div className="bx-stat"><span>投产比</span><strong>{ratio(report.roi)}</strong><small>总归因收入 ÷ 总消耗</small></div>
            <div className="bx-stat"><span>收入数据覆盖</span><strong>{report.count ? `${Math.round(report.coverage * 100)}%` : '—'}</strong><small>{report.knownCount}/{report.count} 条日报 · 更新于 {dateLabel(report.updatedAt)}</small></div>
        </div>
        {!!report.count && (report.coverage < 1 || !report.comparable || report.freshCount < report.count) && <Panel><div className="bx-inline-actions"><Badge tone="amber">数据完整性提示</Badge><span>{report.coverage < 1 ? '存在尚未回传的收入，整体投产比暂不计算。' : ''}{!report.comparable ? '归因窗口不一致，请统一口径后比较。' : ''}{report.freshCount < report.count ? ` ${report.count - report.freshCount} 条日报尚未确认新鲜。` : ''}</span></div></Panel>}
        <Panel title="投入与收入趋势" subtitle="仅展示有真实日报的日期；缺失收入保留为空。" action={<CalendarDays size={18}/>}>
            {trend.length ? <><div style={{ height: 260, minWidth: 0 }} role="img" aria-label="每日消耗与归因收入折线图，下方提供完整数据表"><ResponsiveContainer width="100%" height="100%"><LineChart data={trend} margin={{ top: 12, right: 16, bottom: 0, left: 0 }}><CartesianGrid strokeDasharray="3 3" stroke="#e8edf4"/><XAxis dataKey="date" tickFormatter={value => value.slice(5)} tick={{ fontSize: 11 }}/><YAxis tick={{ fontSize: 11 }}/><Tooltip formatter={(value: any, name: any) => [money(value), name]}/><Line name="实际消耗" dataKey="spend" type="monotone" stroke="#2563eb" strokeWidth={2.5} dot={trend.length < 12} connectNulls={false}/><Line name="归因收入" dataKey="revenue" type="monotone" stroke="#16a34a" strokeWidth={2.5} dot={trend.length < 12} connectNulls={false}/></LineChart></ResponsiveContainer></div><details className="bx-advanced"><summary>查看每日汇总数据</summary><div className="bx-table-scroll"><table className="bx-table"><thead><tr><th>日期</th><th>消耗</th><th>归因收入</th><th>投产比</th><th>数据覆盖</th></tr></thead><tbody>{report.trend.map((row: any) => <tr key={row.date}><td>{row.date}</td><td>{money(row.spend)}</td><td>{amount(row.revenue)}</td><td>{ratio(row.roi)}</td><td>{row.knownCount}/{row.count}</td></tr>)}</tbody></table></div></details></> : <Empty icon={<BarChart3 size={28}/>} title="当前范围还没有投放数据" description="在投放中心完成渠道连接并同步真实日报后，这里将自动汇总。也可以调整日期与素材包筛选。"/>}
        </Panel>
        <Panel title="渠道贡献" subtitle="按实际消耗排序。跨渠道收入使用各平台归因结果，不能视为去重后的业务收入。">
            {report.byChannel.length ? <div className="bx-table-scroll"><table className="bx-table"><thead><tr><th>渠道</th><th>消耗 / 占比</th><th>归因收入</th><th>投产比</th><th>曝光</th><th>点击率</th><th>归因转化</th></tr></thead><tbody>{report.byChannel.map((row: any) => <tr key={row.id}><td><strong>{CHANNELS[row.channel] || row.channel}</strong></td><td>{money(row.spend)}<small>{report.spend > 0 ? `${(row.spend / report.spend * 100).toFixed(1)}%` : '—'}</small></td><td>{amount(row.revenue)}</td><td>{ratio(row.roi)}</td><td>{row.impressions?.toLocaleString('zh-CN') ?? '—'}</td><td>{row.ctr == null ? '—' : `${(row.ctr * 100).toFixed(2)}%`}</td><td>{row.conversions ?? '—'}</td></tr>)}</tbody></table></div> : <p>渠道同步的真实效果将在此汇总。</p>}
        </Panel>
        <Panel title="素材包表现" subtitle="从整体表现定位到包内投放；同包多条成品按独立投放单元汇总。">
            {report.byProject.length ? <div className="bx-table-scroll"><table className="bx-table"><thead><tr><th>素材包</th><th>消耗</th><th>归因收入</th><th>投产比</th><th>报表天数</th><th>查看</th></tr></thead><tbody>{report.byProject.map((row: any) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{money(row.spend)}</td><td>{amount(row.revenue)}</td><td>{ratio(row.roi)}</td><td>{row.days} 天</td><td><Button secondary onClick={() => onProject(row.projectId)}>素材包<ArrowUpRight size={14}/></Button></td></tr>)}</tbody></table></div> : <p>有投放日报后，可以比较各素材包的投入与产出。</p>}
        </Panel>
        <Panel title="投放单元明细" subtitle="从汇总进入单条投放，查看预算调整、员工汇报和完整效果。">
            {report.byCampaign.length ? <div className="bx-table-scroll"><table className="bx-table"><thead><tr><th>投放单元</th><th>渠道</th><th>消耗</th><th>归因收入</th><th>投产比</th><th>数据覆盖</th><th>详情</th></tr></thead><tbody>{report.byCampaign.map((row: any) => <tr key={row.id}><td><strong>{row.name}</strong></td><td>{CHANNELS[row.channel] || row.channel}</td><td>{money(row.spend)}</td><td>{amount(row.revenue)}</td><td>{ratio(row.roi)}</td><td>{row.knownCount}/{row.count}</td><td><Button secondary onClick={() => goCampaign(row.id, row.projectId)}>查看投放<ArrowUpRight size={14}/></Button></td></tr>)}</tbody></table></div> : <p>暂无可汇总的投放单元日报。</p>}
        </Panel>
    </>;
}
