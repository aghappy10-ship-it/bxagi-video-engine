import { deflateSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createAutomaticFlow,describeAutomaticFlow } from '../server/automatic-flow.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createBxagiOrchestrator } from '../server/bxagi-orchestrator.mjs';
import { createBxagiAccountRepository } from '../server/bxagi-account-repository.mjs';
import { createBxagiSessionRepository } from '../server/bxagi-session-repository.mjs';
import { encryptConnectionSecrets } from '../server/adapters/connection-secrets.mjs';
function actualPng(width=24,height=24) {
  const crc = bytes => { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (name, body) => { const content = Buffer.concat([Buffer.from(name), body]), header = Buffer.alloc(4), tail = Buffer.alloc(4); header.writeUInt32BE(body.length); tail.writeUInt32BE(crc(content)); return Buffer.concat([header, content, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const offset = y * (width * 4 + 1) + 1 + x * 4; pixels[offset] = 220; pixels[offset + 1] = 60; pixels[offset + 2] = 90; pixels[offset + 3] = 255; }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]));
}

function database(){const sqlite=new DatabaseSync(':memory:'),directory=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,directory),'utf8'));return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};}
function bucket(){const values=new Map();return {values,async put(key,body){const bytes=new Uint8Array(await new Response(body).arrayBuffer());values.set(key,bytes);return {size:bytes.length};},async get(key){const bytes=values.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),async arrayBuffer(){return bytes.slice().buffer;}}:null;},async delete(key){values.delete(key);}};}
async function fixture(){
 const env={DB:database(),BUCKET:bucket(),APP_ENCRYPTION_KEY:'91'.repeat(32)},repo=createPlatformRepository(env.DB),accounts=createBxagiAccountRepository(env.DB),calls=[],state={employeesAvailable:true,meStatus:200,waiting:false,contexts:new Map(),paidCalls:0},owner=await accounts.resolveVerifiedSubject('automatic-subject-a'),other=await accounts.resolveVerifiedSubject('automatic-subject-b');
 for(const account of [owner,other]){const token=`fixture-token-${account.subject}`;await createBxagiSessionRepository(env.DB).create(account.userId,{id:account.subject===owner.subject?'a'.repeat(64):'b'.repeat(64),subject:account.subject,tokenCiphertext:await encryptConnectionSecrets({accessToken:token},env.APP_ENCRYPTION_KEY),profile:{id:account.subject},deviceId:'fixture-device',expiresAt:new Date(Date.now()+3600000).toISOString(),lastValidatedAt:new Date().toISOString()});state.contexts.set(account.subject,{userId:account.userId,nativeUserId:account.userId,subject:account.subject,accessToken:token});}
 const context=state.contexts.get(owner.subject),fetcher=async(url,init)=>{calls.push('me');assert.equal(url,'https://bxagi.xinlx.com/api/auth/me');const found=[...state.contexts.values()].find(c=>init.headers.Authorization===`Bearer ${c.accessToken}`);assert.ok(found);return Response.json(state.meStatus===200?{id:found.subject}:{detail:'private details'},{status:state.meStatus});};
 const employee={id:'bxagi:market:existing-employee',providerId:'existing-employee',provider:'bxagi',resourceType:'installed_employee',marketId:'existing-employee',marketVerified:true,activationState:'ready',sourceVerified:true,installed:true,name:'广告素材制作与广告运营员工',skills:['文案','广告运营'],usable:true,conversationId:'hired-source'};
 const workforce={
  async listEmployees(){calls.push('catalog');return state.employeesAvailable?[employee]:[];},
  async createConversation({jobId}){calls.push(`create:${jobId}`);return {startTaskId:jobId};},
  async getStartTask(id){calls.push('start');return {status:'READY',conversationId:id};},
  async getConversation(id){calls.push('conversation');return {id,employeeId:employee.providerId,executionStatus:state.waiting?'awaiting_user_confirmation':'RUNNING'};},
  async uploadFile(input){calls.push('upload');assert.ok(new Uint8Array(await input.blob.arrayBuffer()).length>0);return {relativePath:`${input.directory}/${input.filename}`};},
  async sendMessage(_id,prompt){calls.push('instruction');assert.match(prompt,/不要自行购买、雇佣、续费/);},
  async readManifest({conversation}){calls.push('manifest');if(state.waiting)throw Object.assign(new Error('missing'),{status:404});const rows=await repo.listJobs(owner.userId),job=rows.find(j=>j.id===conversation.id);assert.ok(job);if(job.details.kind==='buying')return {version:1,jobId:job.id,kind:'buying',decision:{action:job.details.action,campaignId:job.details.campaignId,inputVersion:job.details.inputVersion}};return {version:1,jobId:job.id,kind:'production',creatives:[{path:`bxagi-advertising/${job.id}/output/result.png`,filename:'result.png',mimeType:'image/png',format:'square',title:'实际素材文案',sourceAssetIds:job.details.assetIds,factsUsed:['真实提供的事实']}]};},
  async readArtifact(){calls.push('artifact');return new Response(actualPng());}
 };
 const adsService={async launch(userId,campaign){state.paidCalls++;assert.equal(userId,owner.userId);return repo.updateCampaign(userId,campaign.id,{status:'active',remoteId:'fixture-remote-id'});},async pause(userId,campaign){state.paidCalls++;return repo.updateCampaign(userId,campaign.id,{status:'paused'});}};
 const factory=options=>createBxagiOrchestrator({...options,workforce}),automation=createAutomaticFlow({repository:repo,bucket:env.BUCKET,env,fetcher,createOrchestrator:factory,adsService});
 const project=await repo.createProject(owner.userId,{title:'原始素材项目',productName:'产品',description:'用户事实',facts:['真实提供的事实'],objective:'views',scene:'general'});
 async function source(metadata={}){const key=`fixture-source-${crypto.randomUUID()}`,bytes=new TextEncoder().encode('实际原始素材，真实提供的事实');await env.BUCKET.put(key,bytes);return repo.createAsset(owner.userId,{projectId:project.id,filename:'source.txt',mimeType:'text/plain',size:bytes.length,role:'source',objectKey:key,metadata});}
 await source();
 async function wake(){const flows=(await repo.listJobs(owner.userId)).filter(j=>j.type==='platform_automation');for(const flow of flows)await repo.updateJob(owner.userId,flow.id,{details:{...flow.details,nextActionAt:'2000-01-01T00:00:00Z'}});}
 async function tick(){await wake();return automation.tick({userId:owner.userId});}
 async function finish(){let result;for(let i=0;i<20;i++){result=await tick();if(['awaiting_budget','awaiting_explicit_launch','awaiting_real_metrics'].includes(result.results[0]?.waiting?.code))return result;}assert.fail('Actual production did not finish');}
 return {env,repo,owner,other,context,state,calls,workforce,factory,adsService,automation,project,source,wake,tick,finish};
}
test('uploads reserve one tenant flow and concurrent ticks queue one real production without granting ad spend',async()=>{
 const f=await fixture();await Promise.all([f.automation.ensureProject(f.context,f.project.id,{notBefore:'2000-01-01T00:00:00Z'}),f.automation.ensureProject(f.context,f.project.id,{notBefore:'2000-01-01T00:00:00Z'})]);assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='platform_automation').length,1);
 await Promise.all([f.automation.tick({userId:f.owner.userId}),f.automation.tick({userId:f.owner.userId})]);const jobs=await f.repo.listJobs(f.owner.userId);assert.equal(jobs.filter(j=>j.type==='bxagi_workflow').length,1);assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,0);assert.equal(f.state.paidCalls,0);
 await assert.rejects(f.automation.ensureProject({...f.context,userId:f.other.userId,nativeUserId:f.other.userId},f.project.id),e=>e.status===404);
 await assert.rejects(f.automation.tick({userId:f.other.userId,context:f.context}),e=>e.status===403);assert.equal((await f.automation.tick({userId:f.other.userId})).processed,0);
});
test('automatic ticks deliver real sources, recycle actual artifacts and stop at budget; same source never loops production',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);const completed=await f.finish();assert.equal(completed.results[0].waiting.code,'awaiting_budget');assert.ok(completed.results[0].lastCompletedProductionJobId);assert.equal(f.state.paidCalls,0);assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,1);
 const creatives=await f.repo.listCreatives(f.owner.userId,f.project.id);assert.equal(creatives.length,1);assert.ok((await f.env.BUCKET.get(creatives[0].objectKey)).size>0);for(let i=0;i<3;i++)await f.tick();assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,1);assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,1);
 const flow=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='platform_automation'),summary=describeAutomaticFlow(flow);assert.ok(!JSON.stringify(summary).includes(f.context.accessToken));assert.ok(!JSON.stringify(summary).includes(f.owner.userId));assert.ok(!Object.hasOwn(summary,'details'));
 await f.env.BUCKET.delete(creatives[0].objectKey);assert.equal((await f.tick()).results[0].waiting.code,'artifact_missing');assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,1);
});
test('budget drafts do not create buying work; only an already explicit authorized launch job can progress',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.finish();const creative=(await f.repo.listCreatives(f.owner.userId,f.project.id))[0];await f.repo.updateCreative(f.owner.userId,creative.id,{status:'approved',reviewedBy:f.owner.userId,reviewedAt:new Date().toISOString()});
 const campaign=await f.repo.createCampaign(f.owner.userId,{projectId:f.project.id,creativeIds:[creative.id],name:'预算草稿',channel:'custom',dailyBudget:100,totalBudget:1000,maxDailyBudget:200,targetRoi:1,objective:'views',autoOptimize:false,buyingEmployeeId:'',status:'draft'});assert.equal((await f.tick()).results[0].waiting.code,'awaiting_explicit_launch');assert.equal(f.state.paidCalls,0);assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.details?.kind==='buying').length,0);
 const explicit=f.factory({repository:f.repo,bucket:f.env.BUCKET,env:f.env,context:f.context,adsService:f.adsService});await explicit.submitBuying(campaign,{action:'launch'});const result=await f.finish();assert.equal(result.results[0].waiting.code,'awaiting_real_metrics');assert.equal(f.state.paidCalls,1);assert.equal((await f.repo.getCampaign(f.owner.userId,campaign.id)).status,'active');await f.tick();assert.equal(f.state.paidCalls,1);
});
test('missing employees and lost sessions persist machine-readable waits and recover after restoring the existing account',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);f.state.employeesAvailable=false;assert.equal((await f.tick()).results[0].waiting.code,'waiting_market_employee');assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,0);f.state.employeesAvailable=true;assert.equal((await f.tick()).results[0].status,'producing');
 f.state.meStatus=401;assert.equal((await f.tick()).results[0].waiting.code,'login_required');assert.equal(f.state.paidCalls,0);const before=f.calls.filter(c=>c.startsWith('create:')).length;await f.tick();assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,before);
 f.state.meStatus=200;await createBxagiSessionRepository(f.env.DB).create(f.owner.userId,{id:'c'.repeat(64),subject:f.context.subject,tokenCiphertext:await encryptConnectionSecrets({accessToken:f.context.accessToken},f.env.APP_ENCRYPTION_KEY),profile:{id:f.context.subject},deviceId:'relogin-device',expiresAt:new Date(Date.now()+3600000).toISOString(),lastValidatedAt:new Date().toISOString()});assert.equal((await f.tick()).results[0].status,'producing');assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,before+1);
});
test('uncertain writes and human confirmations never cause a duplicate create or instruction',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.tick();let job=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='bxagi_workflow');await f.repo.updateJob(f.owner.userId,job.id,{status:'needs_reconciliation',details:{...job.details,remoteWritePending:'create_conversation'}});assert.equal((await f.tick()).results[0].waiting.code,'remote_write_uncertain');assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,0);
 await f.repo.updateJob(f.owner.userId,job.id,{status:'running',details:{...job.details,remoteWritePending:null,startTaskId:job.id,conversationId:job.id,inputsReady:true,messageSentAt:new Date().toISOString()}});f.state.waiting=true;assert.equal((await f.tick()).results[0].waiting.code,'remote_user_input');const before=f.calls.length;await f.tick();assert.deepEqual(f.calls.slice(before),['me']);assert.equal(f.state.paidCalls,0);
});
test('new source arriving during production signals a next revision while the old snapshot remains immutable',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.tick();const first=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='bxagi_workflow'),originalIds=[...first.details.assetIds];const added=await f.source();await f.automation.ensureProject(f.context,f.project.id);
 assert.deepEqual((await f.repo.getJob(f.owner.userId,first.id)).details.assetIds,originalIds);await f.finish();const jobs=(await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow');assert.equal(jobs.length,2);assert.ok(jobs.find(j=>j.id!==first.id).details.assetIds.includes(added.id));assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,2);
});
test('real feedback requires project/campaign metric ownership and opt-in; unknown conversion does not become a ROI claim',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.finish();const creative=(await f.repo.listCreatives(f.owner.userId,f.project.id))[0],campaign=await f.repo.createCampaign(f.owner.userId,{projectId:f.project.id,creativeIds:[creative.id],name:'真实反馈',channel:'custom',dailyBudget:100,totalBudget:1000,maxDailyBudget:200,targetRoi:1,objective:'views',autoOptimize:false,buyingEmployeeId:'',status:'draft'});
 const metric=await f.repo.upsertMetrics(f.owner.userId,{campaignId:campaign.id,date:'2026-10-14',source:'manual',spend:20,revenue:null,conversions:null,hasConversion:false,dataFresh:true,impressions:2000,clicks:10});const task=await f.repo.addOptimizationTask(f.owner.userId,{campaignId:campaign.id,projectId:f.project.id,status:'pending',type:'creative_iteration',reason:'基于真实CTR进行标题实验',metadata:{metricId:metric.id}});
 await f.tick();assert.equal((await f.repo.getOptimizationTask(f.owner.userId,task.id)).status,'pending');assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,1);
 await f.repo.updateCampaign(f.owner.userId,campaign.id,{autoOptimize:true});await f.tick();const job=(await f.repo.listJobs(f.owner.userId)).find(j=>j.details?.optimizationTaskId===task.id);assert.ok(job);assert.equal(job.details.optimization.signal.type,'ctr');assert.equal(job.details.optimization.metricId,metric.id);assert.equal(job.details.optimization.signals.some(signal=>signal.type==='roi'),false);assert.equal(f.state.paidCalls,0);
 await f.finish();assert.equal((await f.repo.getOptimizationTask(f.owner.userId,task.id)).status,'completed');const outputs=await f.repo.listCreatives(f.owner.userId,f.project.id);assert.equal(outputs.length,2);assert.ok(outputs.find(row=>row.metadata?.optimizationTaskId===task.id));assert.equal(f.state.paidCalls,0);
});
test('source limits and expired or malformed test scopes stop before any remote employee action',async()=>{
 const f=await fixture(),asset=(await f.repo.listAssets(f.owner.userId,f.project.id))[0];await f.automation.ensureProject(f.context,f.project.id);f.env.DB.sqlite.prepare('UPDATE assets SET size = ? WHERE id = ?').run(17*1024*1024,asset.id);assert.equal((await f.tick()).results[0].waiting.code,'source_too_large');assert.ok(!f.calls.includes('catalog'));
 f.env.DB.sqlite.prepare('UPDATE assets SET size = ?, metadata = ? WHERE id = ?').run(100,JSON.stringify({automationProbeExpiresAt:'bad-date'}),asset.id);assert.equal((await f.tick()).results[0].waiting.code,'test_project_excluded');await assert.rejects(f.automation.ensureProject(f.context,f.project.id),e=>e.status===409);assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,0);
});
test('flow CAS preserves a concurrent upload signal and rejects foreign or expired operation owners',async()=>{
 const f=await fixture(),flow=await f.automation.ensureProject(f.context,f.project.id,{notBefore:'2000-01-01T00:00:00Z'}),claimed=await f.repo.claimAutomaticFlow(f.owner.userId,flow.id,'first');assert.ok(claimed);assert.equal(await f.repo.claimAutomaticFlow(f.owner.userId,flow.id,'second'),null);assert.equal(await f.repo.claimAutomaticFlow(f.other.userId,flow.id,'foreign'),null);
 const signal=await f.automation.ensureProject(f.context,f.project.id,{notBefore:'2001-01-01T00:00:00Z'});const saved=await f.repo.saveAutomaticFlow(f.owner.userId,flow.id,'first',claimed.details.signalVersion,{status:'waiting',details:{nextActionAt:'2099-01-01T00:00:00Z',productionJobId:'preserved-work'}});assert.equal(saved.details.signalVersion,signal.details.signalVersion);assert.equal(saved.details.nextActionAt,'2001-01-01T00:00:00.000Z');assert.equal(saved.details.productionJobId,'preserved-work');assert.equal(await f.repo.saveAutomaticFlow(f.owner.userId,flow.id,'wrong',1,{status:'queued',details:{}}),null);
 await f.repo.releaseAutomaticFlow(f.other.userId,flow.id,'first');assert.equal((await f.repo.getJob(f.owner.userId,flow.id)).details.operationId,'first');await f.repo.releaseAutomaticFlow(f.owner.userId,flow.id,'first');assert.ok(await f.repo.claimAutomaticFlow(f.owner.userId,flow.id,'new'));
});
test('saved 401 and 403 are retried after valid identity/backoff without making a new job; failed initial jobs are not requeued',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.tick();const job=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='bxagi_workflow');await f.repo.updateJob(f.owner.userId,job.id,{status:'awaiting_result',details:{...job.details,lastErrorStatus:401,lastErrorCode:'workforce_unauthorized'}});await f.tick();assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,1);
 const current=await f.repo.getJob(f.owner.userId,job.id);await f.repo.updateJob(f.owner.userId,job.id,{status:'awaiting_result',details:{...current.details,lastErrorStatus:403,lastErrorCode:'workforce_forbidden'}});await f.tick();assert.ok(f.calls.includes('start'));assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,1);
 await f.repo.updateJob(f.owner.userId,job.id,{status:'failed'});const flow=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='platform_automation');await f.repo.updateJob(f.owner.userId,flow.id,{details:{...flow.details,productionJobId:null}});for(let i=0;i<3;i++)assert.equal((await f.tick()).results[0].waiting.code,'production_failed');assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,1);
});
test('only an already active owned due campaign pulls real metrics; drafts and future deadlines never synchronize',async()=>{
 const f=await fixture();let syncCalls=0;f.adsService.sync=async(userId,campaign)=>{syncCalls++;assert.equal(userId,f.owner.userId);assert.equal(campaign.status,'active');await f.repo.updateCampaign(userId,campaign.id,{nextSyncAt:new Date(Date.now()+60000).toISOString()});return {campaign};};await f.automation.ensureProject(f.context,f.project.id);await f.finish();const creative=(await f.repo.listCreatives(f.owner.userId,f.project.id))[0],campaign=await f.repo.createCampaign(f.owner.userId,{projectId:f.project.id,creativeIds:[creative.id],name:'报表监测',channel:'custom',dailyBudget:100,totalBudget:1000,maxDailyBudget:200,objective:'views',targetRoi:1,autoOptimize:false,buyingEmployeeId:'',status:'draft'});await f.tick();assert.equal(syncCalls,0);
 await f.repo.updateCampaign(f.owner.userId,campaign.id,{status:'active',remoteId:'actual-owned-id',nextSyncAt:new Date(Date.now()+60000).toISOString()});await f.tick();assert.equal(syncCalls,0);await f.repo.updateCampaign(f.owner.userId,campaign.id,{nextSyncAt:'2000-01-01T00:00:00Z'});await f.tick();assert.equal(syncCalls,1);await f.tick();assert.equal(syncCalls,1);assert.equal(f.state.paidCalls,0);
 await f.source();await f.automation.ensureProject(f.context,f.project.id);await f.tick();await f.repo.updateCampaign(f.owner.userId,campaign.id,{nextSyncAt:'2000-01-01T00:00:00Z'});const ongoing=await f.tick();assert.equal(ongoing.results[0].status,'producing');assert.equal(syncCalls,2);assert.equal(f.state.paidCalls,0);
});
test('an unexpired scoped probe may queue production but expiry stops it before the first remote mutation',async()=>{
 const f=await fixture(),asset=(await f.repo.listAssets(f.owner.userId,f.project.id))[0];f.env.AUTOMATION_PROBE_OWNER=f.owner.userId;f.env.AUTOMATION_PROBE_EXPIRES_AT=new Date(Date.now()+60000).toISOString();f.env.DB.sqlite.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({automationProbeExpiresAt:f.env.AUTOMATION_PROBE_EXPIRES_AT}),asset.id);await f.automation.ensureProject(f.context,f.project.id);await f.tick();assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,1);f.env.DB.sqlite.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({automationProbeExpiresAt:'2000-01-01T00:00:00Z'}),asset.id);assert.equal((await f.tick()).results[0].waiting.code,'test_project_excluded');assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,0);assert.ok(!f.calls.includes('instruction'));
});
test('revoking probe environment immediately blocks a still-future saved asset scope',async()=>{
 const f=await fixture(),asset=(await f.repo.listAssets(f.owner.userId,f.project.id))[0];f.env.AUTOMATION_PROBE_OWNER=f.owner.userId;f.env.AUTOMATION_PROBE_EXPIRES_AT=new Date(Date.now()+60000).toISOString();f.env.DB.sqlite.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({automationProbeExpiresAt:f.env.AUTOMATION_PROBE_EXPIRES_AT}),asset.id);await f.automation.ensureProject(f.context,f.project.id);await f.tick();f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';assert.equal((await f.tick()).results[0].waiting.code,'test_project_excluded');await assert.rejects(f.automation.ensureProject(f.context,f.project.id),e=>e.status===409);assert.equal(f.calls.filter(c=>c.startsWith('create:')).length,0);
});
async function expiredSentFlow(){
 const f=await fixture(),asset=(await f.repo.listAssets(f.owner.userId,f.project.id))[0];
 f.env.AUTOMATION_PROBE_OWNER=f.owner.userId;f.env.AUTOMATION_PROBE_EXPIRES_AT=new Date(Date.now()+60000).toISOString();
 f.env.DB.sqlite.prepare('UPDATE assets SET metadata = ? WHERE id = ?').run(JSON.stringify({automationProbeExpiresAt:f.env.AUTOMATION_PROBE_EXPIRES_AT}),asset.id);
 const get=f.workforce.getConversation;f.workforce.getConversation=async id=>({...await get(id),created_by_user_id:f.context.subject});
 const send=f.workforce.sendMessage;f.workforce.sendMessage=async(...args)=>{await send(...args);return {transport:'bxagi_ws',eventId:'ack-event',messageAcknowledged:true};};
 await f.automation.ensureProject(f.context,f.project.id);
 let job;for(let i=0;i<12;i++){await f.tick();job=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='bxagi_workflow');if(job?.details.messageSentAt)break;}
 assert.equal(job.details.messageAcknowledged,true);
 for(const method of ['createConversation','getStartTask','ensureRuntime','uploadFile','sendMessage'])f.workforce[method]=async()=>assert.fail('Expired flow must not call '+method);
 f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00.000Z';f.calls.length=0;
 return {...f,job};
}
test('expired bound acknowledged flow collects actual output and then stops without dispatch, buying or feedback work',async()=>{
 const f=await expiredSentFlow();
 try{
  await f.repo.createCampaign(f.owner.userId,{projectId:f.project.id,creativeIds:[],name:'existing authorized fixture',channel:'custom',dailyBudget:100,totalBudget:1000,maxDailyBudget:200,objective:'views',targetRoi:1,buyingEmployeeId:'',status:'active',autoOptimize:true});
  f.adsService.sync=async()=>assert.fail('Expired production collection must not advance reports or buying');
  const result=await f.tick();assert.equal(result.results[0].waiting.code,'test_collection_complete');assert.equal(result.results[0].lastCompletedProductionJobId,f.job.id);
  const outputs=await f.repo.listCreatives(f.owner.userId,f.project.id);assert.equal(outputs.length,1);assert.ok(await f.env.BUCKET.get(outputs[0].objectKey));assert.equal(f.state.paidCalls,0);
  const reads=f.calls.filter(call=>call!=='me').length;await f.tick();assert.equal(f.calls.filter(call=>call!=='me').length,reads);
  assert.equal((await f.repo.listJobs(f.owner.userId)).filter(job=>job.type==='bxagi_workflow').length,1);
 }finally{f.env.DB.sqlite.close();}
});
test('automatic recovery archives an acknowledged legacy activation failure from its original offline employee without redispatch',async()=>{
 const f=await expiredSentFlow();
 try{
  await f.repo.updateJob(f.owner.userId,f.job.id,{status:'failed',details:{...f.job.details,lastErrorCode:'bxagi_market_employee_activation_required',lastErrorStatus:409}});
  const catalog=f.workforce.listEmployees;f.workforce.listEmployees=async()=>{const employees=await catalog();return employees.map(employee=>({...employee,entitlementVerified:true,availability:'node_offline',usable:false}));};
  const result=await f.tick();assert.equal(result.results[0].waiting.code,'test_collection_complete');assert.equal(result.results[0].lastCompletedProductionJobId,f.job.id);assert.equal(f.state.paidCalls,0);
  const job=await f.repo.getJob(f.owner.userId,f.job.id);assert.equal(job.status,'completed');assert.equal(job.details.lastErrorCode,null);assert.equal(job.details.delivery.expectedCount,1);assert.deepEqual(job.details.delivery.expected,[{filename:'result.png',mimeType:'image/png'}]);assert.equal((await f.repo.listJobs(f.owner.userId)).filter(row=>row.type==='bxagi_workflow').length,1);
 }finally{f.env.DB.sqlite.close();}
});
test('temporary collection outage preserves its task and flow retry deadline before continuing read-only recovery',async()=>{
 const f=await expiredSentFlow();
 try{
  const read=f.workforce.readManifest;f.workforce.readManifest=async()=>{f.calls.push('offline-read');throw Object.assign(new Error('node transport unavailable'),{status:503,code:'bxagi_node_offline'});};
  let result=await f.tick();assert.equal(result.results[0].waiting.code,'node_offline');assert.equal(result.results[0].waiting.requiresUser,false);assert.equal(result.results[0].status,'producing');
  let job=await f.repo.getJob(f.owner.userId,f.job.id);assert.equal(job.status,'awaiting_result');assert.equal(job.details.recovery.attempt,1);assert.equal(result.results[0].nextActionAt,job.details.recovery.nextRetryAt);
  const attempts=f.calls.filter(call=>call==='offline-read').length;await f.tick();assert.equal(f.calls.filter(call=>call==='offline-read').length,attempts);
  await f.repo.updateJob(f.owner.userId,job.id,{details:{...job.details,recovery:{...job.details.recovery,nextRetryAt:'2000-01-01T00:00:00Z'}}});
  f.workforce.readManifest=read;result=await f.tick();assert.equal(result.results[0].waiting.code,'test_collection_complete');job=await f.repo.getJob(f.owner.userId,f.job.id);assert.equal(job.status,'completed');assert.equal(job.details.recovery,null);assert.equal(f.state.paidCalls,0);
 }finally{f.env.DB.sqlite.close();}
});
test('offline selected market employee waits without an installation attempt or a production dispatch',async()=>{
 const f=await fixture();
 try{
  const catalog=f.workforce.listEmployees;f.workforce.listEmployees=async()=>{const employees=await catalog();return employees.map(employee=>({...employee,entitlementVerified:true,availability:'node_offline',usable:false}));};
  await f.automation.ensureProject(f.context,f.project.id);const result=await f.tick();assert.equal(result.results[0].waiting.code,'node_offline');assert.equal(result.results[0].waiting.requiresUser,false);assert.equal(result.results[0].status,'monitoring');assert.ok(Date.parse(result.results[0].nextActionAt)>Date.now());assert.equal((await f.repo.listJobs(f.owner.userId)).filter(row=>row.type==='bxagi_workflow').length,0);assert.equal(f.state.paidCalls,0);assert.equal(f.calls.some(call=>call.startsWith('create:')),false);
 }finally{f.env.DB.sqlite.close();}
});
test('expired flow reports terminal missing delivery once and never automatically dispatches or re-collects it',async()=>{
 const f=await expiredSentFlow();
 try{
  f.workforce.readManifest=async()=>{f.calls.push('manifest');throw Object.assign(new Error('missing'),{status:404});};
  f.workforce.getEvents=async()=>[{key:'execution_status',value:'finished',timestamp:'2099-01-01T20:04:42Z'},{id:'ack-event'}];
  const result=await f.tick();assert.equal(result.results[0].waiting.code,'delivery_missing');assert.equal(result.results[0].waiting.requiresUser,true);
  const saved=await f.repo.getJob(f.owner.userId,f.job.id);assert.equal(saved.status,'failed');assert.equal(saved.details.lastErrorCode,'bxagi_delivery_missing');
  const calls=f.calls.length;await f.tick();assert.deepEqual(f.calls.slice(calls),['me']);assert.equal((await f.repo.listCreatives(f.owner.userId)).length,0);assert.equal(f.state.paidCalls,0);
 }finally{f.env.DB.sqlite.close();}
});
test('asynchronous D1 saves settle before the flow operation lease is released on success and error waits',async()=>{
 const f=await fixture();let savesInFlight=0,releases=0;
 const repository={...f.repo,async saveAutomaticFlow(...args){savesInFlight++;try{await new Promise(resolve=>setTimeout(resolve,10));return await f.repo.saveAutomaticFlow(...args);}finally{savesInFlight--;}},async releaseAutomaticFlow(...args){assert.equal(savesInFlight,0,'a pending D1 save must retain its operation lease');releases++;return f.repo.releaseAutomaticFlow(...args);}};
 const automation=createAutomaticFlow({repository,bucket:f.env.BUCKET,env:f.env,resolveContext:async()=>f.context,createOrchestrator:f.factory,adsService:f.adsService});await automation.ensureProject(f.context,f.project.id,{notBefore:'2000-01-01T00:00:00Z'});
 const queued=await automation.tick({userId:f.owner.userId});assert.equal(queued.results[0].status,'producing');let flow=(await f.repo.listJobs(f.owner.userId)).find(job=>job.type==='platform_automation');assert.ok(flow.details.productionJobId);assert.ok(flow.details.lastTickAt);assert.equal(flow.details.operationId,undefined);assert.equal(releases,1);
 const missing=createAutomaticFlow({repository,bucket:f.env.BUCKET,env:f.env,resolveContext:async()=>{throw Object.assign(new Error('expired'),{status:401});},createOrchestrator:f.factory});await f.wake();const waiting=await missing.tick({userId:f.owner.userId});assert.equal(waiting.results[0].waiting.code,'login_required');flow=await f.repo.getJob(f.owner.userId,flow.id);assert.equal(flow.details.waiting.code,'login_required');assert.equal(flow.details.operationId,undefined);assert.equal(releases,2);
});
test('saved historical conversation or missing marketplace proof never syncs, restarts or changes its remote state',async()=>{
 for(const patch of [{resourceType:'conversation'},{marketId:null},{marketVerified:false},{resourceType:undefined}]){
  const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.tick();const job=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='bxagi_workflow');await f.repo.updateJob(f.owner.userId,job.id,{status:'running',details:{...job.details,employee:{...job.details.employee,...patch},startTaskId:'existing-start',remoteWritePending:'create_conversation'}});const before=f.calls.length;
  const result=await f.tick();assert.equal(result.results[0].waiting.code,'historical_task_only');assert.match(result.results[0].waiting.message,/历史会话/);assert.deepEqual(f.calls.slice(before),['me']);const saved=await f.repo.getJob(f.owner.userId,job.id);assert.equal(saved.status,'running');assert.equal(saved.details.remoteWritePending,'create_conversation');assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,1);assert.equal(f.state.paidCalls,0);
 }
});
test('completed historical output remains a record and does not fulfill the market production flow',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.finish();const job=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='bxagi_workflow'),creative=(await f.repo.listCreatives(f.owner.userId,f.project.id))[0];assert.ok(await f.env.BUCKET.get(creative.objectKey));await f.repo.updateJob(f.owner.userId,job.id,{details:{...job.details,employee:{...job.details.employee,resourceType:'conversation'}}});const before=f.calls.length;const result=await f.tick();assert.equal(result.results[0].waiting.code,'historical_task_only');assert.notEqual(result.results[0].waiting.code,'awaiting_budget');assert.deepEqual(f.calls.slice(before),['me']);assert.equal((await f.repo.getCreative(f.owner.userId,creative.id)).id,creative.id);
});
test('verified market templates without activation wait without installation or exposure of unverified pricing',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.tick();const job=(await f.repo.listJobs(f.owner.userId)).find(j=>j.type==='bxagi_workflow');await f.repo.updateJob(f.owner.userId,job.id,{details:{...job.details,employee:{...job.details.employee,resourceType:'marketplace_template',sourceVerified:false,activationState:'not_installed',usable:false}}});const before=f.calls.length;assert.equal((await f.tick()).results[0].waiting.code,'waiting_employee_activation');assert.deepEqual(f.calls.slice(before),['me']);assert.equal(f.state.paidCalls,0);
 for(const code of ['bxagi_market_employee_required','bxagi_market_employee_activation_required']){const other=await fixture();await other.automation.ensureProject(other.context,other.project.id);const automation=createAutomaticFlow({repository:other.repo,bucket:other.env.BUCKET,env:other.env,resolveContext:async()=>other.context,createOrchestrator:()=>({async submitProduction(){throw Object.assign(new Error('unverified price=999 credential='+other.context.accessToken),{status:409,code,quote:{amount:999}});}})});await other.wake();const result=await automation.tick({userId:other.owner.userId});assert.equal(result.results[0].waiting.code,code==='bxagi_market_employee_required'?'waiting_market_employee':'waiting_employee_activation');assert.ok(!JSON.stringify(result).includes('price=999'));assert.ok(!JSON.stringify(result.results[0].waiting).includes('999'));assert.ok(!JSON.stringify(result).includes(other.context.accessToken));assert.equal((await other.repo.listJobs(other.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,0);}
});
test('an explicitly authorized buying job from a historical conversation cannot execute an ad operation',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.finish();const creative=(await f.repo.listCreatives(f.owner.userId,f.project.id))[0];await f.repo.updateCreative(f.owner.userId,creative.id,{status:'approved',reviewedBy:f.owner.userId,reviewedAt:new Date().toISOString()});const campaign=await f.repo.createCampaign(f.owner.userId,{projectId:f.project.id,creativeIds:[creative.id],name:'市场员工投放',channel:'custom',dailyBudget:100,totalBudget:1000,maxDailyBudget:200,targetRoi:1,objective:'views',autoOptimize:false,buyingEmployeeId:'',status:'draft'}),explicit=f.factory({repository:f.repo,bucket:f.env.BUCKET,env:f.env,context:f.context,adsService:f.adsService}),queued=await explicit.submitBuying(campaign,{action:'launch'});await f.repo.updateJob(f.owner.userId,queued.job.id,{details:{...queued.job.details,employee:{...queued.job.details.employee,resourceType:'conversation'}}});const before=f.calls.length;const result=await f.tick();assert.equal(result.results[0].waiting.code,'historical_task_only');assert.equal(result.results[0].waiting.stage,'buying');assert.deepEqual(f.calls.slice(before),['me']);assert.equal(f.state.paidCalls,0);assert.equal((await f.repo.getCampaign(f.owner.userId,campaign.id)).status,'draft');assert.equal((await f.repo.getJob(f.owner.userId,queued.job.id)).status,'queued');
});

test('new explicit-upload projects never dispatch before start even when an automatic tick exists',async()=>{
 const f=await fixture();await f.repo.updateProject(f.owner.userId,f.project.id,{sourceState:{version:1,status:'sealed',batchId:'unstarted-batch',assetIds:[]}});
 await f.automation.ensureProject(f.context,f.project.id);const result=await f.tick();
 assert.equal(result.results[0].waiting.code,'production_start_required');assert.equal(f.calls.filter(c=>c==='catalog'||c.startsWith('create:')).length,0);
});

test('round-robin reports sync every due campaign despite one failure and production awaiting explicit start',async()=>{
 const f=await fixture();await f.repo.updateProject(f.owner.userId,f.project.id,{sourceState:{version:1,status:'sealed',batchId:'unstarted-batch',assetIds:[]}});
 const ids=[];for(let i=0;i<5;i++){const c=await f.repo.createCampaign(f.owner.userId,{projectId:f.project.id,name:`campaign ${i}`,channel:'custom',status:'active',buyingEmployeeId:'',dailyBudget:10,totalBudget:100,maxDailyBudget:10,creativeIds:[],objective:'views'});ids.push(c.id);}
 const attempted=[];const service=createAutomaticFlow({repository:f.repo,bucket:f.env.BUCKET,env:f.env,fetcher:f.fetcher,resolveContext:async()=>f.context,createOrchestrator:f.factory,adsService:{async sync(u,c){attempted.push(c.id);if(c.id===[...ids].sort()[0])throw Object.assign(new Error('fixture unavailable'),{status:503});await f.repo.updateCampaign(u,c.id,{nextSyncAt:new Date(Date.now()+3600000).toISOString()});}}});
 await service.ensureProject(f.context,f.project.id);await f.wake();await service.tick({context:f.context});await f.wake();await service.tick({context:f.context});
 assert.deepEqual([...new Set(attempted)].sort(),ids.sort());assert.equal(attempted.length,5);
 assert.equal((await f.repo.listJobs(f.owner.userId)).filter(j=>j.type==='bxagi_workflow').length,0);
});

test('one uncertain buying request cannot starve other explicitly authorized campaign jobs',async()=>{
 const f=await fixture();await f.automation.ensureProject(f.context,f.project.id);await f.finish();const creative=(await f.repo.listCreatives(f.owner.userId,f.project.id))[0];await f.repo.updateCreative(f.owner.userId,creative.id,{status:'approved',reviewedBy:f.owner.userId,reviewedAt:new Date().toISOString()});
 const workflow=f.factory({repository:f.repo,bucket:f.env.BUCKET,env:f.env,context:f.context,adsService:f.adsService});const jobs=[];
 for(let i=0;i<5;i++){const c=await f.repo.createCampaign(f.owner.userId,{projectId:f.project.id,creativeIds:[creative.id],name:`authorized ${i}`,channel:'custom',dailyBudget:10,totalBudget:100,maxDailyBudget:10,targetRoi:1,objective:'views',autoOptimize:false,buyingEmployeeId:'',status:'draft'});jobs.push((await workflow.submitBuying(c,{action:'launch'})).job);}
 const uncertain=[...jobs].sort((a,b)=>a.id.localeCompare(b.id))[0];await f.repo.updateJob(f.owner.userId,uncertain.id,{status:'needs_reconciliation',details:{...uncertain.details,remoteWritePending:'send_message'}});
 for(let i=0;i<20;i++)await f.tick();
 assert.equal(f.state.paidCalls,4);assert.equal((await f.repo.getJob(f.owner.userId,uncertain.id)).status,'needs_reconciliation');assert.equal(f.calls.includes(`create:${uncertain.id}`),false);
});
