'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, LogOut, Menu, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { Screen } from '../types';
import type { PlatformState } from '../use-platform';
import { WORKSPACE_NAV, screenDefinition } from './navigation';

type Props = {
  state: PlatformState;
  screen: Screen;
  mobileNav: boolean;
  onMobileNav: (open: boolean) => void;
  onNavigate: (screen: Screen) => void;
  children: ReactNode;
};

export function WorkspaceShell({ state, screen, mobileNav, onMobileNav, onNavigate, children }: Props) {
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const current = screenDefinition(screen);
  const userName = state.data.user.displayName || state.data.bxagi.profile?.displayName || '我的工作区';
  const workspaceName = state.data.preferences?.preferences?.workspaceName || '我的创意工作区';

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 761px)');
    const closeOnDesktop = () => { if (desktop.matches) onMobileNav(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, [onMobileNav]);

  useEffect(() => {
    if (!mobileNav) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebar.current?.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') onMobileNav(false);
      if (event.key !== 'Tab') return;
      const targets = Array.from(sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)') || []);
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      menuButton.current?.focus();
    };
  }, [mobileNav, onMobileNav]);

  return (
    <div className="bx-shell">
      <a className="bx-skip-link" href="#workspace-content" onClick={event => {
        event.preventDefault();
        const main = document.getElementById('workspace-content');
        main?.focus();
        main?.scrollIntoView({ block: 'start' });
      }}>跳至工作区内容</a>
      <aside ref={sidebar} id="workspace-navigation" className={`bx-sidebar ${mobileNav ? 'is-open' : ''}`} aria-label="工作区导航">
        <div className="bx-brand-row">
          <a className="bx-brand" href="#overview" aria-label="BXAGI 广告工作台首页" onClick={() => onNavigate('overview')}>
            <span className="bx-brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <div><strong>BXAGI<span>·</span></strong><small>广告素材与投放平台</small></div>
          </a>
          <button className="bx-icon-button bx-nav-close" onClick={() => onMobileNav(false)} aria-label="关闭导航"><X size={20} /></button>
        </div>
        <div className="bx-workspace-tag"><span className="bx-status-dot" />{workspaceName}<ShieldCheck size={14} /></div>
        <nav>
          {['素材与生产', '投放与经营', '系统与进化'].map(group => (
            <div className="bx-nav-group" key={group}>
              <p className="bx-nav-label">{group}</p>
              {WORKSPACE_NAV.filter(item => item.group === group).map(({ id, label, Icon, module }) => (
                <button key={id} className={current.id === id ? 'active' : ''} onClick={() => onNavigate(id)} aria-current={current.id === id ? 'page' : undefined}>
                  <Icon size={18} /><span>{label}</span><small className="bx-module-code">{module}</small>

                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="bx-sidebar-note">
          <span className="bx-note-label">POWERED BY BXAGI</span>
          <strong>每个任务，都有合适的员工</strong>
          <p>从员工市场匹配生产岗位<br />跟进实际执行与交付</p>
          <button onClick={() => onNavigate('tasks')}>进入任务中心<ArrowUpRight size={14} /></button>
        </div>
        <footer className="bx-sidebar-footer">
          <span className="bx-user-avatar">{userName.slice(0, 1)}</span>
          <button className="bx-account-shortcut" onClick={() => onNavigate('settings')}><strong>{userName}</strong><small>BXAGI 账号工作区</small></button>
          <button className="bx-icon-button" aria-label="退出 BXAGI 账号" title="退出登录" disabled={!!state.busy} onClick={() => void state.logoutBxagi()}><LogOut size={16} /></button>
        </footer>
      </aside>
      {mobileNav && <button className="bx-mobile-shade" onClick={() => onMobileNav(false)} aria-label="关闭导航遮罩" tabIndex={-1} />}
      <div className="bx-main" inert={mobileNav || undefined}>
        <header className="bx-topbar">
          <div className="bx-breadcrumb">
            <button ref={menuButton} className="bx-icon-button bx-mobile-menu" aria-label="打开导航" aria-expanded={mobileNav} aria-controls="workspace-navigation" onClick={() => onMobileNav(!mobileNav)}><Menu size={21} /></button>
            <span>{workspaceName}</span><ChevronRight size={13} /><strong>{current.label}</strong>
          </div>
          <div className="bx-topbar-actions">
            <span className="bx-cloud-state"><span className={`bx-status-dot ${state.error ? 'amber' : ''}`} />{state.error ? '同步需要检查' : state.data.bxagi.connected ? 'BXAGI 已连接' : '需要登录'}</span>
            <button className="bx-icon-button" aria-label="刷新工作区" title="刷新工作区" disabled={!!state.busy || state.loading} onClick={() => void state.run('refresh', async () => {}, '工作区记录已刷新。')}><RefreshCw size={17} className={state.busy === 'refresh' ? 'spin' : ''} /></button>
            <button className="bx-topbar-avatar" onClick={() => onNavigate('settings')} aria-label="账户与连接">{userName.slice(0, 1)}</button>
          </div>
        </header>
        <main id="workspace-content" className="bx-content" tabIndex={-1}>{children}<footer className="bx-content-footer"><span>BXAGI 广告工作台</span><span>素材生产 · 成品管理 · 投放优化</span></footer></main>
      </div>
    </div>
  );
}
