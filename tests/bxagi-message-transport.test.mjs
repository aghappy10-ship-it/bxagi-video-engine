import test from 'node:test';
import assert from 'node:assert/strict';
import { createBxagiMessageTransport, isMatchingBxagiUserMessage } from '../server/bxagi-message-transport.mjs';

const secret = 'message-transport-fixture-token';
const conversationId = '8b5d965a-71f8-4b9a-bb07-0cedfce8a5b5';
const anotherConversationId = '2b1a2bf2-b045-4545-a8cb-011f82e9119c';
const prompt = '原素材已上传。请按素材清单优化并交付真实文件。';
const freshTimestamp = () => new Date(Date.now() + 1000).toISOString();
const echo = (patch = {}) => ({
  id: 'actual-user-event', timestamp: freshTimestamp(), source: 'user', kind: 'MessageEvent',
  conversation_id: conversationId,
  llm_message: { role: 'user', content: [{ type: 'text', text: prompt }] }, ...patch,
});

class FakeSocket {
  constructor({ readyState = 1, stateAfterAccept = 1, onAccept, onSend } = {}) {
    this.readyState = readyState;
    this.stateAfterAccept = stateAfterAccept;
    this.onAccept = onAccept;
    this.onSend = onSend;
    this.listeners = new Map();
    this.sent = [];
    this.accepts = 0;
    this.closes = 0;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  accept() {
    for (const type of ['message', 'close', 'error']) assert.ok(this.listeners.get(type)?.size, `${type} listener must exist before accept`);
    this.accepts++;
    this.readyState = this.stateAfterAccept;
    this.onAccept?.(this);
  }
  send(data) {
    assert.equal(this.readyState, 1);
    for (const type of ['message', 'close', 'error']) assert.ok(this.listeners.get(type)?.size, `${type} listener must exist before send`);
    this.sent.push(data);
    this.onSend?.(this, data);
  }
  close() { this.closes++; this.readyState = 3; }
  emit(type, event = {}) { for (const listener of [...(this.listeners.get(type) || [])]) listener(event); }
  frame(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }); }
}

function fixture({ socketOptions = {}, response, handshakeError, serverDate, timeoutMs = 100 } = {}) {
  const socket = new FakeSocket({ onSend: ws => ws.frame(echo()), ...socketOptions });
  const calls = [];
  const api = createBxagiMessageTransport({ accessToken: secret, timeoutMs, fetcher: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (handshakeError) throw handshakeError;
    return response || { status: 101, webSocket: socket, headers: new Headers({ Date: serverDate || new Date().toUTCString() }), redirected: false, url };
  } });
  return { api, socket, calls, async send(options = {}) { return api.send({ conversationId, prompt, ...options }); } };
}

const safeError = (error, uncertain) => {
  assert.ok(error instanceof Error);
  assert.equal(error.uncertain, uncertain);
  assert.equal(typeof error.code, 'string');
  assert.ok(!error.message.includes(secret));
  assert.ok(!error.message.includes('external.invalid'));
  return true;
};

test('Cloudflare handshake uses the fixed socket endpoint and protocol header and sends exactly once', async () => {
  const f = fixture();
  const result = await f.send();
  assert.deepEqual(result, { transport: 'bxagi_ws', transportStatus: 101, messageAcknowledged: true, eventId: 'actual-user-event', liveVerified: false, deliveryEvidence: 'matching_user_event', freshEchoVerified: false });
  assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0];
  assert.equal(url.origin, 'https://bxagi.xinlx.com');
  assert.equal(url.pathname, `/sockets/events/${conversationId}`);
  assert.deepEqual([...url.searchParams], [['resend_all', 'true'], ['resend_limit', '100'], ['resend_sort_order', 'TIMESTAMP_DESC']]);
  assert.ok(!url.href.includes(secret));
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'manual');
  const headers = new Headers(options.headers);
  assert.equal(headers.get('Upgrade'), 'websocket');
  assert.equal(headers.get('Sec-WebSocket-Protocol'), `bxc-jwt-${secret}`);
  assert.equal(headers.get('Authorization'), null);
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(f.socket.accepts, 1);
  assert.equal(f.socket.sent.length, 1);
  assert.deepEqual(JSON.parse(f.socket.sent[0]), { role: 'user', content: [{ type: 'text', text: prompt }] });
});

test('history received during accept cannot acknowledge a message that has not been sent', async () => {
  const f = fixture({ socketOptions: {
    onAccept: ws => ws.frame(echo({ id: 'history-before-send' })),
    onSend: ws => ws.frame(echo({ id: 'echo-after-send' })),
  } });
  assert.equal((await f.send()).eventId, 'echo-after-send');
  assert.equal(f.socket.sent.length, 1);
});

test('baseline events, stale timestamps, agent events, and different conversations cannot acknowledge the request', async () => {
  const minimumTimestamp = new Date(Date.now()).toISOString();
  const f = fixture({ socketOptions: { onSend: ws => {
    ws.frame(echo({ id: 'baseline-event' }));
    ws.frame(echo({ id: 'old-history', timestamp: '2000-01-01T00:00:00.000Z' }));
    ws.frame(echo({ id: 'agent-message', source: 'agent', llm_message: { role: 'assistant', content: [{ type: 'text', text: prompt }] } }));
    ws.frame({ id: 'state-event', timestamp: freshTimestamp(), kind: 'AgentStateChangedEvent', source: 'agent', state: 'running' });
    ws.frame(echo({ id: 'wrong-conversation', conversation_id: anotherConversationId }));
    ws.frame(echo({ id: 'wrong-prompt', llm_message: { role: 'user', content: [{ type: 'text', text: `${prompt} 已经完成` }] } }));
    ws.frame(echo({ id: 'accepted-echo' }));
  } } });
  assert.equal((await f.send({ knownEventIds: ['baseline-event'], minimumTimestamp })).eventId, 'accepted-echo');
  assert.equal(f.socket.sent.length, 1);
});

test('an echoed user message without conversation_id is accepted only with valid id, timestamp, and exact text', async () => {
  const f = fixture({ socketOptions: { onSend: ws => {
    ws.frame(echo({ id: '', conversation_id: undefined }));
    ws.frame(echo({ id: 'invalid-time', timestamp: 'not-an-ISO-date', conversation_id: undefined }));
    ws.frame(echo({ id: 'extra-content', conversation_id: undefined, llm_message: { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'text', text: 'unrelated' }] } }));
    ws.frame(echo({ id: 'echo-without-conversation', conversation_id: undefined }));
  } } });
  assert.equal((await f.send()).eventId, 'echo-without-conversation');
});

test('the acknowledgement threshold follows the server clock rather than an unrelated local clock', async () => {
  const f = fixture({ serverDate: 'Sat, 01 Jan 2000 00:00:00 GMT', socketOptions: { onSend: ws => {
    ws.frame(echo({ id: 'older-than-handshake', timestamp: '1999-12-31T23:59:58.000Z' }));
    ws.frame(echo({ id: 'server-clock-echo', timestamp: '2000-01-01T00:00:00.500Z' }));
  } } });
  assert.equal((await f.send()).eventId, 'server-clock-echo');
  assert.equal(f.socket.sent.length, 1);
});

test('an unknown exact history event predating server Date is rejected even when queued after send', async () => {
  const f = fixture({ serverDate: 'Sat, 01 Jan 2000 00:00:00 GMT', socketOptions: { onSend: ws => {
    const oldEvent = echo({ id: 'unknown-replay-after-send', timestamp: '1999-12-31T23:59:59.500Z' });
    queueMicrotask(() => {
      ws.frame(oldEvent);
      ws.frame(echo({ id: 'fresh-echo-after-replay', timestamp: '2000-01-01T00:00:01.000Z' }));
    });
  } } });
  assert.equal((await f.send()).eventId, 'fresh-echo-after-replay');
  assert.equal(f.socket.sent.length, 1);
  assert.equal(f.calls.length, 1);
});

test('an exact event within the handshake second is labelled matching evidence without claiming a fresh echo', async () => {
  const f = fixture({ serverDate: 'Sat, 01 Jan 2000 00:00:00 GMT', socketOptions: { onSend: ws => {
    queueMicrotask(() => ws.frame(echo({ id: 'same-second-exact-event', timestamp: '2000-01-01T00:00:00.900Z' })));
  } } });
  const result = await f.send();
  assert.equal(result.eventId, 'same-second-exact-event');
  assert.equal(result.messageAcknowledged, true);
  assert.equal(result.deliveryEvidence, 'matching_user_event');
  assert.equal(result.freshEchoVerified, false);
  assert.equal(f.socket.sent.length, 1);
});

test('a connecting socket waits for open before sending and accepts the synchronous echo', async () => {
  const f = fixture({ socketOptions: { readyState: 0, stateAfterAccept: 0, onAccept: ws => queueMicrotask(() => { ws.readyState = 1; ws.emit('open'); }) } });
  assert.equal((await f.send()).messageAcknowledged, true);
  assert.equal(f.socket.sent.length, 1);
});

test('handshake redirects are cancelled and never forwarded or retried', async () => {
  for (const status of [301, 302, 307, 308]) {
    let cancelled = 0;
    const f = fixture({ response: { status, redirected: false, headers: new Headers({ Location: 'https://external.invalid/target' }), body: { async cancel() { cancelled++; } } } });
    await assert.rejects(f.send(), error => safeError(error, false));
    assert.equal(cancelled, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.socket.sent.length, 0);
  }
});

test('failed upgrades and pre-open socket failures remain known unsent and expose no remote error detail', async () => {
  for (const config of [
    { handshakeError: new Error(`network ${secret} https://external.invalid`) },
    { response: { status: 403, headers: new Headers(), body: { async cancel() {} } } },
    { response: { status: 101, headers: new Headers() } },
    { socketOptions: { readyState: 0, stateAfterAccept: 0, onAccept: ws => ws.emit('close', { reason: `closed ${secret}` }) } },
    { socketOptions: { readyState: 0, stateAfterAccept: 0, onAccept: ws => ws.emit('error', { message: `failed ${secret}` }) } },
  ]) {
    const f = fixture(config);
    await assert.rejects(f.send(), error => safeError(error, false));
    assert.equal(f.calls.length, 1);
    assert.equal(f.socket.sent.length, 0);
  }
});

test('post-send close, error, timeout, and throwing send remain uncertain and cannot trigger resends', async () => {
  for (const onSend of [
    ws => ws.emit('close', { reason: `private close ${secret}` }),
    ws => ws.emit('error', { message: `private failure ${secret}` }),
    () => {},
    () => { throw new Error(`send failed ${secret}`); },
  ]) {
    const f = fixture({ socketOptions: { onSend } });
    await assert.rejects(f.send(), error => safeError(error, true));
    assert.equal(f.calls.length, 1);
    assert.equal(f.socket.sent.length, 1);
  }
});

test('malformed or oversized message frames fail boundedly after one send', async () => {
  for (const onSend of [
    ws => ws.frame(`not-json ${secret}`),
    ws => ws.frame('x'.repeat(1024 * 1024 + 1)),
    ws => { const frame = JSON.stringify({ kind: 'AgentStateChangedEvent', padding: 'x'.repeat(900 * 1024) }); for (let count = 0; count < 5; count++) ws.frame(frame); },
    ws => { for (let count = 0; count < 1001; count++) ws.frame({ kind: 'AgentStateChangedEvent', state: 'running' }); },
  ]) {
    const f = fixture({ socketOptions: { onSend } });
    await assert.rejects(f.send(), error => safeError(error, true));
    assert.equal(f.calls.length, 1);
    assert.equal(f.socket.sent.length, 1);
  }
});

test('invalid conversation identifiers and prompts exceeding the byte limit fail before any handshake', async () => {
  const f = fixture();
  await assert.rejects(f.api.send({ conversationId: '../different', prompt }), error => safeError(error, false));
  await assert.rejects(f.api.send({ conversationId, prompt: '界'.repeat(90 * 1024) }), error => safeError(error, false));
  assert.equal(f.calls.length, 0);
  assert.equal(f.socket.sent.length, 0);
});

test('the echo matcher accepts the two observed text formats and rejects unrelated or malformed events', () => {
  assert.equal(isMatchingBxagiUserMessage(echo(), prompt, { conversationId }), true);
  assert.equal(isMatchingBxagiUserMessage(echo({ llm_message: { role: 'user', content: prompt } }), prompt, { conversationId }), true);
  for (const event of [
    echo({ id: '' }),
    echo({ timestamp: 'not-a-date' }),
    echo({ source: 'agent' }),
    echo({ kind: 'AgentStateChangedEvent' }),
    echo({ conversation_id: anotherConversationId }),
    echo({ conversation_id: 'malformed-identifier' }),
    echo({ llm_message: { role: 'assistant', content: prompt } }),
    echo({ llm_message: { role: 'user', content: `${prompt} extra` } }),
    echo({ llm_message: { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'text', text: 'extra' }] } }),
  ]) assert.equal(isMatchingBxagiUserMessage(event, prompt, { conversationId }), false);
});

test('workerd executes the actual transport against a local WebSocketPair provider without external traffic', { timeout: 30000 }, async () => {
  const [{ build }, { Miniflare }, { fileURLToPath }] = await Promise.all([import('esbuild'), import('miniflare'), import('node:url')]);
  const root = fileURLToPath(new URL('../', import.meta.url));
  const bundle = await build({ stdin: {
    contents: `import { createBxagiMessageTransport } from './server/bxagi-message-transport.mjs';
      export default { async fetch() {
        try {
          const transport = createBxagiMessageTransport({ accessToken: ${JSON.stringify(secret)}, timeoutMs: 5000 });
          return Response.json(await transport.send({ conversationId: ${JSON.stringify(conversationId)}, prompt: ${JSON.stringify(prompt)} }));
        } catch (error) { return Response.json({ code: error.code, uncertain: error.uncertain, message: error.message }, { status: 502 }); }
      } };`,
    resolveDir: root, sourcefile: 'message-transport-workerd-fixture.mjs',
  }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022', logLevel: 'silent' });
  const provider = `export default { async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== 'https://bxagi.xinlx.com' || url.pathname !== '/sockets/events/${conversationId}' ||
        url.searchParams.get('resend_all') !== 'true' || url.searchParams.get('resend_limit') !== '100' ||
        url.searchParams.get('resend_sort_order') !== 'TIMESTAMP_DESC' ||
        request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
        request.headers.get('Sec-WebSocket-Protocol') !== ${JSON.stringify(`bxc-jwt-${secret}`)} ||
        request.headers.has('Authorization')) return new Response('fixture handshake rejected', { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      server.send(JSON.stringify({ id: 'workerd-user-event', source: 'user', kind: 'MessageEvent',
        timestamp: new Date(Date.now() + 1000).toISOString(), conversation_id: ${JSON.stringify(conversationId)}, llm_message: message }));
    });
    server.accept();
    return new Response(null, { status: 101, webSocket: client, headers: { Date: new Date().toUTCString() } });
  } };`;
  const mf = new Miniflare({ workers: [
    { name: 'transport-caller', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'], outboundService: 'fixture-provider' },
    { name: 'fixture-provider', modules: true, script: provider, compatibilityDate: '2026-05-15' },
  ] });
  try {
    const response = await mf.dispatchFetch('https://local-transport.test/');
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(result, { transport: 'bxagi_ws', transportStatus: 101, messageAcknowledged: true, eventId: 'workerd-user-event', liveVerified: false, deliveryEvidence: 'matching_user_event', freshEchoVerified: false });
  } finally { await mf.dispose(); }
});
