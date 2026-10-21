'use client';
import { useEffect, useState } from 'react';
import { Bell, Building2, Database, KeyRound, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { Button, Panel } from './ui';
import type { PlatformState } from './use-platform';
import { ChannelSettings } from '../../features/settings/channel-settings';
import { AccountSecurity, NotificationSettings, ProfileSettings, WorkspaceSettings } from '../../features/settings/settings-panels';
import { useSettings } from '../../features/settings/use-settings';
import { ContentSourceSettings } from '../../features/catalog/source-settings';
import '../../features/settings/settings.css';

const TABS = [
    { id: 'profile', title: '个人资料', icon: UserRound },
    { id: 'security', title: '账户安全', icon: ShieldCheck },
    { id: 'channels', title: '渠道接入', icon: KeyRound },
    { id: 'sources', title: '内容源', icon: Database },
    { id: 'notifications', title: '通知偏好', icon: Bell },
    { id: 'workspace', title: '工作区', icon: Building2 },
] as const;
export function Settings({ state }: { state: PlatformState }) {
    const [tab, setTab] = useState<string>('channels');
    useEffect(() => {
        const readTab = () => {
            const [screen, query = ''] = window.location.hash.slice(1).split('?', 2);
            if (screen === 'settings' && new URLSearchParams(query).get('view') === 'sources') setTab('sources');
        };
        readTab(); window.addEventListener('hashchange', readTab);
        return () => window.removeEventListener('hashchange', readTab);
    }, []);
    const preferences = useSettings(state);
    const needsPreferences = ['profile', 'notifications', 'workspace'].includes(tab);
    return <div className="bx-settings"><nav className="bx-settings-tabs" aria-label="系统设置分类">{TABS.map(item => <button key={item.id} type="button" className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><item.icon size={16}/>{item.title}</button>)}</nav><div className="bx-settings-content">
        {tab === 'channels' && <ChannelSettings state={state}/>}
        {tab === 'sources' && <ContentSourceSettings state={state}/>}
        {tab === 'security' && <AccountSecurity state={state}/>}
        {needsPreferences && preferences.loading && <Panel><p role="status">正在读取你的设置…</p></Panel>}
        {needsPreferences && !preferences.loading && preferences.error && <Panel title="暂时无法读取设置"><p role="alert">{preferences.error}</p><Button secondary onClick={preferences.load}><RefreshCw size={15}/>重新读取</Button></Panel>}
        {preferences.settings && !preferences.loading && !preferences.error && <>
            {tab === 'profile' && <ProfileSettings state={state} settings={preferences.settings} save={preferences.save}/>}
            {tab === 'notifications' && <NotificationSettings state={state} settings={preferences.settings} save={preferences.save}/>}
            {tab === 'workspace' && <WorkspaceSettings state={state} settings={preferences.settings} save={preferences.save}/>}
        </>}
    </div></div>;
}
