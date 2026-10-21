import { assertCreativeDeliveryComplete } from '../creative-delivery-eligibility.mjs';
import { fail, requireRow } from './protocol.mjs';

/** Every user-triggered advertising operation uses the same owner and employee path. */
export async function executeCampaignAction({userId,repository,ads,remoteWorkflow},campaign,action) {
  if (!['launch','pause','sync'].includes(action)) fail(400,'不支持该投放操作','invalid_campaign_action');
  if (campaign.userId !== userId) fail(404,'投放不存在','not_found');
  if (action === 'launch') {
    const creatives=await Promise.all(campaign.creativeIds.map(id=>repository.getCreative(userId,id)));
    for (const value of creatives) {
      const creative=requireRow(value);
      if(creative.projectId!==campaign.projectId)fail(400,'广告素材不属于该素材包','invalid_creative');
      await assertCreativeDeliveryComplete({repository,userId,creative});
      if(creative.status==='rejected')fail(400,'该素材已被拒绝，请重新审核或生成','rejected_creative');
    }
    for(const creative of creatives)if(creative.status!=='approved') {
      await repository.updateCreative(userId,creative.id,{status:'approved',reviewedBy:userId,reviewedAt:new Date().toISOString()});
      await repository.addAudit(userId,{action:'creative.approved_at_launch',entityType:'creative',entityId:creative.id,details:{campaignId:campaign.id,authorization:'explicit_launch'}});
    }
  }
  if(['launch','pause'].includes(action)) {
    const workflow=await remoteWorkflow();
    if(workflow)return workflow.submitBuying(campaign,{action});
  }
  const result=await ads[action](userId,campaign);
  return result?.campaign?result:{campaign:result};
}
