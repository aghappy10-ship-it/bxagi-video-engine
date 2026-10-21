import { createPlatformRepository } from './platform-repository.mjs';
import { resolveBxagiContextForUser } from './bxagi-auth.mjs';
import { createBxagiOrchestrator } from './bxagi-orchestrator.mjs';

// Temporary, explicitly configured production-only test capability. It cannot
// select tenants, arbitrary jobs, credentials, URLs or advertising operations.
const MAX_WINDOW=30*60*1000,MAX_FILE=16*1024*1024;
const PURPOSE='fixed-production-flow-test';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function hash(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
const digest=value=>hash(new TextEncoder().encode(value));
async function guard(request,env){
  const expires=Date.parse(env.FLOW_TEST_EXPIRES_AT??''),remaining=expires-Date.now(),owner=env.FLOW_TEST_OWNER,secret=env.FLOW_TEST_SECRET;
  if(typeof secret!=='string'||secret.length<32||typeof owner!=='string'||!owner||owner.length>256||!Number.isFinite(expires)||remaining<=0||remaining>MAX_WINDOW)fail(503,'flow_test_unavailable','临时流程测试未配置或已到期');
  const authorization=request.headers.get('Authorization')||'';
  if(authorization.length>1024||!authorization.startsWith('Bearer ')||await digest(authorization.slice(7))!==await digest(secret))fail(401,'flow_test_unauthorized','临时流程测试认证失败');
  const origin=request.headers.get('Origin');
  if(request.headers.get('Sec-Fetch-Site')==='cross-site'||(origin&&origin!==new URL(request.url).origin))fail(403,'cross_site_request','请求来源不允许');
  return {owner,expiresAt:new Date(expires).toISOString()};
}
async function emptyBody(request){
  if(!request.body)return;
  const reader=request.body.getReader();let total=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>1024)fail(400,'flow_test_parameters_refused','测试入口不接受自定义参数');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  if(total===0)return;
  let body;try{body=JSON.parse(await new Blob(chunks).text());}catch{fail(400,'flow_test_parameters_refused','测试入口只接受空JSON对象');}
  if(!body||Array.isArray(body)||typeof body!=='object'||Object.keys(body).length)fail(400,'flow_test_parameters_refused','测试入口不接受自定义参数');
}
const stageOf=job=>['preparing','queued','starting','uploading','running','awaiting_result','awaiting_user_input','awaiting_user_confirmation','completed','failed','needs_reconciliation','verification_failed'].includes(job?.status)?job.status:'unknown';
const evidenceId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value)?value:null;
const staticErrors=new Set(['等待BXAGI员工实际交付清单与成品文件','BXAGI员工需要补充信息或确认，请在员工中心处理','BXAGI执行或成果保存暂未完成，请检查连接后同步任务','BXAGI创建或指令提交结果不明，请先在员工中心核对；系统不会重复提交']);

export async function handleFlowTestRequest(request,env,injected={}){
  let scopedRunId=null;
  try{
    const url=new URL(request.url),path=url.pathname.replace(/^\/api\/v2/,'');
    const start=path==='/worker/flow-test/start'&&request.method==='POST';
    const match=/^\/worker\/flow-test\/(flow-[a-f0-9]{32})\/(sync|status)$/.exec(path);
    if(!start&&(!match||(match[2]==='sync'?request.method!=='POST':request.method!=='GET')))fail(404,'not_found','测试接口不存在');
    const {owner,expiresAt}=await guard(request,env);
    if([...url.searchParams].length)fail(400,'flow_test_parameters_refused','测试入口不接受查询参数');
    if(request.method==='POST')await emptyBody(request);
    const resolveContext=injected.resolveContext??resolveBxagiContextForUser;
    const context=await resolveContext(owner,env,{fetcher:injected.fetcher,required:true});
    if(!context||context.userId!==owner||typeof context.subject!=='string'||!context.subject)fail(401,'flow_test_identity_invalid','测试账号会话未通过验证');
    const repo=injected.repository??createPlatformRepository(env.DB),bucket=injected.bucket??env.BUCKET;
    if(!bucket?.put||!bucket?.get)fail(503,'flow_test_storage_unavailable','测试存储暂不可用');
    const runId=`flow-${(await digest(`${owner}\0${expiresAt}`)).slice(0,32)}`;
    async function load(id){
      const run=await repo.getJob(owner,id);
      if(!run||run.id!==runId||run.type!=='platform_flow_test'||run.details?.purpose!==PURPOSE||run.details?.windowExpiresAt!==expiresAt)fail(404,'not_found','本次流程测试不存在');
      if(run.details.bxagiSubject!==context.subject)fail(409,'flow_test_account_changed','测试账号身份发生变化');
      scopedRunId=run.id;return run;
    }
    async function production(run){
      if(!run.details.productionJobId)return null;
      const job=await repo.getJob(owner,run.details.productionJobId);
      if(!job||job.projectId!==run.projectId||job.type!=='bxagi_workflow'||job.details?.kind!=='production'||job.details.bxagiSubject!==context.subject||job.details.flowTestRunId!==run.id||job.details.flowTestExpiresAt!==expiresAt||job.details.optimizationTaskId||!Array.isArray(run.details.inputAssetIds)||run.details.inputAssetIds.length!==1||!Array.isArray(job.details.assetIds)||job.details.assetIds.length!==run.details.inputAssetIds.length||job.details.assetIds.some(id=>!run.details.inputAssetIds.includes(id)))fail(409,'flow_test_job_mismatch','测试任务关联不一致');
      const project=await repo.getProject(owner,run.projectId);if(!project)fail(404,'not_found','测试项目不存在');
      for(const id of run.details.inputAssetIds){const asset=await repo.getAsset(owner,id);if(!asset||asset.projectId!==run.projectId||asset.metadata?.flowTestRunId!==run.id)fail(409,'flow_test_job_mismatch','测试输入关联不一致');}
      return job;
    }
    const orchestrator=run=>{
      const repository={...repo,createBxagiProductionJob:(u,payload)=>repo.createBxagiProductionJob(u,{...payload,details:{...payload.details,flowTestRunId:run.id,flowTestExpiresAt:expiresAt}})};
      const factory=injected.createOrchestrator??createBxagiOrchestrator;
      // Deliberately omit adsService: this service exposes production only.
      return factory({repository,bucket,env,context,fetcher:injected.fetcher});
    };
    async function summary(run){
      const job=await production(run),artifacts=[];
      const resultIds=job?.details?.resultCreativeIds??[];
      if(!Array.isArray(resultIds)||resultIds.length>20||new Set(resultIds).size!==resultIds.length)fail(422,'flow_test_artifact_invalid','测试成品数量或关联无效');
      for(const id of resultIds){
        const creative=await repo.getCreative(owner,id);
        if(!creative||creative.projectId!==run.projectId||creative.metadata?.sourceJobId!==job.id||!Array.isArray(creative.sourceAssetIds)||!creative.sourceAssetIds.length||creative.sourceAssetIds.some(source=>!run.details.inputAssetIds.includes(source))||!Number.isSafeInteger(creative.size)||creative.size<=0||creative.size>MAX_FILE)fail(422,'flow_test_artifact_invalid','测试成品关联或大小无效');
        const object=await bucket.get(creative.objectKey);if(!object||object.size!==creative.size)fail(422,'flow_test_artifact_invalid','测试成品实际文件尚未归档');
        const bytes=await object.arrayBuffer();if(bytes.byteLength!==creative.size)fail(422,'flow_test_artifact_invalid','测试成品实际文件大小不一致');
        artifacts.push({id:creative.id,mimeType:creative.mimeType,size:bytes.byteLength,sha256:await hash(bytes)});
      }
      const completed=job?.status==='completed'&&artifacts.length>0;
      if(job?.status==='completed'&&!completed)fail(422,'flow_test_artifact_invalid','员工任务声明完成但未找到真实成品');
      const details=job?.details??{},executionStatus=typeof details.executionStatus==='string'&&/^[A-Za-z_]{1,60}$/.test(details.executionStatus)?details.executionStatus:null;
      const evidence={employeeId:evidenceId(job?.employeeId),providerEmployeeId:evidenceId(details.employee?.providerId),startTaskId:evidenceId(details.startTaskId),conversationId:evidenceId(details.conversationId),uploadedAssetCount:Array.isArray(details.uploadedAssets)?Math.min(details.uploadedAssets.length,20):0,briefUploaded:details.briefUploaded===true,messageSentAt:Number.isFinite(Date.parse(details.messageSentAt))?new Date(details.messageSentAt).toISOString():null,executionStatus,lastError:staticErrors.has(details.lastError)?details.lastError:details.lastError?'员工任务尚未完成，请检查对应任务状态':null,errorCode:typeof run.details.errorCode==='string'&&/^[a-z_]{1,80}$/.test(run.details.errorCode)?run.details.errorCode:null};
      return {runId:run.id,projectId:run.projectId||null,productionJobId:job?.id??null,stage:stageOf(job??run),productionCompleted:completed,evidence,artifacts,paidAdvertisingPerformed:false,financialOperationsPerformed:false,checkedAt:new Date().toISOString()};
    }
    if(start){
      // One test per fixed owner and expiry window. The single SQL reservation
      // prevents concurrent refreshes from creating duplicate employee work.
      const now=new Date().toISOString(),details={purpose:PURPOSE,provider:'flow-test',windowExpiresAt:expiresAt,bxagiSubject:context.subject,inputAssetIds:[],productionJobId:null};
      const claim=await env.DB.prepare("INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details) VALUES (?,?,?,?,?,?,?,'preparing',?) ON CONFLICT(id) DO NOTHING").bind(runId,owner,now,now,'','flow-test','platform_flow_test',JSON.stringify(details)).run();
      let run=await load(runId);
      if(Number(claim.meta?.changes??claim.changes??0)===0)return response(await summary(run));
      try{
        const project=await repo.createProject(owner,{title:'BXAGI 全流程素材测试',productName:'流程测试素材',description:'非商品销售、非广告投放的测试项目。使用测试输入验证实际员工素材生产与成品归档。',facts:['这是用于验证平台流程的测试素材','不包含商品价格、优惠或效果承诺'],objective:'views',scene:'general',assignment:{provider:'bxagi',flowTestRunId:run.id}});
        run=await repo.updateJob(owner,run.id,{projectId:project.id,details:{...run.details,projectId:project.id}});
        const bytes=new TextEncoder().encode('BXAGI 平台流程测试\n这是用于验证平台流程的测试素材。\n请依据这些事实生成一份可用于核对流程的实际PNG测试海报和一份实际纯文本广告文案，注明“流程测试素材”。\n不得声称商品价格、优惠、订单或投放效果；不得投放、购买、雇佣或续费。\n');
        const objectKey=`tenants/${encodeURIComponent(owner)}/assets/${crypto.randomUUID()}`;
        await bucket.put(objectKey,bytes,{httpMetadata:{contentType:'text/plain'}});
        let asset;
        try{asset=await repo.createAsset(owner,{projectId:project.id,filename:'flow-test-source.txt',mimeType:'text/plain',size:bytes.length,role:'source',objectKey,status:'uploaded',metadata:{flowTestRunId:run.id,sha256:await hash(bytes)}});}catch(error){await bucket.delete?.(objectKey);throw error;}
        run=await repo.updateJob(owner,run.id,{assetId:asset.id,details:{...run.details,inputAssetIds:[asset.id],sourceSize:bytes.length}});
        if(Date.parse(expiresAt)<=Date.now())fail(503,'flow_test_unavailable','临时流程测试已到期');
        const outcome=await orchestrator(run).submitProduction(project);
        if(!outcome?.job?.id)fail(503,'flow_test_dispatch_incomplete','测试员工任务尚未创建');
        run=await repo.updateJob(owner,run.id,{status:'queued',details:{...run.details,productionJobId:outcome.job.id}});
        await repo.addAudit(owner,{action:'flow_test.production_queued',entityType:'job',entityId:run.id,details:{projectId:project.id,productionJobId:outcome.job.id,windowExpiresAt:expiresAt,paidAdvertising:false}});
        return response(await summary(run),201);
      }catch(error){await repo.updateJob(owner,run.id,{status:'failed',details:{...run.details,errorCode:typeof error.code==='string'?error.code:'flow_test_start_failed'}});throw error;}
    }
    let run=await load(match[1]),job=await production(run);
    if(match[2]==='sync'){
      if(!job)fail(409,'flow_test_not_ready','测试任务尚未准备完成');
      if(Date.parse(expiresAt)<=Date.now())fail(503,'flow_test_unavailable','临时流程测试已到期');
      await orchestrator(run).syncJob(job.id);
      job=await production(run);
      run=await repo.updateJob(owner,run.id,{status:stageOf(job),details:{...run.details,lastSyncedAt:new Date().toISOString()}});
    }
    const result=await summary(run);
    if(match[2]==='status'){
      // Read-only fresh catalog diagnostics never resume or dispatch a task.
      try{
        const employees=await orchestrator(run).catalog();
        if(!Array.isArray(employees))fail(502,'flow_test_catalog_invalid','员工目录格式无效');
        result.catalog={reachable:true,total:employees.length,usable:employees.filter(employee=>employee.usable===true).length,truncated:employees.length>20,employees:employees.slice(0,20).map(employee=>{
          const providerUsable=typeof employee.providerUsable==='boolean'?employee.providerUsable:null,conversationExists=typeof employee.providerConversationExists==='boolean'?employee.providerConversationExists:null,hasConversation=!!evidenceId(employee.conversationId),subscriptionExpired=typeof employee.subscriptionExpired==='boolean'?employee.subscriptionExpired:null;
          const availabilityReason=employee.usable===true?'available':subscriptionExpired===true?'expired':providerUsable===null?'usable_missing':providerUsable===false?'provider_unusable':conversationExists===false?'conversation_unavailable':!hasConversation?'conversation_missing':'unknown';
          return {id:evidenceId(employee.id),usable:employee.usable===true,providerUsable,hasConversation,conversationExists,subscriptionExpired,availabilityReason};
        })};
      }catch{result.catalog={reachable:false,total:null,usable:null,employees:[],error:{code:'flow_test_catalog_unavailable',message:'实际员工目录暂不可读，未派发任务'}};}
    }
    return response(result);
  }catch(error){
    const status=Number(error?.status)||503,known=typeof error?.code==='string'&&/^(flow_test_|bxagi_|cross_site_request$|not_found$)/.test(error.code);
    return response({...(scopedRunId?{runId:scopedRunId}:{}),error:{code:known?error.code:'flow_test_unavailable',message:status<500&&known?error.message:'临时流程测试暂不可用，请检查限时配置与BXAGI会话'}},status);
  }
}
