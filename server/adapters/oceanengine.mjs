import { createHash } from 'node:crypto';
import { configuration, AdsError, createProviderClient } from './provider-http.mjs';
const PROJECT_FIELDS = new Set(['ad_type','advertiser_id','advertising_volume','app_name','app_promotion_type','asset_type','audience','audience_extend','auto_extend_traffic','blue_flow_package','budget_group_id','classify','delivery_mode','delivery_range','delivery_setting','delivery_type','download_mode','download_type','download_url','dpa_adtype','dpa_product_target','item_number','keywords','landing_page_stay_time','landing_type','launch_type','marketing_goal','micro_app_instance_id','micro_promotion_type','multi_asset_type','name','native_setting','open_url','open_url_field','open_url_params','open_url_type','operation','optimize_goal','promotion_type','quick_app_id','related_product','rta_id','search_bid_ratio','subscribe_url','track_url_setting','ulink_url','ulink_url_type','value_optimized_type','yuntu_5a_brand_id','yuntu_5a_brand_main_industry_id']);
const PROMOTION_FIELDS = new Set(['7d_retention','ad_download_status','advertiser_id','auto_extend_traffic','bid','brand_info','budget','budget_mode','config_id','cpa_bid','deep_cpabid','first_roi_goal','is_comment_disable','keywords','materials_type','name','native_setting','operation','project_id','promotion_materials','promotion_related_product','roi_goal','source','union_bid_ratio']);
export function safePublicUrl(value) {
  let url; try { url = new URL(value); } catch { throw configuration('落地页必须是可公开访问的 HTTPS 地址'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || !host.includes('.')) throw configuration('落地页必须是可公开访问的 HTTPS 域名，不能使用本机、IP 或内网地址');
  return url.href;
}
function validateJson(value, depth = 0) {
  if (depth > 10) throw configuration('渠道模板嵌套过深');
  if (value === null || ['boolean','string'].includes(typeof value)) { if (typeof value === 'string' && value.length > 10000) throw configuration('渠道模板字段过长'); return; }
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { if (value.length > 100) throw configuration('渠道模板列表过长'); value.forEach(v => validateJson(v, depth + 1)); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) { if (['__proto__','prototype','constructor','access_token','accessToken','secret','app_secret'].includes(key)) throw configuration('渠道模板含禁止字段'); validateJson(child, depth + 1); }
    return;
  }
  throw configuration('渠道模板只能包含有限 JSON 值');
}
function template(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw configuration(`缺少经过账户校验的${label}模板`);
  if (JSON.stringify(value).length > 50000) throw configuration('渠道模板过大'); validateJson(value);
  for (const key of Object.keys(value)) if (!fields.has(key)) throw configuration(`${label}模板含未支持字段 ${key}`);
  return structuredClone(value);
}
function requiredEnum(value, allowed, label) { if (!allowed.includes(value)) throw configuration(`${label}必须为 ${allowed.join(' / ')}`); }
function exactIntegerId(value, label, uncertain = false) {
  const text=String(value);
  if ((typeof value==='number' && !Number.isSafeInteger(value)) || !/^[1-9]\d{0,18}$/.test(text) || BigInt(text)>9223372036854775807n) {
    if (uncertain) throw new AdsError('invalid_provider_response', `渠道返回了无效${label}`, {uncertain:true});
    throw configuration(`${label}必须为精确的正整数，请使用字符串保存完整账号 ID`);
  }
  return BigInt(text)<=BigInt(Number.MAX_SAFE_INTEGER) ? Number(text) : text;
}
function accountNumber(value) { return exactIntegerId(value,'广告主账户 ID'); }
function providerId(value,label) { return exactIntegerId(value,label,true); }
export function validateOceanEngineConfiguration(campaign, connection, project = {}) {
  const cfg = campaign.platformConfig ?? {};
  if (cfg.budgetUnit !== 'yuan') throw configuration('请根据当前账户官方文档设置预算单位 budgetUnit 为 yuan；首版仅支持人民币元模板');
  const daily = Number(campaign.dailyBudget), total = Number(campaign.totalBudget), max = Number(campaign.maxDailyBudget);
  if (![daily,total,max].every(n => Number.isFinite(n) && n > 0) || daily > total || daily > max) throw configuration('预算必须有效且日预算不得超过总预算及日预算上限');
  const accountId = accountNumber(connection.accountId);
  const p = template(cfg.project, PROJECT_FIELDS, '项目'); const promotion = template(cfg.promotion, PROMOTION_FIELDS, '营销');
  for (const t of [p,promotion]) if (t.advertiser_id !== undefined && String(t.advertiser_id) !== String(accountId)) throw configuration('渠道模板广告主账户与连接账户不一致');
  if (promotion.project_id !== undefined || promotion.promotion_materials !== undefined) throw configuration('营销模板不得预置项目 ID 或素材 ID；系统会使用本次真实上传结果');
  requiredEnum(p.ad_type, ['ALL','SEARCH'], 'ad_type'); requiredEnum(p.landing_type, ['APP','DPA','LINK','MICRO_GAME','NATIVE_ACTION','QUICK_APP','SHOP'], 'landing_type');
  requiredEnum(p.marketing_goal, ['VIDEO_AND_IMAGE'], 'marketing_goal');
  if (!p.delivery_range || !p.delivery_setting) throw configuration('项目模板缺少 delivery_range 或 delivery_setting');
  requiredEnum(p.delivery_range.inventory_catalog, ['MANUAL','UNIVERSAL_SMART'], 'inventory_catalog');
  requiredEnum(p.delivery_setting.bid_type, ['CUSTOM','NO_BID','OPTIMAL_COST','UPPER_CONTROL'], 'bid_type');
  requiredEnum(p.delivery_setting.budget_mode, ['BUDGET_MODE_DAY'], 'budget_mode');
  if (p.delivery_setting.pricing !== undefined) requiredEnum(p.delivery_setting.pricing, ['PRICING_CPC','PRICING_CPM','PRICING_OCPC','PRICING_OCPM'], 'pricing');
  const report = cfg.report, mapping = cfg.metricMapping;
  const projectDimension = mapping?.projectId;
  if (!report || !Array.isArray(report.dimensions) || report.dimensions.length !== 1 || report.dimensions[0] !== projectDimension || !/^(?:[a-z0-9_]*_)?project_id$/.test(projectDimension ?? '') || !Array.isArray(report.metrics) || !report.metrics.length || !Array.isArray(report.filters) || !Array.isArray(report.order_by)) throw configuration('报表模板需使用单一项目 ID 维度，并在 metricMapping.projectId 中指定其官方字段；同时填写真实指标与 filters/order_by 数组');
  validateJson(report); validateJson(mapping);
  if (!mapping || typeof mapping.spend !== 'string' || !report.metrics.includes(mapping.spend)) throw configuration('请设置渠道报表消耗字段 metricMapping.spend');
  for (const key of ['revenue','conversions','impressions','clicks']) if (mapping[key] !== undefined && (typeof mapping[key] !== 'string' || !report.metrics.includes(mapping[key]))) throw configuration(`报表中缺少 ${key} 映射字段`);
  const landingUrl = cfg.landingUrl || project.landingUrl;
  if (p.landing_type === 'LINK' && !landingUrl) throw configuration('LINK 投放缺少真实落地页');
  const url = landingUrl ? safePublicUrl(landingUrl) : null;
  const titles = cfg.titles;
  if (!Array.isArray(titles) || !titles.length || titles.length > 10 || titles.some(t => typeof t !== 'string' || !t.trim() || t.length > 100)) throw configuration('请设置 1 至 10 条实际广告标题');
  // Budgets, ownership, status and source IDs are compiled; templates cannot replace them.
  p.advertiser_id = accountId; p.name = String(campaign.name).slice(0,80); p.operation = 'DISABLE';
  p.delivery_setting.budget_mode = 'BUDGET_MODE_DAY'; p.delivery_setting.budget = daily;
  if (promotion.budget !== undefined) promotion.budget = daily;
  if (promotion.budget_mode !== undefined) promotion.budget_mode = 'BUDGET_MODE_DAY';
  promotion.advertiser_id = accountId; promotion.operation = 'DISABLE';
  return { cfg, accountId, projectTemplate: p, promotionTemplate: promotion, report, mapping, url, titles };
}
function assertMutationResult(result, {kind, ids}) {
  if (result.errors !== undefined && !Array.isArray(result.errors)) throw new AdsError('invalid_provider_response','渠道批量写入返回了无效错误列表',{uncertain:true,requestId:result._requestId});
  if (result.errors?.length) throw new AdsError('provider_partial_failure','渠道批量写入包含单项失败，请根据请求编号核对实际状态',{uncertain:true,requestId:result._requestId});
  // Success arrays alone are ambiguous; the adapter reads back the actual entity state.
  void kind; void ids;
  return result;
}
export function createOceanEngineAdapter({ accessToken, fetcher, timeoutMs }) {
  const request = createProviderClient({ accessToken, fetcher, timeoutMs });
  async function readback(config,projectId,promotionIds,{status,budget}={}) {
    const project=await request('/open_api/v3.0/project/list/',{query:{advertiser_id:config.accountId,filtering:{ids:[projectId]},fields:['project_id','advertiser_id','opt_status','delivery_setting']}});
    const projects=Array.isArray(project.list)?project.list.filter(row=>String(row.project_id)===String(projectId)&&String(row.advertiser_id)===String(config.accountId)):[];
    if (projects.length!==1 || status && projects[0].opt_status!==status || budget!==undefined && (projects[0].delivery_setting?.budget_mode!=='BUDGET_MODE_DAY' || Number(projects[0].delivery_setting?.budget)!==Number(budget))) throw new AdsError('write_not_verified','渠道项目读回状态与提交目标不一致，请在广告后台核对',{uncertain:true,requestId:project._requestId});
    const proof={projectRequestId:project._requestId};
    if (status && promotionIds.length) {
      const promotions=await request('/open_api/v3.0/promotion/list/',{query:{advertiser_id:config.accountId,filtering:{ids:promotionIds,project_id:projectId},fields:['promotion_id','project_id','advertiser_id','opt_status']}});
      const rows=Array.isArray(promotions.list)?promotions.list:[];
      if (!promotionIds.every(id=>rows.filter(row=>String(row.promotion_id)===String(id)&&String(row.project_id)===String(projectId)&&String(row.advertiser_id)===String(config.accountId)&&row.opt_status===status).length===1)) throw new AdsError('write_not_verified','渠道营销读回状态与提交目标不一致，请在广告后台核对',{uncertain:true,requestId:promotions._requestId});
      proof.promotionRequestId=promotions._requestId;
    }
    return proof;
  }
  return {
    async validateReport(config) {
      if (typeof config.report.data_topic !== 'string' || !config.report.data_topic.trim()) throw configuration('报表模板缺少官方 data_topic');
      const result=await request('/open_api/v3.0/report/custom/config/get/',{query:{advertiser_id:config.accountId,data_topics:[config.report.data_topic]}});
      const topic=Array.isArray(result.list) ? result.list.find(item=>item.data_topic===config.report.data_topic) : null;
      if (!topic || !Array.isArray(topic.dimensions) || !Array.isArray(topic.metrics)) throw configuration('该账户尚无可核实的报表主题配置');
      const projectField=topic.dimensions.find(item=>item.field===config.mapping.projectId);
      if (!projectField || projectField.filter_able!==true || !Number.isInteger(projectField.filter_config?.type)) throw configuration('项目 ID 维度缺少官方支持的过滤配置，请从该账户参数生成器重新设置');
      if (config.report.metrics.some(field=>!topic.metrics.some(item=>item.field===field))) throw configuration('报表模板包含该账户主题不支持的指标');
      config.projectFilter={field:projectField.field,type:projectField.filter_config.type,...(Number.isInteger(projectField.filter_config.operator)?{operator:projectField.filter_config.operator}:{})};
      config.reportConfigRequestId=result._requestId;
      return config;
    },
    async upload({ creative, bytes, accountId }) {
      const video = creative.mimeType === 'video/mp4';
      if (!video && creative.mimeType !== 'image/png') throw configuration('此渠道首版只接收 PNG 图片和 MP4 视频；WebM 请先转码', 'needs_transcode');
      if (!video && bytes.byteLength > 1.5 * 1024 * 1024) throw configuration('巨量图片上传不得超过 1.5 MiB，请先压缩实际图片');
      const form = new FormData(); form.set('advertiser_id', String(accountId)); form.set('upload_type','UPLOAD_BY_FILE');
      const kind = video ? 'video' : 'image'; form.set(`${kind}_file`,new Blob([bytes],{type:creative.mimeType}),creative.filename || `${creative.id}.${video?'mp4':'png'}`);
      form.set(`${kind}_signature`,createHash('md5').update(bytes).digest('hex')); form.set('filename',creative.filename || creative.id);
      const result = await request(`/open_api/2/file/${kind}/ad/`,{method:'POST',body:form});
      const id = video ? result.video_id : result.id;
      if (typeof id !== 'string' || !id) throw new AdsError('invalid_provider_response', '真实素材上传响应缺少素材 ID', { uncertain: true });
      return { kind, id, creativeId: creative.id, requestId: result._requestId };
    },
    async createProject(config) { const result=await request('/open_api/v3.0/project/create/',{method:'POST',body:config.projectTemplate}); return { id:providerId(result.project_id,'项目 ID'),requestId:result._requestId }; },
    async createPromotion(config, projectId, creative, uploaded, cover) {
      const materials = { title_material_list: config.titles.map(title => ({title})) };
      if (config.url) materials.external_url_material_list = [config.url];
      if (uploaded.kind === 'video') {
        if (!cover?.id) throw configuration('MP4 视频需要同账户真实上传的 PNG 封面');
        materials.video_material_list = [{ image_mode: creative.width >= creative.height ? 'CREATIVE_IMAGE_MODE_VIDEO' : 'CREATIVE_IMAGE_MODE_VIDEO_VERTICAL', video_id:uploaded.id,video_cover_id:cover.id }];
      } else materials.image_material_list = [{image_mode:creative.width >= creative.height ? 'CREATIVE_IMAGE_MODE_LARGE' : 'CREATIVE_IMAGE_MODE_LARGE_VERTICAL',images:[{image_id:uploaded.id}]}];
      const result=await request('/open_api/v3.0/promotion/create/',{method:'POST',body:{...config.promotionTemplate,advertiser_id:config.accountId,project_id:projectId,name:String(`${creative.title || creative.id}`).slice(0,80),operation:'DISABLE',promotion_materials:materials}});
      return { id:providerId(result.promotion_id,'营销 ID'),creativeId:creative.id,requestId:result._requestId };
    },
    async status(config, projectId, promotionIds, enable) {
      const opt_status = enable ? 'ENABLE' : 'DISABLE';
      // Disable the project first for stop-loss. Enable only after all promotions exist.
      if (!enable) assertMutationResult(await request('/open_api/v3.0/project/status/update/',{method:'POST',allowEmptySuccess:true,body:{advertiser_id:config.accountId,data:[{project_id:projectId,opt_status}]}}),{kind:'project',ids:[projectId]});
      if (promotionIds.length) assertMutationResult(await request('/open_api/v3.0/promotion/status/update/',{method:'POST',allowEmptySuccess:true,body:{advertiser_id:config.accountId,data:promotionIds.map(id=>({promotion_id:id,opt_status}))}}),{kind:'promotion',ids:promotionIds});
      if (enable) assertMutationResult(await request('/open_api/v3.0/project/status/update/',{method:'POST',allowEmptySuccess:true,body:{advertiser_id:config.accountId,data:[{project_id:projectId,opt_status}]}}),{kind:'project',ids:[projectId]});
      return readback(config,projectId,promotionIds,{status:opt_status});
    },
    async budget(config, projectId, budget) {
      assertMutationResult(await request('/open_api/v3.0/project/budget/update/',{method:'POST',allowEmptySuccess:true,body:{advertiser_id:config.accountId,data:[{project_id:projectId,budget_mode:'BUDGET_MODE_DAY',budget}]}}),{kind:'project',ids:[projectId]});
      return readback(config,projectId,[],{budget});
    },
    async report(config, { startTime, endTime, projectId }) {
      const r = config.report; let page=1; const rows=[]; const requestIds=[];
      for (;;) {
        const result=await request('/open_api/v3.0/report/custom/get/',{query:{advertiser_id:config.accountId,dimensions:r.dimensions,metrics:r.metrics,filters:[...r.filters.filter(item=>item.field!==config.mapping.projectId),{...config.projectFilter,values:[String(projectId)]}],order_by:r.order_by,data_topic:r.data_topic,start_time:startTime,end_time:endTime,page,page_size:100}});
        if (!Array.isArray(result.rows)) throw new AdsError('invalid_provider_response','渠道报表缺少 rows');
        requestIds.push(result._requestId); rows.push(...result.rows.filter(row => String(row.dimensions?.[config.mapping.projectId]) === String(projectId)));
        const totalPages=Number(result.page_info?.total_page ?? 1);
        if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 20) throw new AdsError('report_incomplete','报表分页数量超出可核实范围，请缩小账户模板范围');
        if (page >= totalPages) break; page++;
      }
      if (rows.length !== 1) throw new AdsError('report_incomplete',rows.length ? '项目聚合报表返回多行，无法确认唯一快照' : '当前项目尚无可核实报表，本轮保持预算');
      const metrics = rows[0].metrics;
      if (!metrics || typeof metrics !== 'object') throw new AdsError('invalid_provider_response','渠道报表缺少指标对象');
      const number = field => { const raw = field ? metrics[field] : undefined; if (raw === null || raw === undefined || typeof raw === 'boolean' || typeof raw === 'string' && !raw.trim()) return null; const value=Number(raw); return Number.isFinite(value) && value >= 0 ? value : null; };
      const spend=number(config.mapping.spend); if (spend === null) throw new AdsError('invalid_provider_response','渠道消耗指标缺失或无效');
      const revenue=number(config.mapping.revenue),conversions=number(config.mapping.conversions);
      return { spend,revenue,conversions,impressions:number(config.mapping.impressions),clicks:number(config.mapping.clicks),hasConversion:revenue!==null&&conversions!==null,dataFresh:true,proof:{requestIds,projectId,startTime,endTime,dimensions:rows[0].dimensions,metricMapping:config.mapping} };
    }
  };
}
