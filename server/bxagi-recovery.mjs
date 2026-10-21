/** Transport availability is separate from entitlement and write reconciliation. */
export const BXAGI_AVAILABILITY_CODES = new Set(['bxagi_node_offline','bxagi_gateway_disconnected','bxagi_node_unavailable','bxagi_runtime_unavailable']);
const READ_TRANSIENT_CODES = new Set([...BXAGI_AVAILABILITY_CODES,'upstream_unavailable','upstream_request_failed','message_handshake_failed']);
export function hasUncertainBxagiWrite(job){
  const d=job?.details||{},unknown=record=>!!record&&(!!record.remoteWritePending||record.outcomeUnknown===true||record.remoteOutcomeUnknown===true||record.dispatchOutcomeUnknown===true||record.uncertain===true||record.status==='needs_reconciliation'||['needs_reconciliation','sending','switching'].includes(record.phase)||record.dispatchAcceptedObserved===true&&record.dispatchAccepted!==true);
  return job?.status==='needs_reconciliation'||[d,d.coordination,d.deliveryRepair,d.visualRepair,d.videoFormatRepair].some(unknown);
}
export function isTransientBxagiError(error){
  if(error?.uncertain===true||[401,403].includes(Number(error?.status)))return false;
  return READ_TRANSIENT_CODES.has(error?.code)||!error?.status||error.status>=500||error.status===429;
}
export function nextBxagiRecovery(previous,code,{now=Date.now(),random=Math.random}={}){
  const attempt=Math.min(20,Math.max(0,Number.isSafeInteger(previous?.attempt)?previous.attempt:0)+1);
  const base=Math.min(300,15*2**Math.min(attempt-1,5));
  const retrySeconds=Math.max(12,Math.min(300,Math.round(base*(0.8+Math.max(0,Math.min(1,random()))*0.4))));
  return {attempt,code:typeof code==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(code)?code:'upstream_unavailable',firstFailureAt:previous?.firstFailureAt||new Date(now).toISOString(),lastFailureAt:new Date(now).toISOString(),nextRetryAt:new Date(now+retrySeconds*1000).toISOString()};
}
export function bxagiRecoveryDue(job,now=Date.now()){
  const retry=Date.parse(job?.details?.recovery?.nextRetryAt||'');
  return !Number.isFinite(retry)||retry<=now;
}
export function automaticallyRecoverableReadFailure(job){
  const {lastErrorCode:code,lastErrorStatus:status}=job?.details||{};
  if([401,403].includes(status))return false;
  // Legacy availability was recorded as activation_required. The next read
  // must revalidate the current entitlement; this never installs or renews.
  return code==='bxagi_market_employee_activation_required'||READ_TRANSIENT_CODES.has(code);
}
