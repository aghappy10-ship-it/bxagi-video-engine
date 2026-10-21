export const BXAGI_JOB_STATES=['queued','starting','uploading','running','awaiting_result','awaiting_user_input','awaiting_user_confirmation','needs_reconciliation','completed','failed','awaiting_conversation','awaiting_upload'];
const isBxagi=value=>String(value||'').toLowerCase()==='bxagi';
export function remoteJobs(data={}) {
  const rows=[...(data.remoteJobs||[]),...(data.bxagi?.jobs||[]),...(data.jobs||[])];
  const unique=new Map();
  for(const job of rows){if(isBxagi(job.provider)||isBxagi(job.details?.provider)||isBxagi(job.metadata?.provider)||/^bxagi[_-]/i.test(String(job.type||'')))unique.set(job.id,job);}
  return Array.from(unique.values());
}
export function remoteErrorMessage(value) {return typeof value==='string'?value:value&&typeof value.message==='string'?value.message:'';}
export function remoteJobDescription(job) {
  const recoveryCode=job.details?.recovery?.code||job.details?.lastErrorCode;
  if(!['completed','complete'].includes(job.status)&&['bxagi_node_offline','bxagi_gateway_disconnected','bxagi_node_unavailable','bxagi_runtime_unavailable'].includes(recoveryCode))return '执行节点暂不可用，任务与已归档文件已保留。系统等待连接恢复后继续原任务。';
  const supplied=remoteErrorMessage(job.error)||remoteErrorMessage(job.details?.lastError)||remoteErrorMessage(job.details?.error)||remoteErrorMessage(job.details?.message)||remoteErrorMessage(job.message);
  if(supplied)return supplied;
  if(job.status==='queued')return '任务已进入员工执行队列，等待准备素材并联系员工。';
  if(['starting','awaiting_conversation'].includes(job.status))return '正在联系 BXAGI 员工，等待可用会话。';
  if(['uploading','awaiting_upload'].includes(job.status))return '正在交付原始素材，尚未取得员工处理结果。';
  if(['awaiting_user_input','awaiting_user_confirmation'].includes(job.status))return '员工需要你补充信息，请查看任务并继续处理。';
  if(job.status==='needs_reconciliation')return '远端执行结果尚不明确，系统保留任务，不会重复派发。';
  if(job.status==='completed')return '远端任务已返回；实际成品与渠道状态以平台保存的记录为准。';
  if(job.status==='failed')return '员工任务未完成，请查看返回原因后处理。';
  return '正在等待 BXAGI 员工的实际执行结果。';
}
export function queuedJobNotice(result,description='任务') {
  if(isBxagi(result?.provider)&&result.job) {
    if(result.job.status==='failed')return {error:remoteErrorMessage(result.job.error)||remoteErrorMessage(result.job.details?.error)||'BXAGI 任务处理失败，请查看任务状态。'};
    if(result.job.status==='needs_reconciliation')return {notice:`${description}结果待核查，系统不会重复派发。`};
    if(['awaiting_user_input','awaiting_user_confirmation'].includes(result.job.status))return {notice:`${description}需要你补充信息，请查看员工任务。`};
    if(result.job.status==='completed')return {notice:`${description}已返回远端结果；成品与渠道状态以已保存的实际记录为准。`};
    return {notice:`${description}已加入 BXAGI 员工执行队列，状态与结果持续同步。`};
  }
  return {error:'未取得可核实的 BXAGI 员工任务，未确认生成成品或执行投放。'};
}
export function pendingRemoteJob(job) {return ['queued','starting','uploading','running','awaiting_result','awaiting_user_input','awaiting_user_confirmation','needs_reconciliation','awaiting_conversation','awaiting_upload'].includes(job.status);}
export function safeBxagiUrl(value) {try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='bxagi.xinlx.com'?url.href:null;}catch{return null;}}
export function pollableRemoteJob(job) {return ['queued','starting','uploading','running','awaiting_result','awaiting_conversation','awaiting_upload'].includes(job.status);}

export const errorMessage=remoteErrorMessage;
export function bxagiUploadLimit(capabilities={}) {const configured=Number(capabilities.bxagiTransferMaxBytes);return Number.isSafeInteger(configured)&&configured>0?Math.min(configured,64*1024*1024):16*1024*1024;}
