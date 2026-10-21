'use client';

import { Suspense, useEffect, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { LoginPanel, LoginModal } from '../components/platform/bxagi-account';
import { useRemoteJobSync } from '../components/platform/remote-jobs';
import { Button } from '../components/platform/ui';
import { usePlatform, type PlatformState } from '../components/platform/use-platform';
import { useAutomaticOptimization } from '../components/platform/use-optimization';
import { WorkspaceShell } from '../components/platform/workspace/workspace-shell';
import { CampaignDialog, NewProjectDialog, ScreenBoundary, ScreenLoading, WorkspaceScreen } from '../components/platform/workspace/screens';
import { SCREEN_DESCRIPTIONS, WORKSPACE_NAV, screenFromHash } from '../components/platform/workspace/navigation';
import type { Row, Screen } from '../components/platform/types';

export default function Home() {
  const state = usePlatform();
  if (state.loading) return <main className="bx-login-loading" role="status"><Loader2 size={30} className="spin" /><h1>BXAGI 广告工作台</h1><p>正在连接你的工作区…</p></main>;
  if (state.requiresLogin) return <LoginPanel state={state} />;
  // A new verified owner gets fresh view state, forms and resource previews.
  return <AuthenticatedWorkspace key={state.data.user.id} state={state} />;
}

function AuthenticatedWorkspace({ state }: { state: PlatformState }) {
  const [screen, setScreen] = useState<Screen>('overview');
  const [selectedProject, setSelectedProject] = useState('');
  const [newProject, setNewProject] = useState(false);
  const [newCampaign, setNewCampaign] = useState(false);
  const [preset, setPreset] = useState<Row | undefined>();
  const [mobileNav, setMobileNav] = useState(false);
  const { retryOptimization } = useAutomaticOptimization(state, screen);
  useRemoteJobSync(state);

  useEffect(() => {
    function readLocation() {
      const section = window.location.hash.split(/[/?]/)[0];
      if (!section || WORKSPACE_NAV.some(item => '#' + item.id === section) || section === '#employees') {
        setScreen(screenFromHash(window.location.hash));
        setMobileNav(false);
      }
    }
    readLocation();
    window.addEventListener('hashchange', readLocation);
    return () => window.removeEventListener('hashchange', readLocation);
  }, []);

  function navigate(next: Screen) {
    setScreen(next);
    setMobileNav(false);
    if (window.location.hash !== '#' + next) window.location.hash = next;
  }

  function createProject() {
    if (!state.data.bxagi.connected) return state.openBxagiLogin();
    setNewProject(true);
  }

  function openProject(id: string) {
    setSelectedProject(id);
    navigate('projects');
  }

  function openCampaign(creative?: Row) {
    if (!state.data.bxagi.connected) return state.openBxagiLogin();
    setPreset(creative);
    setNewCampaign(true);
  }

  const current = WORKSPACE_NAV.find(item => item.id === screen) || WORKSPACE_NAV.find(item => item.id === 'tasks') || WORKSPACE_NAV[0];
  return <WorkspaceShell state={state} screen={screen} mobileNav={mobileNav} onMobileNav={setMobileNav} onNavigate={navigate}>
    <div className="bx-page-heading">
      <div><span>{current.english}</span><h1>{current.label}</h1><p>{SCREEN_DESCRIPTIONS[screen]}</p></div>
      {screen === 'projects' && <Button onClick={createProject}><Plus size={16} />新建素材包</Button>}
    </div>
    {state.error && <div className="bx-message error" role="alert"><span>{state.error}</span><button className="bx-icon-button" onClick={() => state.setError('')} aria-label="关闭错误提示"><X size={16} /></button></div>}
    {state.notice && <div className="bx-message success" role="status"><span>{state.notice}</span><button className="bx-icon-button" onClick={() => state.setNotice('')} aria-label="关闭提示"><X size={16} /></button></div>}
    <WorkspaceScreen state={state} screen={screen} selectedProject={selectedProject} onSelectProject={setSelectedProject} onCreateProject={createProject} onOpenProject={openProject} onCampaign={openCampaign} onNavigate={navigate} onRetry={retryOptimization} />
    {state.bxagiLoginOpen && <LoginModal state={state} onClose={state.closeBxagiLogin} />}
    <ScreenBoundary key={newProject ? 'new-project' : newCampaign ? 'new-campaign' : 'closed'}><Suspense fallback={<ScreenLoading />}>
      {newProject && <NewProjectDialog state={state} onClose={() => setNewProject(false)} onCreated={openProject} />}
      {newCampaign && <CampaignDialog state={state} onClose={() => setNewCampaign(false)} preset={preset} onCreated={() => navigate('campaigns')} />}
    </Suspense></ScreenBoundary>
  </WorkspaceShell>;
}
