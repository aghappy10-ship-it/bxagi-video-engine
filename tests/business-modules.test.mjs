import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';

// Actual migrations/storage/HTTP handlers; no external employee or advertising calls.
function fixture(t) {
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(`../drizzle/${name}`,import.meta.url),'utf8'));
  t.after(()=>sqlite.close());
  const DB={prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};
  const objects=new Map(),BUCKET={async put(key,body){const bytes=new Uint8Array(await new Response(body).arrayBuffer());objects.set(key,bytes);return {size:bytes.length};},async get(key){const bytes=objects.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),async arrayBuffer(){return bytes.slice().buffer;}}:null;},async delete(key){objects.delete(key);}};
  const env={DB,BUCKET,APP_ENCRYPTION_KEY:'36'.repeat(32)},repo=createPlatformRepository(DB);
  async function call(path,{user='owner',method='GET',body,raw,headers={}}={}) {
    const response=await handlePlatformRequest(new Request(`https://fixture.test/api/v2${path}`,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(raw?{'Content-Type':'image/png','X-Filename':'source.png'}:{}),...headers},...(body?{body:JSON.stringify(body)}:raw?{body:raw}:{})}),env,{repository:repo,resolveBxagiContext:async(_r,_e,{required}={})=>required?{userId:user,nativeUserId:user,subject:`subject-${user}`,profile:{displayName:'Owner'}}:null,fetcher:async()=>{throw new Error('No live requests allowed');}});
    return {status:response.status,data:await response.json()};
  }
  return {call,repo,env};
}
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XAAAAABJRU5ErkJggg==','base64'));
async function sourcePack(call) {
  const created=await call('/projects',{method:'POST',body:{title:'眼镜素材包',facts:['黑色镜框']}});assert.equal(created.status,201);
  const project=created.data.project;
  const opened=await call(`/projects/${project.id}/upload-batches`,{method:'POST',body:{expectedCount:1}});assert.equal(opened.status,201);
  const batch=opened.data.batch,uploaded=await call(`/projects/${project.id}/assets?batchId=${batch.id}`,{method:'POST',raw:png});assert.equal(uploaded.status,201);
  const sealed=await call(`/projects/${project.id}/upload-batches/${batch.id}/complete`,{method:'POST',body:{assetIds:[uploaded.data.asset.id]}});assert.equal(sealed.status,200);
  return {project:sealed.data.project,batch,asset:uploaded.data.asset};
}
async function drafts(call) {
  const pack=await sourcePack(call),creativeIds=[];
  for(let i=0;i<3;i++) {
    const out=await call(`/projects/${pack.project.id}/creatives`,{method:'POST',raw:png,headers:{'X-Creative-Metadata':encodeURIComponent(JSON.stringify({title:`测试成品${i+1}`,sourceAssetIds:[pack.asset.id],width:1,height:1,format:'square'}))}});assert.equal(out.status,201);creativeIds.push(out.data.creative.id);
  }
  const connection=await call('/connections',{method:'POST',body:{channel:'oceanengine',accountId:'12345',accessToken:'test-only-encrypted',expiresAt:'2099-01-01T00:00:00Z'}});assert.equal(connection.status,201);
  const created=await call('/delivery-groups',{method:'POST',body:{projectId:pack.project.id,creativeIds,channel:'oceanengine',connectionId:connection.data.connection.id,dailyBudget:300,totalBudget:900,targetRoi:1.5,objective:'purchase'}});assert.equal(created.status,201,JSON.stringify(created.data));
  return {...pack,...created.data,connection:connection.data.connection};
}

test('manual upload batches seal complete inputs and remain idle until explicit production',async t=>{
  const {call,repo}=fixture(t),created=await call('/projects',{method:'POST',body:{title:'手动上传'}}),id=created.data.project.id;
  assert.equal(created.data.project.productionEmployeeId,'');assert.equal(created.data.project.sourceState.status,'empty');
  const opened=await call(`/projects/${id}/upload-batches`,{method:'POST',body:{expectedCount:2}}),batch=opened.data.batch;
  const first=await call(`/projects/${id}/assets?batchId=${batch.id}`,{method:'POST',raw:png});assert.equal(first.status,201);
  const incomplete=await call(`/projects/${id}/upload-batches/${batch.id}/complete`,{method:'POST',body:{assetIds:[first.data.asset.id]}});assert.equal(incomplete.status,422);
  assert.equal((await call(`/projects/${id}/upload-batches/${batch.id}/complete`,{user:'other',method:'POST',body:{assetIds:[first.data.asset.id]}})).status,404);
  const second=await call(`/projects/${id}/assets?batchId=${batch.id}`,{method:'POST',raw:png});
  const sealed=await call(`/projects/${id}/upload-batches/${batch.id}/complete`,{method:'POST',body:{assetIds:[first.data.asset.id,second.data.asset.id]}});assert.equal(sealed.status,200);
  assert.equal(sealed.data.project.sourceState.status,'sealed');assert.equal((await repo.listJobs('owner')).some(job=>['bxagi_workflow','platform_automation'].includes(job.type)),false);
  assert.equal((await call(`/projects/${id}/assets?batchId=${batch.id}`,{method:'POST',raw:png})).status,409);
  assert.equal((await call('/bootstrap',{user:'other'})).data.assets.length,0);
});

test('a lost upload response can be retried with the same file request without duplicate storage records',async t=>{
  const {call,repo}=fixture(t),created=await call('/projects',{method:'POST',body:{title:'上传重试'}}),id=created.data.project.id;
  const batch=(await call(`/projects/${id}/upload-batches`,{method:'POST',body:{expectedCount:1}})).data.batch;
  const headers={'X-Upload-Request-Id':'retry-upload-1234'};
  const first=await call(`/projects/${id}/assets?batchId=${batch.id}`,{method:'POST',raw:png,headers});assert.equal(first.status,201);
  const retry=await call(`/projects/${id}/assets?batchId=${batch.id}`,{method:'POST',raw:png,headers});assert.equal(retry.status,200);assert.equal(retry.data.asset.id,first.data.asset.id);
  assert.equal((await repo.listAssets('owner',id)).length,1);
  const done=await call(`/projects/${id}/upload-batches/${batch.id}/complete`,{method:'POST',body:{assetIds:[retry.data.asset.id]}});assert.equal(done.status,200);
  assert.equal((await call(`/projects/${id}/assets?batchId=${batch.id}`,{method:'POST',raw:png,headers})).data.asset.id,first.data.asset.id);
});

test('three independent draft units share one pack cap and concurrent budget edits cannot exceed it',async t=>{
  const {call,repo}=fixture(t),{group,campaigns}=await drafts(call);
  assert.equal(campaigns.length,3);assert.equal(new Set(campaigns.map(row=>row.creativeIds[0])).size,3);
  assert.equal(campaigns.reduce((sum,row)=>sum+row.dailyBudget,0),300);
  assert.ok(campaigns.every(row=>row.status==='draft'&&!row.remoteId&&row.deliveryGroupId===group.id));
  const [a,b,c]=campaigns;
  assert.equal((await call(`/campaigns/${a.id}/budget`,{method:'POST',body:{dailyBudget:50}})).status,200);
  assert.equal((await call(`/campaigns/${b.id}/budget`,{method:'POST',body:{dailyBudget:50}})).status,200);
  const concurrent=await Promise.all([a,b].map(row=>call(`/campaigns/${row.id}/budget`,{method:'POST',body:{dailyBudget:120}})));
  assert.equal(concurrent.filter(result=>result.status===200).length,1);assert.ok(concurrent.some(result=>result.status===409));
  assert.ok((await repo.listCampaigns('owner')).reduce((sum,row)=>sum+row.dailyBudget,0)<=300);
  assert.equal((await call(`/campaigns/${c.id}/budget`,{user:'other',method:'POST',body:{dailyBudget:50}})).status,404);
  assert.equal((await call(`/delivery-groups/${group.id}/budget`,{method:'POST',body:{dailyBudget:100,totalBudget:900}})).status,409);
  assert.equal((await call(`/delivery-groups/${group.id}/budget`,{user:'other',method:'POST',body:{dailyBudget:500,totalBudget:1000}})).status,404);
});

test('global report sums unit data once; evidence creates an owner-scoped task and strategy remains unverified',async t=>{
  const {call,repo}=fixture(t),{campaigns}=await drafts(call);
  for(let d=0;d<3;d++)for(const campaign of campaigns) {
    const date=new Date(Date.now()-d*86400000).toISOString().slice(0,10);
    const report=await call(`/campaigns/${campaign.id}/metrics`,{method:'POST',body:{date,spend:10,revenue:5,conversions:4,impressions:100,clicks:10,hasConversion:true,dataFresh:true}});assert.equal(report.status,200);
  }
  const overview=await call('/insights/overview');assert.equal(overview.status,200);assert.equal(overview.data.spend,90);assert.equal(overview.data.revenue,45);assert.equal(overview.data.roi,.5);
  const generated=await call('/decisions/refresh',{method:'POST',body:{}});assert.equal(generated.status,200);
  const decision=generated.data.decisions.find(row=>row.type==='material'&&row.campaignId);assert.ok(decision);
  const accepts=await Promise.all([1,2].map(()=>call(`/decisions/${decision.id}/action`,{method:'POST',body:{action:'accept'}})));
  assert.ok(accepts.some(result=>result.status===200));
  assert.equal((await repo.listOptimizationTasks('owner')).filter(row=>row.metadata?.sourceDecisionId===decision.id).length,1);
  assert.equal((await call(`/decisions/${decision.id}/action`,{user:'other',method:'POST',body:{action:'dismiss'}})).status,404);
  const strategy=await call('/strategies',{method:'POST',body:{decisionId:decision.id}});assert.equal(strategy.status,201);
  assert.equal((await call(`/strategies/${strategy.data.strategy.id}/action`,{method:'POST',body:{action:'activate'}})).status,409);
  assert.equal((await call('/insights/overview',{user:'other'})).data.spend,0);
});

test('preferences and connection management persist safely and cross-site PATCH/DELETE are rejected',async t=>{
  const {call,repo}=fixture(t);
  const saved=await call('/settings/preferences',{method:'PATCH',body:{displayName:'我的工作室',notificationEmail:'owner@example.com',preferences:{workspaceName:'广告工作区',timezone:'Asia/Hong_Kong',notifyOnFailure:true}}});assert.equal(saved.status,200);assert.equal(saved.data.settings.emailDeliveryAvailable,false);
  assert.equal((await call('/settings/preferences')).data.settings.displayName,'我的工作室');assert.equal((await call('/settings/preferences',{user:'other'})).data.settings.displayName,'');
  const connection=(await call('/connections',{method:'POST',body:{channel:'volcano',accountId:'project-a',accessToken:'not-real-api-key'}})).data.connection;
  const before=await repo.getConnection('owner',connection.id);
  const changed=await call(`/connections/${connection.id}`,{method:'PATCH',body:{label:'模型服务',accessToken:''}});assert.equal(changed.status,200);assert.equal((await repo.getConnection('owner',connection.id)).secretsCiphertext,before.secretsCiphertext);
  assert.ok(!JSON.stringify(changed.data).includes('not-real-api-key'));
  const probe=await call(`/connections/${connection.id}/test`,{method:'POST',body:{}});assert.equal(probe.data.status,'adapter_pending');assert.equal(probe.data.verified,false);
  assert.equal((await call(`/connections/${connection.id}`,{user:'other',method:'DELETE'})).status,404);
  assert.equal((await call('/settings/preferences',{method:'PATCH',body:{displayName:'attack'},headers:{Origin:'https://other.test'}})).status,403);
  assert.equal((await call(`/connections/${connection.id}`,{method:'DELETE',headers:{Origin:'https://other.test'}})).status,403);
  assert.equal((await call(`/connections/${connection.id}`,{method:'DELETE'})).data.deleted,true);
});
