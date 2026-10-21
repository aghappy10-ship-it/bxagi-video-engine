'use client';

import {
  ArrowRight, ArrowUpRight, Box, ChevronRight, Clapperboard,
  Clock3, FileText, FolderOpen, Gamepad2, Image as ImageIcon, Layers3, Plus,
  ShieldCheck, Shirt, Sparkles, Target, UploadCloud, Video, Workflow,
} from 'lucide-react';
import { Badge, Button, Empty, LinkButton, Panel } from './ui';
import { bytes, dateLabel, label, mime, type Row, type Screen } from './types';
import type { PlatformState } from './use-platform';
import { AutomationFlowCards } from './automation';
import '../../styles/platform/package-workspace.css';
import { projectReadyCreatives, backgroundSchedulerState } from './automation.mjs';
import { remoteJobs, pendingRemoteJob, remoteJobDescription } from './remote-jobs.mjs';

type Props = {
  state: PlatformState;
  onCreate: () => void;
  onScreen: (screen: Screen) => void;
  onProject: (id: string) => void;
};

function SceneIcon({ scene }: { scene: string }) {
  const Icon = scene === 'apparel' ? Shirt : scene === 'game' ? Gamepad2 : scene === 'drama' ? Clapperboard : Box;
  return <Icon size={20} />;
}

export function Overview({ state, onCreate, onScreen, onProject }: Props) {
  const { data } = state;
  const jobs = remoteJobs(data);
  const activeJobs = jobs.filter(pendingRemoteJob);
  const attention = activeJobs.filter(job => ['awaiting_user_input', 'awaiting_user_confirmation', 'needs_reconciliation'].includes(job.status));
  const ready = data.projects.flatMap(project => projectReadyCreatives(project.id, data)) as Row[];
  const review = ready.filter(row => !['approved', 'reviewed'].includes(row.status));
  const recent = [...data.projects].sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))).slice(0, 5);
  const latestFiles = [...ready].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 3);
  const activeCampaigns = data.campaigns.filter(row => ['active', 'running'].includes(row.status));
  const scheduler = backgroundSchedulerState(data.capabilities);
  const next = attention.length
    ? { title: attention.length + ' 个任务需要你处理', detail: '查看员工的补充信息、确认请求或待核查结果。', action: '查看任务', onClick: () => onScreen('tasks'), tone: 'amber' }
    : review.length
      ? { title: review.length + ' 份成品已完成交付', detail: '预览实际文件并完成审核，再为合适的素材设置预算。', action: '检查成品', onClick: () => onScreen('library'), tone: 'green' }
      : activeJobs.length
        ? { title: activeJobs.length + ' 个员工任务进行中', detail: '任务进度会持续同步，实际生成的文件将归档到素材库。', action: '跟进进度', onClick: () => onScreen('tasks'), tone: 'blue' }
        : { title: data.projects.length ? '继续你的下一次创作' : '从第一个素材包开始', detail: '上传图片、视频或产品资料，说明目标与真实卖点。', action: '新建素材包', onClick: onCreate, tone: 'blue' };
  const stats = [
    { title: '素材包', value: data.projects.length, caption: '按产品与目标组织', Icon: FolderOpen, screen: 'projects' as Screen },
    { title: '原始文件', value: data.assets.length, caption: '当前工作区已上传', Icon: Layers3, screen: 'projects' as Screen },
    { title: '完整主成品', value: ready.length, caption: review.length + ' 份待审核', Icon: ImageIcon, screen: 'library' as Screen },
    { title: '进行中任务', value: activeJobs.length, caption: attention.length ? attention.length + ' 项需要处理' : '以实际员工状态为准', Icon: Workflow, screen: 'tasks' as Screen },
  ];

  return <>
    <section className="bx-operational-hero">
      <div><span className="bx-studio-eyebrow"><span/>BXAGI WORKSPACE</span><h2>工作区进展，一目了然。</h2><p>上传资料、安排员工、管理投放，下一步从这里开始。</p></div>
      <div className="bx-inline-actions"><Button onClick={onCreate}><Plus size={16}/>新建素材包</Button><a className="bx-button secondary" href="#projects?view=catalog"><Clapperboard size={16}/>自动抓剧</a><button className="bx-studio-link" onClick={() => onScreen('campaigns')}>查看投放<ArrowUpRight size={16}/></button></div>
    </section>

    <div className="bx-workspace-stats">
      {stats.map(({ title, value, caption, Icon, screen }) => <button className="bx-workspace-stat" key={title} onClick={() => onScreen(screen)}><div><span>{title}</span><Icon size={18} /></div><strong>{value}<ArrowUpRight size={17} /></strong><small>{caption}</small></button>)}
    </div>

    <section className={'bx-next-action ' + next.tone} aria-label="建议下一步">
      <span className="bx-next-icon"><Sparkles size={20} /></span>
      <div><span>下一步</span><h2>{next.title}</h2><p>{next.detail}</p></div>
      <Button secondary onClick={next.onClick}>{next.action}<ArrowRight size={15} /></Button>
    </section>

    <div className="bx-workspace-columns">
      <Panel title="最近素材包" subtitle="跟进素材从上传到生产的每一步。" action={<LinkButton onClick={() => onScreen('projects')}>全部素材包</LinkButton>} className="bx-recent-panel">
        {recent.length ? <div className="bx-project-rows">{recent.map(project => {
          const count = ready.filter(row => row.projectId === project.id).length;
          const pending = activeJobs.filter(job => job.projectId === project.id);
          return <button key={project.id} onClick={() => onProject(project.id)}><span className={'bx-project-scene ' + project.scene}><SceneIcon scene={project.scene} /></span><div><strong>{project.title}</strong><small>{(project.productName || '原始素材包')}<span>·</span>{count} 份成品</small></div><span className="bx-project-row-state">{pending.length ? <Badge tone="blue">员工处理中</Badge> : count ? <Badge tone="green">已交付</Badge> : project.sourceState?.status === 'uploading' ? <Badge tone="amber">上传待完成</Badge> : <Badge>待安排优化</Badge>}<small>{dateLabel(project.updatedAt || project.createdAt)}</small></span><ChevronRight size={16} /></button>;
        })}</div> : <Empty title="第一份好素材，从这里开始" description="创建素材包、上传资料，再去任务中心安排员工。" icon={<FolderOpen size={28} />} action={<Button secondary onClick={onCreate}><Plus size={16} />创建素材包</Button>} />}
      </Panel>

      <Panel title="工作区连接" subtitle="来自当前账号的实际连接状态。" className="bx-connection-panel">
        <div className="bx-connection-list">
          <div><span><ShieldCheck size={18} /></span><div><strong>BXAGI 账号</strong><small>{data.bxagi.profile?.displayName || '当前账号工作区'}</small></div><Badge tone={data.bxagi.connected ? 'green' : 'amber'}>{data.bxagi.connected ? '已连接' : '待登录'}</Badge></div>
          <div><span><UploadCloud size={18} /></span><div><strong>素材存储</strong><small>原始文件与实际交付</small></div><Badge tone={data.capabilities.storage ? 'green' : 'amber'}>{data.capabilities.storage ? '已接通' : '待配置'}</Badge></div>
          <div><span><Target size={18} /></span><div><strong>广告投放</strong><small>{activeCampaigns.length} 条成品正在投放</small></div><button className="bx-text-button" onClick={() => onScreen('settings')}>管理授权</button></div>
        </div>
        <div className="bx-scheduler-note"><Clock3 size={15} /><p>{scheduler.running ? '后台调度运行中，可持续跟进任务。' : '后台执行器尚未运行，当前由页面跟进任务。'}<button onClick={() => onScreen('tasks')}>查看执行状态<ArrowUpRight size={12} /></button></p></div>
      </Panel>
    </div>

    {latestFiles.length > 0 && <Panel title="最近交付" subtitle="仅展示完整交付中当前有效的成品。" action={<LinkButton onClick={() => onScreen('library')}>打开成品中心</LinkButton>}>
      <div className="bx-latest-files">{latestFiles.map(file => {
        const type = mime(file);
        const image = ['image/png', 'image/jpeg', 'image/webp'].includes(type) && typeof file.contentUrl === 'string' && file.contentUrl.startsWith('/api/v2/creatives/');
        return <button key={file.id} onClick={() => onScreen('library')}><span className="bx-latest-preview">{image ? <img src={file.contentUrl} alt="" loading="lazy" /> : type.startsWith('video/') ? <Video size={25} /> : <FileText size={25} />}</span><div><strong>{label(file)}</strong><small>{type.startsWith('video/') ? '视频' : type.startsWith('image/') ? '图片' : '文档'} · {bytes(file.size)}</small><span>{dateLabel(file.createdAt)}</span></div><ArrowUpRight size={16} /></button>;
      })}</div>
    </Panel>}

    {activeJobs.length > 0 && <Panel title="员工执行动态" action={<LinkButton onClick={() => onScreen('tasks')}>全部任务</LinkButton>}>
      <div className="bx-activity-list">{activeJobs.slice(0, 3).map(job => <div key={job.id}><span className="bx-activity-dot" /><div><strong>{data.projects.find(project => project.id === job.projectId)?.title || job.title || 'BXAGI 员工任务'}</strong><p>{remoteJobDescription(job)}</p></div><Badge tone={attention.includes(job) ? 'amber' : 'blue'}>{attention.includes(job) ? '需要处理' : '执行中'}</Badge></div>)}</div>
    </Panel>}

    {data.automationFlows.length > 0 && <details className="bx-workflow-detail"><summary><Workflow size={16} /><span>自动流程详情</span><small>{data.automationFlows.length} 条流程</small><ChevronRight size={16} /></summary><AutomationFlowCards state={state} /></details>}
  </>;
}
