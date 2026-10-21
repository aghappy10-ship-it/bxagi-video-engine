import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAdsService,encryptConnectionSecrets,decryptConnectionSecrets,connectionSummary} from '../server/ads-service.mjs';
import {validateOceanEngineConfiguration,safePublicUrl} from '../server/adapters/oceanengine.mjs';
const KEY='a'.repeat(64), USER='tenant-a';
const REPORT_CONFIG={list:[{data_topic:'BASIC_DATA',dimensions:[{field:'project_id',filter_able:true,filter_config:{type:2,operator:7}}],metrics:['stat_cost','paid_value','converted','show_cnt','click_cnt'].map(field=>({field}))}]};
const PNG=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQf8AAAAASUVORK5CYII=','base64'));
function config(){return {budgetUnit:'yuan',project:{ad_type:'ALL',landing_type:'LINK',marketing_goal:'VIDEO_AND_IMAGE',delivery_range:{inventory_catalog:'MANUAL'},delivery_setting:{bid_type:'NO_BID',budget_mode:'BUDGET_MODE_DAY',pricing:'PRICING_CPC'}},promotion:{},report:{dimensions:['project_id'],metrics:['stat_cost','paid_value','converted'],filters:[],order_by:[],data_topic:'BASIC_DATA'},metricMapping:{projectId:'project_id',spend:'stat_cost',revenue:'paid_value',conversions:'converted'},landingUrl:'https://shop.example.com/item',titles:['上传素材中的真实商品']};}
async function fixture({autoOptimize=false,channel='oceanengine',fetcher}={}) {
 const campaign={id:'campaign-a',userId:USER,projectId:'project-a',creativeIds:['creative-a'],name:'实际商品测试',channel,dailyBudget:200,totalBudget:2000,maxDailyBudget:1000,targetRoi:1.5,autoOptimize,connectionId:'connection-a',platformConfig:config(),status:'draft',remoteState:{},remoteId:null};
 const connection={id:'connection-a',userId:USER,channel,accountId:'12345',expiresAt:new Date(Date.now()+3600000).toISOString(),secretsCiphertext:await encryptConnectionSecrets({accessToken:'SECRET_TOKEN'},KEY)};
 const creative={id:'creative-a',userId:USER,projectId:'project-a',status:'approved',reviewedAt:new Date().toISOString(),mimeType:'image/png',objectKey:'tenant-a/creative',filename:'actual.png',width:1,height:1,title:'真实素材'};
 const audits=[],metrics=[],tasks=[],queries=[];let operationId=null;
 const guard=(u,id,expected)=>{queries.push({u,id});return u===USER&&id===expected;};
 const repo={
  getCampaign:async(u,id)=>guard(u,id,campaign.id)?structuredClone(campaign):null,
  updateCampaign:async(u,id,p)=>{if(!guard(u,id,campaign.id))return null;Object.assign(campaign,structuredClone(p));return structuredClone(campaign);},
  getConnection:async(u,id)=>guard(u,id,connection.id)?connection:null,
  getProject:async(u,id)=>guard(u,id,'project-a')?{id,landingUrl:'https://shop.example.com/item'}:null,
  getCreative:async(u,id)=>guard(u,id,creative.id)?creative:null,
  listCreatives:async(u,ids)=>u===USER&&ids.includes(creative.id)?[creative]:[],
  claimCampaignLaunch:async(u,id,attemptId)=>{if(!guard(u,id,campaign.id)||!['draft','blocked'].includes(campaign.status)||operationId||campaign.remoteId||campaign.remoteState?.projectId||campaign.remoteState?.writePending)return null;campaign.status='launching';campaign.launchAttemptId=attemptId;return structuredClone(campaign);},
  claimCampaignOperation:async(u,id,op)=>{if(!guard(u,id,campaign.id)||operationId)return null;operationId=op;return structuredClone(campaign);},
  releaseCampaignOperation:async(u,id,op)=>{assert.equal(u,USER);assert.equal(id,campaign.id);if(operationId===op)operationId=null;},
  addAudit:async(u,row)=>{assert.equal(u,USER);audits.push(row);return row;},
  upsertMetrics:async(u,row)=>{assert.equal(u,USER);const index=metrics.findIndex(m=>m.date===row.date&&m.source===row.source);const metric={id:'metric-a',...row};if(index>=0)metrics[index]=metric;else metrics.push(metric);return metric;},
  addOptimizationTask:async(u,row)=>{assert.equal(u,USER);const t={id:'task-a',...row};tasks.push(t);return t;},
  listDueCampaigns:async()=>[structuredClone(campaign)]
 };
 const calls=[];let providerStatus='ENABLE',providerBudget=200;
 const readbackData=url=>url.includes('/project/list/')?{list:[{project_id:campaign.remoteState.projectId,advertiser_id:connection.accountId,opt_status:providerStatus,delivery_setting:{budget_mode:'BUDGET_MODE_DAY',budget:providerBudget}}]}:{list:(campaign.remoteState.promotionIds??[]).map(id=>({promotion_id:id,project_id:campaign.remoteState.projectId,advertiser_id:connection.accountId,opt_status:providerStatus}))};
 const recordWrite=(url,options)=>{if(url.includes('/status/update/'))providerStatus=JSON.parse(options.body).data[0].opt_status;if(url.includes('/budget/update/'))providerBudget=JSON.parse(options.body).data[0].budget;};
 const defaultFetch=async(url,options)=>{
  calls.push({url,options});recordWrite(url,options);const path=new URL(url).pathname;
  let data={errors:[]};
  if(path.includes('/project/list/')||path.includes('/promotion/list/'))data=readbackData(url);
  else if(path.includes('/report/custom/config/'))data=REPORT_CONFIG;
  else if(path.includes('/file/image/'))data={id:'image-real'};
  else if(path.includes('/project/create/'))data={project_id:901};
  else if(path.includes('/promotion/create/'))data={promotion_id:902};
  else if(path.includes('/report/custom/'))data={rows:[{dimensions:{project_id:'901'},metrics:{stat_cost:'150',paid_value:'600',converted:'5'}}],page_info:{total_page:1}};
  return Response.json({code:0,data,request_id:`request-${calls.length}`});
 };
 const finalFetch=fetcher?async(url,options)=>{calls.push({url,options});recordWrite(url,options);if(url.includes('/project/list/')||url.includes('/promotion/list/'))return Response.json({code:0,data:readbackData(url)});if(url.includes('/report/custom/config/'))return Response.json({code:0,data:REPORT_CONFIG});return fetcher(url,options,calls.length);}:defaultFetch;
 return {service:createAdsService({repository:repo,bucket:{get:async()=>({size:PNG.length,arrayBuffer:async()=>PNG.buffer})},env:{APP_ENCRYPTION_KEY:KEY},fetcher:finalFetch}),campaign,connection,creative,audits,metrics,tasks,calls,queries,repo};
}
test('AES-GCM encrypts credentials, authenticates envelope, never exports secrets',async()=>{
 const ciphertext=await encryptConnectionSecrets({accessToken:'secret-abc',refreshToken:'refresh'},KEY);assert.ok(!ciphertext.includes('secret-abc'));assert.equal((await decryptConnectionSecrets(ciphertext,KEY)).accessToken,'secret-abc');
 await assert.rejects(()=>decryptConnectionSecrets(ciphertext,'b'.repeat(64)),/解密失败/);
 await assert.rejects(()=>encryptConnectionSecrets({},''),/APP_ENCRYPTION_KEY/);
 const output=JSON.stringify(connectionSummary({id:'a',accessToken:'secret',secretsCiphertext:ciphertext,appSecret:'hidden',expiresAt:new Date(Date.now()+1e5).toISOString()}));assert.ok(!output.includes('secret'));assert.ok(!output.includes('hidden'));assert.ok(!output.includes('ciphertext'));
});
test('launch uploads actual PNG bytes, creates disabled project/promotion, then enables with official schemas',async()=>{
 const f=await fixture();const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'active');assert.equal(result.remoteId,'901');
 assert.equal(f.calls.length,8);const writes=f.calls.filter(c=>c.options.method!=='GET');assert.equal(writes[0].options.body.get('upload_type'),'UPLOAD_BY_FILE');assert.deepEqual(new Uint8Array(await writes[0].options.body.get('image_file').arrayBuffer()),PNG);assert.match(writes[0].options.body.get('image_signature'),/^[a-f0-9]{32}$/);
 const project=JSON.parse(writes[1].options.body);assert.equal(project.operation,'DISABLE');assert.equal(project.advertiser_id,12345);assert.equal(project.delivery_setting.budget,200);
 const promotion=JSON.parse(writes[2].options.body);assert.equal(promotion.operation,'DISABLE');assert.equal(promotion.project_id,901);assert.deepEqual(promotion.promotion_materials.image_material_list[0].images,[{image_id:'image-real'}]);
 assert.deepEqual(JSON.parse(writes[3].options.body).data,[{promotion_id:902,opt_status:'ENABLE'}]);assert.deepEqual(JSON.parse(writes[4].options.body).data,[{project_id:901,opt_status:'ENABLE'}]);
 assert.ok(f.calls.every(c=>new URL(c.url).origin==='https://api.oceanengine.com'&&c.options.headers['Access-Token']==='SECRET_TOKEN'));assert.ok(!JSON.stringify(f.audits).includes('SECRET_TOKEN'));
 await f.service.launch(USER,f.campaign);assert.equal(f.calls.length,8);
});
test('concurrent launches claim once and never create two remote projects',async()=>{
 const f=await fixture();const results=await Promise.allSettled([f.service.launch(USER,f.campaign),f.service.launch(USER,f.campaign)]);assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.calls.filter(c=>c.url.includes('/project/create/')).length,1);
});
test('first launch compiles the claimed budget, creative and channel configuration after a concurrent edit',async()=>{
 const f=await fixture(),claim=f.repo.claimCampaignLaunch;let materialReads=0;
 f.repo.listCreatives=async(u,ids)=>{materialReads++;assert.equal(u,USER);return ids.includes(f.creative.id)?[structuredClone(f.creative)]:[];};
 f.repo.claimCampaignLaunch=async(u,id,attemptId)=>{
  assert.equal(materialReads,0);assert.equal(f.calls.length,0);
  f.campaign.dailyBudget=75;f.campaign.totalBudget=300;f.campaign.maxDailyBudget=75;
  f.campaign.creativeIds=['creative-after-edit'];f.creative.id='creative-after-edit';f.creative.filename='after-edit.png';
  f.campaign.platformConfig.titles=['已确认的新素材标题'];f.campaign.platformConfig.landingUrl='https://shop.example.com/updated';
  return claim(u,id,attemptId);
 };
 const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'active');assert.equal(result.dailyBudget,75);
 const project=JSON.parse(f.calls.find(c=>c.url.includes('/project/create/')).options.body);assert.equal(project.delivery_setting.budget,75);
 const promotion=JSON.parse(f.calls.find(c=>c.url.includes('/promotion/create/')).options.body);assert.deepEqual(promotion.promotion_materials.title_material_list,[{title:'已确认的新素材标题'}]);assert.deepEqual(promotion.promotion_materials.external_url_material_list,['https://shop.example.com/updated']);
 assert.equal(f.calls.find(c=>c.url.includes('/file/image/')).options.body.get('image_file').name,'after-edit.png');
 assert.deepEqual(Object.keys(result.remoteState.uploads),['creative-after-edit']);assert.deepEqual(f.audits.find(a=>a.action==='ads.launched').details.creativeIds,['creative-after-edit']);
});
test('first launch cannot inspect or send channel data while another campaign operation owns the lock',async()=>{
 const f=await fixture();assert.ok(await f.repo.claimCampaignOperation(USER,f.campaign.id,'budget-edit'));let materialReads=0;
 f.repo.listCreatives=async()=>{materialReads++;return [f.creative];};
 await assert.rejects(()=>f.service.launch(USER,f.campaign),error=>error.code==='operation_in_progress');
 assert.equal(materialReads,0);assert.equal(f.calls.length,0);assert.equal(f.campaign.status,'draft');
});
test('tenant-scoped lookup rejects another owner even with supplied campaign object',async()=>{
 const f=await fixture();await assert.rejects(()=>f.service.launch('tenant-b',f.campaign),/不存在/);assert.equal(f.calls.length,0);
});
test('unsupported channel, expired token, template account override and unreviewed data block before remote calls',async()=>{
 for(const change of [f=>f.campaign.channel='tencent',f=>f.connection.expiresAt='2020-01-01',f=>f.campaign.platformConfig.project.advertiser_id=666,f=>f.creative.status='draft',f=>f.campaign.platformConfig.promotion.promotion_materials={video_material_list:[{video_id:'invented'}]},f=>f.campaign.platformConfig.budgetUnit='unknown']) {
  const f=await fixture();change(f);const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'blocked');assert.equal(f.calls.length,0);
 }
});
test('uncertain project write is persisted and never retried on launch',async()=>{
 const f=await fixture({fetcher:async(url)=>{if(url.includes('/file/'))return Response.json({code:0,data:{id:'real-image'}});throw new Error('connection reset after provider accepted');}});
 const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'needs_reconciliation');assert.equal(result.remoteState.writePending.stage,'project_create');assert.equal(f.calls.length,3);await assert.rejects(()=>f.service.launch(USER,f.campaign),/不会重复/);assert.equal(f.calls.length,3);
});
test('malformed successful remote response is uncertain, not an invented remote ID',async()=>{
 const f=await fixture({fetcher:async()=>Response.json({code:0,data:{}})});const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'needs_reconciliation');assert.equal(result.remoteId,null);assert.equal(f.calls.length,2);
});
test('sync stores actual snapshot without auto writes when autoOptimize is false',async()=>{
 const f=await fixture();await f.service.launch(USER,f.campaign);const base=f.calls.length;const result=await f.service.sync(USER,f.campaign);
 assert.equal(result.metric.spend,150);assert.equal(result.metric.roi,4);assert.equal(result.decision.action,'increase');assert.equal(result.campaign.dailyBudget,200);assert.equal(f.calls.length,base+3);assert.equal(f.tasks.length,0);
 await f.service.sync(USER,f.campaign);assert.equal(f.metrics.length,1);assert.equal(f.campaign.dailyBudget,200);
});
test('auto optimization uses exact remote metric, bounded update payload, and 24h cooldown',async()=>{
 const f=await fixture({autoOptimize:true});await f.service.launch(USER,f.campaign);const r=await f.service.sync(USER,f.campaign);assert.equal(r.campaign.dailyBudget,240);assert.equal(f.tasks.length,1);
 const update=f.calls.find(c=>c.url.includes('/budget/update/'));assert.deepEqual(JSON.parse(update.options.body),{advertiser_id:12345,data:[{project_id:901,budget_mode:'BUDGET_MODE_DAY',budget:240}]});
 await f.service.sync(USER,f.campaign);assert.equal(f.calls.filter(c=>c.url.includes('/budget/update/')).length,1);assert.equal(f.tasks.length,1);
});
test('missing revenue/conversion metrics retain unknown ROI and hold',async()=>{
 const f=await fixture({autoOptimize:true});await f.service.launch(USER,f.campaign);delete f.campaign.platformConfig.metricMapping.revenue;delete f.campaign.platformConfig.metricMapping.conversions;
 const r=await f.service.sync(USER,f.campaign);assert.equal(r.metric.revenue,null);assert.equal(r.metric.conversions,null);assert.equal(r.metric.roi,null);assert.equal(r.decision.action,'hold');assert.equal(f.tasks.length,0);
});
test('report rows from other remote projects cannot become current campaign spend',async()=>{
 const f=await fixture();await f.service.launch(USER,f.campaign);
 const service=createAdsService({repository:f.repo,bucket:{},env:{APP_ENCRYPTION_KEY:KEY},fetcher:async(url)=>Response.json({code:0,data:url.includes('/config/')?REPORT_CONFIG:{rows:[{dimensions:{project_id:'777'},metrics:{stat_cost:'500'}}],page_info:{total_page:1}}})});
 const r=await service.sync(USER,f.campaign);assert.equal(r.metric,null);assert.equal(r.decision.action,'hold');assert.equal(f.metrics.length,0);
});
test('landing pages reject local, insecure, credentials and IP addresses',()=>{
 for(const u of ['http://shop.example.com','https://localhost/x','https://127.0.0.1','https://192.168.0.1','https://[::1]','https://foo.local','https://user:pass@shop.example.com'])assert.throws(()=>safePublicUrl(u));assert.equal(safePublicUrl('https://shop.example.com/item'),'https://shop.example.com/item');
});
test('template JSON prototypes/credentials and unbounded reports are rejected',async()=>{
 const f=await fixture();f.campaign.platformConfig.project.audience=JSON.parse('{"__proto__":{}}');assert.throws(()=>validateOceanEngineConfiguration(f.campaign,f.connection));
 const g=await fixture();g.campaign.platformConfig.report.dimensions.push('advertiser_id');assert.throws(()=>validateOceanEngineConfiguration(g.campaign,g.connection),/单一/);
});
test('official int64 IDs are never rounded during request or response handling',async()=>{
 const f=await fixture({fetcher:async(url,options)=>{
  if(url.includes('/file/'))return Response.json({code:0,data:{id:'real-image'}});
  if(url.includes('/project/create/')) {assert.match(options.body,/"advertiser_id":9007199254740993[,}]/);return new Response('{"code":0,"data":{"project_id":9007199254740995}}',{headers:{'content-type':'application/json'}});}
  if(url.includes('/promotion/create/')) {assert.match(options.body,/"project_id":9007199254740995[,}]/);return new Response('{"code":0,"data":{"promotion_id":9007199254740997}}',{headers:{'content-type':'application/json'}});}
  if(url.includes('/promotion/status/'))assert.match(options.body,/"promotion_id":9007199254740997[,}]/);
  return Response.json({code:0,data:{errors:[]}});
 }});f.connection.accountId='9007199254740993';const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'active');assert.equal(result.remoteId,'9007199254740995');assert.equal(result.remoteState.promotionIds[0],'9007199254740997');
});
test('real total spend bound pauses rather than increasing beyond remaining budget',async()=>{
 const f=await fixture({autoOptimize:true});f.campaign.dailyBudget=100;f.campaign.totalBudget=150;await f.service.launch(USER,f.campaign);
 const r=await f.service.sync(USER,f.campaign);assert.equal(r.decision.action,'pause');assert.equal(r.campaign.status,'paused');assert.equal(f.calls.filter(c=>c.url.includes('/budget/update/')).length,0);
});
test('WebM and MP4 without an actual reviewed cover never make provider calls',async()=>{
 const f=await fixture();f.creative.mimeType='video/webm';let result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'blocked');assert.match(result.error,/转码/);assert.equal(f.calls.length,0);
 const g=await fixture();g.creative.mimeType='video/mp4';g.creative.duration=20;result=await g.service.launch(USER,g.campaign);assert.equal(result.status,'blocked');assert.match(result.error,/封面/);assert.equal(g.calls.length,0);
});
test('top-level success with batch item failure does not mark active or retry',async()=>{
 const f=await fixture({fetcher:async(url)=>{
  if(url.includes('/file/'))return Response.json({code:0,data:{id:'real-image'}});
  if(url.includes('/project/create/'))return Response.json({code:0,data:{project_id:901}});
  if(url.includes('/promotion/create/'))return Response.json({code:0,data:{promotion_id:902}});
  return Response.json({code:0,data:{errors:[{promotion_id:902,error_message:'account restricted'}],promotion_ids:[]},request_id:'partial-request'});
 }});const r=await f.service.launch(USER,f.campaign);assert.equal(r.status,'needs_reconciliation');assert.equal(r.remoteState.projectId,901);assert.equal(r.remoteState.requestId,'partial-request');assert.equal(f.calls.filter(c=>c.url.includes('/project/status/')).length,0);await assert.rejects(()=>f.service.launch(USER,f.campaign),/不会重复/);
});
test('response code0/null mutation data can be confirmed only through actual entity readback',async()=>{
 const f=await fixture({fetcher:async(url)=>{
  if(url.includes('/file/'))return Response.json({code:0,data:{id:'real-image'}});
  if(url.includes('/project/create/'))return Response.json({code:0,data:{project_id:901}});
  if(url.includes('/promotion/create/'))return Response.json({code:0,data:{promotion_id:902}});
  return Response.json({code:0,data:null});
 }});const r=await f.service.launch(USER,f.campaign);assert.equal(r.status,'active');assert.equal(f.calls.filter(c=>c.url.includes('/project/list/')||c.url.includes('/promotion/list/')).length,2);
});
test('resume refuses exhausted cumulative budget without any enable write',async()=>{
 const f=await fixture();f.campaign.dailyBudget=100;f.campaign.totalBudget=150;await f.service.launch(USER,f.campaign);await f.service.pause(USER,f.campaign);const start=f.calls.length;
 const resumed=await f.service.launch(USER,f.campaign);assert.equal(resumed.status,'paused');assert.match(resumed.error,/总预算/);assert.equal(f.calls.slice(start).filter(c=>c.options.method==='POST').length,0);assert.equal(f.audits.at(-1).action,'ads.resume_blocked');
});
test('resume reduces to actual remaining total budget and reads it back before enable',async()=>{
 const f=await fixture();f.campaign.totalBudget=200;await f.service.launch(USER,f.campaign);await f.service.pause(USER,f.campaign);const start=f.calls.length;
 const resumed=await f.service.launch(USER,f.campaign);assert.equal(resumed.status,'active');assert.equal(resumed.dailyBudget,50);
 const subsequent=f.calls.slice(start);const budgetIndex=subsequent.findIndex(c=>c.url.includes('/budget/update/'));const enableIndex=subsequent.findIndex(c=>c.url.includes('/status/update/'));assert.ok(budgetIndex>=0&&budgetIndex<enableIndex);assert.equal(JSON.parse(subsequent[budgetIndex].options.body).data[0].budget,50);assert.equal(subsequent[budgetIndex+1].options.method,'GET');assert.ok(resumed.remoteState.resumeBudgetProof.requestIds.length);
});
test('resume with unknown cumulative spend keeps paused and sends no mutations',async()=>{
 const f=await fixture({fetcher:async(url)=>{
  if(url.includes('/file/'))return Response.json({code:0,data:{id:'real-image'}});
  if(url.includes('/project/create/'))return Response.json({code:0,data:{project_id:901}});
  if(url.includes('/promotion/create/'))return Response.json({code:0,data:{promotion_id:902}});
  if(url.includes('/report/custom/get/'))return Response.json({code:0,data:{rows:[],page_info:{total_page:1}}});
  return Response.json({code:0,data:{errors:[]}});
 }});await f.service.launch(USER,f.campaign);await f.service.pause(USER,f.campaign);const start=f.calls.length;const resumed=await f.service.launch(USER,f.campaign);assert.equal(resumed.status,'paused');assert.equal(f.calls.slice(start).filter(c=>c.options.method==='POST').length,0);
});
test('worker enforces budget pause with ROI optimization disabled',async()=>{
 const f=await fixture();f.campaign.dailyBudget=100;f.campaign.totalBudget=150;await f.service.launch(USER,f.campaign);const result=await f.service.tick();assert.equal(result.processed,1);assert.equal(f.campaign.status,'paused');assert.equal(f.tasks.length,0);assert.ok(f.audits.some(a=>a.action==='ads.budget_guard_pause'));
});
test('remaining-budget discipline reduces actual budget independently of ROI toggle',async()=>{
 const f=await fixture();f.campaign.totalBudget=250;await f.service.launch(USER,f.campaign);const result=await f.service.sync(USER,f.campaign);assert.equal(result.campaign.dailyBudget,100);assert.equal(result.decision.action,'hold');assert.equal(f.tasks.length,0);assert.equal(JSON.parse(f.calls.find(c=>c.url.includes('/budget/update/')).options.body).data[0].budget,100);assert.ok(f.audits.some(a=>a.action==='ads.budget_guard_reduce'));
});
test('daily spend stops at daily ceiling despite high ROI and disabled optimization',async()=>{
 const f=await fixture();f.campaign.dailyBudget=100;await f.service.launch(USER,f.campaign);const result=await f.service.sync(USER,f.campaign);assert.equal(result.campaign.status,'paused');assert.match(result.decision.reason,/日预算/);assert.equal(f.calls.filter(c=>c.url.includes('/budget/update/')).length,0);
});
test('paused budget increase is applied to channel before explicit resume',async()=>{
 const f=await fixture();await f.service.launch(USER,f.campaign);await f.service.pause(USER,f.campaign);f.campaign.dailyBudget=300;const start=f.calls.length;const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'active');assert.equal(result.dailyBudget,300);
 const subsequent=f.calls.slice(start);const write=subsequent.find(c=>c.url.includes('/budget/update/'));assert.equal(JSON.parse(write.options.body).data[0].budget,300);assert.ok(subsequent.indexOf(write)<subsequent.findIndex(c=>c.url.includes('/status/update/')));assert.equal(f.audits.findLast(a=>a.action==='ads.resume_budget_set').details.requestedDailyBudget,300);
});
test('resume uses newly claimed budget instead of stale pre-lock campaign snapshot',async()=>{
 const f=await fixture();await f.service.launch(USER,f.campaign);await f.service.pause(USER,f.campaign);const claim=f.repo.claimCampaignOperation;f.repo.claimCampaignOperation=async(u,id,op)=>{f.campaign.dailyBudget=350;return claim(u,id,op);};const start=f.calls.length;
 const result=await f.service.launch(USER,f.campaign);assert.equal(result.dailyBudget,350);assert.equal(JSON.parse(f.calls.slice(start).find(c=>c.url.includes('/budget/update/')).options.body).data[0].budget,350);assert.equal(f.audits.findLast(a=>a.action==='ads.resume_budget_set').details.requestedDailyBudget,350);
});
test('resume observes an already resumed claimed row and avoids duplicate channel mutations',async()=>{
 const f=await fixture();await f.service.launch(USER,f.campaign);await f.service.pause(USER,f.campaign);const claim=f.repo.claimCampaignOperation;f.repo.claimCampaignOperation=async(u,id,op)=>{f.campaign.status='active';return claim(u,id,op);};const start=f.calls.length;
 const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'active');assert.equal(f.calls.length,start);
});
test('CTR-only real report creates a material experiment without ROI or budget claims',async()=>{
 const f=await fixture({autoOptimize:true,fetcher:async(url)=>{
  if(url.includes('/file/'))return Response.json({code:0,data:{id:'real-image'}});
  if(url.includes('/project/create/'))return Response.json({code:0,data:{project_id:901}});
  if(url.includes('/promotion/create/'))return Response.json({code:0,data:{promotion_id:902}});
  if(url.includes('/report/custom/get/'))return Response.json({code:0,data:{rows:[{dimensions:{project_id:'901'},metrics:{stat_cost:'50',show_cnt:'2000',click_cnt:'50'}}],page_info:{total_page:1}}});
  return Response.json({code:0,data:{errors:[]}});
 }});f.campaign.platformConfig.report.metrics=['stat_cost','show_cnt','click_cnt'];f.campaign.platformConfig.metricMapping={projectId:'project_id',spend:'stat_cost',impressions:'show_cnt',clicks:'click_cnt'};await f.service.launch(USER,f.campaign);const start=f.calls.length;
 const result=await f.service.sync(USER,f.campaign);assert.equal(result.decision.action,'hold');assert.equal(result.metric.roi,null);assert.equal(result.optimizationTask.metadata.signal,'ctr');assert.equal(result.campaign.dailyBudget,200);assert.equal(f.calls.slice(start).filter(c=>c.options.method==='POST').length,0);assert.match(result.optimizationTask.metadata.nextCreativeInstructions,/不得给出ROI/);
});

function grouped(f,{dailyBudget=300,totalBudget=3000}={}) {
 const group={id:'pack-delivery',userId:USER,projectId:'project-a',dailyBudget,totalBudget};
 const sibling={id:'sibling',userId:USER,projectId:'project-a',deliveryGroupId:group.id,creativeIds:['creative-b'],dailyBudget:100,totalBudget:1000,maxDailyBudget:300,status:'draft',remoteState:{}};
 f.campaign.deliveryGroupId=group.id;f.campaign.remoteState.deliveryUnit={initialDailyBudget:f.campaign.dailyBudget,round:1};let lock=null;
 f.repo.getDeliveryGroup=async(u,id)=>u===USER&&id===group.id?structuredClone(group):null;
 f.repo.listCampaigns=async(u)=>u===USER?[structuredClone(f.campaign),structuredClone(sibling)]:[];
 f.repo.claimDeliveryGroupOperation=async(u,id,op)=>{if(u!==USER||id!==group.id||lock)return null;lock=op;return structuredClone(group);};
 f.repo.releaseDeliveryGroupOperation=async(u,id,op)=>{assert.equal(u,USER);assert.equal(id,group.id);if(lock===op)lock=null;};
 const claim=f.repo.claimCampaignOperation;f.repo.claimCampaignOperation=async(...args)=>{assert.ok(lock,'group lock must precede campaign lock');return claim(...args);};
 return {group,sibling,get locked(){return !!lock;}};
}
test('grouped auto increase respects draft sibling reservations and preserves initial allocation',async()=>{
 const f=await fixture({autoOptimize:true});const g=grouped(f);await f.service.launch(USER,f.campaign);
 assert.equal(f.campaign.remoteState.deliveryUnit.initialDailyBudget,200);
 const result=await f.service.sync(USER,f.campaign);
 assert.equal(result.decision.action,'approval');assert.equal(result.campaign.dailyBudget,200);assert.equal(f.calls.filter(c=>c.url.includes('/budget/update/')).length,0);assert.equal(g.locked,false);
});
test('grouped auto increase records confirmed adjustment only within available group budget',async()=>{
 const f=await fixture({autoOptimize:true});const g=grouped(f,{dailyBudget:400});await f.service.launch(USER,f.campaign);
 const result=await f.service.sync(USER,f.campaign);assert.equal(result.campaign.dailyBudget,240);assert.equal(result.campaign.remoteState.lastBudgetAdjustment.direction,'increase');assert.equal(result.campaign.remoteState.lastBudgetAdjustment.actor,'employee');assert.equal(g.locked,false);
});
test('manual live budget updates enforce group cap before network and read back a valid reduction',async()=>{
 const f=await fixture();const g=grouped(f);await f.service.launch(USER,f.campaign);const before=f.calls.length;
 await assert.rejects(()=>f.service.adjustBudget(USER,f.campaign,{dailyBudget:250}),error=>error.code==='delivery_group_budget_exceeded');assert.equal(f.calls.length,before);
 const result=await f.service.adjustBudget(USER,f.campaign,{dailyBudget:180});assert.equal(result.campaign.status,'active');assert.equal(result.campaign.dailyBudget,180);assert.equal(result.campaign.remoteState.lastBudgetAdjustment.previousBudget,200);assert.equal(result.campaign.remoteState.lastBudgetAdjustment.direction,'decrease');assert.ok(result.readback);assert.equal(g.locked,false);
});
test('unknown sibling writes prevent grouped launch without changing any channel',async()=>{
 const f=await fixture();const g=grouped(f);g.sibling.status='needs_reconciliation';
 await assert.rejects(()=>f.service.launch(USER,f.campaign),error=>error.code==='delivery_group_reconciliation_required');assert.equal(f.calls.length,0);assert.equal(f.campaign.status,'draft');assert.equal(g.locked,false);
});
test('disabled channel account cannot launch even with a valid token',async()=>{
 const f=await fixture();f.connection.status='disabled';const result=await f.service.launch(USER,f.campaign);assert.equal(result.status,'blocked');assert.match(result.error,/停用/);assert.equal(f.calls.length,0);
});
test('uncertain manual budget write retains the old confirmed budget and blocks a repeat',async()=>{
 const f=await fixture({fetcher:async(url)=>{
  if(url.includes('/file/'))return Response.json({code:0,data:{id:'image-real'}});
  if(url.includes('/project/create/'))return Response.json({code:0,data:{project_id:901}});
  if(url.includes('/promotion/create/'))return Response.json({code:0,data:{promotion_id:902}});
  if(url.includes('/report/custom/get/'))return Response.json({code:0,data:{rows:[{dimensions:{project_id:'901'},metrics:{stat_cost:'50',paid_value:'200',converted:'2'}}],page_info:{total_page:1}}});
  if(url.includes('/budget/update/'))throw new Error('remote acknowledgement lost');
  return Response.json({code:0,data:{errors:[]}});
 }});const g=grouped(f);await f.service.launch(USER,f.campaign);const result=await f.service.adjustBudget(USER,f.campaign,{dailyBudget:180});
 assert.equal(result.campaign.status,'needs_reconciliation');assert.equal(result.campaign.dailyBudget,200);assert.equal(result.campaign.remoteState.writePending.stage,'manual_budget_update');assert.equal(g.locked,false);
 const writes=f.calls.filter(c=>c.url.includes('/budget/update/')).length;await assert.rejects(()=>f.service.adjustBudget(USER,f.campaign,{dailyBudget:180}));assert.equal(f.calls.filter(c=>c.url.includes('/budget/update/')).length,writes);
});
