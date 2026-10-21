/** Read-only collection eligibility. Identity, source files and output are rechecked at execution. */
import { isExecutableMarketEmployee } from '../bxagi-market-eligibility.mjs';
import { automaticallyRecoverableReadFailure, hasUncertainBxagiWrite } from '../bxagi-recovery.mjs';

export const ACTIVE = new Set(['queued', 'starting', 'uploading', 'running', 'awaiting_result', 'awaiting_user_input', 'awaiting_user_confirmation']);

function collectionPrerequisites(job) {
  const d = job?.details || {};
  return {
    job_type: job?.type === 'bxagi_workflow',
    production_kind: d.kind === 'production',
    market_employee: isExecutableMarketEmployee(d.employee),
    employee_binding: typeof job?.employeeId === 'string' && job.employeeId === d.employee?.id,
    message_acknowledged: d.messageAcknowledged === true,
    message_time: Number.isFinite(Date.parse(d.messageSentAt)),
    conversation_id: typeof d.conversationId === 'string' && !!d.conversationId,
    start_task_id: typeof d.startTaskId === 'string' && !!d.startTaskId,
    inputs_ready: d.inputsReady === true,
    brief_uploaded: d.briefUploaded === true,
    latest_repair_acknowledged: [d.deliveryRepair, d.visualRepair, d.videoFormatRepair].every(repair => !repair || ['sent', 'completed'].includes(repair.phase) && repair.messageAcknowledged === true),
    no_pending_write: !hasUncertainBxagiWrite(job),
    status_collectable: job?.status !== 'needs_reconciliation' && (ACTIVE.has(job?.status) || job?.status === 'completed' || job?.status === 'failed')
  };
}

/** Eligibility only: every retry still validates sources, identity and actual output.
 * An earlier read/manifest failure must not permanently bar read-only recovery. */
export function isCollectableBxagiProductionJob(job) {
  return Object.values(collectionPrerequisites(job)).every(Boolean);
}

export function isAutomaticallyRecoverableBxagiProductionJob(job) {
  return isCollectableBxagiProductionJob(job) && !['awaiting_user_input', 'awaiting_user_confirmation', 'completed'].includes(job.status) && (job.status !== 'failed' || automaticallyRecoverableReadFailure(job));
}

/** Safe diagnostics contain static check names and booleans, never stored errors or IDs. */
export function bxagiProductionCollectionEligibility(job, {
  userId,
  subject
} = {}) {
  const checks = {
    ...collectionPrerequisites(job),
    owner_matches: typeof userId === 'string' && !!userId && job?.userId === userId,
    subject_matches: typeof subject === 'string' && !!subject && job?.details?.bxagiSubject === subject
  };
  const blockers = Object.keys(checks).filter(key => checks[key] !== true);
  return {
    eligible: blockers.length === 0,
    eligibilityOnly: true,
    checks,
    blockers,
    actualFilesVerified: false
  };
}
