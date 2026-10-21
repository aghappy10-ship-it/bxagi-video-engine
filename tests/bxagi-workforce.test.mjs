import test from 'node:test';
import assert from 'node:assert/strict';
import { createBxagiWorkforce, BXAGI_ORIGIN, BXAGI_MAX_MANIFEST_BYTES, BXAGI_MAX_ARTIFACT_BYTES } from '../server/bxagi-workforce.mjs';

const jobId = 'fa6d1cf4-3a0d-4ad0-82c8-c2d36f644f86';
const input = `bxagi-advertising/${jobId}/input`;
const output = `bxagi-advertising/${jobId}/output`;
const secret = 'test-credential-must-stay-on-server';
const subject = 'verified-bxagi-subject';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const row = { id: 'existing-conversation', employee_id: 'creative_employee', created_by_user_id: subject, node_id: 'authorized-node', selected_repository: 'my-workspace', memory_space_name: 'employee-memory', agent_type: 'AgiAgent', execution_status: 'idle', sandbox_status: 'RUNNING' };
const onlineNodes = { nodes: [{ node_id: row.node_id, status: 'online', gateway_connected: true }] };
const employee = { id: 'bxagi:creative_employee', providerId: 'creative_employee', conversationId: row.id, memorySpaceName: 'employee-memory', usable: true, provider: 'bxagi' };
test('artifact deadline defaults to 60 seconds and clamps explicit values to 120 seconds without waiting on real timers',async t=>{
  const deadlines=[];
  t.mock.method(globalThis,'setTimeout',(_callback,delay)=>{deadlines.push(delay);return {deadline:delay};});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  for(const [configured,expected] of [[undefined,60000],[120000,120000],[180000,120000],[NaN,60000],[-1,100]]){
    const api=createBxagiWorkforce({accessToken:secret,subject,...(configured===undefined?{}:{artifactTimeoutMs:configured}),fetcher:async(url,options)=>{assert.equal(new URL(url).origin,BXAGI_ORIGIN);assert.equal(options.method,'GET');return new Response('artifact-stream-fixture');}});
    const response=await api.readArtifact({conversation:row,relativePath:`${output}/test.mp4`});
    assert.equal(await response.text(),'artifact-stream-fixture');assert.equal(deadlines.at(-1),expected);
  }
});
function client(handler) {
  const calls = [];
  const api = createBxagiWorkforce({ accessToken: secret, subject, fetcher: async (url, options) => {
    assert.equal(new URL(url).origin, BXAGI_ORIGIN);
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    calls.push({ url: new URL(url), options }); return handler(new URL(url), options, calls.length);
  } });
  return { api, calls };
}

test('directory joins exact mine.items and template array with owned sessions; does not manufacture executable tools', async () => {
  const { api, calls } = client(url => url.pathname.endsWith('/mine') ? json({ items: [
    { employee_id: 'creative_employee', name: '游戏素材员工', usable: true, conversation_exists: true, conversation_id: row.id, memory_space_name: 'employee-memory' },
    { employee_id: 'inactive', usable: false, conversation_id: 'old' },
    { employee_id: 'unknown', conversation_id: 'unknown-conversation' },
  ] }) : url.pathname.endsWith('/templates') ? json([
    { id: 'creative_employee', name: 'template name', description: `实际视频剪辑工具 ${secret}`, category: '创意', tags: ['游戏'], skills: ['media/video-edit'] },
    { id: 'inactive', description: '广告投放', skills: ['ads/campaign'] },
  ]) : url.pathname === '/api/nodes' ? json(onlineNodes) : url.searchParams.has('ids') ? json([]) : json({ items: [row] }));
  const result = await api.listEmployees();
  assert.equal(calls[0].url.pathname, '/api/v1/employees/mine');
  assert.equal(calls[0].url.searchParams.get('include_inactive'), 'true');
  assert.equal(calls[1].url.pathname, '/api/v1/employees/templates');
  assert.equal(result[0].id, 'bxagi:creative_employee'); assert.equal(result[0].name, '游戏素材员工');
  assert.equal(result[0].usable, true); assert.deepEqual(result[0].roleCandidates, ['production']);
  assert.ok(result[0].sceneKeywords.includes('游戏')); assert.equal(result[0].liveVerified, false);
  assert.equal(result[1].usable, false); assert.equal(result[2].usable, false);
  assert.equal(result[0].providerUsable, true); assert.equal(result[0].providerConversationExists, true);
  assert.equal(result[1].providerUsable, false); assert.equal(result[1].providerConversationExists, null);
  assert.equal(result[2].providerUsable, null); assert.equal(result[0].subscriptionExpired, false);
  const batch=calls.find(call=>call.url.pathname==='/api/v1/app-conversations'&&call.url.searchParams.has('ids'));
  assert.deepEqual(batch.url.searchParams.getAll('ids'),['old','unknown-conversation']);assert.deepEqual([...batch.url.searchParams.keys()],['ids','ids']);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.equal(result[0].capabilities, undefined);
});

test('unobserved directory envelopes are rejected instead of converted to successful employees', async () => {
  for (const [mine, templates] of [[[], []], [{ items: [] }, { items: [] }], [{ items: [{}] }, []]]) {
    const { api } = client(url => json(url.pathname.endsWith('/mine') ? mine : templates));
    await assert.rejects(api.listEmployees(), error => error.code === 'unexpected_response');
  }
});

test('dedicated conversation uses the existing employee node, memory and repository, with no premature work', async () => {
  const { api, calls } = client((url, options) => url.pathname.endsWith('/mine') ? json({ items: [] }) : url.pathname === '/api/nodes' ? json(onlineNodes) : options.method === 'GET' ? json([{ ...row, agent_server_url: 'https://external.invalid', session_api_key: secret }]) : json({ id: 'start-task', agent_server_url: 'https://external.invalid' }));
  const result = await api.createConversation({ employee, jobId });
  assert.deepEqual(result, { startTaskId: 'start-task', liveVerified: false });
  assert.equal(calls[0].url.searchParams.has('skip_live_status'), false);
  assert.deepEqual([...calls[0].url.searchParams.keys()], ['ids']);
  const payload = JSON.parse(calls.find(call => call.options.method === 'POST').options.body);
  assert.equal(payload.employee_id, employee.providerId); assert.equal(payload.node_id, row.node_id);
  assert.equal(payload.memory_space_name, row.memory_space_name); assert.equal(payload.selected_repository, row.selected_repository);
  assert.equal(payload.initial_message, undefined); assert.equal(payload.parent_conversation_id, null);
  assert.equal(calls.length, 4); assert.ok(calls.every(call => !/install|renew/.test(call.url.pathname)));
});

test('inactive employee or mismatched employee conversation cannot create a remote execution', async () => {
  let counter = 0;
  const api = createBxagiWorkforce({ accessToken: secret, subject, fetcher: async url => { counter++; const path = new URL(url).pathname; return path.endsWith('/mine') ? json({ items: [] }) : path === '/api/nodes' ? json(onlineNodes) : json([{ ...row, employee_id: 'somebody_else' }]); } });
  await assert.rejects(api.createConversation({ employee: { ...employee, usable: false }, jobId }), error => error.code === 'employee_unavailable');
  assert.equal(counter, 0);
  await assert.rejects(api.createConversation({ employee, jobId }), error => error.code === 'employee_mismatch'); assert.equal(counter, 3);
});

test('missing optional source settings use the defaults visibly chosen by the official workforce UI', async () => {
  const { api, calls } = client((url, options) => url.pathname.endsWith('/mine') ? json({ items: [] }) : url.pathname === '/api/nodes' ? json(onlineNodes) : options.method === 'GET' ? json([{ ...row, selected_repository: null, agent_type: null, memory_space_name: null, participants: [{ type: 'agent', is_primary: true, node_id: row.node_id }] }]) : json({ id: 'start-task' }));
  await api.createConversation({ employee: { ...employee, memorySpaceName: null }, jobId });
  const payload = JSON.parse(calls.find(call => call.options.method === 'POST').options.body);
  assert.equal(payload.selected_repository, 'default'); assert.equal(payload.memory_space_name, 'default'); assert.equal(payload.agent_type, 'AgiAgent');
  assert.equal(payload.node_id, row.node_id);
});

test('conversation records exclude runtime URLs and session credentials and require matching array record', async () => {
  const { api } = client(() => json([{ ...row, conversation_url: 'https://external.invalid', session_api_key: secret }]));
  const result = await api.getConversation(row.id);
  assert.equal(result.id, row.id); assert.equal(result.execution_status, 'idle');
  assert.equal(result.conversation_url, undefined); assert.equal(result.session_api_key, undefined);
  const { api: bad } = client(() => json({ items: [row] }));
  await assert.rejects(bad.getConversation(row.id), error => error.code === 'unexpected_response');
});

test('READY identifies startup only; missing real conversation and unknown envelopes fail', async () => {
  const { api } = client(() => json([{ id: 'task', status: 'READY', app_conversation_id: 'created-conversation' }]));
  assert.deepEqual(await api.getStartTask('task'), { startTaskId: 'task', status: 'READY', conversationId: 'created-conversation', liveVerified: false });
  for (const data of [[{ id: 'task', status: 'READY' }], { status: 'READY', app_conversation_id: 'fake' }]) {
    const { api: bad } = client(() => json(data)); await assert.rejects(bad.getStartTask('task'), error => error.code === 'unexpected_response');
  }
});

test('runtime ensure revalidates the owned conversation, uses its repository and exposes only observed readiness',async()=>{
  for(const status of ['starting','missing','ready']){
    const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({status,conversation_url:`https://runtime.invalid/${secret}`,session_api_key:secret}));
    const result=await api.ensureRuntime({conversation:{id:row.id,created_by_user_id:'forged-owner',selected_repository:'forged-repo'}});
    assert.deepEqual(result,{status,liveVerified:false});assert.equal(calls.length,2);
    assert.equal(calls[0].url.pathname,'/api/v1/app-conversations');assert.equal(calls[0].url.searchParams.get('ids'),row.id);
    assert.equal(calls[1].url.pathname,`/api/v1/conversations/${row.id}/runtime/ensure`);assert.equal(calls[1].url.searchParams.get('project_name'),row.selected_repository);assert.equal(calls[1].options.method,'GET');
    assert.equal(JSON.stringify(result).includes(secret),false);
  }
  const {api,calls}=client(()=>json([{...row,created_by_user_id:'foreign'}]));
  await assert.rejects(api.ensureRuntime({conversation:{id:row.id,created_by_user_id:subject}}),error=>error.code==='conversation_owner_mismatch');assert.equal(calls.length,1);
  for(const data of [null,[],{}, {status:'unknown'}, {status:'READY'}]){
    const {api:invalid}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json(data));
    await assert.rejects(invalid.ensureRuntime({conversation:row}),error=>error.code==='unexpected_runtime_response'&&!error.uncertain);
  }
});

test('UUID wire format equivalence preserves the actual conversation ID without granting a different record',async()=>{
  const hyphen='19a3e398-9dd1-43eb-b615-ba052654382f',compact=hyphen.replaceAll('-','');
  const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([{...row,id:compact}]):json({status:'ready'}));
  const source=await api.getConversation(hyphen);assert.equal(source.id,compact);assert.equal(calls[0].url.searchParams.get('ids'),hyphen);
  assert.deepEqual(await api.ensureRuntime({conversation:{id:hyphen}}),{status:'ready',liveVerified:false});assert.equal(calls.at(-1).url.pathname,`/api/v1/conversations/${compact}/runtime/ensure`);
  for(const otherId of ['19a3e398-9dd1-43eb-b615-ba0526543820','19a3e3989dd143ebb615ba0526543820','existingconversation']){
    const {api:foreign}=client(()=>json([{...row,id:otherId}]));
    await assert.rejects(foreign.getConversation(hyphen),error=>error.code==='conversation_not_found');
  }
  const {api:near}=client(()=>json([{...row,id:'existingconversation'}]));
  await assert.rejects(near.getConversation('existing-conversation'),error=>error.code==='conversation_not_found');
  const {api:foreignOwner}=client(()=>json([{...row,id:compact,created_by_user_id:'foreign'}]));
  await assert.rejects(foreignOwner.getConversation(hyphen),error=>error.code==='conversation_owner_mismatch');
  const {api:task}=client(()=>json([{id:compact,status:'READY',app_conversation_id:row.id}]));
  assert.equal((await task.getStartTask(hyphen)).conversationId,row.id);
});

test('real binary upload is multipart in a dedicated input directory; receipt is not an output', async () => {
  const { api, calls } = client(() => new Response(null, { status: 204 }));
  const result = await api.uploadFile({ conversationId: row.id, directory: input, filename: '原素材.png', blob: new Blob(['actual-file'], { type: 'image/png' }) });
  assert.equal(calls[0].url.pathname, `/api/v1/conversations/${row.id}/files/upload`);
  assert.equal(calls[0].url.searchParams.get('path'), input); assert.ok(calls[0].options.body instanceof FormData);
  assert.equal(await calls[0].options.body.get('file').text(), 'actual-file');
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  assert.equal(result.transportStatus, 204); assert.equal(result.status, undefined); assert.equal(result.creative, undefined);
});

test('message delivery verifies current ownership and observed history before one acknowledged transport send', async () => {
  const prompt='实际素材上传完毕，开始处理。',calls=[];let sends=0;
  const history={id:'old-event',timestamp:'2026-10-14T00:00:00Z',kind:'MessageEvent',source:'user',llm_message:{role:'user',content:[{type:'text',text:'different task'}]}};
  const make=events=>createBxagiWorkforce({accessToken:secret,subject,fetcher:async url=>{calls.push(new URL(url));return new URL(url).pathname==='/api/v1/app-conversations'?json([row]):json({items:events});},messageTransport:{async send(input){sends++;assert.equal(input.conversationId,row.id);assert.equal(input.prompt,prompt);assert.deepEqual(input.knownEventIds,['old-event']);return {transport:'bxagi_ws',transportStatus:101,messageAcknowledged:true,eventId:'new-event',liveVerified:false}}}});
  const result=await make([history]).sendMessage(row.id,prompt);assert.equal(sends,1);assert.equal(result.messageAcknowledged,true);assert.equal(result.liveVerified,false);
  assert.equal(calls[0].pathname,'/api/v1/app-conversations');assert.equal(calls[1].pathname,`/api/v1/conversation/${row.id}/events/search`);
  const duplicate=await make([{...history,llm_message:{role:'user',content:prompt}}]).sendMessage(row.id,prompt);assert.equal(sends,1);assert.equal(duplicate.alreadyDelivered,true);assert.equal(duplicate.eventId,'old-event');
  const foreign=createBxagiWorkforce({accessToken:secret,subject,fetcher:async()=>json([{...row,created_by_user_id:'another-user'}]),messageTransport:{async send(){sends++}}});
  await assert.rejects(foreign.sendMessage(row.id,prompt),error=>error.code==='conversation_owner_mismatch'&&error.messageSent===false&&!error.uncertain);assert.equal(sends,1);
});

test('actual artifacts use a same-origin node proxy and verified subject, with protected response headers', async () => {
  const { api, calls } = client(() => new Response('actual-bytes', { headers: { 'Content-Type': 'image/png', 'X-Session-API-Key': secret, 'Location': 'https://external.invalid' } }));
  const response = await api.readArtifact({ conversation: row, relativePath: `${output}/成品.png` });
  assert.equal(await response.text(), 'actual-bytes');
  assert.equal(calls[0].url.pathname, `/api/nodes/${row.node_id}/file/download-relative/${output}/%E6%88%90%E5%93%81.png`);
  assert.equal(calls[0].url.searchParams.get('project_name'), row.selected_repository);
  assert.equal(calls[0].options.headers['X-User-Id'], subject);
  assert.equal(response.headers.get('X-Session-API-Key'), null); assert.equal(response.headers.get('Location'), null);
});

test('input and output directory validation rejects traversal and external URLs before any request', async () => {
  let count = 0;
  const api = createBxagiWorkforce({ accessToken: secret, subject, fetcher: async () => { count++; return json({}); } });
  for (const relativePath of [`${output}/../secret`, `${output}/%2e%2e/file`, `https://external.invalid/x`, `${input}/source.png`, `${output}/a\\b`]) {
    await assert.rejects(api.readArtifact({ conversation: row, relativePath }), error => error.code === 'invalid_artifact_path');
  }
  await assert.rejects(api.uploadFile({ conversationId: row.id, directory: 'default', filename: 'f', blob: new Blob(['x']) }), error => error.code === 'invalid_upload_path');
  assert.equal(count, 0);
});

test('manifest must be a bounded JSON object; text claims and oversized streams cannot finish a job', async () => {
  const { api } = client(() => json({ jobId, artifacts: [] }));
  assert.deepEqual(await api.readManifest({ conversation: row, relativePath: `${output}/manifest.json` }), { jobId, artifacts: [] });
  for (const data of ['finished', []]) {
    const { api: bad } = client(() => json(data)); await assert.rejects(bad.readManifest({ conversation: row, relativePath: `${output}/manifest.json` }), error => error.code === 'invalid_manifest');
  }
  const { api: huge } = client(() => new Response(new Uint8Array(BXAGI_MAX_MANIFEST_BYTES + 1)));
  await assert.rejects(huge.readManifest({ conversation: row, relativePath: `${output}/manifest.json` }), error => error.code === 'response_too_large');
});

test('artifact length is limited both before download and while streaming', async () => {
  const { api } = client(() => new Response('x', { headers: { 'Content-Length': String(BXAGI_MAX_ARTIFACT_BYTES + 1) } }));
  await assert.rejects(api.readArtifact({ conversation: row, relativePath: `${output}/f.png` }), error => error.code === 'response_too_large');
  const { api: stream } = client(() => new Response(new Uint8Array(BXAGI_MAX_ARTIFACT_BYTES + 1)));
  const response = await stream.readArtifact({ conversation: row, relativePath: `${output}/f.png` });
  await assert.rejects(response.arrayBuffer(), error => error.code === 'response_too_large');
});

test('media transfers outlive the ordinary deadline while manifests and JSON retain it',async()=>{
 const calls=[];
 const api=createBxagiWorkforce({accessToken:secret,subject,timeoutMs:100,artifactTimeoutMs:400,fetcher:async(url,options)=>{
  calls.push({url:new URL(url),options});
  return new Response(new ReadableStream({start(controller){
   const timer=setTimeout(()=>{controller.enqueue(new TextEncoder().encode('actual-media-bytes'));controller.close();},180);
   options.signal.addEventListener('abort',()=>{clearTimeout(timer);controller.error(new Error(secret));},{once:true});
  }}));
 }});
 const media=await api.readArtifact({conversation:row,relativePath:`${output}/video.mp4`});assert.equal(await media.text(),'actual-media-bytes');assert.equal(calls[0].options.signal.aborted,false);
 await assert.rejects(api.readManifest({conversation:row,relativePath:`${output}/manifest.json`}),e=>e.code==='upstream_stream_timeout');
 await assert.rejects(api.listExecutionAgents(),e=>e.code==='upstream_stream_timeout');
 assert.equal(calls.length,3);assert.ok(calls.every(c=>c.options.method==='GET'));assert.equal(calls[1].options.signal.aborted,true);assert.equal(calls[2].options.signal.aborted,true);
 // Completing a body clears its deadline instead of aborting an already successful transfer.
 assert.equal(calls[0].options.signal.aborted,false);
});

test('a media deadline aborts a partial body once and permits an explicit read-only recollection',async()=>{
 let calls=0,aborts=0;const signals=[];
 const api=createBxagiWorkforce({accessToken:secret,subject,timeoutMs:100,artifactTimeoutMs:150,fetcher:async(_url,options)=>{
  calls++;signals.push(options.signal);assert.equal(options.method,'GET');
  if(calls===2)return new Response('complete-recollected-bytes');
  return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));options.signal.addEventListener('abort',()=>{aborts++;controller.error(new Error(secret));},{once:true});}}));
 }});
 const incomplete=await api.readArtifact({conversation:row,relativePath:`${output}/video.mp4`});
 await assert.rejects(incomplete.arrayBuffer(),e=>e.code==='upstream_stream_timeout'&&!e.message.includes(secret));assert.equal(calls,1);assert.equal(aborts,1);assert.equal(signals[0].aborted,true);
 const recollected=await api.readArtifact({conversation:row,relativePath:`${output}/video.mp4`});assert.equal(await recollected.text(),'complete-recollected-bytes');assert.equal(calls,2);assert.equal(signals[1].aborted,false);
});

test('upstream error bodies and network errors never expose credentials or auto-retry writes', async () => {
  const { api } = client(() => new Response(`Bearer ${secret} original runtime failure`, { status: 403 }));
  await assert.rejects(api.listEmployees(), error => error.code === 'workforce_forbidden' && !error.message.includes(secret));
  let count = 0;
  const writer = createBxagiWorkforce({ accessToken: secret, subject, fetcher: async () => { count++; throw new Error(`https://external.invalid ${secret}`); } });
  await assert.rejects(writer.sendMessage(row.id, 'process'), error => error.code === 'upstream_unavailable' && !error.uncertain && error.messageSent === false && !error.message.includes(secret));
  assert.equal(count, 1);
});

test('unreadable create receipt retains uncertainty and never repeats conversation creation', async () => {
  for (const receipt of [{}, { id: '../invalid' }, []]) {
    const { api, calls } = client((url, options) => url.pathname.endsWith('/mine') ? json({ items: [] }) : url.pathname === '/api/nodes' ? json(onlineNodes) : options.method === 'GET' ? json([row]) : json(receipt));
    await assert.rejects(api.createConversation({ employee, jobId }), error => error.code === 'unexpected_response' && error.uncertain);
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  }
});

function discoveryClient({ ledger = [], conversations = [], templates = [], nodes = onlineNodes.nodes, pages, postReceipt = { id: 'dedicated-task' } } = {}) {
  return client((url, options) => {
    if (url.pathname.endsWith('/mine')) return json({ items: ledger });
    if (url.pathname.endsWith('/templates')) return json(templates);
    if (url.pathname === '/api/nodes') return json({ nodes });
    if (options.method === 'POST') return json(postReceipt);
    const ids = url.searchParams.getAll('ids');
    if (ids.length) return json(conversations.filter(conversation => ids.includes(conversation.id)));
    if (pages) return json(pages[url.searchParams.get('page_id') || 'first'] || { items: [] });
    return json({ items: conversations, total: conversations.length });
  });
}

test('mine can be empty while an actual owned AGI root is discovered and creates a dedicated run without employee_id', async () => {
  const source = { ...row, employee_id: null, title: '已有通用执行员工', agent_type: 'CodeActAgent' };
  const { api, calls } = discoveryClient({ conversations: [source] });
  const catalog = await api.listEmployees();
  assert.equal(catalog.length, 1); assert.equal(catalog[0].resourceType, 'conversation');
  assert.equal(catalog[0].providerId, null); assert.equal(catalog[0].conversationId, source.id);
  assert.equal(catalog[0].usable, true); assert.equal(catalog[0].availability, 'ready');
  assert.deepEqual(catalog[0].roleCandidates, ['production', 'buying']);
  await api.createConversation({ employee: catalog[0], jobId });
  const writes = calls.filter(call => call.options.method === 'POST');
  assert.equal(writes.length, 1); assert.equal(writes[0].url.pathname, '/api/v1/app-conversations');
  const payload = JSON.parse(writes[0].options.body);
  assert.equal(payload.employee_id, undefined); assert.equal(payload.node_id, row.node_id);
  assert.equal(payload.memory_space_name, row.memory_space_name); assert.equal(payload.agent_type, 'CodeActAgent');
  assert.ok(calls.every(call => !/install|renew|admin/.test(call.url.pathname)));
  assert.deepEqual(api.discoveryDiagnostics(), { pages: 1, conversationCount: 1, ledgerCount: 0, rootCount: 1, ownedRootCount: 1, nodeCount: 1, usableCount: 1, limitReached: false, excludedReasons: {} });
});

test('owned-root discovery rejects administrative visibility, missing owners, child runs and non-agent conversations', async () => {
  const { api } = discoveryClient({ conversations: [
    { ...row, id: 'owned', employee_id: null },
    { ...row, id: 'foreign', created_by_user_id: 'another-user', employee_id: null },
    { ...row, id: 'unknown-owner', created_by_user_id: null, employee_id: null },
    { ...row, id: 'child', parent_conversation_id: 'owned', employee_id: null },
    { ...row, id: 'non-agent', agent_type: 'ReadOnlyAgent', participants: [], employee_id: null },
  ] });
  const result = await api.listEmployees(); assert.deepEqual(result.map(entry => entry.conversationId), ['owned']);
  const diagnostics = api.discoveryDiagnostics();
  assert.equal(diagnostics.ownedRootCount, 1); assert.equal(diagnostics.excludedReasons.foreign_owner, 1);
  assert.equal(diagnostics.excludedReasons.owner_missing, 1); assert.equal(diagnostics.excludedReasons.child_conversation, 1); assert.equal(diagnostics.excludedReasons.not_agent, 1);
  assert.ok(!JSON.stringify(diagnostics).includes('another-user'));
  const { api: reader } = discoveryClient({ conversations: [{ ...row, created_by_user_id: 'another-user' }] });
  await assert.rejects(reader.getConversation(row.id), error => error.code === 'conversation_owner_mismatch' && error.status === 403);
});

test('dedicated advertising executions do not reappear as employees, without broad title filtering', async () => {
  const execution = { ...row, id: 'platform-job', employee_id: null, title: `广告任务 · ${jobId}` };
  const { api, calls } = discoveryClient({ conversations: [
    execution,
    { ...row, id: 'real-root', employee_id: null, title: '广告任务 · 产品创意员工' },
    { ...row, id: 'similar-title', employee_id: null, title: `广告任务 · ${jobId} 素材专家` },
  ] });
  const catalog = await api.listEmployees();
  assert.deepEqual(catalog.map(entry => entry.conversationId), ['real-root', 'similar-title']);
  assert.equal(api.discoveryDiagnostics().excludedReasons.execution_run, 1);
  await assert.rejects(api.createConversation({ employee: { ...employee, providerId: null, resourceType: 'conversation', conversationId: execution.id }, jobId }), error => error.code === 'employee_unavailable');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
});

test('a real installed ledger employee remains discoverable with an advertising execution title', async () => {
  const source = { ...row, title: `广告任务 · ${jobId}` };
  const { api } = discoveryClient({
    ledger: [{ employee_id: row.employee_id, conversation_id: row.id, name: '已雇用素材员工', usable: true, conversation_exists: true }],
    conversations: [source],
  });
  const catalog = await api.listEmployees();
  assert.equal(catalog.length, 1); assert.equal(catalog[0].resourceType, 'installed_employee');
  assert.equal(catalog[0].usable, true); assert.equal(api.discoveryDiagnostics().excludedReasons.execution_run, undefined);
});

test('an expired or disabled employee cannot be resurrected by a second root conversation', async () => {
  for (const marker of [{ status: 'expired', usable: true }, { usable: false }, { conversation_exists: false }]) {
    const { api } = discoveryClient({ ledger: [{ employee_id: row.employee_id, conversation_id: row.id, ...marker }], conversations: [row, { ...row, id: 'other-root' }] });
    const result = await api.listEmployees();
    assert.equal(result.length, 2); assert.ok(result.every(entry => entry.usable === false));
    assert.equal(result[0].resourceType, 'installed_employee'); assert.equal(result[1].resourceType, 'conversation');
  }
});

test('fresh dispatch rechecks ownership, node access and expired ledger before writing a conversation', async () => {
  const resource = { ...employee, resourceType: 'conversation' };
  for (const fixture of [
    { conversations: [{ ...row, created_by_user_id: 'foreign' }] },
    { conversations: [row], nodes: [] },
    { conversations: [row], nodes: [{ node_id: row.node_id, status: 'offline' }] },
    { conversations: [row], ledger: [{ employee_id: row.employee_id, conversation_id: row.id, status: 'expired' }] },
  ]) {
    const { api, calls } = discoveryClient(fixture);
    await assert.rejects(api.createConversation({ employee: resource, jobId }), error => ['conversation_owner_mismatch', 'employee_unavailable'].includes(error.code));
    assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  }
});

test('existing roots and installed ledger entries are deduplicated, and unknown node availability stays explicit', async () => {
  const { api } = discoveryClient({ ledger: [{ employee_id: row.employee_id, conversation_id: row.id, usable: true }, { employee_id: row.employee_id, conversation_id: row.id, usable: true }], conversations: [row, row], nodes: [{ node_id: row.node_id, status: 'online', gateway_connected: false }] });
  const result = await api.listEmployees(); assert.equal(result.length, 1);
  assert.equal(result[0].usable, false); assert.equal(result[0].availability, 'node_offline');
  const { api: noTools } = discoveryClient({ templates: [{ id: 'market-only', name: '市场模板', skills: ['anything'] }] });
  assert.deepEqual(await noTools.listEmployees(), []);
});

test('pagination follows only returned cursors, deduplicates records and stops at its fixed bound', async () => {
  const { api, calls } = discoveryClient({ pages: {
    first: { items: [{ ...row, employee_id: null }], next_page_id: 'opaque-next', total: 9000 },
    'opaque-next': { items: [{ ...row, employee_id: null }, { ...row, id: 'second', employee_id: null }], next_page_id: 'must-not-request', total: 9000 },
  } });
  const result = await api.listEmployees(); assert.equal(result.length, 2);
  const pages = calls.filter(call => call.url.pathname === '/api/v1/app-conversations');
  assert.equal(pages.length, 2); assert.equal(pages[0].url.searchParams.get('limit'), '500');
  assert.equal(pages[1].url.searchParams.get('page_id'), 'opaque-next');
  assert.equal(api.discoveryDiagnostics().limitReached, true);
  assert.ok(result.every(entry => entry.discoveryTruncated));
});

test('a fetcher that unexpectedly follows a redirect is rejected before reading data', async () => {
  const response = json({ secret }); Object.defineProperty(response, 'url', { value: 'https://external.invalid/result' });
  const { api } = client(() => response);
  await assert.rejects(api.getConversation(row.id), error => error.code === 'redirect_refused' && !error.message.includes(secret));
});

test('manual mode rejects and cancels both same-origin and cross-origin redirect responses without another request', async () => {
  for (const location of ['/api/auth/me', 'https://credential-destination.invalid/capture']) {
    for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
      let cancelled = false;
      const body = status === 304 ? null : new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
      const { api, calls } = client(() => new Response(body, { status, headers: { Location: location } }));
      await assert.rejects(api.getConversation(row.id), error => error.code === 'redirect_refused' && !error.uncertain && !error.message.includes(secret));
      assert.equal(calls.length, 1); assert.equal(calls[0].url.origin, BXAGI_ORIGIN);
      assert.equal(calls[0].options.redirect, 'manual');
      if (body) assert.equal(cancelled, true);
    }
  }
});

test('a redirected message preflight sends no task and never forwards its token', async () => {
  let cancelled = false;
  const { api, calls } = client(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status: 307, headers: { Location: `https://credential-destination.invalid/${secret}` } }));
  await assert.rejects(api.sendMessage(row.id, 'owned task'), error => error.code === 'redirect_refused' && !error.uncertain && error.messageSent === false && !error.message.includes(secret));
  assert.equal(cancelled, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, BXAGI_ORIGIN); assert.equal(calls[0].url.pathname, '/api/v1/app-conversations');
});

test('message preflight timeout cancels the read before any instruction is sent', async () => {
  const api = createBxagiWorkforce({ accessToken: secret, subject, timeoutMs: 100, fetcher: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(secret)))) });
  await assert.rejects(api.sendMessage(row.id, 'process'), error => error.code === 'upstream_unavailable' && !error.uncertain && error.messageSent === false && !error.message.includes(secret));
});

test('event output includes observed finish/state fields, without accepting them as saved artifacts', async () => {
  const { api } = client(() => json({ items: [
    { id: 'event', kind: 'MessageEvent', source: 'agent', llm_message: { role: 'assistant', content: [{ type: 'text', text: `Done. Bearer ${secret}` }, { type: 'image', image_urls: [`https://external.invalid/${secret}`] }] }, session_api_key: secret },
    { id: 'finish', kind: 'ActionEvent', source: 'agent', action: { kind: 'FinishAction', args: { token: secret } } },
  ] }));
  const events = await api.getEvents(row.id);
  assert.equal(events[1].action.kind, 'FinishAction'); assert.equal(events[1].action.args, undefined);
  assert.ok(!JSON.stringify(events).includes(secret)); assert.equal(events[0].llm_message.content.length, 1); assert.equal(events[0].status, undefined);
});

test('observed full_state updates project only a known execution status and discard all other state data',async()=>{
 const {api}=client(()=>json({items:[{id:'state',kind:'ConversationStateUpdateEvent',source:'agent',key:'full_state',value:{execution_status:'FINISHED',session_api_key:secret,tools:{args:secret}}},{id:'unknown',key:'full_state',value:{execution_status:secret}}]}));
 const events=await api.getEvents(row.id);assert.equal(events[0].key,'execution_status');assert.equal(events[0].value,'finished');assert.equal(events[0].full_state,undefined);assert.equal(events[1].key,undefined);assert.equal(JSON.stringify(events).includes(secret),false);
});

test('job filesystem inspection compares only four exact owned input/output directories with bounded metadata',async()=>{
 const {api,calls}=client(url=>{
  if(url.pathname==='/api/v1/app-conversations')return json([row]);
  const path=url.searchParams.get('path');assert.ok([input,output].includes(path));
  if(url.pathname.endsWith('/files'))return json({directories:[],files:[{path:`${path}/actual.png`,type:'file',size:120},{path:'../private',type:'file',secret}]});
  assert.equal(url.pathname,`/api/nodes/${row.node_id}/file/list`);assert.equal(url.searchParams.get('project_name'),row.selected_repository);
  return new Response('not found',{status:404});
 });
 const result=await api.inspectJobFiles({conversationId:row.id,jobId});assert.equal(calls.length,5);assert.ok(calls.every(c=>c.options.method==='GET'));
 assert.equal(result.conversation.input.exists,true);assert.equal(result.conversation.input.fileCount,1);assert.equal(result.conversation.input.excludedEntryCount,1);assert.equal(result.nodeProject.output.exists,false);assert.equal(result.nodeProject.output.errorCode,'directory_not_found');assert.equal(JSON.stringify(result).includes(secret),false);
 assert.ok(calls.filter(c=>c.url.pathname.includes('/api/nodes/')).every(c=>c.options.headers['X-User-Id']===subject));
 const count=calls.length;await assert.rejects(api.inspectJobFiles({conversationId:row.id,jobId:'../root'}),e=>e.code==='invalid_job');assert.equal(calls.length,count);
 const {api:foreign,calls:foreignCalls}=client(()=>json([{...row,created_by_user_id:'foreign'}]));await assert.rejects(foreign.inspectJobFiles({conversationId:row.id,jobId}),e=>e.code==='conversation_owner_mismatch');assert.equal(foreignCalls.length,1);
 const {api:unknown}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:[]}));const unverified=await unknown.inspectJobFiles({conversationId:row.id,jobId});assert.equal(unverified.conversation.output.exists,null);assert.equal(unverified.conversation.output.errorCode,'file_list_unverified');
});

test('conversation manifest reads official JSON content as text only and never guesses binary decoding or external paths',async()=>{
 const manifest={version:1,jobId,kind:'production',creatives:[]},path=`${output}/manifest.json`;
 const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({path,content:JSON.stringify(manifest),language:'json',session_api_key:secret}));
 assert.deepEqual(await api.readConversationManifest({conversationId:row.id,relativePath:path}),manifest);assert.equal(calls[1].url.pathname,`/api/v1/conversations/${row.id}/files/${encodeURIComponent(path)}`);assert.ok(calls.every(c=>c.options.method==='GET'));
 const before=calls.length;for(const relativePath of [`${output}/../private`,`${output}/image.png`,'https://external.invalid/manifest.json'])await assert.rejects(api.readConversationManifest({conversationId:row.id,relativePath}),e=>['invalid_artifact_path','invalid_manifest_path'].includes(e.code));assert.equal(calls.length,before);
 for(const response of [{path:'wrong/manifest.json',content:JSON.stringify(manifest)},{path,content:'Done.'},{path,content:Buffer.from(JSON.stringify(manifest)).toString('base64')}]){
  const {api:invalid}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json(response));await assert.rejects(invalid.readConversationManifest({conversationId:row.id,relativePath:path}),e=>e.code==='invalid_manifest');
 }
});

test('delivery report reads observed finish/error fields only and redacts credentials without claiming actual delivery',async()=>{
 const jwt='eyJheaderabcdefgh.eyJpayloadabcdefgh.signatureabcdefgh',apiKey='sk-proj-abcdefgh123456',events=[
  {id:'older',kind:'ActionEvent',source:'agent',timestamp:'2026-10-14T11:00:00Z',action:{kind:'FinishAction',message:'old completion'}},
  {id:'latest',kind:'ActionEvent',source:'agent',timestamp:'2026-10-14T11:01:00Z',action:{kind:'FinishAction',message:`素材未交付：文件工具不可用。Bearer ${secret} api_key="${apiKey}" JWT ${jwt}`,args:{arbitrary:'must-not-leak'}}},
  {id:'agent-error',kind:'AgentErrorEvent',timestamp:'2026-10-14T11:00:59Z',error:`model permission denied; session_api_key=${secret}`},
  {id:'tool-error',kind:'ObservationEvent',timestamp:'2026-10-14T11:00:58Z',observation:{kind:'MCPToolObservation',is_error:true,content:[{type:'text',text:`rendering unavailable password='other-private-password'`},{type:'image',image_url:'must-not-leak'}],args:{private:'must-not-leak'}}},
  {id:'terminal-error',kind:'ObservationEvent',timestamp:'2026-10-14T11:00:57Z',observation:{kind:'TerminalObservation',exit_code:1,content:[{type:'text',text:'FileNotFoundError: current input unavailable'}],command:'print all settings must-not-leak',metadata:{env:{private:'must-not-leak'}}}},
  {id:'normal-user',kind:'MessageEvent',source:'user',llm_message:{content:'must-not-leak user prompt'}},
 ];
 const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:events}));
 const report=await api.getDeliveryReport({conversationId:row.id,jobId});assert.equal(calls.length,3);assert.ok(calls.every(c=>c.options.method==='GET'));assert.equal(calls[1].url.searchParams.get('limit'),'100');assert.equal(report.latestFinish.eventId,'latest');assert.ok(report.latestFinish.message.includes('文件工具不可用'));assert.equal(report.errors.length,3);assert.equal(report.errors.at(-1).exitCode,1);assert.equal(report.successfulDeliveryVerified,false);
 assert.equal(Object.hasOwn(report,'recentToolResults'),false);
 assert.equal(report.latestAgentMessage,null);
 for(const hidden of [secret,jwt,apiKey,'other-private-password','must-not-leak'])assert.equal(JSON.stringify(report).includes(hidden),false,hidden);
});

test('delivery report reads only the latest agent assistant message, with bounded redacted text and no success inference',async()=>{
 const jwt='eyJheaderabcdefgh.eyJpayloadabcdefgh.signatureabcdefgh',apiKey='sk-proj-abcdefgh123456';
 const message=`视频已生成，清单路径仍需修复。 Bearer ${secret}; api_key="${apiKey}"; password='private-password'; ${jwt}\n${'续'.repeat(3000)}`;
 for(const messageContent of [message,[{type:'text',text:message},{type:'image',image_url:'must-not-leak'},{type:'tool',text:'must-not-leak'}]]){
  const events=[
   {id:'older',timestamp:'2026-10-14T13:56:00Z',kind:'MessageEvent',source:'agent',llm_message:{role:'assistant',content:'older message must-not-leak'}},
   {id:'latest',timestamp:'2026-10-14T13:57:19Z',kind:'MessageEvent',source:'agent',llm_message:{role:'assistant',content:messageContent,metadata:{secret:'must-not-leak'}}},
   {id:'user',timestamp:'2026-10-14T13:58:00Z',kind:'MessageEvent',source:'user',llm_message:{role:'assistant',content:'must-not-leak'}},
   {id:'tool',timestamp:'2026-10-14T13:59:00Z',kind:'MessageEvent',source:'agent',llm_message:{role:'tool',content:'must-not-leak'}},
  ];
  const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:events}));
  const report=await api.getDeliveryReport({conversationId:row.id,jobId});
  assert.equal(report.latestAgentMessage.eventId,'latest');assert.equal(report.latestAgentMessage.timestamp,'2026-10-14T13:57:19.000Z');assert.equal(report.latestAgentMessage.message.length,2000);assert.ok(report.latestAgentMessage.message.startsWith('视频已生成，清单路径仍需修复。'));
  assert.equal(report.latestFinish,null);assert.equal(report.successfulDeliveryVerified,false);assert.equal(calls.length,3);assert.ok(calls.every(c=>c.options.method==='GET'));
  for(const hidden of [secret,jwt,apiKey,'private-password','must-not-leak'])assert.equal(JSON.stringify(report).includes(hidden),false,hidden);
 }
});

test('long agent errors retain a bounded validation tail after complete credential redaction; short errors keep their shape',async()=>{
 const jwt='eyJheaderabcdefgh.eyJpayloadabcdefgh.signatureabcdefgh',password='private-password-spanning-tail-boundary',apiKey='sk-proj-abcdefgh123456';
 const reason='ValidationError: command must be create; unexpected parameter file_text';
 const events=[
  {id:'long-error',kind:'AgentErrorEvent',error:`Error validating args ${'render_frame(); '.repeat(400)}\nBearer ${secret}; password="${password}"; api_key=${apiKey}; ${jwt}\n${reason}`},
  // A raw tail slice would expose the end of these secrets without their label.
  {id:'token-boundary',kind:'AgentErrorEvent',error:`${'x'.repeat(4000)} ${secret}${'Z'.repeat(1190)}`},
  {id:'password-boundary',kind:'AgentErrorEvent',error:`${'x'.repeat(4000)} password="${password}" ${'Y'.repeat(1190)}`},
  {id:'short-error',kind:'AgentErrorEvent',error:`validation failed; password='${password}'`},
  {id:'exact-limit',kind:'AgentErrorEvent',error:'x'.repeat(2000)},
 ];
 const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:events}));
 const report=await api.getDeliveryReport({conversationId:row.id,jobId}),byId=new Map(report.errors.map(error=>[error.eventId,error]));
 const long=byId.get('long-error');assert.equal(long.message.length,2000);assert.equal(long.detailTail.length,1200);assert.ok(long.detailTail.endsWith(reason));assert.ok(long.detailTail.includes('[redacted]'));
 assert.ok(report.errors.every(error=>error.message.length<=2000&&(!Object.hasOwn(error,'detailTail')||error.detailTail.length<=1200)));
 for(const hidden of [secret,secret.slice(-10),password,password.slice(-10),apiKey,jwt])assert.equal(JSON.stringify(report).includes(hidden),false,hidden);
 assert.deepEqual(byId.get('short-error'),{eventId:'short-error',timestamp:null,kind:'AgentErrorEvent',message:'validation failed; password=[redacted]'});
 assert.equal(Object.hasOwn(byId.get('exact-limit'),'detailTail'),false);
 assert.equal(report.successfulDeliveryVerified,false);assert.ok(calls.every(call=>call.options.method==='GET'));
});

test('opt-in terminal diagnostics are bounded read-only media observations, with commands and credentials removed',async()=>{
 const events=Array.from({length:8},(_,i)=>({id:`terminal-${i}`,timestamp:`2026-10-14T11:00:0${i}Z`,kind:'ObservationEvent',observation:{kind:i%2?'TerminalObservation':'ExecuteBashObservation',exit_code:0,content:`ffmpeg version 6.1 encoder libx264 ${'x'.repeat(1000)}`}}));
 events[7].observation={kind:'TerminalObservation',exit_code:0,command:'python -c "print(ffmpeg)"',content:`python -c "print(ffmpeg)"\nPython 3.11; Pillow installed\nffmpeg version 6.1; api_key="sk-proj-abcdefgh123456"; Bearer ${secret}\nPRIVATE_DATA=ffmpeg-env-must-not-leak\nother private text must-not-leak`,metadata:{environment:{private:'must-not-leak'}}};
 events[6].observation={kind:'ExecuteBashObservation',metadata:{exit_code:1,command:'must-not-leak'},content:[{type:'text',text:'ModuleNotFoundError: No module named av; password="private-password"'},{type:'image',image_url:'must-not-leak'}]};
 events.push({id:'excluded',timestamp:'2026-10-14T11:01:00Z',kind:'ObservationEvent',observation:{kind:'MCPToolObservation',content:'ffmpeg must-not-leak'}});
 const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:events}));
 const report=await api.getDeliveryReport({conversationId:row.id,jobId,includeToolResults:true});
 assert.equal(report.recentToolResults.length,6);assert.deepEqual(report.recentToolResults.map(r=>r.eventId),['terminal-7','terminal-6','terminal-5','terminal-4','terminal-3','terminal-2']);
 assert.equal(report.recentToolResults[0].exitCode,0);assert.equal(report.recentToolResults[1].exitCode,1);assert.ok(report.recentToolResults[0].message.includes('Pillow installed'));assert.ok(report.recentToolResults[1].message.includes('No module named av'));assert.ok(report.recentToolResults.every(r=>r.message.length<=800));
 assert.equal(calls.length,3);assert.ok(calls.every(c=>c.options.method==='GET'));assert.deepEqual(calls.map(c=>c.url.pathname),['/api/v1/app-conversations',`/api/v1/conversation/${row.id}/events/search`,'/api/v1/agents']);
 for(const hidden of [secret,'sk-proj-abcdefgh123456','private-password','must-not-leak','print(ffmpeg)'])assert.equal(JSON.stringify(report).includes(hidden),false,hidden);
 assert.equal(report.successfulDeliveryVerified,false);
});

test('opt-in terminal diagnostics validate identifiers and exit codes and retain ownership preflight',async()=>{
 const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:[{id:'invalid/id',timestamp:'invalid-time',kind:'ObservationEvent',observation:{kind:'TerminalObservation',exit_code:999999,timeout:true,content:'ffmpeg timed out'}}]}));
 const report=await api.getDeliveryReport({conversationId:row.id,jobId,includeToolResults:true});assert.deepEqual(report.recentToolResults,[{eventId:null,timestamp:null,kind:'TerminalObservation',exitCode:null,message:'ffmpeg timed out',timedOut:true}]);
 const ordinary=await api.getDeliveryReport({conversationId:row.id,jobId,includeToolResults:'true'});assert.equal(Object.hasOwn(ordinary,'recentToolResults'),false);assert.ok(calls.every(c=>c.options.method==='GET'));
 const {api:foreign,calls:foreignCalls}=client(()=>json([{...row,created_by_user_id:'another-user'}]));await assert.rejects(foreign.getDeliveryReport({conversationId:row.id,jobId,includeToolResults:true}),e=>e.code==='conversation_owner_mismatch');assert.equal(foreignCalls.length,1);
});

test('delivery report rejects unowned or unbounded queries and does not invent a finish message',async()=>{
 const {api,calls}=client(()=>json([{...row,created_by_user_id:'other'}]));await assert.rejects(api.getDeliveryReport({conversationId:row.id,jobId}),e=>e.code==='conversation_owner_mismatch');assert.equal(calls.length,1);
 const before=calls.length;await assert.rejects(api.getDeliveryReport({conversationId:row.id,jobId:'../root'}),e=>e.code==='invalid_job');assert.equal(calls.length,before);
 const events=[{id:'finish',source:'agent',kind:'ActionEvent',action:{kind:'FinishAction'}},...Array.from({length:6},(_,i)=>({id:`error-${i}`,kind:'AgentErrorEvent',error:'x'.repeat(5000)}))];
 const {api:bounded}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:events}));const report=await bounded.getDeliveryReport({conversationId:row.id,jobId});assert.equal(report.latestFinish.message,null);assert.equal(report.errors.length,5);assert.ok(report.errors.every(e=>e.message.length<=2000));
 const {api:huge}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):json({items:Array.from({length:101},()=>({kind:'AgentErrorEvent',error:'x'}))}));await assert.rejects(huge.getDeliveryReport({conversationId:row.id,jobId}),e=>e.code==='unexpected_response');
});

const executionAgents=[{id:'PlanAgent',name:'规划',description:'仅计划',capabilities:['制定计划与搜索'],available:true},{id:'CodeActAgent',name:'执行',description:'可读写文件和执行代码',capabilities:['代码编写','调试执行'],available:true}];
test('future market conversations never inherit PlanAgent and select only an observed executing agent without policy changes',async()=>{
 const {api,calls}=client((url,options)=>url.pathname==='/api/v1/agents'?json(executionAgents):url.pathname.endsWith('/mine')?json({items:[]}):url.pathname==='/api/nodes'?json(onlineNodes):options.method==='GET'?json([{...row,agent_type:'PlanAgent',participants:[{type:'agent',is_primary:true,node_id:row.node_id}]}]):json({id:'start-task'}));
 await api.createConversation({employee,jobId});const post=calls.find(c=>c.options.method==='POST'),payload=JSON.parse(post.options.body);assert.equal(payload.agent_type,'CodeActAgent');assert.equal(payload.enable_plan_mode,false);assert.equal(payload.employee_id,row.employee_id);assert.equal(payload.node_id,row.node_id);assert.equal(payload.selected_repository,row.selected_repository);assert.equal(payload.enable_review_after_finish,undefined);assert.equal(payload.approval_policy,undefined);assert.equal(payload.initial_message,undefined);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
 const {api:unavailable,calls:blocked}=client(url=>url.pathname==='/api/v1/agents'?json([{...executionAgents[1],available:false}]):url.pathname.endsWith('/mine')?json({items:[]}):url.pathname==='/api/nodes'?json(onlineNodes):json([{...row,agent_type:'PlanAgent',participants:[{type:'agent',is_primary:true,node_id:row.node_id}]}]));await assert.rejects(unavailable.createConversation({employee,jobId}),e=>e.code==='execution_agent_unavailable');assert.equal(blocked.some(c=>c.options.method==='POST'),false);
});

test('execution switch uses the official owned task API once, then verifies unchanged employee and executable agent by readback',async()=>{
 let switched=false;const task={...row,title:`广告任务 · ${jobId}`,agent_type:'PlanAgent'};
 const {api,calls}=client((url,options)=>{if(url.pathname==='/api/v1/agents')return json(executionAgents);if(options.method==='POST'){assert.equal(url.pathname,'/api/v1/agents/switch');assert.deepEqual(JSON.parse(options.body),{agent_type:'CodeActAgent',conversation_id:row.id});switched=true;return json({agent_type:'CodeActAgent',message:secret});}return json([{...task,agent_type:switched?'CodeActAgent':'PlanAgent'}]);});
 const receipt=await api.switchExecutionAgent({conversationId:row.id,employeeId:row.employee_id,jobId});assert.equal(receipt.executionModeVerified,true);assert.equal(receipt.agentType,'CodeActAgent');assert.equal(receipt.employeeId,row.employee_id);assert.equal(receipt.switched,true);assert.equal(JSON.stringify(receipt).includes(secret),false);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);assert.equal(calls.some(c=>/policy|config|install|renew/.test(c.url.pathname)),false);
 const again=await api.ensureExecutionAgent({conversationId:row.id,employeeId:row.employee_id,jobId});assert.equal(again.switched,false);assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});

test('execution switch preflight proves non-write while lost or mismatched write outcomes remain uncertain',async()=>{
 const task={...row,title:`广告任务 · ${jobId}`,agent_type:'PlanAgent'};
 for(const variant of ['foreign-owner','wrong-title','wrong-employee','unavailable-agent','network','readback']){
  let posts=0;const {api}=client((url,options)=>{if(url.pathname==='/api/v1/agents')return json(variant==='unavailable-agent'?[]:executionAgents);if(options.method==='POST'){posts++;if(variant==='network')throw new Error(secret);return json({agent_type:'CodeActAgent'});}return json([{...task,created_by_user_id:variant==='foreign-owner'?'other':subject,title:variant==='wrong-title'?'employee source':task.title,employee_id:variant==='wrong-employee'?'other':row.employee_id,agent_type:posts&&variant!=='readback'?'CodeActAgent':'PlanAgent'}]);});
  await assert.rejects(api.switchExecutionAgent({conversationId:row.id,employeeId:row.employee_id,jobId}),e=>{assert.equal(e.writeSent,['network','readback'].includes(variant));assert.equal(e.uncertain,['network','readback'].includes(variant));assert.equal(e.message.includes(secret),false);return true;});assert.equal(posts,['network','readback'].includes(variant)?1:0);
 }
});

test('remote input reads only owned current UUID files or brief, with actual bounded binary bytes',async()=>{
 const path=`${input}/${jobId}.txt`,bytes=new TextEncoder().encode('actual input');const {api,calls}=client(url=>url.pathname==='/api/v1/app-conversations'?json([row]):new Response(bytes));
 const response=await api.readJobInput({conversation:{id:row.id,selected_repository:'forged'},relativePath:path});assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);assert.equal(calls[1].url.pathname,`/api/nodes/${row.node_id}/file/download-relative/${path}`);assert.equal(calls[1].url.searchParams.get('project_name'),row.selected_repository);assert.equal(calls[1].options.headers['X-User-Id'],subject);
 const before=calls.length;for(const relativePath of [`${input}/arbitrary.txt`,`${input}/subdir/brief.json`,`${output}/brief.json`,`${input}/../secret`])await assert.rejects(api.readJobInput({conversation:row,relativePath}),e=>e.code==='invalid_input_path');assert.equal(calls.length,before);
 const {api:foreign,calls:foreignCalls}=client(()=>json([{...row,created_by_user_id:'other'}]));await assert.rejects(foreign.readJobInput({conversation:row,relativePath:path}),e=>e.code==='conversation_owner_mismatch');assert.equal(foreignCalls.length,1);
});

test('live agent capability labels remain labels; execution tools identify the official default definition rather than runtime permission',async()=>{
 const {api,calls}=client(()=>json([...executionAgents,{id:'AgiAgent',name:'AGI',capabilities:[],available:false,api_key:secret,config:{secret}}]));
 const agents=await api.listExecutionAgents(),code=agents.find(a=>a.type==='CodeActAgent');assert.deepEqual(code.capabilities,['代码编写','调试执行']);assert.deepEqual(code.tools,['terminal','file_editor','task_tracker','browser_tool_set']);assert.equal(code.toolsBasis,'official_agent_definition');assert.equal(code.registered,true);assert.equal(code.runtimeToolsVerified,false);assert.equal(agents.find(a=>a.type==='AgiAgent').available,false);assert.equal(JSON.stringify(agents).includes(secret),false);assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/api/v1/agents');assert.equal(calls[0].options.method,'GET');
});
