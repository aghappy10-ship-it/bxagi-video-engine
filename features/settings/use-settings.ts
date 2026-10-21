'use client';
import { useCallback, useEffect, useState } from 'react';
import { platformRequest } from '../../components/platform/api';
import type { PlatformState } from '../../components/platform/use-platform';

export type SettingsPreferences = {
    displayName: string;
    notificationEmail: string;
    preferences: { workspaceName: string; timezone: string; reportFrequency: 'daily' | 'weekly' | 'off'; notifyOnDelivery: boolean; notifyOnFailure: boolean; notifyOnBudget: boolean };
    emailVerified: boolean;
    emailDeliveryAvailable: boolean;
};
export function useSettings(state: PlatformState) {
    const [settings, setSettings] = useState<SettingsPreferences | null>(null);
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    const load = useCallback(async () => {
        setLoading(true); setError('');
        try { const result = await platformRequest<{ settings: SettingsPreferences }>('/settings/preferences'); setSettings(result.settings); }
        catch (error) { setError(error instanceof Error ? error.message : '暂时无法读取设置'); }
        finally { setLoading(false); }
    }, []);
    useEffect(() => { let mounted = true; setSettings(null); setError(''); setLoading(true); platformRequest<{ settings: SettingsPreferences }>('/settings/preferences').then(result => { if (mounted) setSettings(result.settings); }).catch(error => { if (mounted) setError(error instanceof Error ? error.message : '暂时无法读取设置'); }).finally(() => { if (mounted) setLoading(false); }); return () => { mounted = false; }; }, [state.data.user.id]);
    async function save(patch: Partial<SettingsPreferences>, notice = '设置已保存。') {
        const result = await state.run('save-settings', () => platformRequest<{ settings: SettingsPreferences }>('/settings/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }), notice);
        if (result) setSettings(result.settings);
    }
    return { settings, loading, error, load, save };
}
