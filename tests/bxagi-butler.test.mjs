import test from 'node:test';
import assert from 'node:assert/strict';
import { createBxagiButler, buildBxagiButlerCoordinationBrief } from '../server/bxagi-butler.mjs';

const token = 'butler-fixture-private-token';
const json = value => new Response(JSON.stringify(value));
const employee = { id: 'bxagi:market:video_editor', marketId: 'video_editor', provider: 'bxagi', resourceType: 'marketplace_template', marketVerified: true, name: '视频编辑专家' };
function client(handler, options = {}) {
  const calls = [];
  const api = createBxagiButler({ accessToken: token, subject: 'verified-owner', ...options, fetcher: async (url, init) => {
    const parsed = new URL(url); calls.push(parsed);
    assert.equal(parsed.origin, 'https://bxagi.xinlx.com'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, `Bearer ${token}`); assert.equal(init.body, undefined);
    return handler(parsed, init);
  } });
  return { api, calls };
}

test('official capability is read-only even when remote butler mode is enabled', async () => {
  const { api, calls } = client(() => json({ butler_mode: true, secret: token, account_admin: true }));
  const result = await api.inspectCapabilities();
  assert.equal(result.enabled, true); assert.equal(result.dispatchEnabled, false); assert.equal(result.planningOnlyApiVerified, false);
  assert.equal(result.marketRoutingVerified, false); assert.equal(result.liveVerified, false);
  assert.deepEqual(Object.keys(api).sort(), ['inspectCapabilities', 'listDispatches','readDispatchDiagnostic']);
  assert.equal(calls[0].pathname, '/api/v1/feature-flags'); assert.ok(!JSON.stringify(result).includes(token));
});

test('disabled and malformed feature flags never imply active dispatch', async () => {
  assert.equal((await client(() => json({ butler_mode: false })).api.inspectCapabilities()).enabled, false);
  await assert.rejects(client(() => json({ butler_mode: 'true' })).api.inspectCapabilities(), { code: 'unexpected_response' });
});

test('history only exposes bounded metadata, excludes ack/text/secrets and does not verify delivery or ownership', async () => {
  const { api, calls } = client(() => json({ items: [{ client_message_id: 'dispatch-1', conversation_id: 'owned-unknown', status: 'completed', created_at: '2026-10-14T13:20:34Z', route: { employee_name: `编辑 Bearer ${token}`, employee_id: 'unverified', session_api_key: token }, text: token, ack_text: 'private body', error: token, device_id: token }], token }));
  const result = await api.listDispatches({ limit: 5, offset: 2, source: 'voice_device', deviceId: 'device-1', status: 'completed' });
  assert.equal(calls[0].pathname, '/api/v1/butler/dispatches');
  assert.equal(calls[0].searchParams.get('device_id'), 'device-1');
  assert.equal(result.items[0].status, 'completed');
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['clientMessageId', 'conversationId', 'createdAt', 'employeeName', 'status']);
  assert.equal(result.deliveryVerified, false); assert.equal(result.ownershipVerified, false); assert.equal(result.routeVerified, false);
  assert.ok(!JSON.stringify(result).includes(token)); assert.ok(!JSON.stringify(result).includes('private body')); assert.ok(!JSON.stringify(result).includes('unverified'));
});

test('unknown status stays unknown and malformed IDs or envelopes are refused', async () => {
  const result = await client(() => json({ items: [{ client_message_id: 'd1', status: 'wonderful', created_at: 'private arbitrary data' }] })).api.listDispatches();
  assert.equal(result.items[0].status, 'unknown'); assert.equal(result.items[0].createdAt, null);
  for (const payload of [{ items: [{}] }, { items: [{ client_message_id: '../bad' }] }, { items: [{ client_message_id: token }] }, { items: 'bad' }]) await assert.rejects(client(() => json(payload)).api.listDispatches(), { code: 'unexpected_response' });
});

test('invalid pagination and filter injection cannot send any upstream request', async () => {
  const { api, calls } = client(() => { throw new Error('must not fetch'); });
  for (const args of [{ limit: 101 }, { offset: -1 }, { source: 'x&token=private' }, { deviceId: '../other' }, { status: 'active' }]) await assert.rejects(api.listDispatches(args), error => error.status === 400);
  assert.equal(calls.length, 0);
});

test('redirects and upstream failures expose no remote bodies or credentials', async () => {
  await assert.rejects(client(() => new Response(token, { status: 302, headers: { Location: 'https://evil.invalid/' } })).api.inspectCapabilities(), { code: 'redirect_refused' });
  for (const status of [401, 403, 500]) await assert.rejects(client(() => new Response(token, { status })).api.listDispatches(), error => !error.message.includes(token) && error.uncertain === false && error.status === (status === 500 ? 502 : status));
  await assert.rejects(client(() => { throw new Error(token); }).api.listDispatches(), error => !error.message.includes(token) && error.code === 'upstream_unavailable');
});

test('oversized declared and streamed responses are rejected', async () => {
  for (const response of [new Response('{}', { headers: { 'Content-Length': '262145' } }), new Response(' '.repeat(262145))]) await assert.rejects(client(() => response).api.inspectCapabilities(), { code: 'response_too_large' });
});

test('timeout bounds stalled reads without automatic retries', async () => {
  let cancelled = false;
  const { api, calls } = client(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })), { timeoutMs: 100 });
  await assert.rejects(api.inspectCapabilities(), { code: 'upstream_timeout' });
  assert.equal(calls.length, 1); assert.equal(cancelled, true);
});

test('brief keeps exact market IDs and mandatory boundaries inside 500 characters', () => {
  const brief = buildBxagiButlerCoordinationBrief({ project: { title: '流程验证'.repeat(50), objective: '优化视频'.repeat(50), facts: ['真实事实'.repeat(50), '不包含价格'.repeat(50)], accessToken: token }, employees: [employee, { ...employee, marketId: 'other', id: 'bxagi:market:other' }, employee] });
  assert.ok(brief.length <= 500); assert.match(brief, /不得开始生产、安装、雇佣、购买、续费、投放、改预算/); assert.match(brief, /仅做协调建议/);
  const metadata = JSON.parse(brief.split('数据：')[1]); assert.equal(metadata.candidates[0].marketId, 'video_editor');
  assert.equal(new Set(metadata.candidates.map(item => item.marketId)).size, metadata.candidates.length); assert.ok(!brief.includes(token));
});

test('brief refuses historical resources and strips credential-like metadata', () => {
  assert.throws(() => buildBxagiButlerCoordinationBrief({ employees: [{ ...employee, resourceType: 'conversation' }] }), { code: 'butler_market_candidates_required' });
  const brief = buildBxagiButlerCoordinationBrief({ project: { title: 'Bearer private-auth-token', facts: ['password=hidden-secret'] }, employees: [employee] });
  assert.ok(!brief.includes('private-auth-token')); assert.ok(!brief.includes('hidden-secret'));
});

test('dispatch diagnostic reads only fixed bounded history and the exact client ID, returning an actual failed reason without task bodies',async()=>{
 const clientMessageId='b5e9fe5aa81d49a0916c85fc207f627b',fixture=client(()=>json({items:[{client_message_id:'different-client',status:'failed',error:'unrelated private failure'},{client_message_id:clientMessageId,status:'failed',conversation_id:null,route:{employee_name:'通用助理',token},error_message:'No online execution worker was available.',text:'private prompt',ack_text:'private ack',env:{token}}]}));
 const result=await fixture.api.readDispatchDiagnostic({clientMessageId});assert.equal(result.found,true);assert.equal(result.status,'failed');assert.equal(result.conversationId,null);assert.equal(result.employeeName,'通用助理');assert.equal(result.failureMessage,'No online execution worker was available.');assert.equal(result.deliveryVerified,false);assert.equal(fixture.calls[0].pathname,'/api/v1/butler/dispatches');assert.equal(fixture.calls[0].search,'?limit=100&offset=0');
 for(const value of [token,'private prompt','private ack','unrelated private failure'])assert.equal(JSON.stringify(result).includes(value),false);
 const missing=await fixture.api.readDispatchDiagnostic({clientMessageId:'0'.repeat(32)});assert.equal(missing.found,false);assert.equal(missing.failureMessage,null);
});
test('failure summaries strongly redact credentials, private keys, URLs and environment dumps, cap 400 characters and reject unobserved object structure',async()=>{
 const clientMessageId='b5e9fe5aa81d49a0916c85fc207f627b';
 const sensitive=`Execution failed; Bearer remote-private-bearer; session_api_key="remote-session-key" password=remote-password ${token} https://example.invalid/?token=private-query -----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-material\n-----END OPENSSH PRIVATE KEY----- ${'diagnostic '.repeat(100)}`;
 const result=await client(()=>json({items:[{client_message_id:clientMessageId,status:'failed',error:sensitive}]})).api.readDispatchDiagnostic({clientMessageId});assert.ok(result.failureMessage.length<=400);assert.ok(result.failureMessage.includes('Execution failed'));
 for(const value of ['remote-private-bearer','remote-session-key','remote-password',token,'example.invalid','private-query','private-key-material'])assert.equal(result.failureMessage.includes(value),false,value);
 for(const error of [{code:'WORKER_MISSING',message:'No usable execution worker.'},{error_message:'No usable execution worker.'}])assert.ok((await client(()=>json({items:[{client_message_id:clientMessageId,status:'failed',error}]})).api.readDispatchDiagnostic({clientMessageId})).failureMessage.includes('No usable execution worker.'));
 for(const error of [{code:{token},message:'nested secret'}, {message:'hidden config',settings:{token}}, ['private arbitrary data'], 'environment={"API_KEY":"private-env"}', 'PATH=/private\nAWS_SECRET_ACCESS_KEY=private-env', '-----BEGIN PRIVATE KEY-----\nprivate-key-material'])assert.equal((await client(()=>json({items:[{client_message_id:clientMessageId,status:'failed',error}]})).api.readDispatchDiagnostic({clientMessageId})).failureMessage,null);
});
test('dispatch diagnostic invalid client IDs do not fetch; duplicate or malformed results cannot imply a reconciled failure',async()=>{
 const clientMessageId='b5e9fe5aa81d49a0916c85fc207f627b',fixture=client(()=>json({items:[]}));
 for(const value of [undefined,'../other','bad-id','0'.repeat(31)])await assert.rejects(fixture.api.readDispatchDiagnostic({clientMessageId:value}),error=>error.status===400);assert.equal(fixture.calls.length,0);
 for(const raw of [{items:[{client_message_id:clientMessageId,status:'failed'},{client_message_id:clientMessageId,status:'running'}]},{items:'private body'}])await assert.rejects(client(()=>json(raw)).api.readDispatchDiagnostic({clientMessageId}),{code:'unexpected_response'});
 const running=await client(()=>json({items:[{client_message_id:clientMessageId,status:'running',error:'previous error'}]})).api.readDispatchDiagnostic({clientMessageId});assert.equal(running.failureMessage,null);
});

const messageId = '4f984e9cbb684ab6aa4d42eb06f7d1c2';
const conversationId = 'b35df0af6e6344e995e90e5b2d47d578';
const diagnosticText = '仅给当前视频任务诊断建议，不执行生产、安装、购买、投放或预算操作。';
function dispatchClient(handler, options = {}) {
  const calls = [];
  const api = createBxagiButler({ accessToken: token, subject: 'verified-owner', enableCoordinationDispatch: true, ...options, fetcher: async (url, init) => {
    calls.push({ url, init }); return handler(url, init);
  } });
  return { api, calls };
}

test('coordination dispatch requires exact opt-in and only submits the observed fixed payload', async () => {
  for (const option of [undefined, false, 'true', 1]) assert.equal(dispatchClient(() => { throw new Error('must not fetch'); }, { enableCoordinationDispatch: option }).api.dispatchCoordination, undefined);
  const { api, calls } = dispatchClient(() => json({ accepted: true, conversation_id: conversationId, client_message_id: messageId, ack_text: token, route: { api_key: token } }));
  const receipt = await api.dispatchCoordination({ text: diagnosticText, clientMessageId: messageId });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://bxagi.xinlx.com/api/v1/butler/dispatch');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.redirect, 'manual'); assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { text: diagnosticText, mode: 'command', client_message_id: messageId });
  assert.equal(receipt.accepted, true); assert.equal(receipt.outcomeUnknown, false); assert.equal(receipt.conversationId, conversationId);
  assert.equal(receipt.routeVerified, false); assert.equal(receipt.ownershipVerified, false); assert.equal(receipt.deliveryVerified, false);
  assert.ok(!JSON.stringify(receipt).includes(token)); assert.ok(!Object.hasOwn(receipt, 'ack_text'));
});

test('invalid diagnostic text and client IDs fail before a POST can occur', async () => {
  const { api, calls } = dispatchClient(() => { throw new Error('must not fetch'); });
  for (const args of [{ text: '', clientMessageId: messageId }, { text: 'x'.repeat(501), clientMessageId: messageId }, { text: token, clientMessageId: messageId }, { text: diagnosticText, clientMessageId: 'bad-id' }, { text: diagnosticText, clientMessageId: messageId + '/evil' }]) await assert.rejects(api.dispatchCoordination(args), error => error.status === 400 && error.outcomeUnknown === false && error.writeSent === false);
  assert.equal(calls.length, 0);
});

test('unconfirmed accepted flag, conversation or mismatched receipt ID remain unknown and never retry', async () => {
  for (const raw of [{ accepted: false }, { accepted: 'true', conversation_id: conversationId }, { accepted: true }, { accepted: true, conversation_id: '../unowned' }, { accepted: true, conversation_id: conversationId, client_message_id: 'different' }]) {
    const { api, calls } = dispatchClient(() => json(raw));
    await assert.rejects(api.dispatchCoordination({ text: diagnosticText, clientMessageId: messageId }), { code: 'butler_dispatch_unconfirmed', outcomeUnknown: true, writeSent: true, uncertain: true });
    assert.equal(calls.length, 1);
  }
});

test('POST redirect, network failure, conflict, malformed or oversized body preserve unknown outcome', async () => {
  const handlers = [() => new Response(token, { status: 302, headers: { Location: 'https://evil.invalid' } }), () => { throw new Error(token); }, () => new Response(token, { status: 409 }), () => new Response(token, { status: 503 }), () => new Response('{bad json'), () => new Response('{}', { headers: { 'Content-Length': '262145' } })];
  for (const handler of handlers) {
    const { api, calls } = dispatchClient(handler);
    await assert.rejects(api.dispatchCoordination({ text: diagnosticText, clientMessageId: messageId }), error => error.outcomeUnknown === true && error.uncertain === true && error.writeSent === true && !error.message.includes(token));
    assert.equal(calls.length, 1);
  }
});

test('explicit authentication refusal is reported without claiming an unknown accepted write', async () => {
  const { api, calls } = dispatchClient(() => new Response(token, { status: 401 }));
  await assert.rejects(api.dispatchCoordination({ text: diagnosticText, clientMessageId: messageId }), { status: 401, outcomeUnknown: false, writeSent: true, uncertain: false });
  assert.equal(calls.length, 1);
});

test('POST timeout remains unknown and cancels a stalled response without replay', async () => {
  let cancelled = false;
  const { api, calls } = dispatchClient(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })), { timeoutMs: 100 });
  await assert.rejects(api.dispatchCoordination({ text: diagnosticText, clientMessageId: messageId }), { code: 'upstream_timeout', outcomeUnknown: true, writeSent: true, uncertain: true });
  assert.equal(calls.length, 1); assert.equal(cancelled, true);
});
