import { resolveBxagiContextForUser } from './bxagi-auth.mjs';
import { createBxagiOrchestrator,isCollectableBxagiProductionJob,isAutomaticallyRecoverableBxagiProductionJob } from './bxagi-orchestrator.mjs';

import { BXAGI_AVAILABILITY_CODES,nextBxagiRecovery,bxagiRecoveryDue,hasUncertainBxagiWrite } from './bxagi-recovery.mjs';

const ACTIVE=new Set(['queued','starting','uploading','running','awaiting_result']);
const HUMAN_WAIT=new Set(['awaiting_user_input','awaiting_user_confirmation']);
const MAX_FILE=16*1024*1024;
const ownerOf=context=>context?.userId||context?.nativeUserId;
const hasMarketProof=employee=>employee?.provider==='bxagi'&&['marketplace_template','installed_employee'].includes(employee.resourceType)&&typeof employee.marketId==='string'&&employee.marketId.trim().length>0&&employee.marketVerified===true;
const isMarketInstallation=employee=>hasMarketProof(employee)&&employee.resourceType==='installed_employee'&&employee.activationState==='ready'&&employee.sourceVerified===true&&employee.usable===true;
const marketWaitCode=employee=>hasMarketProof(employee)?'waiting_employee_activation':'historical_task_only';
const fail=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const timeAfter=seconds=>new Date(Date.now()+seconds*1000).toISOString();
const waits={
  production_start_required:'本批素材已保存，等待完成上传并明确开始优化。',partial_delivery:'本批主成品未全部交付，已有文件可预览；请检查后补充生产。',
  node_offline:'BXAGI执行节点暂时离线，系统会等待连接恢复后继续原任务。',gateway_disconnected:'BXAGI节点网关断连，系统会退避检查并继续原任务。',runtime_unavailable:'BXAGI员工运行时暂不可用，系统会等待恢复后继续原任务。',
  delivery_missing:'员工任务已结束，但交付文件缺失；请检查交付后重新回收，系统不会重复派发。',test_collection_complete:'限时测试的真实成品已回收归档，测试流程已停止。',
  login_required:'BXAGI会话需要重新登录，登录后流程会继续。',employee_missing:'账号暂无可用的市场员工，请检查员工市场。',employee_unavailable:'市场员工暂不可执行，请检查激活状态与权限。',waiting_market_employee:'等待匹配BXAGI员工市场中的岗位，历史会话不能替代市场员工。',waiting_employee_activation:'已匹配的市场员工尚未激活，请查看官方激活条件；系统不会自动购买或续费。',market_activation_pending:'正在启用已匹配的免费市场员工，核实执行资源后会继续生产。',historical_task_only:'该任务来自历史会话或缺少市场岗位证明，仅保留历史记录，不会作为市场员工继续执行。',source_missing:'等待上传真实原始素材。',source_too_large:'请将素材拆分为最多20份，每份不超过16MiB。',remote_starting:'正在准备已激活市场员工的独立执行会话。',remote_processing:'市场员工正在处理素材，系统会继续回收实际文件。',remote_user_input:'员工需要补充信息或确认，请在BXAGI对应任务中处理。',remote_write_uncertain:'远端写入结果不明，等待核对，系统不会重复派发。',production_failed:'素材生产未完成，请检查已有任务原因。',artifact_missing:'员工任务尚无有效的实际归档成品。',awaiting_budget:'真实成品已归档，请设置投放预算。',awaiting_explicit_launch:'预算草稿已保存，等待明确启动投放。',awaiting_channel_connection:'投放账号或渠道权限尚未满足要求。',awaiting_real_metrics:'等待真实投放报表，未知转化不会推断ROI。',insufficient_evidence:'现有真实反馈不足以提出下一轮素材实验。',service_unavailable:'远端服务暂不可用，系统会退避后重试。',account_changed:'该流程与当前已验证BXAGI账号不一致。',test_project_excluded:'限时测试项目由独立测试流程管理。',operation_busy:'另一请求正在推进该流程。',budget_monitoring:'正在监测已有投放预算和真实反馈。',buying_failed:'投放员工任务尚未完成，请检查已有任务。',campaign_changed:'预算或投放素材已变化，需要重新明确启动。',automation_unavailable:'自动流程存储或执行器尚未配置。'
};
function waiting(code,{requiresUser=false,retrySeconds=15,stage='production'}={}){return {code,message:waits[code]||waits.service_unavailable,stage,requiresUser,retryAt:timeAfter(retrySeconds)};}
function jobWait(job,kind='production'){
  if(hasUncertainBxagiWrite(job))return waiting('remote_write_uncertain',{requiresUser:true,retrySeconds:300,stage:kind});
  if(HUMAN_WAIT.has(job.status))return waiting('remote_user_input',{requiresUser:true,retrySeconds:60,stage:kind});
  const status=job.details?.lastErrorStatus,code=job.details?.lastErrorCode;
  if(status===401)return waiting('login_required',{requiresUser:true,retrySeconds:120,stage:kind});
  if(status===403)return waiting(kind==='buying'?'awaiting_channel_connection':'employee_unavailable',{requiresUser:true,retrySeconds:300,stage:kind});
  if(code==='bxagi_campaign_changed')return waiting('campaign_changed',{requiresUser:true,retrySeconds:300,stage:kind});
  if(code==='bxagi_delivery_missing')return waiting('delivery_missing',{requiresUser:true,retrySeconds:300,stage:kind});
  if(job.details?.recovery&&bxagiRecoveryDue(job)===false){const recovery=job.details.recovery,code=recovery.code==='bxagi_node_offline'?'node_offline':recovery.code==='bxagi_gateway_disconnected'?'gateway_disconnected':recovery.code==='bxagi_runtime_unavailable'?'runtime_unavailable':'service_unavailable';return {...waiting(code,{stage:kind}),retryAt:recovery.nextRetryAt};}
  if(job.status==='partial')return waiting('partial_delivery',{requiresUser:true,retrySeconds:300,stage:kind});
  if(job.status==='failed')return waiting(kind==='buying'?'buying_failed':'production_failed',{requiresUser:true,retrySeconds:300,stage:kind});
  if(typeof status==='number'&&status>=500)return waiting('service_unavailable',{retrySeconds:120,stage:kind});
  return waiting(['queued','starting','uploading'].includes(job.status)?'remote_starting':'remote_processing',{retrySeconds:15,stage:kind});
}
const inputOf=project=>({title:project.title,productName:project.productName,description:project.description,facts:project.facts||[],objective:project.objective,audience:project.audience,landingUrl:project.landingUrl});
const probeExpired=(assets,userId,env)=>assets.some(asset=>Object.hasOwn(asset.metadata||{},'automationProbeExpiresAt')&&(env.AUTOMATION_PROBE_OWNER!==userId||env.AUTOMATION_PROBE_EXPIRES_AT!==asset.metadata.automationProbeExpiresAt||!Number.isFinite(Date.parse(asset.metadata.automationProbeExpiresAt))||Date.parse(asset.metadata.automationProbeExpiresAt)<=Date.now()));
async function signature(project,assets){const bytes=new TextEncoder().encode(JSON.stringify({input:inputOf(project),assets:assets.map(a=>({id:a.id,size:a.size,mimeType:a.mimeType,role:a.role||'source'})).sort((a,b)=>a.id.localeCompare(b.id))}));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');}
async function actualCreativeRecords(repo,bucket,userId,projectId,job){
  const ids=job.details?.resultCreativeIds;
  if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length)return false;
  for(const id of ids){const row=await repo.getCreative(userId,id);if(!row||row.projectId!==projectId||row.metadata?.sourceJobId!==job.id||!Array.isArray(row.sourceAssetIds)||!row.sourceAssetIds.length||row.sourceAssetIds.some(source=>!job.details.assetIds?.includes(source))||!Number.isSafeInteger(row.size)||row.size<=0||row.size>MAX_FILE)return false;const object=await bucket.get(row.objectKey);if(!object||object.size!==row.size)return false;await object.body?.cancel?.().catch(()=>{});}
  return true;
}

/** Public summary contains operational state, never session or runtime fields. */
export function describeAutomaticFlow(flow){
  const details=flow?.details||{},code=Object.hasOwn(waits,details.waiting?.code)?details.waiting.code:null;
  const metricCode=Object.hasOwn(waits,details.metricsWaiting?.code)?details.metricsWaiting.code:null;
  return {id:flow.id,projectId:flow.projectId,status:flow.status,enabled:details.enabled===true,productionJobId:details.productionJobId||null,lastCompletedProductionJobId:details.lastCompletedProductionJobId||null,buyingJobId:details.buyingJobId||null,optimizationTaskId:details.optimizationTaskId||null,nextActionAt:details.nextActionAt||null,lastTickAt:details.lastTickAt||null,lastMetricSyncAt:details.lastMetricSyncAt||null,metricsWaiting:metricCode?{code:metricCode,message:waits[metricCode],requiresUser:details.metricsWaiting.requiresUser===true,retryAt:details.metricsWaiting.retryAt||null}:null,waiting:code?{code,message:waits[code],stage:['production','buying','feedback','budget','system'].includes(details.waiting.stage)?details.waiting.stage:'system',requiresUser:details.waiting.requiresUser===true,retryAt:details.waiting.retryAt||null}:null};
}

/** Advances existing employee operations; it never grants new media spend. */
export function createAutomaticFlow({repository:repo,bucket,env={},fetcher=fetch,resolveContext=resolveBxagiContextForUser,createOrchestrator=createBxagiOrchestrator,adsService}={}){
  async function ensureProject(context,projectId,{notBefore=timeAfter(5)}={}){
    const userId=ownerOf(context);if(!userId||!context?.subject)fail(401,'bxagi_login_required','请先登录BXAGI');
    const project=await repo.getProject(userId,projectId);if(!project)fail(404,'not_found','素材项目不存在');
    const assets=await repo.listAssets(userId,projectId);
    if(assets.some(asset=>asset.metadata?.flowTestRunId)||probeExpired(assets,userId,env))fail(409,'automation_test_project','限时测试项目不进入通用自动流程');
    const date=Date.parse(notBefore);if(!Number.isFinite(date))fail(400,'invalid_automation_time','自动流程时间无效');
    return repo.ensureAutomaticFlow(userId,projectId,{bxagiSubject:context.subject,notBefore:new Date(date).toISOString()});
  }
  async function runOne(flow,providedContext){
    const userId=flow.userId,operationId=crypto.randomUUID();
    const claimed=await repo.claimAutomaticFlow(userId,flow.id,operationId);
    if(!claimed)return {id:flow.id,projectId:flow.projectId,status:'busy',waiting:waiting('operation_busy',{stage:'system'})};
    flow=claimed;
    const signalVersion=Number(flow.details?.signalVersion||0);
    let metricsPatch={};
    async function save(status,details){
      const result=await repo.saveAutomaticFlow(userId,flow.id,operationId,signalVersion,{status,details:{recovery:null,...details,...metricsPatch,lastTickAt:new Date().toISOString()}});
      return result?describeAutomaticFlow(result):{id:flow.id,projectId:flow.projectId,status:'busy',waiting:waiting('operation_busy',{stage:'system'})};
    }
    const hold=async (code,options={},details={})=>{const retry=!options.requiresUser&&['node_offline','gateway_disconnected','runtime_unavailable','service_unavailable'].includes(code),recovery=retry?nextBxagiRecovery(flow.details.recovery,code):null,reason=waiting(code,options);if(recovery)reason.retryAt=recovery.nextRetryAt;return await save(options.requiresUser?'waiting':'monitoring',{...details,recovery,waiting:reason,nextActionAt:reason.retryAt});};
    try{
      if(providedContext?.error)throw providedContext.error;
      const context=providedContext||await resolveContext(userId,env,{fetcher,required:true});
      if(!context||ownerOf(context)!==userId)return await hold('login_required',{requiresUser:true,retrySeconds:120,stage:'system'});
      if(context.subject!==flow.details.bxagiSubject)return await hold('account_changed',{requiresUser:true,retrySeconds:300,stage:'system'});
      const project=await repo.getProject(userId,flow.projectId);
      if(!project)return await hold('source_missing',{requiresUser:true,retrySeconds:300});
      const assets=await repo.listAssets(userId,project.id);
      if(assets.some(a=>a.metadata?.flowTestRunId)||probeExpired(assets,userId,env)){
        // Dispatch expiry is final. The sole permitted continuation is reading
        // the existing, acknowledged production task already bound to this flow.
        let job=flow.details.productionJobId?await repo.getJob(userId,flow.details.productionJobId):null;
        if(!job||job.projectId!==project.id||job.details?.bxagiSubject!==context.subject||job.details.automaticFlowId!==flow.id||!isCollectableBxagiProductionJob(job))return await hold('test_project_excluded',{requiresUser:true,retrySeconds:3600,stage:'system'});
        if((job.status==='failed'&&!isAutomaticallyRecoverableBxagiProductionJob(job))||!bxagiRecoveryDue(job)){const reason=jobWait(job);return await save(reason.requiresUser?'waiting':'producing',{...flow.details,waiting:reason,nextActionAt:reason.retryAt});}
        if(job.status!=='completed'){
          const collection=createOrchestrator({repository:repo,bucket,env,context,fetcher});
          if(typeof collection.collectProduction!=='function')return await hold('test_project_excluded',{requiresUser:true,retrySeconds:3600,stage:'system'});
          const result=await collection.collectProduction(job.id);job=result?.job||await repo.getJob(userId,job.id);
        }
        if(job?.status==='completed'){
          if(!await actualCreativeRecords(repo,bucket,userId,project.id,job))return await hold('artifact_missing',{requiresUser:true,retrySeconds:300},{...flow.details,productionJobId:job.id});
          return await hold('test_collection_complete',{requiresUser:true,retrySeconds:3600,stage:'system'},{...flow.details,lastCompletedProductionJobId:job.id});
        }
        const reason=jobWait(job);return await save(reason.requiresUser?'waiting':'producing',{...flow.details,waiting:reason,nextActionAt:reason.retryAt});
      }
      const campaigns=(await repo.listCampaigns(userId)).filter(c=>c.projectId===project.id),active=campaigns.some(c=>c.status==='active');
      const rotate=(rows,cursor)=>{const sorted=[...rows].sort((a,b)=>a.id.localeCompare(b.id));const after=sorted.findIndex(row=>row.id>cursor);return cursor&&after>=0?[...sorted.slice(after),...sorted.slice(0,after)]:sorted;};
      const metricAttempts={...(flow.details.metricAttempts||{})};
      const dueCampaigns=rotate(campaigns.filter(c=>{const due=Date.parse(c.nextSyncAt??''),retry=Date.parse(metricAttempts[c.id]??'');return c.status==='active'&&(c.nextSyncAt==null||Number.isFinite(due)&&due<=Date.now())&&(!Number.isFinite(retry)||retry<=Date.now());}),flow.details.metricCursor).slice(0,3);
      if(adsService?.sync){
        const metricFailures=[];
        for(const campaign of dueCampaigns){
          try{await adsService.sync(userId,campaign);delete metricAttempts[campaign.id];metricsPatch.lastMetricSyncAt=new Date().toISOString();metricsPatch.metricCampaignId=campaign.id;}
          catch(error){const requiresUser=[401,403].includes(error.status)||['connection_missing','token_expired','adapter_pending','campaign_not_live'].includes(error.code);const reason=waiting(requiresUser?'awaiting_channel_connection':'service_unavailable',{requiresUser,retrySeconds:120,stage:'feedback'});metricAttempts[campaign.id]=reason.retryAt;metricFailures.push({...reason,campaignId:campaign.id});}
          metricsPatch.metricCursor=campaign.id;
        }
        if(dueCampaigns.length)Object.assign(metricsPatch,{metricAttempts,metricsWaiting:metricFailures[0]||null,nextMetricAttemptAt:null});
      }
      const jobs=(await repo.listJobs(userId)).filter(j=>j.projectId===project.id&&j.type==='bxagi_workflow'&&j.details?.bxagiSubject===context.subject);
      const wrappedRepo={...repo,createBxagiProductionJob:(owner,payload)=>repo.createBxagiProductionJob(owner,{...payload,details:{...payload.details,automaticFlowId:flow.id}})};
      const orchestration=createOrchestrator({repository:wrappedRepo,bucket,env,context,fetcher,adsService});
      // Already-authorized buying work progresses independently of a blocked production.
      // Round-robin bounds each tick and prevents an uncertain job starving other plans.
      const buyingJobs=rotate(jobs.filter(j=>j.details.kind==='buying'&&(ACTIVE.has(j.status)||HUMAN_WAIT.has(j.status)||j.status==='needs_reconciliation')),flow.details.buyingCursor).slice(0,3);
      let buyingReason=null;
      for(const buying of buyingJobs){
        let reason;
        const campaign=campaigns.find(c=>c.id===buying.details.campaignId);
        if(!isMarketInstallation(buying.details.employee))reason=waiting(marketWaitCode(buying.details.employee),{requiresUser:true,retrySeconds:300,stage:'buying'});
        else if(!campaign)reason=waiting('buying_failed',{requiresUser:true,retrySeconds:300,stage:'buying'});
        else if(buying.details.createdBy!==userId||!Number.isFinite(Date.parse(buying.details.authorizedAt))||!['launch','pause'].includes(buying.details.action))reason=waiting('awaiting_explicit_launch',{requiresUser:true,retrySeconds:300,stage:'buying'});
        else if(hasUncertainBxagiWrite(buying)||HUMAN_WAIT.has(buying.status)||!bxagiRecoveryDue(buying))reason=jobWait(buying,'buying');
        else{
          try{const outcome=await orchestration.syncJob(buying.id),job=outcome?.job||await repo.getJob(userId,buying.id);reason=job?.status==='completed'?waiting('awaiting_real_metrics',{retrySeconds:60,stage:'feedback'}):jobWait(job||buying,'buying');}
          catch(error){reason=waiting(error.code==='bxagi_campaign_changed'?'campaign_changed':'buying_failed',{requiresUser:true,retrySeconds:300,stage:'buying'});}
        }
        buyingReason=buyingReason||reason;
        Object.assign(metricsPatch,{buyingCursor:buying.id,buyingJobId:buying.id});
      }
      const explicitReady=project.sourceState?.version!==1||project.sourceState.status==='started'&&!!project.sourceState.startedJobId;
      if(!assets.length)return await hold(explicitReady?'source_missing':'production_start_required',{requiresUser:true,retrySeconds:300});
      const selectedAssets=project.sourceState?.version===1&&explicitReady?assets.filter(a=>project.sourceState.assetIds?.includes(a.id)):assets;
      if(selectedAssets.length>20||selectedAssets.some(a=>!Number.isSafeInteger(a.size)||a.size<=0||a.size>MAX_FILE))return await hold('source_too_large',{requiresUser:true,retrySeconds:300});
      const currentSignature=project.sourceState?.version===1&&explicitReady?project.sourceState.inputVersion:await signature(project,assets);
      async function actualCreatives(job){
        return actualCreativeRecords(repo,bucket,userId,project.id,job);
      }
      async function jobSignature(job){const selected=(job.details?.assetIds||[]).map(id=>assets.find(a=>a.id===id));if(selected.some(a=>!a))return null;return signature(job.details.input||project,selected);}
      let production=flow.details.productionJobId?await repo.getJob(userId,flow.details.productionJobId):null;
      if(explicitReady&&project.sourceState?.version===1){
        const requested=await repo.getJob(userId,project.sourceState.startedJobId);
        if(!production||!production.details?.optimizationTaskId||production.details?.batchId!==requested?.details?.batchId)production=requested;
      }
      if(production&&(production.projectId!==project.id||production.type!=='bxagi_workflow'||production.details?.kind!=='production'||production.details.bxagiSubject!==context.subject))return await hold('account_changed',{requiresUser:true,retrySeconds:300,stage:'system'});
      if(!production){production=jobs.find(j=>j.details.kind==='production'&&(j.details.remoteWritePending||j.status==='needs_reconciliation'))||jobs.find(j=>j.details.kind==='production'&&(ACTIVE.has(j.status)||HUMAN_WAIT.has(j.status)))||jobs.find(j=>j.details.kind==='production'&&['completed','failed','partial'].includes(j.status));}
      if(production){
        if(!isMarketInstallation(production.details.employee))return await hold(marketWaitCode(production.details.employee),{requiresUser:true,retrySeconds:300},{productionJobId:production.id});
        const productionSignature=await jobSignature(production);
        if(!productionSignature)return await hold('source_missing',{requiresUser:true,retrySeconds:300},{productionJobId:production.id});
        if(hasUncertainBxagiWrite(production)||HUMAN_WAIT.has(production.status)){
          const reason=jobWait(production);return await save('waiting',{productionJobId:production.id,productionSignature,sourceSignature:currentSignature,waiting:reason,nextActionAt:reason.retryAt});
        }
        if(!bxagiRecoveryDue(production)){const reason=jobWait(production);return await save(reason.requiresUser?'waiting':'producing',{productionJobId:production.id,productionSignature,sourceSignature:currentSignature,waiting:reason,nextActionAt:reason.retryAt});}
        if(production.status==='failed'&&isAutomaticallyRecoverableBxagiProductionJob(production)&&typeof orchestration.collectProduction==='function'){
          const result=await orchestration.collectProduction(production.id);production=result?.job||await repo.getJob(userId,production.id);
          if(production?.status!=='completed'){const reason=jobWait(production);return await save(reason.requiresUser?'waiting':'producing',{productionJobId:production.id,productionSignature,sourceSignature:currentSignature,waiting:reason,nextActionAt:reason.retryAt});}
        }
        if(ACTIVE.has(production.status)){
          if(probeExpired(assets,userId,env))return await hold('test_project_excluded',{requiresUser:true,retrySeconds:3600,stage:'system'});
          const result=isAutomaticallyRecoverableBxagiProductionJob(production)&&typeof orchestration.collectProduction==='function'?await orchestration.collectProduction(production.id):await orchestration.syncJob(production.id);production=result?.job||await repo.getJob(userId,production.id);
          if(!production)return await hold('production_failed',{requiresUser:true,retrySeconds:300});
          if(production.status!=='completed'){const reason=jobWait(production);return await save(reason.requiresUser?'waiting':'producing',{productionJobId:production.id,productionSignature,sourceSignature:currentSignature,waiting:reason,nextActionAt:reason.retryAt});}
        }
        if(production.status==='partial'){const reason=jobWait(production);return await save('waiting',{...flow.details,productionJobId:production.id,waiting:reason,nextActionAt:reason.retryAt});}
        if(production.status==='failed'){
          if(productionSignature===currentSignature)return await hold('production_failed',{requiresUser:true,retrySeconds:300},{productionJobId:production.id,productionSignature});
          production=null;
        }
        if(production?.status==='completed'){
          if(!await actualCreatives(production))return await hold('artifact_missing',{requiresUser:true,retrySeconds:300},{productionJobId:production.id});
          flow.details={...flow.details,productionJobId:production.id,productionSignature,lastCompletedProductionJobId:production.id,lastCompletedSignature:productionSignature};
        }
        if(production&&production.status!=='completed')return await hold('production_failed',{requiresUser:true,retrySeconds:300},{productionJobId:production.id,productionSignature});
      }
      const tasks=(await repo.listOptimizationTasks(userId)).filter(task=>task.projectId===project.id&&task.status==='pending');
      let optimizationTask;
      for(const task of tasks){if(task.metadata?.origin==='business_decision')continue;const campaign=campaigns.find(c=>c.id===task.campaignId);if(!campaign||campaign.autoOptimize!==true)continue;const metric=await repo.getMetric(userId,task.metadata?.sourceMetricId||task.metadata?.metricId);if(metric&&metric.campaignId===campaign.id&&metric.projectId===project.id){optimizationTask=task;break;}}
      if(!explicitReady)return await hold('production_start_required',{requiresUser:true,retrySeconds:300},flow.details);
      if(!production||flow.details.lastCompletedSignature!==currentSignature||optimizationTask){
        if(probeExpired(assets,userId,env))return await hold('test_project_excluded',{requiresUser:true,retrySeconds:3600,stage:'system'});
        const outcome=await orchestration.submitProduction(project,optimizationTask?{optimizationTaskId:optimizationTask.id}:{});
        if(!outcome?.job){return await hold('insufficient_evidence',{retrySeconds:300,stage:'feedback'},{...flow.details,sourceSignature:currentSignature,optimizationTaskId:optimizationTask?.id||null});}
        const queued=await repo.getJob(userId,outcome.job.id);
        if(!queued||queued.projectId!==project.id||queued.details?.kind!=='production'||queued.details.bxagiSubject!==context.subject)fail(409,'automation_job_mismatch','员工任务归属不一致');
        if(!isMarketInstallation(queued.details.employee))return await hold(marketWaitCode(queued.details.employee),{requiresUser:true,retrySeconds:300},{productionJobId:queued.id});
        const reason=waiting('remote_starting');return await save('producing',{...flow.details,productionJobId:queued.id,productionSignature:await jobSignature(queued),sourceSignature:currentSignature,optimizationTaskId:optimizationTask?.id||null,waiting:reason,nextActionAt:reason.retryAt});
      }
      if(buyingReason)return await save(buyingReason.requiresUser?'waiting':'monitoring',{...flow.details,waiting:buyingReason,nextActionAt:buyingReason.retryAt});
      if(!campaigns.length)return await hold('awaiting_budget',{requiresUser:true,retrySeconds:60,stage:'budget'},flow.details);
      if(active){
        const reason=Object.hasOwn(metricsPatch,'metricsWaiting')?metricsPatch.metricsWaiting:flow.details.metricsWaiting;
        if(reason)return await save(reason.requiresUser?'waiting':'monitoring',{...flow.details,waiting:reason,nextActionAt:reason.retryAt});
        return await hold('awaiting_real_metrics',{retrySeconds:60,stage:'feedback'},flow.details);
      }
      const blocked=campaigns.some(c=>c.status==='needs_reconciliation'||c.remoteState?.writePending);
      if(blocked)return await hold('remote_write_uncertain',{requiresUser:true,retrySeconds:300,stage:'buying'},flow.details);
      return await hold('awaiting_explicit_launch',{requiresUser:true,retrySeconds:60,stage:'budget'},flow.details);
    }catch(error){
      const code=error.code,status=Number(error.status)||503;
      if(![401,403].includes(status)&&BXAGI_AVAILABILITY_CODES.has(code))return await hold(code==='bxagi_node_offline'?'node_offline':code==='bxagi_gateway_disconnected'?'gateway_disconnected':code==='bxagi_runtime_unavailable'?'runtime_unavailable':'service_unavailable');
      if(status===401)return await hold('login_required',{requiresUser:true,retrySeconds:120,stage:'system'});
      if(code==='bxagi_market_activation_pending')return await hold('market_activation_pending',{retrySeconds:15});
      if(code==='bxagi_market_activation_needs_reconciliation')return await hold('remote_write_uncertain',{requiresUser:true,retrySeconds:300});
      if(code==='bxagi_market_activation_failed')return await hold('employee_unavailable',{requiresUser:true,retrySeconds:300});
      if(['bxagi_market_employee_required','bxagi_market_role_unmatched'].includes(code))return await hold('waiting_market_employee',{requiresUser:true,retrySeconds:300});
      if(['bxagi_market_employee_activation_required','bxagi_employee_activation_required','bxagi_market_activation_required','bxagi_activation_required'].includes(code))return await hold('waiting_employee_activation',{requiresUser:true,retrySeconds:300});
      if(code==='bxagi_employee_missing')return await hold('employee_missing',{requiresUser:true,retrySeconds:300});
      if(status===403||code==='employee_unavailable')return await hold('employee_unavailable',{requiresUser:true,retrySeconds:300});
      if(['production_start_required','production_batch_required','upload_batch_not_sealed'].includes(code))return await hold('production_start_required',{requiresUser:true,retrySeconds:300});
      if(code==='bxagi_transfer_limit'||status===413)return await hold('source_too_large',{requiresUser:true,retrySeconds:300});
      if(code==='bxagi_production_in_progress'||status===409)return await hold('operation_busy',{retrySeconds:15,stage:'system'});
      if(code==='bxagi_feedback_missing')return await hold('insufficient_evidence',{requiresUser:true,retrySeconds:300,stage:'feedback'});
      return await hold('service_unavailable',{retrySeconds:120,stage:'system'});
    }finally{await repo.releaseAutomaticFlow(userId,flow.id,operationId);}
  }
  async function tick({userId=null,context=null,limit=3}={}){
    if(context){if(userId&&ownerOf(context)!==userId)fail(403,'automation_owner_mismatch','自动流程用户不匹配');userId=ownerOf(context);if(!userId)fail(401,'bxagi_login_required','请先登录BXAGI');}
    const count=Math.min(Math.max(Number(limit)||1,1),3),flows=await repo.listDueAutomaticFlows(count,userId),contexts=new Map(),results=[];
    for(const flow of flows){
      if(userId&&flow.userId!==userId)continue;
      let scoped=context;
      if(!scoped){if(!contexts.has(flow.userId))contexts.set(flow.userId,resolveContext(flow.userId,env,{fetcher,required:true}).catch(error=>({error})));scoped=await contexts.get(flow.userId);}
      results.push(await runOne(flow,scoped));
    }
    return {processed:results.length,results};
  }
  return {ensureProject,tick,describe:describeAutomaticFlow};
}
