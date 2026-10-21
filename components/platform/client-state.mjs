import { isBxagiSessionRequired, normalizeSessionBootstrap, clearSessionData } from './auth-state.mjs';

const failureMessage = (reason, fallback) => {
  const message = typeof reason?.message === 'string' && reason.message ? reason.message : fallback;
  const reasons = Array.isArray(reason?.reasons) ? reason.reasons.filter(item => typeof item === 'string' && item) : [];
  return [message, ...reasons].join('；');
};

/** Keep request ordering independent of rendering. Every result is checked
 * against the identity and operation that originally requested it. */
export function createPlatformClientState({ empty, request, post }) {
  let snapshot = { data: empty, loading: true, busy: '', error: '', notice: '', requiresLogin: true, bxagiLoginOpen: false };
  let active = true, epoch = 0, readVersion = 0, readFlight = null, operation = null, automation = null;
  const listeners = new Set();
  const publish = patch => {
    if (!active) return;
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const invalidateRead = () => { readVersion++; readFlight?.controller.abort(); readFlight = null; };
  const invalidateSession = () => { epoch++; invalidateRead(); operation = null; automation = null; };
  const current = ticket => active && ticket.epoch === epoch;
  const currentOperation = ticket => current(ticket) && operation === ticket;
  function resetSession({ preserveDialog = false } = {}) {
    invalidateSession();
    publish({ data: clearSessionData(empty), requiresLogin: true, busy: '', loading: false, notice: '', bxagiLoginOpen: preserveDialog && snapshot.bxagiLoginOpen });
  }
  function sessionChanged() {
    resetSession({ preserveDialog: true });
    publish({ error: '' });
  }
  function refresh({ fresh = false } = {}) {
    if (!active) return Promise.resolve(empty);
    if (operation?.key === 'bxagi-logout') return Promise.resolve(empty);
    if (readFlight && !fresh) return readFlight.promise;
    if (fresh) invalidateRead();
    const ticket = { epoch, version: ++readVersion, controller: new AbortController(), promise: null };
    const isCurrentRead = () => current(ticket) && ticket.version === readVersion;
    readFlight = ticket;
    ticket.promise = (async () => {
      try {
        const response = await request('/bootstrap', { signal: ticket.controller.signal });
        if (!isCurrentRead()) return empty;
        const normalized = normalizeSessionBootstrap(response, empty);
        if (!normalized.authenticated) { resetSession(); return empty; }
        const previousOwner = snapshot.data.user?.id;
        const changedOwner = previousOwner && previousOwner !== normalized.data.user.id;
        if (changedOwner) invalidateSession();
        publish({ data: normalized.data, requiresLogin: false, ...(changedOwner ? { busy: '', error: '', notice: '', loading: false } : {}) });
        return normalized.data;
      } catch (reason) {
        if (!isCurrentRead()) return empty;
        if (isBxagiSessionRequired(reason)) { resetSession(); return empty; }
        throw reason;
      } finally {
        if (readFlight === ticket) { readFlight = null; publish({ loading: false }); }
      }
    })();
    return ticket.promise;
  }
  async function run(key, action, message) {
    // React state alone cannot guard two clicks within the same render frame.
    if (!active || operation) return undefined;
    if (snapshot.requiresLogin) { publish({ bxagiLoginOpen: true }); return undefined; }
    const ticket = { epoch, key };
    operation = ticket;
    publish({ busy: key, error: '', notice: '' });
    try {
      // Finish an already-started tick before a user mutation. The operation
      // guard prevents another tick from entering while this one is awaited.
      if (automation) await automation.promise;
      if (!currentOperation(ticket)) return undefined;
      invalidateRead();
      let result;
      try { result = await action(); }
      catch (reason) {
        if (!currentOperation(ticket)) return undefined;
        const error = failureMessage(reason, '操作未完成，请检查当前状态。');
        if (isBxagiSessionRequired(reason)) { resetSession(); publish({ error }); }
        else { publish({ error }); await refresh({ fresh: true }).catch(() => {}); }
        return undefined;
      }
      if (!currentOperation(ticket)) return undefined;
      try { await refresh({ fresh: true }); }
      catch { if (currentOperation(ticket)) publish({ error: '操作已返回成功，但工作区状态暂未更新，请刷新确认。' }); }
      if (!currentOperation(ticket)) return undefined;
      if (message) publish({ notice: message });
      // A failed follow-up read must not invite repeating a successful write.
      return result;
    } finally {
      if (currentOperation(ticket)) { operation = null; publish({ busy: '' }); }
    }
  }
  async function advanceAutomation() {
    if (!active || automation || operation || snapshot.requiresLogin || !snapshot.data.bxagi.connected) return undefined;
    const ticket = { epoch, promise: null };
    automation = ticket;
    ticket.promise = (async () => {
      try {
        const result = await post('/automation/tick', {});
        if (!current(ticket) || automation !== ticket) return undefined;
        await refresh({ fresh: true });
        return current(ticket) && automation === ticket ? result : undefined;
      } catch (reason) {
        if (!current(ticket) || automation !== ticket) return undefined;
        if (isBxagiSessionRequired(reason)) resetSession();
        else publish({ error: failureMessage(reason, '自动工作流暂未推进，系统将保留现有任务。') });
        return undefined;
      } finally { if (automation === ticket) automation = null; }
    })();
    return ticket.promise;
  }
  async function logoutBxagi() {
    if (!active || operation?.key === 'bxagi-logout') return;
    // Old reads and action callbacks become stale before logout is sent.
    resetSession();
    const ticket = { epoch, key: 'bxagi-logout' };
    operation = ticket; publish({ busy: ticket.key, error: '' });
    try {
      const response = await post('/bxagi/auth/logout', {});
      if (!currentOperation(ticket)) return;
      if (response.connected !== false) throw new Error('退出状态尚未确认，请重试。');
      resetSession();
    } catch (reason) {
      if (!currentOperation(ticket)) return;
      const error = failureMessage(reason, '退出未完成，请稍后重试。');
      operation = null; publish({ busy: '' });
      await refresh({ fresh: true }).catch(() => {});
      if (current(ticket)) publish({ error });
    } finally { if (currentOperation(ticket)) { operation = null; publish({ busy: '' }); } }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    connect() { active = true; const started = epoch; void refresh().catch(reason => { if (active && epoch === started) publish({ error: failureMessage(reason, '工作区暂不可用，请稍后重试。') }); }); },
    disconnect() { active = false; invalidateSession(); snapshot = { ...snapshot, busy: '' }; },
    refresh, run, advanceAutomation, logoutBxagi, sessionChanged,
    setError(value) { publish({ error: typeof value === 'function' ? value(snapshot.error) : value }); },
    setNotice(value) { publish({ notice: typeof value === 'function' ? value(snapshot.notice) : value }); },
    openBxagiLogin() { publish({ bxagiLoginOpen: true }); },
    closeBxagiLogin() { publish({ bxagiLoginOpen: false }); },
  };
}
