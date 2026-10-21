const listeners = new Set();

/** Session boundaries carry no identity or credential data. */
export function subscribeClientSessionChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('Session listener must be a function');
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function notifyClientSessionChange() {
    for (const listener of [...listeners]) {
        // A UI subscriber cannot turn an acknowledged login/logout into a failure.
        try { listener(); } catch { /* Other subscribers still receive the boundary. */ }
    }
}
