import { AdsError } from './adapters/provider-http.mjs';
import { hasUncertainBxagiWrite } from './bxagi-recovery.mjs';

const incomplete = () => { throw new AdsError('bxagi_delivery_incomplete', '该素材的生产任务尚未完整交付或当前交付版本未通过核实，请等待完整归档后再投放', { status: 409 }); };

/** A saved partial artifact is downloadable, but cannot authorize new ad delivery. */
export async function assertCreativeDeliveryComplete({ repository, userId, creative } = {}) {
  if (!creative || typeof userId !== 'string' || !userId || creative.userId && creative.userId !== userId) incomplete();
  if (['cover','notes','subtitle','attachment','supporting'].includes(creative.metadata?.deliverableRole)) throw new AdsError('creative_not_primary','封面、字幕和说明属于辅助交付，请选择主成品投放',{status:400});
  if (!Object.hasOwn(creative.metadata || {}, 'sourceJobId')) return creative;
  const sourceJobId = creative.metadata.sourceJobId;
  if (typeof sourceJobId !== 'string' || !sourceJobId || sourceJobId.length > 160 || typeof repository?.getJob !== 'function') incomplete();
  const job = await repository.getJob(userId, sourceJobId);
  if (!job || job.id !== sourceJobId || job.userId !== userId || job.projectId !== creative.projectId || job.status !== 'completed' || hasUncertainBxagiWrite(job)) incomplete();
  if (job.type === 'video_optimize') {
    // The existing local video worker has a single, fully decoded result.
    if (creative.validation !== 'worker-full-decode' || job.details?.resultCreativeId !== creative.id || job.details?.output?.fullDecodePassed !== true) incomplete();
  } else if (!Array.isArray(job.details?.resultCreativeIds) || !job.details.resultCreativeIds.includes(creative.id)) incomplete();
  return creative;
}
