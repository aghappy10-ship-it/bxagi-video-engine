'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { platformRequest } from '../../components/platform/api';
import { catalogErrorMessage, catalogNextPoll } from './helpers.mjs';
import type { CatalogItems, CatalogStatus } from './types';

export function useCatalogStatus(ownerId: string, follow = false) {
    const [status, setStatus] = useState<CatalogStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [tick, setTick] = useState(0);
    const [visible, setVisible] = useState(true);
    const life = useRef<AbortController | null>(null);
    const revision = useRef(0);
    const reading = useRef(false);
    const advancing = useRef(false);
    const commanding = useRef(false);
    const retryAfter = useRef(0);

    const refresh = useCallback(async () => {
        const controller = life.current;
        if (!controller || controller.signal.aborted || reading.current || advancing.current || commanding.current) return;
        reading.current = true;
        const version = revision.current;
        try {
            const next = await platformRequest<CatalogStatus>('/catalog/status', { signal: controller.signal });
            if (!controller.signal.aborted && version === revision.current) { setStatus(next); setError(''); retryAfter.current = 0; }
        } catch (err) {
            if (!controller.signal.aborted && version === revision.current) { setError(catalogErrorMessage(err, '暂时无法读取抓取状态，请重试。')); retryAfter.current = Date.now() + 10000; }
        } finally {
            if (life.current === controller) reading.current = false;
            if (!controller.signal.aborted && life.current === controller) { setLoading(false); setTick(value => value + 1); }
        }
    }, []);

    const command = useCallback(async (action: 'sync' | 'pause') => {
        const controller = life.current;
        if (!controller || controller.signal.aborted || commanding.current) return null;
        commanding.current = true;
        const version = ++revision.current;
        setBusy(action); setError('');
        try {
            const next = await platformRequest<CatalogStatus>(`/catalog/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
            if (!controller.signal.aborted && version === revision.current) { setStatus(next); retryAfter.current = 0; return next; }
        } catch (err) {
            if (!controller.signal.aborted && version === revision.current) setError(catalogErrorMessage(err, action === 'pause' ? '暂停未确认，请重试并核查状态。' : '暂时无法启动抓取，请检查内容源配置。'));
        } finally {
            if (life.current === controller) commanding.current = false;
            if (!controller.signal.aborted && life.current === controller) { setBusy(''); setTick(value => value + 1); }
        }
        return null;
    }, []);

    const advance = useCallback(async () => {
        const controller = life.current;
        if (!controller || controller.signal.aborted || advancing.current || commanding.current || reading.current) return;
        advancing.current = true;
        const version = revision.current;
        try {
            const next = await platformRequest<CatalogStatus>('/catalog/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal });
            if (!controller.signal.aborted && version === revision.current) { setStatus(next); setError(''); retryAfter.current = 0; }
        } catch (err) {
            if (!controller.signal.aborted && version === revision.current) { setError(catalogErrorMessage(err, '本次读取未完成，稍后重试；已入库资料会保留。')); retryAfter.current = Date.now() + 10000; }
        } finally {
            if (life.current === controller) advancing.current = false;
            if (!controller.signal.aborted && life.current === controller) setTick(value => value + 1);
        }
    }, []);

    const accept = useCallback((next: CatalogStatus) => {
        revision.current += 1;
        setStatus(next); setError(''); retryAfter.current = 0;
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        life.current = controller;
        reading.current = false; advancing.current = false; commanding.current = false;
        const onVisibility = () => setVisible(document.visibilityState === 'visible');
        onVisibility();
        document.addEventListener('visibilitychange', onVisibility);
        void refresh();
        return () => { revision.current += 1; controller.abort(); document.removeEventListener('visibilitychange', onVisibility); };
    }, [ownerId, refresh]);

    useEffect(() => {
        if (!follow || !visible || loading) return;
        const next = catalogNextPoll(status);
        const timer = window.setTimeout(() => {
            if (document.visibilityState !== 'visible') return;
            void (next.action === 'advance' ? advance() : refresh());
        }, Math.min(2147483647, Math.max(next.delay, retryAfter.current - Date.now())));
        return () => window.clearTimeout(timer);
    }, [follow, visible, loading, status, tick, advance, refresh]);

    return { status, loading, error, busy, refresh, command, accept };
}

export function useCatalogItems(ownerId: string, sourceKey: string, query: string, cursor: string, revision: string) {
    const key = JSON.stringify([ownerId, sourceKey, query, cursor]);
    const [result, setResult] = useState<{ key: string; requestKey: string; value: CatalogItems } | null>(null);
    const [failure, setFailure] = useState<{ requestKey: string; message: string } | null>(null);
    const [refreshToken, setRefreshToken] = useState(0);
    const requestKey = JSON.stringify([key, revision, refreshToken]);
    const sequence = useRef(0);
    useEffect(() => {
        const controller = new AbortController();
        const request = ++sequence.current;
        const params = new URLSearchParams({ q: query, limit: '50' });
        if (cursor) params.set('cursor', cursor);
        void platformRequest<CatalogItems>(`/catalog/items?${params}`, { signal: controller.signal }).then(next => {
            if (!controller.signal.aborted && request === sequence.current) setResult({ key, requestKey, value: next });
        }).catch(err => {
            if (!controller.signal.aborted && request === sequence.current) setFailure({ requestKey, message: catalogErrorMessage(err, '剧目资料读取失败，请重试。') });
        });
        return () => controller.abort();
    }, [key, query, cursor, requestKey]);
    // Retain rows during a same-query background update, never across accounts, searches or pages.
    const data = result?.key === key ? result.value : null;
    return { data, loading: result?.requestKey !== requestKey && failure?.requestKey !== requestKey, error: failure?.requestKey === requestKey ? failure.message : '', refresh: () => setRefreshToken(value => value + 1) };
}
