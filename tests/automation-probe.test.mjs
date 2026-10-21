import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handleAutomationProbe} from '../server/automation-probe.mjs';
import {createPlatformRepository} from '../server/platform-repository.mjs';
import {deflateSync} from 'node:zlib';
import {handlePlatformRequest} from '../server/platform-api.mjs';
import {showcaseSpec} from '../server/bxagi-showcase.mjs';
import {showcaseFontResources} from '../server/bxagi-showcase-font.mjs';
function fixture(){
 const sqlite=new DatabaseSync(':memory:'),dir=new URL('../drizzle/',import.meta.url);
 for(const f of readdirSync(dir).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(f,dir),'utf8'));
 const DB={prepare(sql){const s=sqlite.prepare(sql);return {bind(...a){return {async first(){return s.get(...a)??null},async all(){return {results:s.all(...a)}},async run(){return {meta:{changes:Number(s.run(...a).changes)}}}}}}}};
 const objects=new Map(),env={DB,AUTOMATION_PROBE_MODE:'production-market',AUTOMATION_PROBE_OWNER:'owner',AUTOMATION_PROBE_SECRET:'test-secret-'.repeat(4),AUTOMATION_PROBE_EXPIRES_AT:new Date(Date.now()+600000).toISOString(),BUCKET:{async put(k,v){objects.set(k,new Uint8Array(await new Response(v).arrayBuffer()));},async get(k){const v=objects.get(k);return v?{size:v.length,body:new Blob([v]).stream()}:null},async delete(k){objects.delete(k)}}};
 const context={userId:'owner',nativeUserId:'owner',subject:'s',accessToken:'secret-never-output'};let submits=0;
 const injected={fetcher:async()=>{throw new Error('Unconfigured fixture network is forbidden')},resolveContext:async()=>context,createOrchestrator:({repository})=>({async submitProduction(project,options={}){submits++;const job=await repository.createBxagiProductionJob('owner',{projectId:project.id,employeeId:'bxagi:market:design',details:{kind:'production',provider:'bxagi',bxagiSubject:'s',input:project,...(options.batchId?{batchId:options.batchId,inputVersion:options.inputVersion,productionSpec:options.productionSpec}:{}),assetIds:options.assetIds||(await repository.listAssets('owner',project.id)).map(a=>a.id),employee:{id:'bxagi:market:design',marketId:'design',provider:'bxagi',providerId:'design',name:'市场设计师',resourceType:'installed_employee',marketVerified:true,activationState:'ready',sourceVerified:true,usable:true}}});return {job}},async syncJob(){throw new Error('Not yet due')},async catalog(){return[]}})};
 const call=async({body,secret=env.AUTOMATION_PROBE_SECRET,method='POST',query=''}={})=>{const r=await handleAutomationProbe(new Request(`https://app.test/api/v2/worker/automation-probe${query}`,{method,headers:{Authorization:`Bearer ${secret}`},...(body?{body}:{})}),env,injected);return {status:r.status,data:await r.json()}};
 return {sqlite,env,injected,call,submits:()=>submits,repo:createPlatformRepository(DB)};
}
test('node inspection is bounded to the fixed verified owner, performs only GET and stores safe local diagnostics',async()=>{
 const f=fixture();let reads=0;
 try{
  const call=(options={})=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/node-inspection'+(options.query||''),{method:'POST',headers:{Authorization:`Bearer ${options.secret||f.env.AUTOMATION_PROBE_SECRET}`},...(options.body?{body:options.body}:{})}),f.env,f.injected);
  assert.equal((await call()).status,503);
  f.env.AUTOMATION_PROBE_MODE='node-inspection';
  f.injected.fetcher=async(url,options)=>{reads++;assert.equal(url,'https://bxagi.xinlx.com/api/nodes');assert.equal(options.method,'GET');return Response.json({nodes:[{node_id:'owned-node',status:'offline',gateway_connected:false,last_heartbeat_at:'2026-10-15T00:50:00Z',node_url:'wss://gateway-ws.private.invalid/secret-never-output'}]});};
  assert.equal((await call({body:'{"owner":"other"}'})).status,400);
  assert.equal((await call({query:'?owner=other'})).status,400);
  assert.equal((await call({secret:'wrong'})).status,401);assert.equal(reads,0);
  const response=await call(),data=await response.json();assert.equal(response.status,200);assert.equal(reads,1);assert.equal(data.nodes[0].status,'offline');assert.equal(data.nodes[0].cloudGateway,true);assert.equal(data.persistenceStatus,'saved');assert.ok(!JSON.stringify(data).includes('secret-never-output'));
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,0);
  f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';assert.equal((await call()).status,503);assert.equal(reads,1);
 }finally{f.sqlite.close();}
});
test('bounded verification rejects stale/oversized windows, wrong service credentials and caller-selected scope',async()=>{const f=fixture();try{assert.equal((await f.call({secret:'wrong'})).status,401);for(const arg of [{body:'{}'},{body:'{"userId":"other"}'},{query:'?projectId=other'},{method:'GET'}])assert.equal((await f.call(arg)).status,400);f.env.AUTOMATION_PROBE_EXPIRES_AT=new Date(Date.now()-1).toISOString();assert.equal((await f.call()).status,503);f.env.AUTOMATION_PROBE_EXPIRES_AT=new Date(Date.now()+4000000).toISOString();assert.equal((await f.call()).status,503);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,0);}finally{f.sqlite.close()}});
test('production verification reuses reservation, actual source and persisted dispatch without financial capability',async()=>{const f=fixture();try{const first=await f.call();assert.equal(first.status,200,JSON.stringify(first.data));assert.ok(first.data.job);assert.equal(first.data.job.status,'queued');assert.equal(first.data.productionCompleted,false);assert.equal(first.data.paidAdvertisingPerformed,false);const second=await f.call();assert.equal(second.data.runId,first.data.runId);assert.equal(second.data.projectId,first.data.projectId);assert.equal(f.submits(),1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM assets').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM campaigns').get().n,0);assert.ok(!JSON.stringify(first.data).includes('secret-never-output'));f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00.000Z';assert.equal((await f.call()).status,503);assert.equal(f.submits(),1);}finally{f.sqlite.close()}});
test('service verifies saved BXAGI account before creating any source or job',async()=>{const f=fixture();try{f.injected.resolveContext=async()=>({userId:'other',subject:'s'});assert.equal((await f.call()).status,401);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n,0);}finally{f.sqlite.close()}});
test('fixed showcase queues one ordinary market production with actual storyboard and licensed font, without copying old creatives or buying',async()=>{
 const f=fixture();try{
  f.env.AUTOMATION_PROBE_MEDIA='video';f.env.AUTOMATION_PROBE_SCENARIO=showcaseSpec.scenario;
  const first=await f.call();assert.equal(first.status,200,JSON.stringify(first.data));
  const project=await f.repo.getProject('owner',first.data.projectId),assets=await f.repo.listAssets('owner',project.id);
  assert.equal(project.description,showcaseSpec.description);assert.deepEqual(project.facts,showcaseSpec.facts);
  assert.equal(assets.length,1+showcaseFontResources().length);
  const source=assets.find(a=>a.role==='source');assert.equal(source.mimeType,'text/plain');
  assert.equal(await new Response((await f.env.BUCKET.get(source.objectKey)).body).text(),showcaseSpec.sourceText);
  const font=assets.find(a=>a.mimeType==='font/ttf');assert.ok(font.size>1000);assert.equal(font.metadata.licensedWorkflowResource,true);
  const second=await f.call();assert.equal(second.data.projectId,project.id);assert.equal(f.submits(),1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM campaigns').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM creatives').get().n,0);
  delete f.env.AUTOMATION_PROBE_SCENARIO;assert.equal((await f.call()).status,409);assert.equal(f.submits(),1);
 }finally{f.sqlite.close();}
});
test('unsupported showcase scenario or media cannot create a project or accept caller parameters',async()=>{
 const f=fixture();try{
  f.env.AUTOMATION_PROBE_SCENARIO='arbitrary';assert.equal((await f.call()).status,503);
  f.env.AUTOMATION_PROBE_SCENARIO=showcaseSpec.scenario;assert.equal((await f.call()).status,503);
  f.env.AUTOMATION_PROBE_MEDIA='video';assert.equal((await f.call({body:'{"description":"caller override"}'})).status,400);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,0);assert.equal(f.submits(),0);
 }finally{f.sqlite.close();}
});
test('package verification seals the real inputs and starts one immutable video production through the production service',async()=>{
 const f=fixture();try{
  f.env.AUTOMATION_PROBE_MEDIA='video';f.env.AUTOMATION_PROBE_SCENARIO='package-v1';
  const first=await f.call();assert.equal(first.status,200,JSON.stringify(first.data));
  const data=first.data,project=await f.repo.getProject('owner',data.projectId),assets=await f.repo.listAssets('owner',project.id),batch=await f.repo.getJob('owner',data.batch.id),job=await f.repo.getJob('owner',data.job.id);
  assert.equal(data.scenario,'package-v1');assert.equal(project.title,'BXAGI 八模块流程实测 · 22秒');assert.equal(project.description,showcaseSpec.description);
  assert.equal(assets.length,1+showcaseFontResources().length);assert.ok(assets.every(a=>a.metadata.automationProbeExpiresAt===f.env.AUTOMATION_PROBE_EXPIRES_AT));
  assert.equal(batch.type,'upload_batch');assert.equal(batch.status,'sealed');assert.equal(batch.details.reusedAssets,true);assert.deepEqual([...batch.details.assetIds].sort(),assets.map(a=>a.id).sort());
  assert.equal(data.batch.startedJobId,job.id);assert.equal(data.sourceState.status,'started');assert.equal(job.details.batchId,batch.id);assert.equal(job.details.inputVersion,batch.details.inputVersion);
  assert.equal(data.productionSpec.targetCount,1);assert.equal(data.productionSpec.mediaType,'video');assert.equal(data.productionSpec.format,'portrait');assert.equal(data.productionSpec.employeeMode,'auto');
  assert.match(data.productionSpec.instructions,/role:primary/);assert.match(data.productionSpec.instructions,/22.00秒/);assert.match(data.productionSpec.instructions,/不创建或启动广告投放/);assert.deepEqual(data.productionSpec,job.details.productionSpec);
  assert.equal(job.details.automaticFlowId,data.flow.id);assert.equal(job.details.automationProbeExpiresAt,f.env.AUTOMATION_PROBE_EXPIRES_AT);assert.equal(data.productionCompleted,false);assert.equal(data.paidAdvertisingPerformed,false);
  const retry=await f.call();assert.equal(retry.status,200,JSON.stringify(retry.data));assert.equal(retry.data.batch.id,batch.id);assert.equal(retry.data.job.id,job.id);assert.equal(f.submits(),1);
  const concurrent=await Promise.all([f.call(),f.call()]);assert.ok(concurrent.some(r=>r.status===200));assert.ok(concurrent.every(r=>[200,409].includes(r.status)));assert.equal(f.submits(),1);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs WHERE type='upload_batch'").get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM campaigns').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM connections').get().n,0);
  assert.equal(JSON.stringify(data).includes('secret-never-output'),false);
 }finally{f.sqlite.close();}
});
test('package verification refuses image mode, caller overrides, identity drift, expired authority and changed batch linkage',async()=>{
 const f=fixture();try{
  f.env.AUTOMATION_PROBE_SCENARIO='package-v1';assert.equal((await f.call()).status,503);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,0);
  f.env.AUTOMATION_PROBE_MEDIA='video';assert.equal((await f.call({body:'{"targetCount":3,"channel":"oceanengine"}'})).status,400);assert.equal((await f.call({query:'?projectId=other'})).status,400);
  const resolve=f.injected.resolveContext;f.injected.resolveContext=async()=>({userId:'other',subject:'s'});assert.equal((await f.call()).status,401);f.injected.resolveContext=resolve;
  const first=await f.call();assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(f.submits(),1);
  const project=await f.repo.getProject('owner',first.data.projectId);await f.repo.updateProject('owner',project.id,{sourceState:{...project.sourceState,batchId:'foreign-batch'}});
  assert.equal((await f.call()).data.error.code,'automation_probe_batch_changed');assert.equal(f.submits(),1);
  await f.repo.updateProject('owner',project.id,{sourceState:project.sourceState});f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00.000Z';assert.equal((await f.call()).status,503);assert.equal(f.submits(),1);
 }finally{f.sqlite.close();}
});
test('private verification excludes arbitrary error messages and permits only bounded market diagnostics',async()=>{const f=fixture();try{f.injected.resolveContext=async()=>{throw new Error('secret-never-output upstream body')};const hidden=await f.call();assert.ok(!JSON.stringify(hidden).includes('secret-never-output'));f.injected.resolveContext=async()=>{throw Object.assign(new Error('secret-never-output'),{code:'unexpected_response',marketDiagnostic:'BXAGI 市场员工会话响应格式尚不能确认'})};const diagnostic=await f.call();assert.equal(diagnostic.data.error.diagnostic,'BXAGI 市场员工会话响应格式尚不能确认');assert.ok(!JSON.stringify(diagnostic).includes('secret-never-output'));}finally{f.sqlite.close()}});
test('market inspection is read-only, scoped and cannot activate the production probe',async()=>{const f=fixture();try{f.env.AUTOMATION_PROBE_MODE='market-inspection';assert.equal((await f.call()).status,503);const injected={...f.injected,createMarketplace:()=>({async inspect(){return {isCloudMode:true,quota:{remaining:0,quota:0},employees:[{id:'bxagi:market:design',marketId:'design',provider:'bxagi',resourceType:'marketplace_template',marketVerified:true,name:'设计师',skills:['素材制作'],activationState:'not_installed',usable:false,activation:{required:true,freeVerified:false,quote:{monthly:10,annual:100,currency:'CNY'}}}]}}})};const r=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/market-inspection',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,injected);const data=await r.json();assert.equal(r.status,200);assert.equal(data.readOnly,true);assert.equal(data.installationPerformed,false);assert.equal(data.marketplace.employees[0].activation.quote.monthly,10);assert.equal(data.matches.production.marketId,'design');assert.equal(data.matches.production.activationRequired,true);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,0);}finally{f.sqlite.close()}});


test('probe continues the same definitely refused instruction once and never resets an uncertain or sent write',async()=>{
 for(const variant of ['definite','uncertain','sent','other-status','already-recovered']){
  const f=fixture();try{
   const first=await f.call(),id=first.data.job.id,original=await f.repo.getJob('owner',id);
   const details={...original.details,startTaskId:'start-task',conversationId:'same-conversation',inputsReady:true,briefUploaded:true,
    uploadedAssets:[{id:original.details.assetIds[0],path:'actual-source'}],lastErrorCode:'upstream_request_failed',lastErrorStatus:404,
    ...(variant==='uncertain'?{remoteWritePending:'send_instruction'}:{}),...(variant==='sent'?{messageSentAt:new Date().toISOString()}:{}),
    ...(variant==='other-status'?{lastErrorStatus:403}:{}),...(variant==='already-recovered'?{messageTransportRecoveryAttempted:true}:{})};
   await f.repo.updateJob('owner',id,{status:'failed',details});
   let synced=0;f.injected.createOrchestrator=()=>({async syncJob(jobId){synced++;assert.equal(jobId,id);const same=await f.repo.getJob('owner',jobId);assert.equal(same.details.conversationId,'same-conversation');assert.equal(same.details.inputsReady,true);assert.equal(same.details.messageTransportRecoveryAttempted,true);return {job:same}},async catalog(){return[]}});
   const result=await f.call();assert.equal(result.status,200,JSON.stringify(result));
   assert.equal(synced,variant==='definite'?1:0);assert.equal(f.submits(),1);
   assert.equal((await f.repo.getJob('owner',id)).details.conversationId,'same-conversation');
   if(variant==='definite'){assert.equal(result.data.job.status,'uploading');await f.repo.updateJob('owner',id,{status:'failed',details:{...(await f.repo.getJob('owner',id)).details,lastErrorCode:'upstream_request_failed',lastErrorStatus:404}});await f.call();assert.equal(synced,1);}
  }finally{f.sqlite.close()}
 }
});

test('sent production without artifacts exposes only bounded owned-event metadata and never writes or starts a runtime',async()=>{
 const f=fixture(),calls=[];try{
  const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id),conversationId='19a3e398-9dd1-43eb-b615-ba052654382f';
  await f.repo.updateJob('owner',job.id,{status:'needs_reconciliation',details:{...job.details,conversationId,messageSentAt:new Date().toISOString(),remoteWritePending:'send_instruction'}});
  f.injected.fetcher=async(url,options)=>{const u=new URL(url);calls.push(u);assert.equal(options.method,'GET');assert.equal(u.origin,'https://bxagi.xinlx.com');
   if(u.pathname==='/api/v1/app-conversations')return Response.json([{id:conversationId.replaceAll('-',''),created_by_user_id:'s',employee_id:'design',execution_status:'RUNNING',session_api_key:'secret-never-output'}]);
   assert.equal(u.pathname,`/api/v1/conversation/${conversationId.replaceAll('-','')}/events/search`);
   return Response.json({items:[{id:'user-event',kind:'MessageEvent',source:'user',timestamp:'2026-10-14T11:17:41Z',llm_message:{role:'user',content:[{type:'text',text:'secret-never-output raw prompt'}]}},{id:'finish-event',kind:'ActionEvent',source:'agent',timestamp:'2026-10-14T11:18:00Z',action:{kind:'FinishAction',args:{credential:'secret-never-output'}}},{id:'state-event',kind:'StateEvent',source:'agent',timestamp:'2026-10-14T11:18:00Z',key:'execution_status',value:'finished'},{id:'secret-never-output',kind:'secret-never-output',source:'secret-never-output',timestamp:'secret-never-output',key:'execution_status',value:'secret-never-output'}]});};
  const result=await f.call();assert.equal(result.status,200);assert.equal(calls.length,2);assert.equal(result.data.remoteDiagnostics.readOnly,true);assert.equal(result.data.remoteDiagnostics.executionStatus,'running');assert.deepEqual(result.data.remoteDiagnostics.counts,{total:4,userMessages:1,agentMessages:0,actions:1,observations:0,finishActions:1,other:1});
  assert.equal(result.data.remoteDiagnostics.events[2].execution_status,'finished');assert.deepEqual(result.data.remoteDiagnostics.events[3],{id:null,kind:'other',source:'other',timestamp:null});assert.equal(JSON.stringify(result.data).includes('secret-never-output'),false);assert.equal(JSON.stringify(result.data).includes('raw prompt'),false);assert.equal(result.data.productionCompleted,false);assert.equal((await f.repo.getJob('owner',job.id)).status,'needs_reconciliation');assert.equal(f.submits(),1);
 }finally{f.sqlite.close()}
});

test('diagnostics never read events for an unowned, unrequested or different employee conversation; unsent jobs skip them',async()=>{
 for(const variant of ['owner','employee','id','unsent']){
  const f=fixture(),calls=[];try{
   const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id),conversationId='19a3e398-9dd1-43eb-b615-ba052654382f';
   await f.repo.updateJob('owner',job.id,{status:'needs_reconciliation',details:{...job.details,conversationId,remoteWritePending:'send_instruction',...(variant!=='unsent'?{messageSentAt:new Date().toISOString()}:{})}});
   f.injected.fetcher=async(url,options)=>{calls.push(url);assert.equal(options.method,'GET');assert.equal(new URL(url).pathname,'/api/v1/app-conversations');return Response.json([{id:variant==='id'?'19a3e3989dd143ebb615ba0526543820':conversationId.replaceAll('-',''),created_by_user_id:variant==='owner'?'foreign':'s',employee_id:variant==='employee'?'different':'design',execution_status:'secret-never-output'}]);};
   const result=await f.call();assert.equal(result.status,200);assert.equal(calls.length,variant==='unsent'?0:1);if(variant==='unsent')assert.equal(result.data.remoteDiagnostics,undefined);else assert.ok(result.data.remoteDiagnostics.errorCode);assert.equal(JSON.stringify(result.data).includes('secret-never-output'),false);assert.equal((await f.repo.getJob('owner',job.id)).details.remoteWritePending,'send_instruction');
  }finally{f.sqlite.close()}
 }
});

test('fixed prior-job inspection is read-only despite an expired production window and never fetches declared arbitrary files',async()=>{
 for(const variant of ['valid','missing','invalid']){
  const f=fixture(),calls=[];try{
   const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id),conversationId='5e813d72d907441cbe5f949c16014406';
   await f.repo.updateJob('owner',job.id,{status:'awaiting_result',details:{...job.details,conversationId,messageSentAt:new Date().toISOString(),automationProbeExpiresAt:'1970-01-01T00:00:00.000Z'}});
   const before=await f.repo.getJob('owner',job.id);f.env.AUTOMATION_PROBE_MODE='production-inspection';f.env.AUTOMATION_PROBE_JOB_ID=job.id;f.env.AUTOMATION_PROBE_BUTLER='true';
   f.injected.fetcher=async(url,options)=>{const u=new URL(url);calls.push(u.pathname);assert.equal(options.method,'GET');assert.equal(u.origin,'https://bxagi.xinlx.com');
    if(u.pathname==='/api/v1/feature-flags')return variant==='missing'?new Response('secret-never-output',{status:503}):Response.json({butler_mode:true});
    if(u.pathname==='/api/v1/butler/dispatches')return Response.json({items:[{client_message_id:'coordination-record',conversation_id:conversationId,status:'completed',ack_text:'secret-never-output',route:{employee_name:'市场协调员工',token:'secret-never-output'}}]});
    if(u.pathname==='/api/v1/app-conversations')return Response.json([{id:conversationId,created_by_user_id:'s',employee_id:'design',node_id:'owned-node',selected_repository:'owned-project',execution_status:null}]);
    if(u.pathname.endsWith('/events/search'))return Response.json({items:[{id:'state-event',kind:'ConversationStateUpdateEvent',source:'agent',timestamp:'2026-10-14T11:27:00Z',key:'full_state',value:{execution_status:'finished',secret:'secret-never-output'}}]});
    if(u.pathname.endsWith('/files')||u.pathname.endsWith('/file/list')){assert.ok([`bxagi-advertising/${job.id}/input`,`bxagi-advertising/${job.id}/output`].includes(u.searchParams.get('path')));return Response.json({directories:[],files:[]});}
    assert.equal(u.pathname,`/api/nodes/owned-node/file/download-relative/bxagi-advertising/${job.id}/output/manifest.json`);assert.equal(u.searchParams.get('project_name'),'owned-project');
    return variant==='missing'?new Response('private upstream body',{status:404}):Response.json({version:1,jobId:job.id,kind:'production',secret:'secret-never-output',creatives:[{path:variant==='invalid'?'https://arbitrary.invalid/private.png':`bxagi-advertising/${job.id}/output/result.png`,mimeType:'image/png',sourceAssetIds:job.details.assetIds,title:'secret-never-output'}]});};
   const response=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-inspection',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected),data=await response.json();
   assert.equal(data.butler.readOnly,true);assert.equal(data.butler.dispatchEnabled,false);if(variant==='missing')assert.equal(data.butler.errorCode,'butler_inspection_unavailable');else {assert.equal(data.butler.enabled,true);assert.equal(data.butler.history.items[0].status,'completed');assert.equal(data.butler.history.deliveryVerified,false);}
   assert.equal(response.status,200);assert.equal(data.readOnly,true);assert.equal(data.manifest.found,variant==='valid');assert.equal(data.manifest.fileVerified,false);assert.equal(data.productionCompleted,false);assert.equal(data.archiveVerified,false);assert.equal(data.remoteDiagnostics.events[0].execution_status,'finished');assert.equal(calls.filter(p=>p.includes('/file/download-relative/')).length,1);assert.equal(calls.filter(p=>p.endsWith('/file/list')).length,2);assert.equal(JSON.stringify(data).includes('secret-never-output'),false);assert.equal(JSON.stringify(data).includes('arbitrary.invalid'),false);assert.deepEqual(await f.repo.getJob('owner',job.id),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n,3);
  }finally{f.sqlite.close()}
 }
});

test('private collection requires its recovery mode and invokes only the fixed original production collector',async()=>{
 const f=fixture();try{
  const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id);
  await f.repo.updateJob('owner',job.id,{details:{...job.details,messageSentAt:new Date().toISOString(),conversationId:'owned-conversation'}});
  f.env.AUTOMATION_PROBE_JOB_ID=job.id;let collected=0;
  f.injected.createOrchestrator=()=>({async collectProduction(id){assert.equal(id,job.id);collected++;return {job:await f.repo.getJob('owner',id)}}});
  const call=()=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-collection',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected);
  f.env.AUTOMATION_PROBE_MODE='production-inspection';assert.equal((await call()).status,503);assert.equal(collected,0);
  f.env.AUTOMATION_PROBE_MODE='production-recovery';const response=await call(),data=await response.json();assert.equal(response.status,200);assert.equal(collected,1);assert.equal(data.remoteWrites,false);assert.equal(data.productionCompleted,false);assert.equal(data.paidAdvertisingPerformed,false);assert.deepEqual(data.artifacts,[]);assert.equal(f.submits(),1);
 }finally{f.sqlite.close()}
});

test('showcase layout correction needs its distinct capability and fixed original hash, with no caller-selected content',async()=>{
 const f=fixture();try{
  const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id);
  await f.repo.updateJob('owner',job.id,{status:'completed',details:{...job.details,messageSentAt:new Date().toISOString(),conversationId:'owned-conversation'}});
  f.env.AUTOMATION_PROBE_JOB_ID=job.id;f.env.AUTOMATION_PROBE_MEDIA='video';let repairs=0;
  f.injected.createOrchestrator=()=>({async repairShowcaseLayout(id,auth,options){repairs++;assert.equal(id,job.id);assert.deepEqual(auth,{jobId:job.id,expiresAt:f.env.AUTOMATION_PROBE_EXPIRES_AT});assert.deepEqual(options,{originalSha256:'a'.repeat(64)});return {job:await f.repo.getJob('owner',id)}}});
  const call=(body)=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-showcase-layout-repair',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`},...(body?{body}:{})}),f.env,f.injected);
  f.env.AUTOMATION_PROBE_MODE='production-recovery';assert.equal((await call()).status,503);assert.equal(repairs,0);
  f.env.AUTOMATION_PROBE_MODE='showcase-layout-repair';assert.equal((await call()).status,503);assert.equal(repairs,0);
  f.env.AUTOMATION_PROBE_ORIGINAL_SHA256='A'.repeat(64);assert.equal((await call('{"text":"arbitrary"}')).status,400);assert.equal(repairs,0);
  assert.equal((await f.call()).status,503);assert.equal((await call()).status,200);assert.equal(repairs,1);
  f.env.AUTOMATION_PROBE_EXPIRES_AT='2000-01-01T00:00:00Z';assert.equal((await call()).status,503);assert.equal(repairs,1);
 }finally{f.sqlite.close();}
});

test('delivery repair requires a distinct bounded capability and forwards only its fixed job scope',async()=>{
 const f=fixture();try{
  const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id);
  await f.repo.updateJob('owner',job.id,{status:'failed',details:{...job.details,messageSentAt:new Date().toISOString(),conversationId:'owned-conversation',lastErrorCode:'bxagi_delivery_missing'}});
  f.env.AUTOMATION_PROBE_JOB_ID=job.id;let repaired=0;
  f.injected.createOrchestrator=()=>({async repairDelivery(id,authorization){repaired++;assert.equal(id,job.id);assert.deepEqual(authorization,{jobId:job.id,expiresAt:f.env.AUTOMATION_PROBE_EXPIRES_AT});return {job:await f.repo.getJob('owner',id)}}});
  const call=(body)=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-repair',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`},...(body?{body}:{})}),f.env,f.injected);
  f.env.AUTOMATION_PROBE_MODE='production-recovery';assert.equal((await call()).status,503);assert.equal(repaired,0);
  f.env.AUTOMATION_PROBE_MODE='production-repair';assert.equal((await call('{"jobId":"another"}')).status,400);assert.equal(repaired,0);
  const response=await call(),data=await response.json();assert.equal(response.status,200);assert.equal(data.jobId,job.id);assert.equal(data.productionCompleted,false);assert.equal(data.paidAdvertisingPerformed,false);assert.equal(repaired,1);
  f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';assert.equal((await call()).status,503);assert.equal(repaired,1);
 }finally{f.sqlite.close()}
});

test('artifact inspection streams only the completed fixed job owned PNG and rejects a foreign source job',async()=>{
 const f=fixture();try{
  const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id),bytes=new Uint8Array([137,80,78,71]);
  const creative=await f.repo.createCreative('owner',{projectId:job.projectId,filename:'poster.png',mimeType:'image/png',size:bytes.length,objectKey:'owned-test-output',title:'测试输出',metadata:{sourceJobId:job.id}});
  await f.env.BUCKET.put(creative.objectKey,bytes);
  await f.repo.updateJob('owner',job.id,{status:'completed',details:{...job.details,messageSentAt:new Date().toISOString(),messageAcknowledged:true,startTaskId:'verified-start',inputsReady:true,briefUploaded:true,conversationId:'owned-conversation',resultCreativeIds:[creative.id]}});
  f.env.AUTOMATION_PROBE_MODE='production-recovery';f.env.AUTOMATION_PROBE_JOB_ID=job.id;
  const call=()=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-artifact',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected);
  const response=await call();assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/png');assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  await f.repo.updateCreative('owner',creative.id,{metadata:{sourceJobId:'foreign-job'}});assert.equal((await call()).status,404);
  f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';assert.equal((await call()).status,503);
 }finally{f.sqlite.close()}
});

async function archivedPartialFixture(){
 const f=fixture(),initial=await f.call(),job=await f.repo.getJob('owner',initial.data.job.id),bytes=new Uint8Array([0,0,0,24,102,116,121,112]);
 const creative=await f.repo.createCreative('owner',{projectId:job.projectId,title:'Archived current video',filename:'video-h264.mp4',mimeType:'video/mp4',size:bytes.length,objectKey:'archived-partial-video',width:720,height:720,duration:10,metadata:{sourceJobId:job.id}});
 await f.env.BUCKET.put(creative.objectKey,bytes);
 const current=await f.repo.updateJob('owner',job.id,{status:'failed',details:{...job.details,messageSentAt:new Date().toISOString(),messageAcknowledged:true,startTaskId:'verified-start',inputsReady:true,briefUploaded:true,conversationId:'owned-conversation',resultCreativeIds:[creative.id],lastErrorCode:'bxagi_market_employee_activation_required',videoFormatRepair:{phase:'sent',messageAcknowledged:true}}});
 f.env.AUTOMATION_PROBE_MODE='production-recovery';f.env.AUTOMATION_PROBE_JOB_ID=job.id;f.env.AUTOMATION_PROBE_ARTIFACT_KIND='video';
 f.injected.createOrchestrator=()=>assert.fail('Archive download cannot advance production');
 return {...f,job:current,creative,bytes,artifactCall:()=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-artifact',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected)};
}
test('fixed artifact streams an owned acknowledged partial archive without remote work or completing its failed job',async()=>{
 const f=await archivedPartialFixture();try{
  const before=await f.repo.getJob('owner',f.job.id),creativeBefore=await f.repo.getCreative('owner',f.creative.id),response=await f.artifactCall();
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'video/mp4');assert.equal(response.headers.get('Content-Length'),String(f.bytes.length));assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),f.bytes);
  assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);assert.deepEqual(await f.repo.getCreative('owner',f.creative.id),creativeBefore);assert.equal(f.submits(),1);
 }finally{f.sqlite.close();}
});
test('partial archive rejects missing acknowledgements, any pending coordination or repair and identity mismatches even for completed jobs',async()=>{
 const invalid=[
  ['messageAcknowledged',false],['startTaskId',null],['inputsReady',false],['briefUploaded',false],['bxagiSubject','foreign'],['remoteWritePending','send_instruction'],['remoteOutcomeUnknown',true],['outcomeUnknown',true],
  ['coordination',{phase:'waiting_reply',remoteWritePending:'dispatch_official_butler'}],['coordination',{dispatchAcceptedObserved:true,dispatchAccepted:false}],['coordination',{dispatchOutcomeUnknown:true}],
  ...['deliveryRepair','visualRepair','videoFormatRepair'].flatMap(key=>[[key,{phase:'sent',messageAcknowledged:false}],[key,{phase:'sent',messageAcknowledged:true,remoteWritePending:'send_repair'}],[key,{phase:'sent',messageAcknowledged:true,remoteOutcomeUnknown:true}],[key,{phase:'needs_reconciliation',messageAcknowledged:true}]])
 ];
 for(const status of ['failed','completed'])for(const [key,value]of invalid){const f=await archivedPartialFixture();try{
  await f.repo.updateJob('owner',f.job.id,{status,details:{...f.job.details,[key]:value}});const before=await f.repo.getJob('owner',f.job.id);let reads=0;f.env.BUCKET.get=async()=>{reads++;assert.fail('Uncertain task cannot read archived content');};
  assert.equal((await f.artifactCall()).status,409,`${status}:${key}:${JSON.stringify(value)}`);assert.equal(reads,0);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);
 }finally{f.sqlite.close();}}
 for(const variant of ['needs_reconciliation','foreign-owner']){const f=await archivedPartialFixture();try{
  if(variant==='needs_reconciliation')await f.repo.updateJob('owner',f.job.id,{status:variant});else f.sqlite.prepare('UPDATE jobs SET userId=? WHERE id=?').run('foreign',f.job.id);
  assert.equal((await f.artifactCall()).status,409,variant);
 }finally{f.sqlite.close();}}
});
test('partial archive retains current creative owner, project, source, rejection, MIME, R2 integrity and time-window restrictions',async()=>{
 for(const variant of ['foreign-owner','foreign-project','foreign-source','rejected','wrong-mime','not-current','missing-object','size-mismatch','expiry']){const f=await archivedPartialFixture();try{
  if(variant==='foreign-owner')f.sqlite.prepare('UPDATE creatives SET userId=? WHERE id=?').run('foreign',f.creative.id);
  if(variant==='foreign-project')await f.repo.updateCreative('owner',f.creative.id,{projectId:'foreign'});
  if(variant==='foreign-source')await f.repo.updateCreative('owner',f.creative.id,{metadata:{sourceJobId:'foreign'}});
  if(variant==='rejected')await f.repo.updateCreative('owner',f.creative.id,{status:'rejected'});
  if(variant==='wrong-mime')await f.repo.updateCreative('owner',f.creative.id,{mimeType:'image/png'});
  if(variant==='not-current')await f.repo.updateJob('owner',f.job.id,{details:{...f.job.details,resultCreativeIds:[]}});
  if(variant==='missing-object')await f.env.BUCKET.delete(f.creative.objectKey);
  if(variant==='size-mismatch')await f.repo.updateCreative('owner',f.creative.id,{size:f.bytes.length+1});
  if(variant==='expiry')f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';
  const before=await f.repo.getJob('owner',f.job.id);assert.equal((await f.artifactCall()).status,variant==='expiry'?503:404,variant);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);
 }finally{f.sqlite.close();}}
});

test('visual repair has a distinct fixed-owner capability and ships only compiled licensed resources',async()=>{
 const f=fixture();try{
  const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id);
  await f.repo.updateJob('owner',job.id,{status:'completed',details:{...job.details,messageSentAt:new Date().toISOString(),conversationId:'owned-conversation'}});
  f.env.AUTOMATION_PROBE_JOB_ID=job.id;let repaired=0;
  f.injected.createOrchestrator=()=>({async repairVisualDelivery(id,authorization,{resources}){
   repaired++;assert.equal(id,job.id);assert.deepEqual(authorization,{jobId:job.id,expiresAt:f.env.AUTOMATION_PROBE_EXPIRES_AT});
   assert.deepEqual(resources.map(r=>r.filename),['BXAGI-Workflow-SC-Subset.ttf','OFL.txt','NOTICE.txt']);
   assert.ok(resources.reduce((n,r)=>n+r.size,0)<32768);
   for(const resource of resources){assert.equal(resource.blob.size,resource.size);assert.match(resource.sha256,/^[a-f0-9]{64}$/);}
   return {job:await f.repo.getJob('owner',id)};
  }});
  const call=(body)=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-visual-repair',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`},...(body?{body}:{})}),f.env,f.injected);
  for(const mode of ['production-market','production-recovery','production-repair']){f.env.AUTOMATION_PROBE_MODE=mode;assert.equal((await call()).status,503);}
  f.env.AUTOMATION_PROBE_MODE='production-visual-repair';assert.equal((await call('{"resources":[]}')).status,400);assert.equal(repaired,0);
  const response=await call(),data=await response.json();assert.equal(response.status,200);assert.equal(repaired,1);assert.equal(data.messageAcknowledged,false);assert.equal(data.productionCompleted,false);assert.equal(data.paidAdvertisingPerformed,false);
  f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';assert.equal((await call()).status,503);assert.equal(repaired,1);
 }finally{f.sqlite.close()}
});

function videoSourcePng(){
 const crc=bytes=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value>>>1^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const content=Buffer.concat([Buffer.from(name),data]),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(content));return Buffer.concat([length,content,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(24);header.writeUInt32BE(24,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc(24*(24*3+1));for(let y=0;y<24;y++)for(let x=0;x<24;x++){const at=y*73+1+x*3;pixels[at]=x*10;pixels[at+1]=y*10;pixels[at+2]=180;}
 return new Uint8Array(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
const bytesHash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
async function videoFixture(){
 const f=fixture(),bytes=videoSourcePng(),project=await f.repo.createProject('owner',{title:'previous actual PNG',facts:['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺']}),sourceJob=await f.repo.createJob('owner',{projectId:project.id,type:'bxagi_workflow',employeeId:'bxagi:market:design',status:'completed',details:{kind:'production',bxagiSubject:'s'}});
 const source=await f.repo.createCreative('owner',{projectId:project.id,title:'Verified fixture PNG',filename:'poster-v2.png',mimeType:'image/png',size:bytes.length,objectKey:'verified-owned-source',status:'draft',metadata:{sourceJobId:sourceJob.id}});
 await f.env.BUCKET.put(source.objectKey,bytes);await f.repo.updateJob('owner',sourceJob.id,{details:{...sourceJob.details,resultCreativeIds:[source.id]}});
 f.env.AUTOMATION_PROBE_MEDIA='video';f.env.AUTOMATION_PROBE_SOURCE_CREATIVE_ID=source.id;f.env.AUTOMATION_PROBE_SOURCE_SHA256=await bytesHash(bytes);
 return {...f,bytes,source,sourceJob};
}
test('video verification clones only the hash-verified owned current PNG into a new source and reuses one market production reservation',async()=>{
 const f=await videoFixture();try{
  const first=await f.call();assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.productionCompleted,false);assert.equal(first.data.paidAdvertisingPerformed,false);assert.equal(f.submits(),1);
  const project=await f.repo.getProject('owner',first.data.projectId),assets=await f.repo.listAssets('owner',project.id);assert.equal(project.title,'BXAGI视频生产实测');assert.equal(project.scene,'general');assert.deepEqual(project.facts,['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺']);for(const value of ['10秒','720×720','24fps','H.264','yuv420p','faststart','94%','100%','淡入淡出','不裁切文字','静音','不下载音乐','file_editor','遇到权限或审批保持等待'])assert.ok(project.description.includes(value),value);
  assert.equal(assets.length,1);assert.equal(assets[0].mimeType,'image/png');assert.equal(assets[0].filename,'automation-source.png');assert.equal(assets[0].size,f.bytes.length);assert.equal(assets[0].metadata.sourceCreativeId,f.source.id);assert.equal(assets[0].metadata.sourceSha256,f.env.AUTOMATION_PROBE_SOURCE_SHA256);assert.notEqual(assets[0].objectKey,f.source.objectKey);assert.deepEqual(new Uint8Array(await new Response((await f.env.BUCKET.get(assets[0].objectKey)).body).arrayBuffer()),f.bytes);
  const second=await f.call();assert.equal(second.data.runId,first.data.runId);assert.equal(second.data.projectId,project.id);assert.equal(f.submits(),1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM assets').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM campaigns').get().n,0);assert.deepEqual(new Uint8Array(await new Response((await f.env.BUCKET.get(f.source.objectKey)).body).arrayBuffer()),f.bytes);
  f.env.AUTOMATION_PROBE_MEDIA='image';assert.equal((await f.call()).status,409);assert.equal(f.submits(),1);f.env.AUTOMATION_PROBE_MEDIA='video';f.env.AUTOMATION_PROBE_SOURCE_SHA256='0'.repeat(64);assert.equal((await f.call()).status,409);assert.equal(f.submits(),1);
 }finally{f.sqlite.close();}
});
test('video input refuses foreign, rejected, stale, uncompleted, wrong MIME, missing, oversized and altered source bytes before a new project or dispatch',async()=>{
 for(const variant of ['foreign','rejected','not-current','pending','subject','project','mime','missing','oversize','size','hash','non-png']){
  const f=await videoFixture();try{
   if(variant==='foreign')f.sqlite.prepare('UPDATE creatives SET userId=? WHERE id=?').run('foreign',f.source.id);
   if(variant==='rejected')await f.repo.updateCreative('owner',f.source.id,{status:'rejected'});
   if(variant==='not-current')await f.repo.updateJob('owner',f.sourceJob.id,{details:{...f.sourceJob.details,resultCreativeIds:[]}});
   if(variant==='pending')await f.repo.updateJob('owner',f.sourceJob.id,{status:'running'});
   if(variant==='subject')await f.repo.updateJob('owner',f.sourceJob.id,{details:{...f.sourceJob.details,bxagiSubject:'other-account',resultCreativeIds:[f.source.id]}});
   if(variant==='project')await f.repo.updateCreative('owner',f.source.id,{projectId:'different-project'});
   if(variant==='mime')await f.repo.updateCreative('owner',f.source.id,{mimeType:'text/plain'});
   if(variant==='missing')await f.env.BUCKET.delete(f.source.objectKey);
   if(variant==='oversize')await f.repo.updateCreative('owner',f.source.id,{size:16*1024*1024+1});
   if(variant==='size')await f.repo.updateCreative('owner',f.source.id,{size:f.bytes.length+1});
   if(variant==='hash')f.env.AUTOMATION_PROBE_SOURCE_SHA256='0'.repeat(64);
   if(variant==='non-png'){const bytes=new Uint8Array(f.bytes.length);await f.env.BUCKET.put(f.source.objectKey,bytes);f.env.AUTOMATION_PROBE_SOURCE_SHA256=await bytesHash(bytes);}
   const result=await f.call();assert.equal(result.status,409,variant);assert.equal(f.submits(),0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM assets').get().n,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM campaigns').get().n,0);
  }finally{f.sqlite.close();}
 }
});
test('an existing image reservation cannot be converted into video or copy another source through environment changes',async()=>{
 const f=fixture();try{const image=await f.call();f.env.AUTOMATION_PROBE_MEDIA='video';f.env.AUTOMATION_PROBE_SOURCE_CREATIVE_ID='00000000-0000-0000-0000-000000000000';f.env.AUTOMATION_PROBE_SOURCE_SHA256='0'.repeat(64);const video=await f.call();assert.equal(video.status,409);assert.equal(f.submits(),1);assert.equal((await f.repo.getProject('owner',image.data.projectId)).title,'BXAGI 智能调度实测');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM assets').get().n,1);}finally{f.sqlite.close();}
});
test('video collection and fixed artifact require actual current MP4 rather than a PNG and expose only owned MP4 metadata and bytes',async()=>{
 const f=await videoFixture();try{
  const first=await f.call(),job=await f.repo.getJob('owner',first.data.job.id);
  const png=await f.repo.createCreative('owner',{projectId:job.projectId,title:'Fixture cover',filename:'cover.png',mimeType:'image/png',size:f.bytes.length,objectKey:'current-cover',status:'draft',metadata:{sourceJobId:job.id}});await f.env.BUCKET.put(png.objectKey,f.bytes);
  const current=await f.repo.updateJob('owner',job.id,{status:'completed',details:{...job.details,messageSentAt:new Date().toISOString(),messageAcknowledged:true,startTaskId:'verified-start',inputsReady:true,briefUploaded:true,conversationId:'owned-conversation',resultCreativeIds:[png.id]}});
  f.env.AUTOMATION_PROBE_MODE='production-recovery';f.env.AUTOMATION_PROBE_JOB_ID=job.id;f.env.AUTOMATION_PROBE_ARTIFACT_KIND='video';let collects=0;
  f.injected.createOrchestrator=()=>({async collectProduction(id){collects++;assert.equal(id,job.id);return {job:await f.repo.getJob('owner',id)}}});
  const call=path=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/'+path,{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected);
  const pngOnly=await (await call('production-collection')).json();assert.equal(pngOnly.productionCompleted,false);assert.equal((await call('production-artifact')).status,404);
  // This endpoint streams already archived bytes; codec/media validation is
  // covered by the real importer, rather than repeated in this route test.
  const bytes=new Uint8Array([0,0,0,24,102,116,121,112]),mp4=await f.repo.createCreative('owner',{projectId:job.projectId,title:'Fixture video',filename:'video.mp4',mimeType:'video/mp4',size:bytes.length,objectKey:'current-video',status:'draft',width:720,height:720,duration:10,metadata:{sourceJobId:job.id}});await f.env.BUCKET.put(mp4.objectKey,bytes);await f.repo.updateJob('owner',job.id,{details:{...current.details,resultCreativeIds:[png.id,mp4.id]}});
  const collected=await (await call('production-collection')).json();assert.equal(collected.productionCompleted,true);assert.equal(collected.remoteWrites,false);assert.equal(collected.paidAdvertisingPerformed,false);assert.deepEqual(collected.artifacts.find(row=>row.id===mp4.id),{id:mp4.id,mimeType:'video/mp4',size:bytes.length,width:720,height:720,duration:10,contentUrl:`/api/v2/creatives/${mp4.id}/content`});
  const output=await call('production-artifact');assert.equal(output.status,200);assert.equal(output.headers.get('Content-Type'),'video/mp4');assert.equal(output.headers.get('Content-Disposition'),'attachment; filename="BXAGI_workflow_test.mp4"');assert.deepEqual(new Uint8Array(await output.arrayBuffer()),bytes);
  await f.repo.updateCreative('owner',mp4.id,{status:'rejected'});assert.equal((await call('production-artifact')).status,404);assert.equal((await (await call('production-collection')).json()).productionCompleted,false);
  await f.repo.updateCreative('owner',mp4.id,{status:'draft',metadata:{sourceJobId:f.sourceJob.id}});assert.equal((await call('production-artifact')).status,404);assert.equal(collects,3);assert.equal(f.submits(),1);
 }finally{f.sqlite.close();}
});

async function diagnosticFixture(){
 const f=await videoFixture(),initial=await f.call(),job=await f.repo.getJob('owner',initial.data.job.id),conversationId='5e813d72d907441cbe5f949c16014406',diagnosticConversationId='f80b31be6ed54fa98a5c1e2efee4a0c9',state={posts:0,outcome:'accepted',reportOwner:'s',reads:[]};
 await f.repo.updateJob('owner',job.id,{status:'failed',details:{...job.details,conversationId,messageSentAt:'2026-10-14T13:47:16Z',messageAcknowledged:true,messageEventId:'verified-video-user-event',lastErrorCode:'bxagi_invalid_artifact'}});
 f.env.AUTOMATION_PROBE_MODE='butler-diagnostic';f.env.AUTOMATION_PROBE_JOB_ID=job.id;
 f.injected.fetcher=async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,'https://bxagi.xinlx.com');assert.equal(options.headers.Authorization,'Bearer secret-never-output');
  if(options.method==='POST'){
   state.posts++;assert.equal(u.pathname,'/api/v1/butler/dispatch');const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body).sort(),['client_message_id','mode','text']);assert.equal(body.mode,'command');assert.match(body.client_message_id,/^[a-f0-9]{32}$/);assert.ok(body.text.length<=500);assert.ok(body.text.includes(job.id));assert.ok(body.text.includes('曾报告缺少cv2/imageio'));assert.ok(body.text.includes('清单路径不符合任务专属目录'));assert.ok(body.text.includes('尚无验收通过MP4'));assert.ok(body.text.includes('不要继续原任务、开始生产或执行修复'));assert.ok(!body.text.includes('secret-never-output'));assert.ok(!body.text.includes(f.source.id));
   const record=(await f.repo.listJobs('owner')).find(row=>row.type==='bxagi_butler_diagnostic');assert.equal(record.details.remoteWritePending,'dispatch_butler_diagnostic');assert.equal(record.details.clientMessageId,body.client_message_id);assert.equal(record.status,'advice_preparing');assert.ok(record.details.operationId);
   if(state.outcome==='network')throw new Error('secret-never-output lost network');
   if(state.outcome==='uncertain')return new Response('secret-never-output remote body',{status:502});
   if(state.outcome==='refused')return new Response('secret-never-output remote body',{status:403});
   if(state.outcome==='malformed')return Response.json({accepted:true,conversation_id:'secret-never-output'});
   return Response.json({accepted:true,conversation_id:diagnosticConversationId,client_message_id:body.client_message_id,ack_text:'secret-never-output raw ack'});
  }
  assert.equal(options.method,'GET');state.reads.push(u.pathname);
  if(u.pathname==='/api/v1/feature-flags')return Response.json({butler_mode:true});
  if(u.pathname==='/api/v1/butler/dispatches'){assert.equal(u.search,'?limit=100&offset=0');const record=(await f.repo.listJobs('owner')).find(row=>row.type==='bxagi_butler_diagnostic');return Response.json({items:state.remoteFailure?[{client_message_id:state.foreignClient?'0'.repeat(32):record.details.clientMessageId,status:'failed',conversation_id:null,route:{employee_name:'通用助理'},error_message:state.failureMessage??'No online execution worker was available.',text:'secret-never-output'}]:[]});}
  if(u.pathname==='/api/v1/app-conversations'){const id=u.searchParams.getAll('ids')[0];assert.ok([conversationId,diagnosticConversationId].includes(id));return Response.json([{id,created_by_user_id:id===diagnosticConversationId?state.reportOwner:'s',employee_id:id===conversationId?'design':null,agent_type:'CodeActAgent'}]);}
  if(u.pathname.endsWith('/events/search')){assert.equal(u.pathname,`/api/v1/conversation/${diagnosticConversationId}/events/search`);return Response.json({items:[{id:'diagnostic-finish',kind:'ActionEvent',source:'agent',timestamp:'2026-10-14T14:00:00Z',action:{kind:'FinishAction',message:'只给建议：现有工具处理，清单使用专属相对路径。'}}]});}
  if(u.pathname==='/api/v1/agents')return Response.json([]);
  assert.fail('Unexpected diagnostic request '+u.pathname);
 };
 const call=async({body,query='',secret=f.env.AUTOMATION_PROBE_SECRET,method='POST'}={})=>{const response=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/butler-diagnostic'+query,{method,headers:{Authorization:`Bearer ${secret}`},...(body?{body}:{})}),f.env,f.injected);return {status:response.status,data:await response.json()};};
 return {...f,job:await f.repo.getJob('owner',job.id),state,diagnosticCall:call,diagnosticConversationId};
}
test('scoped butler diagnostic dispatches once under a durable reservation without modifying failed video production; duplicates read only its owned advice',async()=>{
 const f=await diagnosticFixture();try{
  const before=await f.repo.getJob('owner',f.job.id),first=await f.diagnosticCall();assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.status,'advice_dispatched');assert.equal(first.data.accepted,true);assert.equal(first.data.productionCompleted,false);assert.equal(first.data.adviceAutomaticallyApplied,false);assert.equal(first.data.paidAdvertisingPerformed,false);assert.equal(first.data.conversationId,f.diagnosticConversationId);assert.equal(f.state.posts,1);
  const record=await f.repo.getJob('owner',first.data.diagnosticId);assert.equal(record.type,'bxagi_butler_diagnostic');assert.equal(record.details.remoteWritePending,null);assert.equal(record.details.operationId,undefined);assert.match(record.details.fixedTextHash,/^[a-f0-9]{64}$/);assert.equal((await f.repo.listDueBxagiJobs()).some(job=>job.id===record.id),false);
  const second=await f.diagnosticCall();assert.equal(second.data.diagnosticId,first.data.diagnosticId);assert.equal(second.data.report.latestFinish.message.includes('只给建议'),true);assert.equal(f.state.posts,1);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs WHERE type=?').get('bxagi_butler_diagnostic').n,1);assert.ok(!JSON.stringify(first.data).includes('secret-never-output'));
  f.state.reportOwner='foreign';const blocked=await f.diagnosticCall();assert.equal(blocked.data.accepted,true);assert.equal(blocked.data.report.errorCode,'butler_diagnostic_report_unavailable');assert.equal(f.state.posts,1);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);
 }finally{f.sqlite.close();}
});
test('concurrent butler diagnostic callers reserve one client ID and dispatch only once',async()=>{
 const f=await diagnosticFixture();try{const results=await Promise.all([f.diagnosticCall(),f.diagnosticCall()]);assert.equal(results.every(row=>row.status===200),true);assert.equal(results[0].data.diagnosticId,results[1].data.diagnosticId);assert.equal(f.state.posts,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs WHERE type=?').get('bxagi_butler_diagnostic').n,1);assert.equal(f.submits(),1);}finally{f.sqlite.close();}
});
test('unknown butler write outcome is permanent, never retries and cannot complete production; explicit refusals also consume the reservation',async()=>{
 for(const variant of ['network','uncertain','malformed','refused']){
  const f=await diagnosticFixture();try{
   f.state.outcome=variant;const before=await f.repo.getJob('owner',f.job.id),first=await f.diagnosticCall();assert.equal(first.status,200);assert.equal(first.data.status,variant==='refused'?'advice_refused':'advice_needs_reconciliation');assert.equal(first.data.dispatchOutcomeUnknown,variant!=='refused');assert.equal(first.data.productionCompleted,false);assert.equal(f.state.posts,1);const record=await f.repo.getJob('owner',first.data.diagnosticId);assert.equal(record.details.remoteWritePending,variant==='refused'?null:'dispatch_butler_diagnostic');
   await f.diagnosticCall();assert.equal(f.state.posts,1);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);assert.equal(JSON.stringify(first.data).includes('secret-never-output'),false);assert.equal((await f.repo.listDueBxagiJobs()).some(job=>job.id===record.id),false);
  }finally{f.sqlite.close();}
 }
});
test('same-client official failure reconciles only the advice record and never retries dispatch or changes production',async()=>{
 const f=await diagnosticFixture();try{
  f.state.outcome='malformed';const before=await f.repo.getJob('owner',f.job.id),first=await f.diagnosticCall();assert.equal(first.data.status,'advice_needs_reconciliation');assert.equal(f.state.posts,1);
  f.state.remoteFailure=true;f.state.foreignClient=true;const unrelated=await f.diagnosticCall();assert.equal(unrelated.data.status,'advice_needs_reconciliation');assert.equal(unrelated.data.dispatchDiagnostic.found,false);assert.equal(unrelated.data.dispatchOutcomeUnknown,true);
  f.state.foreignClient=false;const reconciled=await f.diagnosticCall();assert.equal(reconciled.data.status,'advice_failed_remote');assert.equal(reconciled.data.accepted,false);assert.equal(reconciled.data.dispatchOutcomeUnknown,false);assert.equal(reconciled.data.productionCompleted,false);assert.equal(reconciled.data.dispatchDiagnostic.failureMessage,'No online execution worker was available.');
  const record=await f.repo.getJob('owner',first.data.diagnosticId);assert.equal(record.details.remoteStatus,'failed');assert.ok(record.details.reconciledAt);assert.equal(record.details.remoteWritePending,null);assert.equal(record.details.clientMessageId,first.data.clientMessageId);assert.equal((await f.repo.listDueBxagiJobs()).some(job=>job.id===record.id),false);
  await f.diagnosticCall();assert.equal(f.state.posts,1);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);assert.equal(f.submits(),1);
 }finally{f.sqlite.close();}
});
test('missing failure details or unavailable read leave an unknown advice outcome untouched without another POST',async()=>{
 const f=await diagnosticFixture();try{
  f.state.outcome='network';const first=await f.diagnosticCall(),before=await f.repo.getJob('owner',first.data.diagnosticId);
  const fetcher=f.injected.fetcher;f.injected.fetcher=async(url,options)=>new URL(url).pathname==='/api/v1/butler/dispatches'?new Response('secret-never-output upstream',{status:500}):fetcher(url,options);
  const unavailable=await f.diagnosticCall();assert.equal(unavailable.data.status,'advice_needs_reconciliation');assert.equal(unavailable.data.dispatchDiagnostic.failureMessage,null);assert.deepEqual(await f.repo.getJob('owner',first.data.diagnosticId),before);assert.equal(f.state.posts,1);
  f.injected.fetcher=fetcher;f.state.remoteFailure=true;f.state.failureMessage={settings:{token:'secret-never-output'}};const failed=await f.diagnosticCall();assert.equal(failed.data.status,'advice_failed_remote');assert.equal(failed.data.dispatchDiagnostic.failureMessage,null);assert.equal(f.state.posts,1);assert.equal(JSON.stringify(failed.data).includes('secret-never-output'),false);
 }finally{f.sqlite.close();}
});
test('butler diagnostic requires its exact capability and fixed owner job; caller scope and unacknowledged production cannot dispatch',async()=>{
 for(const variant of ['mode','secret','body','query','method','expiry','job','subject','history','unacknowledged']){
  const f=await diagnosticFixture();try{
   const args={};if(variant==='mode')f.env.AUTOMATION_PROBE_MODE='production-market';if(variant==='secret')args.secret='wrong';if(variant==='body')args.body='{"userId":"foreign"}';if(variant==='query')args.query='?jobId=another';if(variant==='method')args.method='GET';if(variant==='expiry')f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';if(variant==='job')f.env.AUTOMATION_PROBE_JOB_ID=f.sourceJob.id;
   if(['subject','history','unacknowledged'].includes(variant)){const details={...f.job.details,...(variant==='subject'?{bxagiSubject:'foreign'}:variant==='history'?{employee:{...f.job.details.employee,resourceType:'conversation',marketId:null}}:{messageAcknowledged:false})};await f.repo.updateJob('owner',f.job.id,{details});}
   const response=await f.diagnosticCall(args);assert.ok(response.status>=400,variant);assert.equal(f.state.posts,0);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs WHERE type=?').get('bxagi_butler_diagnostic').n,0);assert.equal(f.submits(),1);
  }finally{f.sqlite.close();}
 }
 const routed=await handlePlatformRequest(new Request('https://app.test/api/v2/worker/butler-diagnostic',{method:'POST',headers:{Authorization:'Bearer generic-worker-key'}}),{APP_WORKER_SECRET:'generic-worker-key'});assert.equal(routed.status,503);assert.equal((await routed.json()).error.code,'automation_probe_disabled');
});
test('butler diagnostic mode permits fixed-job reads and local collection but not production, market or repair dispatch',async()=>{
 const f=await diagnosticFixture();try{
  const before=await f.repo.getJob('owner',f.job.id);
  const call=path=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/'+path,{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected);
  for(const path of ['automation-probe','market-inspection','production-repair','production-visual-repair']){const response=await call(path);assert.equal(response.status,503);assert.equal((await response.json()).error.code,'automation_probe_disabled');}
  assert.equal((await call('production-artifact')).status,409);
  let collected=0;f.injected.createOrchestrator=()=>({async collectProduction(id){collected++;assert.equal(id,f.job.id);return {job:await f.repo.getJob('owner',id)}}});
  const response=await call('production-collection');assert.equal(response.status,200);assert.equal((await response.json()).remoteWrites,false);assert.equal(collected,1);assert.equal(f.state.posts,0);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);
 }finally{f.sqlite.close();}
});
test('fixed video inspection projects only bounded manifest path shapes and never fetches arbitrary declared files',async()=>{
 const f=await diagnosticFixture();try{
  const conversationId=f.job.details.conversationId,prefix=`bxagi-advertising/${f.job.id}/output/`,paths=[prefix+'video.mp4','video.mp4','output/cover.png','/workspace/private/video.mp4','../private.mp4','https://unknown.invalid/secret-never-output'],calls=[];
  f.injected.fetcher=async(url,options)=>{const u=new URL(url);calls.push(u.pathname);assert.equal(options.method,'GET');
   if(u.pathname==='/api/v1/app-conversations')return Response.json([{id:conversationId,created_by_user_id:'s',employee_id:'design',node_id:'owned-node',selected_repository:'owned-project'}]);
   if(u.pathname.endsWith('/events/search'))return Response.json({items:[]});
   if(u.pathname==='/api/v1/agents')return Response.json([]);
   if(u.pathname.endsWith('/files')||u.pathname.endsWith('/file/list'))return Response.json({files:[],directories:[]});
   const manifest={version:1,jobId:f.job.id,kind:'production',creatives:paths.map((path,index)=>({path,mimeType:index===2?'image/png':index===5?'secret-never-output':'video/mp4',sourceAssetIds:f.job.details.assetIds}))};
   if(u.pathname.includes('/file/download-relative/')){assert.equal(u.pathname,`/api/nodes/owned-node/file/download-relative/${prefix}manifest.json`);return Response.json(manifest);}
   assert.equal(u.pathname,`/api/v1/conversations/${conversationId}/files/${encodeURIComponent(prefix+'manifest.json')}`);return Response.json({path:prefix+'manifest.json',content:JSON.stringify(manifest)});
  };
  const response=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-inspection',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected),data=await response.json();assert.equal(response.status,200,JSON.stringify(data));assert.equal(data.conversationManifest.found,true);assert.equal(data.conversationManifest.pathsWithinJob,false);
  assert.deepEqual(data.conversationManifest.pathShape,[{index:0,mimeType:'video/mp4',shape:'exact_job_relative'},{index:1,mimeType:'video/mp4',shape:'bare_filename'},{index:2,mimeType:'image/png',shape:'output_relative'},{index:3,mimeType:'video/mp4',shape:'absolute'},{index:4,mimeType:'video/mp4',shape:'other'},{index:5,mimeType:'other',shape:'other'}]);
  assert.equal(JSON.stringify(data).includes('unknown.invalid'),false);assert.equal(JSON.stringify(data).includes('/workspace/private'),false);assert.equal(JSON.stringify(data).includes('secret-never-output'),false);assert.equal(calls.filter(path=>path.includes('/file/download-relative/')).length,1);assert.equal(f.state.posts,0);
  f.env.AUTOMATION_PROBE_MODE='production-video-format-repair';const formatInspection=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-inspection',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected);assert.equal(formatInspection.status,200);assert.equal((await formatInspection.json()).readOnly,true);assert.equal(f.state.posts,0);
 }finally{f.sqlite.close();}
});

async function originalFixture(){
 const f=await diagnosticFixture(),prefix=`bxagi-advertising/${f.job.id}/output/`,bytes=new Uint8Array([0,0,0,8,102,116,121,112,0,0,0,8,109,111,111,118,0,0,0,12,109,100,97,116,1,2,3,4]),state={reads:[],owner:'s',employee:'design',size:bytes.length,manifest:{version:1,jobId:f.job.id,kind:'production',creatives:[{filename:'video.mp4',path:'video.mp4',mimeType:'video/mp4',sourceAssetIds:f.job.details.assetIds}]}};
 f.env.AUTOMATION_PROBE_MODE='production-recovery';
 f.injected.createOrchestrator=()=>assert.fail('Original download must not invoke collection or production');
 f.injected.fetcher=async(url,options)=>{const u=new URL(url);assert.equal(u.origin,'https://bxagi.xinlx.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');state.reads.push(u.pathname);
  if(u.pathname==='/api/v1/app-conversations')return Response.json([{id:f.job.details.conversationId,created_by_user_id:state.owner,employee_id:state.employee,node_id:'owned-node',selected_repository:'owned-project'}]);
  if(u.pathname===`/api/nodes/owned-node/file/download-relative/${prefix}manifest.json`)return Response.json(state.manifest);
  assert.equal(u.pathname,`/api/nodes/owned-node/file/download-relative/${prefix}video.mp4`);return new Response(bytes,{headers:{'Content-Type':'video/mp4','Content-Length':String(state.size)}});
 };
 const original=()=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-original',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected);
 return {...f,original,originalState:state,originalBytes:bytes};
}
test('private original video download returns bounded unverified bytes using GETs only without archiving or completing production',async()=>{
 const f=await originalFixture();try{
  const before=await f.repo.getJob('owner',f.job.id),count=f.sqlite.prepare('SELECT count(*) n FROM creatives').get().n,response=await f.original();
  assert.equal(response.status,200);assert.equal(response.headers.get('X-Artifact-Validation'),'unverified');assert.equal(response.headers.get('Content-Type'),'video/mp4');assert.equal(response.headers.get('Content-Length'),String(f.originalBytes.length));assert.match(response.headers.get('Content-Disposition'),/^attachment;/);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),f.originalBytes);
  assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM creatives').get().n,count);assert.equal(f.submits(),1);assert.equal(f.originalState.reads.filter(path=>path.endsWith('/video.mp4')).length,1);
 }finally{f.sqlite.close();}
});
test('original video endpoint rejects expired capability, unacknowledged or pending jobs and foreign conversation or employee before file download',async()=>{
 for(const variant of ['expiry','unacknowledged','pending','owner','employee','image']){const f=await originalFixture();try{
  if(variant==='expiry')f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';
  if(variant==='image')f.env.AUTOMATION_PROBE_MEDIA='image';
  if(variant==='owner')f.originalState.owner='foreign';if(variant==='employee')f.originalState.employee='foreign';
  if(['unacknowledged','pending'].includes(variant))await f.repo.updateJob('owner',f.job.id,{details:{...f.job.details,...(variant==='pending'?{remoteWritePending:'send_message'}:{messageAcknowledged:false})}});
  const response=await f.original();assert.ok(response.status>=400,variant);assert.equal(f.originalState.reads.some(path=>path.includes('/file/')),false);assert.equal((await f.repo.getJob('owner',f.job.id)).status,'failed');
 }finally{f.sqlite.close();}}
});
test('original video requires one exact manifest file bound to this job and its owned source, and enforces the 16 MiB bound',async()=>{
 for(const variant of ['job','absolute','relative','duplicate','source','oversize']){const f=await originalFixture();try{
  const manifest=f.originalState.manifest;if(variant==='job')manifest.jobId='another-job';if(variant==='absolute')manifest.creatives[0].path='/workspace/video.mp4';if(variant==='relative')manifest.creatives[0].path='output/video.mp4';if(variant==='duplicate')manifest.creatives.push({...manifest.creatives[0]});if(variant==='source')manifest.creatives[0].sourceAssetIds=['foreign'];if(variant==='oversize')f.originalState.size=16*1024*1024+1;
  const before=await f.repo.getJob('owner',f.job.id),response=await f.original();assert.ok(response.status>=400,variant);if(variant!=='oversize')assert.equal(f.originalState.reads.some(path=>path.endsWith('/video.mp4')),false);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);
 }finally{f.sqlite.close();}}
});
test('collection validation reason exposes only the local static allowlist and never arbitrary error text',async()=>{
 const f=await diagnosticFixture();try{
  f.injected.createOrchestrator=()=>({async collectProduction(){return {job:await f.repo.getJob('owner',f.job.id)}}});
  for(const message of ['MP4视频实际时长缺失或无效','secret-never-output remote error']){await f.repo.updateJob('owner',f.job.id,{details:{...f.job.details,lastError:message}});
   const response=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-collection',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected),data=await response.json();assert.equal(response.status,200);assert.equal(data.validationReason,message.startsWith('MP4')?message:null);assert.equal(JSON.stringify(data).includes('secret-never-output'),false);
  }
 }finally{f.sqlite.close();}
});

test('original download buffers the complete body and rejects truncated boxes, length mismatches and stream failures before returning 200',async()=>{
 for(const variant of ['box','length','stream','empty','extended','missing']){const f=await originalFixture();try{
  const prior=f.injected.fetcher,before=await f.repo.getJob('owner',f.job.id);
  f.injected.fetcher=async(url,options)=>{const response=await prior(url,options);if(!new URL(url).pathname.endsWith('/video.mp4'))return response;
   if(variant==='stream')return new Response(new ReadableStream({start(controller){controller.enqueue(f.originalBytes.subarray(0,20));},pull(controller){controller.error(new Error('secret-never-output interrupted'));}}));
   let bytes=f.originalBytes.slice();if(variant==='box')new DataView(bytes.buffer).setUint32(16,1000);if(variant==='extended')new DataView(bytes.buffer).setUint32(16,1);if(variant==='empty')bytes=new Uint8Array();if(variant==='missing')bytes=bytes.slice(0,16);
   return new Response(bytes,{headers:variant==='length'?{'Content-Length':String(bytes.length+1)}:{}});
  };
  const response=await f.original(),data=await response.json();assert.ok(response.status>=400,variant);assert.equal(response.headers.get('X-Artifact-Validation'),null);assert.equal(JSON.stringify(data).includes('secret-never-output'),false);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);
 }finally{f.sqlite.close();}}
});

test('video format repair forwards only a fixed job and server hash under its distinct bounded capability, without local mutation or completion',async()=>{
 const f=await diagnosticFixture();try{
  f.env.AUTOMATION_PROBE_MODE='production-video-format-repair';f.env.AUTOMATION_PROBE_ORIGINAL_SHA256='A'.repeat(64);let repaired=0;
  const before=await f.repo.getJob('owner',f.job.id);
  f.injected.createOrchestrator=({context})=>({async repairVideoFormat(id,authorization){repaired++;assert.equal(context.subject,'s');assert.equal(id,f.job.id);assert.deepEqual(authorization,{jobId:f.job.id,expiresAt:f.env.AUTOMATION_PROBE_EXPIRES_AT,originalSha256:'a'.repeat(64)});return {job:before,busy:true};}});
  const response=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-video-format-repair',{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.jobId,f.job.id);assert.equal(data.busy,true);assert.equal(data.productionCompleted,false);assert.equal(data.paidAdvertisingPerformed,false);assert.equal(data.messageAcknowledged,false);assert.equal(repaired,1);assert.deepEqual(await f.repo.getJob('owner',f.job.id),before);assert.equal(JSON.stringify(data).includes('secret-never-output'),false);assert.equal(JSON.stringify(data).includes('A'.repeat(64)),false);assert.equal(f.state.posts,0);
 }finally{f.sqlite.close();}
});
test('video format repair rejects caller parameters, stale credentials, wrong modes, identities and missing hashes before the orchestrator',async()=>{
 for(const variant of ['mode','body','query','method','secret','expiry','hash','media','subject','job','owner']){const f=await diagnosticFixture();try{
  f.env.AUTOMATION_PROBE_MODE='production-video-format-repair';f.env.AUTOMATION_PROBE_ORIGINAL_SHA256='a'.repeat(64);let calls=0;f.injected.createOrchestrator=()=>{calls++;assert.fail('Repair must not be invoked');};
  if(variant==='mode')f.env.AUTOMATION_PROBE_MODE='production-repair';if(variant==='expiry')f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00Z';if(variant==='hash')f.env.AUTOMATION_PROBE_ORIGINAL_SHA256='secret-never-output';if(variant==='media')f.env.AUTOMATION_PROBE_MEDIA='image';if(variant==='job')f.env.AUTOMATION_PROBE_JOB_ID=f.sourceJob.id;if(variant==='owner')f.env.AUTOMATION_PROBE_OWNER='foreign';if(variant==='subject')await f.repo.updateJob('owner',f.job.id,{details:{...f.job.details,bxagiSubject:'foreign'}});
  const response=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/production-video-format-repair'+(variant==='query'?'?jobId=foreign':''),{method:variant==='method'?'GET':'POST',headers:{Authorization:`Bearer ${variant==='secret'?'wrong':f.env.AUTOMATION_PROBE_SECRET}`},...(variant==='body'?{body:'{"jobId":"foreign","originalSha256":"caller-hash"}'}:{})}),f.env,f.injected);
  assert.ok(response.status>=400,variant);assert.equal(calls,0);assert.equal(f.state.posts,0);
 }finally{f.sqlite.close();}}
});
test('video format repair capability permits collection and artifact checks but cannot enable market, other repair or butler dispatch',async()=>{
 const f=await diagnosticFixture();try{
  f.env.AUTOMATION_PROBE_MODE='production-video-format-repair';let collected=0;f.injected.createOrchestrator=()=>({async collectProduction(id){collected++;assert.equal(id,f.job.id);return {job:await f.repo.getJob('owner',id)}}});
  const call=path=>handleAutomationProbe(new Request('https://app.test/api/v2/worker/'+path,{method:'POST',headers:{Authorization:`Bearer ${f.env.AUTOMATION_PROBE_SECRET}`}}),f.env,f.injected);
  for(const path of ['automation-probe','market-inspection','production-repair','production-visual-repair','butler-diagnostic'])assert.equal((await call(path)).status,503,path);
  assert.equal((await call('production-artifact')).status,409);assert.equal((await call('production-collection')).status,200);assert.equal(collected,1);assert.equal(f.state.posts,0);
 }finally{f.sqlite.close();}
});

test('built-in butler recovery is separately enabled, owner-scoped, and cannot dispatch production',async()=>{
 const f=fixture();let inspected=0,ensured=0;try{
  f.injected.createButlerBootstrap=({context})=>{assert.equal(context.userId,'owner');assert.equal(context.subject,'s');return {async inspect(){inspected++;return {status:'available',canInitialize:true,canRepair:false}},async ensure({authorizationExpiresAt}){ensured++;assert.equal(authorizationExpiresAt,f.env.AUTOMATION_PROBE_EXPIRES_AT);return {status:'ready',ownershipVerified:true}}}};
  const call=async(path,{body,query='',method='POST',secret=f.env.AUTOMATION_PROBE_SECRET}={})=>{const response=await handleAutomationProbe(new Request('https://app.test/api/v2/worker/'+path+query,{method,headers:{Authorization:'Bearer '+secret},...(body?{body}:{})}),f.env,f.injected);return {status:response.status,data:await response.json()}};
  assert.equal((await call('butler-bootstrap')).status,503);f.env.AUTOMATION_PROBE_MODE='butler-recovery';
  assert.equal((await call('butler-inspection')).data.readOnly,true);assert.equal(inspected,1);assert.equal(ensured,0);
  for(const opt of [{body:'{}'},{query:'?userId=other'},{method:'GET'},{secret:'wrong'}])assert.ok([400,401].includes((await call('butler-bootstrap',opt)).status));
  f.injected.resolveContext=async()=>({userId:'foreign',subject:'s'});assert.equal((await call('butler-bootstrap')).status,401);f.injected.resolveContext=async()=>({userId:'owner',subject:'s',accessToken:'secret-never-output'});
  const initialized=await call('butler-bootstrap');assert.equal(initialized.status,200);assert.equal(initialized.data.readOnly,false);assert.equal(initialized.data.paidAdvertisingPerformed,false);assert.equal(ensured,1);
  for(const path of ['automation-probe','production-collection','production-video-format-repair','butler-diagnostic','market-inspection'])assert.equal((await call(path)).status,503);
  f.env.AUTOMATION_PROBE_EXPIRES_AT='1970-01-01T00:00:00.000Z';assert.equal((await call('butler-bootstrap')).status,503);assert.equal(ensured,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM projects').get().n,0);assert.equal(f.submits(),0);
 }finally{f.sqlite.close()}
});

test('fresh butler production verification carries compiled licensed Chinese font inputs through normal asset ownership',async()=>{
 const f=fixture();try{f.env.BXAGI_BUTLER_ENABLED='true';const response=await f.call();assert.equal(response.status,200);const assets=await f.repo.listAssets('owner',response.data.projectId);assert.equal(assets.length,4);assert.equal(assets.filter(a=>a.metadata.licensedWorkflowResource===true).length,3);assert.ok(assets.every(a=>a.userId==='owner'&&a.metadata.automationProbeExpiresAt===f.env.AUTOMATION_PROBE_EXPIRES_AT));assert.ok(assets.some(a=>a.filename.endsWith('.ttf')&&a.role==='reference'));assert.equal((await f.repo.getJob('owner',response.data.job.id)).details.assetIds.length,4);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM campaigns').get().n,0);}finally{f.sqlite.close()}
});
