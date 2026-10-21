import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createBxagiOrchestrator, chooseBxagiEmployee, scoreBxagiMarketEmployee, syncDueBxagiJobs, isCollectableBxagiProductionJob, isAutomaticallyRecoverableBxagiProductionJob, bxagiProductionCollectionEligibility } from '../server/bxagi-orchestrator.mjs';
import { BxagiProtocolError } from '../server/bxagi-workforce.mjs';
import { createBxagiSessionRepository } from '../server/bxagi-session-repository.mjs';
import { encryptConnectionSecrets } from '../server/adapters/connection-secrets.mjs';
import { publicMarketSelection } from '../server/bxagi-market-eligibility.mjs';
import { workflowFontResources } from '../server/bxagi-workflow-font.mjs';

// Exercise deployment SQL and the production repository instead of mocking owner scope.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const directory = new URL('../drizzle/', import.meta.url);
  const migrations = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  assert.ok(migrations.length);
  for (const name of migrations) sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  return { sqlite, prepare(sql) {
    const statement = sqlite.prepare(sql);
    return { bind(...args) { return {
      async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { return { meta: { changes: Number(statement.run(...args).changes) } }; },
    }; } };
  } };
}
function bucket() {
  const values = new Map();
  return { values, async put(key, body, options = {}) {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    values.set(key, { bytes, options });
    return { size: bytes.length };
  }, async get(key) {
    const entry = values.get(key);
    if (!entry) return null;
    return { size: entry.bytes.length, body: new Blob([entry.bytes]).stream(),
      async arrayBuffer() { return entry.bytes.slice().buffer; } };
  }, async delete(key) { values.delete(key); } };
}
function actualPng(width=24,height=24) {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, body) => { const content = Buffer.concat([Buffer.from(name), body]), header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(body.length); tail.writeUInt32BE(crc(content)); return Buffer.concat([header, content, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 4 + 1) + 1 + x * 4; pixels[offset] = 220; pixels[offset + 1] = 60; pixels[offset + 2] = 90; pixels[offset + 3] = 255; }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}
const png = actualPng();
const userId = 'native-owner-a';
const context = { nativeUserId: userId, subject: 'verified-bxagi-account', profile: { id: 'verified-bxagi-account', displayName: '测试账户' }, accessToken: 'test-token-never-export', sessionId: 'server-session' };
async function fixture() {
  const env = { DB: database(), BUCKET: bucket(), APP_ENCRYPTION_KEY: '46'.repeat(32) };
  const repository = createPlatformRepository(env.DB);
  const project = await repository.createProject(userId, { title: '服装素材', productName: '棉质上衣', scene: 'apparel', facts: ['纯棉面料', '提供三个尺码'], objective: 'purchase', productionEmployeeId: 'legacy-apparel', assignment: {} });
  const sourceKey = `owners/${userId}/source.png`;
  await env.BUCKET.put(sourceKey, png);
  const asset = await repository.createAsset(userId, { projectId: project.id, filename: '上衣.png', mimeType: 'image/png', size: png.length, objectKey: sourceKey });
  return { env, repository, project, asset, context: { ...context }, bucket: env.BUCKET };
}

// Normalized adapter contract fixture; protocol verification belongs to workforce tests.
function workforceFixture({ manifest, artifact = png, artifactMime = 'image/png', sendError, startStatus = 'READY', executionStatus = 'RUNNING' } = {}) {
  const calls = [];
  const files = new Map();
  const employees = [
    { id: 'bxagi:market:creative_employee', providerId: 'creative_employee', marketId:'creative_employee',resourceType:'installed_employee',marketVerified:true,activationState:'ready',sourceVerified:true,name: '服装素材优化员工', provider: 'bxagi', roleCandidates: ['production'], sceneKeywords: ['服装', 'apparel'], usable: true, conversationId: 'hired-creative', memorySpaceName: 'owner-memory', routingBasis: 'provider_metadata', liveVerified: false },
    { id: 'bxagi:market:buying_employee', providerId: 'buying_employee', marketId:'buying_employee',resourceType:'installed_employee',marketVerified:true,activationState:'ready',sourceVerified:true,name: '广告投放员工', provider: 'bxagi', roleCandidates: ['buying'], sceneKeywords: [], usable: true, conversationId: 'hired-buyer', memorySpaceName: 'owner-memory', routingBasis: 'provider_metadata', liveVerified: false },
  ];
  let jobId;
  let selectedEmployeeId;
  const api = {
    async listEmployees() { calls.push({ action: 'catalog' }); return employees; },
    async createConversation(input) { calls.push({ action: 'create', input }); jobId = input.jobId; selectedEmployeeId = input.employee.providerId; return { startTaskId: 'fixture-start-task', liveVerified: false }; },
    async getStartTask(id) { calls.push({ action: 'start-status', id }); return { startTaskId: id, status: startStatus, conversationId: startStatus === 'READY' ? 'dedicated-conversation' : null, liveVerified: false }; },
    async getConversation(id) { calls.push({ action: 'conversation', id }); return { id, employee_id: selectedEmployeeId, node_id: 'authorized-node', selected_repository: 'owner-project', memory_space_name: 'owner-memory', execution_status: executionStatus }; },
    async uploadFile(input) { const bytes = new Uint8Array(await input.blob.arrayBuffer()); calls.push({ action: 'upload', ...input, blob: undefined, bytes }); const relativePath = `${input.directory}/${input.filename}`; files.set(relativePath, bytes); return { relativePath, transportStatus: 200, liveVerified: false }; },
    async sendMessage(conversationId, prompt) { calls.push({ action: 'prompt', conversationId, prompt }); if (sendError) throw sendError; return { transportStatus: 200, liveVerified: false }; },
    async getEvents(id) { calls.push({ action: 'events', id }); return []; },
    async readManifest(input) { calls.push({ action: 'manifest', ...input }); if (manifest instanceof Error) throw manifest; return typeof manifest === 'function' ? manifest(jobId) : manifest; },
    async readArtifact(input) { calls.push({ action: 'artifact', ...input }); return new Response(artifact, { headers: { 'Content-Type': artifactMime } }); },
  };
  return { api, calls, files, employees, jobId: () => jobId };
}
async function synchronise(orchestrator, id, count = 20) {
  let result;
  for (let step = 0; step < count; step++) {
    result = await orchestrator.syncJob(id);
    if (['completed', 'failed', 'blocked', 'needs_reconciliation', 'awaiting_user_input'].includes(result.job.status)) break;
  }
  return result;
}
async function pollUntil(orchestrator, id, predicate, count = 20) {
  let result;
  for (let step = 0; step < count; step++) {
    result = await orchestrator.syncJob(id);
    if (predicate(result)) return result;
  }
  assert.fail(`Expected workflow stage not reached within ${count} polls: ${result?.job?.status}`);
}
function orchestrator(f, remote, overrides = {}) {
  return createBxagiOrchestrator({ repository: f.repository, bucket: f.bucket, env: f.env, context: f.context, workforce: remote.api, ...overrides });
}
function productionManifest(f, id, patch = {}) {
  return { version: 1, jobId: id, kind: 'production', creatives: [{ path: `bxagi-advertising/${id}/output/creative.png`, filename: 'creative.png', mimeType: 'image/png', title: '纯棉上衣素材', format: 'square', sourceAssetIds: [f.asset.id], factsUsed: ['纯棉面料'] }], ...patch };
}
async function collectionFixture({manifest,artifact=png}={}){
  const f=await fixture(),remote=workforceFixture({manifest:id=>productionManifest(f,id),artifact}),workflow=orchestrator(f,remote);
  const submitted=await workflow.submitProduction(f.project);
  await pollUntil(workflow,submitted.job.id,result=>!!result.job.details.messageSentAt);
  const job=await f.repository.getJob(userId,submitted.job.id),expiry='2000-01-01T00:00:00.000Z';
  await f.repository.updateJob(userId,job.id,{details:{...job.details,messageAcknowledged:true,messageEventId:'confirmed-user-event',automationProbeExpiresAt:expiry}});
  f.env.DB.sqlite.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({automationProbeExpiresAt:expiry}),f.asset.id);
  const conversation=remote.api.getConversation;
  remote.api.getConversation=async id=>({...await conversation(id),created_by_user_id:context.subject});
  if(manifest)remote.api.readManifest=async input=>{remote.calls.push({action:'manifest',...input});if(manifest instanceof Error)throw manifest;return manifest(job.id);};
  for(const method of ['createConversation','getStartTask','ensureRuntime','uploadFile','sendMessage'])remote.api[method]=async()=>{remote.calls.push({action:'FORBIDDEN:'+method});assert.fail('Collection must not invoke '+method);};
  remote.calls.length=0;
  return {...f,remote,workflow,job:await f.repository.getJob(userId,job.id)};
}

test('collect-only recovers actual PNG after dispatch expiry with no remote write or runtime-start calls',async()=>{
  const f=await collectionFixture();
  try{
    await assert.rejects(f.workflow.syncJob(f.job.id),error=>error.code==='automation_probe_expired');
    assert.deepEqual(f.remote.calls,[]);
    const result=await f.workflow.collectProduction(f.job.id);
    assert.equal(result.collectionOnly,true);assert.equal(result.job.status,'completed');assert.equal(result.creatives.length,1);
    const creative=await f.repository.getCreative(userId,result.creatives[0].id);
    assert.deepEqual(new Uint8Array(await(await f.bucket.get(creative.objectKey)).arrayBuffer()),png);
    assert.equal(creative.metadata.sourceJobId,f.job.id);assert.equal(creative.metadata.semanticValidated,false);
    assert.deepEqual(f.remote.calls.map(call=>call.action),['catalog','conversation','conversation','manifest','artifact']);
    await f.workflow.collectProduction(f.job.id);
    assert.equal((await f.repository.listCreatives(userId)).length,1);
  }finally{f.env.DB.sqlite.close();}
});

test('valid current entitlement can retrieve completed files while its execution node is offline',async()=>{
  const f=await collectionFixture();
  try{
    Object.assign(f.remote.employees[0],{usable:false,entitlementVerified:true,availability:'node_offline'});
    await f.repository.updateJob(userId,f.job.id,{status:'failed',details:{...f.job.details,lastErrorCode:'bxagi_market_employee_activation_required',lastErrorStatus:409}});
    const result=await f.workflow.collectProduction(f.job.id);
    assert.equal(result.job.status,'completed');assert.equal(result.job.id,f.job.id);assert.equal(result.job.details.delivery.expectedCount,1);
    assert.deepEqual(result.job.details.delivery.expected,[{filename:'creative.png',mimeType:'image/png'}]);
    assert.equal(f.remote.calls.some(call=>call.action.startsWith('FORBIDDEN:')),false);
  }finally{f.env.DB.sqlite.close();}
});

test('offline read recovery never accepts expired rights, a foreign source or missing entitlement',async()=>{
  for(const patch of [{installation:{status:'expired'}},{sourceVerified:false},{entitlementVerified:false}]){
    const f=await collectionFixture();
    try{
      Object.assign(f.remote.employees[0],{usable:false,entitlementVerified:true,availability:'node_offline',...patch});
      const result=await f.workflow.collectProduction(f.job.id);
      assert.equal(result.job.status,'awaiting_result');assert.equal(result.job.details.lastErrorCode,'bxagi_collection_authorization_required');assert.equal(result.job.details.lastErrorStatus,403);
      assert.equal(f.remote.calls.some(call=>['manifest','artifact'].includes(call.action)||call.action.startsWith('FORBIDDEN:')),false);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('automatic historical recovery accepts only safe acknowledged transient failures and honors retry deadlines',async()=>{
  const f=await collectionFixture();
  try{
    const job=await f.repository.updateJob(userId,f.job.id,{status:'failed',details:{...f.job.details,lastErrorCode:'bxagi_market_employee_activation_required',lastErrorStatus:409}});
    assert.equal(isAutomaticallyRecoverableBxagiProductionJob(job),true);
    assert.deepEqual((await f.repository.listDueBxagiJobs()).map(row=>row.id),[job.id]);
    for(const details of [{lastErrorStatus:401},{lastErrorStatus:403},{lastErrorCode:'bxagi_invalid_manifest'},{messageAcknowledged:false},{remoteWritePending:'send_instruction'},{videoFormatRepair:{phase:'needs_reconciliation',messageAcknowledged:true}}])assert.equal(isAutomaticallyRecoverableBxagiProductionJob({...job,details:{...job.details,...details}}),false);
    await f.repository.updateJob(userId,job.id,{details:{...job.details,recovery:{attempt:1,nextRetryAt:'2099-01-01T00:00:00Z'}}});assert.deepEqual(await f.repository.listDueBxagiJobs(),[]);
    await f.repository.updateJob(userId,job.id,{details:{...job.details,recovery:{attempt:1,nextRetryAt:'2000-01-01T00:00:00Z'}}});assert.deepEqual((await f.repository.listDueBxagiJobs()).map(row=>row.id),[job.id]);
  }finally{f.env.DB.sqlite.close();}
});

test('known node outage waits before any write and resumes the same task after its retry deadline',async()=>{
  const f=await fixture(),remote=workforceFixture(),workflow=orchestrator(f,remote);
  try{
    const {job}=await workflow.submitProduction(f.project);
    Object.assign(remote.employees[0],{usable:false,entitlementVerified:true,availability:'node_offline'});
    const paused=await workflow.syncJob(job.id);assert.equal(paused.job.status,'awaiting_result');assert.equal(paused.job.details.lastErrorCode,'bxagi_node_offline');assert.equal(paused.job.details.recovery.attempt,1);assert.ok(Date.parse(paused.job.details.recovery.nextRetryAt)>Date.now());assert.equal(remote.calls.some(call=>call.action==='create'),false);
    Object.assign(remote.employees[0],{usable:true,availability:'ready'});
    assert.equal((await workflow.syncJob(job.id)).waitingForRecovery,true);assert.equal(remote.calls.some(call=>call.action==='create'),false);
    await f.repository.updateJob(userId,job.id,{details:{...paused.job.details,recovery:{...paused.job.details.recovery,nextRetryAt:'2000-01-01T00:00:00Z'}}});
    const resumed=await workflow.syncJob(job.id);assert.equal(resumed.job.id,job.id);assert.ok(resumed.job.details.startTaskId);assert.equal(resumed.job.details.recovery,null);assert.equal(remote.calls.filter(call=>call.action==='create').length,1);
  }finally{f.env.DB.sqlite.close();}
});
test('node loss during create preflight is a retryable unsent operation and never becomes an unknown remote write',async()=>{
  const f=await fixture(),remote=workforceFixture(),workflow=orchestrator(f,remote);
  try{
    const {job}=await workflow.submitProduction(f.project);
    remote.api.createConversation=async()=>{Object.assign(remote.employees[0],{usable:false,entitlementVerified:true,availability:'node_offline'});throw Object.assign(new Error('preflight employee unavailable'),{status:409,code:'employee_unavailable'});};
    const result=await workflow.syncJob(job.id);assert.equal(result.job.status,'awaiting_result');assert.equal(result.job.details.lastErrorCode,'bxagi_node_offline');assert.equal(result.job.details.remoteWritePending,null);assert.equal(result.job.details.startTaskId,undefined);
  }finally{f.env.DB.sqlite.close();}
});
test('offline manifest absence does not misreport terminal delivery and validated expected files survive a later download outage',async()=>{
  const f=await collectionFixture({manifest:new BxagiProtocolError('not_found','missing',404)});
  try{
    Object.assign(f.remote.employees[0],{usable:false,entitlementVerified:true,availability:'node_offline'});
    f.remote.api.getEvents=async()=>assert.fail('Offline manifest cannot establish terminal missing delivery from old events');
    const waiting=await f.workflow.collectProduction(f.job.id);assert.equal(waiting.job.status,'awaiting_result');assert.equal(waiting.job.details.lastErrorCode,'bxagi_node_offline');assert.equal(waiting.job.details.recovery.attempt,1);
    f.remote.api.readManifest=async()=>productionManifest(f,f.job.id);f.remote.api.readArtifact=async()=>{throw Object.assign(new Error('file transport unavailable'),{status:502,code:'upstream_unavailable'});};
    const download=await f.workflow.collectProduction(f.job.id);assert.equal(download.job.status,'awaiting_result');assert.deepEqual(download.job.details.delivery.expected,[{filename:'creative.png',mimeType:'image/png'}]);assert.equal(download.job.details.recovery.attempt,2);
  }finally{f.env.DB.sqlite.close();}
});

test('a failed owned acknowledged production can retry collection after any previous read error without resetting or redispatching',async()=>{
  for(const code of ['conversation_not_found','upstream_request_failed','bxagi_invalid_manifest','bxagi_invalid_video_repair_manifest','unrecognized_read_failure']){
    const f=await collectionFixture();
    try{
      const failed=await f.repository.updateJob(userId,f.job.id,{status:'failed',details:{...f.job.details,lastErrorCode:code,lastErrorStatus:404,lastError:'private prior upstream error'}});
      assert.equal(isCollectableBxagiProductionJob(failed),true);
      const eligibility=bxagiProductionCollectionEligibility(failed,{userId,subject:context.subject});assert.equal(eligibility.eligible,true);assert.deepEqual(eligibility.blockers,[]);assert.equal(eligibility.actualFilesVerified,false);assert.ok(!JSON.stringify(eligibility).includes('private'));
      // Merely asking about eligibility never clears or changes the failed job.
      assert.equal((await f.repository.getJob(userId,f.job.id)).status,'failed');assert.deepEqual(f.remote.calls,[]);
      const collected=await f.workflow.collectProduction(f.job.id);assert.equal(collected.job.status,'completed',code);assert.equal(collected.collectionOnly,true);assert.equal(collected.creatives.length,1);
      assert.equal(f.remote.calls.some(call=>call.action.startsWith('FORBIDDEN:')),false);assert.equal(collected.job.id,failed.id);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('an actual collection read failure can recover on the same job when the owned conversation becomes readable',async()=>{
  const f=await collectionFixture();
  try{
    const getConversation=f.remote.api.getConversation;f.remote.api.getConversation=async()=>{throw new BxagiProtocolError('conversation_not_found','temporarily unavailable',404);};
    const first=await f.workflow.collectProduction(f.job.id);assert.equal(first.job.status,'failed');assert.equal(first.job.details.lastErrorCode,'conversation_not_found');assert.equal((await f.repository.listCreatives(userId)).length,0);
    f.remote.api.getConversation=getConversation;const recovered=await f.workflow.collectProduction(f.job.id);assert.equal(recovered.job.status,'completed');assert.equal(recovered.job.id,first.job.id);assert.equal(recovered.job.details.messageEventId,'confirmed-user-event');
    assert.equal(f.remote.calls.some(call=>call.action.startsWith('FORBIDDEN:')),false);
  }finally{f.env.DB.sqlite.close();}
});

test('failed collection eligibility still rejects missing evidence, all nested uncertain writes and foreign scope without remote reads',async()=>{
  const patches=[{messageAcknowledged:false},{inputsReady:false},{briefUploaded:false},{startTaskId:null},{conversationId:null},{remoteWritePending:'send_instruction'},{outcomeUnknown:true},{remoteOutcomeUnknown:true},{dispatchOutcomeUnknown:true},{uncertain:true},
    ...['coordination','deliveryRepair','visualRepair','videoFormatRepair'].flatMap(key=>[{[key]:{remoteWritePending:'awaiting_remote_receipt'}},{[key]:{phase:'needs_reconciliation'}},{[key]:{outcomeUnknown:true}},{[key]:{phase:'sending'}}]),
    {coordination:{dispatchAcceptedObserved:true,dispatchAccepted:false}}];
  for(const patch of patches){
    const f=await collectionFixture();
    try{
      const failed=await f.repository.updateJob(userId,f.job.id,{status:'failed',details:{...f.job.details,lastErrorCode:'upstream_request_failed',...patch}});
      const eligibility=bxagiProductionCollectionEligibility(failed,{userId,subject:context.subject});assert.equal(eligibility.eligible,false,JSON.stringify(patch));assert.ok(eligibility.blockers.length);assert.equal(isCollectableBxagiProductionJob(failed),false);
      await assert.rejects(f.workflow.collectProduction(f.job.id),{code:'bxagi_collection_scope_invalid'});assert.deepEqual(f.remote.calls,[]);assert.equal((await f.repository.getJob(userId,f.job.id)).status,'failed');assert.equal((await f.repository.listCreatives(userId)).length,0);
    }finally{f.env.DB.sqlite.close();}
  }
  const f=await collectionFixture();try{
    assert.equal(bxagiProductionCollectionEligibility(f.job,{userId:'other',subject:context.subject}).checks.owner_matches,false);
    assert.equal(bxagiProductionCollectionEligibility(f.job,{userId,subject:'other'}).checks.subject_matches,false);
    assert.equal(bxagiProductionCollectionEligibility(f.job).eligible,false);
    const missing=bxagiProductionCollectionEligibility(null,{userId,subject:context.subject});assert.equal(missing.eligible,false);assert.ok(Object.values(missing.checks).every(value=>typeof value==='boolean'));
  }finally{f.env.DB.sqlite.close();}
});

test('collect-only recovers failed bare-name MP4/PNG/TXT deliveries inside the same job after expiry without remote writes',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'bxagi-bare-delivery-'));
  let f;
  try{
    const videoPath=join(directory,'video.mp4');
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=blue:size=32x24:rate=24','-t','1','-c:v','mjpeg','-threads','1','-pix_fmt','yuvj420p','-q:v','3',videoPath],{timeout:10000});
    const video=readFileSync(videoPath),notes=new TextEncoder().encode('流程测试说明：纯棉面料');
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=codec_name','-of','json',videoPath],{timeout:10000}));
    assert.equal(probe.streams[0].codec_name,'mjpeg');
    f=await collectionFixture();
    await f.repository.updateJob(userId,f.job.id,{status:'failed',details:{...f.job.details,lastErrorCode:'bxagi_invalid_artifact'}});
    const files=new Map([['video.mp4',video],['cover.png',png],['notes.txt',notes]]),prefix=`bxagi-advertising/${f.job.id}/output/`;
    f.remote.api.readManifest=async()=>productionManifest(f,f.job.id,{creatives:[['video.mp4','video/mp4'],['cover.png','image/png'],['notes.txt','text/plain']].map(([filename,mimeType])=>({path:filename,filename,mimeType,title:'实际输出',sourceAssetIds:[f.asset.id],factsUsed:['纯棉面料']}))});
    f.remote.api.readArtifact=async({relativePath})=>{f.remote.calls.push({action:'artifact',relativePath});assert.ok(relativePath.startsWith(prefix));const bytes=files.get(relativePath.slice(prefix.length));assert.ok(bytes);return new Response(bytes);};
    await assert.rejects(f.workflow.syncJob(f.job.id),{code:'automation_probe_expired'});
    let result;for(let step=0;step<3;step++)result=await f.workflow.collectProduction(f.job.id);
    assert.equal(result.job.status,'completed');assert.equal(result.collectionOnly,true);
    const creatives=await f.repository.listCreatives(userId,f.project.id);assert.equal(creatives.length,3);
    for(const creative of creatives){assert.equal(creative.metadata.remoteArtifactPath,prefix+creative.filename);assert.deepEqual(new Uint8Array(await(await f.bucket.get(creative.objectKey)).arrayBuffer()),new Uint8Array(files.get(creative.filename)));assert.deepEqual(creative.sourceAssetIds,[f.asset.id]);assert.deepEqual(creative.metadata.factsUsed,['纯棉面料']);}
    const importedVideo=creatives.find(creative=>creative.mimeType==='video/mp4');assert.equal(importedVideo.width,32);assert.equal(importedVideo.height,24);assert.equal(importedVideo.duration,1);assert.deepEqual(importedVideo.metadata.technicalChecks,{mp4Structure:true,fullDecode:false});
    assert.equal(f.remote.calls.filter(call=>call.action==='artifact').length,3);assert.equal(f.remote.calls.some(call=>call.action.startsWith('FORBIDDEN:')),false);
    await f.workflow.collectProduction(f.job.id);assert.equal((await f.repository.listCreatives(userId,f.project.id)).length,3);
  }finally{f?.env.DB.sqlite.close();rmSync(directory,{recursive:true,force:true});}
});

test('bare and canonical aliases are duplicate delivery paths before any artifact read',async()=>{
  const f=await collectionFixture();
  try{
    f.remote.api.readManifest=async()=>{const manifest=productionManifest(f,f.job.id);manifest.creatives.push({...manifest.creatives[0],path:'creative.png'});return manifest;};
    const result=await f.workflow.collectProduction(f.job.id);
    assert.equal(result.job.status,'failed');assert.equal(result.job.details.lastErrorCode,'bxagi_invalid_manifest');
    assert.equal(f.remote.calls.some(call=>call.action==='artifact'),false);assert.equal((await f.repository.listCreatives(userId)).length,0);
  }finally{f.env.DB.sqlite.close();}
});

test('short-path compatibility rejects output-relative, unsafe paths and mismatched filename or MIME before artifact reads',async()=>{
  const cases=[['output/creative.png','creative.png','image/png'],['/workspace/creative.png','creative.png','image/png'],['bxagi-advertising/foreign/output/creative.png','creative.png','image/png'],['../creative.png','creative.png','image/png'],['%2e%2e.png','%2e%2e.png','image/png'],['creative.png?token=x','creative.png?token=x','image/png'],['a\\creative.png','a\\creative.png','image/png'],[' creative.png',' creative.png','image/png'],['creative.png','different.png','image/png'],['creative.png','creative.png','video/mp4'],['creative.svg','creative.svg','image/svg+xml']];
  for(const [path,filename,mimeType] of cases){const f=await collectionFixture();try{
    await f.repository.updateJob(userId,f.job.id,{status:'failed',details:{...f.job.details,lastErrorCode:'bxagi_invalid_artifact'}});
    f.remote.api.readManifest=async()=>{const manifest=productionManifest(f,f.job.id);Object.assign(manifest.creatives[0],{path,filename,mimeType});return manifest;};
    const result=await f.workflow.collectProduction(f.job.id);assert.equal(result.job.status,'failed',path);assert.equal(result.job.details.lastErrorCode,'bxagi_invalid_artifact',path);
    assert.equal(f.remote.calls.some(call=>call.action==='artifact'),false,path);assert.equal((await f.repository.listCreatives(userId)).length,0,path);
  }finally{f.env.DB.sqlite.close();}}
});

test('collect-only rejects unsent, unacknowledged, uncertain and foreign work before any remote read',async()=>{
  for(const variant of ['unsent','unacknowledged','pending','uncertain','buying','subject','owner','source']){
    const f=await collectionFixture();
    try{
      let workflow=f.workflow;
      if(variant==='owner')workflow=orchestrator(f,f.remote,{context:{...f.context,nativeUserId:'foreign-owner'}});
      else if(variant==='subject')workflow=orchestrator(f,f.remote,{context:{...f.context,subject:'foreign-subject'}});
      else if(variant==='source')await f.bucket.delete(f.asset.objectKey);
      else await f.repository.updateJob(userId,f.job.id,{...(variant==='uncertain'?{status:'needs_reconciliation'}:{}),details:{...f.job.details,...(variant==='unsent'?{messageSentAt:null}:variant==='unacknowledged'?{messageAcknowledged:false}:variant==='pending'?{remoteWritePending:'send_instruction'}:variant==='buying'?{kind:'buying'}:{})}});
      await assert.rejects(workflow.collectProduction(f.job.id));
      assert.deepEqual(f.remote.calls,[],variant);assert.equal((await f.repository.listCreatives(userId)).length,0);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('collect-only revalidates current market source and actual dedicated employee before reading any output',async()=>{
  for(const variant of ['catalog-instance','source-owner','source-parent','task-owner','task-employee']){
    const f=await collectionFixture();
    try{
      if(variant==='catalog-instance')f.remote.employees[0].providerId='different-instance';
      else{const original=f.remote.api.getConversation;f.remote.api.getConversation=async id=>{const row=await original(id),source=id==='hired-creative';return {...row,...(variant==='source-owner'&&source||variant==='task-owner'&&!source?{created_by_user_id:'foreign-owner'}:{}),...(variant==='source-parent'&&source?{parent_conversation_id:'historical-task'}:{}),...(variant==='task-employee'&&!source?{employee_id:'other-employee'}:{})};};}
      const result=await f.workflow.collectProduction(f.job.id);assert.equal(result.job.status,'failed');assert.equal(result.job.details.lastErrorCode,'bxagi_collection_employee_mismatch',variant);
      assert.equal(f.remote.calls.some(call=>['manifest','artifact'].includes(call.action)),false);assert.equal((await f.repository.listCreatives(userId)).length,0);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('finished missing delivery is terminal using ordered events without trusting remote wall-clock timestamps; manual collection retries only reads',async()=>{
  const f=await collectionFixture({manifest:new BxagiProtocolError('not_found','missing',404)});
  try{
    f.remote.api.getEvents=async()=>[{id:'finish-state',key:'execution_status',value:'finished',timestamp:'2099-01-01T20:04:42Z'},{id:'finish',kind:'ActionEvent',source:'agent',action:{kind:'FinishAction'}},{id:'confirmed-user-event',kind:'MessageEvent',source:'user'}];
    const missing=await f.workflow.collectProduction(f.job.id);
    assert.equal(missing.job.status,'failed');assert.equal(missing.job.details.lastErrorCode,'bxagi_delivery_missing');assert.equal(missing.job.details.executionStatus,'finished');assert.equal(missing.creatives.length,0);
    f.remote.api.readManifest=async()=>productionManifest(f,f.job.id);
    const recovered=await f.workflow.collectProduction(f.job.id);assert.equal(recovered.job.status,'completed');assert.equal(recovered.job.details.lastErrorCode,null);assert.equal(recovered.creatives.length,1);
    assert.equal(f.remote.calls.some(call=>call.action.startsWith('FORBIDDEN:')),false);
  }finally{f.env.DB.sqlite.close();}
});

test('newest running event supersedes old finish and old events before the acknowledged instruction do not terminate collection',async()=>{
  for(const events of [[{key:'execution_status',value:'running'},{kind:'ActionEvent',source:'agent',action:{kind:'FinishAction'}}],[{id:'confirmed-user-event'},{key:'execution_status',value:'finished'}]]){
    const f=await collectionFixture({manifest:new BxagiProtocolError('not_found','missing',404)});
    try{f.remote.api.getEvents=async()=>events;const result=await f.workflow.collectProduction(f.job.id);assert.equal(result.job.status,'awaiting_result');assert.equal(result.job.details.lastErrorCode,null);}
    finally{f.env.DB.sqlite.close();}
  }
});

test('an acknowledged new message supersedes a stale finished conversation snapshot until a newer execution event arrives',async()=>{
  const f=await collectionFixture({manifest:new BxagiProtocolError('not_found','missing',404)});
  try{
    const get=f.remote.api.getConversation;f.remote.api.getConversation=async id=>({...await get(id),execution_status:'finished'});
    f.remote.api.getEvents=async()=>[{id:'confirmed-user-event',kind:'MessageEvent',source:'user'},{key:'execution_status',value:'finished'},{kind:'ActionEvent',source:'agent',action:{kind:'FinishAction'}}];
    const waiting=await f.workflow.collectProduction(f.job.id);assert.equal(waiting.job.status,'awaiting_result');assert.equal(waiting.job.details.executionStatus,null);assert.equal(waiting.job.details.deliveryStateEvidence,'acknowledged_message_boundary');
    f.remote.api.getEvents=async()=>[{key:'execution_status',value:'finished',timestamp:'2099-01-01T20:04:42Z'},{id:'confirmed-user-event',kind:'MessageEvent',source:'user'}];
    const ended=await f.workflow.collectProduction(f.job.id);assert.equal(ended.job.status,'failed');assert.equal(ended.job.details.lastErrorCode,'bxagi_delivery_missing');assert.equal(ended.job.details.deliveryStateEvidence,'execution_event');
    assert.equal(f.remote.calls.some(call=>call.action.startsWith('FORBIDDEN:')),false);
  }finally{f.env.DB.sqlite.close();}
});

test('collect-only validates actual media bytes and concurrent collection imports once',async()=>{
  const bad=await collectionFixture({artifact:png.slice(0,24)});
  try{const result=await bad.workflow.collectProduction(bad.job.id);assert.equal(result.job.status,'failed');assert.equal((await bad.repository.listCreatives(userId)).length,0);}finally{bad.env.DB.sqlite.close();}
  const f=await collectionFixture();
  try{const results=await Promise.all([f.workflow.collectProduction(f.job.id),f.workflow.collectProduction(f.job.id)]);assert.ok(results.some(result=>result.busy));assert.ok(results.some(result=>result.job.status==='completed'));assert.equal((await f.repository.listCreatives(userId)).length,1);assert.equal(f.remote.calls.filter(call=>call.action==='artifact').length,1);}finally{f.env.DB.sqlite.close();}
});

async function repairFixture(){
  const f=await collectionFixture(),state={mode:'PlanAgent',switches:0,sends:0},prior=f.job;
  f.remote.employees[0].agentType='PlanAgent';
  const job=await f.repository.updateJob(userId,prior.id,{status:'failed',details:{...prior.details,employee:{...prior.details.employee,agentType:'PlanAgent'},lastErrorCode:'bxagi_delivery_missing',lastErrorStatus:404}});
  const get=f.remote.api.getConversation;f.remote.api.getConversation=async id=>({...await get(id),agent_type:id==='hired-creative'?'PlanAgent':state.mode,title:`广告任务 · ${job.id}`});
  f.remote.api.inspectJobFiles=async()=>{const prefix=`bxagi-advertising/${job.id}`,entries=[...job.details.uploadedAssets.map(a=>({path:a.path,type:'file'})),{path:`${prefix}/input/brief.json`,type:'file'}];const namespace=()=>({input:{directory:`${prefix}/input`,exists:true,excludedEntryCount:0,truncated:false,fileCount:entries.length,directoryCount:0,entries},output:{directory:`${prefix}/output`,exists:true,excludedEntryCount:0,truncated:false,fileCount:0,directoryCount:0,entries:[]}});return {jobId:job.id,conversationId:job.details.conversationId,conversation:namespace(),nodeProject:namespace()};};
  f.remote.api.readJobInput=async({relativePath})=>new Response(f.remote.files.get(relativePath));
  f.remote.api.switchExecutionAgent=async input=>{state.switches++;assert.deepEqual(input,{conversationId:job.details.conversationId,employeeId:job.details.employee.providerId,jobId:job.id});const saved=await f.repository.getJob(userId,job.id);assert.equal(saved.details.remoteWritePending,'switch_execution_agent');assert.equal(saved.details.deliveryRepair.revision,1);state.mode='CodeActAgent';return {...input,agentType:'CodeActAgent',executionModeVerified:true};};
  f.remote.api.sendMessage=async(id,prompt)=>{state.sends++;assert.equal(id,job.details.conversationId);const saved=await f.repository.getJob(userId,job.id);assert.equal(saved.details.remoteWritePending,'send_delivery_repair');assert.match(prompt,/已安装且支持中文的字体/);assert.match(prompt,/不要下载或安装软件/);assert.match(prompt,/delivery-repair:/);assert.match(prompt,/"mimeType":"image\/png"/);assert.match(prompt,/"sourceAssetIds":/);return {transport:'bxagi_ws',eventId:'repair-message-event',messageAcknowledged:true};};
  return {...f,job,state,authorization:{jobId:job.id,expiresAt:new Date(Date.now()+600000).toISOString()}};
}

test('explicit repair verifies actual inputs, switches same PlanAgent task once and records acknowledged new instruction without dispatching again',async()=>{
  const f=await repairFixture();
  try{
    const result=await f.workflow.repairDelivery(f.job.id,f.authorization);assert.equal(result.job.status,'running');assert.equal(result.job.details.deliveryRepair.revision,1);assert.equal(result.job.details.deliveryRepair.phase,'sent');assert.equal(result.job.details.deliveryRepair.originalMessageEventId,'confirmed-user-event');assert.equal(result.job.details.messageEventId,'repair-message-event');assert.equal(result.job.details.executionAgentType,'CodeActAgent');assert.equal(result.job.details.employee.agentType,'PlanAgent');assert.equal(result.job.details.remoteWritePending,null);assert.equal(f.state.switches,1);assert.equal(f.state.sends,1);
    const again=await f.workflow.repairDelivery(f.job.id,f.authorization);assert.equal(again.alreadyAttempted,true);assert.equal(f.state.switches,1);assert.equal(f.state.sends,1);
    await assert.rejects(f.workflow.syncJob(f.job.id),e=>e.code==='automation_probe_expired');
    const collected=await f.workflow.collectProduction(f.job.id);assert.equal(collected.job.status,'completed');assert.equal(collected.creatives.length,1);assert.equal(f.remote.calls.some(c=>c.action.startsWith('FORBIDDEN:')),false);
  }finally{f.env.DB.sqlite.close();}
});

test('repair acknowledgement has only a local 60-second event-index grace before missing-delivery terminal checks resume',async()=>{
  const f=await repairFixture();
  try{
    await f.workflow.repairDelivery(f.job.id,f.authorization);
    const get=f.remote.api.getConversation;f.remote.api.getConversation=async id=>({...await get(id),execution_status:'finished'});
    f.remote.api.readManifest=async()=>{throw new BxagiProtocolError('not_found','missing',404);};
    f.remote.api.getEvents=async()=>[{key:'execution_status',value:'finished',timestamp:'2099-01-01T20:04:42Z'},{id:'confirmed-user-event'}];
    const pending=await f.workflow.collectProduction(f.job.id);assert.equal(pending.job.status,'awaiting_result');assert.equal(pending.job.details.deliveryStateEvidence,'repair_message_index_pending');
    const job=await f.repository.getJob(userId,f.job.id),old=new Date(Date.now()-61000).toISOString();
    await f.repository.updateJob(userId,job.id,{details:{...job.details,messageSentAt:old,deliveryRepair:{...job.details.deliveryRepair,messageSentAt:old}}});
    const terminal=await f.workflow.collectProduction(job.id);assert.equal(terminal.job.status,'failed');assert.equal(terminal.job.details.lastErrorCode,'bxagi_delivery_missing');
  }finally{f.env.DB.sqlite.close();}
});

test('repair rejects missing, expired, overlong or foreign authorization before remote calls',async()=>{
  for(const authorization of [{},{expiresAt:'2000-01-01T00:00:00Z'}, {expiresAt:new Date(Date.now()+7200000).toISOString()},{jobId:'different-job',expiresAt:new Date(Date.now()+600000).toISOString()}]){
    const f=await repairFixture();try{await assert.rejects(f.workflow.repairDelivery(f.job.id,{jobId:f.job.id,...authorization}),e=>e.code==='bxagi_repair_authorization_required');assert.deepEqual(f.remote.calls,[]);assert.equal(f.state.switches,0);}finally{f.env.DB.sqlite.close();}
  }
});

test('repair refuses nonempty outputs, altered remote source or brief, and non-planning task without a switch or instruction',async()=>{
  for(const variant of ['output','source','brief','agent']){
    const f=await repairFixture();
    try{
      if(variant==='output'){const inspect=f.remote.api.inspectJobFiles;f.remote.api.inspectJobFiles=async()=>{const data=await inspect();data.nodeProject.output.fileCount=1;return data;};}
      else if(variant==='agent')f.state.mode='CodeActAgent';
      else{const read=f.remote.api.readJobInput;f.remote.api.readJobInput=async input=>(variant==='brief')===input.relativePath.endsWith('/brief.json')?new Response(variant==='brief'?JSON.stringify({jobId:'different'}):'altered source'):read(input);}
      await assert.rejects(f.workflow.repairDelivery(f.job.id,f.authorization));assert.equal(f.state.switches,0);assert.equal(f.state.sends,0);assert.equal((await f.repository.getJob(userId,f.job.id)).details.deliveryRepair,undefined);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('unknown switch or message outcome persists its pending repair marker and never retries either write',async()=>{
  for(const stage of ['switch','send','switch-receipt']){
    const f=await repairFixture();
    try{
      if(stage==='switch')f.remote.api.switchExecutionAgent=async()=>{f.state.switches++;throw Object.assign(new Error('unknown'),{status:502,uncertain:true,writeSent:true});};
      if(stage==='switch-receipt')f.remote.api.switchExecutionAgent=async()=>{f.state.switches++;return {agentType:'CodeActAgent'};};
      if(stage==='send')f.remote.api.sendMessage=async()=>{f.state.sends++;throw Object.assign(new Error('unknown'),{status:502,uncertain:true,messageSent:true});};
      const result=await f.workflow.repairDelivery(f.job.id,f.authorization);assert.equal(result.job.status,'needs_reconciliation');assert.equal(result.job.details.remoteWritePending,stage==='send'?'send_delivery_repair':'switch_execution_agent');assert.equal(result.job.details.deliveryRepair.phase,'needs_reconciliation');
      const counts=[f.state.switches,f.state.sends];await f.workflow.repairDelivery(f.job.id,f.authorization);assert.deepEqual([f.state.switches,f.state.sends],counts);assert.equal((await f.repository.listJobs(userId)).filter(j=>j.type==='bxagi_workflow').length,1);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('known unsent repair still consumes its single revision and concurrent repair callers cannot switch twice',async()=>{
  const unsent=await repairFixture();try{unsent.remote.api.switchExecutionAgent=async()=>{unsent.state.switches++;throw Object.assign(new Error('preflight refused'),{status:403,uncertain:false,writeSent:false});};const result=await unsent.workflow.repairDelivery(unsent.job.id,unsent.authorization);assert.equal(result.job.status,'failed');assert.equal(result.job.details.remoteWritePending,null);assert.equal(result.job.details.deliveryRepair.revision,1);await unsent.workflow.repairDelivery(unsent.job.id,unsent.authorization);assert.equal(unsent.state.switches,1);assert.equal(unsent.state.sends,0);}finally{unsent.env.DB.sqlite.close();}
  const f=await repairFixture();try{const results=await Promise.all([f.workflow.repairDelivery(f.job.id,f.authorization),f.workflow.repairDelivery(f.job.id,f.authorization)]);assert.ok(results.some(r=>r.busy||r.alreadyAttempted));assert.equal(f.state.switches,1);assert.equal(f.state.sends,1);}finally{f.env.DB.sqlite.close();}
});

async function visualFixture(){
  const f=await fixture(),facts=['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺'];
  f.project=await f.repository.updateProject(userId,f.project.id,{title:'BXAGI 智能调度实测',productName:'流程验证素材',facts});
  f.env.DB.sqlite.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({automationProbeId:'probe-fixture'}),f.asset.id);
  const state={manifest:'old',events:[{id:'old-finish',key:'execution_status',value:'finished'}],mode:'CodeActAgent',uploads:0,sends:0};
  const remote=workforceFixture({manifest:id=>productionManifest(f,id)}),get=remote.api.getConversation;
  remote.api.getConversation=async id=>({...await get(id),created_by_user_id:context.subject,agent_type:state.mode,execution_status:'finished'});
  remote.api.ensureRuntime=async()=>({status:'ready'});
  remote.api.sendMessage=async()=>({transport:'bxagi_ws',messageAcknowledged:true,eventId:'original-user-event'});
  remote.api.getEvents=async()=>state.events;
  remote.api.readJobInput=async({relativePath})=>new Response(remote.files.get(relativePath));
  const workflow=orchestrator(f,remote),submitted=await workflow.submitProduction(f.project),completed=await synchronise(workflow,submitted.job.id);
  assert.equal(completed.job.status,'completed');
  const job=await f.repository.getJob(userId,submitted.job.id),original=(await f.repository.listCreatives(userId,job.projectId))[0],upload=remote.api.uploadFile;
  remote.api.uploadFile=async input=>{state.uploads++;const saved=await f.repository.getJob(userId,job.id);assert.equal(saved.details.remoteWritePending,'upload_visual_resource:'+input.filename);assert.equal(saved.details.visualRepair.revision,1);return upload(input);};
  remote.api.sendMessage=async(id,prompt)=>{state.sends++;assert.equal(id,job.details.conversationId);const saved=await f.repository.getJob(userId,job.id);assert.equal(saved.details.remoteWritePending,'send_visual_repair');assert.equal(saved.details.visualRepair.uploadedResources.length,3);assert.match(prompt,/ImageFont\.truetype/);assert.match(prompt,/只执行一条完整命令/);assert.match(prompt,/先用file_editor写脚本/);assert.match(prompt,/不得购买、雇佣、续费、安装/);assert.match(prompt,/遇到权限、审批/);assert.match(prompt,/仅用于流程验证，不进行广告投放/);assert.match(prompt,/visual-repair:/);return {transport:'bxagi_ws',eventId:'visual-user-event',messageAcknowledged:true};};
  remote.api.readManifest=async()=>{
    if(state.manifest==='missing')throw new BxagiProtocolError('not_found','missing',404);
    if(state.manifest==='old')return productionManifest(f,job.id);
    const current=await f.repository.getJob(userId,job.id),prefix=`bxagi-advertising/${job.id}/output/`;
    return {version:1,jobId:job.id,kind:'production',visualRepair:{revision:1,attemptId:state.manifest==='wrong-attempt'?'foreign-attempt':current.details.visualRepair.attemptId},creatives:[{path:prefix+'poster-v2.png',filename:'poster-v2.png',mimeType:'image/png',title:'流程测试素材',format:'square',sourceAssetIds:[f.asset.id],factsUsed:facts},{path:prefix+'production_notes-v2.txt',filename:'production_notes-v2.txt',mimeType:'text/plain',title:'流程测试素材',format:'square',sourceAssetIds:[f.asset.id],factsUsed:facts}]};
  };
  remote.api.readArtifact=async({relativePath})=>{remote.calls.push({action:'artifact',relativePath});return new Response(relativePath.endsWith('.txt')?'Used supplied font; input verified.':actualPng(state.manifest==='bad-size'?24:1080,state.manifest==='bad-size'?24:1080));};
  remote.calls.length=0;
  return {...f,remote,workflow,job,original,state,resources:workflowFontResources(),authorization:{jobId:job.id,expiresAt:new Date(Date.now()+600000).toISOString()}};
}

test('one visual repair uploads verified licensed font resources before one same-task instruction, preserves old PNG and imports only actual v2',async()=>{
  const f=await visualFixture();
  try{
    const originalObject=await f.bucket.get(f.original.objectKey),originalBytes=await originalObject.arrayBuffer();
    const result=await f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources});
    assert.equal(result.job.status,'running');assert.equal(result.job.details.visualRepair.phase,'sent');assert.equal(result.job.details.visualRepair.originalMessageEventId,'original-user-event');assert.equal(result.job.details.messageEventId,'visual-user-event');assert.equal(result.job.details.visualRepair.uploadedResources.length,3);assert.equal(f.state.uploads,3);assert.equal(f.state.sends,1);assert.equal(result.job.details.remoteWritePending,null);
    const rejected=await f.repository.getCreative(userId,f.original.id);assert.equal(rejected.status,'rejected');assert.equal(rejected.metadata.semanticValidated,false);assert.equal(rejected.objectKey,f.original.objectKey);assert.deepEqual(await (await f.bucket.get(rejected.objectKey)).arrayBuffer(),originalBytes);
    const again=await f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources});assert.equal(again.alreadyAttempted,true);assert.equal(f.state.uploads,3);assert.equal(f.state.sends,1);
    const stale=await f.workflow.collectProduction(f.job.id);assert.equal(stale.job.status,'awaiting_result');assert.equal(stale.job.details.deliveryStateEvidence,'repair_message_index_pending');assert.equal(stale.creatives.length,0);assert.equal(f.remote.calls.some(call=>call.action==='artifact'),false);
    f.state.manifest='v2';f.state.events=[{key:'execution_status',value:'finished'},{id:'visual-user-event'},{id:'old-finish',key:'execution_status',value:'finished'}];
    const partial=await f.workflow.collectProduction(f.job.id);assert.equal(partial.job.status,'awaiting_result');
    const collected=await f.workflow.collectProduction(f.job.id);assert.equal(collected.job.status,'completed');assert.equal(collected.job.details.visualRepair.phase,'completed');assert.equal(collected.creatives.length,2);assert.equal(collected.creatives.find(row=>row.mimeType==='image/png').width,1080);assert.equal((await f.repository.listCreatives(userId,f.job.projectId)).length,3);assert.equal(collected.creatives.every(row=>row.metadata.visualRepairAttemptId===result.job.details.visualRepair.attemptId&&row.metadata.semanticValidated===false),true);assert.equal((await f.repository.getCreative(userId,f.original.id)).status,'rejected');assert.equal(f.remote.calls.some(call=>['create','start-status'].includes(call.action)),false);
  }finally{f.env.DB.sqlite.close();}
});

test('visual repair rejects invalid authorization and fixed resource bytes before any employee call',async()=>{
  for(const variant of ['authorization','filename','hash','size','bytes']){
    const f=await visualFixture();try{
      const authorization=variant==='authorization'?{...f.authorization,jobId:'another-job'}:f.authorization,resources=f.resources.map(row=>({...row}));
      if(variant==='filename')resources[0].filename='arbitrary.ttf';if(variant==='hash')resources[0].sha256='0'.repeat(64);if(variant==='size')resources[0].size++;if(variant==='bytes')resources[0].blob=new Blob([new Uint8Array(resources[0].size)]);
      await assert.rejects(f.workflow.repairVisualDelivery(f.job.id,authorization,{resources}));assert.deepEqual(f.remote.calls,[]);assert.equal(f.state.uploads,0);assert.equal(f.state.sends,0);assert.equal((await f.repository.getJob(userId,f.job.id)).details.visualRepair,undefined);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('visual repair respects actual approval, owner, source bytes, test scope and approved or campaign-linked originals',async()=>{
  for(const variant of ['conversation-wait','event-wait','full-state-wait','owner','source','facts','approved','campaign']){
    const f=await visualFixture();try{
      if(variant==='event-wait')f.state.events=[{key:'execution_status',value:'awaiting_user_confirmation'}];
      else if(variant==='full-state-wait')f.state.events=[{key:'full_state',value:{execution_status:'awaiting_user_input',secrets:'never-used'}}];
      else if(variant==='conversation-wait'||variant==='owner'){const get=f.remote.api.getConversation;f.remote.api.getConversation=async id=>({...await get(id),...(variant==='owner'?{created_by_user_id:'foreign-owner'}:{execution_status:'awaiting_user_confirmation'})});}
      else if(variant==='source')f.remote.api.readJobInput=async()=>new Response('modified source');
      else if(variant==='facts'){const current=await f.repository.getJob(userId,f.job.id);await f.repository.updateJob(userId,current.id,{details:{...current.details,input:{...current.details.input,facts:['uncovered commercial claim']}}});}
      else if(variant==='approved')await f.repository.updateCreative(userId,f.original.id,{status:'approved'});
      else if(variant==='campaign')await f.repository.createCampaign(userId,{projectId:f.project.id,creativeIds:[f.original.id],name:'already-linked',channel:'oceanengine',objective:'purchase',dailyBudget:10,totalBudget:10,maxDailyBudget:10,buyingEmployeeId:'unused-buying-employee',status:'draft'});
      await assert.rejects(f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources}));assert.equal(f.state.uploads,0);assert.equal(f.state.sends,0);assert.equal((await f.repository.getJob(userId,f.job.id)).details.visualRepair,undefined);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('visual repair unknown upload or message preserves a durable pending stage and never repeats resources or instruction',async()=>{
  for(const variant of ['upload','send','receipt']){
    const f=await visualFixture();try{
      if(variant==='upload')f.remote.api.uploadFile=async()=>{f.state.uploads++;throw Object.assign(new Error('connection lost'),{status:502});};
      if(variant==='send')f.remote.api.sendMessage=async()=>{f.state.sends++;throw Object.assign(new Error('lost ack'),{status:502,messageSent:true,uncertain:true});};
      if(variant==='receipt')f.remote.api.sendMessage=async()=>{f.state.sends++;return {transport:'bxagi_ws',messageAcknowledged:true,eventId:context.accessToken};};
      const result=await f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources});assert.equal(result.job.status,'needs_reconciliation');assert.equal(result.job.details.visualRepair.phase,'needs_reconciliation');assert.equal(result.job.details.remoteWritePending,variant==='upload'?'upload_visual_resource:BXAGI-Workflow-SC-Subset.ttf':'send_visual_repair');const counts=[f.state.uploads,f.state.sends];
      await f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources});await f.workflow.syncJob(f.job.id);assert.deepEqual([f.state.uploads,f.state.sends],counts);await assert.rejects(f.workflow.collectProduction(f.job.id));assert.equal(JSON.stringify(result.job).includes(context.accessToken),false);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('concurrent visual repair has one upload set and one instruction; a proven unsent failure still consumes its revision',async()=>{
  const f=await visualFixture();try{const results=await Promise.all([f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources}),f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources})]);assert.ok(results.some(row=>row.busy||row.alreadyAttempted));assert.equal(f.state.uploads,3);assert.equal(f.state.sends,1);}finally{f.env.DB.sqlite.close();}
  const g=await visualFixture();try{g.remote.api.sendMessage=async()=>{g.state.sends++;throw Object.assign(new Error('preflight refused'),{status:403,messageSent:false,uncertain:false});};const result=await g.workflow.repairVisualDelivery(g.job.id,g.authorization,{resources:g.resources});assert.equal(result.job.status,'failed');assert.equal(result.job.details.remoteWritePending,null);await g.workflow.repairVisualDelivery(g.job.id,g.authorization,{resources:g.resources});assert.equal(g.state.uploads,3);assert.equal(g.state.sends,1);}finally{g.env.DB.sqlite.close();}
});

test('visual delivery rejects another repair attempt and incorrect actual dimensions; newer approval state supersedes old completion',async()=>{
  for(const variant of ['wrong-attempt','bad-size','new-wait','index-expired']){
    const f=await visualFixture();try{
      await f.workflow.repairVisualDelivery(f.job.id,f.authorization,{resources:f.resources});f.state.manifest=variant==='new-wait'||variant==='index-expired'?'old':variant;
      if(variant==='new-wait')f.state.events=[{key:'execution_status',value:'awaiting_user_confirmation'},{id:'visual-user-event'},{id:'old-finish',key:'execution_status',value:'finished'}];
      if(variant==='index-expired'){const current=await f.repository.getJob(userId,f.job.id);await f.repository.updateJob(userId,current.id,{details:{...current.details,visualRepair:{...current.details.visualRepair,messageSentAt:new Date(Date.now()-61000).toISOString()}}});}
      const result=await f.workflow.collectProduction(f.job.id);assert.equal(result.job.status,variant==='new-wait'?'awaiting_user_confirmation':'failed');assert.equal(result.job.details.lastErrorCode,variant==='wrong-attempt'?'bxagi_invalid_visual_manifest':variant==='bad-size'?'bxagi_invalid_visual_artifact':variant==='index-expired'?'bxagi_delivery_missing':null);assert.equal((await f.repository.listCreatives(userId,f.job.projectId)).length,1);assert.equal(f.state.sends,1);
    }finally{f.env.DB.sqlite.close();}
  }
});
async function videoFormatFixture(){
 const f=await collectionFixture(),facts=['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺'];
 f.project=await f.repository.updateProject(userId,f.project.id,{title:'BXAGI视频生产实测',productName:'流程验证素材',facts});
 f.env.DB.sqlite.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({automationProbeId:'video-probe-fixture'}),f.asset.id);
 const input={...f.job.details.input,title:f.project.title,productName:f.project.productName,facts};
 f.job=await f.repository.updateJob(userId,f.job.id,{status:'failed',details:{...f.job.details,input,runtimeStatus:'ready',lastErrorCode:'bxagi_invalid_artifact'}});
 const prefix=`bxagi-advertising/${f.job.id}`,state={sends:0,mode:'CodeActAgent',execution:'finished',manifest:'old'};
 const entries=[['video.mp4','video/mp4',12097373],['cover.png','image/png',png.length],['notes.txt','text/plain',100]].map(([filename,mimeType,size])=>({filename,mimeType,size,path:`${prefix}/output/${filename}`,sourceAssetIds:[f.asset.id],factsUsed:facts}));
 f.remote.api.getConversation=async id=>({id,created_by_user_id:context.subject,employee_id:f.job.details.employee.providerId,agent_type:state.mode,execution_status:state.execution});
 f.remote.api.getEvents=async()=>[{id:'previous-finish',key:'execution_status',value:'finished'}];
 f.remote.api.readManifest=async()=>({version:1,jobId:f.job.id,kind:'production',...(state.manifest==='wrong'?{videoFormatRepairAttemptId:'wrong-attempt'}:{}),creatives:state.manifest==='old'?entries:entries.map(entry=>entry.mimeType==='video/mp4'?{...entry,filename:'video-h264.mp4',path:`${prefix}/output/video-h264.mp4`}:entry.mimeType==='text/plain'?{...entry,filename:'production_notes_h264.txt',path:`${prefix}/output/production_notes_h264.txt`}:entry)});
 f.remote.api.inspectJobFiles=async()=>({conversation:{output:{exists:true,truncated:false,excludedEntryCount:0,entries:entries.map(entry=>({path:entry.path,size:entry.size,type:'file'}))}}});
 f.remote.api.readJobInput=async()=>Response.json({jobId:f.job.id,kind:'production',project:input,campaign:null,optimization:null,coordination:null,sourceFiles:f.job.details.uploadedAssets});
 f.remote.api.sendMessage=async(id,prompt)=>{state.sends++;assert.equal(id,f.job.details.conversationId);const saved=await f.repository.getJob(userId,f.job.id);assert.equal(saved.details.remoteWritePending,'send_video_format_repair');assert.equal(saved.details.videoFormatRepair.phase,'sending');assert.match(prompt,/禁止生成、重复、补帧、插值/);assert.match(prompt,/全部保留，禁止覆盖或修改/);assert.match(prompt,/imageio-ffmpeg==0\.6\.0/);assert.match(prompt,/videoFormatRepairAttemptId/);assert.match(prompt,/production_notes_h264\.txt/);assert.match(prompt,/SHA-256=aaaaaaaa/);return {transport:'bxagi_ws',eventId:'video-repair-user-event',messageAcknowledged:true};};
 return {...f,state,authorization:{jobId:f.job.id,expiresAt:new Date(Date.now()+600000).toISOString(),originalSha256:'a'.repeat(64)}};
}

test('video format repair sends one same-employee instruction, preserves original files and refuses stale or foreign repair manifests',async()=>{
 const f=await videoFormatFixture();try{
  const originals=new Map(f.remote.files),result=await f.workflow.repairVideoFormat(f.job.id,f.authorization);
  assert.equal(result.job.status,'running');assert.equal(result.job.details.videoFormatRepair.phase,'sent');assert.equal(result.job.details.videoFormatRepair.originalMessageEventId,'confirmed-user-event');assert.equal(result.job.details.videoFormatRepair.originalSize,12097373);assert.equal(result.job.details.videoFormatRepair.originalSha256,'a'.repeat(64));assert.equal(result.job.details.messageEventId,'video-repair-user-event');assert.equal(result.job.details.remoteWritePending,null);assert.equal(f.state.sends,1);assert.deepEqual(f.remote.files,originals);
  assert.equal((await f.workflow.repairVideoFormat(f.job.id,f.authorization)).alreadyAttempted,true);assert.equal(f.state.sends,1);
  const stale=await f.workflow.collectProduction(f.job.id);assert.equal(stale.job.status,'awaiting_result');assert.equal(stale.job.details.deliveryStateEvidence,'repair_message_index_pending');assert.equal(stale.creatives.length,0);assert.equal(f.remote.calls.some(c=>c.action==='artifact'||c.action.startsWith('FORBIDDEN:')),false);
  f.state.manifest='wrong';const wrong=await f.workflow.collectProduction(f.job.id);assert.equal(wrong.job.status,'failed');assert.equal(wrong.job.details.lastErrorCode,'bxagi_invalid_video_repair_manifest');assert.equal((await f.repository.listCreatives(userId)).length,0);
 }finally{f.env.DB.sqlite.close();}
});

test('video format repair unknown send or receipt remains pending and is never resent, including concurrent calls',async()=>{
 for(const variant of ['send','receipt','known-unsent']){
  const f=await videoFormatFixture();try{
   f.remote.api.sendMessage=async()=>{f.state.sends++;if(variant==='receipt')return {transport:'bxagi_events',eventId:'not-live-ws',messageAcknowledged:true};throw Object.assign(new Error('send failure'),{status:variant==='known-unsent'?403:502,messageSent:variant!=='known-unsent',uncertain:variant!=='known-unsent'});};
   const result=await f.workflow.repairVideoFormat(f.job.id,f.authorization),uncertain=variant!=='known-unsent';assert.equal(result.job.status,uncertain?'needs_reconciliation':'failed');assert.equal(result.job.details.videoFormatRepair.phase,uncertain?'needs_reconciliation':'failed');assert.equal(result.job.details.remoteWritePending,uncertain?'send_video_format_repair':null);
   assert.equal((await f.workflow.repairVideoFormat(f.job.id,f.authorization)).alreadyAttempted,true);assert.equal(f.state.sends,1);await assert.rejects(f.workflow.collectProduction(f.job.id));
  }finally{f.env.DB.sqlite.close();}
 }
 const f=await videoFormatFixture();try{const results=await Promise.all([f.workflow.repairVideoFormat(f.job.id,f.authorization),f.workflow.repairVideoFormat(f.job.id,f.authorization)]);assert.equal(f.state.sends,1);assert.ok(results.some(row=>row.busy||row.alreadyAttempted));}finally{f.env.DB.sqlite.close();}
});

test('video format repair requires bound source hash, original failed test job, ownership, CodeAct and no approval wait',async()=>{
 for(const variant of ['authorization','hash','status','facts','owner','agent','approval','source-size']){
  const f=await videoFormatFixture();try{
   const authorization={...f.authorization};if(variant==='authorization')authorization.jobId='other';if(variant==='hash')authorization.originalSha256='partial';
   if(variant==='status')await f.repository.updateJob(userId,f.job.id,{status:'running'});
   if(variant==='facts')await f.repository.updateProject(userId,f.project.id,{facts:['unapproved commercial fact']});
   if(variant==='owner'){const get=f.remote.api.getConversation;f.remote.api.getConversation=async id=>({...await get(id),created_by_user_id:'foreign'});}
   if(variant==='agent')f.state.mode='PlanAgent';if(variant==='approval')f.state.execution='awaiting_user_confirmation';if(variant==='source-size')f.remote.api.inspectJobFiles=async()=>({conversation:{output:{exists:true,truncated:false,excludedEntryCount:0,entries:[]}}});
   await assert.rejects(f.workflow.repairVideoFormat(f.job.id,authorization));assert.equal(f.state.sends,0);assert.equal((await f.repository.getJob(userId,f.job.id)).details.videoFormatRepair,undefined);assert.equal(f.remote.calls.some(c=>c.action.startsWith('FORBIDDEN:')),false);
  }finally{f.env.DB.sqlite.close();}
 }
});

async function buyingFixture(f) {
  const creative = await f.repository.createCreative(userId, { projectId: f.project.id, filename: 'actual.png', mimeType: 'image/png', size: png.length, objectKey: f.asset.objectKey, title: '实际成品', status: 'approved', sourceAssetIds: [f.asset.id] });
  const campaign = await f.repository.createCampaign(userId, { projectId: f.project.id, creativeIds: [creative.id], name: '服装计划', channel: 'oceanengine', dailyBudget: 100, totalBudget: 1000, maxDailyBudget: 200, objective: 'purchase', targetRoi: 2, buyingEmployeeId: 'old-local-role', platformConfig: { budgetUnit: 'yuan' } });
  return { campaign, creative };
}

test('launch cannot queue an approved partial employee artifact, while pause and a complete owned delivery remain allowed',async()=>{
  for(const variant of ['partial','foreign-project','missing-result','complete','pause']){
    const f=await fixture(),remote=workforceFixture(),workflow=orchestrator(f,remote);
    try{
      const {campaign,creative}=await buyingFixture(f),source=await f.repository.createJob(userId,{projectId:variant==='foreign-project'?'foreign-project':f.project.id,employeeId:'bxagi:market:creative_employee',type:'bxagi_workflow',status:variant==='partial'||variant==='pause'?'awaiting_result':'completed',details:{kind:'production',resultCreativeIds:variant==='missing-result'?[]:[creative.id]}});
      await f.repository.updateCreative(userId,creative.id,{metadata:{provider:'bxagi',sourceJobId:source.id}});
      if(['complete','pause'].includes(variant))assert.equal((await workflow.submitBuying(campaign,{action:variant==='pause'?'pause':'launch'})).job.status,'queued');
      else{await assert.rejects(workflow.submitBuying(campaign),error=>error.status===409&&error.code==='bxagi_delivery_incomplete');assert.equal((await f.repository.listJobs(userId)).some(job=>job.details?.kind==='buying'),false);}
      assert.equal(remote.calls.some(call=>call.action==='create'||call.action==='prompt'),false);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('production dispatch saves actual sources and brief before prompt, imports actual bytes, then deduplicates sync', async () => {
  const f = await fixture(), remote = workforceFixture({ manifest: id => productionManifest(f, id) }), workflow = orchestrator(f, remote);
  try {
    const submitted = await workflow.submitProduction(f.project);
    assert.equal(submitted.job.status, 'queued'); assert.deepEqual(submitted.variants, []);
    assert.equal(remote.calls.some(call => call.action === 'create'), false);
    const first = await workflow.syncJob(submitted.job.id);
    assert.notEqual(first.job.status, 'completed');
    assert.equal(remote.calls.some(call => call.action === 'prompt'), false);
    await pollUntil(workflow, submitted.job.id, result => !!result.job.details.messageSentAt);
    const promptIndex = remote.calls.findIndex(call => call.action === 'prompt');
    assert.ok(promptIndex > 0);
    const uploads = remote.calls.slice(0, promptIndex).filter(call => call.action === 'upload');
    assert.equal(uploads.length, 2); assert.deepEqual(uploads[0].bytes, png);
    assert.match(uploads[0].directory, new RegExp(submitted.job.id));
    assert.equal(uploads[1].filename, 'brief.json');
    const brief = JSON.parse(new TextDecoder().decode(uploads[1].bytes));
    assert.deepEqual(brief.project.facts, f.project.facts); assert.equal(brief.sourceFiles[0].id, f.asset.id);
    const result = await synchronise(workflow, submitted.job.id);
    assert.equal(result.job.status, 'completed'); assert.equal(result.creatives.length, 1);
    const creative = result.creatives[0]; assert.equal(creative.width, 24); assert.equal(creative.height, 24);
    assert.equal(creative.metadata.semanticValidated, false); assert.equal(creative.userId, userId); assert.equal(creative.objectKey, undefined);
    const stored = await f.repository.getCreative(userId, creative.id);
    assert.deepEqual(new Uint8Array(await (await f.bucket.get(stored.objectKey)).arrayBuffer()), png);
    const replay = await workflow.syncJob(submitted.job.id); assert.equal(replay.job.status, 'completed');
    assert.equal((await f.repository.listCreatives(userId)).length, 1);
    assert.equal(remote.calls.filter(call => call.action === 'prompt').length, 1);
    assert.ok(!JSON.stringify({ submitted, result, audit: await f.repository.listAudit(userId), calls: remote.calls }).includes(context.accessToken));
  } finally { f.env.DB.sqlite.close(); }
});

test('READY conversation and completion text without actual output keep production pending', async () => {
  const f = await fixture(), remote = workforceFixture({ manifest: new BxagiProtocolError('not_found', '尚未写出真实成品', 404) }), workflow = orchestrator(f, remote);
  try {
    const submitted = await workflow.submitProduction(f.project), result = await pollUntil(workflow, submitted.job.id, value => value.job.status === 'awaiting_result');
    assert.equal(result.job.status, 'awaiting_result'); assert.deepEqual(result.creatives, []);
    assert.equal((await f.repository.listCreatives(userId)).length, 0);
  } finally { f.env.DB.sqlite.close(); }
});

test('actual production readback in planning or read-only mode stops before runtime, input upload and instruction dispatch',async()=>{
  for(const agentType of ['PlanAgent','ReadOnlyAgent']){
    const f=await fixture(),remote=workforceFixture(),get=remote.api.getConversation;
    remote.api.getConversation=async id=>({...await get(id),agent_type:agentType});
    remote.api.ensureRuntime=async()=>{remote.calls.push({action:'runtime'});return {status:'ready'};};
    try{
      const workflow=orchestrator(f,remote),submitted=await workflow.submitProduction(f.project),result=await synchronise(workflow,submitted.job.id);
      assert.equal(result.job.status,'failed');assert.equal(result.job.details.lastErrorCode,'bxagi_execution_mode_invalid');assert.equal(remote.calls.some(call=>['runtime','upload','prompt'].includes(call.action)),false);assert.equal(result.job.details.messageSentAt,undefined);assert.equal((await f.repository.listCreatives(userId)).length,0);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('unknown remote write outcome requires reconciliation and cannot be retried by sync', async () => {
  const f = await fixture(), remote = workforceFixture({ sendError: new BxagiProtocolError('upstream_unavailable', `token ${context.accessToken}`, 502, true) }), workflow = orchestrator(f, remote);
  try {
    const submitted = await workflow.submitProduction(f.project), result = await pollUntil(workflow, submitted.job.id, value => value.job.status === 'needs_reconciliation');
    assert.equal(result.job.status, 'needs_reconciliation'); assert.equal(result.job.details.remoteWritePending, 'send_instruction');
    await workflow.syncJob(submitted.job.id); await workflow.syncJob(submitted.job.id);
    assert.equal(remote.calls.filter(call => call.action === 'create').length, 1); assert.equal(remote.calls.filter(call => call.action === 'prompt').length, 1);
    assert.ok(!JSON.stringify(result).includes(context.accessToken)); assert.equal((await f.repository.listCreatives(userId)).length, 0);
  } finally { f.env.DB.sqlite.close(); }
});

test('remote jobs enforce native owner and original verified BXAGI subject', async () => {
  const f = await fixture(), remote = workforceFixture(), workflow = orchestrator(f, remote);
  try {
    const submitted = await workflow.submitProduction(f.project);
    const other = orchestrator(f, remote, { context: { ...f.context, nativeUserId: 'native-owner-b' } });
    await assert.rejects(() => other.syncJob(submitted.job.id), error => error.status === 404);
    await assert.rejects(() => other.submitProduction(f.project), error => error.status === 404);
    const switched = orchestrator(f, remote, { context: { ...f.context, subject: 'different-bxagi-account' } });
    await assert.rejects(() => switched.syncJob(submitted.job.id), error => error.code === 'bxagi_account_changed');
    assert.equal(remote.calls.some(call => call.action === 'create'), false);
  } finally { f.env.DB.sqlite.close(); }
});

test('concurrent initial planning queues one owner job rather than duplicate remote work', async () => {
  const f = await fixture(), remote = workforceFixture(), workflow = orchestrator(f, remote);
  try {
    await Promise.allSettled([workflow.submitProduction(f.project), workflow.submitProduction(f.project)]);
    const jobs = (await f.repository.listJobs(userId)).filter(job => job.type === 'bxagi_workflow');
    assert.equal(jobs.length, 1);
  } finally { f.env.DB.sqlite.close(); }
});

for (const kind of ['truncated', 'duplicate', 'foreign-directory']) {
  test(`${kind} artifact cannot complete production or save misleading creatives`, async () => {
    const f = await fixture();
    const remote = workforceFixture({ artifact: kind === 'truncated' ? png.slice(0, 24) : png, manifest: id => {
      const manifest = productionManifest(f, id);
      if (kind === 'duplicate') manifest.creatives.push({ ...manifest.creatives[0] });
      if (kind === 'foreign-directory') manifest.creatives[0].path = 'bxagi-advertising/another-job/output/creative.png';
      return manifest;
    } });
    try {
      const workflow = orchestrator(f, remote), submitted = await workflow.submitProduction(f.project), result = await synchronise(workflow, submitted.job.id);
      assert.notEqual(result.job.status, 'completed', kind); assert.equal((await f.repository.listCreatives(userId)).length, 0, kind);
    } finally { f.env.DB.sqlite.close(); }
  });
}

test('buying decision delegates to actual channel tool and cannot claim active on blocked channel', async () => {
  const f = await fixture(), { campaign } = await buyingFixture(f); let job, launchCalls = 0;
  const remote = workforceFixture({ manifest: () => ({ version: 1, jobId: job.id, kind: 'buying', decision: { action: 'launch', campaignId: campaign.id, inputVersion: job.details.inputVersion }, rationale: '员工检查实际预算和素材' }) });
  const workflow = orchestrator(f, remote, { adsService: { async launch(owner, input) { assert.equal(owner, userId); assert.equal(input.dailyBudget, 100); launchCalls++; return { ...input, status: 'blocked', error: '真实渠道凭据未配置' }; } } });
  try {
    const submitted = await workflow.submitBuying(campaign); job = submitted.job;
    assert.equal(submitted.campaign.status, 'draft');
    const result = await synchronise(workflow, job.id); assert.equal(launchCalls, 1); assert.equal(result.job.status, 'failed'); assert.equal(result.campaign.status, 'blocked');
    assert.notEqual((await f.repository.getCampaign(userId, campaign.id)).status, 'active');
  } finally { f.env.DB.sqlite.close(); }
});

test('changing authorized budget after dispatch rejects employee stale decision without channel mutation', async () => {
  const f = await fixture(), { campaign } = await buyingFixture(f); let job, launchCalls = 0;
  const remote = workforceFixture({ manifest: () => ({ version: 1, jobId: job.id, kind: 'buying', decision: { action: 'launch', campaignId: campaign.id, inputVersion: job.details.inputVersion } }) });
  const workflow = orchestrator(f, remote, { adsService: { async launch() { launchCalls++; throw new Error('stale decision must not launch'); } } });
  try {
    job = (await workflow.submitBuying(campaign)).job; await workflow.syncJob(job.id);
    await f.repository.updateCampaign(userId, campaign.id, { dailyBudget: 150 });
    const result = await synchronise(workflow, job.id); assert.equal(result.job.status, 'failed'); assert.equal(launchCalls, 0); assert.equal((await f.repository.getCampaign(userId, campaign.id)).status, 'draft');
  } finally { f.env.DB.sqlite.close(); }
});

test('routing uses only actual usable hired employees and never fabricates or hires a role', () => {
  const remote = workforceFixture(); const unavailable = { ...remote.employees[0], id: 'expired', usable: false };
  assert.equal(chooseBxagiEmployee([unavailable, ...remote.employees], { kind: 'production', scene: 'apparel' }).employee.id, 'bxagi:market:creative_employee');
  assert.throws(() => chooseBxagiEmployee([unavailable], { kind: 'buying' }), error => error.code === 'bxagi_market_employee_required');
});

// Metadata fixture rewrites preserve the mdat position: ffmpeg writes the initial
// moov at the end. These files are test-only and never become user deliverables.
function rewriteMp4Metadata(input, change) {
  let nextTrack=0;
  const walk=(bytes,track=null)=>{
    const parts=[];
    for(let offset=0;offset<bytes.length;){
      const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);assert.ok(size>=8&&offset+size<=bytes.length);
      const currentTrack=type==='trak'?nextTrack++:track;
      let body=Buffer.from(bytes.subarray(offset+8,offset+size));
      if(['moov','trak','mdia'].includes(type))body=walk(body,currentTrack);
      const edited=change(type,body,currentTrack),bodies=edited===null?[]:Array.isArray(edited)?edited:[edited??body];
      for(const item of bodies){const header=Buffer.alloc(8);header.writeUInt32BE(item.length+8);header.write(type,4,'ascii');parts.push(header,item);}
      offset+=size;
    }
    return Buffer.concat(parts);
  };
  return walk(Buffer.from(input));
}
function mp4VersionOne(type,body) {
  const next=Buffer.alloc(body.length+12);body.copy(next,0,0,4);next[0]=1;
  next.writeBigUInt64BE(BigInt(body.readUInt32BE(4)),4);next.writeBigUInt64BE(BigInt(body.readUInt32BE(8)),12);
  if(type==='tkhd'){body.copy(next,20,12,20);next.writeBigUInt64BE(BigInt(body.readUInt32BE(20)),28);body.copy(next,36,24);}
  else{next.writeUInt32BE(body.readUInt32BE(12),20);next.writeBigUInt64BE(BigInt(body.readUInt32BE(16)),24);body.copy(next,32,20);}
  return next;
}
test('MP4 imports actual v0/v1 video dimensions and duration matching ffprobe, never manifest claims', async () => {
  const directory=mkdtempSync(join(tmpdir(),'bxagi-mp4-metadata-'));
  try{
    const original=join(directory,'fixture.mp4'),faststart=join(directory,'faststart.mp4');
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=blue:size=32x24:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1.25','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac',original],{timeout:10000});
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-i',original,'-map','0','-c','copy','-movflags','+faststart',faststart],{timeout:10000});
    const real=readFileSync(original),v1=rewriteMp4Metadata(real,(type,body,track)=>track===0&&['tkhd','mdhd'].includes(type)?mp4VersionOne(type,body):undefined);
    const good=[['ordinary',real],['faststart',readFileSync(faststart)],['version-one',v1],['tkhd-version-one',rewriteMp4Metadata(real,(type,body,track)=>track===0&&type==='tkhd'?mp4VersionOne(type,body):undefined)],['mdhd-version-one',rewriteMp4Metadata(real,(type,body,track)=>track===0&&type==='mdhd'?mp4VersionOne(type,body):undefined)]];
    const importVideo=async(bytes)=>{
      const f=await fixture(),remote=workforceFixture({artifact:bytes,artifactMime:'video/mp4',manifest:id=>{
        const result=productionManifest(f,id);Object.assign(result.creatives[0],{path:`bxagi-advertising/${id}/output/actual.mp4`,filename:'actual.mp4',mimeType:'video/mp4',width:9999,height:8888,duration:7777});return result;
      }});
      try{const workflow=orchestrator(f,remote),submitted=await workflow.submitProduction(f.project),result=await synchronise(workflow,submitted.job.id);return {result,creatives:await f.repository.listCreatives(userId)};}
      finally{f.env.DB.sqlite.close();}
    };
    for(const [name,bytes] of good){
      const path=join(directory,`${name}.mp4`);writeFileSync(path,bytes);
      const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=codec_name,width,height,duration,r_frame_rate,nb_read_frames','-of','json',path],{timeout:10000})).streams[0];
      assert.equal(probe.codec_name,'h264');assert.equal(probe.r_frame_rate,'24/1');assert.equal(Number(probe.nb_read_frames),30);
      execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-xerror','-err_detect','explode','-i',path,'-map','0','-f','null','-'],{timeout:10000});
      const {result,creatives}=await importVideo(bytes);assert.equal(result.job.status,'completed',name);assert.equal(creatives.length,1,name);
      assert.equal(creatives[0].width,probe.width,name);assert.equal(creatives[0].height,probe.height,name);assert.equal(creatives[0].duration,Number(probe.duration),name);
      assert.equal(creatives[0].metadata.semanticValidated,false);assert.deepEqual(creatives[0].metadata.technicalChecks,{mp4Structure:true,fullDecode:false});
    }
    const mutate=(source,type,edit)=>rewriteMp4Metadata(source,(name,body,track)=>track===0&&name===type?edit(body):undefined);
    const number=(offset,value)=>body=>{body.writeUInt32BE(value,offset);return body;};
    const bigint=(offset,value)=>body=>{body.writeBigUInt64BE(value,offset);return body;};
    const fake=Buffer.alloc(2048);fake.write('ftyp',4);
    const bad=[
      ['fake-ftyp',fake],['truncated-file',real.subarray(0,1024)],
      ['missing-tkhd',mutate(real,'tkhd',()=>null)],['missing-mdhd',mutate(real,'mdhd',()=>null)],
      ['short-tkhd-v0',mutate(real,'tkhd',body=>body.subarray(0,83))],['short-mdhd-v0',mutate(real,'mdhd',body=>body.subarray(0,23))],
      ['short-tkhd-v1',mutate(v1,'tkhd',body=>body.subarray(0,95))],['short-mdhd-v1',mutate(v1,'mdhd',body=>body.subarray(0,35))],
      ['unknown-tkhd-version',mutate(real,'tkhd',body=>{body[0]=2;return body;})],['unknown-mdhd-version',mutate(real,'mdhd',body=>{body[0]=2;return body;})],
      ['zero-width',mutate(real,'tkhd',number(76,0))],['zero-height-v1',mutate(v1,'tkhd',number(92,0))],
      ['fractional-width',mutate(real,'tkhd',number(76,32*65536+1))],['oversized-width',mutate(v1,'tkhd',number(88,8193*65536))],
      ['zero-timescale-v0',mutate(real,'mdhd',number(12,0))],['zero-timescale-v1',mutate(v1,'mdhd',number(20,0))],
      ['zero-duration-v0',mutate(real,'mdhd',number(16,0))],['zero-duration-v1',mutate(v1,'mdhd',bigint(24,0n))],
      ['unknown-duration-v0',mutate(real,'mdhd',number(16,0xffffffff))],['unknown-duration-v1',mutate(v1,'mdhd',bigint(24,0xffffffffffffffffn))],
      ['imprecise-duration-v1',mutate(v1,'mdhd',bigint(24,BigInt(Number.MAX_SAFE_INTEGER)+1n))],
      ['duplicate-tkhd',mutate(real,'tkhd',body=>[body,body])],['duplicate-mdhd',mutate(real,'mdhd',body=>[body,body])],
      ['multiple-video-tracks',mutate(real,'trak',body=>[body,body])],
    ];
    for(const [name,bytes] of bad){const {result,creatives}=await importVideo(bytes);assert.equal(result.job.status,'failed',name);assert.equal(result.job.details.lastErrorCode,'bxagi_invalid_artifact',name);assert.equal(creatives.length,0,name);}
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('manual employee input can resume an existing conversation without another task or instruction', async () => {
  const f = await fixture(), remote = workforceFixture({ executionStatus: 'awaiting_user_input', manifest: new BxagiProtocolError('not_found', '等待用户补充信息', 404) }), workflow = orchestrator(f, remote);
  try {
    const submitted = await workflow.submitProduction(f.project);
    const waiting = await pollUntil(workflow, submitted.job.id, value => value.job.status === 'awaiting_user_input'); assert.equal(waiting.job.status, 'awaiting_user_input');
    assert.equal((await workflow.submitProduction(f.project)).job.id, submitted.job.id);
    remote.api.readManifest = async () => productionManifest(f, submitted.job.id);
    const resumed = await workflow.syncJob(submitted.job.id); assert.equal(resumed.job.status, 'completed');
    assert.equal(remote.calls.filter(call => call.action === 'create').length, 1); assert.equal(remote.calls.filter(call => call.action === 'prompt').length, 1);
    assert.equal((await f.repository.listJobs(userId)).length, 1);
  } finally { f.env.DB.sqlite.close(); }
});

test('long multi-file transfer renews the current operation lease before sending an instruction', async () => {
  const f = await fixture(), remote = workforceFixture(), workflow = orchestrator(f, remote);
  const originalNow = Date.now; let elapsed = 0, leaseChecked = false;
  const initialTime = originalNow();
  try {
    const submitted = await workflow.submitProduction(f.project), upload = remote.api.uploadFile;
    Date.now = () => initialTime + elapsed;
    remote.api.uploadFile = async input => { const receipt = await upload(input); elapsed += 75000; return receipt; };
    remote.api.sendMessage = async () => {
      const actual = await f.repository.getJob(userId, submitted.job.id);
      assert.ok(elapsed > 120000, 'Transfer must exceed the initial lease for this regression');
      assert.ok(Date.parse(actual.details.operationExpiresAt) > Date.now(), 'Current stage must renew the lease');
      assert.equal(await f.repository.claimBxagiJobOperation(userId, submitted.job.id, 'concurrent-dispatch'), null);
      leaseChecked = true; return { transportStatus: 200, liveVerified: false };
    };
    const result = await pollUntil(workflow, submitted.job.id, () => leaseChecked); assert.equal(result.job.status, 'running'); assert.equal(leaseChecked, true);
  } finally { Date.now = originalNow; f.env.DB.sqlite.close(); }
});

test('batch production checkpoints each real transfer and resumes imported artifacts without downloading twice', async () => {
  const f = await fixture();
  const second = await f.repository.createAsset(userId, { projectId: f.project.id, filename: '上衣背面.png', mimeType: 'image/png', size: png.length, objectKey: f.asset.objectKey });
  const remote = workforceFixture({ manifest: id => {
    const result = productionManifest(f, id);
    result.creatives.push({ ...result.creatives[0], path: `bxagi-advertising/${id}/output/back.png`, filename: 'back.png', sourceAssetIds: [second.id] });
    return result;
  } }), workflow = orchestrator(f, remote);
  try {
    const submitted = await workflow.submitProduction(f.project); let result, sawPartial = false;
    for (let poll = 0; poll < 20; poll++) {
      const before = remote.calls.length; result = await workflow.syncJob(submitted.job.id);
      const transfers = remote.calls.slice(before).filter(call => ['upload', 'artifact'].includes(call.action));
      assert.ok(transfers.length <= 1, 'A worker request must transfer at most one actual file');
      const actual = await f.repository.listCreatives(userId);
      if (actual.length === 1) { sawPartial = true; assert.notEqual(result.job.status, 'completed'); }
      if (result.job.status === 'completed') break;
    }
    assert.equal(sawPartial, true); assert.equal(result.job.status, 'completed');
    assert.equal((await f.repository.listCreatives(userId)).length, 2);
    assert.equal(remote.calls.filter(call => call.action === 'artifact').length, 2);
    assert.equal(remote.calls.filter(call => call.action === 'upload').length, 3);
    assert.equal(remote.calls.filter(call => call.action === 'prompt').length, 1);
    assert.deepEqual(new Set(result.job.details.resultCreativeIds).size, 2);
    await workflow.syncJob(submitted.job.id); assert.equal(remote.calls.filter(call => call.action === 'artifact').length, 2);
  } finally { f.env.DB.sqlite.close(); }
});

async function savedSession(f, expiresAt, id = crypto.randomUUID()) {
  return createBxagiSessionRepository(f.env.DB).create(userId, { id, subject: context.subject, profile: context.profile, deviceId: 'fixture-device', tokenCiphertext: await encryptConnectionSecrets({ accessToken: context.accessToken }, f.env.APP_ENCRYPTION_KEY), expiresAt, lastValidatedAt: new Date().toISOString() });
}
async function actualFeedback(f, campaign) {
  const metric = await f.repository.upsertMetrics(userId, { campaignId: campaign.id, date: '2026-10-14', source: 'manual', spend: 75, revenue: 30, conversions: 4, hasConversion: true, dataFresh: true, impressions: 3000, clicks: 70, roi: 30 / 75 });
  const task = await f.repository.addOptimizationTask(userId, { campaignId: campaign.id, projectId: f.project.id, status: 'pending', reason: '真实反馈要求新素材实验', metadata: { metricId: metric.id } });
  return { metric, task };
}

test('background feedback eligibility requires campaign opt-in, matching owner/project and unexpired account session', async () => {
  const f = await fixture();
  try {
    const { campaign } = await buyingFixture(f); await f.repository.updateCampaign(userId, campaign.id, { autoOptimize: true });
    const { task } = await actualFeedback(f, campaign);
    const off = (await buyingFixture(f)).campaign, offTask = (await actualFeedback(f, off)).task;
    await f.repository.addOptimizationTask('native-owner-b', { campaignId: campaign.id, projectId: f.project.id, status: 'pending', reason: 'cross-owner must be excluded', metadata: {} });
    await f.repository.addOptimizationTask(userId, { campaignId: campaign.id, projectId: 'different-project', status: 'pending', reason: 'wrong-project must be excluded', metadata: {} });
    assert.deepEqual(await f.repository.listPendingBxagiOptimizations(), []);
    await savedSession(f, new Date(Date.now() - 60000).toISOString()); assert.deepEqual(await f.repository.listPendingBxagiOptimizations(), []);
    await savedSession(f, new Date(Date.now() + 3600000).toISOString());
    assert.deepEqual((await f.repository.listPendingBxagiOptimizations()).map(row => row.id), [task.id]);
    assert.equal((await f.repository.getOptimizationTask(userId, offTask.id)).status, 'pending');
    await f.repository.updateOptimizationTask(userId, task.id, { metadata: { ...task.metadata, nextBxagiAttemptAt: new Date(Date.now() + 300000).toISOString() } });
    assert.deepEqual(await f.repository.listPendingBxagiOptimizations(), []);
  } finally { f.env.DB.sqlite.close(); }
});

test('worker can queue the opted-in feedback round from actual saved metrics with no page or new media spend', async () => {
  const f = await fixture(), requests = [], resolved = [];
  try {
    const { campaign } = await buyingFixture(f); await f.repository.updateCampaign(userId, campaign.id, { autoOptimize: true });
    const { task, metric } = await actualFeedback(f, campaign), off = (await buyingFixture(f)).campaign, offTask = (await actualFeedback(f, off)).task;
    await savedSession(f, new Date(Date.now() + 3600000).toISOString());
    const fetcher = async (url, options) => {
      requests.push({ url, method: options.method }); const path = new URL(url).pathname;
      assert.equal(new URL(url).origin, 'https://bxagi.xinlx.com'); assert.equal(options.method, 'GET');
      if (path === '/api/v1/employees/mine') return Response.json({ items: [{ employee_id: 'creative_employee', name: '服装素材员工', usable: true, status: 'active', conversation_exists: true, conversation_id: 'hired-creative', memory_space_name: 'owner-memory' }] });
      if (path === '/api/v1/employees/templates') return Response.json([{ id: 'creative_employee', name: '服装素材员工', description: '真实广告素材剪辑与优化', skills: ['素材设计'] }]);
      if (path === '/api/v1/employees/pricing') return Response.json([]);
      if (path === '/api/billing/free-solo-quota') return Response.json({remaining:1,quota:1});
      if (path === '/api/settings') return Response.json({is_cloud_mode:true});
      if (path === '/api/nodes') return Response.json({ nodes: [{ node_id: 'owner-node', status: 'online', gateway_connected: true }] });
      if (path === '/api/v1/app-conversations') return Response.json([{ id: 'hired-creative', employee_id: 'creative_employee', created_by_user_id: context.subject, node_id: 'owner-node', agent_type: 'AgiAgent', selected_repository: 'owner-workspace', memory_space_name: 'owner-memory', sandbox_status: 'RUNNING', execution_status: 'idle' }]);
      throw new Error(`Unexpected protocol endpoint: ${path}`);
    };
    const result = await syncDueBxagiJobs({ repository: f.repository, bucket: f.bucket, env: f.env, fetcher,
      resolveContext: async (owner, _env, options) => { resolved.push(owner); assert.equal(options.required, true); return { ...context, nativeUserId: owner }; },
      adsService: { async launch() { assert.fail('Feedback production must not authorize new media spend'); } },
    });
    assert.equal(result.processed, 1, JSON.stringify({ result, requests, task: await f.repository.getOptimizationTask(userId, task.id) })); assert.equal(result.results[0].optimizationTaskId, task.id); assert.equal(result.results[0].status, 'queued');
    const jobs = await f.repository.listJobs(userId); assert.equal(jobs.length, 1); assert.equal(jobs[0].details.optimizationTaskId, task.id);
    assert.equal(jobs[0].details.optimization.metricId, metric.id); assert.equal(jobs[0].details.optimization.status, 'experiment_ready');
    assert.equal(jobs[0].details.bxagiSubject, context.subject); assert.equal(jobs[0].details.messageSentAt, undefined);
    assert.equal((await f.repository.getOptimizationTask(userId, task.id)).status, 'producing');
    assert.equal((await f.repository.getOptimizationTask(userId, offTask.id)).status, 'pending');
    assert.deepEqual(resolved, [userId]); assert.equal(requests.length, 7); assert.ok(requests.every(request => request.method === 'GET'));
    assert.ok(!JSON.stringify({ result, jobs }).includes(context.accessToken));
    assert.equal((await f.repository.getCampaign(userId, campaign.id)).dailyBudget, 100);
  } finally { f.env.DB.sqlite.close(); }
});

test('routing ranks the complete market before activation and cannot choose an unrelated installed history substitute',()=>{
  const market=workforceFixture().employees[0];
  const finance={...market,id:'bxagi:market:finance',marketId:'finance',name:'金融分析师',description:'财务报表分析',skills:[]};
  const video={...market,id:'bxagi:market:video',marketId:'video',name:'视频剪辑与素材设计',resourceType:'marketplace_template',usable:false,activationState:'not_installed',sourceVerified:false,activation:{freeVerified:false,quote:{monthly:99,annual:999,currency:'CNY'}}};
  assert.throws(()=>chooseBxagiEmployee([finance,video],{kind:'production',scene:'general'}),error=>error.code==='bxagi_market_employee_activation_required'&&error.marketSelection.id===video.id);
  assert.throws(()=>chooseBxagiEmployee([finance],{kind:'production',scene:'general'}),error=>error.code==='bxagi_market_role_unmatched');
});

test('market routing prioritizes actual production and paid buying specialists over assistants and broad design or marketing roles',()=>{
  const base=workforceFixture().employees[0];
  const employee=(marketId,name,skills=[],category='',description='')=>({...base,id:`bxagi:market:${marketId}`,marketId,name,skills,category,description});
  const video=employee('marketing_video_optimization_specialist','视频优化专家',['知识内容/multimedia-creation','数据智能/data-analyst']);
  const drama=employee('short_drama_promo_editor','短剧推广剪辑师',['短剧推广/episode-understanding','短剧推广/clip-planning','短剧推广/ffmpeg-cut','短剧推广/cut-review','短剧推广/promo-cutting-workflow'],'市场部/短剧推广');
  const suit=employee('suit_rendering_designer','西服效果图设计师',['产品体验/jdsuit-ai-render','设计部/suit-render-flow']);
  const buyer=employee('paid_media_programmatic_buyer','程序化广告采买专家',['付费媒体/programmatic-buying-workflow']);
  const assistants=[employee('mac_assistant','Mac个人助理',[],'市场部','处理素材视频剪辑、图像生成和广告投放'),employee('store_assistant','店长助理',[],'市场部','营销创意设计及媒体增长广告采买')];
  const unrelated=[employee('game_designer','游戏设计师',['知识内容/multimedia-creation'],'设计部/游戏','游戏试玩内容创意'),employee('course_designer','课程设计师',['知识内容/multimedia-creation'],'知识内容'),employee('mechanical','机械工程设计师'),employee('strategy','广告策略专家'),employee('marketer','市场营销专家'),employee('planner','片段规划师',['短剧推广/episode-understanding','短剧推广/clip-planning'])];
  const catalog=[...assistants,...unrelated,drama,suit,video,buyer];
  assert.equal(chooseBxagiEmployee(catalog,{kind:'production',scene:'general'}).employee.id,video.id);
  assert.equal(chooseBxagiEmployee(catalog,{kind:'production',scene:'drama'}).employee.id,drama.id);
  assert.equal(chooseBxagiEmployee(catalog,{kind:'production',scene:'apparel'}).employee.id,suit.id);
  assert.equal(chooseBxagiEmployee(catalog,{kind:'production',scene:'game'}).employee.id,video.id);
  assert.equal(chooseBxagiEmployee(catalog,{kind:'buying',scene:'general'}).employee.id,buyer.id);
  for(const candidate of [...assistants,...unrelated]){
    assert.equal(scoreBxagiMarketEmployee(candidate,{kind:'production',scene:'game'}),0,candidate.name);
    assert.equal(scoreBxagiMarketEmployee(candidate,{kind:'buying',scene:'general'}),0,candidate.name);
  }
  assert.equal(scoreBxagiMarketEmployee(buyer,{kind:'production'}),0);
  assert.equal(scoreBxagiMarketEmployee(employee('delivery','广告投放优化专家'),{kind:'production'}),0);
  assert.throws(()=>chooseBxagiEmployee([...assistants,...unrelated],{kind:'buying'}),error=>error.code==='bxagi_market_role_unmatched');
  const uninstalled={...buyer,resourceType:'marketplace_template',usable:false,activationState:'not_installed',sourceVerified:false};
  assert.throws(()=>chooseBxagiEmployee([...assistants,...unrelated,uninstalled],{kind:'buying'}),error=>error.code==='bxagi_market_employee_activation_required'&&error.marketSelection.id===buyer.id);
});

test('paid media auditing, tracking, attribution and strategy do not qualify as execution buying workflows',()=>{
  const base=workforceFixture().employees[1];
  const employee=(marketId,name,skills)=>({...base,id:`bxagi:market:${marketId}`,marketId,name,skills,category:'市场部/付费媒体',description:'付费媒体广告投放运营、媒体购买与增长优化'});
  const buyer=employee('paid_media_programmatic_buyer','程序化广告采买专家',['付费媒体/programmatic-buying-workflow']);
  const nonExecutors=[employee('paid_media_auditor','付费媒体审计师',['付费媒体/paid-media-audit']),employee('tracking_specialist','广告投放追踪专家',['付费媒体/conversion-tracking']),employee('attribution_analyst','广告归因分析师',['付费媒体/attribution-analysis']),employee('search_query_analyst','搜索词分析师',['付费媒体/search-query-analysis']),employee('social_strategist','付费媒体社交策略师',['付费媒体/social-strategy'])];
  for(const candidate of nonExecutors)assert.equal(scoreBxagiMarketEmployee(candidate,{kind:'buying'}),0,candidate.name);
  assert.equal(chooseBxagiEmployee([...nonExecutors,buyer],{kind:'buying'}).employee.id,buyer.id);
  assert.throws(()=>chooseBxagiEmployee(nonExecutors,{kind:'buying'}),error=>error.code==='bxagi_market_role_unmatched');
  // A real execution workflow can be evidence for a mixed role, but cannot
  // outrank the dedicated buying title merely through its department label.
  const mixed={...nonExecutors[0],skills:['付费媒体/programmatic-buying-workflow']};
  assert.ok(scoreBxagiMarketEmployee(mixed,{kind:'buying'})<scoreBxagiMarketEmployee(buyer,{kind:'buying'}));
});

test('saved historical resources are fenced before reusable routing or any remote sync; unknown writes retain their state',async()=>{
  for(const uncertain of [false,true]){
    const f=await fixture(),remote=workforceFixture(),w=orchestrator(f,remote);
    try{
      const job=(await w.submitProduction(f.project)).job;
      const details={...job.details,employee:{...job.details.employee,resourceType:'conversation',marketId:null,marketVerified:false},remoteWritePending:uncertain?'send_instruction':null};
      await f.repository.updateJob(userId,job.id,{status:uncertain?'needs_reconciliation':'running',details});
      const before=remote.calls.length;
      await assert.rejects(()=>w.submitProduction(f.project),error=>error.code==='bxagi_market_employee_required');
      await assert.rejects(()=>w.syncJob(job.id),error=>error.code==='bxagi_market_employee_required');
      assert.equal(remote.calls.length,before);assert.equal(remote.calls.filter(call=>call.action==='create').length,0);
      const preserved=await f.repository.getJob(userId,job.id);assert.equal(preserved.status,uncertain?'needs_reconciliation':'stopped_history_resource');assert.equal(preserved.details.remoteWritePending,uncertain?'send_instruction':null);
    }finally{f.env.DB.sqlite.close();}
  }
});

function activationFixture(remote,{installStatus=200}={}){
  let installed=false,sourceReady=false,installWrites=0;
  const readyEmployee=remote.employees[0],template={...readyEmployee,resourceType:'marketplace_template',installed:false,installation:null,activationState:'not_installed',sourceVerified:false,usable:false,hasSubs:false,
    activation:{required:true,freeVerified:true,freeBasis:'solo_quota',quote:{monthly:0,annual:0,currency:'CNY'},listQuote:{monthly:99,annual:999,currency:'CNY'},quoteScope:'activation_only'}};
  delete template.providerId;delete template.conversationId;
  const marketplace={async inspect(){return {isCloudMode:true,quota:{remaining:installed?2:3,quota:3},employees:[installed?{...template,resourceType:'installed_employee',installed:true,installation:{status:'active'},providerId:readyEmployee.providerId,conversationId:'market-installed-conversation',activationState:sourceReady?'ready':'unverified',sourceVerified:sourceReady,usable:sourceReady}:template,remote.employees[1]]};},async readTemplateDetails(marketId){return {marketId,schedules:[],scheduleCount:0};}};
  const fetcher=async(url,init)=>{
    const parsed=new URL(url);assert.equal(parsed.origin,'https://bxagi.xinlx.com');
    if(parsed.pathname==='/api/nodes'&&init.method==='GET')return Response.json({nodes:[{node_id:'owned-node',status:'online',gateway_connected:true}]});
    assert.equal(parsed.pathname,'/api/v1/employees/install');assert.equal(init.method,'POST');
    assert.deepEqual(JSON.parse(init.body),{template_id:template.marketId,name:template.name,node_id:'owned-node',primary_agent_name:template.name,period:'monthly',locale:'zh'});
    installWrites++;installed=true;
    return Response.json(installStatus===200?{main_conversation_id:'market-installed-conversation'}:{error:'fixture upstream uncertainty'},{status:installStatus});
  };
  return {template,marketplace,fetcher,ready(){sourceReady=true;},writes:()=>installWrites};
}

test('explicit string free-activation flag installs once, waits for real source readiness, then executes production',async()=>{
  const f=await fixture(),remote=workforceFixture({manifest:id=>productionManifest(f,id)}),a=activationFixture(remote);
  f.env.BXAGI_MARKET_AUTO_ACTIVATE_FREE='true';
  const workflow=orchestrator(f,remote,{marketplace:a.marketplace,fetcher:a.fetcher});
  try{
    await assert.rejects(()=>workflow.submitProduction(f.project),error=>error.code==='bxagi_market_activation_pending'&&error.marketSelection.freeBasis==='solo_quota'&&error.marketSelection.quoteScope==='activation_only'&&error.marketSelection.listQuote.monthly===99);
    await assert.rejects(()=>workflow.submitProduction(f.project),error=>error.code==='bxagi_market_activation_pending');
    assert.equal(a.writes(),1);assert.equal((await f.repository.listJobs(userId)).filter(job=>job.type==='bxagi_workflow').length,0);assert.equal(remote.calls.some(call=>call.action==='create'),false);
    a.ready();const submitted=await workflow.submitProduction(f.project);
    assert.equal(submitted.job.status,'queued');assert.equal(submitted.job.details.employee.resourceType,'installed_employee');assert.equal(submitted.job.details.employee.sourceVerified,true);
    assert.equal((await workflow.submitProduction(f.project)).job.id,submitted.job.id);assert.equal(a.writes(),1);
    const result=await synchronise(workflow,submitted.job.id);assert.equal(result.job.status,'completed');assert.equal(result.creatives.length,1);assert.equal(a.writes(),1);
  }finally{f.env.DB.sqlite.close();}
});

test('free activation never starts without explicit enablement, verified free quota or a new Solo template',async()=>{
  for(const scenario of ['disabled','no_free_quota','expired','team']){
    const f=await fixture(),remote=workforceFixture(),a=activationFixture(remote);let activationCalls=0;
    f.env.BXAGI_MARKET_AUTO_ACTIVATE_FREE=scenario==='disabled'?'false':true;
    const candidate={...a.template,activation:{...a.template.activation,freeVerified:scenario!=='no_free_quota'},...(scenario==='expired'?{resourceType:'installed_employee',installed:true,installation:{status:'expired'},activationState:'unverified'}:{}),...(scenario==='team'?{hasSubs:true}:{})};
    const marketplace={async inspect(){return {employees:[candidate],isCloudMode:true,quota:{remaining:scenario==='no_free_quota'?0:3,quota:3}};}};
    const workflow=orchestrator(f,remote,{marketplace,marketActivation:{async activate(){activationCalls++;assert.fail('activation must not be called');}}});
    try{
      await assert.rejects(()=>workflow.submitProduction(f.project),error=>error.code==='bxagi_market_employee_activation_required');assert.equal(activationCalls,0);assert.equal(remote.calls.some(call=>call.action==='create'),false);assert.equal((await f.repository.listJobs(userId)).length,0);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('unknown installation outcome is durable, never retries and cannot produce even when a later catalogue looks ready',async()=>{
  const f=await fixture(),remote=workforceFixture(),a=activationFixture(remote,{installStatus:500});f.env.BXAGI_MARKET_AUTO_ACTIVATE_FREE=true;
  const workflow=orchestrator(f,remote,{marketplace:a.marketplace,fetcher:a.fetcher});
  try{
    await assert.rejects(()=>workflow.submitProduction(f.project),error=>error.code==='bxagi_market_activation_needs_reconciliation');
    const receipt=await f.repository.getBxagiMarketActivation(userId,a.template.marketId,f.context.subject);assert.equal(receipt.status,'needs_reconciliation');assert.equal(receipt.details.remoteWritePending,'install_market_employee');
    a.ready();await assert.rejects(()=>workflow.submitProduction(f.project),error=>error.code==='bxagi_market_activation_needs_reconciliation');
    assert.equal(a.writes(),1);assert.equal((await f.repository.listJobs(userId)).filter(job=>job.type==='bxagi_workflow').length,0);assert.equal(remote.calls.some(call=>call.action==='create'),false);
  }finally{f.env.DB.sqlite.close();}
});

test('public activation evidence distinguishes quota activation from list prices and drops untrusted quote fields',()=>{
  const a=activationFixture(workforceFixture()),publicValue=publicMarketSelection(a.template);
  assert.deepEqual(publicValue.quote,{monthly:0,annual:0,currency:'CNY'});assert.deepEqual(publicValue.listQuote,{monthly:99,annual:999,currency:'CNY'});assert.equal(publicValue.freeBasis,'solo_quota');assert.equal(publicValue.quoteScope,'activation_only');
  const invalid=publicMarketSelection({...a.template,activation:{...a.template.activation,freeBasis:'unverified_secret',quoteScope:'forever_free',listQuote:{monthly:-1,annual:99,currency:'CNY',secret:'not-public'}}});
  assert.equal(invalid.freeBasis,undefined);assert.equal(invalid.quoteScope,undefined);assert.equal(invalid.listQuote,undefined);assert.equal(JSON.stringify(invalid).includes('not-public'),false);
});

test('startup READY waits for actual runtime readiness before each input or prompt write and persists safe checkpoints',async()=>{
  const f=await fixture(),remote=workforceFixture({manifest:id=>productionManifest(f,id)});let runtimeStatus='starting';
  remote.api.ensureRuntime=async({conversation})=>{remote.calls.push({action:'runtime',id:conversation.id,status:runtimeStatus});return {status:runtimeStatus,liveVerified:false};};
  const workflow=orchestrator(f,remote);
  try{
    const submitted=await workflow.submitProduction(f.project);await workflow.syncJob(submitted.job.id);
    const startup=await workflow.syncJob(submitted.job.id);assert.equal(startup.job.status,'starting');assert.ok(startup.job.details.conversationId);
    for(const status of ['starting','missing']){
      runtimeStatus=status;const waiting=await workflow.syncJob(submitted.job.id);assert.equal(waiting.job.status,'starting');assert.equal(waiting.job.details.runtimeStatus,status);assert.equal(waiting.job.details.remoteWritePending,null);assert.equal(waiting.job.details.runtimeReadyAt,null);
      assert.equal(remote.calls.some(call=>['upload','prompt'].includes(call.action)),false);
    }
    runtimeStatus='ready';const ready=await workflow.syncJob(submitted.job.id);assert.equal(ready.job.details.runtimeStatus,'ready');assert.ok(ready.job.details.runtimeReadyAt);assert.equal(remote.calls.some(call=>call.action==='upload'),false);
    await workflow.syncJob(submitted.job.id);assert.equal(remote.calls.filter(call=>call.action==='upload').length,1);
    runtimeStatus='missing';const interrupted=await workflow.syncJob(submitted.job.id);assert.equal(interrupted.job.details.runtimeStatus,'missing');assert.equal(remote.calls.filter(call=>call.action==='upload').length,1);
    runtimeStatus='ready';await workflow.syncJob(submitted.job.id);await workflow.syncJob(submitted.job.id);assert.equal(remote.calls.filter(call=>call.action==='upload').length,2);
    runtimeStatus='starting';await workflow.syncJob(submitted.job.id);assert.equal(remote.calls.some(call=>call.action==='prompt'),false);
    runtimeStatus='ready';await workflow.syncJob(submitted.job.id);const result=await synchronise(workflow,submitted.job.id);assert.equal(result.job.status,'completed');assert.equal(remote.calls.filter(call=>call.action==='prompt').length,1);assert.equal(remote.calls.filter(call=>call.action==='create').length,1);
    for(let index=0;index<remote.calls.length;index++)if(['upload','prompt'].includes(remote.calls[index].action))assert.equal(remote.calls.slice(0,index).findLast(call=>call.action==='runtime').status,'ready');
  }finally{f.env.DB.sqlite.close();}
});

test('a market task conversation must name the selected employee before runtime, input or prompt operations',async()=>{
  for(const employeeId of [null,'','different_employee']){
    const f=await fixture(),remote=workforceFixture();
    remote.api.getConversation=async id=>({id,employee_id:employeeId,node_id:'authorized-node',selected_repository:'owner-project'});
    remote.api.ensureRuntime=async()=>{remote.calls.push({action:'runtime'});return {status:'ready'};};
    const workflow=orchestrator(f,remote);
    try{
      const submitted=await workflow.submitProduction(f.project);await workflow.syncJob(submitted.job.id);await workflow.syncJob(submitted.job.id);
      const result=await workflow.syncJob(submitted.job.id);assert.equal(result.job.status,'failed');assert.equal(result.job.details.lastErrorCode,'bxagi_task_employee_mismatch');assert.equal(result.job.details.lastErrorStatus,422);
      assert.equal(remote.calls.some(call=>['runtime','upload','prompt','artifact'].includes(call.action)),false);assert.equal(result.job.details.messageSentAt,undefined);assert.equal(result.job.details.remoteWritePending,null);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('proven pre-send transport failure clears only the instruction checkpoint and resumes the same uploaded task',async()=>{
  const f=await fixture(),remote=workforceFixture({sendError:Object.assign(new Error('fixture handshake unavailable'),{status:502,code:'message_handshake_failed',messageSent:false,uncertain:false})}),workflow=orchestrator(f,remote);
  try{
    const submitted=await workflow.submitProduction(f.project),waiting=await pollUntil(workflow,submitted.job.id,value=>value.job.details.lastErrorCode==='message_handshake_failed');
    assert.equal(waiting.job.status,'awaiting_result');assert.equal(waiting.job.details.remoteWritePending,null);assert.equal(waiting.job.details.messageSentAt,undefined);assert.equal(waiting.job.details.inputsReady,true);
    const conversationId=waiting.job.details.conversationId,uploads=remote.calls.filter(call=>call.action==='upload').length;
    remote.api.sendMessage=async(id,prompt)=>{remote.calls.push({action:'acknowledged-prompt',conversationId:id,prompt});return {transport:'bxagi_ws',messageAcknowledged:true,eventId:'new-user-event'};};
    const early=await workflow.syncJob(submitted.job.id);assert.equal(early.waitingForRecovery,true);assert.equal(remote.calls.filter(call=>call.action==='acknowledged-prompt').length,0);
    await f.repository.updateJob(userId,waiting.job.id,{details:{...waiting.job.details,recovery:{...waiting.job.details.recovery,nextRetryAt:'2000-01-01T00:00:00Z'}}});
    const resumed=await workflow.syncJob(submitted.job.id);assert.equal(resumed.job.id,submitted.job.id);assert.equal(resumed.job.details.conversationId,conversationId);assert.ok(resumed.job.details.messageSentAt);assert.equal(resumed.job.details.remoteWritePending,null);
    assert.equal(resumed.job.details.messageTransport,'bxagi_ws');assert.equal(resumed.job.details.messageAcknowledged,true);assert.equal(resumed.job.details.messageEventId,'new-user-event');assert.equal(resumed.job.details.messageAlreadyDelivered,false);
    assert.equal(remote.calls.filter(call=>call.action==='create').length,1);assert.equal(remote.calls.filter(call=>call.action==='upload').length,uploads);assert.equal(remote.calls.filter(call=>call.action==='acknowledged-prompt').length,1);
  }finally{f.env.DB.sqlite.close();}
});

test('unmarked or already-sent transport failures remain uncertain and never replay the instruction',async()=>{
  for(const markers of [{},{messageSent:false},{messageSent:true,uncertain:true}]){
    const f=await fixture(),remote=workforceFixture({sendError:Object.assign(new Error('fixture dispatch failure'),{status:502,code:'message_dispatch_failed',...markers})}),workflow=orchestrator(f,remote);
    try{
      const submitted=await workflow.submitProduction(f.project),waiting=await pollUntil(workflow,submitted.job.id,value=>value.job.status==='needs_reconciliation');
      assert.equal(waiting.job.details.remoteWritePending,'send_instruction');assert.equal(waiting.job.details.messageSentAt,undefined);const before=remote.calls.length;
      await workflow.syncJob(submitted.job.id);assert.equal(remote.calls.length,before);assert.equal(remote.calls.filter(call=>call.action==='prompt').length,1);
    }finally{f.env.DB.sqlite.close();}
  }
});

test('message receipts distinguish an already delivered instruction and omit unknown transports, secrets and legacy acknowledgements',async()=>{
  for(const receipt of [{transport:'bxagi_events',messageAcknowledged:true,eventId:'owned-existing-user-event',alreadyDelivered:true},{transport:'untrusted',messageAcknowledged:true,eventId:context.accessToken},{transport:'bxagi_ws',messageAcknowledged:true,eventId:'sk-private-credential'},undefined]){
    const f=await fixture(),remote=workforceFixture();remote.api.sendMessage=async()=>receipt;const workflow=orchestrator(f,remote);
    try{
      const submitted=await workflow.submitProduction(f.project),result=await pollUntil(workflow,submitted.job.id,value=>!!value.job.details.messageSentAt),details=result.job.details;
      assert.equal(details.messageAcknowledged,receipt?.messageAcknowledged===true);assert.equal(details.messageAlreadyDelivered,receipt?.alreadyDelivered===true);
      assert.equal(details.messageTransport,['bxagi_ws','bxagi_events'].includes(receipt?.transport)?receipt.transport:undefined);assert.equal(details.messageEventId,receipt?.eventId==='owned-existing-user-event'?receipt.eventId:undefined);
      assert.equal(JSON.stringify(result.job).includes(context.accessToken),false);
    }finally{f.env.DB.sqlite.close();}
  }
});


test('production execution prioritizes a material-producing expert over a higher-category teaching coach',()=>{
  const base=workforceFixture().employees[0];
  const expert={...base,id:'bxagi:market:video-expert',marketId:'video-expert',name:'视频优化专家',description:'缩略图概念设计与视频优化，使用多媒体制作出图',skills:['知识内容/multimedia-creation'],category:'市场部/视频平台'};
  const coach={...base,id:'bxagi:market:video-coach',marketId:'video-coach',name:'短视频剪辑教练',description:'视频剪辑教学与示范素材制作',skills:['知识内容/multimedia-creation','视频制作/editing-coaching-workflow'],category:'市场部/视频制作'};
  assert.equal(chooseBxagiEmployee([coach,expert],{kind:'production',scene:'general'}).employee.id,expert.id);
});

test('sealed upload batch waits for all owner files, freezes inputs, and explicit production is idempotent', async () => {
  const { createProductionService } = await import('../server/production-service.mjs');
  const f=await fixture(),remote=workforceFixture(),workflow=orchestrator(f,remote);
  const service=createProductionService({repository:f.repository,bucket:f.bucket,context:f.context,orchestrator:workflow});
  const created=await service.beginBatch(f.project.id,{expectedCount:2});
  const add=async name=>{const key=crypto.randomUUID();await f.bucket.put(key,png);return f.repository.createAsset(userId,{projectId:f.project.id,filename:name,mimeType:'image/png',size:png.length,objectKey:key,metadata:{uploadBatchId:created.batch.id}});};
  const first=await add('a.png');
  await assert.rejects(service.completeBatch(f.project.id,created.batch.id,{assetIds:[first.id]}),e=>e.code==='upload_batch_incomplete');
  await assert.rejects(service.start(f.project.id,{productionSpec:{mediaType:'image',format:'square'}}),e=>e.code==='upload_batch_not_sealed');
  assert.equal(remote.calls.length,0);
  const second=await add('b.png');
  const sealed=await service.completeBatch(f.project.id,created.batch.id,{assetIds:[first.id,second.id]});
  assert.equal(sealed.batch.status,'sealed');
  await assert.rejects(service.assertBatchUpload(f.project.id,created.batch.id),e=>e.code==='upload_batch_closed');
  await assert.rejects(service.completeBatch(f.project.id,created.batch.id,{assetIds:[f.asset.id,first.id]}),e=>e.code==='upload_batch_closed');
  const request={batchId:created.batch.id,productionSpec:{targetCount:2,mediaType:'image',format:'square',employeeMode:'manual',employeeId:remote.employees[0].id,instructions:'保留真实商品颜色'}};
  const started=await service.start(f.project.id,request);
  assert.deepEqual([...started.job.details.assetIds].sort(),[first.id,second.id].sort());
  assert.equal(started.job.details.productionSpec.targetCount,2);
  assert.equal(started.assignment.routingMode,'manual');
  assert.equal((await service.start(f.project.id,request)).job.id,started.job.id);
  await assert.rejects(service.start(f.project.id,{...request,productionSpec:{...request.productionSpec,targetCount:3}}),e=>e.code==='production_request_frozen');
  const newer=await service.beginBatch(f.project.id,{expectedCount:1,reuseAssetIds:[f.asset.id]});
  await service.completeBatch(f.project.id,newer.batch.id,{assetIds:[f.asset.id]});
  assert.deepEqual((await f.repository.getJob(userId,started.job.id)).details.assetIds,started.job.details.assetIds);
  const stranger=createProductionService({repository:f.repository,bucket:f.bucket,context:{...f.context,nativeUserId:'stranger'},orchestrator:workflow});
  await assert.rejects(stranger.completeBatch(f.project.id,created.batch.id,{assetIds:[first.id,second.id]}),e=>e.status===404);
});

test('manual selection must be an official production role and cannot be replaced by coordinator routing', async () => {
  const { createProductionService } = await import('../server/production-service.mjs');
  const f=await fixture(),remote=workforceFixture(),workflow=orchestrator(f,remote,{env:{...f.env,BXAGI_BUTLER_ENABLED:'true'}});
  const service=createProductionService({repository:f.repository,bucket:f.bucket,context:f.context,orchestrator:workflow});
  const batch=await service.beginBatch(f.project.id,{expectedCount:1,reuseAssetIds:[f.asset.id]});await service.completeBatch(f.project.id,batch.batch.id,{assetIds:[f.asset.id]});
  await assert.rejects(service.start(f.project.id,{productionSpec:{mediaType:'image',format:'square',employeeMode:'manual',employeeId:remote.employees[1].id}}),e=>e.code==='bxagi_market_role_unmatched');
  // Failed frozen requests require a new explicitly selected batch, never silent reassignment.
  const second=await service.beginBatch(f.project.id,{expectedCount:1,reuseAssetIds:[f.asset.id]});await service.completeBatch(f.project.id,second.batch.id,{assetIds:[f.asset.id]});
  const started=await service.start(f.project.id,{productionSpec:{mediaType:'image',format:'square',employeeMode:'manual',employeeId:remote.employees[0].id}});
  await workflow.syncJob(started.job.id);
  assert.ok(remote.calls.find(call=>call.action==='create'));
  assert.equal((await f.repository.getJob(userId,started.job.id)).details.coordination,undefined);
});

test('requested primary count excludes covers, partial media stays unlaunchable, and complete variants carry frozen version', async () => {
  const { createProductionService } = await import('../server/production-service.mjs');
  const { assertCreativeDeliveryComplete } = await import('../server/creative-delivery-eligibility.mjs');
  for(const count of [1,3]){
    const f=await fixture(),remote=workforceFixture({manifest:id=>productionManifest(f,id,{creatives:[...Array.from({length:count},(_,index)=>({path:`bxagi-advertising/${id}/output/variant-${index}.png`,filename:`variant-${index}.png`,mimeType:'image/png',role:'primary',format:'square',sourceAssetIds:[f.asset.id]})),{path:`bxagi-advertising/${id}/output/cover.png`,filename:'cover.png',mimeType:'image/png',role:'cover',format:'square',sourceAssetIds:[f.asset.id]}]})});
    remote.api.readArtifact=async input=>{const index=Number(/variant-(\d+)/.exec(input.relativePath)?.[1]||0);return new Response(actualPng(24+index*6,24+index*6));};
    const workflow=orchestrator(f,remote),service=createProductionService({repository:f.repository,bucket:f.bucket,context:f.context,orchestrator:workflow});
    const started=await service.start(f.project.id,{productionSpec:{targetCount:3,mediaType:'image',format:'square'}});
    let result;
    for(let i=0;i<20;i++){result=await workflow.syncJob(started.job.id);if(['partial','completed','failed'].includes(result.job.status))break;}
    assert.equal(result.job.status,count===1?'partial':'completed');
    assert.equal(result.job.details.delivery.actualPrimaryCount,count);
    const rows=await f.repository.listCreatives(userId,f.project.id);
    assert.equal(rows.length,count+1);const primary=rows.find(row=>row.metadata.deliverableRole==='primary');assert.ok(primary);assert.equal(primary.metadata.productionVersion.batchId,started.job.details.batchId);
    if(count===1)await assert.rejects(assertCreativeDeliveryComplete({repository:f.repository,userId,creative:primary}),e=>e.code==='bxagi_delivery_incomplete');
    else await assertCreativeDeliveryComplete({repository:f.repository,userId,creative:primary});
  }
});

test('sealed files up to storage limit do not silently exceed the employee transfer limit',async()=>{
  const { createProductionService } = await import('../server/production-service.mjs');
  const f=await fixture(),remote=workforceFixture(),workflow=orchestrator(f,remote),service=createProductionService({repository:f.repository,bucket:f.bucket,context:f.context,orchestrator:workflow});
  const bytes=new Uint8Array(17*1024*1024),key='large-input';await f.bucket.put(key,bytes);
  const large=await f.repository.createAsset(userId,{projectId:f.project.id,filename:'large.mp4',mimeType:'video/mp4',size:bytes.length,objectKey:key});
  const batch=await service.beginBatch(f.project.id,{expectedCount:1,reuseAssetIds:[large.id]});
  assert.equal((await service.completeBatch(f.project.id,batch.batch.id,{assetIds:[large.id]})).batch.status,'sealed');
  await assert.rejects(service.start(f.project.id,{}),e=>e.code==='production_sources_invalid'&&e.message.includes('16MiB'));
  assert.equal(remote.calls.length,0);
});

test('lost batch bookkeeping after queue creation never duplicates the same frozen employee request',async()=>{
  const { createProductionService } = await import('../server/production-service.mjs');
  const f=await fixture(),remote=workforceFixture(),workflow=orchestrator(f,remote);let failOnce=true;
  const wrapped={...f.repository,async updateJob(u,id,patch){if(failOnce&&patch.details?.startedJobId){failOnce=false;throw new Error('injected storage failure');}return f.repository.updateJob(u,id,patch);}};
  const service=createProductionService({repository:wrapped,bucket:f.bucket,context:f.context,orchestrator:workflow});
  const options={productionSpec:{targetCount:1,mediaType:'image',format:'square'}};
  await assert.rejects(service.start(f.project.id,options),/injected storage failure/);
  const first=(await f.repository.listJobs(userId)).find(row=>row.type==='bxagi_workflow');assert.ok(first);
  const retried=await service.start(f.project.id,options);assert.equal(retried.job.id,first.id);
  assert.equal((await f.repository.listJobs(userId)).filter(row=>row.type==='bxagi_workflow').length,1);
});

test('accepted business decisions require explicit owner start, preserve the original job and never invent metric evidence',async()=>{
 const {createProductionService}=await import('../server/production-service.mjs');
 const f=await fixture(),remote=workforceFixture({manifest:id=>productionManifest(f,id,{creatives:[{path:`bxagi-advertising/${id}/output/result.png`,filename:'result.png',mimeType:'image/png',role:'primary',format:'square',sourceAssetIds:[f.asset.id]}]})}),workflow=orchestrator(f,remote);
 const service=createProductionService({repository:f.repository,bucket:f.bucket,context:f.context,orchestrator:workflow}),productionSpec={mediaType:'image',format:'square',targetCount:1};
 const initial=await service.start(f.project.id,{productionSpec});assert.equal((await synchronise(workflow,initial.job.id)).job.status,'completed');
 const decision=await f.repository.createDecision(userId,{projectId:f.project.id,type:'material',status:'proposed',title:'改善产品卖点表达',reason:'用户采纳前仅建议',evidence:{},actionPlan:{kind:'optimization_task',instructions:'突出用户已提供的面料事实，不新增功效'},result:{}});
 const task=await f.repository.addOptimizationTask(userId,{projectId:f.project.id,campaignId:'',type:'creative_optimization',status:'pending',reason:'素材要求',metadata:{origin:'business_decision',approval:'accepted',sourceDecisionId:decision.id}});
 await assert.rejects(service.start(f.project.id,{optimizationTaskId:task.id,productionSpec}),e=>e.code==='bxagi_decision_not_accepted');
 assert.equal((await f.repository.getOptimizationTask(userId,task.id)).status,'pending');
 await f.repository.updateDecision(userId,decision.id,{status:'accepted',result:{optimizationTaskId:task.id}});
 const next=await service.start(f.project.id,{optimizationTaskId:task.id,productionSpec});assert.notEqual(next.job.id,initial.job.id);
 assert.equal(next.job.details.optimization.origin,'business_decision');assert.equal(next.job.details.optimization.metricId,undefined);assert.equal(next.job.details.optimization.instructions,'突出用户已提供的面料事实，不新增功效');
 assert.equal((await synchronise(workflow,next.job.id)).job.status,'completed');assert.equal((await f.repository.getOptimizationTask(userId,task.id)).status,'completed');
 assert.equal((await service.start(f.project.id,{optimizationTaskId:task.id,productionSpec})).job.id,next.job.id);
 assert.equal((await f.repository.listJobs(userId)).filter(j=>j.type==='bxagi_workflow').length,2);
 const prompt=remote.calls.filter(call=>call.action==='prompt').at(-1).prompt;assert.match(prompt,/用户已采纳/);assert.match(prompt,/不新增功效/);
});

test('one sealed package can include previously uploaded sources plus a new upload without starting halfway',async()=>{
 const {createProductionService}=await import('../server/production-service.mjs');const f=await fixture(),remote=workforceFixture(),service=createProductionService({repository:f.repository,bucket:f.bucket,context:f.context,orchestrator:orchestrator(f,remote)});
 const created=await service.beginBatch(f.project.id,{expectedCount:2,reuseAssetIds:[f.asset.id]});assert.deepEqual(created.batch.assetIds,[f.asset.id]);
 await service.assertBatchUpload(f.project.id,created.batch.id);
 await assert.rejects(service.completeBatch(f.project.id,created.batch.id,{assetIds:[f.asset.id]}),e=>e.code==='upload_batch_incomplete');
 const key=crypto.randomUUID();await f.bucket.put(key,png);const extra=await f.repository.createAsset(userId,{projectId:f.project.id,filename:'extra.png',mimeType:'image/png',size:png.length,objectKey:key,metadata:{uploadBatchId:created.batch.id}});
 const sealed=await service.completeBatch(f.project.id,created.batch.id,{assetIds:[f.asset.id,extra.id]});assert.equal(sealed.batch.assetIds.length,2);assert.equal(remote.calls.length,0);
 const result=await service.start(f.project.id,{productionSpec:{mediaType:'image',format:'square'}});assert.deepEqual([...result.job.details.assetIds].sort(),[f.asset.id,extra.id].sort());
});
