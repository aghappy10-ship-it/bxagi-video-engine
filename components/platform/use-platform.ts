'use client';
import { useCallback, useEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { platformRequest, post } from './api';
import { createPlatformClientState } from './client-state.mjs';
import { subscribeClientSessionChange } from './client-session-events.mjs';
import { EMPTY, type Bootstrap } from './types';

type Snapshot = { data: Bootstrap; loading: boolean; busy: string; error: string; notice: string; requiresLogin: boolean; bxagiLoginOpen: boolean };
export function usePlatform() {
    const storeRef = useRef<ReturnType<typeof createPlatformClientState> | null>(null);
    if (!storeRef.current) storeRef.current = createPlatformClientState({ empty: EMPTY, request: platformRequest, post });
    const store = storeRef.current;
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot) as Snapshot;
    useEffect(() => {
        const unsubscribe = subscribeClientSessionChange(store.sessionChanged);
        store.connect();
        return () => { unsubscribe(); store.disconnect(); };
    }, [store]);
    const refresh = useCallback((): Promise<Bootstrap> => store.refresh(), [store]);
    const run = useCallback(<T,>(key: string, action: () => Promise<T>, message?: string): Promise<T | undefined> => store.run(key, action, message), [store]);
    return { ...snapshot, refresh, run,
        setError: store.setError as Dispatch<SetStateAction<string>>,
        setNotice: store.setNotice as Dispatch<SetStateAction<string>>,
        openBxagiLogin: store.openBxagiLogin, closeBxagiLogin: store.closeBxagiLogin,
        logoutBxagi: store.logoutBxagi, advanceAutomation: store.advanceAutomation };
}
export type PlatformState = ReturnType<typeof usePlatform>;
