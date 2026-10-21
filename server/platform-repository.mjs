/** Durable D1 repository. User operations always scope SQL to the authenticated owner. */
import { isAutomaticallyRecoverableBxagiProductionJob } from './bxagi-orchestrator.mjs';
import { bxagiRecoveryDue } from './bxagi-recovery.mjs';
import { mergeBxagiNodeHealth, sanitizeBxagiNodeObservation } from './bxagi-node-health.mjs';
const JSON_FIELDS = new Set(['facts','assignment','metadata','creativeIds','sourceAssetIds','platformConfig','remoteState','creativePlan','definition','details','productionSpec','sourceState','policy','preferences','evidence','actionPlan','result']);
const BOOL_FIELDS = new Set(['autoOptimize','hasConversion','dataFresh']);
const TABLE_FIELDS = {
  employeeProfiles: ['name','role','scene','definition'],
  projects: ['title','productName','description','facts','objective','audience','landingUrl','scene','productionEmployeeId','assignment','creativePlan','productionSpec','sourceState'],
  assets: ['projectId','filename','mimeType','size','role','objectKey','metadata','status','uploadRequestId'],
  creatives: ['projectId','filename','mimeType','size','objectKey','title','variantId','format','employeeId','sourceAssetIds','validation','width','height','duration','status','reviewedBy','reviewedAt','metadata'],
  campaigns: ['projectId','deliveryGroupId','unitKey','creativeIds','name','channel','dailyBudget','totalBudget','maxDailyBudget','targetRoi','objective','autoOptimize','connectionId','platformConfig','remoteState','operationId','buyingEmployeeId','status','remoteId','error','launchStage','launchAttemptId','lastSyncedAt','nextSyncAt'],
  deliveryGroups: ['projectId','name','dailyBudget','totalBudget','status','policy','operationId'],
  userPreferences: ['displayName','notificationEmail','preferences'],
  decisions: ['projectId','campaignId','type','status','title','reason','evidence','actionPlan','result'],
  strategies: ['projectId','campaignId','name','version','status','kind','definition','evidence','sourceDecisionId'],
  metrics: ['campaignId','projectId','date','source','spend','revenue','conversions','hasConversion','dataFresh','impressions','clicks','roi','metadata'],
  connections: ['channel','accountId','label','secretsCiphertext','expiresAt','appId','status'], audit: ['action','entityType','entityId','details'],
  optimizationTasks: ['campaignId','projectId','type','status','reason','metadata'], jobs: ['projectId','assetId','employeeId','type','status','details'],
};
const encode = (key,value) => JSON_FIELDS.has(key) ? JSON.stringify(value ?? (['facts','creativeIds','sourceAssetIds'].includes(key) ? [] : {})) : BOOL_FIELDS.has(key) ? Number(Boolean(value)) : value ?? null;
function decode(row) {
  if (!row) return null;
  const result={...row};
  for (const field of JSON_FIELDS) if (field in result) { try { result[field]=JSON.parse(result[field]); } catch { result[field]=null; } }
  for (const field of BOOL_FIELDS) if (field in result) result[field]=Boolean(result[field]);
  return result;
}
export function createPlatformRepository(DB) {
  if (!DB?.prepare) throw new Error('D1 DB binding is unavailable');
  const query=(sql,...args)=>DB.prepare(sql).bind(...args);
  const get=async(table,userId,id)=>decode(await query(`SELECT * FROM ${table} WHERE userId = ? AND id = ?`,userId,id).first());
  const list=async(table,userId,{projectId,limit=500}={})=> {
    const statement=projectId ? query(`SELECT * FROM ${table} WHERE userId = ? AND projectId = ? ORDER BY createdAt DESC LIMIT ?`,userId,projectId,limit) : query(`SELECT * FROM ${table} WHERE userId = ? ORDER BY createdAt DESC LIMIT ?`,userId,limit);
    return ((await statement.all()).results ?? []).map(decode);
  };
  const insert=async(table,userId,payload)=> {
    if (!userId) throw new Error('Authenticated owner is required');
    const now=new Date().toISOString(); const data={id:crypto.randomUUID(),userId,createdAt:now,updatedAt:now};
    for (const key of TABLE_FIELDS[table]) if (Object.hasOwn(payload,key)) data[key]=encode(key,payload[key]);
    const fields=Object.keys(data);
    await query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,...fields.map(f=>data[f])).run();
    return get(table,userId,data.id);
  };
  const update=async(table,userId,id,patch)=> {
    const fields=TABLE_FIELDS[table].filter(f=>Object.hasOwn(patch,f));
    if (!fields.length) return get(table,userId,id);
    await query(`UPDATE ${table} SET ${fields.map(f=>`${f} = ?`).join(',')}, updatedAt = ? WHERE userId = ? AND id = ?`,...fields.map(f=>encode(f,patch[f])),new Date().toISOString(),userId,id).run();
    return get(table,userId,id);
  };
  return {
    listEmployeeProfiles:u=>list('employeeProfiles',u),createEmployeeProfile:(u,p)=>insert('employeeProfiles',u,p),
    getProject:(u,id)=>get('projects',u,id),listProjects:u=>list('projects',u),createProject:(u,p)=>insert('projects',u,p),updateProject:(u,id,p)=>update('projects',u,id,p),
    getAsset:(u,id)=>get('assets',u,id),listAssets:(u,projectId)=>list('assets',u,{projectId}),createAsset:(u,p)=>insert('assets',u,p),
    findAssetUpload:async(u,projectId,uploadRequestId)=>decode(await query('SELECT * FROM assets WHERE userId = ? AND projectId = ? AND uploadRequestId = ?',u,projectId,uploadRequestId).first()),
    getCreative:(u,id)=>get('creatives',u,id),createCreative:(u,p)=>insert('creatives',u,p),updateCreative:(u,id,p)=>update('creatives',u,id,p),
    listCreatives:async(u,selector)=>Array.isArray(selector) ? (await Promise.all(selector.map(id=>get('creatives',u,id)))).filter(Boolean) : list('creatives',u,{projectId:selector}),
    getCampaign:(u,id)=>get('campaigns',u,id),loadCampaign:(u,id)=>get('campaigns',u,id),listCampaigns:u=>list('campaigns',u),createCampaign:(u,p)=>insert('campaigns',u,p),updateCampaign:(u,id,p)=>update('campaigns',u,id,p),
    listCampaignsByGroup:async(u,id)=>((await query('SELECT * FROM campaigns WHERE userId = ? AND deliveryGroupId = ? ORDER BY createdAt DESC',u,id).all()).results??[]).map(decode),
    listCampaignsByConnection:async(u,id)=>((await query('SELECT * FROM campaigns WHERE userId = ? AND connectionId = ? ORDER BY createdAt DESC',u,id).all()).results??[]).map(decode),
    getConnection:(u,id)=>get('connections',u,id),listConnections:u=>list('connections',u),createConnection:(u,p)=>insert('connections',u,p),updateConnection:(u,id,p)=>update('connections',u,id,p),
    deleteConnection:async(u,id)=>{const row=await get('connections',u,id);if(!row)return null;await query('DELETE FROM connections WHERE userId = ? AND id = ?',u,id).run();return row;},
    getDeliveryGroup:(u,id)=>get('deliveryGroups',u,id),listDeliveryGroups:u=>list('deliveryGroups',u),createDeliveryGroup:(u,p)=>insert('deliveryGroups',u,p),updateDeliveryGroup:(u,id,p)=>update('deliveryGroups',u,id,p),
    getDeliveryGroupByProject:async(u,projectId)=>decode(await query('SELECT * FROM deliveryGroups WHERE userId = ? AND projectId = ?',u,projectId).first()),
    async claimDeliveryGroupOperation(userId,id,operationId){
      const now=new Date().toISOString(),stale=new Date(Date.now()-10*60*1000).toISOString();
      const result=await query('UPDATE deliveryGroups SET operationId = ?, updatedAt = ? WHERE userId = ? AND id = ? AND (operationId IS NULL OR updatedAt < ?)',operationId,now,userId,id,stale).run();
      return Number(result.meta?.changes??result.changes??0)>0?get('deliveryGroups',userId,id):null;
    },
    releaseDeliveryGroupOperation:async(u,id,operationId)=>{await query('UPDATE deliveryGroups SET operationId = NULL WHERE userId = ? AND id = ? AND operationId = ?',u,id,operationId).run();},
    getPreferences:async(u)=>decode(await query('SELECT * FROM userPreferences WHERE userId = ?',u).first()),
    async savePreferences(u,p){
      if(!u)throw new Error('Authenticated owner is required');
      const now=new Date().toISOString();
      await query("INSERT INTO userPreferences (id,userId,createdAt,updatedAt) VALUES (?,?,?,?) ON CONFLICT(userId) DO NOTHING",crypto.randomUUID(),u,now,now).run();
      const row=await query('SELECT id FROM userPreferences WHERE userId = ?',u).first();
      return update('userPreferences',u,row.id,p);
    },
    listDecisions:u=>list('decisions',u),getDecision:(u,id)=>get('decisions',u,id),createDecision:(u,p)=>insert('decisions',u,p),updateDecision:(u,id,p)=>update('decisions',u,id,p),
    async claimDecisionAction(u,id,action){
      if(!['accept','dismiss'].includes(action))return null;
      const result=await query("UPDATE decisions SET status = ?, updatedAt = ? WHERE userId = ? AND id = ? AND (status = 'proposed' OR (status = ? AND updatedAt < ?))",`processing_${action}`,new Date().toISOString(),u,id,`processing_${action}`,new Date(Date.now()-2*60*1000).toISOString()).run();
      return Number(result.meta?.changes??result.changes??0)>0?get('decisions',u,id):null;
    },
    async createDecisionOptimizationTask(u,p){
      const key=p.metadata?.sourceDecisionId;
      if(!key||!await get('decisions',u,key))throw Object.assign(new Error('经营建议不存在'),{status:404,code:'not_found'});
      const now=new Date().toISOString(),data={id:crypto.randomUUID(),userId:u,createdAt:now,updatedAt:now};
      for(const field of TABLE_FIELDS.optimizationTasks)if(Object.hasOwn(p,field))data[field]=encode(field,p[field]);
      const fields=Object.keys(data);
      await query(`INSERT INTO optimizationTasks (${fields.join(',')}) SELECT ${fields.map(()=>'?').join(',')} WHERE NOT EXISTS (SELECT 1 FROM optimizationTasks WHERE userId = ? AND json_extract(metadata,'$.sourceDecisionId') = ?)`,...fields.map(field=>data[field]),u,key).run();
      return decode(await query("SELECT * FROM optimizationTasks WHERE userId = ? AND json_extract(metadata,'$.sourceDecisionId') = ? ORDER BY createdAt LIMIT 1",u,key).first());
    },
    listStrategies:u=>list('strategies',u),getStrategy:(u,id)=>get('strategies',u,id),createStrategy:(u,p)=>insert('strategies',u,p),updateStrategy:(u,id,p)=>update('strategies',u,id,p),
    async claimJobOperation(userId,id,operationId){
      const now=new Date().toISOString(),expires=new Date(Date.now()+2*60*1000).toISOString();
      const result=await query("UPDATE jobs SET details = json_set(details,'$.operationId',?,'$.operationExpiresAt',?), updatedAt = ? WHERE userId = ? AND id = ? AND type IN ('upload_batch','production_request') AND (json_extract(details,'$.operationId') IS NULL OR json_extract(details,'$.operationExpiresAt') < ?)",operationId,expires,now,userId,id,now).run();
      return Number(result.meta?.changes??result.changes??0)>0?get('jobs',userId,id):null;
    },
    releaseJobOperation:async(u,id,operationId)=>{await query("UPDATE jobs SET details = json_remove(details,'$.operationId','$.operationExpiresAt') WHERE userId = ? AND id = ? AND type IN ('upload_batch','production_request') AND json_extract(details,'$.operationId') = ?",u,id,operationId).run();},
    getMetric:(u,id)=>get('metrics',u,id),listMetrics:u=>list('metrics',u,{limit:10000}),listAudit:u=>list('audit',u,{limit:500}),addAudit:(u,p)=>insert('audit',u,p),createJob:(u,p)=>insert('jobs',u,p),
    // Preparation batches have their own endpoint; keep their large item lists out of worker scans and bootstrap.
    listJobs:async u=>((await query("SELECT * FROM jobs WHERE userId = ? AND type <> 'release_batch' ORDER BY createdAt DESC LIMIT 500",u).all()).results??[]).map(decode),
    getJob:(u,id)=>get('jobs',u,id),updateJob:(u,id,p)=>update('jobs',u,id,p),
    addOptimizationTask:(u,p)=>insert('optimizationTasks',u,p),listOptimizationTasks:u=>list('optimizationTasks',u),getOptimizationTask:(u,id)=>get('optimizationTasks',u,id),updateOptimizationTask:(u,id,p)=>update('optimizationTasks',u,id,p),
    async getAutomaticFlow(userId,projectId){return decode(await query("SELECT * FROM jobs WHERE userId = ? AND projectId = ? AND type = 'platform_automation' ORDER BY createdAt ASC LIMIT 1",userId,projectId).first());},
    async ensureAutomaticFlow(userId,projectId,{bxagiSubject,notBefore}={}){
      if(!bxagiSubject||!await get('projects',userId,projectId))throw Object.assign(new Error('素材项目不存在或账户未验证'),{status:404,code:'not_found'});
      const now=new Date().toISOString(),due=Number.isFinite(Date.parse(notBefore))?new Date(notBefore).toISOString():now;
      const details={provider:'platform',kind:'automatic_advertising',enabled:true,bxagiSubject,signalVersion:1,lastSignalAt:now,nextActionAt:due};
      const result=await query("INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details) SELECT ?,?,?,?,?,'','platform_automation','queued',? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND projectId = ? AND type = 'platform_automation')",crypto.randomUUID(),userId,now,now,projectId,JSON.stringify(details),userId,projectId).run();
      if(!Number(result.meta?.changes??result.changes??0))await query("UPDATE jobs SET details = json_set(details,'$.signalVersion',coalesce(json_extract(details,'$.signalVersion'),0)+1,'$.lastSignalAt',?,'$.nextActionAt',?,'$.enabled',json('true')), updatedAt = ? WHERE userId = ? AND projectId = ? AND type = 'platform_automation' AND json_extract(details,'$.bxagiSubject') = ?",now,due,now,userId,projectId,bxagiSubject).run();
      return decode(await query("SELECT * FROM jobs WHERE userId = ? AND projectId = ? AND type = 'platform_automation' AND json_extract(details,'$.bxagiSubject') = ? LIMIT 1",userId,projectId,bxagiSubject).first());
    },
    async listDueAutomaticFlows(limit=3,userId=null){
      const now=new Date().toISOString(),scope=userId?' AND userId = ?':'',args=userId?[now,now,userId]:[now,now];
      return ((await query(`SELECT * FROM jobs WHERE type = 'platform_automation' AND json_extract(details,'$.enabled') = 1 AND (json_extract(details,'$.nextActionAt') IS NULL OR json_extract(details,'$.nextActionAt') <= ?) AND (json_extract(details,'$.operationId') IS NULL OR json_extract(details,'$.operationExpiresAt') < ?)${scope} ORDER BY updatedAt ASC LIMIT ?`,...args,Math.min(Math.max(Number(limit)||1,1),3)).all()).results??[]).map(decode);
    },
    async claimAutomaticFlow(userId,id,operationId){
      const now=new Date().toISOString(),expires=new Date(Date.now()+2*60*1000).toISOString();
      const result=await query("UPDATE jobs SET details = json_set(details,'$.operationId',?,'$.operationExpiresAt',?), updatedAt = ? WHERE userId = ? AND id = ? AND type = 'platform_automation' AND json_extract(details,'$.enabled') = 1 AND (json_extract(details,'$.operationId') IS NULL OR json_extract(details,'$.operationExpiresAt') < ?)",operationId,expires,now,userId,id,now).run();
      return Number(result.meta?.changes??result.changes??0)>0?get('jobs',userId,id):null;
    },
    async saveAutomaticFlow(userId,id,operationId,signalVersion,{status,details={}}){
      const patch={...details};for(const key of ['provider','kind','enabled','bxagiSubject','signalVersion','lastSignalAt','operationId','operationExpiresAt'])delete patch[key];
      const now=new Date().toISOString();
      const result=await query("UPDATE jobs SET status = ?, details = json_set(json_patch(details,?), '$.nextActionAt', CASE WHEN coalesce(json_extract(details,'$.signalVersion'),0) > ? THEN min(coalesce(json_extract(details,'$.nextActionAt'),?),coalesce(json_extract(?,'$.nextActionAt'),?)) ELSE coalesce(json_extract(?,'$.nextActionAt'),json_extract(details,'$.nextActionAt'),?) END), updatedAt = ? WHERE userId = ? AND id = ? AND type = 'platform_automation' AND json_extract(details,'$.operationId') = ?",status,JSON.stringify(patch),signalVersion,now,JSON.stringify(patch),now,JSON.stringify(patch),now,now,userId,id,operationId).run();
      return Number(result.meta?.changes??result.changes??0)>0?get('jobs',userId,id):null;
    },
    async releaseAutomaticFlow(userId,id,operationId){await query("UPDATE jobs SET details = json_remove(details,'$.operationId','$.operationExpiresAt') WHERE userId = ? AND id = ? AND type = 'platform_automation' AND json_extract(details,'$.operationId') = ?",userId,id,operationId).run();},
    async claimOptimizationTask(userId,id,leaseId) {
      const now=new Date().toISOString(),expires=new Date(Date.now()+30*60*1000).toISOString();
      const result=await query("UPDATE optimizationTasks SET status = 'producing', metadata = json_set(metadata,'$.productionLeaseId',?,'$.productionLeaseExpiresAt',?), updatedAt = ? WHERE userId = ? AND id = ? AND (status = 'pending' OR (status = 'producing' AND json_extract(metadata,'$.productionLeaseExpiresAt') < ?)) AND NOT EXISTS (SELECT 1 FROM optimizationTasks other WHERE other.userId = ? AND other.projectId = optimizationTasks.projectId AND other.id <> optimizationTasks.id AND other.status = 'producing' AND json_extract(other.metadata,'$.productionLeaseExpiresAt') > ?)",leaseId,expires,now,userId,id,now,userId,now).run();
      return Number(result.meta?.changes??result.changes??0)>0 ? get('optimizationTasks',userId,id) : null;
    },
    async releaseOptimizationTask(userId,id,leaseId) { await query("UPDATE optimizationTasks SET status = 'pending', metadata = json_remove(metadata,'$.productionLeaseId','$.productionLeaseExpiresAt'), updatedAt = ? WHERE userId = ? AND id = ? AND status = 'producing' AND json_extract(metadata,'$.productionLeaseId') = ?",new Date().toISOString(),userId,id,leaseId).run(); },
    async completeOptimizationTask(userId,id,leaseId,metadata) {
      const result=await query("UPDATE optimizationTasks SET status = 'completed', metadata = ?, updatedAt = ? WHERE userId = ? AND id = ? AND status = 'producing' AND json_extract(metadata,'$.productionLeaseId') = ?",JSON.stringify(metadata),new Date().toISOString(),userId,id,leaseId).run();
      return Number(result.meta?.changes??result.changes??0)>0 ? get('optimizationTasks',userId,id) : null;
    },
    async upsertMetrics(userId,payload) {
      const campaign=await get('campaigns',userId,payload.campaignId);
      if (!campaign) throw Object.assign(new Error('Campaign not found'),{status:404});
      const now=new Date().toISOString();const data={...payload,id:crypto.randomUUID(),userId,createdAt:now,updatedAt:now,projectId:campaign.projectId};
      const fields=['id','userId','createdAt','updatedAt',...TABLE_FIELDS.metrics.filter(k=>Object.hasOwn(data,k))];
      const mutable=fields.filter(k=>!['id','userId','createdAt','campaignId','date','source'].includes(k));
      await query(`INSERT INTO metrics (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')}) ON CONFLICT(userId,campaignId,date,source) DO UPDATE SET ${mutable.map(f=>`${f} = excluded.${f}`).join(',')}`,...fields.map(f=>encode(f,data[f]))).run();
      return decode(await query('SELECT * FROM metrics WHERE userId = ? AND campaignId = ? AND date = ? AND source = ?',userId,payload.campaignId,payload.date,payload.source).first());
    },
    async claimCampaignLaunch(userId,id,attemptId=crypto.randomUUID()) {
      const result=await query("UPDATE campaigns SET status = 'launching', launchStage = 'claimed', launchAttemptId = ?, error = NULL, updatedAt = ? WHERE userId = ? AND id = ? AND status IN ('draft','blocked') AND operationId IS NULL AND remoteId IS NULL AND json_extract(remoteState,'$.projectId') IS NULL AND json_extract(remoteState,'$.writePending') IS NULL",attemptId,new Date().toISOString(),userId,id).run();
      return Number(result.meta?.changes ?? result.changes ?? 0)>0 ? get('campaigns',userId,id) : null;
    },
    async claimCampaignBudgetOperation(userId,id,operationId) {const result=await query("UPDATE campaigns SET operationId = ?, updatedAt = ? WHERE userId = ? AND id = ? AND status IN ('draft','blocked','paused') AND operationId IS NULL AND json_extract(remoteState,'$.writePending') IS NULL",operationId,new Date().toISOString(),userId,id).run();return Number(result.meta?.changes??result.changes??0)>0 ? get('campaigns',userId,id) : null;},
    async claimCampaignOperation(userId,id,operationId) { const result=await query("UPDATE campaigns SET operationId = ?, updatedAt = ? WHERE userId = ? AND id = ? AND (operationId IS NULL OR (updatedAt < ? AND json_extract(remoteState,'$.writePending') IS NULL))",operationId,new Date().toISOString(),userId,id,new Date(Date.now()-10*60*1000).toISOString()).run(); return Number(result.meta?.changes ?? result.changes ?? 0)>0 ? get('campaigns',userId,id) : null; },
    async releaseCampaignOperation(userId,id,operationId) { await query('UPDATE campaigns SET operationId = NULL WHERE userId = ? AND id = ? AND operationId = ?',userId,id,operationId).run(); },
    async createBxagiProductionJob(userId,payload){
      if(!await get('projects',userId,payload.projectId))throw Object.assign(new Error('素材项目不存在'),{status:404,code:'not_found'});
      const now=new Date().toISOString(),data={id:crypto.randomUUID(),userId,createdAt:now,updatedAt:now};
      for(const key of TABLE_FIELDS.jobs)if(Object.hasOwn(payload,key))data[key]=encode(key,payload[key]);
      data.type='bxagi_workflow';data.status='queued';data.details=encode('details',{...payload.details,provider:'bxagi',kind:'production'});
      const fields=Object.keys(data),result=await query(`INSERT INTO jobs (${fields.join(',')}) SELECT ${fields.map(()=>'?').join(',')} WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND projectId = ? AND type = 'bxagi_workflow' AND json_extract(details,'$.kind') = 'production' AND status IN ('queued','starting','uploading','running','awaiting_result','awaiting_user_input','awaiting_user_confirmation'))`,...fields.map(f=>data[f]),userId,payload.projectId).run();
      return Number(result.meta?.changes??result.changes??0)>0 ? get('jobs',userId,data.id) : null;
    },
    async getBxagiMarketActivation(userId,marketId,bxagiSubject){
      return decode(await query("SELECT * FROM jobs WHERE userId = ? AND type = 'bxagi_market_activation' AND json_extract(details,'$.marketId') = ? AND json_extract(details,'$.bxagiSubject') = ? ORDER BY createdAt ASC LIMIT 1",userId,marketId,bxagiSubject).first());
    },
    async getBxagiButlerBootstrap(userId,bxagiSubject){
      return decode(await query("SELECT * FROM jobs WHERE userId = ? AND type = 'bxagi_butler_bootstrap' AND json_extract(details,'$.bxagiSubject') = ? ORDER BY createdAt ASC LIMIT 1",userId,bxagiSubject).first());
    },
    async getBxagiNodeHealth(userId,bxagiSubject){
      if(!userId||!bxagiSubject)return null;
      return decode(await query("SELECT * FROM jobs WHERE userId = ? AND type = 'bxagi_node_health' AND json_extract(details,'$.bxagiSubject') = ? ORDER BY createdAt ASC LIMIT 1",userId,bxagiSubject).first());
    },
    async recordBxagiNodeHealth(userId,bxagiSubject,observation){
      if(typeof userId!=='string'||!/^[A-Za-z0-9_.:@-]{1,160}$/.test(userId)||typeof bxagiSubject!=='string'||!/^[A-Za-z0-9_.:@-]{1,160}$/.test(bxagiSubject))throw Object.assign(new Error('节点观测需要已验证的账号'),{status:400,code:'invalid_node_health_identity'});
      const current=sanitizeBxagiNodeObservation(observation),initial=mergeBxagiNodeHealth(null,current,bxagiSubject),id=crypto.randomUUID();
      const read=async()=>decode(await query("SELECT * FROM jobs WHERE userId = ? AND type = 'bxagi_node_health' AND json_extract(details,'$.bxagiSubject') = ? ORDER BY createdAt ASC LIMIT 1",userId,bxagiSubject).first());
      // One durable journal per verified owner + subject. Atomic insertion and
      // revision CAS prevent parallel page/background checks losing transitions.
      await query("INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details) SELECT ?,?,?,?,'','','bxagi_node_health','observed',? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND type = 'bxagi_node_health' AND json_extract(details,'$.bxagiSubject') = ?)",id,userId,current.checkedAt,current.checkedAt,JSON.stringify(initial),userId,bxagiSubject).run();
      for(let attempt=0;attempt<4;attempt++){
        const existing=await read();
        if(!existing||existing.id===id)return existing;
        const next=mergeBxagiNodeHealth(existing.details,current,bxagiSubject);
        if(!next)return existing;
        const result=await query("UPDATE jobs SET details = ?, updatedAt = ? WHERE userId = ? AND id = ? AND type = 'bxagi_node_health' AND json_extract(details,'$.bxagiSubject') = ? AND coalesce(json_extract(details,'$.revision'),0) = ?",JSON.stringify(next),current.checkedAt,userId,existing.id,bxagiSubject,existing.details?.revision??0).run();
        if(Number(result.meta?.changes??result.changes??0)>0)return read();
      }
      throw Object.assign(new Error('节点观测保存繁忙'),{status:503,code:'node_health_storage_busy'});
    },
    async reserveBxagiButlerBootstrap(userId,{bxagiSubject,attemptId}={}){
      if(!userId||!bxagiSubject||!attemptId)throw Object.assign(new Error('大管家初始化需要已验证的账号和操作标识'),{status:400,code:'invalid_butler_bootstrap'});
      const now=new Date().toISOString(),id=crypto.randomUUID(),details={provider:'bxagi',kind:'butler_bootstrap',marketId:'general_assistant',bxagiSubject,attemptId};
      const result=await query("INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details) SELECT ?,?,?,?,'','bxagi:market:general_assistant','bxagi_butler_bootstrap','reserved',? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND type = 'bxagi_butler_bootstrap' AND json_extract(details,'$.bxagiSubject') = ?) AND NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND type = 'bxagi_market_activation' AND json_extract(details,'$.marketId') = 'general_assistant' AND (status IN ('reserved','activating','needs_reconciliation') OR json_extract(details,'$.remoteWritePending') IS NOT NULL))",id,userId,now,now,JSON.stringify(details),userId,bxagiSubject,userId).run();
      const job=decode(await query("SELECT * FROM jobs WHERE userId = ? AND type = 'bxagi_butler_bootstrap' AND json_extract(details,'$.bxagiSubject') = ? ORDER BY createdAt ASC LIMIT 1",userId,bxagiSubject).first());
      return {claimed:Number(result.meta?.changes??result.changes??0)>0,job};
    },
    async reserveBxagiMarketActivation(userId,{marketId,bxagiSubject,operationId}={}){
      if(!userId||!marketId||!bxagiSubject||!operationId)throw Object.assign(new Error('市场员工启用需要已验证的账号和岗位'),{status:400,code:'invalid_market_activation'});
      const now=new Date().toISOString(),id=crypto.randomUUID(),details={provider:'bxagi',kind:'market_activation',marketId,bxagiSubject,operationId};
      const result=await query("INSERT INTO jobs (id,userId,createdAt,updatedAt,projectId,employeeId,type,status,details) SELECT ?,?,?,?,'',?,'bxagi_market_activation','reserved',? WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND type = 'bxagi_market_activation' AND json_extract(details,'$.marketId') = ? AND json_extract(details,'$.bxagiSubject') = ?) AND NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND type = 'bxagi_market_activation' AND status IN ('reserved','activating','needs_reconciliation')) AND (? <> 'general_assistant' OR NOT EXISTS (SELECT 1 FROM jobs WHERE userId = ? AND type = 'bxagi_butler_bootstrap' AND (status IN ('reserved','installing','starting','needs_reconciliation') OR json_extract(details,'$.remoteWritePending') IS NOT NULL)))",id,userId,now,now,`bxagi:market:${marketId}`,JSON.stringify(details),userId,marketId,bxagiSubject,userId,marketId,userId).run();
      const job=decode(await query("SELECT * FROM jobs WHERE userId = ? AND type = 'bxagi_market_activation' AND json_extract(details,'$.marketId') = ? AND json_extract(details,'$.bxagiSubject') = ? ORDER BY createdAt ASC LIMIT 1",userId,marketId,bxagiSubject).first());
      return {claimed:Number(result.meta?.changes??result.changes??0)>0,job};
    },
    async claimBxagiJobOperation(userId,id,operationId){
      const now=new Date().toISOString(),expires=new Date(Date.now()+2*60*1000).toISOString();
      const result=await query("UPDATE jobs SET details = json_set(details,'$.operationId',?,'$.operationExpiresAt',?), updatedAt = ? WHERE userId = ? AND id = ? AND (type LIKE 'bxagi_%' OR json_extract(details,'$.provider') = 'bxagi') AND json_extract(details,'$.remoteWritePending') IS NULL AND (json_extract(details,'$.operationId') IS NULL OR json_extract(details,'$.operationExpiresAt') < ?)",operationId,expires,now,userId,id,now).run();
      return Number(result.meta?.changes??result.changes??0)>0 ? get('jobs',userId,id) : null;
    },
    async releaseBxagiJobOperation(userId,id,operationId){await query("UPDATE jobs SET details = json_remove(details,'$.operationId','$.operationExpiresAt') WHERE userId = ? AND id = ? AND json_extract(details,'$.operationId') = ?",userId,id,operationId).run();},
    async listDueBxagiJobs(limit=3){
      const now=new Date().toISOString(),count=Math.min(Math.max(Number(limit)||1,1),3);
      const rows=((await query("SELECT * FROM jobs WHERE (type LIKE 'bxagi_%' OR json_extract(details,'$.provider') = 'bxagi') AND (status IN ('queued','starting','uploading','running','awaiting_result') OR (status = 'failed' AND json_extract(details,'$.kind') = 'production' AND json_extract(details,'$.messageAcknowledged') = 1 AND json_extract(details,'$.lastErrorCode') IN ('bxagi_market_employee_activation_required','bxagi_node_offline','bxagi_gateway_disconnected','bxagi_node_unavailable','bxagi_runtime_unavailable','upstream_unavailable','upstream_request_failed','message_handshake_failed'))) AND (json_extract(details,'$.nextSyncAt') IS NULL OR json_extract(details,'$.nextSyncAt') <= ?) AND (json_extract(details,'$.recovery.nextRetryAt') IS NULL OR json_extract(details,'$.recovery.nextRetryAt') <= ?) AND json_extract(details,'$.remoteWritePending') IS NULL AND NOT EXISTS (SELECT 1 FROM jobs flow WHERE flow.userId = jobs.userId AND flow.projectId = jobs.projectId AND flow.type = 'platform_automation' AND json_extract(flow.details,'$.enabled') = 1) ORDER BY updatedAt ASC LIMIT 60",now,now).all()).results??[]).map(decode);
      return rows.filter(job=>{
        if(!bxagiRecoveryDue(job))return false;
        const recoverable=isAutomaticallyRecoverableBxagiProductionJob(job);
        if(job.status==='failed')return recoverable;
        const expired=['flowTestExpiresAt','automationProbeExpiresAt'].some(key=>job.details?.[key]!=null&&(!Number.isFinite(Date.parse(job.details[key]))||Date.parse(job.details[key])<=Date.now()));
        return !expired||recoverable;
      }).slice(0,count);
    },
    async listPendingBxagiOptimizations(limit=2){
      const now=new Date().toISOString();
      return ((await query("SELECT tasks.* FROM optimizationTasks tasks JOIN campaigns campaign ON campaign.id = tasks.campaignId AND campaign.userId = tasks.userId AND campaign.projectId = tasks.projectId WHERE tasks.status = 'pending' AND campaign.autoOptimize = 1 AND NOT EXISTS (SELECT 1 FROM jobs flow WHERE flow.userId = tasks.userId AND flow.projectId = tasks.projectId AND flow.type = 'platform_automation' AND json_extract(flow.details,'$.enabled') = 1) AND (json_extract(tasks.metadata,'$.nextBxagiAttemptAt') IS NULL OR json_extract(tasks.metadata,'$.nextBxagiAttemptAt') <= ?) AND EXISTS (SELECT 1 FROM bxagiSessions session WHERE session.userId = tasks.userId AND session.expiresAt > ?) ORDER BY tasks.updatedAt ASC LIMIT ?",now,now,Math.min(Math.max(Number(limit)||1,1),2)).all()).results??[]).map(decode);
    },
    async claimWorkerCompletion(id,leaseId) { const result=await query("UPDATE jobs SET status = 'finishing', updatedAt = ? WHERE id = ? AND status = 'running' AND json_extract(details,'$.leaseId') = ?",new Date().toISOString(),id,leaseId).run(); return Number(result.meta?.changes??result.changes??0)>0 ? decode(await query('SELECT * FROM jobs WHERE id = ?',id).first()) : null; },
    async getCreativeForWorkerJob(userId,jobId){return decode(await query("SELECT * FROM creatives WHERE userId = ? AND json_extract(metadata,'$.sourceJobId') = ? ORDER BY createdAt DESC LIMIT 1",userId,jobId).first());},
    async getWorkerJob(id) { return decode(await query('SELECT * FROM jobs WHERE id = ?',id).first()); },
    async updateWorkerJob(id,patch) { const job=decode(await query('SELECT * FROM jobs WHERE id = ?',id).first()); return job ? update('jobs',job.userId,id,patch) : null; },
    async claimWorkerJobs(limit=1,capabilities=[]) {
      if(!capabilities.includes('ffmpeg')) return [];
      const recoveryTime=new Date().toISOString();
      const expired=((await query("SELECT * FROM jobs WHERE type = 'video_optimize' AND status IN ('running','finishing') AND json_extract(details,'$.leaseExpiresAt') < ? LIMIT 20",recoveryTime).all()).results??[]).map(decode);
      for(const job of expired){
        if(job.status==='finishing'){
          const creative=decode(await query("SELECT * FROM creatives WHERE userId = ? AND projectId = ? AND json_extract(metadata,'$.sourceJobId') = ? AND size > 0 ORDER BY createdAt DESC LIMIT 1",job.userId,job.projectId,job.id).first());
          if(creative){const details={...job.details,resultCreativeId:creative.id,recoveredAt:recoveryTime,output:{width:creative.width,height:creative.height,duration:creative.duration,fullDecodePassed:creative.metadata?.technicalChecks?.fullDecode===true,semanticValidated:false}};await query("UPDATE jobs SET status = 'completed', details = ?, updatedAt = ? WHERE id = ? AND status = 'finishing' AND json_extract(details,'$.leaseId') = ?",JSON.stringify(details),recoveryTime,job.id,job.details.leaseId).run();continue;}
        }
        const exhausted=Number(job.details?.attempts??0)>=3;const details={...job.details,leaseId:null,leaseExpiresAt:null,...(exhausted?{error:'视频处理已达到3次重试上限，请检查素材或执行器'}:{recoveredAt:recoveryTime})};await query("UPDATE jobs SET status = ?, details = ?, updatedAt = ? WHERE id = ? AND status IN ('running','finishing') AND json_extract(details,'$.leaseId') = ?",exhausted?'failed':'queued',JSON.stringify(details),recoveryTime,job.id,job.details.leaseId).run();}
      const candidates=((await query("SELECT * FROM jobs WHERE status = 'queued' AND type = 'video_optimize' ORDER BY createdAt ASC LIMIT ?",Math.min(Math.max(Number(limit)||1,1),5)).all()).results??[]).map(decode);
      const claimed=[];
      for(const job of candidates){ const leaseId=crypto.randomUUID();const now=new Date().toISOString();const details={...job.details,attempts:Number(job.details?.attempts??0)+1,leaseId,claimedAt:now,leaseExpiresAt:new Date(Date.now()+30*60*1000).toISOString()};const result=await query("UPDATE jobs SET status = 'running', details = ?, updatedAt = ? WHERE userId = ? AND id = ? AND status = 'queued'",JSON.stringify(details),now,job.userId,job.id).run();if(Number(result.meta?.changes??result.changes??0)>0)claimed.push(await get('jobs',job.userId,job.id)); }
      return claimed;
    },
    async listDueCampaigns(limit=20) {return ((await query("SELECT * FROM campaigns WHERE status = 'active' AND (nextSyncAt IS NULL OR nextSyncAt <= ?) ORDER BY updatedAt ASC LIMIT ?",new Date().toISOString(),limit).all()).results ?? []).map(decode);},
  };
}
