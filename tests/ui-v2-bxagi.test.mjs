import test from 'node:test';
import assert from 'node:assert/strict';
import {remoteJobs,queuedJobNotice,remoteJobDescription,pendingRemoteJob,safeBxagiUrl} from '../components/platform/remote-jobs.mjs';

test('employee jobs exclude legacy local processing and deduplicate bootstrap aliases',()=>{
  const job={id:'remote-one',provider:'bxagi',status:'queued'};
  const result=remoteJobs({jobs:[{id:'legacy',type:'preprocess'},job],remoteJobs:[job],bxagi:{jobs:[{id:'remote-two',provider:'BXAGI'}]}});
  assert.deepEqual(result.map(row=>row.id),['remote-one','remote-two']);
});
test('queued or startup responses do not claim content produced or paid ads launched',()=>{
  assert.match(queuedJobNotice({provider:'bxagi',job:{id:'j',status:'queued'}},'投放任务').notice,/执行队列/);
  assert.doesNotMatch(queuedJobNotice({provider:'bxagi',job:{id:'j',status:'queued'}},'投放任务').notice,/已投放|已生成|已派发/);
  assert.match(remoteJobDescription({status:'queued'}),/等待准备素材/);
  assert.match(remoteJobDescription({status:'uploading'}),/尚未取得/);
  assert.match(remoteJobDescription({status:'needs_reconciliation'}),/不会重复派发/);
});
test('unverified local return and remote rejection stay explicit failures',()=>{
  assert.ok(queuedJobNotice({variants:[{title:'Local rules'}]}).error);
  assert.equal(queuedJobNotice({provider:'BXAGI',job:{status:'failed',error:{message:'员工不可用'}}}).error,'员工不可用');
  assert.equal(pendingRemoteJob({status:'awaiting_user_input'}),true);
  assert.equal(pendingRemoteJob({status:'completed'}),false);
});
test('remote task links only open verified BXAGI HTTPS origin',()=>{
  assert.equal(safeBxagiUrl('https://bxagi.xinlx.com/workforce'),'https://bxagi.xinlx.com/workforce');
  assert.equal(safeBxagiUrl('https://example.com/workforce'),null);
  assert.equal(safeBxagiUrl('javascript:alert(1)'),null);
});

import {pollableRemoteJob} from '../components/platform/remote-jobs.mjs';
test('automatic polling pauses for uncertain writes and human input',()=>{
  assert.equal(pollableRemoteJob({status:'needs_reconciliation'}),false);
  assert.equal(pollableRemoteJob({status:'awaiting_user_input'}),false);
  assert.equal(pollableRemoteJob({status:'awaiting_result'}),true);
});

import {remoteErrorMessage,bxagiUploadLimit} from '../components/platform/remote-jobs.mjs';
test('structured bootstrap errors render as safe text and retain provider explanation',()=>{
  assert.equal(remoteErrorMessage({code:'bxagi_unavailable',message:'员工目录暂不可用'}),'员工目录暂不可用');
  assert.equal(remoteErrorMessage('会话已失效'),'会话已失效');
  assert.equal(remoteErrorMessage({code:'unknown',secret:'never display this'}),'');
  assert.equal(remoteErrorMessage(null),'');
});
test('employee upload limit follows actual 16 MiB transfer capability',()=>{
  assert.equal(bxagiUploadLimit({bxagiTransferMaxBytes:16*1024*1024}),16777216);
  assert.equal(bxagiUploadLimit({}),16777216);
  assert.equal(bxagiUploadLimit({bxagiTransferMaxBytes:-1}),16777216);
});

import {isBxagiSessionRequired,normalizeSessionBootstrap,clearSessionData} from '../components/platform/auth-state.mjs';
test('missing or expired BXAGI sessions clear private rows instead of preserving prior workspace',()=>{
  const empty={user:{id:''},bxagi:{connected:false},projects:[],assets:[],creatives:[],campaigns:[],metrics:[],connections:[],employees:[],jobs:[],optimizationTasks:[],capabilities:{}};
  const stale={user:{id:'old-tenant'},bxagi:{connected:false},projects:[{id:'private-project'}],assets:[{id:'private-file'}]};
  const normalized=normalizeSessionBootstrap(stale,empty);
  assert.equal(normalized.authenticated,false);assert.equal(normalized.data,empty);assert.deepEqual(normalized.data.assets,[]);
  assert.equal(isBxagiSessionRequired({status:401,code:'bxagi_login_required'}),true);
  assert.equal(isBxagiSessionRequired({status:401,code:'bxagi_session_expired'}),true);
  assert.equal(isBxagiSessionRequired({status:401,code:'bxagi_login_rejected'}),false);
  assert.equal(clearSessionData(empty),empty);
});
test('workspace requires both BXAGI connection and verified tenant after login',()=>{
  const empty={user:{id:''},bxagi:{connected:false},projects:[],capabilities:{}};
  assert.equal(normalizeSessionBootstrap({bxagi:{connected:true},projects:[{id:'unscoped'}]},empty).authenticated,false);
  const payload={user:{id:'bx-tenant'},bxagi:{connected:true,profile:{displayName:'真实账号'}},projects:[{id:'owned'}]};
  const normalized=normalizeSessionBootstrap(payload,empty);
  assert.equal(normalized.authenticated,true);assert.equal(normalized.data.user.id,'bx-tenant');assert.deepEqual(normalized.data.projects,[{id:'owned'}]);
});


test('node connection failures are separate from employee activation failures',()=>{
  assert.match(remoteJobDescription({status:'awaiting_result',details:{recovery:{code:'bxagi_node_offline'},lastError:'员工未激活'}}),/连接恢复后继续原任务/);
  assert.equal(remoteJobDescription({status:'failed',details:{lastErrorCode:'bxagi_market_employee_activation_required',lastError:'员工未激活'}}),'员工未激活');
});
