import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handleFlowTestRequest } from '../server/flow-test-service.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createBxagiAccountRepository } from '../server/bxagi-account-repository.mjs';
import { createBxagiSessionRepository } from '../server/bxagi-session-repository.mjs';
import { createBxagiOrchestrator } from '../server/bxagi-orchestrator.mjs';
import { encryptConnectionSecrets } from '../server/adapters/connection-secrets.mjs';
const SECRET='flow-test-fixture-exclusive-capability-123456789';
const TOKEN='encrypted-fixture-bx-session-never-export';
function database(){const sqlite=new DatabaseSync(':memory:'),directory=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,directory),'utf8'));return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};}
function bucket(){const values=new Map();return {values,async put(key,body){const bytes=new Uint8Array(await new Response(body).arrayBuffer());values.set(key,bytes);return {size:bytes.length};},async get(key){const bytes=values.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),async arrayBuffer(){return bytes.slice().buffer;}}:null;},async delete(key){values.delete(key);}};}
async function fixture(){
  const env={DB:database(),BUCKET:bucket(),APP_ENCRYPTION_KEY:'82'.repeat(32),FLOW_TEST_SECRET:SECRET,FLOW_TEST_EXPIRES_AT:new Date(Date.now()+20*60*1000).toISOString(),APP_WORKER_SECRET:'unrelated-worker-secret'};
  const account=await createBxagiAccountRepository(env.DB).resolveVerifiedSubject('official-fixed-subject');env.FLOW_TEST_OWNER=account.userId;
  await createBxagiSessionRepository(env.DB).create(account.userId,{id:'f'.repeat(64),subject:account.subject,tokenCiphertext:await encryptConnectionSecrets({accessToken:TOKEN},env.APP_ENCRYPTION_KEY),profile:{id:account.subject,displayName:'fixture'},deviceId:'fixture-device',expiresAt:new Date(Date.now()+3600000).toISOString(),lastValidatedAt:new Date().toISOString()});
  const repository=createPlatformRepository(env.DB),calls=[],state={meStatus:200,subject:account.subject,jobId:null};
  const fetcher=async(url,init)=>{calls.push('me');assert.equal(url,'https://bxagi.xinlx.com/api/auth/me');assert.ok(init.headers.Authorization===`Bearer ${TOKEN}`);return Response.json(state.meStatus===200?{id:state.subject,username:'fixture'}:{detail:'never export '+TOKEN},{status:state.meStatus});};
  const workforce={
    async listEmployees(){calls.push('catalog');return [{id:'bxagi:market:hired-production',providerId:'hired-production',provider:'bxagi',marketId:'hired-production',resourceType:'installed_employee',marketVerified:true,activationState:'ready',sourceVerified:true,installed:true,name:'实际市场素材制作与文案员工',usable:true,skills:['文案']}];},
    async createConversation({jobId}){calls.push('create');state.jobId=jobId;return {startTaskId:'fixture-start-task'};},
    async getStartTask(){calls.push('start-status');return {status:'READY',conversationId:'fixture-conversation'};},
    async getConversation(){calls.push('conversation');return {employeeId:'hired-production',executionStatus:'RUNNING'};},
    async uploadFile(input){calls.push('upload');assert.ok(new Uint8Array(await input.blob.arrayBuffer()).length>0);return {relativePath:`${input.directory}/${input.filename}`};},
    async sendMessage(_id,prompt){calls.push('instruction');assert.match(prompt,/不要自行购买、雇佣、续费/);assert.ok(!prompt.includes(TOKEN));},
    async readManifest(){calls.push('manifest');const job=await repository.getJob(account.userId,state.jobId);return {version:1,jobId:job.id,kind:'production',creatives:[{path:`bxagi-advertising/${job.id}/output/result.txt`,filename:'result.txt',mimeType:'text/plain',title:'流程测试文案',format:'square',sourceAssetIds:job.details.assetIds,factsUsed:['这是用于验证平台流程的测试素材']}]};},
    async readArtifact(){calls.push('artifact');return new Response('真实字节：流程测试素材，未投放。');},
  };
  const createOrchestrator=options=>{assert.ok(!options.adsService);return createBxagiOrchestrator({...options,workforce});};
  return {env,repository,calls,state,workforce,owner:account.userId,injected:{fetcher,createOrchestrator}};
}
async function call(f,path,{method='POST',secret=SECRET,body,headers={}}={}){
  const h=new Headers(headers);if(secret)h.set('Authorization',`Bearer ${secret}`);if(body!==undefined)h.set('Content-Type','application/json');
  const r=await handleFlowTestRequest(new Request(`https://app.test/api/v2/worker/flow-test/${path}`,{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{})}),f.env,f.injected);const data=await r.json();
  assert.ok(!JSON.stringify(data).includes(TOKEN));assert.ok(!JSON.stringify(data).includes(SECRET));assert.ok(!JSON.stringify(data).includes(f.owner));assert.ok(!Object.hasOwn(data,'profile'));return {status:r.status,data};
}
test('configuration and independent secret fail closed before any session or employee request',async()=>{
  for(const change of [env=>delete env.FLOW_TEST_SECRET,env=>delete env.FLOW_TEST_OWNER,env=>delete env.FLOW_TEST_EXPIRES_AT,env=>env.FLOW_TEST_EXPIRES_AT='bad-date',env=>env.FLOW_TEST_EXPIRES_AT=new Date(Date.now()-1).toISOString(),env=>env.FLOW_TEST_EXPIRES_AT=new Date(Date.now()+31*60000).toISOString(),env=>env.FLOW_TEST_SECRET='short']){
    const f=await fixture();change(f.env);assert.equal((await call(f,'start')).status,503);assert.deepEqual(f.calls,[]);assert.equal((await f.repository.listProjects(f.owner)).length,0);
  }
  const f=await fixture();assert.equal((await call(f,'start',{secret:f.env.APP_WORKER_SECRET})).status,401);assert.equal((await call(f,'start',{secret:null})).status,401);assert.equal((await call(f,'start',{secret:'wrong-secret'})).status,401);assert.deepEqual(f.calls,[]);
});
test('no owner, job, URL or instruction can be provided and only exact production test routes exist',async()=>{
  const f=await fixture();for(const body of [{owner:f.owner},{userId:f.owner},{jobId:'foreign'},{projectId:'foreign'},{url:'https://outside.test'},{instruction:'launch ads'},{action:'buying'},{runId:'anything'}])assert.equal((await call(f,'start',{body})).status,400);
  for(const path of ['launch','hire','renew','start?owner=x','sync','status','flow-bad/sync'])assert.ok([400,404].includes((await call(f,path)).status));
  assert.equal((await call(f,'start',{headers:{Origin:'https://outside.test'}})).status,403);assert.deepEqual(f.calls,[]);assert.equal((await f.repository.listProjects(f.owner)).length,0);
});
test('fresh official identity must match the fixed saved owner and unavailable sessions cannot fall back',async()=>{
  const f=await fixture();f.state.meStatus=503;assert.equal((await call(f,'start')).status,503);assert.equal((await f.repository.listProjects(f.owner)).length,0);assert.ok(!f.calls.includes('catalog'));
  f.state.meStatus=200;f.state.subject='changed-subject';assert.equal((await call(f,'start')).status,401);assert.equal((await f.repository.listProjects(f.owner)).length,0);
  const other=await fixture();other.env.FLOW_TEST_OWNER='unbound-other-owner';assert.equal((await call(other,'start',{headers:{'oai-authenticated-user-id':other.owner}})).status,401);assert.deepEqual(other.calls,[]);
});
test('concurrent starts reserve one run, create actual source bytes and queue exactly one production job',async()=>{
  const f=await fixture(),results=await Promise.all([call(f,'start',{body:{}}),call(f,'start',{body:{}})]);assert.ok(results.every(r=>[200,201].includes(r.status)));assert.equal(results[0].data.runId,results[1].data.runId);
  const restarted=await call(f,'start');assert.equal(restarted.status,200);assert.equal(restarted.data.stage,'queued');assert.equal(restarted.data.productionCompleted,false);assert.deepEqual(restarted.data.artifacts,[]);assert.equal(f.calls.filter(c=>c==='catalog').length,1);assert.equal(f.calls.filter(c=>c==='create').length,0);
  const projects=await f.repository.listProjects(f.owner),jobs=await f.repository.listJobs(f.owner);assert.equal(projects.length,1);assert.equal(jobs.filter(j=>j.type==='platform_flow_test').length,1);assert.equal(jobs.filter(j=>j.type==='bxagi_workflow').length,1);assert.equal((await f.repository.listCampaigns(f.owner)).length,0);
  const run=jobs.find(j=>j.type==='platform_flow_test'),production=jobs.find(j=>j.type==='bxagi_workflow'),assets=await f.repository.listAssets(f.owner,projects[0].id);assert.equal(production.details.kind,'production');assert.equal(production.details.flowTestRunId,run.id);assert.equal(production.details.flowTestExpiresAt,f.env.FLOW_TEST_EXPIRES_AT);assert.equal(assets.length,1);const object=await f.env.BUCKET.get(assets[0].objectKey);assert.ok(object.size>0);assert.equal(object.size,assets[0].size);assert.match(new TextDecoder().decode(await object.arrayBuffer()),/流程测试/);
});
test('sync advances only the bound production through real archive checks and returns actual file hashes',async()=>{
  const f=await fixture(),started=await call(f,'start'),runId=started.data.runId;let result;
  for(let i=0;i<12;i++){result=await call(f,`${runId}/sync`);assert.equal(result.status,200,JSON.stringify(result.data));if(result.data.productionCompleted)break;}
  assert.equal(result.data.stage,'completed');assert.equal(result.data.productionCompleted,true);assert.equal(result.data.artifacts.length,1);assert.match(result.data.artifacts[0].sha256,/^[a-f0-9]{64}$/);assert.ok(result.data.artifacts[0].size>0);assert.equal(result.data.paidAdvertisingPerformed,false);assert.equal(result.data.financialOperationsPerformed,false);
  assert.equal(result.data.evidence.providerEmployeeId,'hired-production');assert.equal(result.data.evidence.startTaskId,'fixture-start-task');assert.equal(result.data.evidence.conversationId,'fixture-conversation');assert.equal(result.data.evidence.uploadedAssetCount,1);assert.equal(result.data.evidence.briefUploaded,true);assert.ok(Number.isFinite(Date.parse(result.data.evidence.messageSentAt)));
  const creative=await f.repository.getCreative(f.owner,result.data.artifacts[0].id),object=await f.env.BUCKET.get(creative.objectKey);assert.equal(object.size,result.data.artifacts[0].size);assert.equal(creative.metadata.sourceJobId,result.data.productionJobId);assert.equal((await f.repository.listCampaigns(f.owner)).length,0);assert.equal(f.calls.filter(c=>c==='create').length,1);assert.equal(f.calls.filter(c=>c==='instruction').length,1);
  const before=f.calls.length;const status=await call(f,`${runId}/status`,{method:'GET'});assert.equal(status.data.artifacts[0].sha256,result.data.artifacts[0].sha256);assert.deepEqual(f.calls.slice(before),['me','catalog']);assert.equal(status.data.catalog.total,1);assert.equal(status.data.catalog.usable,1);
  f.env.BUCKET.values.delete(creative.objectKey);assert.equal((await call(f,`${runId}/status`,{method:'GET'})).status,422);
});
test('an arbitrary run, ordinary project job or buying job cannot be selected by a flow test record',async()=>{
  const f=await fixture(),started=await call(f,'start'),runId=started.data.runId;assert.equal((await call(f,`flow-${'0'.repeat(32)}/sync`)).status,404);
  const project=await f.repository.createProject(f.owner,{title:'其他私有项目'}),foreign=await f.repository.createJob(f.owner,{projectId:project.id,employeeId:'ordinary',type:'bxagi_workflow',status:'queued',details:{kind:'buying',bxagiSubject:f.state.subject,flowTestRunId:runId,flowTestExpiresAt:f.env.FLOW_TEST_EXPIRES_AT}}),run=await f.repository.getJob(f.owner,runId);
  await f.repository.updateJob(f.owner,runId,{details:{...run.details,productionJobId:foreign.id}});const before=f.calls.filter(c=>c==='create').length;assert.equal((await call(f,`${runId}/sync`)).status,409);assert.equal(f.calls.filter(c=>c==='create').length,before);
});
test('expiry stops sync before a remote dispatch and normal background queries exclude expired test jobs',async()=>{
  const f=await fixture(),started=await call(f,'start'),runId=started.data.runId;f.env.FLOW_TEST_EXPIRES_AT=new Date(Date.now()-1).toISOString();const before=f.calls.length;assert.equal((await call(f,`${runId}/sync`)).status,503);assert.equal(f.calls.length,before);assert.ok(!f.calls.includes('create'));
  const job=await f.repository.getJob(f.owner,started.data.productionJobId);await f.repository.updateJob(f.owner,job.id,{details:{...job.details,flowTestExpiresAt:f.env.FLOW_TEST_EXPIRES_AT}});assert.deepEqual(await f.repository.listDueBxagiJobs(),[]);
});
test('a missing employee start retains one scoped run and status only reads a bounded fresh catalog',async()=>{
  const f=await fixture();f.workforce.listEmployees=async()=>{f.calls.push('catalog');return [];};const started=await call(f,'start');assert.equal(started.status,409);assert.equal(started.data.error.code,'bxagi_market_employee_required');assert.match(started.data.runId,/^flow-/);
  f.workforce.listEmployees=async()=>{f.calls.push('catalog');return Array.from({length:25},(_,i)=>({id:`bxagi:market:employee_${i}`,providerId:`employee_${i}`,provider:"bxagi",marketId:`employee_${i}`,resourceType:"installed_employee",marketVerified:true,activationState:"unverified",sourceVerified:false,usable:false,conversationId:i?'existing-conversation':null,providerConversationExists:false,providerUsable:false,subscriptionExpired:true,accessToken:TOKEN,runtime_url:'https://private.invalid'}));};
  const before=f.calls.length,status=await call(f,`${started.data.runId}/status`,{method:'GET'});assert.equal(status.status,200);assert.equal(status.data.stage,'failed');assert.equal(status.data.catalog.total,25);assert.equal(status.data.catalog.usable,0);assert.equal(status.data.catalog.truncated,true);assert.equal(status.data.catalog.employees.length,20);assert.equal(status.data.catalog.employees[0].conversationExists,false);assert.equal(status.data.catalog.employees[1].hasConversation,true);assert.equal(status.data.catalog.employees[1].subscriptionExpired,true);assert.equal(status.data.catalog.employees[1].availabilityReason,'expired');assert.ok(!JSON.stringify(status.data).includes('private.invalid'));assert.deepEqual(f.calls.slice(before),['me','catalog']);assert.ok(!f.calls.includes('create'));assert.ok(!f.calls.includes('instruction'));assert.equal((await f.repository.listProjects(f.owner)).length,1);assert.equal((await f.repository.listJobs(f.owner)).length,1);
  f.workforce.listEmployees=async()=>{throw new Error('private '+TOKEN);};const unavailable=await call(f,`${started.data.runId}/status`,{method:'GET'});assert.equal(unavailable.status,200);assert.equal(unavailable.data.catalog.reachable,false);assert.equal(unavailable.data.catalog.total,null);
});
