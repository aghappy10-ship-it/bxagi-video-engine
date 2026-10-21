import {remoteErrorMessage} from './remote-jobs.mjs';
export function activeAutomaticFlows(data={}) {return (data.automationFlows||[]).filter(flow=>flow.enabled!==false);}
export function automaticFlowStage(flow) {return flow.waiting?.stage||(['queued','producing'].includes(flow.status)?'production':flow.status==='monitoring'?'feedback':'system');}
export function automaticFlowLabel(flow) {
  if(isNodeRecoveryWait(flow.waiting)||flow.status==='awaiting_node')return '等待执行节点恢复';
  if(flow.waiting?.code==='awaiting_budget')return '等待设置投放预算';
  if(flow.waiting?.code==='awaiting_explicit_launch')return '等待预算授权';
  if(flow.waiting?.requiresUser)return '需要你处理';
  return ({queued:'整理上传素材',producing:'员工生产中',monitoring:'效果与优化监测中',waiting:'流程等待中'})[flow.status]||'自动流程已保存';
}
export function automaticFlowReason(flow) {return remoteErrorMessage(flow.waiting)||'任务已保存，系统按实际执行结果继续推进。';}
export function automaticFlowNeedsUser(flow) {return flow.waiting?.requiresUser===true;}
export function isNodeRecoveryWait(value) {return ['node_offline','gateway_disconnected','runtime_unavailable','awaiting_node','waiting_for_node','bxagi_node_offline','bxagi_node_unavailable','bxagi_gateway_disconnected','bxagi_runtime_unavailable'].includes(value?.code);}
export function backgroundSchedulerState(capabilities={},now=Date.now()) {
  const health=capabilities.backgroundScheduler||{};
  const last=Date.parse(health.lastSuccessfulTickAt||'');
  const configured=capabilities.backgroundSchedulingConfigured===true;
  const maxAge=Number(health.staleAfterMs||health.heartbeatMaxAgeMs)||300000;
  const recent=Number.isFinite(last)&&last<=now+30000&&now-last<=Math.min(Math.max(maxAge,30000),900000);
  const running=configured&&capabilities.backgroundScheduling===true&&['running','healthy','connected'].includes(health.status)&&recent;
  return {running,configured,status:running?'running':!configured?'unconfigured':health.status==='error'?'error':last?'stale':'pending',label:running?'后台调度运行中':!configured?'后台执行器未连接':health.status==='error'?'后台调度异常':last?'后台调度心跳过期':'后台已配置 · 等待首次心跳',lastSuccessfulTickAt:health.lastSuccessfulTickAt||null,lastAttemptAt:health.lastAttemptAt||null};
}
export function automaticAdvanceDelay(data={},now=Date.now()) {
  if(backgroundSchedulerState(data.capabilities,now).running)return 30000;
  const flows=activeAutomaticFlows(data).filter(flow=>!automaticFlowNeedsUser(flow));
  if(!flows.length)return 60000;
  const next=Math.min(...flows.map(flow=>{const due=Date.parse(flow.nextActionAt||'');return Number.isFinite(due)?Math.max(0,due-now):0;}));
  return Math.max(15000,Math.min(next,60000));
}
export function archivedFlowFiles(flow,data={}) {
  const id=flow.productionJobId||flow.lastCompletedProductionJobId;
  const job=(data.jobs||[]).find(row=>row.id===id);
  if(!job)return [];
  const ids=new Set(Array.isArray(job.details?.resultCreativeIds)?job.details.resultCreativeIds:[]);
  return (data.creatives||[]).filter(row=>row.projectId===flow.projectId&&row.metadata?.sourceJobId===id&&ids.has(row.id)&&Number(row.size)>0&&row.status!=='rejected'&&row.reviewStatus!=='rejected');
}
export function creativeDeliveryState(row,data={}) {
  if(row.status==='rejected'||row.reviewStatus==='rejected')return {status:'rejected',label:'审核未通过，待重做'};
  const job=(data.jobs||[]).find(item=>item.id===row.metadata?.sourceJobId);
  if(!job)return {status:row.metadata?.sourceJobId?'validating':'saved',label:row.metadata?.sourceJobId?'任务归属待核实':'实际文件已保存'};
  if(!Array.isArray(job.details?.resultCreativeIds)||!job.details.resultCreativeIds.includes(row.id))return {status:'validating',label:'当前交付版本待核实'};
  if(['completed','complete'].includes(job.status))return {status:'saved',label:'完整交付已归档'};
  const expected=job.details?.delivery?.expected;
  const siblings=(data.creatives||[]).filter(file=>file.metadata?.sourceJobId===job.id&&job.details.resultCreativeIds.includes(file.id)&&file.status!=='rejected'&&file.reviewStatus!=='rejected');
  const notesPending=Array.isArray(expected)&&expected.some(file=>file.mimeType==='text/plain'&&!siblings.some(saved=>saved.mimeType==='text/plain'&&saved.filename===file.filename));
  return {status:'partial',label:notesPending?'部分交付 · 说明待回收':'部分交付 · 其余文件待回收'};
}
export function completedFlowFiles(flow,data={}) {
  const id=flow.lastCompletedProductionJobId;
  if(!id)return [];
  const job=(data.jobs||[]).find(row=>row.id===id);
  if(!job||!['completed','complete'].includes(job.status))return [];
  const ids=Array.isArray(job.details?.resultCreativeIds)?new Set(job.details.resultCreativeIds):null;
  // Older local jobs did not persist a result ID list. BXAGI deliveries always
  // require it, so a missing or empty list cannot revive an obsolete revision.
  if(!ids&&(job.type==='bxagi_workflow'||job.details?.provider==='bxagi'))return [];
  return (data.creatives||[]).filter(row=>row.projectId===flow.projectId&&row.metadata?.sourceJobId===id&&row.status!=='rejected'&&row.reviewStatus!=='rejected'&&(!ids||ids.has(row.id)));
}
export function isPrimaryCreative(row={}) {
  const media=String(row.mimeType||row.mime||row.contentType||'').toLowerCase();
  if(!/^(image|video)\//.test(media))return false;
  const role=row.deliverableRole||row.metadata?.deliverableRole||row.metadata?.deliveryRole||row.metadata?.role||row.role;
  if(['cover','thumbnail','notes','subtitle','auxiliary'].includes(role))return false;
  if(['primary','main'].includes(role))return true;
  return !/^(?:cover|thumbnail|封面)(?:[-_.\s]|$)/i.test(row.filename||'');
}
export function projectReadyCreatives(projectId,data={}) {
  return (data.creatives||[]).filter(row=>{
    if(row.projectId!==projectId||row.status==='rejected'||row.reviewStatus==='rejected'||!Number.isFinite(Number(row.size))||Number(row.size)<=0)return false;
    if(!isPrimaryCreative(row))return false;
    const jobId=row.metadata?.sourceJobId;
    if(!jobId)return ['browser-metadata','operator-reviewed'].includes(row.validation)||row.status==='approved';
    const job=(data.jobs||[]).find(item=>item.id===jobId);
    return job?.status==='completed'&&Array.isArray(job.details?.resultCreativeIds)&&job.details.resultCreativeIds.includes(row.id);
  });
}
