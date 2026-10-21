import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticFlowLabel,automaticFlowReason,automaticFlowNeedsUser,automaticAdvanceDelay,completedFlowFiles,projectReadyCreatives,archivedFlowFiles,creativeDeliveryState,backgroundSchedulerState} from '../components/platform/automation.mjs';

test('durable waiting state identifies budget authorization without pretending ad execution',()=>{
  const flow={status:'waiting',waiting:{code:'awaiting_explicit_launch',message:'预算草稿已保存，等待明确启动投放。',stage:'budget',requiresUser:true}};
  assert.equal(automaticFlowLabel(flow),'等待预算授权');assert.equal(automaticFlowNeedsUser(flow),true);
  assert.match(automaticFlowReason(flow),/等待明确启动/);
  assert.equal(automaticAdvanceDelay({automationFlows:[flow]}),60000);
});
test('owner automatic flow advances active work quickly while preserving explicit human waits',()=>{
  assert.equal(automaticAdvanceDelay({automationFlows:[{enabled:true,status:'producing',waiting:{requiresUser:false}}]}),15000);
  assert.equal(automaticAdvanceDelay({automationFlows:[{enabled:true,status:'waiting',waiting:{code:'remote_write_uncertain',requiresUser:true}}]}),60000);
  assert.equal(automaticAdvanceDelay({automationFlows:[{enabled:false,status:'producing'}]}),60000);
});
test('partial archived artifacts never become selectable ad creatives or count as complete production',()=>{
  const data={jobs:[{id:'incomplete',status:'awaiting_result',details:{resultCreativeIds:['part']}},{id:'done',status:'completed',details:{resultCreativeIds:['actual']}}],creatives:[{id:'part',projectId:'p',size:100,mimeType:'image/png',metadata:{sourceJobId:'incomplete'}},{id:'actual',projectId:'p',size:100,mimeType:'image/png',metadata:{sourceJobId:'done'}},{id:'other',projectId:'other-p',size:100,mimeType:'image/png',metadata:{sourceJobId:'done'}},{id:'manual',projectId:'p',size:80,mimeType:'image/png',validation:'browser-metadata'}]};
  assert.deepEqual(projectReadyCreatives('p',data).map(row=>row.id),['actual','manual']);
  assert.deepEqual(completedFlowFiles({projectId:'p'},data),[]);
  assert.deepEqual(completedFlowFiles({projectId:'p',lastCompletedProductionJobId:'done'},data).map(row=>row.id),['actual']);
});
test('uncertain remote state exposes actual reason instead of automatically claiming success',()=>{
  const flow={status:'waiting',waiting:{code:'remote_write_uncertain',message:'远端写入结果不明，等待核对，系统不会重复派发。',requiresUser:true}};
  assert.equal(automaticFlowLabel(flow),'需要你处理');assert.match(automaticFlowReason(flow),/不会重复派发/);
});
test('a repaired job counts only its current completed result IDs and excludes rejected historical files',()=>{
  const flow={projectId:'p',lastCompletedProductionJobId:'same-job'},job={id:'same-job',type:'bxagi_workflow',status:'completed',details:{resultCreativeIds:['poster-v2','rejected-current']}};
  const row=(id,status='draft')=>({id,projectId:'p',size:100,mimeType:'image/png',status,metadata:{sourceJobId:'same-job'}});
  const data={jobs:[job],creatives:[row('poster-v1','rejected'),row('old-description'),row('poster-v2'),row('rejected-current','rejected')]};
  assert.deepEqual(completedFlowFiles(flow,data).map(file=>file.id),['poster-v2']);
  assert.deepEqual(projectReadyCreatives('p',data).map(file=>file.id),['poster-v2']);
  job.status='running';assert.deepEqual(completedFlowFiles(flow,data),[]);assert.deepEqual(projectReadyCreatives('p',data),[]);
  job.status='completed';job.details.resultCreativeIds=[];assert.deepEqual(completedFlowFiles(flow,data),[]);
  delete job.details.resultCreativeIds;assert.deepEqual(completedFlowFiles(flow,data),[]);
});
test('completed local legacy jobs retain archived files without reviving missing or active jobs',()=>{
  const flow={projectId:'p',lastCompletedProductionJobId:'legacy'},data={jobs:[{id:'legacy',type:'video_optimize',status:'complete',details:{}}],creatives:[{id:'legacy-file',projectId:'p',metadata:{sourceJobId:'legacy'}},{id:'legacy-rejected',projectId:'p',reviewStatus:'rejected',metadata:{sourceJobId:'legacy'}}]};
  assert.deepEqual(completedFlowFiles(flow,data).map(file=>file.id),['legacy-file']);
  data.jobs=[];assert.deepEqual(completedFlowFiles(flow,data),[]);
});


test('partial media is visible and downloadable without entering campaign selection',()=>{
  const flow={projectId:'p',productionJobId:'j'};
  const job={id:'j',status:'awaiting_result',details:{resultCreativeIds:['video','cover'],delivery:{expected:[{filename:'video.mp4',mimeType:'video/mp4'},{filename:'cover.png',mimeType:'image/png'},{filename:'notes.txt',mimeType:'text/plain'}]}}};
  const file=(id,filename,mimeType)=>({id,filename,mimeType,projectId:'p',size:100,mimeType:'image/png',metadata:{sourceJobId:'j'}});
  const data={jobs:[job],creatives:[file('video','video.mp4','video/mp4'),file('cover','cover.png','image/png'),file('old','old.mp4','video/mp4')]};
  assert.deepEqual(archivedFlowFiles(flow,data).map(file=>file.id),['video','cover']);
  assert.deepEqual(projectReadyCreatives('p',data),[]);
  assert.equal(creativeDeliveryState(data.creatives[0],data).label,'部分交付 · 说明待回收');
  delete job.details.delivery;
  assert.equal(creativeDeliveryState(data.creatives[0],data).label,'部分交付 · 其余文件待回收');
  assert.equal(creativeDeliveryState(data.creatives[2],data).status,'validating');
  job.status='completed';
  assert.equal(creativeDeliveryState(data.creatives[0],data).status,'saved');
  assert.deepEqual(projectReadyCreatives('p',data).map(file=>file.id),['video']);
  data.creatives[0].reviewStatus='rejected';
  assert.deepEqual(projectReadyCreatives('p',data).map(file=>file.id),[]);
});

test('background scheduling requires configuration, runtime status and a recent successful tick',()=>{
  const now=Date.parse('2026-10-15T02:00:00Z');
  const capabilities={backgroundScheduling:true,backgroundSchedulingConfigured:true,backgroundScheduler:{status:'running',lastSuccessfulTickAt:'2026-10-15T01:59:00Z',staleAfterMs:180000}};
  assert.equal(backgroundSchedulerState(capabilities,now).running,true);
  assert.equal(automaticAdvanceDelay({capabilities},now),30000);
  for(const changed of [{backgroundScheduling:false},{backgroundSchedulingConfigured:false},{backgroundScheduler:{...capabilities.backgroundScheduler,lastSuccessfulTickAt:'2026-10-15T01:50:00Z'}},{backgroundScheduler:{...capabilities.backgroundScheduler,status:'error'}},{backgroundScheduler:{status:'running'}}])assert.equal(backgroundSchedulerState({...capabilities,...changed},now).running,false);
  assert.equal(backgroundSchedulerState({},now).label,'后台执行器未连接');
  assert.equal(backgroundSchedulerState({backgroundSchedulingConfigured:true},now).label,'后台已配置 · 等待首次心跳');
});

test('node recovery remains automatic and backs off to the saved retry time',()=>{
  const now=Date.parse('2026-10-15T02:00:00Z');
  for(const code of ['node_offline','gateway_disconnected','runtime_unavailable']){
    const flow={status:'waiting',waiting:{code,requiresUser:false},nextActionAt:'2026-10-15T02:00:45Z'};
    assert.equal(automaticFlowLabel(flow),'等待执行节点恢复');
    assert.equal(automaticFlowNeedsUser(flow),false);
    assert.equal(automaticAdvanceDelay({automationFlows:[flow]},now),45000);
  }
  assert.equal(automaticFlowLabel({status:'waiting',waiting:{code:'bxagi_market_employee_activation_required',requiresUser:true}}),'需要你处理');
});
