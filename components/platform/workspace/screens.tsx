'use client';

import { Component, lazy, Suspense, type ReactNode } from 'react';
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import type { Row, Screen } from '../types';
import type { PlatformState } from '../use-platform';
import { Button } from '../ui';
import { Overview } from '../overview';

const Projects = lazy(() => import('../projects').then(module => ({ default: module.Projects })));
const Library = lazy(() => import('../library').then(module => ({ default: module.Library })));
const Tasks = lazy(() => import('../tasks').then(module => ({ default: module.Tasks })));
const Decisions = lazy(() => import('../decisions').then(module => ({ default: module.Decisions })));
const Evolution = lazy(() => import('../evolution').then(module => ({ default: module.Evolution })));
const Campaigns = lazy(() => import('../campaigns').then(module => ({ default: module.Campaigns })));
const Performance = lazy(() => import('../performance').then(module => ({ default: module.Performance })));
const Settings = lazy(() => import('../settings').then(module => ({ default: module.Settings })));
export const NewProjectDialog = lazy(() => import('../projects').then(module => ({ default: module.NewProject })));
export const CampaignDialog = lazy(() => import('../campaigns').then(module => ({ default: module.CampaignForm })));

export function ScreenLoading() {
  return <div className="bx-screen-loading" role="status"><Loader2 className="spin" size={20} /><span>正在加载工作区…</span></div>;
}

export class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="bx-screen-error" role="alert"><AlertCircle size={28} /><h2>这个页面暂时没有加载完成</h2><p>已保存的任务和文件仍在工作区，可以刷新页面后继续。</p><Button secondary onClick={() => window.location.reload()}><RefreshCw size={16} />重新加载</Button></section>;
  }
}

type Props = {
  screen: Screen;
  state: PlatformState;
  selectedProject: string;
  onSelectProject: (id: string) => void;
  onCreateProject: () => void;
  onOpenProject: (id: string) => void;
  onCampaign: (creative?: Row) => void;
  onNavigate: (screen: Screen) => void;
  onRetry: () => void;
};

export function WorkspaceScreen(props: Props) {
  const { state, screen, selectedProject, onSelectProject, onCreateProject, onOpenProject, onCampaign, onNavigate, onRetry } = props;
  function openDelivery(campaignId: string) {
    const url = new URL(window.location.href);
    url.searchParams.delete('deliveryGroup');
    url.searchParams.set('deliveryUnit', campaignId);
    window.history.replaceState(null, '', url);
    onNavigate('campaigns');
  }
  return <ScreenBoundary key={screen}><Suspense fallback={<ScreenLoading />}>
    {screen === 'overview' && <Overview state={state} onCreate={onCreateProject} onScreen={onNavigate} onProject={onOpenProject} />}
    {screen === 'projects' && <Projects state={state} selectedId={selectedProject} onSelect={onSelectProject} onCreate={onCreateProject} onTasks={id => { onSelectProject(id); onNavigate('tasks'); }} />}
    {screen === 'library' && <Library state={state} onCampaign={onCampaign} selectedProject={selectedProject} onProject={onOpenProject} onTasks={id => { onSelectProject(id); onNavigate('tasks'); }} />}
    {(screen === 'tasks' || screen === 'employees') && <Tasks key={screen} state={state} selectedProject={selectedProject} onProject={onOpenProject} onLibrary={id => { onSelectProject(id); onNavigate('library'); }} initialTab={screen === 'employees' ? 'employees' : 'tasks'} />}
    {screen === 'campaigns' && <Campaigns state={state} onCreate={() => onCampaign()} onPerformance={() => onNavigate('performance')} />}
    {screen === 'performance' && <Performance state={state} onProject={onOpenProject} onRetry={onRetry} onCampaign={openDelivery} />}
    {screen === 'decisions' && <Decisions state={state} onProject={onOpenProject} onCampaign={openDelivery} onTasks={(id, taskId) => { const url = new URL(window.location.href); if (taskId) url.searchParams.set('optimizationTask', taskId); else url.searchParams.delete('optimizationTask'); window.history.replaceState(null, '', url); onSelectProject(id); onNavigate('tasks'); }} />}
    {screen === 'evolution' && <Evolution state={state} onProject={onOpenProject} />}
    {screen === 'settings' && <Settings state={state} />}
  </Suspense></ScreenBoundary>;
}
