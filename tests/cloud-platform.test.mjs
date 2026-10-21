import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';

function database() {
  const db=new DatabaseSync(':memory:');
  const dir=new URL('../drizzle/',import.meta.url);
  const migrations=readdirSync(dir).filter(f=>f.endsWith('.sql')).sort();
  assert.ok(migrations.length,'Generated deployment migrations must exist');
  for(const filename of migrations)db.exec(readFileSync(new URL(filename,dir),'utf8'));
  return {sqlite:db,prepare(sql){const s=db.prepare(sql);return {bind(...args){return {async first(){return s.get(...args)??null;},async all(){return {results:s.all(...args)};},async run(){const result=s.run(...args);return {meta:{changes:Number(result.changes)}};}};}};}};
}
function bucket(){const values=new Map();return {values,async put(key,body,options){const reader=body.getReader();const chunks=[];let size=0;while(true){const {value,done}=await reader.read();if(done)break;chunks.push(value);size+=value.length;}const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}values.set(key,{bytes,options});return {key,size};},async get(key,options){const value=values.get(key);if(!value)return null;const bytes=options?.range?value.bytes.slice(options.range.offset,options.range.offset+options.range.length):value.bytes;return {size:bytes.length,body:new Blob([bytes]).stream(),async arrayBuffer(){return bytes.slice().buffer;}};},async delete(key){values.delete(key);}};}
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XAAAAABJRU5ErkJggg==','base64'));
function fixture(){return {DB:database(),BUCKET:bucket(),APP_ENCRYPTION_KEY:'19'.repeat(32),APP_WORKER_SECRET:'fixture-worker-secret'};}
// Isolate legacy business/media checks from upstream authentication. Production
// routes never supply this dependency, and request headers do not choose owners.
function authenticatedContext(user) {
  return async (_request,_env,{required}={}) => required&&user
    ? {userId:user,nativeUserId:user,subject:`fixture-bxagi-${user}`,profile:{id:`fixture-bxagi-${user}`,displayName:'测试用户'}}
    : null;
}
async function call(env,path,{user='user-a',method='GET',body,raw,headers={}}={}) {
  const h=new Headers(headers);
  if(body!==undefined)h.set('Content-Type','application/json');
  const request=new Request(`https://app.test/api/v2${path}`,{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:raw!==undefined?{body:raw}:{})});
  const response=await handlePlatformRequest(request,env,{resolveBxagiContext:authenticatedContext(user)});const result=response.headers.get('content-type')?.includes('application/json')?await response.json():new Uint8Array(await response.arrayBuffer());
  return {status:response.status,data:result,headers:response.headers};
}
async function project(env,user='user-a',title='纯棉衣服推广'){const r=await call(env,'/projects',{user,method:'POST',body:{title,productName:'纯棉衬衫',description:'上传产品素材制作投放广告',facts:['材质为纯棉'],userId:'spoofed-user',scene:'apparel'}});assert.equal(r.status,201);return r.data.project;}
async function asset(env,p,user='user-a'){const r=await call(env,`/projects/${p.id}/assets`,{user,method:'POST',raw:png,headers:{'Content-Type':'image/png','Content-Length':String(png.length),'X-Filename':encodeURIComponent('衬衫.png')}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function creative(env,p,source,user='user-a',metadata={}){const r=await call(env,`/projects/${p.id}/creatives`,{user,method:'POST',raw:png,headers:{'Content-Type':'image/png','Content-Length':String(png.length),'X-Filename':'creative.png','X-Creative-Metadata':encodeURIComponent(JSON.stringify({title:'产品素材',format:'square',sourceAssetIds:source?[source.id]:[],width:1,height:1,validation:'browser-metadata',...metadata}))}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.creative;}
async function campaign(env,p,c,extras={},user='user-a'){const r=await call(env,'/campaigns',{user,method:'POST',body:{projectId:p.id,creativeIds:[c.id],name:'测试投放',channel:'oceanengine',dailyBudget:100,totalBudget:1000,maxDailyBudget:200,targetRoi:1.5,...extras}});assert.equal(r.status,201,JSON.stringify(r.data));return r.data.campaign;}

test('authenticated tenant context is mandatory; health is read-only and body IDs cannot choose tenants',async()=>{
  const env=fixture();assert.equal((await call(env,'/bootstrap',{user:null})).status,401);assert.equal((await call(env,'/system/health',{user:null})).status,200);
  const p=await project(env);assert.equal(p.userId,'user-a');assert.equal(p.scene,'apparel');assert.equal(p.productionEmployeeId,'');
  assert.deepEqual((await call(env,'/bootstrap',{user:'spoofed-user'})).data.projects,[]);
  assert.equal((await call({},'/bootstrap',{user:null})).status,401);
});
test('projects, source assets, actual downloads, plans and exports are isolated between users',async()=>{
  const env=fixture(),p=await project(env);const uploaded=await asset(env,p);assert.equal(uploaded.job,null);assert.equal((await createPlatformRepository(env.DB).listJobs('user-a')).length,0,'upload alone must not dispatch employees');
  assert.ok(!JSON.stringify(uploaded.asset).includes('objectKey'));
  const own=await call(env,`/assets/${uploaded.asset.id}/content`);assert.equal(own.status,200);assert.deepEqual(own.data,png);
  const range=await call(env,`/assets/${uploaded.asset.id}/content`,{headers:{Range:'bytes=0-7'}});assert.equal(range.status,206);assert.deepEqual(range.data,png.slice(0,8));
  for(const path of [`/assets/${uploaded.asset.id}/content`,`/projects/${p.id}/export`])assert.equal((await call(env,path,{user:'user-b'})).status,404);
  for(const action of ['plan','assets','creatives'])assert.equal((await call(env,`/projects/${p.id}/${action}`,{user:'user-b',method:'POST',body:{}})).status,404);
  const plan=await call(env,`/projects/${p.id}/plan`,{method:'POST',body:{}});assert.equal(plan.status,200);assert.equal(plan.data.project.creativePlan.variants.length,3);assert.ok(plan.data.variants.every(v=>v.status==='draft'));
  const other=(await call(env,'/bootstrap',{user:'user-b'})).data;assert.deepEqual(other.assets,[]);assert.deepEqual(other.projects,[]);
  const repo=createPlatformRepository(env.DB);assert.equal(await repo.getProject('user-b',p.id),null);assert.equal(await repo.getAsset('user-b',uploaded.asset.id),null);
});
test('MIME bytes, empty files, upload limit, filenames and dimensions are validated',async()=>{
  const env=fixture(),p=await project(env);
  const fake=await call(env,`/projects/${p.id}/assets`,{method:'POST',raw:new TextEncoder().encode('not an image'),headers:{'Content-Type':'image/png'}});assert.equal(fake.status,415);assert.equal(env.BUCKET.values.size,0);
  const oversize=await call(env,`/projects/${p.id}/assets`,{method:'POST',raw:png,headers:{'Content-Type':'image/png','Content-Length':String(64*1024*1024+1)}});assert.equal(oversize.status,413);
  const wrong=await call(env,`/projects/${p.id}/creatives`,{method:'POST',raw:png,headers:{'Content-Type':'image/png','X-Creative-Metadata':encodeURIComponent(JSON.stringify({width:999,height:1}))}});assert.equal(wrong.status,400);assert.equal(env.BUCKET.values.size,0);
  const r=await call(env,`/projects/${p.id}/assets`,{method:'POST',raw:png,headers:{'Content-Type':'image/png','X-Filename':encodeURIComponent('../../衣服.png')}});assert.equal(r.status,201);assert.ok(!r.data.asset.filename.includes('/'));
});
test('creative bytes, review and referenced project assets cannot cross tenant boundaries',async()=>{
  const env=fixture(),p=await project(env),a=(await asset(env,p)).asset,c=await creative(env,p,a),other=await project(env,'user-b');
  assert.equal((await call(env,`/creatives/${c.id}/content`,{user:'user-b'})).status,404);
  assert.equal((await call(env,`/creatives/${c.id}/review`,{user:'user-b',method:'POST',body:{approved:true}})).status,404);
  assert.equal((await call(env,`/projects/${other.id}/creatives`,{user:'user-b',method:'POST',raw:png,headers:{'Content-Type':'image/png','X-Creative-Metadata':encodeURIComponent(JSON.stringify({sourceAssetIds:[a.id]}))}})).status,404);
  assert.equal((await call(env,'/campaigns',{user:'user-b',method:'POST',body:{projectId:other.id,creativeIds:[c.id],channel:'oceanengine',dailyBudget:100,totalBudget:1000}})).status,404);
  const own=await call(env,`/creatives/${c.id}/review`,{method:'POST',body:{approved:true}});assert.equal(own.data.creative.reviewedBy,'user-a');assert.equal(own.data.creative.status,'approved');
});

test('partial BXAGI artifacts remain downloadable but cannot create or launch an advertising plan',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),repo=createPlatformRepository(env.DB);
  const source=await repo.createJob('user-a',{projectId:p.id,employeeId:'bxagi:market:video',type:'bxagi_workflow',status:'awaiting_result',details:{kind:'production',resultCreativeIds:[c.id],delivery:{expectedCount:3}}});
  await repo.updateCreative('user-a',c.id,{metadata:{sourceJobId:source.id}});
  assert.equal((await call(env,`/creatives/${c.id}/content`)).status,200);
  const body={projectId:p.id,creativeIds:[c.id],channel:'oceanengine',dailyBudget:100,totalBudget:500};
  const draft=await call(env,'/campaigns',{method:'POST',body});assert.equal(draft.status,409);assert.equal(draft.data.error.code,'bxagi_delivery_incomplete');
  const existing=await repo.createCampaign('user-a',{...body,name:'existing partial draft',status:'draft',objective:'purchase',buyingEmployeeId:'',maxDailyBudget:100,targetRoi:1});
  const launch=await call(env,`/campaigns/${existing.id}/launch`,{method:'POST',body:{}});assert.equal(launch.status,409);assert.equal(launch.data.error.code,'bxagi_delivery_incomplete');
  assert.equal((await repo.getCreative('user-a',c.id)).status,'draft');assert.equal((await repo.getCampaign('user-a',existing.id)).status,'draft');
  assert.equal((await repo.listJobs('user-a')).filter(job=>job.details?.kind==='buying').length,0);
  await repo.updateJob('user-a',source.id,{status:'completed',details:{...source.details,delivery:{expectedCount:1}}});
  assert.equal((await call(env,'/campaigns',{method:'POST',body})).status,201);
});
test('encrypted credentials are durable, never returned in bootstrap/export/audit; owner connections only',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p);const response=await call(env,'/connections',{method:'POST',body:{channel:'oceanengine',accountId:'123456',label:'广告账户',accessToken:'SENSITIVE_FIXTURE_TOKEN',appSecret:'SENSITIVE_APP_SECRET',expiresAt:'2099-01-01T00:00:00Z'}});
  assert.equal(response.status,201);assert.ok(!JSON.stringify(response.data).includes('SENSITIVE'));const id=response.data.connection.id;
  const stored=await createPlatformRepository(env.DB).getConnection('user-a',id);assert.ok(stored.secretsCiphertext);assert.ok(!stored.secretsCiphertext.includes('SENSITIVE'));assert.equal(await createPlatformRepository(env.DB).getConnection('user-b',id),null);
  for(const path of ['/bootstrap','/connections','/audit',`/projects/${p.id}/export`]){const r=await call(env,path);assert.ok(!JSON.stringify(r.data).includes('SENSITIVE'));assert.ok(!JSON.stringify(r.data).includes('secretsCiphertext'));}
  const other=await project(env,'user-b'),oc=await creative(env,other,null,'user-b');const attack=await call(env,'/campaigns',{user:'user-b',method:'POST',body:{projectId:other.id,creativeIds:[oc.id],channel:'oceanengine',dailyBudget:100,totalBudget:1000,connectionId:id}});assert.equal(attack.status,404);
  const noKey={...env,APP_ENCRYPTION_KEY:undefined};assert.equal((await call(noKey,'/connections',{method:'POST',body:{channel:'oceanengine',accountId:'2',accessToken:'value'}})).status,503);
});
test('campaign budget caps enforced and secrets cannot hide in exported platform configuration',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p);const base={projectId:p.id,creativeIds:[c.id],channel:'oceanengine',dailyBudget:100,totalBudget:1000};
  for(const changes of [{maxDailyBudget:1001},{dailyBudget:201,maxDailyBudget:200},{dailyBudget:-1},{totalBudget:50},{platformConfig:{accessToken:'secret'}},{platformConfig:{nested:{appSecret:'secret'}}}])assert.equal((await call(env,'/campaigns',{method:'POST',body:{...base,...changes}})).status,400);
  const camp=await campaign(env,p,c);assert.match(camp.buyingEmployeeId,/apparel/);assert.equal(camp.status,'draft');assert.equal(camp.remoteId,null);
});
test('explicit launch approves own actual creatives and missing channel credentials blocks without fabricated IDs',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),camp=await campaign(env,p,c);
  const launch=await call(env,`/campaigns/${camp.id}/launch`,{method:'POST',body:{}});assert.equal(launch.status,200);assert.equal(launch.data.campaign.status,'blocked');assert.equal(launch.data.campaign.remoteId,null);assert.equal((await createPlatformRepository(env.DB).getCreative('user-a',c.id)).status,'approved');
  for(const action of ['launch','pause','sync','metrics'])assert.equal((await call(env,`/campaigns/${camp.id}/${action}`,{user:'user-b',method:'POST',body:{date:'2026-10-14',spend:1}})).status,404);
});
test('manual metrics are labeled, snapshot upserts preserve ID, unknown ROI holds and repeated snapshots avoid duplicate optimization',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),camp=await campaign(env,p,c);const path=`/campaigns/${camp.id}/metrics`;
  const unknown=await call(env,path,{method:'POST',body:{date:'2026-10-14',spend:60,revenue:1000,source:'oceanengine',hasConversion:false,dataFresh:true}});assert.equal(unknown.data.metric.source,'manual');assert.equal(unknown.data.metric.revenue,null);assert.equal(unknown.data.metric.roi,null);assert.equal(unknown.data.decision.action,'hold');
  const poor={date:'2026-10-14',spend:75,revenue:30,conversions:4,hasConversion:true,dataFresh:true};const first=await call(env,path,{method:'POST',body:poor}),second=await call(env,path,{method:'POST',body:poor});assert.equal(first.data.decision.action,'iterate');assert.equal(first.data.metric.id,unknown.data.metric.id);assert.equal(second.data.metric.id,first.data.metric.id);assert.ok(first.data.optimizationTask);assert.equal(second.data.optimizationTask,undefined);
  const boot=(await call(env,'/bootstrap')).data;assert.equal(boot.metrics.length,1);assert.equal(boot.metrics[0].spend,75);assert.equal(boot.optimizationTasks.length,1);
  const stale=await call(env,path,{method:'POST',body:{...poor,dataFresh:false}});assert.equal(stale.data.decision.action,'hold');
  const limit=await call(env,path,{method:'POST',body:{...poor,spend:100}});assert.equal(limit.data.decision.action,'pause');assert.equal(limit.data.decision.execution,'recommendation_only');
  const other=(await call(env,'/bootstrap',{user:'user-b'})).data;assert.deepEqual(other.metrics,[]);assert.deepEqual(other.optimizationTasks,[]);assert.deepEqual((await call(env,'/audit',{user:'user-b'})).data.audit,[]);
});
test('source upload stays unclassified; an explicitly requested local plan can use owner scene profiles',async()=>{
  const env=fixture();const profile=await call(env,'/employees',{method:'POST',body:{name:'宠物食品素材员工',role:'production',scene:'petfood',keywords:['猫粮','狗粮'],instructions:'使用真实营养信息',capabilities:['copy.variants','image.layout']}});assert.equal(profile.status,201);
  const created=await call(env,'/projects',{method:'POST',body:{title:'猫粮产品',facts:['净重1公斤']}});assert.equal(created.data.project.scene,'general');assert.equal(created.data.project.productionEmployeeId,'');
  const plan=await call(env,`/projects/${created.data.project.id}/plan`,{method:'POST',body:{}});assert.equal(plan.data.assignment.productionEmployeeId,profile.data.employee.id);
  const other=await call(env,'/projects',{user:'user-b',method:'POST',body:{title:'猫粮产品'}});assert.equal(other.data.project.scene,'general');
  assert.equal((await call(env,'/employees',{method:'POST',body:{name:'bad',role:'production',scene:'anything',capabilities:['shell.exec']}})).status,400);
  assert.ok((await call(env,'/bootstrap')).data.capabilities.capabilityCatalog.length);
});
test('launch and operation claiming is atomic and records remain owner scoped',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),camp=await campaign(env,p,c),repo=createPlatformRepository(env.DB);
  assert.equal(await repo.claimCampaignLaunch('user-b',camp.id,'attack'),null);const [first,second]=await Promise.all([repo.claimCampaignLaunch('user-a',camp.id,'a'),repo.claimCampaignLaunch('user-a',camp.id,'b')]);assert.equal([first,second].filter(Boolean).length,1);
  assert.ok(await repo.claimCampaignOperation('user-a',camp.id,'one'));assert.equal(await repo.claimCampaignOperation('user-a',camp.id,'two'),null);await repo.releaseCampaignOperation('user-b',camp.id,'one');assert.equal(await repo.claimCampaignOperation('user-a',camp.id,'two'),null);await repo.releaseCampaignOperation('user-a',camp.id,'one');assert.ok(await repo.claimCampaignOperation('user-a',camp.id,'two'));
});
test('first launch and budget editing exclude each other and only the exact owner lock can release an edit',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),camp=await campaign(env,p,c),repo=createPlatformRepository(env.DB);
  assert.ok(await repo.claimCampaignBudgetOperation('user-a',camp.id,'budget-edit'));
  assert.equal(await repo.claimCampaignLaunch('user-a',camp.id,'launch-during-edit'),null);
  await repo.releaseCampaignOperation('user-a',camp.id,'stale-edit');
  await repo.releaseCampaignOperation('user-b',camp.id,'budget-edit');
  assert.equal((await repo.getCampaign('user-a',camp.id)).operationId,'budget-edit');
  assert.equal(await repo.claimCampaignLaunch('user-a',camp.id,'launch-after-wrong-release'),null);
  await repo.updateCampaign('user-a',camp.id,{dailyBudget:50,totalBudget:250,maxDailyBudget:50});
  await repo.releaseCampaignOperation('user-a',camp.id,'budget-edit');
  const claimed=await repo.claimCampaignLaunch('user-a',camp.id,'launch-after-edit');assert.equal(claimed.dailyBudget,50);assert.equal(claimed.totalBudget,250);assert.equal(claimed.maxDailyBudget,50);
  assert.equal(await repo.claimCampaignBudgetOperation('user-a',camp.id,'edit-after-launch'),null);
  const edit=await call(env,`/campaigns/${camp.id}/budget`,{method:'POST',body:{dailyBudget:25,totalBudget:250,maxDailyBudget:50}});assert.equal(edit.status,409);assert.equal((await repo.getCampaign('user-a',camp.id)).dailyBudget,50);
});
test('first launch claim preserves pending or already created remote state instead of creating another project',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),repo=createPlatformRepository(env.DB);
  for(const remoteState of [{writePending:{stage:'project_create'}},{projectId:'verified-remote-project'}]){
    const camp=await campaign(env,p,c,{remoteState});await repo.updateCampaign('user-a',camp.id,{remoteState});
    assert.equal(await repo.claimCampaignLaunch('user-a',camp.id,'new-attempt'),null);assert.equal((await repo.getCampaign('user-a',camp.id)).status,'draft');
  }
});
test('worker tick requires a separate service secret even when an application user is signed in',async()=>{
  const env=fixture();assert.equal((await call(env,'/worker/tick',{method:'POST',body:{}})).status,401);assert.equal((await call({...env,APP_WORKER_SECRET:undefined},'/worker/tick',{method:'POST',body:{}})).status,503);
  const ok=await call(env,'/worker/tick',{user:null,method:'POST',body:{},headers:{Authorization:`Bearer ${env.APP_WORKER_SECRET}`}});assert.equal(ok.status,200);assert.equal(ok.data.processed,0);
});
test('HTTP upload and authorized streaming download round-trip actual bytes through the production handler',async()=>{
  const env=fixture();
  const server=createServer(async(incoming,outgoing)=>{
    try{
      const request=new Request(`http://${incoming.headers.host}${incoming.url}`,{method:incoming.method,headers:incoming.headers,...(['GET','HEAD'].includes(incoming.method)?{}:{body:Readable.toWeb(incoming),duplex:'half'})});
      const owner=/fixture-auth=([^;]+)/.exec(request.headers.get('Cookie')||'')?.[1]||null;
      const response=await handlePlatformRequest(request,env,{resolveBxagiContext:authenticatedContext(owner)});outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)Readable.fromWeb(response.body).pipe(outgoing);else outgoing.end();
    }catch{outgoing.writeHead(500);outgoing.end();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}/api/v2`;
  try{
    const created=await fetch(`${base}/projects`,{method:'POST',headers:{Cookie:'fixture-auth=http-owner','Content-Type':'application/json'},body:JSON.stringify({title:'游戏录屏广告',facts:['免费试玩']})});assert.equal(created.status,201);const p=(await created.json()).project;assert.equal(p.scene,'general');
    const uploaded=await fetch(`${base}/projects/${p.id}/assets`,{method:'POST',headers:{Cookie:'fixture-auth=http-owner','Content-Type':'image/png','X-Filename':encodeURIComponent('游戏.png')},body:png});assert.equal(uploaded.status,201);const a=(await uploaded.json()).asset;
    const download=await fetch(`${base}/assets/${a.id}/content`,{headers:{Cookie:'fixture-auth=http-owner'}});assert.equal(download.status,200);assert.deepEqual(new Uint8Array(await download.arrayBuffer()),png);
    const forbidden=await fetch(`${base}/assets/${a.id}/content`,{headers:{Cookie:'fixture-auth=another-owner'}});assert.equal(forbidden.status,404);
    assert.equal(env.DB.sqlite.prepare('SELECT count(*) n FROM assets WHERE userId = ?').get('http-owner').n,1);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
async function feedbackFixture(){const env=fixture(),p=await project(env),a=(await asset(env,p)).asset,c=await creative(env,p,a),camp=await campaign(env,p,c);const feedback=await call(env,`/campaigns/${camp.id}/metrics`,{method:'POST',body:{date:'2026-10-14',spend:75,revenue:30,conversions:4,hasConversion:true,dataFresh:true,impressions:3000,clicks:70}});assert.equal(feedback.data.decision.action,'iterate');return {env,p,a,c,camp,task:feedback.data.optimizationTask,metric:feedback.data.metric};}
test('verified feedback produces a new plan revision and only actual linked new creatives complete the task',async()=>{
  const {env,p,a,c,task,metric}=await feedbackFixture();
  const planned=await call(env,`/projects/${p.id}/plan`,{method:'POST',body:{optimizationTaskId:task.id}});assert.equal(planned.status,200,JSON.stringify(planned.data));assert.equal(planned.data.optimization.status,'experiment_ready');assert.equal(planned.data.optimization.metricId,metric.id);assert.equal(planned.data.revision,`${task.id}:r1`);assert.equal(planned.data.optimizationTask.status,'producing');assert.ok(planned.data.variants.every(v=>v.id.includes(task.id)));
  const completePath=`/optimization-tasks/${task.id}/complete`;
  assert.equal((await call(env,completePath,{method:'POST',body:{creativeIds:[c.id]}})).status,400);
  const generated=await creative(env,p,a,'user-a',{variantId:planned.data.variants[0].id});assert.equal(generated.metadata.optimizationTaskId,task.id);assert.equal(generated.metadata.planRevision,planned.data.revision);
  const completed=await call(env,completePath,{method:'POST',body:{creativeIds:[generated.id]}});assert.equal(completed.status,200,JSON.stringify(completed.data));assert.equal(completed.data.optimizationTask.status,'completed');assert.deepEqual(completed.data.optimizationTask.metadata.resultCreativeIds,[generated.id]);assert.equal(completed.data.optimizationTask.metadata.efficacyVerified,false);
  assert.equal((await call(env,completePath,{method:'POST',body:{creativeIds:[generated.id]}})).data.replayed,true);
});
test('feedback task, campaign, metric, completion and retry ownership are enforced',async()=>{
  const {env,p,a,task,camp}=await feedbackFixture(),repo=createPlatformRepository(env.DB),other=await project(env,'user-a','另一个衣服项目');
  assert.equal((await call(env,`/projects/${p.id}/plan`,{user:'user-b',method:'POST',body:{optimizationTaskId:task.id}})).status,404);
  assert.equal((await call(env,`/projects/${other.id}/plan`,{method:'POST',body:{optimizationTaskId:task.id}})).status,400);
  for(const action of ['complete','retry'])assert.equal((await call(env,`/optimization-tasks/${task.id}/${action}`,{user:'user-b',method:'POST',body:{creativeIds:[]}})).status,404);
  const bp=await project(env,'user-b'),bc=await creative(env,bp,null,'user-b'),bCamp=await campaign(env,bp,bc,{},'user-b');const bm=await repo.upsertMetrics('user-b',{campaignId:bCamp.id,date:'2026-10-14',source:'manual',spend:60,revenue:1,conversions:5,hasConversion:true,dataFresh:true,roi:1/60});
  const badTask=await repo.addOptimizationTask('user-a',{campaignId:camp.id,projectId:p.id,type:'creative_iteration',status:'pending',reason:'wrong metric',metadata:{metricId:bm.id}});
  assert.equal((await call(env,`/projects/${p.id}/plan`,{method:'POST',body:{optimizationTaskId:badTask.id}})).status,404);
  assert.equal((await repo.getOptimizationTask('user-a',badTask.id)).status,'pending');
});
test('feedback planning is claimed atomically and cannot overwrite an active project production revision',async()=>{
  const {env,p,task}=await feedbackFixture();const options={method:'POST',body:{optimizationTaskId:task.id}};const pair=await Promise.all([call(env,`/projects/${p.id}/plan`,options),call(env,`/projects/${p.id}/plan`,options)]);assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call(env,`/projects/${p.id}/plan`,{method:'POST',body:{}})).status,409);
  const stored=await createPlatformRepository(env.DB).getOptimizationTask('user-a',task.id);assert.equal(stored.metadata.iteration,1);
});
test('failed production can release only its current revision and retries reject old partial files',async()=>{
  const {env,p,a,task}=await feedbackFixture();const path=`/projects/${p.id}/plan`;const first=await call(env,path,{method:'POST',body:{optimizationTaskId:task.id}}),partial=await creative(env,p,a,'user-a',{variantId:first.data.variants[0].id});
  assert.equal((await call(env,`/optimization-tasks/${task.id}/retry`,{method:'POST',body:{planRevision:'wrong'}})).status,409);
  const retry=await call(env,`/optimization-tasks/${task.id}/retry`,{method:'POST',body:{planRevision:first.data.revision,reason:'浏览器导出失败'}});assert.equal(retry.status,200);assert.equal(retry.data.optimizationTask.status,'pending');
  const second=await call(env,path,{method:'POST',body:{optimizationTaskId:task.id}});assert.equal(second.data.revision,`${task.id}:r2`);assert.notEqual(second.data.variants[0].id,first.data.variants[0].id);
  assert.equal((await call(env,`/optimization-tasks/${task.id}/complete`,{method:'POST',body:{creativeIds:[partial.id]}})).status,400);
  const fresh=await creative(env,p,a,'user-a',{variantId:second.data.variants[0].id});assert.equal((await call(env,`/optimization-tasks/${task.id}/complete`,{method:'POST',body:{creativeIds:[fresh.id]}})).status,200);
});
test('unknown or stale conversions cannot be turned into performance conclusions by client supplied context',async()=>{
  const {env,p,camp}=await feedbackFixture(),repo=createPlatformRepository(env.DB);const metric=await repo.upsertMetrics('user-a',{campaignId:camp.id,date:'2026-10-15',source:'manual',spend:60,revenue:null,conversions:null,hasConversion:false,dataFresh:true,impressions:200,clicks:1,roi:null});
  const task=await repo.addOptimizationTask('user-a',{campaignId:camp.id,projectId:p.id,type:'creative_iteration',status:'pending',reason:'检查新数据',metadata:{metricId:metric.id}});
  const plan=await call(env,`/projects/${p.id}/plan`,{method:'POST',body:{optimizationTaskId:task.id,optimizationContext:{metricSnapshot:{revenue:100000,hasConversion:true,conversions:100}}}});assert.equal(plan.status,200);assert.equal(plan.data.optimization.status,'collect_data');assert.equal(plan.data.optimizationTask.status,'awaiting_data');assert.equal(plan.data.optimization.signal,null);assert.deepEqual(plan.data.optimization.signals,[]);
  assert.equal((await call(env,`/optimization-tasks/${task.id}/complete`,{method:'POST',body:{creativeIds:[]}})).status,409);
});
test('all active budgets are monitored and only expired read locks can be recovered',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),camp=await campaign(env,p,c,{autoOptimize:false}),repo=createPlatformRepository(env.DB);
  await repo.updateCampaign('user-a',camp.id,{status:'active'});assert.equal((await repo.listDueCampaigns()).length,1);
  await repo.claimCampaignOperation('user-a',camp.id,'old-read');env.DB.sqlite.prepare('UPDATE campaigns SET updatedAt = ? WHERE id = ?').run('2020-01-01T00:00:00Z',camp.id);assert.ok(await repo.claimCampaignOperation('user-a',camp.id,'new-read'));await repo.releaseCampaignOperation('user-a',camp.id,'new-read');
  await repo.updateCampaign('user-a',camp.id,{remoteState:{writePending:{stage:'provider_write'}}});await repo.claimCampaignOperation('user-a',camp.id,'uncertain-write');env.DB.sqlite.prepare('UPDATE campaigns SET updatedAt = ? WHERE id = ?').run('2020-01-01T00:00:00Z',camp.id);assert.equal(await repo.claimCampaignOperation('user-a',camp.id,'must-not-recover'),null);
});
test('budget edits require an idle inactive campaign, obey limits, preserve owner and unlock before return',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),camp=await campaign(env,p,c),repo=createPlatformRepository(env.DB),path=`/campaigns/${camp.id}/budget`;
  const values={dailyBudget:150,totalBudget:2000,maxDailyBudget:300,targetRoi:2};
  assert.equal((await call(env,path,{user:'user-b',method:'POST',body:values})).status,404);
  const edited=await call(env,path,{method:'POST',body:values});assert.equal(edited.status,200);assert.equal(edited.data.campaign.dailyBudget,150);assert.equal(edited.data.campaign.status,'draft');assert.equal((await repo.getCampaign('user-a',camp.id)).operationId,null);
  assert.equal((await call(env,path,{method:'POST',body:{...values,maxDailyBudget:1001}})).status,400);
  await repo.updateCampaign('user-a',camp.id,{status:'active'});assert.equal((await call(env,path,{method:'POST',body:values})).status,409);
  await repo.updateCampaign('user-a',camp.id,{status:'paused',remoteState:{writePending:{stage:'uncertain_write'}}});assert.equal((await call(env,path,{method:'POST',body:values})).status,409);
  await repo.updateCampaign('user-a',camp.id,{remoteState:{}});await repo.claimCampaignOperation('user-a',camp.id,'resume-lock');assert.equal((await call(env,path,{method:'POST',body:values})).status,409);await repo.releaseCampaignOperation('user-a',camp.id,'resume-lock');assert.equal((await call(env,path,{method:'POST',body:values})).status,200);
});
test('expired finishing jobs reconcile an actual stored creative or safely retry with orphan metadata',async()=>{
  const env=fixture(),p=await project(env),repo=createPlatformRepository(env.DB);
  const mp4=new Uint8Array(execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:size=16x16:rate=1','-t','1','-c:v','libx264','-threads','1','-f','mp4','-movflags','frag_keyframe+empty_moov','pipe:1']));
  const source=await call(env,`/projects/${p.id}/assets`,{method:'POST',raw:mp4,headers:{'Content-Type':'video/mp4','Content-Length':String(mp4.length)}});assert.equal(source.status,201);await repo.createJob('user-a',{projectId:p.id,assetId:source.data.asset.id,employeeId:p.productionEmployeeId,type:'video_optimize',status:'queued',details:{recipe:{format:'portrait',sourceAssetId:source.data.asset.id}}});const claimed=(await repo.claimWorkerJobs(1,['ffmpeg']))[0];assert.ok(await repo.claimWorkerCompletion(claimed.id,claimed.details.leaseId));
  const key='fixture/actual-completed.mp4';await env.BUCKET.put(key,new Blob([mp4]).stream(),{});const actual=await repo.createCreative('user-a',{projectId:p.id,filename:'actual.mp4',mimeType:'video/mp4',size:mp4.length,objectKey:key,title:'实际视频',format:'square',employeeId:p.productionEmployeeId,sourceAssetIds:[source.data.asset.id],validation:'worker-full-decode',width:16,height:16,duration:1,status:'draft',metadata:{sourceJobId:claimed.id,technicalChecks:{fullDecode:true},semanticValidated:false}});
  await repo.updateWorkerJob(claimed.id,{status:'finishing',details:{...claimed.details,completionObjectKey:key,leaseExpiresAt:'2020-01-01T00:00:00Z'}});assert.deepEqual(await repo.claimWorkerJobs(1,['ffmpeg']),[]);const recovered=await repo.getWorkerJob(claimed.id);assert.equal(recovered.status,'completed');assert.equal(recovered.details.resultCreativeId,actual.id);assert.ok(await env.BUCKET.get(key));assert.equal(await repo.getCreativeForWorkerJob('user-b',claimed.id),null);
  const orphan=await repo.createJob('user-a',{projectId:p.id,assetId:source.data.asset.id,employeeId:p.productionEmployeeId,type:'video_optimize',status:'queued',details:{recipe:{format:'portrait'}}});const lease=(await repo.claimWorkerJobs(1,['ffmpeg']))[0];assert.equal(lease.id,orphan.id);await repo.updateWorkerJob(orphan.id,{status:'finishing',details:{...lease.details,completionObjectKey:'fixture/orphan.mp4',leaseExpiresAt:'2020-01-01T00:00:00Z'}});const retry=(await repo.claimWorkerJobs(1,['ffmpeg']))[0];assert.equal(retry.details.attempts,2);assert.equal(retry.details.completionObjectKey,'fixture/orphan.mp4');assert.notEqual(retry.details.leaseId,lease.details.leaseId);
  await repo.updateWorkerJob(orphan.id,{status:'finishing',details:{...retry.details,attempts:3,leaseExpiresAt:'2020-01-01T00:00:00Z'}});assert.deepEqual(await repo.claimWorkerJobs(1,['ffmpeg']),[]);assert.equal((await repo.getWorkerJob(orphan.id)).status,'failed');
});
test('cross-site mutations fail closed while same-origin actions and separate service authentication remain usable',async()=>{
  const env=fixture();assert.equal((await call(env,'/projects',{method:'POST',body:{title:'外站请求'},headers:{Origin:'https://outside.test'}})).status,403);assert.equal((await call(env,'/projects',{method:'POST',body:{title:'外站请求'},headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await call(env,'/projects',{method:'POST',body:{title:'同站请求'},headers:{Origin:'https://app.test','Sec-Fetch-Site':'same-origin'}})).status,201);
  assert.equal((await call(env,'/worker/tick',{user:null,method:'POST',body:{},headers:{Origin:'https://service.test',Authorization:`Bearer ${env.APP_WORKER_SECRET}`}})).status,200);
});
test('fresh sufficient click evidence creates a CTR experiment while unknown revenue keeps ROI and budgets unchanged',async()=>{
  const env=fixture(),p=await project(env),c=await creative(env,p),camp=await campaign(env,p,c);const feedback=await call(env,`/campaigns/${camp.id}/metrics`,{method:'POST',body:{date:'2026-10-14',spend:60,hasConversion:false,dataFresh:true,impressions:2000,clicks:40}});assert.equal(feedback.data.metric.roi,null);assert.equal(feedback.data.decision.action,'iterate');assert.equal(feedback.data.decision.signal,'ctr');assert.ok(feedback.data.optimizationTask);assert.equal((await createPlatformRepository(env.DB).getCampaign('user-a',camp.id)).dailyBudget,100);
  const plan=await call(env,`/projects/${p.id}/plan`,{method:'POST',body:{optimizationTaskId:feedback.data.optimizationTask.id}});assert.equal(plan.status,200);assert.equal(plan.data.optimization.status,'experiment_ready');assert.ok(plan.data.optimization.signals.some(signal=>signal.type==='ctr'||signal.metric==='ctr'||signal.name==='ctr'||String(signal).includes('ctr'))||plan.data.optimization.signal?.type==='ctr'||plan.data.optimization.signal==='ctr');
});
