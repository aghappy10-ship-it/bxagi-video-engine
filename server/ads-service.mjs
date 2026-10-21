import { evaluateCampaign } from '../legacy/workspace/domain.mjs';
import { AdsError, configuration } from './adapters/provider-http.mjs';
import { createOceanEngineAdapter, validateOceanEngineConfiguration } from './adapters/oceanengine.mjs';
import { decryptConnectionSecrets } from './adapters/connection-secrets.mjs';
import { assertCreativeDeliveryComplete } from './creative-delivery-eligibility.mjs';
import { withDeliveryGroupLock, assertDeliveryGroupAllocation } from './delivery-groups.mjs';
export { connectionSummary, encryptConnectionSecrets, decryptConnectionSecrets } from './adapters/connection-secrets.mjs';
export const channelCapabilities = [
  { id:'oceanengine',label:'巨量引擎',adapter:'implemented',requiresConfiguration:true,liveVerified:false },
  { id:'tencent',label:'腾讯广告',adapter:'adapter_pending',requiresConfiguration:true,liveVerified:false },
  { id:'kuaishou',label:'磁力引擎',adapter:'adapter_pending',requiresConfiguration:true,liveVerified:false },
  { id:'custom',label:'自定义渠道',adapter:'adapter_pending',requiresConfiguration:true,liveVerified:false }
];
const safeError = error => error instanceof AdsError ? { code:error.code,message:error.message,uncertain:error.uncertain,requestId:error.requestId } : {code:'operation_failed',message:'投放操作未完成，请检查服务端日志与平台状态',uncertain:true,requestId:null};
function localDateTime(time = Date.now()) { const d=new Date(time+8*3600000); return d.toISOString().slice(0,19).replace('T',' '); }
function today(time = Date.now()) { return localDateTime(time).slice(0,10); }
function lifetimeStart(state) {
  const time=Date.parse(state.launchStartedAt ?? state.launchedAt ?? '');
  if (!Number.isFinite(time) || time>Date.now()) throw configuration('缺少可核实的首次投放时间，累计消耗未知；请先在广告后台核对','cumulative_spend_unknown');
  // Include the whole creation day, so spending during enable/readback latency is not omitted.
  return `${localDateTime(time).slice(0,10)} 00:00:00`;
}
function remainingBudget(total,spend) { return Math.max(0,Math.floor((Number(total)-Number(spend))*100+1e-7)/100); }
export function createAdsService({repository:repo,bucket,env={},fetcher=fetch}) {
  async function owned(userId, campaign) {
    if (!userId || !campaign?.id) throw new AdsError('not_found','投放计划不存在',{status:404});
    const row=await repo.getCampaign(userId,campaign.id);
    if (!row || row.userId && row.userId !== userId) throw new AdsError('not_found','投放计划不存在',{status:404});
    return row;
  }
  async function context(userId,campaign) {
    if (campaign.channel !== 'oceanengine') throw configuration('该渠道尚未配置官方投放适配器；请选择已实现的巨量引擎或等待渠道接入','adapter_pending');
    const connection=await repo.getConnection(userId,campaign.connectionId);
    if (!connection || connection.userId && connection.userId !== userId || connection.channel !== campaign.channel) throw configuration('缺少当前用户授权的同渠道广告主账户','connection_missing');
    if (connection.status==='disabled') throw configuration('广告账户已停用，请先在渠道设置中启用','connection_disabled');
    if (!connection.expiresAt || !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now()) throw configuration('广告账户令牌已过期或缺少有效期，请重新授权并填写 expiresAt','token_expired');
    const secrets=await decryptConnectionSecrets(connection.secretsCiphertext,env.APP_ENCRYPTION_KEY);
    if (typeof secrets.accessToken !== 'string' || !secrets.accessToken.trim()) throw configuration('广告账户缺少 Access Token','connection_missing');
    const project=repo.getProject ? await repo.getProject(userId,campaign.projectId) : {};
    if (repo.getProject && !project) throw new AdsError('not_found','素材项目不存在',{status:404});
    const config=validateOceanEngineConfiguration(campaign,connection,project ?? {});
    const adapter=createOceanEngineAdapter({accessToken:secrets.accessToken,fetcher,timeoutMs:Math.max(1000,Math.min(20000,Number(env.APP_ADS_TIMEOUT_MS)||12000))});
    await adapter.validateReport(config);
    return {connection,config,adapter};
  }
  async function materialBytes(userId,campaign) {
    const ids=campaign.creativeIds;
    if (!Array.isArray(ids) || !ids.length || ids.length>20 || new Set(ids).size!==ids.length) throw configuration('请选择 1 至 20 个不重复的实际广告素材');
    const rows=await repo.listCreatives(userId,ids);
    if (rows.length!==ids.length || rows.some(row=>row.userId && row.userId!==userId || row.projectId!==campaign.projectId || row.status!=='approved' || !row.reviewedAt)) throw configuration('投放素材须属于当前用户与项目，并完成实际素材审核','creative_review_required');
    let cover=null;
    if (rows.some(row=>row.mimeType==='video/mp4')) {
      const coverId=campaign.platformConfig?.coverCreativeId;
      cover=coverId ? await repo.getCreative(userId,coverId) : null;
      if (!cover || cover.projectId!==campaign.projectId || cover.status!=='approved' || !cover.reviewedAt || cover.mimeType!=='image/png' || cover.userId && cover.userId!==userId) throw configuration('MP4 投放需要同项目已审核的实际 PNG 封面素材','cover_required');
    }
    const allRows=[...rows,...(cover?[cover]:[])];
    for (const row of allRows) await assertCreativeDeliveryComplete({ repository: repo, userId, creative: row });
    const map=new Map();
    for (const row of allRows) {
      if (map.has(row.id)) continue;
      if (!['image/png','video/mp4'].includes(row.mimeType)) throw configuration('巨量首版接收实际 PNG 与 MP4；WebM 请先转码后上传','needs_transcode');
      if (!bucket?.get || !row.objectKey) throw configuration('素材存储不可用','storage_unavailable');
      const object=await bucket.get(row.objectKey);
      if (!object || object.size>64*1024*1024) throw configuration('实际素材不存在或超过上传限制','creative_content_missing');
      const bytes=new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength>64*1024*1024) throw configuration('实际素材超过 64 MiB 上传限制');
      if (row.mimeType==='image/png') {
        if (bytes.byteLength<24 || ![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b)) throw configuration('图片实际内容不是 PNG','creative_content_invalid');
        const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        if (view.getUint32(16)!==Number(row.width) || view.getUint32(20)!==Number(row.height) || Number(row.width)<=0 || Number(row.height)<=0) throw configuration('图片记录尺寸与真实 PNG 内容不符','creative_content_invalid');
        if (bytes.byteLength>1.5*1024*1024) throw configuration('巨量图片文件超过 1.5 MiB，请先压缩');
      } else if (bytes.byteLength<12 || new TextDecoder().decode(bytes.subarray(4,8))!=='ftyp' || !Number.isFinite(row.duration) || row.duration<=0 || row.width<=0 || row.height<=0) throw configuration('MP4 文件或媒体尺寸时长无效，请重新生成实际视频','creative_content_invalid');
      map.set(row.id,{row,bytes});
    }
    return {rows,cover,map};
  }
  const audit=(u,c,action,details)=>repo.addAudit(u,{action,entityType:'campaign',entityId:c.id,details});
  async function patch(userId,campaign,data) { const result=await repo.updateCampaign(userId,campaign.id,data); if (!result) throw new AdsError('not_found','投放计划不存在',{status:404}); return result; }
  async function failure(userId,campaign,error,state) {
    const detail=safeError(error); const pending=Boolean(state?.writePending);
    const uncertain=detail.uncertain || pending && error?.code!=='provider_rejected';
    const status=uncertain?'needs_reconciliation':'blocked';
    const next=await patch(userId,campaign,{status,error:detail.message,launchStage:uncertain?'reconcile_required':'blocked',remoteState:{...state,...(!uncertain?{writePending:null}:{}),errorCode:detail.code,requestId:detail.requestId}});
    await audit(userId,next,'ads.operation_failed',{...detail,status}); return next;
  }
  async function launch(userId,input) {
    let campaign=await owned(userId,input);
    if (campaign.status==='active') return campaign;
    if (['launching','needs_reconciliation'].includes(campaign.status) || campaign.remoteState?.writePending) throw new AdsError('reconciliation_required','已有投放操作进行中或结果不明，请先在广告后台核对；系统不会重复创建');
    if (campaign.remoteId || campaign.remoteState?.projectId) {
      if (campaign.status!=='paused') throw new AdsError('reconciliation_required','已创建的渠道项目需要人工核对后继续，系统不会重复创建');
      return applyStatus(userId,campaign,true);
    }
    await assertDeliveryGroupAllocation(repo,userId,campaign);
    const attemptId=crypto.randomUUID();
    campaign=await repo.claimCampaignLaunch(userId,campaign.id,attemptId);
    if (!campaign) throw new AdsError('operation_in_progress','投放计划已被另一请求领取，请刷新状态');
    // Claim before reading materials or compiling channel payloads: a budget edit
    // may have completed after owned(), and launching excludes further edits.
    let ctx,materials;
    try { materials=await materialBytes(userId,campaign); ctx=await context(userId,campaign); }
    catch (error) { return failure(userId,campaign,error instanceof AdsError ? error : new AdsError('preflight_failed','无法读取或校验实际素材，请检查内容存储与账户配置'),campaign.remoteState??{}); }
    let state={...(campaign.remoteState??{}),phase:'uploading',uploads:{},promotionIds:[],writePending:null,attemptId,launchStartedAt:new Date().toISOString()};
    async function write(stage,fn) {
      state={...state,phase:stage,writePending:{stage,startedAt:new Date().toISOString()}};
      await patch(userId,campaign,{launchStage:stage,remoteState:state});
      const result=await fn(); return result;
    }
    async function checkpoint(stage,extra={}) { state={...state,...extra,phase:stage,writePending:null}; campaign=await patch(userId,campaign,{launchStage:stage,remoteState:state,...(state.projectId?{remoteId:String(state.projectId)}:{})}); }
    try {
      for (const {row,bytes} of materials.map.values()) {
        const uploaded=await write(`upload:${row.id}`,()=>ctx.adapter.upload({creative:row,bytes,accountId:ctx.config.accountId}));
        await checkpoint('uploaded',{uploads:{...state.uploads,[row.id]:uploaded}});
      }
      const project=await write('project_create',()=>ctx.adapter.createProject(ctx.config));
      await checkpoint('project_created',{projectId:project.id,projectRequestId:project.requestId});
      for (const creative of materials.rows) {
        const promotion=await write(`promotion_create:${creative.id}`,()=>ctx.adapter.createPromotion(ctx.config,state.projectId,creative,state.uploads[creative.id],materials.cover?state.uploads[materials.cover.id]:null));
        await checkpoint('promotions_created',{promotionIds:[...state.promotionIds,promotion.id],promotionCreatives:{...(state.promotionCreatives??{}),[promotion.id]:creative.id}});
      }
      await write('enable',()=>ctx.adapter.status(ctx.config,state.projectId,state.promotionIds,true));
      state={...state,phase:'active',writePending:null,launchedAt:new Date().toISOString()};
      campaign=await patch(userId,campaign,{status:'active',error:null,launchStage:'active',remoteId:String(state.projectId),remoteState:state,nextSyncAt:new Date(Date.now()+5*60000).toISOString()});
      await audit(userId,campaign,'ads.launched',{channel:campaign.channel,projectId:state.projectId,promotionIds:state.promotionIds,creativeIds:campaign.creativeIds,buyingEmployeeId:campaign.buyingEmployeeId,dailyBudget:campaign.dailyBudget});
      return campaign;
    } catch(error) { return failure(userId,campaign,error,state); }
  }
  async function applyStatus(userId,campaign,enable) {
    const operationId=crypto.randomUUID(); let claimed=await repo.claimCampaignOperation(userId,campaign.id,operationId);
    if (!claimed) throw new AdsError('operation_in_progress','当前计划已有投放操作，请稍后刷新');
    let state={...(claimed.remoteState??{})}; let externalWriteStarted=false;
    try {
      if (state.writePending || claimed.status==='needs_reconciliation') throw new AdsError('reconciliation_required','已有未核实渠道写入，请先核对广告后台');
      if (enable && claimed.status==='active' || !enable && claimed.status==='paused') return claimed;
      if (enable && claimed.status!=='paused' || !enable && claimed.status!=='active') throw configuration('当前计划状态不允许本次启停操作');
      if (enable) { await assertDeliveryGroupAllocation(repo,userId,claimed); await materialBytes(userId,claimed); }
      const ctx=await context(userId,claimed);
      if (!state.projectId || !state.promotionIds?.length) throw configuration('缺少真实渠道项目或营销 ID，无法修改投放状态');
      if (enable) {
        const lifetime=await ctx.adapter.report(ctx.config,{startTime:lifetimeStart(state),endTime:localDateTime(),projectId:state.projectId});
        const remaining=remainingBudget(claimed.totalBudget,lifetime.spend);
        if (!lifetime.dataFresh || remaining<=0) throw configuration('真实累计消耗已达到总预算，或累计数据不可用；请调整预算后再恢复','budget_exhausted');
        state={...state,resumeBudgetProof:lifetime.proof,resumeLifetimeSpend:lifetime.spend};
        const effectiveBudget=Math.min(Number(claimed.dailyBudget),remaining);
        // Every explicit resume applies the locked, current budget, including user increases.
        state={...state,writePending:{stage:'resume_budget_set',startedAt:new Date().toISOString()}};
        await patch(userId,claimed,{remoteState:state});
        externalWriteStarted=true;
        const budgetProof=await ctx.adapter.budget(ctx.config,state.projectId,effectiveBudget);
        state={...state,writePending:null,lastGuardBudgetUpdateAt:new Date().toISOString(),resumeBudgetReadback:budgetProof};
        const requestedBudget=claimed.dailyBudget;
        claimed=await patch(userId,claimed,{dailyBudget:effectiveBudget,remoteState:state});
        await audit(userId,claimed,'ads.resume_budget_set',{requestedDailyBudget:requestedBudget,appliedDailyBudget:effectiveBudget,lifetimeSpend:lifetime.spend,proof:lifetime.proof,readback:budgetProof});
      }
      state={...state,writePending:{stage:enable?'resume':'pause',startedAt:new Date().toISOString()}};
      await patch(userId,claimed,{remoteState:state});
      externalWriteStarted=true;
      await ctx.adapter.status(ctx.config,state.projectId,state.promotionIds,enable);
      state={...state,phase:enable?'active':'paused',writePending:null};
      const next=await patch(userId,claimed,{status:enable?'active':'paused',error:null,remoteState:state,launchStage:state.phase});
      await audit(userId,next,enable?'ads.resumed':'ads.paused',{projectId:state.projectId,promotionIds:state.promotionIds}); return next;
    } catch(error) {
      if (!externalWriteStarted && !state.writePending) {
        const detail=safeError(error);
        const next=await patch(userId,claimed,{status:claimed.status,error:detail.message,remoteState:state});
        await audit(userId,next,enable?'ads.resume_blocked':'ads.pause_blocked',{code:detail.code,reason:detail.message}); return next;
      }
      return failure(userId,claimed,error,state);
    }
    finally { await repo.releaseCampaignOperation(userId,campaign.id,operationId); }
  }
  async function pause(userId,input) {
    const campaign=await owned(userId,input); if (campaign.status==='paused') return campaign;
    if (campaign.remoteState?.writePending || campaign.status==='needs_reconciliation') throw new AdsError('reconciliation_required','上一次写入结果不明，请先在渠道后台核对');
    return applyStatus(userId,campaign,false);
  }
  async function sync(userId,input) {
    let campaign=await owned(userId,input);
    if (!['active','paused'].includes(campaign.status) || !campaign.remoteState?.projectId || campaign.remoteState.writePending) throw configuration('当前计划没有可同步的已核实渠道投放','campaign_not_live');
    const operationId=crypto.randomUUID();
    campaign=await repo.claimCampaignOperation(userId,campaign.id,operationId);
    if (!campaign) throw new AdsError('operation_in_progress','该计划正在进行其他投放操作');
    let state=campaign.remoteState; let metric;
    try {
      if (!['active','paused'].includes(campaign.status) || !state?.projectId || state.writePending) throw configuration('计划状态已改变，本轮不读取或执行新投放','campaign_not_live');
      const ctx=await context(userId,campaign);
      const date=today(),endTime=localDateTime();
      const report=await ctx.adapter.report(ctx.config,{startTime:`${date} 00:00:00`,endTime,projectId:state.projectId});
      const lifetime=await ctx.adapter.report(ctx.config,{startTime:lifetimeStart(state),endTime,projectId:state.projectId});
      const evaluated=evaluateCampaign({...campaign,...report,revenue:report.revenue??0});
      let decision={...evaluated}; const remaining=remainingBudget(campaign.totalBudget,lifetime.spend); let budgetGuard=null;
      if (remaining<=0) budgetGuard={action:'pause',reason:'真实渠道累计消耗已达到计划总预算上限，暂停投放'};
      else if (report.spend>=campaign.dailyBudget) budgetGuard={action:'pause',reason:'真实渠道当日消耗已达到计划日预算，暂停投放'};
      else if (remaining<campaign.dailyBudget) budgetGuard={action:'reduce',newBudget:remaining,reason:'剩余总预算低于日预算，收缩实际渠道预算'};
      if (budgetGuard?.action==='pause') decision={action:'pause',newBudget:campaign.dailyBudget,roi:evaluated.roi,reason:budgetGuard.reason};
      else if (budgetGuard?.action==='reduce') decision={action:'hold',newBudget:remaining,roi:evaluated.roi,reason:budgetGuard.reason};
      else if (decision.action==='increase' && decision.newBudget>remaining) decision={...decision,action:'approval',reason:'加量将超过剩余总预算，需要调整预算后再执行'};
      if (decision.action==='increase' && campaign.deliveryGroupId) {
        try { await assertDeliveryGroupAllocation(repo,userId,campaign,{dailyBudget:decision.newBudget}); }
        catch(error) {
          if (!['delivery_group_budget_exceeded','delivery_group_reconciliation_required'].includes(error?.code)) throw error;
          decision={...decision,action:'approval',newBudget:campaign.dailyBudget,reason:error.message};
        }
      }
      metric=await repo.upsertMetrics(userId,{campaignId:campaign.id,date,source:'oceanengine',spend:report.spend,revenue:report.revenue,conversions:report.conversions,hasConversion:report.hasConversion,dataFresh:true,impressions:report.impressions,clicks:report.clicks,roi:decision.roi,metadata:{proof:report.proof,lifetimeProof:lifetime?.proof,lifetimeSpend:lifetime?.spend??null,budgetGuard,decision}});
      const ctrReady=report.dataFresh && Number.isFinite(report.impressions) && report.impressions>=1000 && Number.isFinite(report.clicks) && report.clicks>=0 && report.clicks<=report.impressions;
      const ctrIteration=decision.action==='hold' && ctrReady;
      const snapshot=JSON.stringify([date,report.spend,report.revenue,report.conversions,report.impressions,report.clicks,decision.action]); let optimizationTask=null;
      if (campaign.autoOptimize && !budgetGuard && snapshot!==state.lastOptimizationSnapshot && (['pause','increase','approval'].includes(decision.action) || ctrIteration)) {
        const openTasks=repo.listOptimizationTasks ? await repo.listOptimizationTasks(userId) : [];
        const hasOpenTask=openTasks.some(task=>task.campaignId===campaign.id&&['pending','planning','producing','awaiting_data','needs_external_video_production'].includes(task.status));
        if (!hasOpenTask) optimizationTask=await repo.addOptimizationTask(userId,{campaignId:campaign.id,projectId:campaign.projectId,type:'creative_optimization',status:'pending',reason:ctrIteration?'真实曝光与点击达到实验门槛，生成标题和版式对照；保持预算与ROI判断':decision.reason,metadata:{employeeId:campaign.buyingEmployeeId,creativeIds:campaign.creativeIds,sourceMetricId:metric.id,source:'oceanengine',signal:ctrIteration?'ctr':'roi',proof:report.proof,nextCreativeInstructions:ctrIteration?'仅依据真实曝光与点击及已上传事实，生成标题和版式对照实验；收入与转化证据不足时不得给出ROI或订单结论':decision.action==='pause'?'基于已上传事实与真实反馈，生成替代开头、卖点顺序和 CTA 方案；不虚构转化与收益':'保留有效事实，制作对照素材版本；继续按预算上限验证'}});
        state={...state,lastOptimizationSnapshot:snapshot};
      }
      if (campaign.status==='active') {
        const priorBudget=Number(campaign.dailyBudget); const lastChange=Date.parse(state.lastBudgetUpdateAt??'');
        const canIncrease=campaign.autoOptimize && !budgetGuard && decision.action==='increase' && (!Number.isFinite(lastChange)||Date.now()-lastChange>=24*3600000) && decision.newBudget<=campaign.maxDailyBudget;
        const execution=budgetGuard?.action ?? (campaign.autoOptimize && decision.action==='pause' ? 'pause' : canIncrease ? 'increase' : null);
        if (execution) {
          state={...state,writePending:{stage:execution,startedAt:new Date().toISOString()}}; await patch(userId,campaign,{remoteState:state});
          let readback;
          if (execution==='pause') { readback=await ctx.adapter.status(ctx.config,state.projectId,state.promotionIds,false); campaign={...campaign,status:'paused'}; }
          else {
            const nextBudget=execution==='reduce'?budgetGuard.newBudget:decision.newBudget;
            readback=await ctx.adapter.budget(ctx.config,state.projectId,nextBudget); campaign={...campaign,dailyBudget:nextBudget};
            state={...state,...(execution==='increase'?{lastBudgetUpdateAt:new Date().toISOString(),metricsBudgetFingerprint:snapshot}:{lastGuardBudgetUpdateAt:new Date().toISOString()})};
          }
          const confirmedState={...state,writePending:null,phase:campaign.status,...(execution!=='pause'?{lastBudgetAdjustment:{previousBudget:priorBudget,newBudget:campaign.dailyBudget,direction:campaign.dailyBudget>priorBudget?'increase':'decrease',actor:'employee',at:new Date().toISOString(),reason:budgetGuard?.reason||decision.reason}}:{})};
          campaign=await patch(userId,campaign,{status:campaign.status,dailyBudget:campaign.dailyBudget,remoteState:confirmedState});
          state=confirmedState;
          await audit(userId,campaign,budgetGuard?`ads.budget_guard_${execution}`:`ads.auto_${execution}`,{decision,budgetGuard,previousBudget:priorBudget,sourceMetricId:metric.id,projectId:state.projectId,readback});
        }
      }
      campaign=await patch(userId,campaign,{status:campaign.status,dailyBudget:campaign.dailyBudget,remoteState:state,error:null,lastSyncedAt:new Date().toISOString(),nextSyncAt:new Date(Date.now()+5*60000).toISOString()});
      await audit(userId,campaign,'ads.synced',{sourceMetricId:metric.id,requestIds:report.proof.requestIds,decision,executedAutomatically:campaign.autoOptimize});
      return {campaign,metric,decision,optimizationTask};
    } catch(error) {
      if (state.writePending || error?.uncertain) campaign=await failure(userId,campaign,error,state);
      else { const detail=safeError(error); campaign=await patch(userId,campaign,{error:detail.message,nextSyncAt:new Date(Date.now()+5*60000).toISOString()}); await audit(userId,campaign,'ads.sync_failed',{...detail,decision:'hold'}); }
      return {campaign,metric:metric??null,decision:{action:'hold',newBudget:campaign.dailyBudget,roi:null,reason:'数据不完整或执行结果待核对，本轮不再操作'},optimizationTask:null};
    } finally { await repo.releaseCampaignOperation(userId,campaign.id,operationId); }
  }
  async function adjustBudget(userId,input,requested={}) {
    let campaign=await owned(userId,input);
    if (!['active','paused'].includes(campaign.status) || !campaign.remoteState?.projectId || campaign.remoteState.writePending) throw configuration('仅可调整已核实的实际投放预算；待投放计划请编辑预算草稿','campaign_not_live');
    const operationId=crypto.randomUUID();
    campaign=await repo.claimCampaignOperation(userId,campaign.id,operationId);
    if (!campaign) throw new AdsError('operation_in_progress','该计划正在进行其他投放操作');
    let state=campaign.remoteState; let writeStarted=false;
    try {
      if (!['active','paused'].includes(campaign.status) || !state?.projectId || state.writePending) throw configuration('计划状态已改变，本轮不修改预算','campaign_not_live');
      const values={};
      for (const key of ['dailyBudget','totalBudget','maxDailyBudget','targetRoi']) {
        const value=Number(requested[key]??campaign[key]);
        if (!Number.isFinite(value)||value<=0||key!=='targetRoi'&&Math.abs(value*100-Math.round(value*100))>0.000001) throw configuration('预算须为大于零且最多两位小数的金额','invalid_budget');
        values[key]=value;
      }
      if (values.dailyBudget>values.maxDailyBudget||values.dailyBudget>values.totalBudget||values.maxDailyBudget>(Number(env.APP_MAX_DAILY_BUDGET)||1000)||values.targetRoi>1000) throw configuration('预算超过已设置的上限','invalid_budget');
      await assertDeliveryGroupAllocation(repo,userId,campaign,values);
      const ctx=await context(userId,{...campaign,...values});
      const lifetime=await ctx.adapter.report(ctx.config,{startTime:lifetimeStart(state),endTime:localDateTime(),projectId:state.projectId});
      if (!lifetime.dataFresh || values.totalBudget<=lifetime.spend) throw configuration('新总预算须高于已核实累计消耗','budget_exhausted');
      if (values.dailyBudget>remainingBudget(values.totalBudget,lifetime.spend)) throw configuration('日预算超过剩余总预算，请降低日预算或明确提高总额度','budget_exhausted');
      const previousBudget=Number(campaign.dailyBudget);
      state={...state,writePending:{stage:'manual_budget_update',startedAt:new Date().toISOString()}};
      await patch(userId,campaign,{remoteState:state});writeStarted=true;
      const readback=await ctx.adapter.budget(ctx.config,state.projectId,values.dailyBudget);
      const confirmedState={...state,writePending:null,lastBudgetUpdateAt:new Date().toISOString(),lastBudgetAdjustment:{previousBudget,newBudget:values.dailyBudget,direction:values.dailyBudget>previousBudget?'increase':values.dailyBudget<previousBudget?'decrease':'unchanged',actor:'user',at:new Date().toISOString()}};
      campaign=await patch(userId,campaign,{...values,remoteState:confirmedState,error:null});
      state=confirmedState;
      await audit(userId,campaign,'ads.manual_budget_updated',{previousBudget,newBudget:values.dailyBudget,requested:values,lifetimeSpend:lifetime.spend,readback});
      return {campaign,readback};
    } catch(error) {
      if (writeStarted||state?.writePending||error?.uncertain) return {campaign:await failure(userId,campaign,error,state)};
      throw error;
    } finally { await repo.releaseCampaignOperation(userId,campaign.id,operationId); }
  }
  // Every grouped execution observes one coherent allocation. Never take this
  // lock after claiming a campaign: manual edits use the same group-first order.
  async function guarded(userId,input,operation,...args) {
    const campaign=await owned(userId,input);
    return withDeliveryGroupLock(repo,userId,campaign.deliveryGroupId,()=>operation(userId,campaign,...args));
  }
  const guardedSync=(userId,input)=>guarded(userId,input,sync);
  async function tick() {
    const campaigns=await repo.listDueCampaigns(20); const results=[];
    for (const campaign of campaigns) {
      if (!campaign.userId || campaign.status!=='active') continue;
      try { const result=await guardedSync(campaign.userId,campaign); results.push({campaignId:campaign.id,status:result.campaign.status,action:result.decision.action}); }
      catch(error) { results.push({campaignId:campaign.id,status:'held',code:safeError(error).code}); }
    }
    return {processed:results.length,results};
  }
  return {launch:(u,c)=>guarded(u,c,launch),pause:(u,c)=>guarded(u,c,pause),sync:guardedSync,adjustBudget:(u,c,requested)=>guarded(u,c,adjustBudget,requested),tick};
}
