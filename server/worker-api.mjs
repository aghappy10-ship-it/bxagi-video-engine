/** Trusted compute boundary. A job lease binds every source and result to its owner. */
const MAX_BYTES=64*1024*1024;
const respond=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const error=(status,message)=>Object.assign(new Error(message),{status});
function authorized(request,secret){
  if(!secret)throw error(503,'视频处理员工密钥未配置');
  const supplied=request.headers.get('Authorization')||'',expected=`Bearer ${secret}`;
  let difference=supplied.length^expected.length;
  for(let i=0;i<expected.length;i++)difference|=(supplied.charCodeAt(i)||0)^expected.charCodeAt(i);
  if(difference)throw error(401,'视频处理员工认证失败');
}
async function smallJson(request){
  if(Number(request.headers.get('Content-Length')||0)>65536)throw error(413,'请求过大');
  const text=await request.text();if(text.length>65536)throw error(413,'请求过大');
  try{return text?JSON.parse(text):{};}catch{throw error(400,'JSON格式有误');}
}
function checkedLease(request,job){
  if(!job)throw error(404,'处理任务不存在');
  if(request.headers.get('X-Job-Lease')!==job.details?.leaseId)throw error(409,'任务租约不匹配');
  const expires=Date.parse(job.details?.leaseExpiresAt||'');
  if(!Number.isFinite(expires)||expires<=Date.now())throw error(409,'任务租约已过期');
  if(!['running','completed'].includes(job.status))throw error(409,'任务已不在处理状态');
}
async function uploadMp4(request,bucket,key){
  const length=Number(request.headers.get('Content-Length'));
  if(!Number.isInteger(length)||length<1024||length>MAX_BYTES||!request.body)throw error(413,'成片必须在1 KB至64 MB以内');
  if((request.headers.get('Content-Type')||'').split(';')[0]!=='video/mp4')throw error(415,'视频员工必须提交实际MP4');
  const [inspection,payload]=request.body.tee(),reader=inspection.getReader();
  const prefix=[];let total=0;
  while(total<12){const {done,value}=await reader.read();if(done)break;prefix.push(value);total+=value.length;}
  void reader.cancel().catch(()=>{});
  const bytes=new Uint8Array(total);let offset=0;for(const part of prefix){bytes.set(part,offset);offset+=part.length;}
  if(bytes.length<12||new TextDecoder().decode(bytes.slice(4,8))!=='ftyp'){void payload.cancel();throw error(415,'文件内容不是ISO MP4');}
  let stream=payload,transfer;
  if(typeof globalThis.FixedLengthStream==='function'){
    const fixed=new globalThis.FixedLengthStream(length);transfer=payload.pipeTo(fixed.writable);transfer.catch(()=>{});stream=fixed.readable;
  }
  try{
    const stored=await bucket.put(key,stream,{httpMetadata:{contentType:'video/mp4'}});
    if(transfer)await transfer;
    if(stored?.size!=null&&stored.size!==length){await bucket.delete(key);throw error(422,'成片上传大小不符');}
    return length;
  }catch(e){await bucket.delete(key).catch(()=>{});throw e;}
}
export async function handleWorkerRequest(request,{repository,bucket,env}){
  try{
    authorized(request,env.APP_WORKER_SECRET);
    const path=new URL(request.url).pathname.replace(/^\/api\/v2/,'');
    if(path==='/worker/claim'&&request.method==='POST'){
      const body=await smallJson(request),capabilities=Array.isArray(body.capabilities)?body.capabilities:[];
      const jobs=await repository.claimWorkerJobs(Math.min(Number(body.limit)||1,5),capabilities);
      for(const job of jobs){
        if(job.details?.completionObjectKey){
          await bucket.delete(job.details.completionObjectKey);
          job.details={...job.details,completionObjectKey:null};
          await repository.updateWorkerJob(job.id,{details:job.details});
        }
      }
      const safe=jobs.map(job=>({id:job.id,type:job.type,recipe:job.details?.recipe||{},leaseId:job.details?.leaseId,leaseExpiresAt:job.details?.leaseExpiresAt,
        sourcePath:`/api/v2/worker/jobs/${job.id}/source`,completePath:`/api/v2/worker/jobs/${job.id}/complete`,failPath:`/api/v2/worker/jobs/${job.id}/fail`}));
      return respond({jobs:safe});
    }
    const match=path.match(/^\/worker\/jobs\/([a-f0-9-]+)\/(source|complete|fail)$/);
    if(!match)return respond({error:'员工接口不存在'},404);
    const job=await repository.getWorkerJob(match[1]);checkedLease(request,job);
    const project=await repository.getProject(job.userId,job.projectId),asset=await repository.getAsset(job.userId,job.assetId);
    if(!project||!asset||asset.projectId!==job.projectId)throw error(404,'任务的所属素材不存在');
    if(match[2]==='source'&&request.method==='GET'){
      if(job.status!=='running')throw error(409,'任务已经完成');
      const object=await bucket.get(asset.objectKey);if(!object)throw error(404,'原始视频文件不存在');
      return new Response(object.body,{headers:{'Content-Type':asset.mimeType,'Content-Length':String(object.size),'Cache-Control':'no-store'}});
    }
    if(match[2]==='fail'&&request.method==='POST'){
      if(job.status!=='running')throw error(409,'任务已完成');
      const body=await smallJson(request),reason=String(body.error||'视频员工处理失败').slice(0,500);
      await repository.updateWorkerJob(job.id,{status:'failed',details:{...job.details,error:reason}});
      await repository.addAudit(job.userId,{action:'video.processing_failed',entityType:'job',entityId:job.id,details:{reason}});
      return respond({status:'failed'});
    }
    if(match[2]==='complete'&&request.method==='POST'){
      if(job.status==='completed')return respond({creative:await repository.getCreative(job.userId,job.details.resultCreativeId),replayed:true});
      let metadata;try{metadata=JSON.parse(decodeURIComponent(request.headers.get('X-Result-Metadata')||''));}catch{throw error(400,'成片检测结果格式有误');}
      if(metadata.fullDecodePassed!==true||!Number.isFinite(metadata.duration)||metadata.duration<=0||metadata.duration>7200||!Number.isInteger(metadata.width)||!Number.isInteger(metadata.height)||metadata.width<16||metadata.height<16||metadata.width>8192||metadata.height>8192)throw error(422,'未取得实际解码与尺寸结果');
      if(!await repository.claimWorkerCompletion(job.id,job.details.leaseId))throw error(409,'成片已经由其他处理请求提交');
      const key=`${encodeURIComponent(job.userId)}/creatives/${crypto.randomUUID()}.mp4`;
      let savedCreative;
      try{
        await repository.updateWorkerJob(job.id,{details:{...job.details,completionObjectKey:key}});
        const size=await uploadMp4(request,bucket,key);
        const creative=await repository.createCreative(job.userId,{projectId:job.projectId,filename:`${job.id}.mp4`,mimeType:'video/mp4',size,objectKey:key,title:`${project.title} · 视频适配素材`,format:job.details.recipe?.format||'portrait',employeeId:job.employeeId,sourceAssetIds:[job.assetId],validation:'worker-full-decode',width:metadata.width,height:metadata.height,duration:metadata.duration,status:'draft',metadata:{technicalChecks:{fullDecode:true},semanticValidated:false,copyApplied:false,sourceJobId:job.id}});
        savedCreative=creative;
        await repository.updateWorkerJob(job.id,{status:'completed',details:{...job.details,resultCreativeId:creative.id,output:{width:metadata.width,height:metadata.height,duration:metadata.duration,fullDecodePassed:true,semanticValidated:false}}});
        await repository.addAudit(job.userId,{action:'video.processing_completed',entityType:'creative',entityId:creative.id,details:{jobId:job.id,width:metadata.width,height:metadata.height,duration:metadata.duration}});
        return respond({creative},201);
      }catch(e){
        // A durable creative must keep its bytes if the subsequent job/audit write
        // is interrupted. Expired finishing leases recover via sourceJobId.
        if(savedCreative)return respond({creative:savedCreative,processingState:'saved_pending_job_confirmation'},202);
        await bucket.delete(key).catch(()=>{});await repository.updateWorkerJob(job.id,{status:'failed',details:{...job.details,error:'成片保存失败'}});throw e;
      }
    }
    return respond({error:'不支持的员工操作'},405);
  }catch(e){return respond({error:e.status?e.message:'视频员工接口处理失败'},e.status||500);}
}
