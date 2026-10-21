'use client';
import type { Screen } from './types';
import type { PlatformState } from './use-platform';
/** Feedback routing belongs to the durable automatic workflow, on every page. */
export function useAutomaticOptimization(state: PlatformState, _screen: Screen) {
    return { retryOptimization: () => { if (state.requiresLogin) {
            state.openBxagiLogin();
            return;
        } void state.advanceAutomation(); } };
}
