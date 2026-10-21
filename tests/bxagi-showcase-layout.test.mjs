import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { createBxagiOrchestrator } from '../server/bxagi-orchestrator.mjs';
import { showcaseSpec } from '../server/bxagi-showcase.mjs';

function database(){const sqlite=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../drizzle/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};}
function bucket(){const values=new Map();return {async put(key,body){values.set(key,new Uint8Array(await new Response(body).arrayBuffer()));},async get(key){const bytes=values.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),async arrayBuffer(){return bytes.slice().buffer;}}:null;},async delete(key){values.delete(key);}};}
const hash=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
function png(color){
 const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let bit=0;bit<8;bit++)n=(n>>>1)^((n&1)?0xedb88320:0);}return(n^0xffffffff)>>>0;};
 const chunk=(type,body)=>{const data=Buffer.concat([Buffer.from(type),body]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(body.length);tail.writeUInt32BE(crc(data));return Buffer.concat([head,data,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(720);header.writeUInt32BE(1280,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc(1280*(1+720*3));for(let y=0;y<1280;y++)for(let x=0;x<720;x++)pixels.set(color,y*(1+720*3)+1+x*3);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
let mediaCache;
function media(){if(mediaCache)return mediaCache;const dir=mkdtempSync(join(tmpdir(),'showcase-layout-fixture-'));try{const videos=['blue','red'].map((color,index)=>{const path=join(dir,index+'.mp4');execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i',`color=${color}:size=720x1280:rate=24`,'-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','22','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',path],{timeout:20000});return readFileSync(path);});return mediaCache={videos,covers:[png([10,20,30]),png([20,40,60])]};}finally{rmSync(dir,{recursive:true,force:true});}}
async function fixture(){
 const env={DB:database(),BUCKET:bucket()},repo=createPlatformRepository(env.DB),owner='showcase-owner',subject='showcase-subject',context={nativeUserId:owner,subject,accessToken:'fixture-showcase-credential'},calls=[],state={oldManifest:false,sendError:null,copyVideo:false,copyCover:false},data=media();
 const project=await repo.createProject(owner,{title:showcaseSpec.title,productName:showcaseSpec.productName,description:'Historical immutable 22-second six-scene brief, intentionally different from newest template.',facts:showcaseSpec.facts,scene:'general',objective:'views'});
 const probe=await repo.createJob(owner,{projectId:project.id,employeeId:'',type:'platform_automation_probe',status:'completed',details:{projectId:project.id,bxagiSubject:subject,purpose:'production_only_verification',scenario:showcaseSpec.scenario,media:'video'}});
 const source=new TextEncoder().encode(showcaseSpec.sourceText);await env.BUCKET.put('source',source);
 const asset=await repo.createAsset(owner,{projectId:project.id,filename:'storyboard.txt',mimeType:'text/plain',size:source.length,objectKey:'source',metadata:{automationProbeId:probe.id}});
 const employee={id:'bxagi:market:video_optimizer',providerId:'video_optimizer',marketId:'video_optimizer',provider:'bxagi',resourceType:'installed_employee',marketVerified:true,activationState:'ready',sourceVerified:true,usable:true,conversationId:'market-source',name:'视频优化专家'};
 let job=await repo.createJob(owner,{projectId:project.id,employeeId:employee.id,type:'bxagi_workflow',status:'completed',details:{kind:'production',bxagiSubject:subject,employee,input:{id:project.id,title:project.title,productName:project.productName,description:project.description,facts:project.facts,scene:project.scene,objective:project.objective},assetIds:[asset.id],startTaskId:'start-task',conversationId:'original-task-conversation',messageAcknowledged:true,messageSentAt:new Date().toISOString(),messageEventId:'original-ack',inputsReady:true,briefUploaded:true,runtimeStatus:'ready'}});
 const prefix=`bxagi-advertising/${job.id}`,uploadedAssets=[{id:asset.id,path:`${prefix}/input/${asset.id}.txt`,kind:'source'}],files=new Map([[uploadedAssets[0].path,source]]),originals=[];
 for(const [filename,mime,bytes] of [['original.mp4','video/mp4',data.videos[0]],['cover.png','image/png',data.covers[0]],['notes.txt','text/plain',Buffer.from('Original actual production notes.')]]){
  await env.BUCKET.put(filename,bytes);originals.push(await repo.createCreative(owner,{projectId:project.id,filename,title:filename,mimeType:mime,size:bytes.length,objectKey:filename,sourceAssetIds:[asset.id],status:'draft',metadata:{sourceJobId:job.id,remoteConversationId:job.details.conversationId,remoteArtifactPath:`${prefix}/output/${filename}`}}));
 }
 job=await repo.updateJob(owner,job.id,{details:{...job.details,uploadedAssets,resultCreativeIds:originals.map(row=>row.id)}});
 files.set(`${prefix}/input/brief.json`,new TextEncoder().encode(JSON.stringify({jobId:job.id,kind:'production',project:job.details.input,campaign:null,optimization:null,coordination:null,sourceFiles:uploadedAssets})));
 const workforce={
  async listEmployees(){return [employee];},
  async getConversation(id){return {id,employeeId:employee.providerId,created_by_user_id:subject,agent_type:'CodeActAgent',execution_status:'finished'};},
  async getEvents(){return [{key:'execution_status',value:'finished'},{id:'original-ack'}];},
  async readJobInput({relativePath}){calls.push('input');return new Response(files.get(relativePath));},
  async sendMessage(id,prompt){calls.push('send');assert.equal(id,job.details.conversationId);const saved=await repo.getJob(owner,job.id);assert.equal(saved.details.remoteWritePending,'send_showcase_layout_repair');assert.equal(saved.details.visualRepair.kind,'showcase_layout');assert.match(prompt,/render_video.py/);assert.match(prompt,/bbox/);assert.match(prompt,/2000字符/);assert.match(prompt,/7.5秒、20.8秒/);assert.match(prompt,/不能把旧封面换名/);if(state.sendError)throw state.sendError;return {transport:'bxagi_ws',eventId:'layout-repair-ack',messageAcknowledged:true};},
  async readManifest(){const saved=await repo.getJob(owner,job.id);const entries=state.oldManifest?originals.map(row=>({filename:row.filename,mimeType:row.mimeType})): [{filename:'video-v2.mp4',mimeType:'video/mp4'},{filename:'cover-v2.png',mimeType:'image/png'},{filename:'notes-v2.txt',mimeType:'text/plain'}];return {version:1,jobId:job.id,kind:'production',...(!state.oldManifest?{visualRepair:{revision:1,attemptId:saved.details.visualRepair.attemptId}}:{}),creatives:entries.map(entry=>({...entry,path:`${prefix}/output/${entry.filename}`,sourceAssetIds:[asset.id],format:'portrait',factsUsed:[]}))};},
  async readArtifact({relativePath}){calls.push('artifact');return new Response(relativePath.endsWith('.mp4')?data.videos[state.copyVideo?0:1]:relativePath.endsWith('.png')?data.covers[state.copyCover?0:1]:'Actual layout repair notes.');},
 };
 for(const method of ['createConversation','getStartTask','ensureRuntime','uploadFile','switchExecutionAgent'])workforce[method]=async()=>assert.fail('Layout correction must not call '+method);
 const workflow=createBxagiOrchestrator({repository:repo,bucket:env.BUCKET,env,context,workforce}),authorization={jobId:job.id,expiresAt:new Date(Date.now()+600000).toISOString()},options={originalSha256:await hash(data.videos[0])};
 return {env,repo,owner,subject,job,asset,probe,project,originals,files,workforce,workflow,authorization,options,calls,state};
}
test('same showcase layout repair binds original video hash, sends once and collects three new real files',async()=>{
 const f=await fixture();try{
  const repair=await f.workflow.repairShowcaseLayout(f.job.id,f.authorization,f.options);assert.equal(repair.job.status,'running');assert.equal(repair.job.details.visualRepair.phase,'sent');assert.equal(repair.job.details.visualRepair.originalSha256,f.options.originalSha256);assert.deepEqual(repair.job.details.resultCreativeIds,[]);assert.equal(repair.job.details.messageEventId,'layout-repair-ack');assert.equal((await f.workflow.repairShowcaseLayout(f.job.id,f.authorization,f.options)).alreadyAttempted,true);assert.equal(f.calls.filter(x=>x==='send').length,1);
  for(const original of f.originals)assert.equal((await f.repo.getCreative(f.owner,original.id)).status,'rejected');
  f.state.oldManifest=true;assert.equal((await f.workflow.collectProduction(f.job.id)).job.status,'awaiting_result');assert.equal(f.calls.filter(x=>x==='artifact').length,0);f.state.oldManifest=false;
  let collected;for(let i=0;i<3;i++)collected=await f.workflow.collectProduction(f.job.id);assert.equal(collected.job.status,'completed');assert.equal(collected.job.details.visualRepair.phase,'completed');assert.equal(collected.job.details.resultCreativeIds.length,3);
  const rows=await f.repo.listCreatives(f.owner,collected.job.details.resultCreativeIds);assert.deepEqual(rows.map(row=>row.filename).sort(),['cover-v2.png','notes-v2.txt','video-v2.mp4']);const video=rows.find(row=>row.mimeType==='video/mp4');assert.equal(video.width,720);assert.equal(video.height,1280);assert.equal(video.duration,22);assert.equal(rows.every(row=>row.metadata.visualRepairAttemptId===repair.job.details.visualRepair.attemptId&&row.metadata.semanticValidated===false),true);
 }finally{f.env.DB.sqlite.close();}
});
test('concurrent calls reserve only one revision and ambiguous sends are never replayed',async()=>{
 for(const unknown of [false,true]){const f=await fixture();try{
  if(unknown)f.state.sendError=Object.assign(new Error('delivery status unknown'),{status:502,uncertain:true,messageSent:true});
  const results=await Promise.all([f.workflow.repairShowcaseLayout(f.job.id,f.authorization,f.options),f.workflow.repairShowcaseLayout(f.job.id,f.authorization,f.options)]);assert.equal(f.calls.filter(x=>x==='send').length,1);assert.ok(results.some(result=>result.busy||result.alreadyAttempted));
  const job=await f.repo.getJob(f.owner,f.job.id);assert.equal(job.status,unknown?'needs_reconciliation':'running');assert.equal((await f.workflow.repairShowcaseLayout(f.job.id,f.authorization,f.options)).alreadyAttempted,true);assert.equal(f.calls.filter(x=>x==='send').length,1);if(unknown)await assert.rejects(f.workflow.collectProduction(f.job.id));
 }finally{f.env.DB.sqlite.close();}}
});
test('wrong hash, source, original scope, approval state and authorization refuse any repair send',async()=>{
 for(const variant of ['hash','scope','probe','source','brief','incomplete','approval','auth','pending','approved','foreign-result']){const f=await fixture();try{
  if(variant==='hash')f.options.originalSha256='0'.repeat(64);
  if(variant==='scope')await f.repo.updateJob(f.owner,f.job.id,{details:{...f.job.details,input:{...f.job.details.input,title:'another work'}}});
  if(variant==='probe')await f.repo.updateJob(f.owner,f.probe.id,{details:{...f.probe.details,scenario:'other'}});
  if(variant==='source')f.files.set(f.job.details.uploadedAssets[0].path,Buffer.from('changed'));
  if(variant==='brief')f.files.set(`bxagi-advertising/${f.job.id}/input/brief.json`,Buffer.from('{}'));
  if(variant==='incomplete')await f.repo.updateJob(f.owner,f.job.id,{status:'awaiting_result'});
  if(variant==='approval')f.workforce.getEvents=async()=>[{key:'execution_status',value:'awaiting_user_confirmation'}];
  if(variant==='auth')f.authorization.expiresAt='2000-01-01T00:00:00Z';
  if(variant==='pending')await f.repo.updateJob(f.owner,f.job.id,{details:{...f.job.details,remoteWritePending:'send_instruction'}});
  if(variant==='approved')await f.repo.updateCreative(f.owner,f.originals[0].id,{status:'approved'});
  if(variant==='foreign-result')await f.repo.updateCreative(f.owner,f.originals[0].id,{metadata:{...f.originals[0].metadata,sourceJobId:'foreign'}});
  await assert.rejects(f.workflow.repairShowcaseLayout(f.job.id,f.authorization,f.options));assert.equal(f.calls.includes('send'),false,variant);assert.equal((await f.repo.getJob(f.owner,f.job.id)).details.visualRepair,undefined,variant);
 }finally{f.env.DB.sqlite.close();}}
});
test('new revision rejects copied original video or cover rather than treating renamed bytes as repaired',async()=>{
 for(const variant of ['copyVideo','copyCover']){const f=await fixture();try{
  await f.workflow.repairShowcaseLayout(f.job.id,f.authorization,f.options);f.state[variant]=true;let result=await f.workflow.collectProduction(f.job.id);if(variant==='copyCover')result=await f.workflow.collectProduction(f.job.id);assert.equal(result.job.status,'failed');assert.equal(result.job.details.lastErrorCode,'bxagi_invalid_visual_artifact');assert.equal(result.job.details.visualRepair.phase,'sent');assert.equal(f.calls.filter(x=>x==='send').length,1);
 }finally{f.env.DB.sqlite.close();}}
});
