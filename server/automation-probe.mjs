import { createPlatformRepository } from './platform-repository.mjs';
import { resolveBxagiContextForUser } from './bxagi-auth.mjs';
import { createAutomaticFlow,describeAutomaticFlow } from './automatic-flow.mjs';
import { createBxagiOrchestrator,chooseBxagiEmployee,scoreBxagiMarketEmployee,bxagiProductionCollectionEligibility } from './bxagi-orchestrator.mjs';
import { publicMarketSelection } from './bxagi-market-eligibility.mjs';
import { createBxagiMarketplace } from './bxagi-marketplace.mjs';
import { createBxagiWorkforce } from './bxagi-workforce.mjs';
import { sameBxagiIdentifier } from './bxagi-identifiers.mjs';
import { isExecutableMarketEmployee } from './bxagi-market-eligibility.mjs';
import { workflowFontResources } from './bxagi-workflow-font.mjs';
import { showcaseSpec } from './bxagi-showcase.mjs';
import { showcaseFontResources } from './bxagi-showcase-font.mjs';
import { createBxagiButler } from './bxagi-butler.mjs';
import { createBxagiButlerCoordinator, bxagiButlerCoordinationEvidence } from './bxagi-butler-coordinator.mjs';
import { createProductionService } from './production-service.mjs';
const packageScenario='package-v1';
const packageProductionSpec={targetCount:1,mediaType:'video',format:'portrait',employeeMode:'auto',instructions:'严格按本素材包 description 中的完整六镜头分镜，实际制作一条22.00秒（528帧）、720×1280、24fps、H.264/yuv420p/faststart、含真实原创AAC音轨的竖屏视频，文件小于16MiB。使用本批真实屏幕文案和许可字体；六镜头须有独立构图和主体运动，不能用静态海报推拉替代。另交付720×1280 RGB PNG封面和UTF-8 TXT制作说明；manifest将视频标记role:primary，封面role:cover，说明role:notes，只有视频计入1条主成品。实际全段解码并检查六个代表帧、中文、音轨和大小，记录真实结果。全部文件写在本任务output目录，禁止复制历史成品冒充新产出。排版特别要求：卡片标签必须按卡片自身中心定位，不能全部按画布中心绘制；检查镜头3与6的标签不重叠、不越界。保留原 sourceText 字符，不新增字库缺失的文案。仅进行素材生产及归档，不创建或启动广告投放，不购买、续费或新增部署。'};
const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
const hashBytes=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const maxArtifactBytes=16*1024*1024;
const localArtifactValidationReasons=new Set(['BXAGI成果必须在当前任务的专属交付目录','员工交付的MP4文件内容不正确','MP4区块被截断','MP4区块长度无效','MP4文件类型区块无效','MP4包含多个影片元数据区块','MP4轨道媒体信息缺失或重复','MP4轨道类型信息无效','MP4包含多个视频轨道，无法确认唯一投放画面','MP4视频尺寸或时长信息缺失或重复','MP4视频尺寸或时长区块不完整','MP4视频实际尺寸无效','MP4视频实际时长缺失或无效','MP4视频实际时长无效','MP4缺少完整视频轨道或媒体数据']);
const validationReason=job=>job?.details?.lastErrorCode==='bxagi_invalid_artifact'&&localArtifactValidationReasons.has(job.details.lastError)?job.details.lastError:null;
const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
// Transfer integrity only: deliberately does not validate tracks, codecs or quality.
function assertCompleteOriginalMp4(bytes){
  if(!bytes.byteLength||bytes.byteLength>maxArtifactBytes)fail(502,'production_original_incomplete');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),types=new Set();let offset=0;
  while(offset<bytes.length){
    if(bytes.length-offset<8)fail(502,'production_original_incomplete');
    let size=view.getUint32(offset),header=8;
    const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
    if(size===1){if(bytes.length-offset<16)fail(502,'production_original_incomplete');const extended=view.getBigUint64(offset+8);if(extended>BigInt(bytes.length-offset))fail(502,'production_original_incomplete');size=Number(extended);header=16;}
    else if(size===0)size=bytes.length-offset;
    if(size<header||size>bytes.length-offset)fail(502,'production_original_incomplete');
    types.add(type);offset+=size;
  }
  if(!['ftyp','moov','mdat'].every(type=>types.has(type)))fail(502,'production_original_incomplete');
}
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
// Only static, locally generated marketplace diagnostics may leave this private
// verification endpoint. Upstream bodies, settings and credentials stay private.
const marketDiagnostic=error=>typeof error?.marketDiagnostic==='string'&&error.marketDiagnostic.startsWith('BXAGI ')?error.marketDiagnostic.slice(0,160):undefined;
const executionStates=new Set(['loading','init','idle','running','paused','stopped','finished','rejected','error','stuck','rate_limited','awaiting_user_confirmation','waiting_for_confirmation','user_confirmed','user_rejected','awaiting_user_input']);
const executionState=value=>typeof value==='string'&&executionStates.has(value.toLowerCase())?value.toLowerCase():null;
const eventKinds=new Set(['MessageEvent','ActionEvent','ObservationEvent','StateEvent','StateChangeEvent','AgentStateChangedEvent','ConversationStateUpdateEvent','AgentErrorEvent','ConversationErrorEvent']);
const eventSources=new Set(['user','agent','environment','system','server']);
const uuid=/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i;
function manifestPathShape(value,jobId){
  const path=value?.path,prefix=`bxagi-advertising/${jobId}/output/`,basename=name=>typeof name==='string'&&name.length>0&&name.length<=180&&!/[\/\\%?#\x00-\x1f\x7f]/.test(name)&&!name.includes('..')&&name!=='.';
  const shape=typeof path!=='string'?'other':path.startsWith(prefix)&&basename(path.slice(prefix.length))?'exact_job_relative':basename(path)?'bare_filename':path.startsWith('output/')&&basename(path.slice(7))?'output_relative':path.startsWith('/')?'absolute':'other';
  return {mimeType:['image/png','video/mp4','text/plain'].includes(value?.mimeType)?value.mimeType:'other',shape};
}
async function butlerDiagnosticReply(record,context,fetcher,{readReport=false,busy=false,dispatchDiagnostic}={}){
  let report;
  if(readReport&&record.status==='advice_dispatched'&&typeof record.details.conversationId==='string'&&uuid.test(record.details.conversationId)){
    try{
      const remote=createBxagiWorkforce({accessToken:context.accessToken,subject:context.subject,fetcher,timeoutMs:5000}),conversation=await remote.getConversation(record.details.conversationId);
      if(!sameBxagiIdentifier(conversation.id,record.details.conversationId)||conversation.created_by_user_id!==context.subject)fail(409,'butler_diagnostic_conversation_mismatch');
      report=await remote.getDeliveryReport({conversationId:conversation.id,jobId:record.details.productionJobId});
    }catch{report={readOnly:true,errorCode:'butler_diagnostic_report_unavailable'};}
  }
  return reply({diagnosticId:record.id,productionJobId:record.details.productionJobId,status:record.status,clientMessageId:record.details.clientMessageId,conversationId:record.details.conversationId||null,accepted:record.status==='advice_dispatched',busy,dispatchOutcomeUnknown:record.status==='advice_needs_reconciliation'||!!record.details.remoteWritePending,lastErrorCode:record.details.lastErrorCode||null,...(report?{report}:{}),...(dispatchDiagnostic?{dispatchDiagnostic}:{}),adviceAutomaticallyApplied:false,productionCompleted:false,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
}
async function productionEventDiagnostics(job,context,fetcher){
  try{
    const remote=createBxagiWorkforce({accessToken:context.accessToken,subject:context.subject,fetcher,timeoutMs:5000});
    const conversation=await remote.getConversation(job.details.conversationId);
    if(!sameBxagiIdentifier(conversation.id,job.details.conversationId)||conversation.created_by_user_id!==context.subject||typeof job.details.employee?.providerId!=='string'||!job.details.employee.providerId||conversation.employee_id!==job.details.employee.providerId)return {readOnly:true,errorCode:'diagnostic_conversation_mismatch'};
    const rows=(await remote.getEvents(conversation.id)).slice(0,100);
    const safeId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(value)&&!value.includes(context.accessToken)&&!/(?:bearer|secret|api[_-]?key|session[_-]?key|^sk[_-])/i.test(value)?value:null;
    return {readOnly:true,executionStatus:executionState(conversation.execution_status),counts:{total:rows.length,userMessages:rows.filter(e=>e.kind==='MessageEvent'&&e.source==='user').length,agentMessages:rows.filter(e=>e.kind==='MessageEvent'&&e.source==='agent').length,actions:rows.filter(e=>e.kind==='ActionEvent').length,observations:rows.filter(e=>e.kind==='ObservationEvent').length,finishActions:rows.filter(e=>e.action?.kind==='FinishAction').length,other:rows.filter(e=>!eventKinds.has(e.kind)||!eventSources.has(e.source)).length},events:rows.slice(0,20).map(e=>({id:safeId(e.id),kind:eventKinds.has(e.kind)?e.kind:'other',source:eventSources.has(e.source)?e.source:'other',timestamp:typeof e.timestamp==='string'&&Number.isFinite(Date.parse(e.timestamp))?new Date(e.timestamp).toISOString():null,...(e.key==='execution_status'&&executionState(e.value)?{execution_status:executionState(e.value)}:{})}))};
  }catch(error){const allowed=new Set(['workforce_unauthorized','workforce_forbidden','conversation_not_found','conversation_owner_mismatch','upstream_request_failed','upstream_unavailable','unexpected_response','response_too_large','upstream_stream_failed','redirect_refused']);return {readOnly:true,errorCode:allowed.has(error.code)?error.code:'diagnostic_unavailable'};}
}
/** Short-lived production verification for one fixed verified owner.
 * Only the ordinary scheduler may enable a verified free Solo market employee;
 * callers cannot select accounts, projects, fees, employees or advertising. */
export async function handleAutomationProbe(request,env,injected={}) {
  try {
    const nodeInspection=new URL(request.url).pathname==='/api/v2/worker/node-inspection';
    const inspection=new URL(request.url).pathname==='/api/v2/worker/market-inspection';
    const productionInspection=new URL(request.url).pathname==='/api/v2/worker/production-inspection';
    const productionCollection=new URL(request.url).pathname==='/api/v2/worker/production-collection';
    const productionRepair=new URL(request.url).pathname==='/api/v2/worker/production-repair';
    const productionVisualRepair=new URL(request.url).pathname==='/api/v2/worker/production-visual-repair';
    const productionVideoFormatRepair=new URL(request.url).pathname==='/api/v2/worker/production-video-format-repair';
    const productionShowcaseLayoutRepair=new URL(request.url).pathname==='/api/v2/worker/production-showcase-layout-repair';
    const productionArtifact=new URL(request.url).pathname==='/api/v2/worker/production-artifact';
    const productionOriginal=new URL(request.url).pathname==='/api/v2/worker/production-original';
    const butlerDiagnostic=new URL(request.url).pathname==='/api/v2/worker/butler-diagnostic';
    const butlerInspection=new URL(request.url).pathname==='/api/v2/worker/butler-inspection';
    const butlerBootstrap=new URL(request.url).pathname==='/api/v2/worker/butler-bootstrap';
    if(nodeInspection){if(!['node-inspection','production-recovery'].includes(env.AUTOMATION_PROBE_MODE))fail(503,'node_inspection_disabled');}
    else if(butlerInspection||butlerBootstrap){if(env.AUTOMATION_PROBE_MODE!=='butler-recovery')fail(503,'butler_recovery_disabled');}
    else if(productionShowcaseLayoutRepair?env.AUTOMATION_PROBE_MODE!=='showcase-layout-repair':productionVideoFormatRepair?env.AUTOMATION_PROBE_MODE!=='production-video-format-repair':butlerDiagnostic?env.AUTOMATION_PROBE_MODE!=='butler-diagnostic':productionVisualRepair?env.AUTOMATION_PROBE_MODE!=='production-visual-repair':productionRepair?env.AUTOMATION_PROBE_MODE!=='production-repair':productionOriginal?!['production-recovery','production-repair','production-visual-repair','butler-diagnostic'].includes(env.AUTOMATION_PROBE_MODE):productionCollection||productionArtifact?!['production-recovery','production-repair','production-visual-repair','production-video-format-repair','butler-diagnostic','showcase-layout-repair'].includes(env.AUTOMATION_PROBE_MODE):productionInspection?!['production-inspection','production-recovery','production-repair','production-visual-repair','production-video-format-repair','butler-diagnostic','showcase-layout-repair'].includes(env.AUTOMATION_PROBE_MODE):inspection?!['market-inspection','production-market'].includes(env.AUTOMATION_PROBE_MODE):env.AUTOMATION_PROBE_MODE!=='production-market')fail(503,'automation_probe_disabled');
    const expiry=Date.parse(env.AUTOMATION_PROBE_EXPIRES_AT||''),remaining=expiry-Date.now();
    const owner=env.AUTOMATION_PROBE_OWNER,secret=env.AUTOMATION_PROBE_SECRET;
    if(typeof owner!=='string'||!owner||typeof secret!=='string'||secret.length<32||!Number.isFinite(expiry)||remaining<=0||remaining>3600000)fail(503,'automation_probe_disabled');
    if(request.method!=='POST'||new URL(request.url).search)fail(400,'automation_probe_parameters_refused');
    const auth=request.headers.get('Authorization')||'';
    if(auth.length>1024||await hash(auth)!==await hash(`Bearer ${secret}`))fail(401,'automation_probe_unauthorized');
    const origin=request.headers.get('Origin');
    if(request.headers.get('Sec-Fetch-Site')==='cross-site'||(origin&&origin!==new URL(request.url).origin))fail(403,'cross_site_request');
    if(request.body){const reader=request.body.getReader();try{const {value,done}=await reader.read();if(!done&&value?.byteLength)fail(400,'automation_probe_parameters_refused');}finally{await reader.cancel().catch(()=>{});}}
    const context=await (injected.resolveContext||resolveBxagiContextForUser)(owner,env,{fetcher:injected.fetcher,required:true});
    if(!context||context.userId!==owner||!context.subject)fail(401,'automation_probe_identity_invalid');
    if(nodeInspection){
      const {createBxagiNodeHealth}=await import('./bxagi-node-health.mjs');
      return reply(await createBxagiNodeHealth({repository:injected.repository||createPlatformRepository(env.DB),context,fetcher:injected.fetcher}).inspect());
    }
    if(butlerInspection||butlerBootstrap){
      const {createBxagiButlerBootstrap}=await import('./bxagi-butler-bootstrap.mjs');
      const repo=injected.repository||createPlatformRepository(env.DB);
      const bootstrap=(injected.createButlerBootstrap||createBxagiButlerBootstrap)({repository:repo,context,fetcher:injected.fetcher});
      const result=butlerBootstrap?await bootstrap.ensure({authorizationExpiresAt:new Date(expiry).toISOString()}):await bootstrap.inspect({includeSchedulePolicy:true});
      return reply({readOnly:butlerInspection,bootstrap:result,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
    }
    const media=env.AUTOMATION_PROBE_MEDIA==='video'?'video':'image',productionMime=media==='video'?'video/mp4':'image/png';
    if(productionInspection||productionCollection||productionRepair||productionVisualRepair||productionVideoFormatRepair||productionShowcaseLayoutRepair||productionArtifact||productionOriginal||butlerDiagnostic){
      const repo=injected.repository||createPlatformRepository(env.DB),jobId=env.AUTOMATION_PROBE_JOB_ID;
      if(typeof jobId!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(jobId))fail(503,'production_inspection_disabled');
      const job=await repo.getJob(owner,jobId);
      if(!job||job.userId!==owner||job.type!=='bxagi_workflow'||job.details?.kind!=='production'||job.details.bxagiSubject!==context.subject||job.employeeId!==job.details.employee?.id||!isExecutableMarketEmployee(job.details.employee)||!Number.isFinite(Date.parse(job.details.messageSentAt))||!job.details.conversationId)fail(409,'production_inspection_scope_invalid');
      if(productionOriginal){
        const project=await repo.getProject(owner,job.projectId);
        if(media!=='video'||project?.title!=='BXAGI视频生产实测'||JSON.stringify(project.facts)!==JSON.stringify(['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺'])||job.status!=='failed'||job.details.lastErrorCode!=='bxagi_invalid_artifact'||job.details.messageAcknowledged!==true||job.details.remoteWritePending)fail(409,'production_original_scope_invalid');
        const ids=job.details.assetIds;
        if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length)fail(409,'production_original_sources_invalid');
        for(const id of ids){const asset=await repo.getAsset(owner,id);if(!asset||asset.projectId!==job.projectId)fail(409,'production_original_sources_invalid');}
        const remote=createBxagiWorkforce({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher,timeoutMs:5000,artifactTimeoutMs:120000}),conversation=await remote.getConversation(job.details.conversationId);
        if(!sameBxagiIdentifier(conversation.id,job.details.conversationId)||conversation.created_by_user_id!==context.subject||conversation.employee_id!==job.details.employee.providerId)fail(409,'production_original_conversation_mismatch');
        const prefix=`bxagi-advertising/${job.id}/output/`,path=prefix+'video.mp4',manifest=await remote.readManifest({conversation,relativePath:prefix+'manifest.json'});
        if(manifest.version!==1||manifest.jobId!==job.id||manifest.kind!=='production'||!Array.isArray(manifest.creatives)||!manifest.creatives.length||manifest.creatives.length>12)fail(422,'production_original_manifest_invalid');
        const videos=manifest.creatives.filter(entry=>entry?.mimeType==='video/mp4'||entry?.filename==='video.mp4'||entry?.path===path||entry?.path==='video.mp4'),video=videos[0];
        if(videos.length!==1||video.filename!=='video.mp4'||video.mimeType!=='video/mp4'||!['video.mp4',path].includes(video.path)||!Array.isArray(video.sourceAssetIds)||!video.sourceAssetIds.length||new Set(video.sourceAssetIds).size!==video.sourceAssetIds.length||video.sourceAssetIds.some(id=>!ids.includes(id)))fail(422,'production_original_manifest_invalid');
        if(Date.now()>=expiry)fail(503,'automation_probe_disabled');
        const original=await remote.readArtifact({conversation,relativePath:path,maxBytes:maxArtifactBytes}),length=original.headers.get('Content-Length'),bytes=new Uint8Array(await original.arrayBuffer());
        if(length!==null&&(!/^\d+$/.test(length)||Number(length)!==bytes.byteLength))fail(502,'production_original_incomplete');
        assertCompleteOriginalMp4(bytes);
        // Diagnostic download only. Never create a creative or mark this job complete.
        return new Response(bytes,{headers:{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="BXAGI_original_unverified.mp4"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Artifact-Validation':'unverified','Content-Length':String(bytes.byteLength)}});
      }
      if(butlerDiagnostic){
        const id=`butler-diagnostic-${(await hash(`${owner}\0${context.subject}\0${job.id}\0butler-diagnostic`)).slice(0,32)}`;
        const text=`只做建议，不执行任务。匿名视频测试素材任务 ${job.id} 曾报告缺少cv2/imageio；现在已生成文件，但清单路径不符合任务专属目录，视频编码与播放尚未验证，尚无验收通过MP4。请说明原因、仅利用现有已安装工具的可行路线、可供核验的市场岗位建议、需补齐工具及清单交付建议；最多6步。不审查原文件，不声称已验收。不要继续原任务、开始生产或执行修复，不安装、下载、雇佣、购买、续费、投放，不修改预算，不访问凭据或其他用户文件。只返回诊断建议，不自动执行任何建议。`;
        const textHash=await hash(text),existing=await repo.getJob(owner,id);
        const validate=record=>{if(!record||record.userId!==owner||record.type!=='bxagi_butler_diagnostic'||record.projectId!==job.projectId||record.details?.bxagiSubject!==context.subject||record.details.productionJobId!==job.id||record.details.fixedTextHash!==textHash||typeof record.details.clientMessageId!=='string'||!/^[a-f\d]{32}$/.test(record.details.clientMessageId))fail(409,'butler_diagnostic_record_mismatch');};
        if(existing){
          validate(existing);let record=existing,dispatchDiagnostic;
          if(['advice_needs_reconciliation','advice_failed_remote'].includes(record.status)){
            try{
              const reader=createBxagiButler({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher,timeoutMs:5000});
              dispatchDiagnostic=await reader.readDispatchDiagnostic({clientMessageId:record.details.clientMessageId});
              if(record.status==='advice_needs_reconciliation'&&dispatchDiagnostic.found===true&&dispatchDiagnostic.clientMessageId===record.details.clientMessageId&&dispatchDiagnostic.status==='failed')record=await repo.updateJob(owner,record.id,{status:'advice_failed_remote',details:{...record.details,remoteWritePending:null,remoteStatus:'failed',reconciledAt:new Date().toISOString()}});
            }catch{dispatchDiagnostic={readOnly:true,errorCode:'butler_dispatch_diagnostic_unavailable',failureMessage:null};}
          }
          return butlerDiagnosticReply(record,context,injected.fetcher,{readReport:true,dispatchDiagnostic});
        }
        const project=await repo.getProject(owner,job.projectId);
        if(project?.title!=='BXAGI视频生产实测'||JSON.stringify(project.facts)!==JSON.stringify(['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺'])||job.status==='completed'||job.status==='needs_reconciliation'||job.details.remoteWritePending||job.details.messageAcknowledged!==true)fail(409,'butler_diagnostic_production_scope_invalid');
        for(const creativeId of (job.details.resultCreativeIds||[]).slice(0,12)){const creative=await repo.getCreative(owner,creativeId);if(creative?.projectId===job.projectId&&creative.metadata?.sourceJobId===job.id&&creative.mimeType==='video/mp4'&&creative.status!=='rejected')fail(409,'butler_diagnostic_video_already_exists');}
        const remote=createBxagiWorkforce({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher,timeoutMs:5000}),conversation=await remote.getConversation(job.details.conversationId);
        if(!sameBxagiIdentifier(conversation.id,job.details.conversationId)||conversation.created_by_user_id!==context.subject||conversation.employee_id!==job.details.employee.providerId)fail(409,'butler_diagnostic_production_conversation_mismatch');
        const butler=createBxagiButler({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher,timeoutMs:5000,enableCoordinationDispatch:true});
        if((await butler.inspectCapabilities()).enabled!==true||typeof butler.dispatchCoordination!=='function')fail(409,'butler_diagnostic_capability_unavailable');
        if(Date.now()>=expiry)fail(503,'automation_probe_disabled');
        const now=new Date().toISOString(),clientMessageId=crypto.randomUUID().replaceAll('-','');
        const reservation=await env.DB.prepare("INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details) VALUES (?,?,?,?,?,'','bxagi_butler_diagnostic','advice_preparing',?) ON CONFLICT(id) DO NOTHING")
          .bind(id,owner,now,now,job.projectId,JSON.stringify({provider:'bxagi_butler',purpose:'bounded_coordination_diagnostic',bxagiSubject:context.subject,productionJobId:job.id,clientMessageId,fixedTextHash:textHash,authorizationExpiresAt:new Date(expiry).toISOString(),adviceAutomaticallyApplied:false})).run();
        let record=await repo.getJob(owner,id);validate(record);
        if(Number(reservation.meta?.changes??reservation.changes??0)===0)return butlerDiagnosticReply(record,context,injected.fetcher);
        const operationId=crypto.randomUUID(),claimed=await repo.claimBxagiJobOperation(owner,id,operationId);
        if(!claimed)return butlerDiagnosticReply(record,context,injected.fetcher,{busy:true});
        record=claimed;let writeAttempted=false;
        try{
          if(record.status!=='advice_preparing'||record.details.remoteWritePending)return butlerDiagnosticReply(record,context,injected.fetcher);
          if(Date.now()>=expiry)fail(503,'automation_probe_disabled');
          record=await repo.updateJob(owner,id,{details:{...record.details,remoteWritePending:'dispatch_butler_diagnostic',attemptedAt:new Date().toISOString(),operationExpiresAt:new Date(Date.now()+120000).toISOString()}});
          writeAttempted=true;
          const receipt=await butler.dispatchCoordination({text,clientMessageId:record.details.clientMessageId});
          if(receipt?.accepted!==true||receipt.clientMessageId!==record.details.clientMessageId||typeof receipt.conversationId!=='string'||!uuid.test(receipt.conversationId)||receipt.conversationId.includes(context.accessToken)||receipt.outcomeUnknown!==false)throw Object.assign(new Error('butler_diagnostic_receipt_unconfirmed'),{code:'butler_diagnostic_receipt_unconfirmed',outcomeUnknown:true});
          record=await repo.updateJob(owner,id,{status:'advice_dispatched',details:{...record.details,remoteWritePending:null,conversationId:receipt.conversationId,acceptedAt:new Date().toISOString(),lastErrorCode:null}});
          return butlerDiagnosticReply(record,context,injected.fetcher);
        }catch(error){
          const unknown=writeAttempted&&!(error.outcomeUnknown===false&&(error.writeSent===false||[400,401,403,404,422,429].includes(error.status)));
          const code=typeof error.code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.code)?error.code:'butler_diagnostic_failed';
          record=await repo.updateJob(owner,id,{status:unknown?'advice_needs_reconciliation':'advice_refused',details:{...record.details,...(unknown?{}:{remoteWritePending:null}),lastErrorCode:code,lastErrorStatus:Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:null}});
          return butlerDiagnosticReply(record,context,injected.fetcher);
        }finally{await repo.releaseBxagiJobOperation(owner,id,operationId);}
      }
      if(productionArtifact){
        // An individually verified archive can be inspected before the whole
        // manifest finishes. A completed label cannot bypass ACK or an unknown
        // subsequent write; this route only reads already imported R2 objects.
        if(!bxagiProductionCollectionEligibility(job,{userId:owner,subject:context.subject}).eligible)fail(409,'production_artifact_not_ready');
        const mime=env.AUTOMATION_PROBE_ARTIFACT_KIND==='video'?'video/mp4':'image/png',filename=mime==='video/mp4'?'BXAGI_workflow_test.mp4':'BXAGI_workflow_test.png';
        for(const id of (job.details.resultCreativeIds||[]).slice(0,12)){
          const creative=await repo.getCreative(owner,id);
          if(!creative||creative.userId!==owner||creative.projectId!==job.projectId||creative.metadata?.sourceJobId!==job.id||creative.status==='rejected'||creative.mimeType!==mime||!Number.isSafeInteger(creative.size)||creative.size<=0||creative.size>maxArtifactBytes)continue;
          const object=await env.BUCKET.get(creative.objectKey);
          if(!object||object.size!==creative.size){await object?.body?.cancel?.().catch(()=>{});continue;}
          return new Response(object.body,{headers:{'Content-Type':mime,'Content-Length':String(creative.size),'Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
        }
        fail(404,'production_artifact_not_found');
      }
      if(productionShowcaseLayoutRepair){
        const originalSha256=env.AUTOMATION_PROBE_ORIGINAL_SHA256;
        if(media!=='video'||typeof originalSha256!=='string'||!/^[a-f\d]{64}$/i.test(originalSha256))fail(503,'production_showcase_layout_disabled');
        const orchestrator=(injected.createOrchestrator||createBxagiOrchestrator)({repository:repo,bucket:env.BUCKET,env,context,fetcher:injected.fetcher});
        const result=await orchestrator.repairShowcaseLayout(job.id,{jobId:job.id,expiresAt:new Date(expiry).toISOString()},{originalSha256:originalSha256.toLowerCase()});
        const current=await repo.getJob(owner,job.id),repair=current?.details.visualRepair;
        return reply({jobId:job.id,jobStatus:current?.status||result.job?.status,busy:result.busy===true,repairKind:repair?.kind||null,phase:repair?.phase||null,messageAcknowledged:repair?.messageAcknowledged===true,lastErrorCode:current?.details.lastErrorCode||null,productionCompleted:false,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
      }
      if(productionVideoFormatRepair){
        const originalSha256=env.AUTOMATION_PROBE_ORIGINAL_SHA256;
        if(media!=='video'||typeof originalSha256!=='string'||!/^[a-f\d]{64}$/i.test(originalSha256))fail(503,'production_video_format_repair_disabled');
        const orchestrator=(injected.createOrchestrator||createBxagiOrchestrator)({repository:repo,bucket:env.BUCKET,env,context,fetcher:injected.fetcher});
        const result=await orchestrator.repairVideoFormat(job.id,{jobId:job.id,expiresAt:new Date(expiry).toISOString(),originalSha256:originalSha256.toLowerCase()});
        const current=await repo.getJob(owner,job.id),repair=current?.details.videoFormatRepair;
        return reply({jobId:job.id,jobStatus:current?.status||result.job?.status,busy:result.busy===true,phase:['sending','sent','needs_reconciliation','failed','completed'].includes(repair?.phase)?repair.phase:null,repairRevision:repair?.revision===1?1:null,messageAcknowledged:repair?.messageAcknowledged===true,lastErrorCode:current?.details.lastErrorCode||null,productionCompleted:false,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
      }
      if(productionVisualRepair){
        const orchestrator=(injected.createOrchestrator||createBxagiOrchestrator)({repository:repo,bucket:env.BUCKET,env,context,fetcher:injected.fetcher});
        const result=await orchestrator.repairVisualDelivery(job.id,{jobId:job.id,expiresAt:new Date(expiry).toISOString()},{resources:workflowFontResources()});
        const current=await repo.getJob(owner,job.id),repair=current?.details.visualRepair;
        if(repair?.phase==='sent'&&repair.messageAcknowledged===true&&current.details.automaticFlowId){
          const flow=await repo.getJob(owner,current.details.automaticFlowId);
          if(flow?.type==='platform_automation'&&flow.projectId===job.projectId&&flow.details.bxagiSubject===context.subject&&flow.details.productionJobId===job.id)await repo.ensureAutomaticFlow(owner,job.projectId,{bxagiSubject:context.subject,notBefore:new Date().toISOString()});
        }
        return reply({jobId:job.id,jobStatus:current?.status||result.job?.status,busy:result.busy===true,repairRevision:repair?.revision||null,messageAcknowledged:repair?.messageAcknowledged===true,lastErrorCode:current?.details.lastErrorCode||null,productionCompleted:false,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
      }
      if(productionRepair){
        const orchestrator=(injected.createOrchestrator||createBxagiOrchestrator)({repository:repo,bucket:env.BUCKET,env,context,fetcher:injected.fetcher});
        const result=await orchestrator.repairDelivery(job.id,{jobId:job.id,expiresAt:new Date(expiry).toISOString()});
        const current=await repo.getJob(owner,job.id);
        return reply({jobId:job.id,jobStatus:current?.status||result.job?.status,busy:result.busy===true,repairRevision:current?.details.deliveryRepair?.revision||null,messageAcknowledged:current?.details.messageAcknowledged===true,lastErrorCode:current?.details.lastErrorCode||null,productionCompleted:false,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
      }
      if(productionCollection){
        const orchestrator=(injected.createOrchestrator||createBxagiOrchestrator)({repository:repo,bucket:env.BUCKET,env,context,fetcher:injected.fetcher});
        const collected=await orchestrator.collectProduction(job.id),current=await repo.getJob(owner,job.id),artifacts=[];
        for(const id of (current?.details.resultCreativeIds||[]).slice(0,12)){
          const creative=await repo.getCreative(owner,id);
          if(!creative||creative.userId!==owner||creative.projectId!==job.projectId||creative.metadata?.sourceJobId!==job.id||creative.status==='rejected')continue;
          const object=await env.BUCKET.get(creative.objectKey);
          if(!object||!Number.isSafeInteger(creative.size)||creative.size<=0||creative.size>maxArtifactBytes||object.size!==creative.size)continue;
          await object.body?.cancel?.().catch(()=>{});
          artifacts.push({id:creative.id,mimeType:creative.mimeType,size:creative.size,width:creative.width,height:creative.height,duration:creative.duration,contentUrl:`/api/v2/creatives/${creative.id}/content`});
        }
        return reply({readOnly:false,remoteWrites:false,jobId:job.id,jobStatus:current?.status||collected.job?.status,lastErrorCode:current?.details.lastErrorCode||null,validationReason:validationReason(current),artifacts,productionCompleted:current?.status==='completed'&&artifacts.some(item=>item.mimeType===productionMime),paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
      }
      const remote=createBxagiWorkforce({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher,timeoutMs:5000}),conversation=await remote.getConversation(job.details.conversationId);
      if(!sameBxagiIdentifier(conversation.id,job.details.conversationId)||conversation.created_by_user_id!==context.subject||typeof job.details.employee.providerId!=='string'||!job.details.employee.providerId||conversation.employee_id!==job.details.employee.providerId)fail(409,'production_inspection_conversation_mismatch');
      let manifest={found:false,fileVerified:false};
      try{
        const value=await remote.readManifest({conversation,relativePath:`bxagi-advertising/${job.id}/output/manifest.json`}),prefix=`bxagi-advertising/${job.id}/output/`;
        if(value.version!==1||value.jobId!==job.id||value.kind!=='production'||!Array.isArray(value.creatives)||!value.creatives.length||value.creatives.length>12)fail(422,'production_inspection_manifest_invalid');
        const files=[];
        for(const item of value.creatives){
          if(typeof item?.path!=='string'||!item.path.startsWith(prefix)||item.path.length>500||/[\\%?#\x00-\x1f]/.test(item.path)||item.path.includes(context.accessToken)||item.path.split('/').some(p=>!p||p==='.'||p==='..')||!['image/png','video/mp4','text/plain'].includes(item.mimeType)||!Array.isArray(item.sourceAssetIds)||!item.sourceAssetIds.length||item.sourceAssetIds.some(id=>!job.details.assetIds?.includes(id)))fail(422,'production_inspection_manifest_invalid');
          files.push({path:item.path,mimeType:item.mimeType,sourceAssetIds:[...new Set(item.sourceAssetIds)].slice(0,20),fileVerified:false});
        }
        if(new Set(files.map(f=>f.path)).size!==files.length)fail(422,'production_inspection_manifest_invalid');
        manifest={found:true,version:1,jobId:job.id,kind:'production',files,fileVerified:false};
      }catch(error){manifest={found:false,fileVerified:false,errorCode:error.status===404?'manifest_not_found':['production_inspection_manifest_invalid','invalid_manifest'].includes(error.code)?'manifest_invalid':'manifest_read_unavailable'};}
      const remoteDiagnostics=await productionEventDiagnostics(job,context,injected.fetcher);
      const files=await remote.inspectJobFiles({conversationId:conversation.id,jobId:job.id});
      let butler;
      if(env.AUTOMATION_PROBE_BUTLER==='true'){
        try{
          const {createBxagiButler}=await import('./bxagi-butler.mjs');
          const reader=createBxagiButler({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher,timeoutMs:5000});
          const capability=await reader.inspectCapabilities(),history=capability.enabled?await reader.listDispatches({limit:10,offset:0}):null;
          butler={...capability,history,checkedAt:new Date().toISOString()};
        }catch{butler={readOnly:true,dispatchEnabled:false,errorCode:'butler_inspection_unavailable'};}
      }
      let deliveryReport;try{deliveryReport=await remote.getDeliveryReport({conversationId:conversation.id,jobId:job.id,includeToolResults:media==='video'});}catch{deliveryReport={readOnly:true,errorCode:'delivery_report_unavailable'};}
      let conversationManifest=null;
      if(!manifest.found){try{
        const value=await remote.readConversationManifest({conversationId:conversation.id,relativePath:`bxagi-advertising/${job.id}/output/manifest.json`});
        conversationManifest={found:true,jobMatches:value.jobId===job.id,kindMatches:value.kind==='production',versionMatches:value.version===1,creativeCount:Array.isArray(value.creatives)?value.creatives.length:0,pathsWithinJob:Array.isArray(value.creatives)&&value.creatives.every(item=>typeof item?.path==='string'&&item.path.startsWith(`bxagi-advertising/${job.id}/output/`)),pathShape:Array.isArray(value.creatives)?value.creatives.slice(0,12).map((item,index)=>({index,...manifestPathShape(item,job.id)})):[],fileVerified:false};
      }catch(error){conversationManifest={found:false,errorCode:error.status===404?'manifest_not_found':'manifest_read_unavailable',fileVerified:false};}}
      return reply({readOnly:true,jobId:job.id,jobStatus:job.status,collectionEligibility:bxagiProductionCollectionEligibility(job,{userId:owner,subject:context.subject}),validationReason:validationReason(job),conversationId:conversation.id,manifest,conversationManifest,files,deliveryReport,remoteDiagnostics,...(butler?{butler}:{}),productionCompleted:false,archiveVerified:false,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
    }
    if(inspection){
      const marketReader=(injected.createMarketplace||createBxagiMarketplace)({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher});
      const marketplace=await marketReader.inspect({diagnostics:true});
      const matches={};for(const kind of ['production','buying']){try{matches[kind]=publicMarketSelection(chooseBxagiEmployee(marketplace.employees,{kind,scene:'general'}).employee);}catch(error){matches[kind]=error.marketSelection||null;}}
      const detailIds=[...new Set(['marketing_video_optimization_specialist','short_drama_promo_editor','paid_media_programmatic_buyer','suit_rendering_designer',matches.production?.marketId,matches.buying?.marketId].filter(Boolean))].filter(id=>marketplace.employees.some(e=>e.marketId===id));
      const templateDetails=marketReader.readTemplateDetails?await Promise.all(detailIds.map(id=>marketReader.readTemplateDetails(id))):[];
      const ranked=[...(marketplace.employees||[])].map(employee=>({employee,score:Math.max(scoreBxagiMarketEmployee(employee,{kind:'production'}),scoreBxagiMarketEmployee(employee,{kind:'buying'}))})).sort((a,b)=>b.score-a.score);
      const employees=ranked.filter(row=>row.score>0).slice(0,40).map(({employee:e})=>({scores:{production:scoreBxagiMarketEmployee(e,{kind:'production'}),buying:scoreBxagiMarketEmployee(e,{kind:'buying'})},id:e.id,marketId:e.marketId,name:e.name,category:e.category,skills:(e.skills||[]).slice(0,8),hasSubs:e.hasSubs,activationState:e.activationState,usable:e.usable,activation:e.activation}));
      
      return reply({marketplace:{...marketplace,employees,totalEmployees:ranked.length,truncated:ranked.length>employees.length},matches,templateDetails,readOnly:true,installationPerformed:false,paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
    }
    const repo=injected.repository||createPlatformRepository(env.DB),bucket=env.BUCKET;
    const scenario=env.AUTOMATION_PROBE_SCENARIO||'legacy';
    if(!['legacy',showcaseSpec.scenario,packageScenario].includes(scenario)||[showcaseSpec.scenario,packageScenario].includes(scenario)&&media!=='video')fail(503,'automation_probe_scenario_invalid');
    const packageFlow=scenario===packageScenario,showcase=scenario===showcaseSpec.scenario||packageFlow;
    const id=`probe-${(await hash(`${owner}\0${new Date(expiry).toISOString()}`)).slice(0,32)}`;
    const now=new Date().toISOString();
    const reservation=await env.DB.prepare("INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details) VALUES (?,?,?,?,?,'','platform_automation_probe','preparing',?) ON CONFLICT(id) DO NOTHING").bind(id,owner,now,now,'',JSON.stringify({provider:'platform',purpose:'production_only_verification',expiresAt:new Date(expiry).toISOString(),bxagiSubject:context.subject,media,scenario,...(media==='video'&&!showcase?{sourceCreativeId:env.AUTOMATION_PROBE_SOURCE_CREATIVE_ID,sourceSha256:env.AUTOMATION_PROBE_SOURCE_SHA256}:{})})).run();
    let run=await repo.getJob(owner,id);
    if(!run||run.details.bxagiSubject!==context.subject||run.type!=='platform_automation_probe')fail(409,'automation_probe_identity_changed');
    if((run.details.scenario||'legacy')!==scenario||(run.details.media||'image')!==media||media==='video'&&!showcase&&(run.details.sourceCreativeId!==env.AUTOMATION_PROBE_SOURCE_CREATIVE_ID||run.details.sourceSha256!==env.AUTOMATION_PROBE_SOURCE_SHA256))fail(409,'automation_probe_media_changed');
    if(Number(reservation.meta?.changes??reservation.changes??0)>0){
      try{
        let bytes,sourceCreative;
        if(showcase)bytes=new TextEncoder().encode(showcaseSpec.sourceText);
        else if(media==='video'){
          const sourceId=env.AUTOMATION_PROBE_SOURCE_CREATIVE_ID,expectedHash=env.AUTOMATION_PROBE_SOURCE_SHA256;
          if(typeof sourceId!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(sourceId)||typeof expectedHash!=='string'||!/^[a-f\d]{64}$/.test(expectedHash))fail(503,'automation_video_source_disabled');
          sourceCreative=await repo.getCreative(owner,sourceId);
          if(!sourceCreative||sourceCreative.userId!==owner||sourceCreative.status==='rejected'||sourceCreative.mimeType!=='image/png'||!Number.isSafeInteger(sourceCreative.size)||sourceCreative.size<=0||sourceCreative.size>maxArtifactBytes||typeof sourceCreative.metadata?.sourceJobId!=='string')fail(409,'automation_video_source_invalid');
          const sourceJob=await repo.getJob(owner,sourceCreative.metadata.sourceJobId);
          if(!sourceJob||sourceJob.userId!==owner||sourceJob.projectId!==sourceCreative.projectId||sourceJob.type!=='bxagi_workflow'||sourceJob.status!=='completed'||sourceJob.details?.kind!=='production'||sourceJob.details.bxagiSubject!==context.subject||sourceJob.details.remoteWritePending||!Array.isArray(sourceJob.details.resultCreativeIds)||!sourceJob.details.resultCreativeIds.includes(sourceId))fail(409,'automation_video_source_job_invalid');
          const object=await bucket.get(sourceCreative.objectKey);
          if(!object||object.size!==sourceCreative.size){await object?.body?.cancel?.().catch(()=>{});fail(409,'automation_video_source_storage_invalid');}
          bytes=new Uint8Array(await (typeof object.arrayBuffer==='function'?object.arrayBuffer():new Response(object.body).arrayBuffer()));
          const magic=[137,80,78,71,13,10,26,10],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
          if(bytes.byteLength!==sourceCreative.size||bytes.byteLength<24||magic.some((value,index)=>bytes[index]!==value)||new TextDecoder().decode(bytes.subarray(12,16))!=='IHDR'||view.getUint32(16)<16||view.getUint32(20)<16||await hashBytes(bytes)!==expectedHash)fail(409,'automation_video_source_bytes_invalid');
        }else bytes=new TextEncoder().encode('BXAGI 智能调度流程测试\n事实：这是用于验证流程的测试素材。不包含商品价格、优惠或效果承诺。\n请使用已核验并启用的BXAGI市场员工生成真实PNG测试海报与纯文本说明，海报注明“流程测试素材”。不得投放、购买、安装、雇佣或续费。\n');
        if(Date.now()>=expiry)fail(503,'automation_probe_disabled');
        const videoDescription='以已上传的真实PNG海报为唯一视觉源，使用现有FFmpeg、Pillow或已安装编码工具，实际生成约10秒、720×720、24fps、H.264、yuv420p、faststart的MP4及实际PNG封面和简短纯文本制作说明，最后写本任务output目录的manifest.json，creatives包含video/mp4、image/png、text/plain三项并关联真实sourceAssetIds。必须有真实视觉运动或转场，例如完整海报缓慢缩放94%到100%并淡入淡出；完整保留中文，不裁切文字。可以静音，不下载音乐。不将静态PNG改扩展名冒充MP4。使用已经渲染正确的中文，不手工拼绘或改写文字，不新增商业承诺。terminal每次只执行一条完整命令，不提交顶层注释加命令或多条命令；多行代码先file_editor写脚本再执行单条命令。不安装或下载软件。遇到权限或审批保持等待，不绕过。对话中的计划、代码或完成声明不能代替真实文件。仅用于流程验证，不进行广告投放。';
        const project=await repo.createProject(owner,{...(showcase?{title:packageFlow?'BXAGI 八模块流程实测 · 22秒':showcaseSpec.title,productName:showcaseSpec.productName,description:showcaseSpec.description,facts:showcaseSpec.facts}:{title:media==='video'?'BXAGI视频生产实测':'BXAGI 智能调度实测',productName:'流程验证素材',description:media==='video'?videoDescription:(env.BXAGI_BUTLER_ENABLED==='true'?'已随素材附带有许可的流程测试中文字库和OFL/NOTICE说明，input目录唯一.bin文件就是TTF字库，可供Pillow直接使用。字库仅覆盖本次固定测试文案；许可说明保留在input，不作为成品。':'')+'必须实际生成一张1080×1080、8位非交错RGB PNG海报及一份纯文本制作说明，并写入本任务output目录及manifest.json。海报标题“流程测试素材”，使用现有支持中文的字体，重新打开检查标题可读。只使用已安装工具，不下载或安装软件。对话中的计划、代码或完成声明不能代替实际文件。仅用于流程验证，不进行广告投放。',facts:['这是用于验证流程的测试素材','不包含商品价格、优惠或效果承诺']}),objective:'views',scene:'general',...(packageFlow?{sourceState:{version:1,status:'empty'}}:{}),assignment:{provider:'bxagi',automationProbeId:id}});
        run=await repo.updateJob(owner,id,{projectId:project.id,details:{...run.details,projectId:project.id}});
        const objectKey=`tenants/${encodeURIComponent(owner)}/assets/${crypto.randomUUID()}`;
        const sourceMime=media==='video'&&!showcase?'image/png':'text/plain';
        await bucket.put(objectKey,bytes,{httpMetadata:{contentType:sourceMime}});
        let asset;
        try{asset=await repo.createAsset(owner,{projectId:project.id,filename:showcase?'showcase-storyboard.txt':media==='video'?'automation-source.png':'automation-source.txt',mimeType:sourceMime,size:bytes.length,role:'source',objectKey,status:'uploaded',metadata:{automationProbeId:id,automationProbeExpiresAt:new Date(expiry).toISOString(),...(sourceCreative?{sourceCreativeId:sourceCreative.id,sourceJobId:sourceCreative.metadata.sourceJobId,sourceSha256:env.AUTOMATION_PROBE_SOURCE_SHA256}:{})}});}catch(e){await bucket.delete?.(objectKey);throw e;}
        if(showcase||media==='image'&&env.BXAGI_BUTLER_ENABLED==='true'){
          for(const resource of (showcase?showcaseFontResources():workflowFontResources())){
            if(Date.now()>=expiry)fail(503,'automation_probe_disabled');
            const resourceBytes=new Uint8Array(await resource.blob.arrayBuffer());
            if(resourceBytes.byteLength!==resource.size||await hashBytes(resourceBytes)!==resource.sha256)fail(500,'automation_font_resource_invalid');
            const resourceKey=`tenants/${encodeURIComponent(owner)}/assets/${crypto.randomUUID()}`;
            await bucket.put(resourceKey,resourceBytes,{httpMetadata:{contentType:resource.blob.type}});
            try{await repo.createAsset(owner,{projectId:project.id,filename:resource.filename,mimeType:resource.blob.type,size:resourceBytes.length,role:'reference',objectKey:resourceKey,status:'uploaded',metadata:{automationProbeId:id,automationProbeExpiresAt:new Date(expiry).toISOString(),licensedWorkflowResource:true,sha256:resource.sha256}});}catch(e){await bucket.delete?.(resourceKey);throw e;}
          }
        }
        if(packageFlow){
          if(Date.now()>=expiry)fail(503,'automation_probe_disabled');
          // The reservation winner seals the input once. Concurrent follow-up
          // requests cannot create multiple initial batches for this same run.
          const sources=await repo.listAssets(owner,project.id);
          const production=createProductionService({repository:repo,bucket,context});
          const {batch}=await production.beginBatch(project.id,{expectedCount:sources.length,reuseAssetIds:sources.map(source=>source.id)});
          await production.completeBatch(project.id,batch.id,{assetIds:sources.map(source=>source.id)});
          run=await repo.updateJob(owner,id,{details:{...run.details,batchId:batch.id}});
        }
        run=await repo.updateJob(owner,id,{assetId:asset.id,status:'queued'});
      }catch(e){await repo.updateJob(owner,id,{status:'failed'});throw e;}
    }
    if(run.status==='preparing')return reply({runId:id,status:'preparing'});
    if(run.status==='failed')fail(409,'automation_probe_setup_failed');
    const projectId=run.projectId;
    // The restricted repository prevents this capability from advancing other
    // projects or any existing buying/feedback work, even if state is malformed.
    const scoped={...repo,
      listDueAutomaticFlows:async()=>{const f=await repo.getAutomaticFlow(owner,projectId);return f&&f.details.enabled===true&&(!f.details.nextActionAt||Date.parse(f.details.nextActionAt)<=Date.now())?[f]:[];},
      listJobs:async()=> (await repo.listJobs(owner)).filter(j=>j.projectId===projectId&&(j.type!=='bxagi_workflow'||j.details?.kind==='production')),
      listCampaigns:async()=>[],listOptimizationTasks:async()=>[],
      createBxagiProductionJob:async(u,p)=>{if(u!==owner||p.projectId!==projectId||p.details?.kind!=='production')fail(403,'automation_probe_scope_invalid');if(packageFlow&&Date.now()>=expiry)fail(503,'automation_probe_disabled');const flow=packageFlow?await repo.getAutomaticFlow(owner,projectId):null;return repo.createBxagiProductionJob(u,{...p,details:{...p.details,...(flow?{automaticFlowId:flow.id}:{}),automationProbeExpiresAt:new Date(expiry).toISOString()}})},
      ...(packageFlow?{createBxagiBuyingJob:async()=>fail(403,'automation_probe_scope_invalid'),createCampaign:async()=>fail(403,'automation_probe_scope_invalid')}:{}),
    };
    const automatic=createAutomaticFlow({repository:scoped,bucket,env,fetcher:injected.fetcher,createOrchestrator:injected.createOrchestrator||createBxagiOrchestrator});
    if(!await repo.getAutomaticFlow(owner,projectId))await automatic.ensureProject(context,projectId,{notBefore:now});
    if(Date.now()>=expiry)fail(503,'automation_probe_disabled');
    if(packageFlow){
      const project=await repo.getProject(owner,projectId);
      if(!run.details.batchId||project?.sourceState?.batchId!==run.details.batchId)fail(409,'automation_probe_batch_changed');
      const production=createProductionService({repository:scoped,bucket,context,orchestrator:()=> (injected.createOrchestrator||createBxagiOrchestrator)({repository:scoped,bucket,env,context,fetcher:injected.fetcher})});
      await production.start(projectId,{batchId:run.details.batchId,productionSpec:packageProductionSpec});
    }
    // One bounded continuation of this verification run after the observed
    // HTTP-message endpoint refused the request with 404. Keep all real files
    // and the same conversation; never reset a sent or uncertain write.
    const previousFlow=await repo.getAutomaticFlow(owner,projectId);
    const rejected=previousFlow?.details.productionJobId?await repo.getJob(owner,previousFlow.details.productionJobId):null;
    if(rejected?.status==='failed'&&rejected.userId===owner&&rejected.projectId===projectId&&rejected.type==='bxagi_workflow'
      &&rejected.details.kind==='production'&&rejected.details.bxagiSubject===context.subject
      &&rejected.details.automationProbeExpiresAt===new Date(expiry).toISOString()
      &&rejected.details.employee?.marketVerified===true&&rejected.employeeId===rejected.details.employee.id
      &&rejected.details.lastErrorCode==='upstream_request_failed'&&rejected.details.lastErrorStatus===404
      &&!rejected.details.messageSentAt&&!rejected.details.remoteWritePending&&!rejected.details.messageTransportRecoveryAttempted
      &&rejected.details.startTaskId&&rejected.details.conversationId&&rejected.details.inputsReady===true
      &&rejected.details.briefUploaded===true&&rejected.details.uploadedAssets?.length>0){
      const recoveredAt=new Date().toISOString();
      const details={...rejected.details,messageTransportRecoveryAttempted:true,messageTransportRecoveryAt:recoveredAt,
        lastError:null,lastErrorCode:null,lastErrorStatus:null};
      const recovered=await env.DB.prepare("UPDATE jobs SET status='uploading',details=?,updatedAt=? WHERE id=? AND userId=? AND status='failed' AND updatedAt=?")
        .bind(JSON.stringify(details),recoveredAt,rejected.id,owner,rejected.updatedAt).run();
      if(Number(recovered.meta?.changes??recovered.changes??0)>0)await env.DB.prepare("UPDATE jobs SET status='producing',details=json_set(details,'$.nextActionAt',?,'$.waiting',null),updatedAt=? WHERE id=? AND userId=? AND json_extract(details,'$.productionJobId')=?")
        .bind(recoveredAt,recoveredAt,previousFlow.id,owner,rejected.id).run();
    }
    await automatic.tick({context,limit:1});
    const flow=await repo.getAutomaticFlow(owner,projectId),explicitProject=packageFlow?await repo.getProject(owner,projectId):null;
    const productionJobId=flow?.details.productionJobId||explicitProject?.sourceState?.startedJobId;
    const job=productionJobId?await repo.getJob(owner,productionJobId):null;
    if(job&&(job.projectId!==projectId||job.details.kind!=='production'))fail(409,'automation_probe_scope_invalid');
    const artifacts=[];
    for(const creativeId of (job?.details.resultCreativeIds||[]).slice(0,20)){
      const c=await repo.getCreative(owner,creativeId);
      if(!c||c.userId!==owner||c.projectId!==projectId||c.metadata?.sourceJobId!==job.id||c.status==='rejected'||!Number.isSafeInteger(c.size)||c.size<=0||c.size>maxArtifactBytes)continue;
      const object=await bucket.get(c.objectKey);if(!object||object.size!==c.size)continue;await object.body?.cancel?.().catch(()=>{});
      artifacts.push({id:c.id,mimeType:c.mimeType,size:c.size,width:c.width,height:c.height,duration:c.duration});
    }
    const coordination=job?.details.coordination;
    let coordinationDiagnostics;
    if(coordination?.mode==='official_butler'&&coordination.phase!=='ready'&&job.userId===owner&&job.type==='bxagi_workflow'&&job.details?.kind==='production'&&job.details.bxagiSubject===context.subject&&job.details.automationProbeExpiresAt===new Date(expiry).toISOString()&&Date.now()<expiry){
      try{
        const remote=createBxagiWorkforce({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher,timeoutMs:5000});
        coordinationDiagnostics=await createBxagiButlerCoordinator({repository:repo,remote,context,fetcher:injected.fetcher,scoreEmployee:scoreBxagiMarketEmployee}).diagnose({state:coordination,parentJobId:job.id});
      }catch{coordinationDiagnostics={readOnly:true,remoteWrites:false,errorCode:'butler_coordination_diagnostic_unavailable'};}
    }
    const remoteDiagnostics=job?.userId===owner&&job.type==='bxagi_workflow'&&job.details?.kind==='production'&&job.details.bxagiSubject===context.subject&&job.details.automationProbeExpiresAt===new Date(expiry).toISOString()&&job.details.messageSentAt&&Number.isFinite(Date.parse(job.details.messageSentAt))&&job.details.conversationId&&artifacts.length===0&&Date.now()<expiry?await productionEventDiagnostics(job,context,injected.fetcher):null;
    let catalog,marketActivation;
    if(!job&&!injected.createOrchestrator){try{const market=await createBxagiMarketplace({accessToken:context.accessToken,subject:context.subject,fetcher:injected.fetcher}).inspect();catalog={source:'marketplace',total:market.employees.length,employees:market.employees.slice(0,20).map(e=>({id:e.id,name:e.name,resourceType:e.resourceType,activationState:e.activationState,usable:e.usable}))};let selection;try{selection=publicMarketSelection(chooseBxagiEmployee(market.employees,{kind:'production',scene:'general'}).employee);}catch(error){selection=error.marketSelection;}catalog.selection=selection||null;if(selection?.marketId){const activation=await repo.getBxagiMarketActivation(owner,selection.marketId,context.subject);if(activation)marketActivation={id:activation.id,status:activation.status,marketId:selection.marketId,freeBasis:activation.details?.freeBasis||null,receiptReceived:!!activation.details?.mainConversationId,lastErrorCode:activation.details?.lastErrorCode||null};}}catch(error){catalog={errorCode:error.code||'bxagi_unavailable',diagnostic:marketDiagnostic(error)};}}
    let packageEvidence;
    if(packageFlow){
      const project=await repo.getProject(owner,projectId),batch=await repo.getJob(owner,run.details.batchId);
      if(!batch||batch.projectId!==projectId||batch.type!=='upload_batch'||batch.details?.bxagiSubject!==context.subject||job&&job.details?.batchId!==batch.id)fail(409,'automation_probe_batch_changed');
      packageEvidence={scenario,batch:{id:batch.id,status:batch.status,expectedCount:batch.details.expectedCount,assetIds:batch.details.assetIds,inputVersion:batch.details.inputVersion,sealedAt:batch.details.sealedAt,startedJobId:batch.details.startedJobId||null},productionSpec:job?.details.productionSpec||project.productionSpec,sourceState:project.sourceState};
    }
    return reply({runId:id,projectId,...packageEvidence,flow:describeAutomaticFlow(flow),...(catalog?{catalog}:{}),...(marketActivation?{marketActivation}:{}),...(remoteDiagnostics?{remoteDiagnostics}:{}),...(coordinationDiagnostics?{coordinationDiagnostics}:{}),job:job?{id:job.id,status:job.status,employeeId:job.employeeId,employeeName:job.details.employee?.name,conversationId:job.details.conversationId,startTaskId:job.details.startTaskId,runtimeStatus:job.details.runtimeStatus||null,executionStatus:job.details.executionStatus||null,uploadedAssetCount:job.details.uploadedAssets?.length||0,briefUploaded:job.details.briefUploaded===true,messageSent:!!job.details.messageSentAt,messageAcknowledged:job.details.messageAcknowledged===true,messageTransport:job.details.messageTransport||null,messageEventId:job.details.messageEventId||null,messageAlreadyDelivered:job.details.messageAlreadyDelivered===true,lastErrorCode:job.details.lastErrorCode||null,lastErrorStatus:job.details.lastErrorStatus||null,coordination:coordination?coordination.mode==='official_butler'?bxagiButlerCoordinationEvidence(coordination):{phase:coordination.phase,conversationId:coordination.conversationId,manifestVerified:coordination.manifestVerified===true}:null}:null,artifacts,productionCompleted:job?.status==='completed'&&artifacts.some(item=>item.mimeType===productionMime),paidAdvertisingPerformed:false,checkedAt:new Date().toISOString()});
  } catch(error) { return reply({error:{code:typeof error.code==='string'?error.code:'automation_probe_unavailable',diagnostic:marketDiagnostic(error)}},Number(error.status)||503); }
}
