import { createProductionService } from '../production-service.mjs';
import { createDeliveryGroupService } from '../delivery-groups.mjs';
import { createSettingsService } from '../settings-service.mjs';
import { createInsightsService } from '../insights-service.mjs';
import { createReleaseBatchService } from '../release-batches-service.mjs';
import { createCatalogService } from '../catalog-service.mjs';
import { executeCampaignAction } from './campaign-actions.mjs';
import { json, parseJson, requireRow } from './protocol.mjs';

/** Business modules share the already verified BXAGI owner; request bodies never select an owner. */
export async function handleBusinessRoutes(request,context) {
  const {path,method,userId,repository,env,authenticated,remoteWorkflow,automatic,ads,fetcher}=context;
  let match;
  const production=()=>createProductionService({repository,bucket:env.BUCKET,context:authenticated,orchestrator:remoteWorkflow,ensureAutomation:projectId=>automatic().ensureProject(authenticated,projectId)});
  const delivery=()=>createDeliveryGroupService({repository,env});
  const settings=()=>createSettingsService({repository,env,fetcher});
  const insights=()=>createInsightsService({repository});
  const releases=()=>createReleaseBatchService({repository,DB:env.DB});
  const catalog=()=>createCatalogService({env,fetcher,repository});
  if(path==='/catalog/status'&&method==='GET')return json(await catalog().status(userId));
  if(path==='/catalog/items'&&method==='GET')return json(await catalog().list(userId,Object.fromEntries(new URL(request.url).searchParams)));
  if(path==='/catalog/source'&&method==='PATCH')return json(await catalog().saveSource(userId,await parseJson(request)));
  if((match=/^\/catalog\/(sync|advance|pause)$/.exec(path))&&method==='POST') {
    const body=await parseJson(request);
    if(Object.keys(body).length)throw Object.assign(new Error('此操作不接受额外参数'),{status:400,code:'catalog_invalid_input'});
    const service=catalog();
    return json(await service[match[1]==='sync'?'start':match[1]](userId),match[1]==='sync'?202:200);
  }
  if(path==='/release-batches'&&method==='GET')return json(await releases().list(userId));
  if(path==='/release-batches'&&method==='POST')return json(await releases().create(userId,await parseJson(request)),201);
  if((match=/^\/release-batches\/([^/]+)\/items\/([^/]+)$/.exec(path))&&method==='PATCH')return json(await releases().updateItem(userId,match[1],match[2],await parseJson(request)));
  if((match=/^\/projects\/([^/]+)\/upload-batches$/.exec(path))&&method==='POST')return json(await production().beginBatch(match[1],await parseJson(request)),201);
  if((match=/^\/projects\/([^/]+)\/upload-batches\/([^/]+)\/complete$/.exec(path))&&method==='POST')return json(await production().completeBatch(match[1],match[2],await parseJson(request)));
  if((match=/^\/projects\/([^/]+)\/production$/.exec(path))&&method==='POST')return json(await production().start(match[1],await parseJson(request)));
  if(path==='/delivery-groups'&&method==='GET')return json({groups:await repository.listDeliveryGroups(userId)});
  if(path==='/delivery-groups'&&method==='POST')return json(await delivery().create(userId,await parseJson(request)),201);
  if((match=/^\/delivery-groups\/([^/]+)\/units$/.exec(path))&&method==='POST')return json(await delivery().append(userId,match[1],await parseJson(request)),201);
  if((match=/^\/delivery-groups\/([^/]+)\/budget$/.exec(path))&&['POST','PATCH'].includes(method))return json(await delivery().updateBudget(userId,match[1],await parseJson(request)));
  if((match=/^\/delivery-groups\/([^/]+)\/(launch|pause|sync)$/.exec(path))&&method==='POST') {
    await parseJson(request);
    return json(await delivery().operate(userId,match[1],match[2],campaign=>executeCampaignAction({userId,repository,ads,remoteWorkflow},campaign,match[2])));
  }
  if(path==='/settings/preferences'&&method==='GET')return json({settings:await settings().getPreferences(userId)});
  if(path==='/settings/preferences'&&['PATCH','POST'].includes(method))return json({settings:await settings().savePreferences(userId,await parseJson(request))});
  if((match=/^\/connections\/([^/]+)$/.exec(path))&&method==='PATCH')return json({connection:await settings().updateConnection(userId,match[1],await parseJson(request))});
  if((match=/^\/connections\/([^/]+)$/.exec(path))&&method==='DELETE')return json(await settings().deleteConnection(userId,match[1]));
  if((match=/^\/connections\/([^/]+)\/test$/.exec(path))&&method==='POST')return json(await settings().testConnection(userId,match[1]));
  if((match=/^\/connections\/([^/]+)\/disable$/.exec(path))&&method==='POST')return json({connection:await settings().disableConnection(userId,match[1])});
  if(path==='/insights/overview'&&method==='GET')return json(await insights().overview(userId,Object.fromEntries(new URL(request.url).searchParams)));
  if(path==='/decisions/refresh'&&method==='POST')return json(await insights().recommendations(userId,{refresh:true}));
  if((match=/^\/decisions\/([^/]+)\/action$/.exec(path))&&method==='POST')return json(await insights().updateDecision(userId,match[1],await parseJson(request)));
  if(path==='/strategies'&&method==='POST')return json(await insights().createStrategy(userId,await parseJson(request)),201);
  if((match=/^\/strategies\/([^/]+)\/action$/.exec(path))&&method==='POST')return json(await insights().updateStrategy(userId,match[1],await parseJson(request)));
  if((match=/^\/projects\/([^/]+)$/.exec(path))&&method==='GET')return json({project:requireRow(await repository.getProject(userId,match[1]))});
  return null;
}
