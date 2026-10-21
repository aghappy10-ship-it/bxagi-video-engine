import { createInsightsService } from './insights-service.mjs';
import { resolveProductionInputs } from './production-service.mjs';
import { createBxagiWorkforce } from './bxagi-workforce.mjs';
import { evaluateOptimizationContext } from '../shared/creative-engine.mjs';
import { createBxagiPlanner,bxagiPlannerEvidence } from './bxagi-planner.mjs';
import { createBxagiButlerCoordinator,bxagiButlerCoordinationEvidence } from './bxagi-butler-coordinator.mjs';
import { createBxagiMarketplace } from './bxagi-marketplace.mjs';
import { isMarketEmployee,isExecutableMarketEmployee,assertMarketEmployee,assertReadableMarketEmployee,publicMarketSelection } from './bxagi-market-eligibility.mjs';
import { BXAGI_AVAILABILITY_CODES,isTransientBxagiError,nextBxagiRecovery,bxagiRecoveryDue,hasUncertainBxagiWrite } from './bxagi-recovery.mjs';
import { sameBxagiIdentifier } from './bxagi-identifiers.mjs';
import { assertCreativeDeliveryComplete } from './creative-delivery-eligibility.mjs';
import { showcaseSpec } from './bxagi-showcase.mjs';
import { MAX_FILE, sha256, extensions, resultPath, byteMetadata } from './bxagi/artifact-validation.mjs';
import { publicEmployee, scoreBxagiMarketEmployee, chooseBxagiEmployee } from './bxagi/employee-routing.mjs';
import { ACTIVE, isCollectableBxagiProductionJob, isAutomaticallyRecoverableBxagiProductionJob } from './bxagi/production-eligibility.mjs';
import { instruction, repairPrompt, visualPrompt, showcaseLayoutPrompt, videoFormatPrompt } from './bxagi/task-prompts.mjs';

// Preserve the existing API for callers while keeping pure rules independently maintainable.
export { scoreBxagiMarketEmployee, chooseBxagiEmployee } from './bxagi/employee-routing.mjs';
export { isCollectableBxagiProductionJob, isAutomaticallyRecoverableBxagiProductionJob, bxagiProductionCollectionEligibility } from './bxagi/production-eligibility.mjs';

const VISUAL_RESOURCES = [
  {filename:'BXAGI-Workflow-SC-Subset.ttf',size:14424,sha256:'094d92ee9a377dbaf5df8d748af8b4cc44aafc81e4c75f87d232b840fc6f8a2c'},
  {filename:'OFL.txt',size:4388,sha256:'1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9'},
  {filename:'NOTICE.txt',size:1243,sha256:'dc835e181cdb9c4e0a3dfad477f7b20a87a556dec617694bb71c266878df1974'},
];

const DELIVERY_TERMINAL = new Set(['finished','stopped','rejected','error','user_rejected']);
const DELIVERY_STATES = new Set(['loading','init','idle','running','paused','stopped','finished','rejected','error','stuck','rate_limited','awaiting_user_confirmation','waiting_for_confirmation','user_confirmed','user_rejected','awaiting_user_input']);
const deliveryState=value=>typeof value==='string'&&DELIVERY_STATES.has(value.toLowerCase())?value.toLowerCase():null;

const fail = (status,message,code='bxagi_workflow_error') => Object.assign(new Error(message),{status,code});
const clean = (value,max=2000) => typeof value==='string' ? value.trim().slice(0,max) : '';
const publicJob = job => {
  const details={...job.details};
  delete details.operationId; delete details.operationExpiresAt;
  return {...job,details};
};
const safeMessage = error => error?.status && error.status<500 ? clean(error.message,500) : 'BXAGI执行或成果保存暂未完成，请检查连接后同步任务';

async function fingerprint(campaign) {
  const data=JSON.stringify([campaign.id,campaign.projectId,campaign.creativeIds,campaign.channel,campaign.objective,campaign.dailyBudget,campaign.totalBudget,campaign.maxDailyBudget,campaign.targetRoi,campaign.autoOptimize,campaign.connectionId,campaign.platformConfig]);
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}

function projectBrief(project) {
  return {id:project.id,title:project.title,productName:project.productName,description:project.description,
    facts:project.facts||[],objective:project.objective,audience:project.audience,landingUrl:project.landingUrl,scene:project.scene};
}

function jobBrief(job, sourceFiles = job.details.uploadedAssets) {
  return {jobId:job.id,kind:job.details.kind,project:job.details.input,campaign:job.details.campaignBrief||null,optimization:job.details.optimization||null,coordination:job.details.coordination?.decision||null,...(job.details.strategyGuidance?{strategyGuidance:job.details.strategyGuidance}:{}),...(job.details.productionSpec?{productionSpec:job.details.productionSpec,productionVersion:job.details.productionVersion}:{}),sourceFiles};
}

/** Real employee jobs. Text claims never substitute for stored files or media readback. */
export function createBxagiOrchestrator({repository:repo,bucket,env={},context,fetcher=fetch,adsService,workforce,marketplace,marketActivation,butler,butlerBootstrap}={}) {
  if(!context?.nativeUserId||!context?.subject||!context?.accessToken)throw fail(401,'请先连接BXAGI账号','bxagi_login_required');
  const userId=context.nativeUserId;
  const strategyGuidance=projectId=>typeof repo.listStrategies==='function'?createInsightsService({repository:repo}).getActiveStrategyGuidance(userId,{projectId}):Promise.resolve({strategyIds:[],productionGuidance:[],deliveryGuidance:[],authority:'advisory'});
  const remote=workforce||createBxagiWorkforce({accessToken:context.accessToken,subject:context.subject,fetcher});
  let employeeCache;
  const marketSource=marketplace||(!workforce?createBxagiMarketplace({accessToken:context.accessToken,subject:context.subject,fetcher}):{async inspect(){return {employees:await remote.listEmployees()};}});
  const catalog=async()=>{if(employeeCache)return employeeCache;const rows=(await marketSource.inspect()).employees;if(!Array.isArray(rows))throw fail(502,'市场员工目录格式不正确','bxagi_market_catalog_invalid');return employeeCache=rows.filter(isMarketEmployee);};
  async function selectProductionEmployee(scene,spec){
    const choose=rows=>{
      if(spec?.employeeMode!=='manual')return chooseBxagiEmployee(rows,{kind:'production',scene});
      const employee=rows.find(row=>row.id===spec.employeeId&&isMarketEmployee(row));
      if(!employee||scoreBxagiMarketEmployee(employee,{kind:'production',scene})<=0)throw fail(409,'所选员工不是当前官方市场可用的素材制作岗位','bxagi_market_role_unmatched');
      assertMarketEmployee(employee);
      return {employee,mode:'manual',basis:'用户明确选择官方市场制作员工；执行前重新核验账号权益与资源'};
    };
    const enabled=env.BXAGI_MARKET_AUTO_ACTIVATE_FREE===true||env.BXAGI_MARKET_AUTO_ACTIVATE_FREE==='true';
    if(enabled)employeeCache=undefined;
    const activationRecord=employee=>repo.getBxagiMarketActivation?.(userId,employee.marketId,context.subject);
    const uncertain=record=>record&&(record.status==='needs_reconciliation'||record.details?.remoteWritePending);
    const hold=(candidate,code,message,status=409)=>Object.assign(fail(status,message,code),{marketSelection:publicMarketSelection(candidate)});
    try{
      const selected=choose(await catalog());
      if(enabled&&uncertain(await activationRecord(selected.employee)))throw hold(selected.employee,'bxagi_market_activation_needs_reconciliation','市场员工安装结果待核对，平台不会重复安装或派发生产');
      return selected;
    }
    catch(error){
      if(error.code!=='bxagi_market_employee_activation_required'||!enabled)throw error;
      const candidate=(await catalog()).find(employee=>employee.id===error.marketSelection?.id);
      if(!candidate)throw error;
      const existing=await activationRecord(candidate);
      if(uncertain(existing))throw hold(candidate,'bxagi_market_activation_needs_reconciliation','市场员工安装结果待核对，平台不会重复安装或派发生产');
      if(existing?.details?.mainConversationId&&candidate.installation?.status!=='expired')throw hold(candidate,'bxagi_market_activation_pending','免费市场员工已提交安装，正在等待完整启动验证');
      // Existing subscriptions (including expired ones) never enter automatic installation.
      if(candidate.resourceType!=='marketplace_template'||candidate.installed===true||candidate.installation||candidate.activationState!=='not_installed'||candidate.hasSubs!==false||candidate.activation?.freeVerified!==true)throw error;
      const activation=marketActivation||(await import('./bxagi-market-activation.mjs')).createBxagiMarketActivation({repository:repo,context,fetcher});
      const result=await activation.activate(candidate,{marketplace:marketSource});
      if(result?.status==='starting'||result?.status==='wait')throw hold(candidate,'bxagi_market_activation_pending','免费市场员工正在安装或等待启动验证，尚未派发生产');
      if(result?.status==='needs_reconciliation')throw hold(candidate,'bxagi_market_activation_needs_reconciliation','市场员工安装结果待核对，平台不会重复安装或派发生产');
      if(result?.status==='blocked')throw error;
      if(result?.status!=='activated')throw hold(candidate,'bxagi_market_activation_failed','市场员工安装未完成验证，请检查状态后继续',502);
      // An installation receipt is not an executable employee. Re-read the official
      // catalogue and require the complete owned source/node proof before queuing.
      employeeCache=undefined;
      const refreshed=await catalog(),installed=refreshed.find(employee=>employee.id===candidate.id);
      if(!isExecutableMarketEmployee(installed))throw hold(candidate,'bxagi_market_activation_pending','免费市场员工已提交安装，正在等待完整启动验证');
      const selected=choose(refreshed);
      if(selected.employee.id!==candidate.id)throw hold(candidate,'bxagi_market_activation_pending','市场岗位信息已更新，请核验所选员工后继续生产');
      return selected;
    }
  }
  const save=(job,patch)=>repo.updateJob(userId,job.id,{...patch,...(patch.details?{details:{...patch.details,...(job.details?.operationId?{operationId:job.details.operationId,operationExpiresAt:new Date(Date.now()+120000).toISOString()}:{} )}}:{})});
  const guardProbe=expiry=>{if(expiry!==undefined&&(env.AUTOMATION_PROBE_OWNER!==userId||env.AUTOMATION_PROBE_EXPIRES_AT!==expiry||!Number.isFinite(Date.parse(expiry))||Date.parse(expiry)<=Date.now()))throw fail(409,'限时素材验证已到期或已撤销，不再执行员工操作','automation_probe_expired');};
  async function ownedJob(id){
    const job=await repo.getJob(userId,id);
    if(!job||job.type!=='bxagi_workflow')throw fail(404,'BXAGI任务不存在','not_found');
    if(job.details?.bxagiSubject!==context.subject)throw fail(409,'任务属于此前连接的BXAGI账号，请连接对应账号后同步','bxagi_account_changed');
    return job;
  }
  async function guardSavedEmployee(job){
    if(!isMarketEmployee(job.details?.employee)){
      if(!hasUncertainBxagiWrite(job))await repo.updateJob(userId,job.id,{status:'stopped_history_resource',details:{...job.details,lastErrorCode:'bxagi_market_employee_required',lastErrorStatus:409,lastError:'历史会话仅保留记录，不再作为员工执行'}});
      assertMarketEmployee(job.details?.employee);
    }
    assertMarketEmployee(job.details.employee);
  }
  async function reusable(entityKey){
    const jobs=await repo.listJobs(userId);
    const found=jobs.find(j=>j.type==='bxagi_workflow'&&j.details?.entityKey===entityKey&&j.details?.bxagiSubject===context.subject&&(ACTIVE.has(j.status)||j.status==='needs_reconciliation'||j.details?.remoteWritePending));
    if(found)await guardSavedEmployee(found);return found;
  }
  async function submitProduction(input,{optimizationTaskId,batchId,assetIds,productionSpec,inputVersion}={}) {
    const project=await repo.getProject(userId,input.id);
    if(!project)throw fail(404,'素材项目不存在','not_found');
    const frozen=await resolveProductionInputs({repository:repo,userId,project,batchId,assetIds,productionSpec});
    if(inputVersion&&inputVersion!==frozen.inputVersion)throw fail(409,'生产输入版本已变化','production_input_changed');
    const spec=frozen.productionSpec;
    if(frozen.batchId){
      const batch=await repo.getJob(userId,frozen.batchId);
      if(!batch.details?.startRequestedAt&&project.sourceState?.status!=='started')throw fail(409,'请确认本批素材和设置后点击开始优化','production_start_required');
    }
    const entityKey=`production:${project.id}:${optimizationTaskId||frozen.batchId||'initial'}`;
    // A frozen batch is one logical request, including completed/uncertain writes.
    if(frozen.batchId){
      const prior=(await repo.listJobs(userId)).find(j=>j.type==='bxagi_workflow'&&j.details?.entityKey===entityKey&&j.details?.bxagiSubject===context.subject);
      if(prior){
        if(prior.details.inputVersion!==frozen.inputVersion||JSON.stringify(prior.details.productionSpec)!==JSON.stringify(spec))throw fail(409,'已登记的生产参数不能修改，请创建新的素材批次','production_request_frozen');
        await guardSavedEmployee(prior);return {provider:'bxagi',queued:true,project,job:publicJob(prior),assignment:project.assignment,variants:[],reused:true};
      }
    }
    const existing=await reusable(entityKey);
    if(existing)return {provider:'bxagi',queued:true,project,job:publicJob(existing),assignment:project.assignment,variants:[]};
    const assets=frozen.assets;
    for(const asset of assets)guardProbe(asset.metadata?.automationProbeExpiresAt);
    if(!assets.length)throw fail(400,'请先上传真实原始素材','bxagi_sources_required');
    if(assets.length>20||assets.some(a=>a.size>MAX_FILE))throw fail(413,'BXAGI当前一次处理最多20个文件，每个文件最多16MiB；请压缩或拆分素材','bxagi_transfer_limit');
    let task,optimization,leaseId;
    if(optimizationTaskId){
      task=await repo.getOptimizationTask(userId,optimizationTaskId);
      if(!task||task.projectId!==project.id)throw fail(404,'对应素材优化任务不存在','not_found');
      if(task.metadata?.origin==='business_decision'){
        const decision=typeof repo.getDecision==='function'?await repo.getDecision(userId,task.metadata?.sourceDecisionId):null;
        if(task.metadata?.approval!=='accepted'||!decision||decision.status!=='accepted'||decision.projectId!==project.id||decision.actionPlan?.kind!=='optimization_task'||decision.result?.optimizationTaskId!==task.id)throw fail(422,'经营优化任务尚未由本账号正式采纳并关联','bxagi_decision_not_accepted');
        const instructions=clean(decision.actionPlan.instructions,2000);
        if(!instructions)throw fail(422,'经营优化任务缺少明确的素材要求','bxagi_decision_instructions_missing');
        optimization={status:'accepted_request',origin:'business_decision',taskId:task.id,decisionId:decision.id,instructions,iteration:Number(task.metadata?.iteration||0)+1,scope:'project',efficacyVerified:false};
      }else{
      const campaign=await repo.getCampaign(userId,task.campaignId);
      const metric=await repo.getMetric(userId,task.metadata?.sourceMetricId||task.metadata?.metricId);
      if(!campaign||!metric||campaign.projectId!==project.id||metric.campaignId!==campaign.id||metric.projectId!==project.id)throw fail(422,'优化任务缺少该项目的真实反馈依据','bxagi_feedback_missing');
      optimization=evaluateOptimizationContext({taskId:task.id,reason:task.reason,iteration:Number(task.metadata?.iteration||0)+1,campaignSnapshot:campaign,metricSnapshot:metric});
      if(optimization.status!=='experiment_ready'){
        await repo.updateOptimizationTask(userId,task.id,{status:'awaiting_data',metadata:{...task.metadata,optimization}});
        return {provider:'bxagi',project,variants:[],optimization};
      }
      }
      leaseId=crypto.randomUUID();task=await repo.claimOptimizationTask(userId,task.id,leaseId);
      if(!task)throw fail(409,'本轮素材优化正在处理，请刷新状态','optimization_in_progress');
    }
    try{
      const {employee,basis,mode}=await selectProductionEmployee(project.scene,spec);
      const guidance=await strategyGuidance(project.id);
      const assignment={provider:'bxagi',engine:'bxagi',scene:project.scene,productionEmployeeId:employee.id,productionEmployee:publicEmployee(employee,'production'),routingMode:mode||'rules',basis:[basis],semanticValidated:false};
      let job=await repo.createBxagiProductionJob(userId,{projectId:project.id,employeeId:employee.id,type:'bxagi_workflow',status:'queued',details:{provider:'bxagi',kind:'production',entityKey,bxagiSubject:context.subject,employee,...(guidance.strategyIds?.length?{strategyGuidance:guidance}:{}),input:projectBrief(frozen.frozenProject||project),...(spec?{productionSpec:spec,batchId:frozen.batchId,inputVersion:frozen.inputVersion,productionVersion:{batchId:frozen.batchId,inputVersion:frozen.inputVersion}}:{}),assetIds:assets.map(a=>a.id),uploadedAssets:[],createdBy:userId,authorizedAt:new Date().toISOString(),...(task?{optimizationTaskId:task.id,optimization,optimizationLeaseId:leaseId}:{})}});
      if(!job)throw fail(409,'该项目已有员工生产任务，请刷新并等待完成','bxagi_production_in_progress');
      if(task){task=await repo.updateOptimizationTask(userId,task.id,{status:'producing',metadata:{...task.metadata,iteration:optimization.iteration,activeRevision:`bxagi:${job.id}`,optimization,provider:'bxagi',remoteJobId:job.id}});}
      const updated=await repo.updateProject(userId,project.id,{productionEmployeeId:employee.id,assignment});
      await repo.addAudit(userId,{action:'bxagi.production_queued',entityType:'job',entityId:job.id,details:{projectId:project.id,employeeId:employee.providerId,sourceAssetIds:assets.map(a=>a.id),optimizationTaskId:task?.id||null}});
      return {provider:'bxagi',queued:true,project:updated,job:publicJob(job),assignment,variants:[]};
    }catch(error){if(task&&leaseId)await repo.releaseOptimizationTask(userId,task.id,leaseId);throw error;}
  }
  async function submitBuying(input,{action='launch'}={}) {
    if(!['launch','pause'].includes(action))throw fail(400,'不支持该员工投放动作');
    const campaign=await repo.getCampaign(userId,input.id);
    if(!campaign)throw fail(404,'投放计划不存在','not_found');
    if(campaign.status==='needs_reconciliation'||campaign.remoteState?.writePending)throw fail(409,'渠道写入结果待核对，请先核对后派发员工','reconciliation_required');
    const entityKey=`buying:${campaign.id}:${action}`;
    const existing=await reusable(entityKey);
    if(existing)return {provider:'bxagi',queued:true,campaign,job:publicJob(existing)};
    const project=await repo.getProject(userId,campaign.projectId);
    if(!project)throw fail(404,'素材项目不存在','not_found');
    const currentEmployees=await catalog(),suggested=project.assignment?.coordination?.buyingEmployeeId;
    const intelligent=currentEmployees.find(e=>e.id===suggested&&isExecutableMarketEmployee(e));
    const selected=intelligent&&campaign.objective===project.objective?{employee:intelligent,mode:'bxagi_employee_planner',basis:'BXAGI协调员已按项目目标选择当前可用投放员工；预算与渠道执行仍由平台保护'}:chooseBxagiEmployee(currentEmployees,{kind:'buying',scene:project.scene});
    const {employee,basis}=selected;
    const creativeRows=await repo.listCreatives(userId,campaign.creativeIds);
    if(creativeRows.length!==campaign.creativeIds.length||creativeRows.some(c=>c.projectId!==project.id))throw fail(404,'投放素材不存在','not_found');
    if(creativeRows.some(c=>c.size>MAX_FILE))throw fail(413,'投放员工当前文件传输最多16MiB，请压缩成品');
    if(action==='launch')for(const creative of creativeRows)await assertCreativeDeliveryComplete({repository:repo,userId,creative});
    const operationId=crypto.randomUUID();
    if(!await repo.claimCampaignOperation(userId,campaign.id,operationId))throw fail(409,'该投放计划正在处理，请稍后刷新');
    try{
      const duplicate=await reusable(entityKey);if(duplicate)return {provider:'bxagi',queued:true,campaign,job:publicJob(duplicate)};
      const current=await repo.getCampaign(userId,campaign.id);
      if(!current||current.projectId!==project.id)throw fail(409,'投放计划归属已变化，停止派发','bxagi_campaign_changed');
      if(action==='launch'){
        const rows=await repo.listCreatives(userId,current.creativeIds);
        if(rows.length!==current.creativeIds.length||rows.some(creative=>creative.projectId!==project.id))throw fail(404,'投放素材不存在','not_found');
        for(const creative of rows)await assertCreativeDeliveryComplete({repository:repo,userId,creative});
      }
      const inputVersion=await fingerprint(current),guidance=await strategyGuidance(project.id);
      const job=await repo.createJob(userId,{projectId:project.id,employeeId:employee.id,type:'bxagi_workflow',status:'queued',details:{provider:'bxagi',kind:'buying',action,entityKey,bxagiSubject:context.subject,employee,...(guidance.strategyIds?.length?{strategyGuidance:guidance}:{}),campaignId:campaign.id,inputVersion,input:projectBrief(project),creativeIds:current.creativeIds,uploadedAssets:[],campaignBrief:{id:current.id,name:current.name,channel:current.channel,objective:current.objective,dailyBudget:current.dailyBudget,totalBudget:current.totalBudget,maxDailyBudget:current.maxDailyBudget,targetRoi:current.targetRoi},createdBy:userId,authorizedAt:new Date().toISOString()}});
      const updated=await repo.updateCampaign(userId,campaign.id,{buyingEmployeeId:employee.id});
      await repo.addAudit(userId,{action:`bxagi.${action}_queued`,entityType:'job',entityId:job.id,details:{campaignId:campaign.id,employeeId:employee.providerId,inputVersion,basis}});
      return {provider:'bxagi',queued:true,campaign:updated,job:publicJob(job)};
    }finally{await repo.releaseCampaignOperation(userId,campaign.id,operationId);}
  }

  async function uploadInputs(job,conversation){
    const rows=job.details.kind==='production'
      ? await Promise.all(job.details.assetIds.map(id=>repo.getAsset(userId,id)))
      : await Promise.all(job.details.creativeIds.map(id=>repo.getCreative(userId,id)));
    if(rows.some(r=>!r||r.projectId!==job.projectId||r.size>MAX_FILE))throw fail(422,'员工任务的真实源文件不存在或超出传输范围');
    const completed=[...(job.details.uploadedAssets||[])];
    for(const row of rows){
      if(completed.some(r=>r.id===row.id))continue;
      const object=await bucket.get(row.objectKey);if(!object)throw fail(404,'原始文件已不存在','bxagi_source_missing');
      const bytes=await object.arrayBuffer();if(bytes.byteLength!==row.size||bytes.byteLength>MAX_FILE)throw fail(422,'原始文件大小与存储记录不一致');
      const directory=`bxagi-advertising/${job.id}/input`,filename=`${row.id}.${extensions[row.mimeType]||'bin'}`;
      await remote.uploadFile({conversationId:conversation.id||job.details.conversationId,directory,filename,blob:new Blob([bytes],{type:row.mimeType})});
      completed.push({id:row.id,path:`${directory}/${filename}`,kind:job.details.kind==='production'?'source':'creative'});
      job=await save(job,{details:{...job.details,uploadedAssets:completed}});
      return job;
    }
    if(!job.details.briefUploaded){
      const brief=jobBrief(job,completed);
      await remote.uploadFile({conversationId:conversation.id||job.details.conversationId,directory:`bxagi-advertising/${job.id}/input`,filename:'brief.json',blob:new Blob([JSON.stringify(brief)],{type:'application/json'})});
      job=await save(job,{details:{...job.details,briefUploaded:true}});
    }
    return job;
  }
  async function importProduction(job,conversation,manifest){
    if(!Array.isArray(manifest.creatives)||!manifest.creatives.length||manifest.creatives.length>12)throw fail(422,'员工清单必须包含1至12份实际成品','bxagi_invalid_manifest');
    const paths=manifest.creatives.map(entry=>resultPath(job,entry?.path,entry));
    if(new Set(paths).size!==paths.length)throw fail(422,'员工清单包含重复成品路径','bxagi_invalid_manifest');
    const spec=job.details.productionSpec;
    const roleOf=entry=>{
      if(!spec)return entry?.mimeType==='text/plain'?'notes':entry?.mimeType==='image/png'&&/cover|封面/i.test(entry.filename||'')?'cover':'primary';
      if(!['primary','cover','notes'].includes(entry?.role))throw fail(422,'新版交付清单必须标明主成品、封面或说明','bxagi_invalid_manifest');
      if(entry.role==='primary'&&entry.mimeType!==(spec.mediaType==='video'?'video/mp4':'image/png')||entry.role==='cover'&&entry.mimeType!=='image/png'||entry.role==='notes'&&entry.mimeType!=='text/plain')throw fail(422,'交付角色与本次生产类型不一致','bxagi_invalid_manifest');
      return entry.role;
    };
    const primaryCount=manifest.creatives.filter(entry=>roleOf(entry)==='primary').length;
    if(spec&&primaryCount>spec.targetCount)throw fail(422,'主成品数量超过本批明确要求','bxagi_invalid_manifest');
    const expected=manifest.creatives.map((entry,index)=>{
      if(!['image/png','video/mp4','text/plain'].includes(entry?.mimeType)||!Array.isArray(entry.sourceAssetIds)||!entry.sourceAssetIds.length||entry.sourceAssetIds.some(id=>!job.details.assetIds.includes(id)))throw fail(422,'员工交付文件类型或来源未通过校验','bxagi_invalid_manifest');
      return {filename:clean(entry.filename,180).replace(/[\/\\\x00-\x1f]/g,'_')||paths[index].split('/').at(-1),mimeType:entry.mimeType};
    });
    job=await save(job,{details:{...job.details,delivery:{expected,expectedCount:expected.length,...(spec?{requestedPrimaryCount:spec.targetCount,actualPrimaryCount:0,complete:false}:{}),manifestValidatedAt:new Date().toISOString()}}});
    if(job.details.optimizationTaskId){const task=await repo.getOptimizationTask(userId,job.details.optimizationTaskId);if(!task||task.projectId!==job.projectId||task.metadata?.remoteJobId!==job.id||task.metadata?.productionLeaseId!==job.details.optimizationLeaseId)throw fail(409,'素材反馈任务的生产版本已改变');}
    const existing=await repo.listCreatives(userId,job.projectId),results=[];
    for(let index=0;index<manifest.creatives.length;index++){
      const entry=manifest.creatives[index],path=paths[index];
      const mime=clean(entry.mimeType,100),sourceIds=Array.isArray(entry.sourceAssetIds)?[...new Set(entry.sourceAssetIds)]:[];
      if(!sourceIds.length||sourceIds.some(id=>!job.details.assetIds.includes(id)))throw fail(422,'员工成品必须关联本任务上传的真实来源','bxagi_invalid_manifest');
      const reused=existing.find(c=>c.metadata?.sourceJobId===job.id&&c.metadata?.remoteArtifactPath===path&&(!job.details.visualRepair||c.metadata?.visualRepairRevision===1&&c.metadata?.visualRepairAttemptId===job.details.visualRepair.attemptId&&c.status!=='rejected'&&c.sourceAssetIds?.length===sourceIds.length&&sourceIds.every(id=>c.sourceAssetIds.includes(id))));
      if(reused&&spec&&reused.metadata?.deliverableRole!==roleOf(entry))throw fail(409,'同一交付文件的主成品角色发生变化，需核对清单','bxagi_invalid_manifest');
      if(reused){const object=await bucket.get(reused.objectKey);if(object&&object.size===reused.size){results.push(reused);continue;}}
      const response=await remote.readArtifact({conversation,relativePath:path});
      const bytes=new Uint8Array(await response.arrayBuffer());if(!bytes.length||bytes.length>MAX_FILE)throw fail(422,'员工交付文件大小无效');
      const {technicalChecks,...dimensions}=await byteMetadata(bytes,mime),deliverableRole=roleOf(entry),contentSha256=await sha256(bytes),key=`tenants/${encodeURIComponent(userId)}/creatives/${crypto.randomUUID()}`;
      if(spec&&deliverableRole==='primary'){
        const targetRatio={portrait:9/16,square:1,landscape:16/9}[spec.format],actualRatio=dimensions.width/dimensions.height;
        if(!Number.isFinite(actualRatio)||Math.abs(actualRatio-targetRatio)/targetRatio>0.04)throw fail(422,'主成品实际画幅与本批要求不一致','bxagi_invalid_artifact');
        if(results.some(c=>c.metadata?.deliverableRole==='primary'&&c.metadata?.contentSha256===contentSha256))throw fail(422,'不同主成品不能是同一文件的重复副本','bxagi_duplicate_primary_artifact');
      }
      if(job.details.videoFormatRepair&&mime==='video/mp4'&&(dimensions.width!==720||dimensions.height!==720||Math.abs(dimensions.duration-10)>0.05))throw fail(422,'修复视频实际尺寸或时长不符合720×720、10秒要求','bxagi_invalid_artifact');
      if(job.details.visualRepair?.kind==='showcase_layout'&&mime==='video/mp4'){
        if(dimensions.width!==720||dimensions.height!==1280||Math.abs(dimensions.duration-22)>0.05||await sha256(bytes)===job.details.visualRepair.originalSha256)throw fail(422,'新版视频必须为720×1280、22秒且不能复制旧视频','bxagi_invalid_visual_artifact');
      }
      if(job.details.visualRepair&&mime==='image/png'){
        const showcase=job.details.visualRepair.kind==='showcase_layout';
        if(dimensions.width!==(showcase?720:1080)||dimensions.height!==(showcase?1280:1080))throw fail(422,showcase?'新版封面必须实际为720×1280':'视觉修复PNG必须实际为1080×1080','bxagi_invalid_visual_artifact');
        for(const originalId of job.details.visualRepair.originalResultCreativeIds){const original=await repo.getCreative(userId,originalId);if(original?.mimeType!=='image/png')continue;const object=await bucket.get(original.objectKey);if(object&&await sha256(bytes)===await sha256(await object.arrayBuffer()))throw fail(422,'视觉修复不能重复复制旧PNG','bxagi_invalid_visual_artifact');}
      }
      await bucket.put(key,bytes,{httpMetadata:{contentType:mime}});
      let creative;
      try{
        const factsUsed=Array.isArray(entry.factsUsed)?entry.factsUsed.filter(f=>typeof f==='string'&&(job.details.input.facts||[]).includes(f)):[];
        creative=await repo.createCreative(userId,{projectId:job.projectId,filename:clean(entry.filename,180).replace(/[\/\\\x00-\x1f]/g,'_')||`bxagi-${index+1}.${extensions[mime]}`,mimeType:mime,size:bytes.length,objectKey:key,title:clean(entry.title,180)||`${job.details.input.title} · BXAGI成品`,variantId:job.details.visualRepair?`${job.id}_visual_1_${index}`:`${job.id}_${index}`,format:['portrait','square','landscape'].includes(entry.format)?entry.format:'square',employeeId:job.employeeId,sourceAssetIds:sourceIds,validation:'bxagi-file-structure',...dimensions,status:'draft',metadata:{provider:'bxagi',sourceJobId:job.id,deliverableRole,contentSha256,...(spec?{requestedCount:spec.targetCount,productionSpec:spec,productionVersion:{...job.details.productionVersion,jobId:job.id}}:{}),remoteArtifactPath:path,remoteEmployeeId:job.details.employee.providerId,remoteConversationId:job.details.conversationId,technicalChecks,semanticValidated:false,factsUsed,...(job.details.visualRepair?{visualRepairRevision:1,visualRepairAttemptId:job.details.visualRepair.attemptId}:{}),...(job.details.optimizationTaskId?{optimizationTaskId:job.details.optimizationTaskId,planRevision:`bxagi:${job.id}`,sourceMetricId:job.details.optimization?.metricId}:{} )}});
      }catch(error){await bucket.delete(key);throw error;}
      results.push(creative);
      job=await save(job,{status:'awaiting_result',details:{...job.details,recovery:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,resultCreativeIds:results.map(c=>c.id),delivery:{...job.details.delivery,...(spec?{actualPrimaryCount:results.filter(c=>c.metadata?.deliverableRole==='primary').length}:{} )}}});
      // Bound each sync to one actual upload/download; later polls reuse stored
      // sourceJobId/path records rather than hold a request for a whole batch.
      if(index<manifest.creatives.length-1)return {provider:'bxagi',job:publicJob(job),creatives:results.map(({objectKey,...row})=>({...row,contentUrl:`/api/v2/creatives/${row.id}/content`}))};
    }
    if(new Set(results.map(c=>c.id)).size!==manifest.creatives.length)throw fail(422,'员工清单包含重复成品文件','bxagi_invalid_manifest');
    const project=await repo.getProject(userId,job.projectId);
    const plan={provider:'bxagi',engine:'bxagi',revision:`bxagi:${job.id}`,remoteJobId:job.id,optimization:job.details.optimization||{status:'not_requested'},variants:results.map((c,index)=>({id:c.variantId,title:c.title,format:c.format,status:'draft',mediaType:c.mimeType.startsWith('image/')?'image':c.mimeType.startsWith('video/')?'video':'text',sourceAssetIds:c.sourceAssetIds,headline:clean(manifest.creatives[index].headline,300),body:clean(manifest.creatives[index].body,4000),cta:clean(manifest.creatives[index].cta,100),evidence:(c.metadata.factsUsed||[]).map(value=>({source:'project.fact',value}))}))};
    await repo.updateProject(userId,project.id,{creativePlan:plan,...(clean(manifest.scene,80)?{scene:clean(manifest.scene,80)}:{})});
    if(spec){
      const actualPrimaryCount=results.filter(c=>c.metadata?.deliverableRole==='primary').length;
      const coversComplete=spec.mediaType!=='video'||results.some(c=>c.metadata?.deliverableRole==='cover');
      const complete=actualPrimaryCount===spec.targetCount&&coversComplete;
      job=await save(job,{details:{...job.details,delivery:{...job.details.delivery,requestedPrimaryCount:spec.targetCount,actualPrimaryCount,complete}}});
      if(!complete){
        job=await save(job,{status:'partial',details:{...job.details,lastErrorCode:'bxagi_partial_delivery',lastError:`已收到${actualPrimaryCount}/${spec.targetCount}条主成品${coversComplete?'':'，缺少视频封面'}，本批尚未完整交付`,resultCreativeIds:results.map(c=>c.id)}});
        return {provider:'bxagi',job:publicJob(job),project:await repo.getProject(userId,project.id),creatives:results.map(({objectKey,...row})=>({...row,contentUrl:`/api/v2/creatives/${row.id}/content`}))};
      }
    }
    if(job.details.optimizationTaskId){
      const task=await repo.getOptimizationTask(userId,job.details.optimizationTaskId);
      if(!task||task.projectId!==project.id||task.metadata?.remoteJobId!==job.id)throw fail(409,'素材反馈任务的生产版本已改变');
      const completed=await repo.completeOptimizationTask(userId,task.id,job.details.optimizationLeaseId,{...task.metadata,resultCreativeIds:results.map(c=>c.id),planVariantIds:results.map(c=>c.variantId),completedAt:new Date().toISOString(),completionType:'bxagi_actual_creatives_generated',efficacyVerified:false});
      if(!completed&&task.status!=='completed')throw fail(409,'素材反馈任务状态已改变');
    }
    job=await save(job,{status:'completed',details:{...job.details,resultCreativeIds:results.map(c=>c.id),completedAt:new Date().toISOString(),efficacyVerified:false,recovery:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,...(job.details.videoFormatRepair?{videoFormatRepair:{...job.details.videoFormatRepair,phase:'completed',resultCreativeIds:results.map(c=>c.id),collectedAt:new Date().toISOString(),fullDecodeVerified:false}}:{}),...(job.details.visualRepair?{visualRepair:{...job.details.visualRepair,phase:'completed',resultCreativeIds:results.map(c=>c.id),collectedAt:new Date().toISOString(),semanticValidated:false}}:{})}});
    await repo.addAudit(userId,{action:'bxagi.actual_creatives_imported',entityType:'job',entityId:job.id,details:{creativeIds:results.map(c=>c.id),remoteConversationId:job.details.conversationId,semanticValidated:false}});
    return {provider:'bxagi',job:publicJob(job),creatives:results.map(({objectKey,...row})=>({...row,contentUrl:`/api/v2/creatives/${row.id}/content`}))};
  }
  async function executeBuying(job,manifest){
    const campaign=await repo.getCampaign(userId,job.details.campaignId);
    if(!campaign||campaign.projectId!==job.projectId)throw fail(404,'任务所属投放计划不存在','not_found');
    if(await fingerprint(campaign)!==job.details.inputVersion)throw fail(409,'投放预算或素材已变化，请重新派发投放员工','bxagi_campaign_changed');
    if(manifest.decision?.action!==job.details.action||manifest.decision?.campaignId!==campaign.id||manifest.decision?.inputVersion!==job.details.inputVersion)throw fail(422,'员工执行请求与用户已授权的计划不一致','bxagi_invalid_decision');
    if(!adsService)throw fail(503,'真实渠道执行工具尚未配置');
    const already=job.details.action==='launch'?campaign.status==='active':campaign.status==='paused';
    let outcome=campaign;
    if(!already){
      if(job.details.adOperationStarted&&campaign.remoteState?.writePending)throw fail(409,'渠道写入结果待核对，不重复执行','reconciliation_required');
      job=await save(job,{details:{...job.details,adOperationStarted:true}});
      outcome=await adsService[job.details.action](userId,campaign);
    }
    const success=job.details.action==='launch'?outcome.status==='active':outcome.status==='paused';
    job=await save(job,{status:success?'completed':outcome.status==='needs_reconciliation'?'needs_reconciliation':'failed',details:{...job.details,campaignResultStatus:outcome.status,lastError:success?null:clean(outcome.error,500)||'真实渠道尚未完成执行',...(success?{completedAt:new Date().toISOString()}:{} )}});
    await repo.addAudit(userId,{action:'bxagi.buying_result',entityType:'job',entityId:job.id,details:{campaignId:campaign.id,action:job.details.action,actualChannelStatus:outcome.status,remoteId:outcome.remoteId||null}});
    return {provider:'bxagi',job:publicJob(job),campaign:outcome,creatives:[]};
  }
  async function waitingDelivery(job,conversation){
      let state=deliveryState(conversation.executionStatus||conversation.execution_status),evidence='conversation';
      if(typeof remote.getEvents==='function'){
        // BXAGI returns descending event order. Its event timestamps may carry
        // a server timezone offset, so never compare them with our wall clock.
        const events=(await remote.getEvents(conversation.id)).slice(0,100);
        const sentIndex=events.findIndex(event=>event.id===job.details.messageEventId);
        const repair=job.details.videoFormatRepair||job.details.visualRepair||job.details.deliveryRepair,ackAge=Date.now()-Date.parse(repair?.messageSentAt);
        const indexing=sentIndex<0&&repair?.phase==='sent'&&repair.revision===1&&repair.messageAcknowledged===true&&repair.messageEventId===job.details.messageEventId&&Number.isFinite(ackAge)&&ackAge>=0&&ackAge<60000;
        const current=sentIndex>=0?events.slice(0,sentIndex):indexing?[]:events;
        // The conversation snapshot may still describe the previous turn.
        // Once our actual message is present, only newer events may terminate it.
        if(sentIndex>=0){state=null;evidence='acknowledged_message_boundary';}
        else if(indexing){state=null;evidence='repair_message_index_pending';}
        for(const event of current){
          if(event.key==='execution_status'&&deliveryState(event.value)){state=deliveryState(event.value);evidence='execution_event';break;}
          if(event.kind==='ActionEvent'&&event.source==='agent'&&event.action?.kind==='FinishAction'){state='finished';evidence='finish_action';break;}
        }
      }
      const terminal=DELIVERY_TERMINAL.has(state),confirmation=['awaiting_user_confirmation','waiting_for_confirmation'].includes(state),waiting=confirmation||state==='awaiting_user_input';
      job=await save(job,{status:terminal?'failed':confirmation?'awaiting_user_confirmation':waiting?'awaiting_user_input':'awaiting_result',details:{...job.details,recovery:null,executionStatus:state,deliveryStateEvidence:evidence,lastErrorCode:terminal?'bxagi_delivery_missing':null,lastErrorStatus:terminal?404:null,lastError:terminal?'BXAGI员工任务已结束，但尚未找到交付清单与实际成品；请检查交付后重新回收':waiting?'BXAGI员工需要补充信息或确认，请在员工中心处理':'等待BXAGI员工实际交付清单与成品文件'}});
      return {provider:'bxagi',job:publicJob(job),creatives:[]};
  }
  async function readDelivery(job,conversation){
    let manifest;
    try{manifest=await remote.readManifest({conversation,relativePath:`bxagi-advertising/${job.id}/output/manifest.json`});}
    catch(error){
      if(error.status!==404)throw error;
      if(conversation.collectionAvailability&&conversation.collectionAvailability!=='ready')throw fail(503,'节点暂不可读取交付文件，保留原任务等待恢复',`bxagi_${conversation.collectionAvailability}`);
      return waitingDelivery(job,conversation);
    }
    if(manifest.version!==1||manifest.jobId!==job.id||manifest.kind!==job.details.kind)throw fail(422,'员工交付清单与当前任务不一致','bxagi_invalid_manifest');
    if(job.details.videoFormatRepair){
      const repair=job.details.videoFormatRepair,prefix=`bxagi-advertising/${job.id}/output/`,entries=manifest.creatives;
      if(!manifest.videoFormatRepairAttemptId&&Array.isArray(entries)&&entries.every(entry=>![prefix+'video-h264.mp4',prefix+'production_notes_h264.txt','video-h264.mp4','production_notes_h264.txt'].includes(entry?.path)))return waitingDelivery(job,conversation);
      const expected=[['video-h264.mp4','video/mp4'],['cover.png','image/png'],['production_notes_h264.txt','text/plain']];
      if(repair.phase!=='sent'||manifest.videoFormatRepairAttemptId!==repair.attemptId||!Array.isArray(entries)||entries.length!==3||expected.some(([filename,mime])=>entries.filter(entry=>entry.path===prefix+filename&&entry.filename===filename&&entry.mimeType===mime).length!==1)||entries.some(entry=>!Array.isArray(entry.sourceAssetIds)||entry.sourceAssetIds.length!==job.details.assetIds.length||new Set(entry.sourceAssetIds).size!==job.details.assetIds.length||entry.sourceAssetIds.some(id=>!job.details.assetIds.includes(id))))throw fail(422,'视频修复清单必须绑定当前修复和原始来源，交付新H264视频、原封面及新说明','bxagi_invalid_video_repair_manifest');
    }
    if(job.details.visualRepair){
      const repair=job.details.visualRepair,prefix=`bxagi-advertising/${job.id}/output/`,entries=manifest.creatives;
      const expected=repair.kind==='showcase_layout'?[['video-v2.mp4','video/mp4'],['cover-v2.png','image/png'],['notes-v2.txt','text/plain']]:[['poster-v2.png','image/png'],['production_notes-v2.txt','text/plain']];
      // Old manifests cannot fulfill a new acknowledged revision.
      if(!manifest.visualRepair&&Array.isArray(entries)&&entries.every(entry=>!expected.some(([name])=>entry?.path===prefix+name)))return waitingDelivery(job,conversation);
      if(repair.phase!=='sent'||manifest.visualRepair?.revision!==1||manifest.visualRepair?.attemptId!==repair.attemptId||!Array.isArray(entries)||entries.length!==expected.length||expected.some(([filename,mime])=>entries.filter(entry=>entry.path===prefix+filename&&entry.filename===filename&&entry.mimeType===mime).length!==1)||entries.some(entry=>!Array.isArray(entry.sourceAssetIds)||entry.sourceAssetIds.length!==job.details.assetIds.length||new Set(entry.sourceAssetIds).size!==job.details.assetIds.length||entry.sourceAssetIds.some(id=>!job.details.assetIds.includes(id))))throw fail(422,'视觉修复清单必须绑定本次修复及原始来源并交付指定v2文件','bxagi_invalid_visual_manifest');
    }
    return job.details.kind==='production'?await importProduction(job,conversation,manifest):await executeBuying(job,manifest);
  }
  async function collectionInputs(job){
    if(!isCollectableBxagiProductionJob(job)||job.userId!==userId||job.details.bxagiSubject!==context.subject)throw fail(409,'只能回收当前账号已确认派发且写入结果明确的市场生产任务','bxagi_collection_scope_invalid');
    const project=await repo.getProject(userId,job.projectId),ids=job.details.assetIds,uploaded=job.details.uploadedAssets;
    if(!project||job.details.input?.id!==project.id||!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||!Array.isArray(uploaded)||uploaded.length!==ids.length)throw fail(409,'成品回收的项目或来源记录不完整','bxagi_collection_source_invalid');
    for(const id of ids){
      const asset=await repo.getAsset(userId,id),files=uploaded.filter(row=>row?.id===id);
      if(!asset||asset.projectId!==project.id||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>MAX_FILE||files.length!==1||files[0].kind!=='source'||files[0].path!==`bxagi-advertising/${job.id}/input/${id}.${extensions[asset.mimeType]||'bin'}`)throw fail(409,'成品回收的原始素材归属或上传记录不匹配','bxagi_collection_source_invalid');
      const object=await bucket.get(asset.objectKey);
      if(!object||object.size!==asset.size)throw fail(409,'成品回收的原始素材文件已不存在或记录不符','bxagi_collection_source_invalid');
      await object.body?.cancel?.().catch(()=>{});
    }
  }
  async function collectionConversation(job,{requireExecutable=false}={}){
    employeeCache=undefined;
    const current=(await catalog()).find(employee=>employee.id===job.employeeId&&employee.marketId===job.details.employee.marketId);
    try{(requireExecutable?assertMarketEmployee:assertReadableMarketEmployee)(current);}catch(error){
      if(!requireExecutable&&error.code==='bxagi_market_employee_activation_required')throw fail(403,'当前市场员工的权益或身份未通过验证，请在BXAGI处理后继续回收','bxagi_collection_authorization_required');
      throw error;
    }
    if(current.providerId!==job.details.employee.providerId||!sameBxagiIdentifier(current.conversationId,job.details.employee.conversationId))throw fail(409,'已选市场员工的实例或来源已改变','bxagi_collection_employee_mismatch');
    const source=await remote.getConversation(current.conversationId);
    if(!sameBxagiIdentifier(source.id,current.conversationId)||source.created_by_user_id!==context.subject||(source.employeeId||source.employee_id)!==current.providerId||source.parent_conversation_id)throw fail(409,'市场员工来源归属未通过回收验证','bxagi_collection_employee_mismatch');
    const raw=await remote.getConversation(job.details.conversationId),conversation={...raw,employeeId:raw.employeeId||raw.employee_id,executionStatus:raw.executionStatus||raw.execution_status};
    if(!sameBxagiIdentifier(conversation.id,job.details.conversationId)||conversation.created_by_user_id!==context.subject||conversation.employeeId!==current.providerId)throw fail(409,'任务会话归属或员工实例未通过回收验证','bxagi_collection_employee_mismatch');
    return {...conversation,...(['ready','node_offline','gateway_disconnected','node_unavailable','runtime_unavailable'].includes(current.availability)?{collectionAvailability:current.availability}:{})};
  }
  /** Remote reads only: expiry stops dispatch, not retrieval of already sent work. */
  async function collectProduction(id){
    let job=await ownedJob(id);
    await collectionInputs(job);
    if(job.status==='completed')return {provider:'bxagi',job:publicJob(job),creatives:[],collectionOnly:true};
    const operationId=crypto.randomUUID(),claimed=await repo.claimBxagiJobOperation(userId,id,operationId);
    if(!claimed)return {provider:'bxagi',job:publicJob(job),creatives:[],collectionOnly:true,busy:true};
    job=claimed;
    try{
      await collectionInputs(job);
      const conversation=await collectionConversation(job);
      const result=await readDelivery(job,conversation);
      return {...result,collectionOnly:true};
    }catch(error){
      job=await ownedJob(id);
      const transient=isTransientBxagiError(error),authRequired=[401,403].includes(error.status);
      job=await save(job,{status:transient||authRequired?'awaiting_result':'failed',details:{...job.details,recovery:transient?nextBxagiRecovery(job.details.recovery,error.code):null,lastErrorCode:typeof error.code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code)?error.code:'bxagi_collection_failed',lastErrorStatus:Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:null,lastError:safeMessage(error)}});
      return {provider:'bxagi',job:publicJob(job),creatives:[],collectionOnly:true};
    }finally{await repo.releaseBxagiJobOperation(userId,id,operationId);}
  }
  function repairAuthorization(id,authorization){
    const remaining=Date.parse(authorization?.expiresAt)-Date.now();
    if(authorization?.jobId!==id||!Number.isFinite(remaining)||remaining<=0||remaining>3600000)throw fail(403,'交付修复需要绑定当前任务的有效限时内部授权','bxagi_repair_authorization_required');
  }

  /** One explicitly authorized PlanAgent repair; never called by ordinary sync. */
  async function repairDelivery(id,authorization={}){
    repairAuthorization(id,authorization);
    let job=await ownedJob(id);
    if(job.details.deliveryRepair)return {provider:'bxagi',job:publicJob(job),creatives:[],repairAttempted:true,alreadyAttempted:true};
    if(job.status!=='failed'||job.details.lastErrorCode!=='bxagi_delivery_missing'||job.details.employee?.agentType!=='PlanAgent')throw fail(409,'只允许修复已确认缺失交付的市场规划员工任务','bxagi_repair_scope_invalid');
    await collectionInputs(job);
    const operationId=crypto.randomUUID(),claimed=await repo.claimBxagiJobOperation(userId,id,operationId);
    if(!claimed)return {provider:'bxagi',job:publicJob(job),creatives:[],busy:true};
    job=claimed;let stage='preflight';
    try{
      if(job.details.deliveryRepair)return {provider:'bxagi',job:publicJob(job),creatives:[],repairAttempted:true,alreadyAttempted:true};
      if(job.status!=='failed'||job.details.lastErrorCode!=='bxagi_delivery_missing'||job.details.employee?.agentType!=='PlanAgent')throw fail(409,'任务状态已变化，不能再次修复','bxagi_repair_scope_invalid');
      await collectionInputs(job);
      const conversation=await collectionConversation(job,{requireExecutable:true});
      if(conversation.agent_type!=='PlanAgent')throw fail(409,'当前会话不再是已确认的规划智能体','bxagi_repair_agent_changed');
      if(typeof remote.inspectJobFiles!=='function'||typeof remote.readJobInput!=='function'||typeof remote.switchExecutionAgent!=='function')throw fail(503,'员工执行模式修复适配器尚不可用','bxagi_repair_adapter_missing');
      const listing=await remote.inspectJobFiles({conversationId:conversation.id,jobId:job.id}),prefix=`bxagi-advertising/${job.id}`,paths=[...job.details.uploadedAssets.map(a=>a.path),`${prefix}/input/brief.json`];
      if(listing?.jobId!==job.id||!sameBxagiIdentifier(listing.conversationId,conversation.id))throw fail(409,'任务文件检查归属不匹配','bxagi_repair_files_unverified');
      for(const namespace of ['conversation','nodeProject']){
        const input=listing[namespace]?.input,output=listing[namespace]?.output;
        if(input?.directory!==`${prefix}/input`||input.exists!==true||input.excludedEntryCount!==0||input.truncated!==false||input.directoryCount!==0||input.fileCount!==paths.length||!Array.isArray(input.entries)||input.entries.length!==paths.length||new Set(input.entries.map(e=>e.path)).size!==paths.length||input.entries.some(e=>e.type!=='file'||!paths.includes(e.path)))throw fail(409,'原始输入目录尚未通过实际核对','bxagi_repair_files_unverified');
        if(output?.directory!==`${prefix}/output`||output.exists!==true||output.excludedEntryCount!==0||output.truncated!==false||output.fileCount!==0||output.directoryCount!==0||!Array.isArray(output.entries)||output.entries.length)throw fail(409,'输出目录并非已核实为空，先回收已有交付','bxagi_repair_output_not_empty');
      }
      const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      for(const source of job.details.uploadedAssets){
        const asset=await repo.getAsset(userId,source.id),object=await bucket.get(asset.objectKey),original=await object.arrayBuffer(),response=await remote.readJobInput({conversation,relativePath:source.path}),bytes=await response.arrayBuffer();
        if(bytes.byteLength!==asset.size||bytes.byteLength>MAX_FILE||await digest(bytes)!==await digest(original))throw fail(409,'远端原始文件与用户上传内容不一致','bxagi_repair_input_mismatch');
        job=await save(job,{details:{...job.details}});
      }
      const response=await remote.readJobInput({conversation,relativePath:`${prefix}/input/brief.json`});
      const brief=await response.json(),expected=jobBrief(job);
      if(JSON.stringify(brief)!==JSON.stringify(expected))throw fail(409,'远端任务说明与已保存任务不一致','bxagi_repair_input_mismatch');
      repairAuthorization(id,authorization);
      const repair={revision:1,attemptId:crypto.randomUUID(),authorizedAt:new Date().toISOString(),authorizationExpiresAt:new Date(Date.parse(authorization.expiresAt)).toISOString(),phase:'switching',originalAgentType:'PlanAgent',originalMessageEventId:job.details.messageEventId||null,originalMessageSentAt:job.details.messageSentAt,inputsVerified:true,emptyOutputVerified:true};
      job=await save(job,{status:'starting',details:{...job.details,deliveryRepair:repair,remoteWritePending:'switch_execution_agent'}});stage='switch';
      const switched=await remote.switchExecutionAgent({conversationId:conversation.id,employeeId:job.details.employee.providerId,jobId:job.id});
      if(switched?.executionModeVerified!==true||switched.agentType!=='CodeActAgent'||switched.employeeId!==job.details.employee.providerId||!sameBxagiIdentifier(switched.conversationId,conversation.id))throw Object.assign(fail(502,'执行模式切换结果尚未确认','bxagi_repair_switch_unconfirmed'),{uncertain:true});
      stage='execution_ready';job=await save(job,{details:{...job.details,executionAgentType:'CodeActAgent',remoteWritePending:null,deliveryRepair:{...job.details.deliveryRepair,phase:'execution_ready',switchedAt:new Date().toISOString()}}});
      repairAuthorization(id,authorization);
      job=await save(job,{status:'running',details:{...job.details,remoteWritePending:'send_delivery_repair',deliveryRepair:{...job.details.deliveryRepair,phase:'sending'}}});stage='send';
      const receipt=await remote.sendMessage(conversation.id,repairPrompt(job));
      const eventId=receipt?.eventId;
      if(receipt?.messageAcknowledged!==true||!['bxagi_ws','bxagi_events'].includes(receipt.transport)||typeof eventId!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(eventId)||eventId.includes(context.accessToken)||/(?:bearer|secret|api[_-]?key|session[_-]?key|^sk[_-])/i.test(eventId))throw Object.assign(fail(502,'交付修复指令尚未收到可核实回执','bxagi_repair_message_unconfirmed'),{uncertain:true});
      stage='acknowledged';const sentAt=new Date().toISOString();
      job=await save(job,{status:'running',details:{...job.details,remoteWritePending:null,messageAcknowledged:true,messageSentAt:sentAt,messageEventId:eventId,messageTransport:receipt.transport,messageAlreadyDelivered:receipt.alreadyDelivered===true,executionStatus:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,deliveryRepair:{...job.details.deliveryRepair,phase:'sent',messageEventId:eventId,messageSentAt:sentAt,messageAcknowledged:true}}});
      return {provider:'bxagi',job:publicJob(job),creatives:[],repairAttempted:true};
    }catch(error){
      if(stage==='preflight')throw error;
      const knownUnsent=error.uncertain===false&&(stage==='switch'?error.writeSent===false:stage==='send'?error.messageSent===false:false);
      const uncertain=['switch','send','acknowledged'].includes(stage)&&!knownUnsent;
      job=await save(job,{status:uncertain?'needs_reconciliation':'failed',details:{...job.details,...(uncertain?{}:{remoteWritePending:null}),lastErrorCode:typeof error.code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code)?error.code:'bxagi_repair_failed',lastErrorStatus:Number.isInteger(error.status)?error.status:null,lastError:uncertain?'执行模式切换或交付修复指令结果待核对；不会自动重发':safeMessage(error),deliveryRepair:{...job.details.deliveryRepair,phase:uncertain?'needs_reconciliation':'failed'}}});
      return {provider:'bxagi',job:publicJob(job),creatives:[],repairAttempted:true};
    }finally{await repo.releaseBxagiJobOperation(userId,id,operationId);}
  }
  async function visualResources(resources){
    if(!Array.isArray(resources)||resources.length!==VISUAL_RESOURCES.length)throw fail(422,'视觉修复仅接受固定字体与许可资源','bxagi_visual_resources_invalid');
    const validated=[];let total=0;
    for(const expected of VISUAL_RESOURCES){
      const matches=resources.filter(resource=>resource?.filename===expected.filename),resource=matches[0];
      if(matches.length!==1||resource.size!==expected.size||resource.sha256!==expected.sha256||!(resource.blob instanceof Blob)||resource.blob.size!==expected.size)throw fail(422,'视觉修复资源名称、大小或校验值不匹配','bxagi_visual_resources_invalid');
      const bytes=await resource.blob.arrayBuffer();total+=bytes.byteLength;
      if(await sha256(bytes)!==expected.sha256||total>32768)throw fail(422,'视觉修复资源内容未通过固定校验','bxagi_visual_resources_invalid');
      validated.push({...expected,blob:new Blob([bytes],{type:expected.filename.endsWith('.ttf')?'font/ttf':'text/plain'})});
    }
    return validated;
  }
  async function visualApproval(conversation){
    let state=deliveryState(conversation.execution_status||conversation.executionStatus);
    const blocked=value=>['awaiting_user_confirmation','waiting_for_confirmation','awaiting_user_input'].includes(value);
    if(blocked(state))throw fail(409,'员工正在等待用户确认或补充信息，请先在员工中心处理','bxagi_visual_approval_required');
    if(typeof remote.getEvents!=='function')throw fail(503,'视觉修复缺少实际会话事件读取能力','bxagi_visual_adapter_missing');
    const events=(await remote.getEvents(conversation.id)).slice(0,100),states=events.map(row=>row.key==='execution_status'?deliveryState(row.value):row.key==='full_state'?deliveryState(row.value?.execution_status):null).filter(Boolean);
    if(states.length)state=states[0];
    if(blocked(state))throw fail(409,'员工正在等待用户确认或补充信息，请先在员工中心处理','bxagi_visual_approval_required');
    if(state==='running'||state==='loading'||state==='init')throw fail(409,'员工仍在执行上一轮任务，请等待其结束','bxagi_visual_employee_busy');
  }

  /** One scoped visual fix using the existing executable task; no agent or ad mutation. */
  async function repairVisualDelivery(id,authorization={},options={}){
    repairAuthorization(id,authorization);
    let job=await ownedJob(id);
    if(job.details.visualRepair)return {provider:'bxagi',job:publicJob(job),creatives:[],visualRepairAttempted:true,alreadyAttempted:true};
    if(job.status!=='completed'||job.details.kind!=='production'||job.details.remoteWritePending)throw fail(409,'仅可修复已回收且写入结果明确的生产成品','bxagi_visual_scope_invalid');
    const resources=await visualResources(options.resources);
    await collectionInputs(job);
    const operationId=crypto.randomUUID(),claimed=await repo.claimBxagiJobOperation(userId,id,operationId);
    if(!claimed)return {provider:'bxagi',job:publicJob(job),creatives:[],busy:true};
    job=claimed;let stage='preflight';
    try{
      if(job.details.visualRepair)return {provider:'bxagi',job:publicJob(job),creatives:[],visualRepairAttempted:true,alreadyAttempted:true};
      if(job.status!=='completed'||job.details.remoteWritePending)throw fail(409,'任务状态已变化，不能重复视觉修复','bxagi_visual_scope_invalid');
      await collectionInputs(job);
      const expectedFacts=['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺'];
      if(job.details.input.title!=='BXAGI 智能调度实测'||job.details.input.productName!=='流程验证素材'||JSON.stringify(job.details.input.facts)!==JSON.stringify(expectedFacts))throw fail(409,'固定字体子集仅用于本次流程测试文案','bxagi_visual_test_scope_invalid');
      const conversation=await collectionConversation(job,{requireExecutable:true});
      if(conversation.agent_type!=='CodeActAgent'||job.details.runtimeStatus!=='ready')throw fail(409,'视觉修复需已验证的CodeAct执行会话和运行时','bxagi_visual_agent_invalid');
      await visualApproval(conversation);
      if(typeof remote.readJobInput!=='function')throw fail(503,'视觉修复缺少实际输入读取能力','bxagi_visual_adapter_missing');
      const ids=job.details.resultCreativeIds;
      if(!Array.isArray(ids)||!ids.length||ids.length>12||new Set(ids).size!==ids.length)throw fail(409,'原始成品记录不完整','bxagi_visual_original_missing');
      const originals=await repo.listCreatives(userId,ids),images=originals.filter(row=>row.mimeType==='image/png');
      if(originals.length!==ids.length||!images.length||originals.some(row=>row.projectId!==job.projectId||row.metadata?.sourceJobId!==job.id||!sameBxagiIdentifier(row.metadata?.remoteConversationId,conversation.id)||!row.metadata?.remoteArtifactPath?.startsWith(`bxagi-advertising/${job.id}/output/`))||images.some(row=>!['draft','rejected'].includes(row.status)))throw fail(409,'只能修复当前任务未批准的实际PNG，原成品归属必须一致','bxagi_visual_original_invalid');
      if((await repo.listCampaigns(userId)).some(campaign=>campaign.creativeIds?.some(creativeId=>images.some(row=>row.id===creativeId))))throw fail(409,'已关联投放计划的素材不能通过测试修复修改','bxagi_visual_original_in_use');
      for(const image of images){const object=await bucket.get(image.objectKey);if(!object||object.size!==image.size)throw fail(409,'原始PNG存储记录不一致','bxagi_visual_original_missing');await byteMetadata(new Uint8Array(await object.arrayBuffer()),'image/png');}
      for(const source of job.details.uploadedAssets){
        const asset=await repo.getAsset(userId,source.id);
        if(typeof asset.metadata?.automationProbeId!=='string'||!asset.metadata.automationProbeId)throw fail(409,'视觉修复仅限授权流程验证输入','bxagi_visual_test_scope_invalid');
        const object=await bucket.get(asset.objectKey),original=await object.arrayBuffer(),response=await remote.readJobInput({conversation,relativePath:source.path}),bytes=await response.arrayBuffer();
        if(bytes.byteLength!==asset.size||bytes.byteLength>MAX_FILE||await sha256(bytes)!==await sha256(original))throw fail(409,'远端真实输入与用户源文件不一致','bxagi_visual_input_mismatch');
        job=await save(job,{details:{...job.details}});
      }
      const prefix=`bxagi-advertising/${job.id}`,response=await remote.readJobInput({conversation,relativePath:`${prefix}/input/brief.json`}),brief=await response.json();
      const expected=jobBrief(job);
      if(JSON.stringify(brief)!==JSON.stringify(expected))throw fail(409,'远端任务说明与已保存任务不一致','bxagi_visual_input_mismatch');
      repairAuthorization(id,authorization);
      const repair={revision:1,attemptId:crypto.randomUUID(),phase:'uploading',authorizedAt:new Date().toISOString(),authorizationExpiresAt:new Date(Date.parse(authorization.expiresAt)).toISOString(),originalResultCreativeIds:ids,originalMessageEventId:job.details.messageEventId||null,originalMessageSentAt:job.details.messageSentAt,inputsVerified:true,executionModeVerified:true,uploadedResources:[],semanticValidated:false};
      job=await save(job,{status:'uploading',details:{...job.details,visualRepair:repair,executionAgentType:'CodeActAgent'}});stage='recorded';
      for(const image of images)await repo.updateCreative(userId,image.id,{status:'rejected',metadata:{...image.metadata,semanticValidated:false,visualQualityRejected:true,visualRepairAttemptId:repair.attemptId}});
      for(const resource of resources){
        repairAuthorization(id,authorization);
        const fresh=await remote.getConversation(conversation.id);
        if(!sameBxagiIdentifier(fresh.id,conversation.id)||fresh.created_by_user_id!==context.subject||(fresh.employee_id||fresh.employeeId)!==job.details.employee.providerId||fresh.agent_type!=='CodeActAgent')throw fail(409,'字体传输前会话归属或执行模式发生变化','bxagi_visual_agent_invalid');
        await visualApproval(fresh);
        if(typeof remote.ensureRuntime!=='function'||(await remote.ensureRuntime({conversation:fresh}))?.status!=='ready')throw fail(409,'视觉修复需等待当前运行时就绪','bxagi_visual_runtime_not_ready');
        job=await save(job,{details:{...job.details,remoteWritePending:`upload_visual_resource:${resource.filename}`}});stage='upload';
        const receipt=await remote.uploadFile({conversationId:conversation.id,directory:`${prefix}/input`,filename:resource.filename,blob:resource.blob});
        if(receipt?.relativePath!==`${prefix}/input/${resource.filename}`||!Number.isInteger(receipt.transportStatus)||receipt.transportStatus<200||receipt.transportStatus>=300)throw Object.assign(fail(502,'字体资源上传结果尚未确认','bxagi_visual_upload_unconfirmed'),{uncertain:true});
        job=await save(job,{details:{...job.details,remoteWritePending:null,visualRepair:{...job.details.visualRepair,uploadedResources:[...job.details.visualRepair.uploadedResources,{filename:resource.filename,path:receipt.relativePath,size:resource.size,sha256:resource.sha256}]}}});stage='recorded';
      }
      repairAuthorization(id,authorization);
      const fresh=await collectionConversation(job,{requireExecutable:true});if(fresh.agent_type!=='CodeActAgent')throw fail(409,'修复期间执行模式发生变化，停止派发','bxagi_visual_agent_invalid');await visualApproval(fresh);
      job=await save(job,{status:'running',details:{...job.details,remoteWritePending:'send_visual_repair',visualRepair:{...job.details.visualRepair,phase:'sending'}}});stage='send';
      const receipt=await remote.sendMessage(fresh.id,visualPrompt(job)),eventId=receipt?.eventId;
      if(receipt?.messageAcknowledged!==true||!['bxagi_ws','bxagi_events'].includes(receipt.transport)||typeof eventId!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(eventId)||eventId.includes(context.accessToken)||/(?:bearer|secret|api[_-]?key|session[_-]?key|^sk[_-]|^[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$)/i.test(eventId))throw Object.assign(fail(502,'视觉修复指令尚未确认接收','bxagi_visual_message_unconfirmed'),{uncertain:true});
      stage='acknowledged';const sentAt=new Date().toISOString();
      job=await save(job,{status:'running',details:{...job.details,remoteWritePending:null,messageAcknowledged:true,messageSentAt:sentAt,messageEventId:eventId,messageTransport:receipt.transport,messageAlreadyDelivered:receipt.alreadyDelivered===true,executionStatus:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,visualRepair:{...job.details.visualRepair,phase:'sent',messageSentAt:sentAt,messageEventId:eventId,messageAcknowledged:true}}});
      return {provider:'bxagi',job:publicJob(job),creatives:[],visualRepairAttempted:true};
    }catch(error){
      if(stage==='preflight')throw error;
      const knownUnsent=stage==='send'&&error.messageSent===false&&error.uncertain===false;
      const uncertain=['upload','send','acknowledged'].includes(stage)&&!knownUnsent;
      job=await save(job,{status:uncertain?'needs_reconciliation':'failed',details:{...job.details,...(uncertain?{}:{remoteWritePending:null}),lastErrorCode:typeof error.code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code)?error.code:'bxagi_visual_repair_failed',lastErrorStatus:Number.isInteger(error.status)?error.status:null,lastError:uncertain?'视觉修复资源或指令提交结果待核对；不会自动重发':safeMessage(error),visualRepair:{...job.details.visualRepair,phase:uncertain?'needs_reconciliation':'failed'}}});
      return {provider:'bxagi',job:publicJob(job),creatives:[],visualRepairAttempted:true};
    }finally{await repo.releaseBxagiJobOperation(userId,id,operationId);}
  }

  /** One scoped correction of the observed showcase card-label layout. */
  async function repairShowcaseLayout(id,authorization={},options={}){
    repairAuthorization(id,authorization);
    let job=await ownedJob(id);
    const result=extra=>({provider:'bxagi',job:publicJob(job),creatives:[],visualRepairAttempted:true,...extra});
    if(job.details.visualRepair)return result({alreadyAttempted:true});
    const originalSha256=options.originalSha256;
    if(typeof originalSha256!=='string'||!/^[a-f0-9]{64}$/i.test(originalSha256))throw fail(403,'排版修复需要原视频完整SHA256证据','bxagi_showcase_source_required');
    const scope=()=>{const input=job.details.input;if(job.status!=='completed'||job.details.kind!=='production'||job.details.deliveryRepair||job.details.videoFormatRepair||hasUncertainBxagiWrite(job)||input?.title!==showcaseSpec.title||input.productName!==showcaseSpec.productName||JSON.stringify(input.facts)!==JSON.stringify(showcaseSpec.facts))throw fail(409,'只允许修正已经完整交付的原22秒演示任务','bxagi_showcase_scope_invalid');};
    scope();await collectionInputs(job);
    const operationId=crypto.randomUUID(),claimed=await repo.claimBxagiJobOperation(userId,id,operationId);
    if(!claimed)return result({busy:true});job=claimed;let stage='preflight';
    try{
      if(job.details.visualRepair)return result({alreadyAttempted:true});scope();await collectionInputs(job);
      if(typeof remote.readJobInput!=='function')throw fail(503,'排版修复缺少原始输入读取能力','bxagi_showcase_adapter_missing');
      const conversation=await collectionConversation(job,{requireExecutable:true});
      if(conversation.agent_type!=='CodeActAgent')throw fail(409,'排版修复需要原CodeActAgent执行会话','bxagi_showcase_agent_invalid');
      await visualApproval(conversation);
      const ids=job.details.resultCreativeIds;
      if(!Array.isArray(ids)||ids.length!==3||new Set(ids).size!==3)throw fail(409,'原视频、封面和说明归档记录不完整','bxagi_showcase_original_invalid');
      const originals=await repo.listCreatives(userId,ids),prefix=`bxagi-advertising/${job.id}`,mimes=['video/mp4','image/png','text/plain'];
      if(originals.length!==3||mimes.some(mime=>originals.filter(row=>row.mimeType===mime).length!==1)||originals.some(row=>row.userId!==userId||row.projectId!==job.projectId||row.metadata?.sourceJobId!==job.id||!sameBxagiIdentifier(row.metadata?.remoteConversationId,conversation.id)||!['draft','rejected'].includes(row.status)||!Array.isArray(row.sourceAssetIds)||row.sourceAssetIds.length!==job.details.assetIds.length||new Set(row.sourceAssetIds).size!==job.details.assetIds.length||row.sourceAssetIds.some(source=>!job.details.assetIds.includes(source))))throw fail(409,'原成品归属、来源或审批状态未通过验证','bxagi_showcase_original_invalid');
      if((await repo.listCampaigns(userId)).some(campaign=>campaign.creativeIds?.some(creativeId=>ids.includes(creativeId))))throw fail(409,'已关联投放计划的成品不能通过演示修复修改','bxagi_showcase_original_in_use');
      for(const original of originals){
        const path=resultPath(job,original.metadata.remoteArtifactPath,original);
        if(path!==original.metadata.remoteArtifactPath)throw fail(409,'原成品保存路径不完整','bxagi_showcase_original_invalid');
        const object=await bucket.get(original.objectKey);
        if(!object||object.size!==original.size||!Number.isSafeInteger(original.size)||original.size<=0||original.size>MAX_FILE)throw fail(409,'原成品存储记录不完整','bxagi_showcase_original_invalid');
        const bytes=new Uint8Array(await object.arrayBuffer()),dimensions=await byteMetadata(bytes,original.mimeType);
        if(bytes.byteLength!==original.size||original.mimeType==='video/mp4'&&(await sha256(bytes)!==originalSha256.toLowerCase()||dimensions.width!==720||dimensions.height!==1280||Math.abs(dimensions.duration-22)>0.05)||original.mimeType==='image/png'&&(dimensions.width!==720||dimensions.height!==1280))throw fail(409,'原视频SHA或真实成品规格与授权不一致','bxagi_showcase_source_mismatch');
      }
      let probeId;
      for(const source of job.details.uploadedAssets){
        const asset=await repo.getAsset(userId,source.id),bound=asset.metadata?.automationProbeId;
        if(typeof bound!=='string'||!bound||probeId&&bound!==probeId)throw fail(409,'原始素材不属于同一次演示试产','bxagi_showcase_scope_invalid');
        probeId=bound;
        const probe=await repo.getJob(userId,bound);
        if(!probe||probe.userId!==userId||probe.type!=='platform_automation_probe'||probe.projectId!==job.projectId||probe.details?.projectId!==job.projectId||probe.details.bxagiSubject!==context.subject||probe.details.purpose!=='production_only_verification'||probe.details.scenario!==showcaseSpec.scenario||probe.details.media!=='video')throw fail(409,'演示试产记录归属或场景未通过验证','bxagi_showcase_scope_invalid');
        const object=await bucket.get(asset.objectKey),original=await object.arrayBuffer(),response=await remote.readJobInput({conversation,relativePath:source.path}),bytes=await response.arrayBuffer();
        if(bytes.byteLength!==asset.size||bytes.byteLength>MAX_FILE||await sha256(bytes)!==await sha256(original))throw fail(409,'远端原输入与上传素材不一致','bxagi_showcase_input_mismatch');
        job=await save(job,{details:{...job.details}});
      }
      const response=await remote.readJobInput({conversation,relativePath:`${prefix}/input/brief.json`}),brief=await response.json(),expected=jobBrief(job);
      if(JSON.stringify(brief)!==JSON.stringify(expected))throw fail(409,'远端原始说明与任务快照不一致','bxagi_showcase_input_mismatch');
      repairAuthorization(id,authorization);
      const fresh=await collectionConversation(job,{requireExecutable:true});if(fresh.agent_type!=='CodeActAgent')throw fail(409,'原执行模式已变化','bxagi_showcase_agent_invalid');await visualApproval(fresh);
      const video=originals.find(row=>row.mimeType==='video/mp4'),repair={kind:'showcase_layout',revision:1,attemptId:crypto.randomUUID(),phase:'preparing',authorizedAt:new Date().toISOString(),authorizationExpiresAt:new Date(Date.parse(authorization.expiresAt)).toISOString(),originalSha256:originalSha256.toLowerCase(),originalSize:video.size,originalResultCreativeIds:ids,originalMessageEventId:job.details.messageEventId||null,originalMessageSentAt:job.details.messageSentAt,inputsVerified:true,executionModeVerified:true,semanticValidated:false};
      job=await save(job,{status:'starting',details:{...job.details,visualRepair:repair,resultCreativeIds:[],recovery:null,completedAt:null}});stage='recorded';
      for(const original of originals)await repo.updateCreative(userId,original.id,{status:'rejected',metadata:{...original.metadata,visualQualityRejected:true,semanticValidated:false,visualRepairAttemptId:repair.attemptId}});
      job=await save(job,{status:'running',details:{...job.details,remoteWritePending:'send_showcase_layout_repair',visualRepair:{...repair,phase:'sending'}}});stage='send';
      const receipt=await remote.sendMessage(fresh.id,showcaseLayoutPrompt(job)),eventId=receipt?.eventId;
      if(receipt?.messageAcknowledged!==true||!['bxagi_ws','bxagi_events'].includes(receipt.transport)||typeof eventId!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(eventId)||eventId.includes(context.accessToken)||/(?:bearer|secret|api[_-]?key|session[_-]?key|^sk[_-]|^[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$)/i.test(eventId))throw Object.assign(fail(502,'排版修复指令尚未确认接收','bxagi_showcase_message_unconfirmed'),{uncertain:true});
      stage='acknowledged';const sentAt=new Date().toISOString();
      job=await save(job,{status:'running',details:{...job.details,remoteWritePending:null,messageAcknowledged:true,messageSentAt:sentAt,messageEventId:eventId,messageTransport:receipt.transport,messageAlreadyDelivered:receipt.alreadyDelivered===true,executionStatus:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,visualRepair:{...job.details.visualRepair,phase:'sent',messageSentAt:sentAt,messageEventId:eventId,messageAcknowledged:true}}});return result();
    }catch(error){
      if(stage==='preflight')throw error;
      const knownUnsent=stage==='send'&&error.messageSent===false&&error.uncertain===false,uncertain=['send','acknowledged'].includes(stage)&&!knownUnsent;
      job=await save(job,{status:uncertain?'needs_reconciliation':'failed',details:{...job.details,...(uncertain?{}:{remoteWritePending:null}),lastErrorCode:typeof error.code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code)?error.code:'bxagi_showcase_layout_failed',lastErrorStatus:Number.isInteger(error.status)?error.status:null,lastError:uncertain?'排版修复发送结果待核对，不会再次发送':safeMessage(error),visualRepair:{...job.details.visualRepair,phase:uncertain?'needs_reconciliation':'failed'}}});return result();
    }finally{await repo.releaseBxagiJobOperation(userId,id,operationId);}
  }

  /** One explicitly authorized same-employee format repair; never resends an uncertain write. */
  async function repairVideoFormat(id,authorization={}){
    repairAuthorization(id,authorization);
    let job=await ownedJob(id);
    const result=extra=>({provider:'bxagi',job:publicJob(job),creatives:[],videoFormatRepairAttempted:true,...extra});
    if(job.details.videoFormatRepair)return result({alreadyAttempted:true});
    if(typeof authorization.originalSha256!=='string'||!/^[a-f0-9]{64}$/i.test(authorization.originalSha256))throw fail(403,'视频修复需已完整读取原件的SHA256证据','bxagi_video_repair_source_required');
    const scope=()=>{if(job.status!=='failed'||job.details.lastErrorCode!=='bxagi_invalid_artifact'||job.details.kind!=='production'||job.details.remoteWritePending||job.details.visualRepair)throw fail(409,'仅可修复已明确失败的原市场员工视频格式','bxagi_video_repair_scope_invalid');};
    scope();await collectionInputs(job);
    const operationId=crypto.randomUUID(),claimed=await repo.claimBxagiJobOperation(userId,id,operationId);
    if(!claimed)return result({busy:true});job=claimed;let stage='preflight';
    try{
      if(job.details.videoFormatRepair)return result({alreadyAttempted:true});scope();await collectionInputs(job);
      const facts=['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺'],project=await repo.getProject(userId,job.projectId);
      if([job.details.input,project].some(value=>value?.title!=='BXAGI视频生产实测'||value?.productName!=='流程验证素材'||JSON.stringify(value.facts)!==JSON.stringify(facts)))throw fail(409,'视频格式修复仅限本次真实试产项目','bxagi_video_repair_scope_invalid');
      for(const assetId of job.details.assetIds){const asset=await repo.getAsset(userId,assetId);if(typeof asset.metadata?.automationProbeId!=='string'||!asset.metadata.automationProbeId)throw fail(409,'视频格式修复输入不属于本次试产','bxagi_video_repair_scope_invalid');}
      const conversation=await collectionConversation(job,{requireExecutable:true});
      if(conversation.agent_type!=='CodeActAgent'||job.details.runtimeStatus!=='ready')throw fail(409,'视频格式修复需要原CodeAct执行会话','bxagi_video_repair_agent_invalid');
      await visualApproval(conversation);
      if(typeof remote.inspectJobFiles!=='function'||typeof remote.readJobInput!=='function')throw fail(503,'视频格式修复缺少实际任务读取能力','bxagi_video_repair_adapter_missing');
      const prefix=`bxagi-advertising/${job.id}`,manifest=await remote.readManifest({conversation,relativePath:`${prefix}/output/manifest.json`});
      if(manifest.version!==1||manifest.jobId!==id||manifest.kind!=='production'||!Array.isArray(manifest.creatives)||manifest.creatives.length!==3)throw fail(409,'原视频交付清单不匹配','bxagi_video_repair_source_invalid');
      const entries=manifest.creatives.map(entry=>({...entry,path:resultPath(job,entry?.path,entry)})),video=entries.find(entry=>entry.path===`${prefix}/output/video.mp4`&&entry.filename==='video.mp4'&&entry.mimeType==='video/mp4'),cover=entries.find(entry=>entry.path===`${prefix}/output/cover.png`&&entry.filename==='cover.png'&&entry.mimeType==='image/png'),notes=entries.find(entry=>entry.mimeType==='text/plain');
      if(!video||!cover||!notes||notes.path===`${prefix}/output/production_notes_h264.txt`||entries.some(entry=>!Array.isArray(entry.sourceAssetIds)||entry.sourceAssetIds.length!==job.details.assetIds.length||new Set(entry.sourceAssetIds).size!==job.details.assetIds.length||entry.sourceAssetIds.some(assetId=>!job.details.assetIds.includes(assetId))))throw fail(409,'原视频、封面或说明来源不匹配','bxagi_video_repair_source_invalid');
      const listing=await remote.inspectJobFiles({conversationId:conversation.id,jobId:id}),outputs=[listing?.conversation?.output,listing?.nodeProject?.output].filter(value=>value?.exists===true&&!value.truncated&&value.excludedEntryCount===0);
      if(!outputs.some(value=>entries.every(entry=>value.entries?.some(file=>file.type==='file'&&file.path===entry.path&&Number.isSafeInteger(file.size)&&file.size>0&&file.size<=MAX_FILE&&(entry!==video||file.size===12097373)))))throw fail(409,'原视频文件大小或现有封面说明未通过核验','bxagi_video_repair_source_invalid');
      const response=await remote.readJobInput({conversation,relativePath:`${prefix}/input/brief.json`}),brief=await response.json(),expected=jobBrief(job);
      if(JSON.stringify(brief)!==JSON.stringify(expected))throw fail(409,'视频试产原始说明与任务不一致','bxagi_video_repair_source_invalid');
      repairAuthorization(id,authorization);
      const fresh=await collectionConversation(job,{requireExecutable:true});if(fresh.agent_type!=='CodeActAgent')throw fail(409,'原执行模式已变化','bxagi_video_repair_agent_invalid');await visualApproval(fresh);
      const repair={revision:1,attemptId:crypto.randomUUID(),phase:'sending',authorizedAt:new Date().toISOString(),authorizationExpiresAt:new Date(Date.parse(authorization.expiresAt)).toISOString(),originalSha256:authorization.originalSha256.toLowerCase(),originalSize:12097373,originalVideoPath:video.path,originalCoverPath:cover.path,originalNotesPath:notes.path,originalMessageEventId:job.details.messageEventId||null,originalMessageSentAt:job.details.messageSentAt,executionModeVerified:true};
      job=await save(job,{status:'running',details:{...job.details,videoFormatRepair:repair,remoteWritePending:'send_video_format_repair'}});stage='send';
      const receipt=await remote.sendMessage(fresh.id,videoFormatPrompt(job)),eventId=receipt?.eventId;
      if(receipt?.messageAcknowledged!==true||receipt.transport!=='bxagi_ws'||typeof eventId!=='string'||!/^[a-zA-Z0-9_.:-]{1,160}$/.test(eventId)||eventId.includes(context.accessToken)||/(?:bearer|secret|api[_-]?key|session[_-]?key|^sk[_-]|^[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$)/i.test(eventId))throw Object.assign(fail(502,'视频修复指令尚未确认接收','bxagi_video_repair_message_unconfirmed'),{uncertain:true});
      stage='acknowledged';const sentAt=new Date().toISOString();
      job=await save(job,{status:'running',details:{...job.details,remoteWritePending:null,messageAcknowledged:true,messageSentAt:sentAt,messageEventId:eventId,messageTransport:receipt.transport,executionStatus:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,videoFormatRepair:{...repair,phase:'sent',messageSentAt:sentAt,messageEventId:eventId,messageAcknowledged:true}}});return result();
    }catch(error){
      if(stage==='preflight')throw error;
      const knownUnsent=stage==='send'&&error.messageSent===false&&error.uncertain===false,uncertain=!knownUnsent;
      job=await save(job,{status:uncertain?'needs_reconciliation':'failed',details:{...job.details,...(uncertain?{}:{remoteWritePending:null}),lastErrorCode:typeof error.code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code)?error.code:'bxagi_video_repair_failed',lastErrorStatus:Number.isInteger(error.status)?error.status:null,lastError:uncertain?'视频修复指令结果待核对，不重复发送':safeMessage(error),videoFormatRepair:{...job.details.videoFormatRepair,phase:uncertain?'needs_reconciliation':'failed'}}});return result();
    }finally{await repo.releaseBxagiJobOperation(userId,id,operationId);}
  }
  async function syncJob(id){
    let job=await ownedJob(id);
    await guardSavedEmployee(job);
    guardProbe(job.details.automationProbeExpiresAt);
    if(job.details.kind==='production')for(const assetId of job.details.assetIds||[]){const asset=await repo.getAsset(userId,assetId);guardProbe(asset?.metadata?.automationProbeExpiresAt);}
    if(!ACTIVE.has(job.status))return {provider:'bxagi',job:publicJob(job),creatives:[]};
    if(!bxagiRecoveryDue(job))return {provider:'bxagi',job:publicJob(job),creatives:[],waitingForRecovery:true};
    if(isCollectableBxagiProductionJob(job))return collectProduction(id);
    if(hasUncertainBxagiWrite(job))return {provider:'bxagi',job:publicJob(job),creatives:[]};
    const operationId=crypto.randomUUID();
    const claimed=await repo.claimBxagiJobOperation(userId,id,operationId);
    if(!claimed)return {provider:'bxagi',job:publicJob(job),creatives:[],busy:true};
    job=claimed;
    try{
      employeeCache=undefined;
      const currentMarket=(await catalog()).find(employee=>employee.id===job.details.employee.id&&employee.marketId===job.details.employee.marketId);
      assertMarketEmployee(currentMarket);
      if(currentMarket.providerId!==job.details.employee.providerId||currentMarket.conversationId!==job.details.employee.conversationId)assertMarketEmployee({...currentMarket,sourceVerified:false});

      if(job.details.kind==='production'&&job.details.productionSpec?.employeeMode!=='manual'&&!job.details.startTaskId&&(job.details.coordination||env.BXAGI_BUTLER_ENABLED===true||env.BXAGI_BUTLER_ENABLED==='true'||env.BXAGI_PLANNER_ENABLED===true||env.BXAGI_PLANNER_ENABLED==='true')){
        // A persisted coordinator keeps its protocol even if deployment flags change.
        const savedMode=job.details.coordination?.mode;
        if(savedMode&&!['official_butler','bxagi_employee_planner','rules'].includes(savedMode))throw fail(409,'已保存的协调方式未知，保留任务等待核对','bxagi_coordination_mode_invalid');
        const official=savedMode?savedMode==='official_butler':env.BXAGI_BUTLER_ENABLED===true||env.BXAGI_BUTLER_ENABLED==='true';
        const employees=await catalog(),planner=official?createBxagiButlerCoordinator({repository:repo,remote,context,fetcher,butler,bootstrap:butlerBootstrap,scoreEmployee:scoreBxagiMarketEmployee}):createBxagiPlanner({remote,context});
        const evidence=official?bxagiButlerCoordinationEvidence:bxagiPlannerEvidence;
        if(!job.details.coordination){
          const sourceAssets=await Promise.all(job.details.assetIds.map(assetId=>repo.getAsset(userId,assetId)));
          if(sourceAssets.some(asset=>!asset||asset.projectId!==job.projectId))throw fail(404,'智能协调来源素材不存在','not_found');
          const coordination=await planner.createState({parentJobId:job.id,project:job.details.input,assets:sourceAssets,employees,fallbackEmployee:job.details.employee});
          job=await save(job,{status:'starting',details:{...job.details,coordination}});
          return {provider:'bxagi',job:publicJob(job),creatives:[],coordination:evidence(coordination)};
        }
        const applyCoordination=async coordination=>{
          const decision=await planner.validateReady(coordination,employees,job.id);
          const routed=employees.find(e=>e.id===decision.productionEmployeeId&&isExecutableMarketEmployee(e));
          if(!routed)throw fail(409,'协调员所选生产员工已不可用','bxagi_planner_invalid_employee');
          const project=await repo.getProject(userId,job.projectId);
          if(!project)throw fail(404,'素材项目不存在','not_found');
          await repo.updateProject(userId,project.id,{productionEmployeeId:routed.id,assignment:{...project.assignment,productionEmployeeId:routed.id,productionEmployee:publicEmployee(routed,'production'),routingMode:official?'official_butler':'bxagi_employee_planner',coordination:decision,basis:[decision.reason]}});
          job=await save(job,{employeeId:routed.id,details:{...job.details,employee:routed,coordination:{...coordination,routingAppliedAt:new Date().toISOString()}}});
        };
        if(job.details.coordination.phase==='ready'&&!job.details.coordination.routingAppliedAt){
          await applyCoordination(job.details.coordination);
          return {provider:'bxagi',job:publicJob(job),creatives:[],coordination:evidence(job.details.coordination)};
        }
        if(!['ready','rules_fallback'].includes(job.details.coordination.phase)){
          const outcome=await planner.advance({state:job.details.coordination,employees,checkpoint:async coordination=>{job=await save(job,{status:'starting',details:{...job.details,coordination,remoteWritePending:coordination.remoteWritePending?'coordination:'+coordination.remoteWritePending:null}});}});
          if(outcome.decision)await applyCoordination(outcome.state);
          return {provider:'bxagi',job:publicJob(job),creatives:[],coordination:evidence(outcome.state)};
        }
      }
      if(!job.details.startTaskId){
        job=await save(job,{status:'starting',details:{...job.details,remoteWritePending:'create_conversation'}});
        const started=await remote.createConversation({employee:job.details.employee,jobId:job.id});
        if(!started?.startTaskId)throw Object.assign(fail(502,'BXAGI启动结果缺少真实任务ID'),{uncertain:true});
        job=await save(job,{status:'starting',details:{...job.details,recovery:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,startTaskId:started.startTaskId,remoteWritePending:null}});
        return {provider:'bxagi',job:publicJob(job),creatives:[]};
      }
      if(!job.details.conversationId){
        const task=await remote.getStartTask(job.details.startTaskId);
        if(task.status==='ERROR'||task.status==='FAILED')throw fail(422,'BXAGI员工会话启动失败，请检查员工和节点');
        if(task.status!=='READY')return {provider:'bxagi',job:publicJob(job),creatives:[]};
        if(!task.conversationId)throw fail(502,'BXAGI未返回可核实的会话ID');
        job=await save(job,{status:typeof remote.ensureRuntime==='function'?'starting':'uploading',details:{...job.details,conversationId:task.conversationId}});
        return {provider:'bxagi',job:publicJob(job),creatives:[]};
      }
      const rawConversation=await remote.getConversation(job.details.conversationId);
      const conversation={...rawConversation,employeeId:rawConversation.employeeId||rawConversation.employee_id,executionStatus:rawConversation.executionStatus||rawConversation.execution_status};
      if(typeof job.details.employee.providerId!=='string'||!job.details.employee.providerId||conversation.employeeId!==job.details.employee.providerId)throw fail(422,'BXAGI任务会话缺少与已选市场员工一致的实例标识，已停止后续操作','bxagi_task_employee_mismatch');
      if(job.details.kind==='production'&&['PlanAgent','ReadOnlyAgent'].includes(rawConversation.agent_type))throw fail(422,'BXAGI实际任务仍为规划或只读模式，尚未具备素材执行模式；已停止素材上传和指令派发','bxagi_execution_mode_invalid');
      if(!job.details.messageSentAt){
        // The official client separates start-task READY from runtime readiness.
        // Test-injected legacy adapters may omit this method; the actual BXAGI
        // adapter always supplies it. Recheck before each input/prompt write.
        if(typeof remote.ensureRuntime==='function'){
          const previous=job.details.runtimeStatus,runtime=await remote.ensureRuntime({conversation});
          if(!['ready','starting','missing'].includes(runtime?.status))throw fail(502,'BXAGI运行时状态尚不能确认','unexpected_runtime_response');
          const checkedAt=new Date().toISOString(),ready=runtime.status==='ready';
          job=await save(job,{status:ready?'uploading':'starting',details:{...job.details,runtimeStatus:runtime.status,runtimeCheckedAt:checkedAt,runtimeReadyAt:ready?job.details.runtimeReadyAt||checkedAt:null,lastError:ready?null:'等待BXAGI员工运行时启动，尚未上传素材或发送指令'}});
          if(!ready||previous!=='ready')return {provider:'bxagi',job:publicJob(job),creatives:[]};
        }
        if(!job.details.inputsReady){job=await uploadInputs(job,conversation);if(job.details.briefUploaded)job=await save(job,{details:{...job.details,inputsReady:true}});return {provider:'bxagi',job:publicJob(job),creatives:[]};}
        job=await save(job,{status:'running',details:{...job.details,remoteWritePending:'send_instruction'}});
        const receipt=await remote.sendMessage(job.details.conversationId,instruction(job));
        const eventId=receipt?.eventId,publicEventId=typeof eventId==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(eventId)&&!eventId.includes(context.accessToken)&&!/(?:bearer|secret|api[_-]?key|session[_-]?key|^sk[_-]|^[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}$)/i.test(eventId)?eventId:null;
        job=await save(job,{status:'running',details:{...job.details,recovery:null,lastError:null,lastErrorCode:null,lastErrorStatus:null,messageSentAt:new Date().toISOString(),remoteWritePending:null,messageAcknowledged:receipt?.messageAcknowledged===true,messageAlreadyDelivered:receipt?.alreadyDelivered===true,...(['bxagi_ws','bxagi_events'].includes(receipt?.transport)?{messageTransport:receipt.transport}:{}),...(publicEventId?{messageEventId:publicEventId}:{})}});
        return {provider:'bxagi',job:publicJob(job),creatives:[]};
      }
      return await readDelivery(job,conversation);
    }catch(error){
      job=await ownedJob(id);
      // The adapter's employee_unavailable is a local, pre-POST validation.
      // If availability changed between our snapshot and that preflight, read
      // it again before deciding this existing task needs human activation.
      if(job.details.remoteWritePending==='create_conversation'&&error.code==='employee_unavailable'&&error.status===409&&error.uncertain!==true){
        try{employeeCache=undefined;assertMarketEmployee((await catalog()).find(employee=>employee.id===job.details.employee.id));}
        catch(current){if(BXAGI_AVAILABILITY_CODES.has(current.code)&&current.status===503)error=Object.assign(current,{writeSent:false,uncertain:false});}
      }
      const definiteUnsent=job.details.remoteWritePending==='send_instruction'&&error.messageSent===false&&error.uncertain===false||job.details.remoteWritePending==='create_conversation'&&error.writeSent===false&&error.uncertain===false;
      const uncertain=!definiteUnsent&&(error.uncertain===true||(job.details.remoteWritePending&&(!error.status||error.status>=500)));
      const transient=!uncertain&&isTransientBxagiError(error),authRequired=!uncertain&&[401,403].includes(error.status);
      const lastErrorCode=typeof error.code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code)?error.code:'bxagi_workflow_error',lastErrorStatus=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:null;
      job=await save(job,{status:uncertain?'needs_reconciliation':transient||authRequired?'awaiting_result':'failed',details:{...job.details,recovery:transient?nextBxagiRecovery(job.details.recovery,error.code):null,lastErrorCode,lastErrorStatus,lastError:uncertain?'BXAGI创建或指令提交结果不明，请先在员工中心核对；系统不会重复提交':safeMessage(error),...(uncertain?{}:{remoteWritePending:null})}});
      return {provider:'bxagi',job:publicJob(job),creatives:[]};
    }finally{await repo.releaseBxagiJobOperation(userId,id,operationId);}
  }
  return {catalog,submitProduction,submitBuying,syncJob,collectProduction,repairDelivery,repairVisualDelivery,repairShowcaseLayout,repairVideoFormat};
}

export async function syncDueBxagiJobs({repository,bucket,env,fetcher=fetch,adsService,resolveContext}){
  const results=[],newlyQueued=new Set();
  // An opted-in campaign's real feedback can start the next production round
  // while the UI is closed. No new media spend or hiring is authorized here.
  const tasks=repository.listPendingBxagiOptimizations?await repository.listPendingBxagiOptimizations(2):[];
  for(const task of tasks){
    try{
      const context=await resolveContext(task.userId,env,{fetcher,required:true});
      if(!context)continue;
      const project=await repository.getProject(task.userId,task.projectId);
      if(!project)continue;
      const outcome=await createBxagiOrchestrator({repository,bucket,env,context,fetcher,adsService}).submitProduction(project,{optimizationTaskId:task.id});
      if(outcome.job){newlyQueued.add(outcome.job.id);results.push({id:outcome.job.id,status:outcome.job.status,optimizationTaskId:task.id});}
    }catch(error){
      if(![401,403,409].includes(error.status))await repository.updateOptimizationTask(task.userId,task.id,{metadata:{...task.metadata,lastBxagiError:safeMessage(error),nextBxagiAttemptAt:new Date(Date.now()+300000).toISOString()}});
    }
  }
  const jobs=(await repository.listDueBxagiJobs(3)).filter(job=>!newlyQueued.has(job.id)&&bxagiRecoveryDue(job));
  for(const job of jobs){
    try{
      const context=await resolveContext(job.userId,env,{fetcher,required:true});
      if(!context||context.subject!==job.details?.bxagiSubject){results.push({id:job.id,status:'requires_login'});continue;}
      const orchestration=createBxagiOrchestrator({repository,bucket,env,context,fetcher,adsService});
      const result=isAutomaticallyRecoverableBxagiProductionJob(job)?await orchestration.collectProduction(job.id):await orchestration.syncJob(job.id);
      results.push({id:job.id,status:result.job.status});
    }catch{results.push({id:job.id,status:'connection_unavailable'});}
  }
  return {processed:results.length,results};
}
