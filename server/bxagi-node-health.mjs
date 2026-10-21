import { BXAGI_ORIGIN, BxagiProtocolError } from './bxagi-workforce.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,160}$/.test(value);
const statuses = new Set(['online', 'busy', 'offline', 'unknown']);
const errors = new Set(['bxagi_nodes_timeout', 'bxagi_nodes_unavailable', 'bxagi_nodes_unauthorized', 'bxagi_nodes_refused', 'bxagi_nodes_invalid_response', 'bxagi_nodes_redirect_refused']);
const fail = code => { throw new BxagiProtocolError(code, 'BXAGI 节点状态暂无法核实', code === 'bxagi_nodes_unauthorized' ? 401 : 502); };
function iso(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const [,year,month,day,hour,minute,second,offsetHour = '00',offsetMinute = '00'] = match;
  const y = Number(year), m = Number(month), d = Number(day), leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  if (m < 1 || m > 12 || d < 1 || d > days[m-1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour) > 23 || Number(offsetMinute) > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
const safeNodeId = (value, token = '') => identifier(value) && (!token || !value.includes(token)) && !/(?:token|password|secret|credential|api[_-]?key|^sk[_-]|^sess[_-])/i.test(value);
export const BXAGI_NODE_HEALTH_HISTORY_LIMIT = 64;

function heartbeat(value, now, missing = false) {
  const at = iso(value);
  if (!at) return { lastHeartbeatAt: null, heartbeatAgeSeconds: null, heartbeatState: missing ? 'unknown' : 'invalid' };
  const elapsed = now - Date.parse(at);
  return { lastHeartbeatAt: at, heartbeatAgeSeconds: elapsed >= 0 ? Math.floor(elapsed / 1000) : null, heartbeatState: elapsed < -60000 ? 'future' : elapsed > 120000 ? 'stale' : 'fresh' };
}

/** A projection, never a raw node record. The URL is used only as a cloud gateway hint. */
export function projectBxagiNodes(rows, { now = Date.now(), token = '' } = {}) {
  if (!Array.isArray(rows) || rows.length > 1000 || !Number.isFinite(now)) fail('bxagi_nodes_invalid_response');
  const seen = new Set();
  return rows.map(row => {
    if (!object(row) || !safeNodeId(row.node_id, token) || seen.has(row.node_id)) fail('bxagi_nodes_invalid_response');
    seen.add(row.node_id);
    let cloudGateway = null;
    if (typeof row.node_url === 'string' && row.node_url.length <= 4096) {
      try { const url = new URL(row.node_url); if (['https:', 'wss:', 'http:', 'ws:'].includes(url.protocol)) cloudGateway = `${url.hostname}${url.pathname}`.includes('gateway-ws'); } catch { /* Unknown is not proof of a local node. */ }
    }
    return {
      nodeId: row.node_id,
      status: statuses.has(row.status) ? row.status : 'unknown',
      gatewayConnected: typeof row.gateway_connected === 'boolean' ? row.gateway_connected : null,
      ...heartbeat(row.last_heartbeat_at, now, row.last_heartbeat_at == null),
      idleTimeoutMinutes: Number.isInteger(row.idle_timeout_minutes) && row.idle_timeout_minutes >= 0 && row.idle_timeout_minutes <= 525600 ? row.idle_timeout_minutes : null,
      cloudGateway,
    };
  }).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

// Re-project on persistence and on read: callers cannot store arbitrary upstream
// fields or leak credentials by placing them in a history record.
export function sanitizeBxagiNodeObservation(value) {
  if (!object(value) || !iso(value.checkedAt) || !['verified', 'unavailable'].includes(value.observationStatus)) fail('bxagi_nodes_invalid_response');
  const base = { checkedAt: iso(value.checkedAt), observationStatus: value.observationStatus };
  if (value.observationStatus === 'unavailable') return { ...base, errorCode: errors.has(value.errorCode) ? value.errorCode : 'bxagi_nodes_unavailable' };
  if (!Array.isArray(value.nodes)) fail('bxagi_nodes_invalid_response');
  const nodes = projectBxagiNodes(value.nodes.map(row => ({
    node_id: row?.nodeId, status: row?.status, gateway_connected: row?.gatewayConnected,
    last_heartbeat_at: row?.lastHeartbeatAt, idle_timeout_minutes: row?.idleTimeoutMinutes,
  })), { now: Date.parse(base.checkedAt) });
  const originals = new Map(value.nodes.map(row => [row?.nodeId, row]));
  for (let i = 0; i < nodes.length; i++) {
    const original = originals.get(nodes[i].nodeId);
    nodes[i].cloudGateway = typeof original?.cloudGateway === 'boolean' ? original.cloudGateway : null;
    if (original?.lastHeartbeatAt == null && original?.heartbeatState === 'invalid') nodes[i].heartbeatState = 'invalid';
  }
  return { ...base, nodes };
}

const stateOf = node => node ? { status: node.status, gatewayConnected: node.gatewayConnected, heartbeatState: node.heartbeatState, idleTimeoutMinutes: node.idleTimeoutMinutes, cloudGateway: node.cloudGateway } : null;
const safeHistory = rows => (Array.isArray(rows) ? rows : []).slice(-BXAGI_NODE_HEALTH_HISTORY_LIMIT).flatMap(row => {
  if (!object(row) || !iso(row.at)) return [];
  if (row.kind === 'inspection') {
    if (![null, 'verified', 'unavailable'].includes(row.from) || !['verified', 'unavailable'].includes(row.to)) return [];
    return [{ at: iso(row.at), kind: 'inspection', from: row.from, to: row.to, ...(row.to === 'unavailable' ? { errorCode: errors.has(row.errorCode) ? row.errorCode : 'bxagi_nodes_unavailable' } : {}) }];
  }
  const state = value => {
    if (value === null) return null;
    if (!object(value) || !statuses.has(value.status)) return undefined;
    return { status: value.status, gatewayConnected: typeof value.gatewayConnected === 'boolean' ? value.gatewayConnected : null, heartbeatState: ['unknown','invalid','fresh','stale','future'].includes(value.heartbeatState) ? value.heartbeatState : 'unknown', idleTimeoutMinutes: Number.isInteger(value.idleTimeoutMinutes) && value.idleTimeoutMinutes >= 0 && value.idleTimeoutMinutes <= 525600 ? value.idleTimeoutMinutes : null, cloudGateway: typeof value.cloudGateway === 'boolean' ? value.cloudGateway : null };
  };
  if (row.kind !== 'node' || !safeNodeId(row.nodeId)) return [];
  const from = state(row.from), to = state(row.to);
  return from === undefined || to === undefined ? [] : [{ at: iso(row.at), kind: 'node', nodeId: row.nodeId, from, to }];
});

/** Pure bounded journal merge used inside the repository's optimistic lock. */
export function mergeBxagiNodeHealth(previous, observation, subject) {
  if (!identifier(subject)) fail('bxagi_nodes_invalid_response');
  const current = sanitizeBxagiNodeObservation(observation);
  const prior = previous?.kind === 'node_health' && previous?.bxagiSubject === subject ? previous : null;
  let lastObservation = null, lastSuccess = null;
  try { if (prior?.observation) lastObservation = sanitizeBxagiNodeObservation(prior.observation); } catch { /* Invalid stored evidence is discarded. */ }
  try { if (prior?.lastSuccess?.observationStatus === 'verified') lastSuccess = sanitizeBxagiNodeObservation(prior.lastSuccess); } catch { /* Invalid stored evidence is discarded. */ }
  if (lastObservation && current.checkedAt < lastObservation.checkedAt) return null;
  const history = safeHistory(prior?.history);
  if (lastObservation?.observationStatus !== current.observationStatus || current.observationStatus === 'unavailable' && lastObservation?.errorCode !== current.errorCode) history.push({ at: current.checkedAt, kind: 'inspection', from: lastObservation?.observationStatus ?? null, to: current.observationStatus, ...(current.errorCode ? { errorCode: current.errorCode } : {}) });
  if (current.observationStatus === 'verified') {
    const before = new Map((lastSuccess?.nodes || []).map(node => [node.nodeId, node]));
    const after = new Map(current.nodes.map(node => [node.nodeId, node]));
    for (const nodeId of new Set([...before.keys(), ...after.keys()])) {
      const from = stateOf(before.get(nodeId)), to = stateOf(after.get(nodeId));
      if (JSON.stringify(from) !== JSON.stringify(to)) history.push({ at: current.checkedAt, kind: 'node', nodeId, from, to });
    }
    lastSuccess = current;
  }
  return { provider: 'bxagi', kind: 'node_health', bxagiSubject: subject, revision: Math.max(0, Number.isSafeInteger(prior?.revision) ? prior.revision : 0) + 1, observation: current, lastSuccess, history: history.slice(-BXAGI_NODE_HEALTH_HISTORY_LIMIT) };
}

export function createBxagiNodeHealth({ repository, context, fetcher = fetch, timeoutMs = 5000, now = Date.now } = {}) {
  const userId = context?.userId || context?.nativeUserId, subject = context?.subject, token = context?.accessToken;
  if (!identifier(userId) || !identifier(subject) || typeof token !== 'string' || !token || token.length > 32000 || /[\x00-\x20\x7f]/.test(token)) fail('bxagi_nodes_unauthorized');
  const timeout = Math.min(10000, Math.max(100, Number(timeoutMs) || 5000));
  async function readNodes() {
    const controller = new AbortController(); let timer, reader;
    const read = async () => {
      const response = await fetcher(`${BXAGI_ORIGIN}/api/nodes`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, redirect: 'manual', signal: controller.signal });
      if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== BXAGI_ORIGIN) { await response.body?.cancel().catch(() => {}); fail('bxagi_nodes_redirect_refused'); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); fail([401,403].includes(response.status) ? 'bxagi_nodes_unauthorized' : response.status >= 500 ? 'bxagi_nodes_unavailable' : 'bxagi_nodes_refused'); }
      const maxBytes = 1024 * 1024, length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body?.cancel().catch(() => {}); fail('bxagi_nodes_invalid_response'); }
      const chunks = []; let size = 0;
      reader = response.body?.getReader();
      if (reader) while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maxBytes) fail('bxagi_nodes_invalid_response'); chunks.push(part.value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let raw; try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('bxagi_nodes_invalid_response'); }
      if (!object(raw)) fail('bxagi_nodes_invalid_response');
      return projectBxagiNodes(raw.nodes, { now: now(), token });
    };
    try { return await Promise.race([read(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); void reader?.cancel().catch(() => {}); reject(new BxagiProtocolError('bxagi_nodes_timeout', 'BXAGI 节点检查超时', 502)); }, timeout); })]); }
    finally { clearTimeout(timer); controller.abort(); void reader?.cancel().catch(() => {}); }
  }
  return Object.freeze({
    async inspect() {
      let observation;
      try { const nodes = await readNodes(); observation = { checkedAt: new Date(now()).toISOString(), observationStatus: 'verified', nodes }; }
      catch (error) { observation = { checkedAt: new Date(now()).toISOString(), observationStatus: 'unavailable', errorCode: errors.has(error?.code) ? error.code : 'bxagi_nodes_unavailable' }; }
      let saved, persistenceStatus = 'unavailable';
      try { if (typeof repository?.recordBxagiNodeHealth === 'function') { saved = await repository.recordBxagiNodeHealth(userId, subject, observation); persistenceStatus = saved ? 'saved' : 'unavailable'; } } catch { /* Availability evidence remains useful if local diagnostics storage fails. */ }
      if (!saved) try { saved = await repository?.getBxagiNodeHealth?.(userId, subject); } catch { /* Do not turn a storage error into a node outage. */ }
      const valid = saved?.userId === userId && saved?.type === 'bxagi_node_health' && saved?.details?.bxagiSubject === subject;
      let details = mergeBxagiNodeHealth(valid ? saved.details : null, observation, subject);
      if (!details && valid) {
        let lastSuccess = null;
        try { if (saved.details?.lastSuccess?.observationStatus === 'verified') lastSuccess = sanitizeBxagiNodeObservation(saved.details.lastSuccess); } catch { /* Never return raw stored rows. */ }
        details = { lastSuccess, history: safeHistory(saved.details?.history) };
      }
      const recent = details?.lastSuccess, fresh = observation.observationStatus === 'verified';
      const nodes = (fresh ? observation.nodes : recent?.nodes || []).map(node => ({ ...node, ...(!fresh && node.lastHeartbeatAt ? heartbeat(node.lastHeartbeatAt, now()) : {}), stale: !fresh }));
      const statusCounts = { online: 0, busy: 0, offline: 0, unknown: 0 };
      for (const node of nodes) statusCounts[node.status]++;
      return { provider: 'bxagi', checkedAt: observation.checkedAt, observationStatus: observation.observationStatus, liveVerified: fresh, readOnly: true, persistenceStatus, lastSuccessfulAt: fresh ? observation.checkedAt : recent?.checkedAt || null, nodeCount: nodes.length, statusCounts, nodes, history: safeHistory(details?.history), ...(observation.errorCode ? { errorCode: observation.errorCode } : {}) };
    },
  });
}
