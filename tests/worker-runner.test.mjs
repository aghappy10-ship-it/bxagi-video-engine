import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handlePlatformRequest } from '../server/platform-api.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';

const execute=promisify(execFile);
const cwd=new URL('..',import.meta.url).pathname;
const workerSecret='only-a-test-worker-secret';
let standaloneModule;
async function standaloneWorker(){
  if(!standaloneModule){
    const ts=(await import('typescript')).default;
    const source=(await readFile(new URL('../build/bxagi-worker.ts',import.meta.url),'utf8')).replace('"../server/platform-api.mjs"',JSON.stringify(new URL('../server/platform-api.mjs',import.meta.url).href));
    const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
    standaloneModule=import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  }
  return standaloneModule;
}
async function database(){
  const sqlite=new DatabaseSync(':memory:');
  const dir=new URL('../drizzle/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())sqlite.exec(await readFile(new URL(file,dir),'utf8'));
  return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};
}
function bucket(){
  const values=new Map();
  return {values,async put(key,stream){const bytes=new Uint8Array(await new Response(stream).arrayBuffer());values.set(key,bytes);return {size:bytes.length};},async get(key){const bytes=values.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),async arrayBuffer(){return bytes.slice().buffer;}}:null;},async delete(key){values.delete(key);}};
}
async function fixture(){return {DB:await database(),BUCKET:bucket(),APP_ENCRYPTION_KEY:'46'.repeat(32),APP_WORKER_SECRET:workerSecret};}
// Trusted dependency injection belongs only to this fixture. Production derives
// owners from verified BXAGI sessions and never accepts request owner headers.
function testBxagiResolver(user){
  return async(_request,_env,{required=false}={})=>required&&user?{userId:user,nativeUserId:user,subject:`test-bxagi:${user}`,accessToken:'fixture-bxagi-access',profile:{id:user,displayName:'测试BXAGI用户'}}:null;
}
async function call(env,path,{method='GET',body,bytes,user='video-owner',headers={},injected={}}={}){
  const h=new Headers(headers);if(body!==undefined)h.set('Content-Type','application/json');
  const dependencies={...injected,resolveBxagiContext:injected.resolveBxagiContext??testBxagiResolver(user)};
  const r=await handlePlatformRequest(new Request(`http://localhost/api/v2${path}`,{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:bytes?{body:bytes}:{})}),env,dependencies);
  const data=r.headers.get('content-type')?.includes('application/json')?await r.json():new Uint8Array(await r.arrayBuffer());return {status:r.status,data};
}
async function job(env,source,filename='游戏录屏.mp4'){
  const created=await call(env,'/projects',{method:'POST',body:{title:'游戏试玩广告',facts:['提供试玩'],productName:'测试游戏'}});assert.equal(created.status,201);
  const uploaded=await call(env,`/projects/${created.data.project.id}/assets`,{method:'POST',bytes:source,headers:{'Content-Type':'video/mp4','Content-Length':String(source.length),'X-Filename':encodeURIComponent(filename)}});
  assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));assert.equal(uploaded.data.job,null);
  // This standalone-worker fixture explicitly queues legacy FFmpeg work. Raw
  // uploads in the public BXAGI product no longer create processing jobs.
  const repository=createPlatformRepository(env.DB);
  const queued=await repository.createJob('video-owner',{projectId:created.data.project.id,assetId:uploaded.data.asset.id,employeeId:'fixture-video-worker',type:'video_optimize',status:'queued',details:{recipe:{format:'portrait',sourceAssetId:uploaded.data.asset.id,preserveFullVideo:true,semanticCut:false},semanticValidated:false}});
  return {...uploaded.data,job:queued,project:created.data.project};
}
async function sample(directory){
  const path=join(directory,'source.mp4');
  await execute('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-f','lavfi','-i','sine=frequency=550:sample_rate=44100','-t','1.2','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',path],{timeout:15000});
  return {path,bytes:await readFile(path)};
}
async function listen(handler){
  const server=createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  return {server,base:`http://127.0.0.1:${server.address().port}`,async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function httpFixture(env,{rejectSecondTick=false}={}){
  let tickRequests=0;
  const http=await listen(async(incoming,outgoing)=>{
    try{
      if(incoming.url==='/api/v2/worker/tick'){
        tickRequests++;
        if(rejectSecondTick&&tickRequests>1){outgoing.writeHead(401,{'Content-Type':'application/json'});outgoing.end('{"error":"test rejected"}');return;}
      }
      const r=new Request(`http://${incoming.headers.host}${incoming.url}`,{method:incoming.method,headers:incoming.headers,...(['GET','HEAD'].includes(incoming.method)?{}:{body:Readable.toWeb(incoming),duplex:'half'})});
      const selected=typeof incoming.headers['x-test-bxagi-owner']==='string'?incoming.headers['x-test-bxagi-owner']:null;
      const fixtureOwner=['video-owner','another-user'].includes(selected)?selected:null;
      const response=await handlePlatformRequest(r,env,{resolveBxagiContext:testBxagiResolver(fixtureOwner)});outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body)Readable.fromWeb(response.body).pipe(outgoing);else outgoing.end();
    }catch{outgoing.writeHead(500);outgoing.end();}
  });
  return {...http,ticks:()=>tickRequests};
}
async function runner(base,extras={}){
  return execute('python3',['worker/run.py','--once','--process-timeout','45','--network-timeout','5'],{cwd,timeout:60000,env:{...process.env,BXAGI_BASE_URL:base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:'',...extras},maxBuffer:64*1024});
}

test('leased HTTP job runs through Python FFmpeg, full decode, real MP4 storage and tenant ownership', {timeout:70000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bxagi-worker-e2e-'));const env=await fixture();const http=await httpFixture(env);
  try{
    const source=await sample(directory),created=await job(env,source.bytes),repository=createPlatformRepository(env.DB);
    const result=await runner(http.base);assert.match(result.stdout,/video_completed/);assert.match(result.stdout,/"fullDecodePassed": true/);assert.ok(!result.stdout.includes(workerSecret));assert.equal(http.ticks(),1);
    const finished=await repository.getWorkerJob(created.job.id);assert.equal(finished.status,'completed');
    assert.equal(finished.details.output.width,720);assert.equal(finished.details.output.height,1280);assert.equal(finished.details.output.fullDecodePassed,true);assert.equal(finished.details.output.semanticValidated,false);
    const creative=await repository.getCreative('video-owner',finished.details.resultCreativeId);assert.equal(creative.validation,'worker-full-decode');assert.deepEqual(creative.sourceAssetIds,[created.asset.id]);assert.equal(creative.metadata.copyApplied,false);assert.equal(creative.userId,'video-owner');
    const stored=await env.BUCKET.get(creative.objectKey);assert.equal(stored.size,creative.size);assert.ok(stored.size>1024);
    const output=join(directory,'stored.mp4');await writeFile(output,new Uint8Array(await stored.arrayBuffer()));
    await execute('ffmpeg',['-v','error','-xerror','-nostdin','-i',output,'-map','0:v:0','-map','0:a:0?','-f','null','-'],{timeout:15000});
    const actual=JSON.parse((await execute('ffprobe',['-v','error','-show_entries','stream=codec_type,width,height:format=duration','-of','json',output],{timeout:5000})).stdout);
    const video=actual.streams.find(s=>s.codec_type==='video');assert.equal(video.width,720);assert.equal(video.height,1280);assert.ok(actual.streams.some(s=>s.codec_type==='audio'));assert.ok(Math.abs(Number(actual.format.duration)-1.2)<.3);
    assert.equal((await call(env,`/creatives/${creative.id}/content`,{user:'another-user'})).status,404);
    assert.equal((await call(env,`/creatives/${creative.id}/content`)).status,200);
    const again=await runner(http.base);assert.match(again.stdout,/"claimed": 0/);assert.equal((await repository.listCreatives('video-owner')).length,1);
  }finally{await http.close();env.DB.sqlite.close();await rm(directory,{recursive:true,force:true});}
});

test('worker bearer and leases guard sources and reject unverified output metadata and oversize results',async()=>{
  const env=await fixture();const fake=new Uint8Array(1024);fake.set(new TextEncoder().encode('ftyp'),4);
  try{
    const created=await job(env,fake);const auth={Authorization:`Bearer ${workerSecret}`};
    assert.equal((await call(env,'/worker/claim',{user:null,method:'POST',body:{capabilities:['ffmpeg']}})).status,401);
    const claim=await call(env,'/worker/claim',{user:null,method:'POST',body:{capabilities:['ffmpeg']},headers:auth});assert.equal(claim.status,200);const leased=claim.data.jobs[0];
    assert.equal((await call(env,`/worker/jobs/${created.job.id}/source`,{user:null,headers:{...auth,'X-Job-Lease':'wrong'}})).status,409);
    const completePath=`/worker/jobs/${created.job.id}/complete`,lease={...auth,'X-Job-Lease':leased.leaseId,'Content-Type':'video/mp4','Content-Length':String(fake.length)};
    const unverified=await call(env,completePath,{user:null,method:'POST',bytes:fake,headers:{...lease,'X-Result-Metadata':encodeURIComponent(JSON.stringify({fullDecodePassed:false,width:720,height:1280,duration:1}))}});assert.equal(unverified.status,422);
    assert.equal((await createPlatformRepository(env.DB).getWorkerJob(created.job.id)).status,'running');
    const oversize=await call(env,completePath,{user:null,method:'POST',bytes:fake,headers:{...lease,'Content-Length':String(64*1024*1024+1),'X-Result-Metadata':encodeURIComponent(JSON.stringify({fullDecodePassed:true,width:720,height:1280,duration:1}))}});assert.equal(oversize.status,413);assert.equal((await createPlatformRepository(env.DB).listCreatives('video-owner')).length,0);
  }finally{env.DB.sqlite.close();}
});

test('explicit timestamps produce the requested real clip and format instead of silent semantic cuts', {timeout:70000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bxagi-worker-trim-')),env=await fixture(),http=await httpFixture(env);
  try{
    const source=await sample(directory),created=await job(env,source.bytes),repository=createPlatformRepository(env.DB);
    await repository.updateWorkerJob(created.job.id,{details:{...created.job.details,recipe:{format:'landscape',preserveFullVideo:false,semanticCut:false,trim:{startSeconds:.2,endSeconds:.8,basis:'explicit_timestamps'}}}});
    const result=await runner(http.base);assert.match(result.stdout,/video_completed/);
    const stored=await repository.getWorkerJob(created.job.id);assert.equal(stored.status,'completed');assert.equal(stored.details.output.width,1280);assert.equal(stored.details.output.height,720);assert.ok(Math.abs(stored.details.output.duration-.6)<.15);
    const creative=await repository.getCreative('video-owner',stored.details.resultCreativeId);assert.equal(creative.format,'landscape');assert.equal(creative.metadata.semanticValidated,false);
  }finally{await http.close();env.DB.sqlite.close();await rm(directory,{recursive:true,force:true});}
});

test('failed actual video inspection reports failure and creates no fabricated creative', {timeout:30000},async()=>{
  const env=await fixture(),http=await httpFixture(env),fake=new Uint8Array(2048);fake.set(new TextEncoder().encode('ftyp'),4);
  try{
    const created=await job(env,fake);
    await assert.rejects(runner(http.base),err=>{assert.equal(err.code,1);assert.match(err.stdout,/video_failed/);assert.ok(!err.stdout.includes(workerSecret));return true;});
    const repository=createPlatformRepository(env.DB),failed=await repository.getWorkerJob(created.job.id);assert.equal(failed.status,'failed');assert.equal((await repository.listCreatives('video-owner')).length,0);
    assert.equal(env.BUCKET.values.size,1);
  }finally{await http.close();env.DB.sqlite.close();}
});

test('runner refuses cross-origin redirects without forwarding either service token', {timeout:15000},async()=>{
  let trapRequests=0;const trap=await listen((incoming,outgoing)=>{trapRequests++;outgoing.end('{}');});
  const origin=await listen((incoming,outgoing)=>{if(incoming.url.endsWith('/tick')){outgoing.setHeader('Content-Type','application/json');outgoing.end('{"processed":0}');}else{outgoing.writeHead(302,{Location:`${trap.base}/stolen`});outgoing.end();}});
  try{
    await assert.rejects(runner(origin.base,{SITES_SERVICE_TOKEN:'test-native-bypass'}),err=>{assert.equal(err.code,1);assert.match(err.stdout,/poll_failed/);assert.ok(!err.stdout.includes('test-native-bypass'));return true;});assert.equal(trapRequests,0);
  }finally{await origin.close();await trap.close();}
});

test('expired leases recover at most three times, and a late worker cannot overwrite the new lease',async()=>{
  const env=await fixture(),fake=new Uint8Array(1024);fake.set(new TextEncoder().encode('ftyp'),4);
  try{
    const created=await job(env,fake),repository=createPlatformRepository(env.DB),old=(await repository.claimWorkerJobs(1,['ffmpeg']))[0];
    await repository.updateWorkerJob(old.id,{details:{...old.details,leaseExpiresAt:'2000-01-01T00:00:00.000Z'}});
    const newer=(await repository.claimWorkerJobs(1,['ffmpeg']))[0];assert.equal(newer.id,old.id);assert.notEqual(newer.details.leaseId,old.details.leaseId);assert.equal(newer.details.attempts,2);
    const rejected=await call(env,`/worker/jobs/${created.job.id}/source`,{user:null,headers:{Authorization:`Bearer ${workerSecret}`,'X-Job-Lease':old.details.leaseId}});assert.equal(rejected.status,409);
    await repository.updateWorkerJob(newer.id,{details:{...newer.details,attempts:3,leaseExpiresAt:'2000-01-01T00:00:00.000Z'}});assert.deepEqual(await repository.claimWorkerJobs(1,['ffmpeg']),[]);assert.equal((await repository.getWorkerJob(newer.id)).status,'failed');
  }finally{env.DB.sqlite.close();}
});

test('continuous monitoring keeps polling during a long video encode and authentication failure stops compute', {timeout:20000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bxagi-worker-monitor-')),env=await fixture(),http=await httpFixture(env,{rejectSecondTick:true});
  try{
    const source=await sample(directory),created=await job(env,source.bytes);
    // A test wrapper holds the actual encoder long enough to observe independent monitoring.
    const wrapper=join(directory,'ffmpeg');await writeFile(wrapper,'#!/usr/bin/python3\nimport os, sys, time\ntime.sleep(10)\nos.execv("/usr/bin/ffmpeg", ["ffmpeg", *sys.argv[1:]])\n');await chmod(wrapper,0o755);
    const started=Date.now();
    await assert.rejects(execute('python3',['worker/run.py','--mode','all','--poll-seconds','5','--process-timeout','30','--network-timeout','2'],{cwd,timeout:15000,env:{...process.env,PATH:`${directory}:${process.env.PATH}`,BXAGI_BASE_URL:http.base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:''},maxBuffer:64*1024}),err=>{assert.equal(err.code,2);assert.match(err.stdout,/authentication_rejected/);assert.ok(!err.stdout.includes(workerSecret));return true;});
    assert.equal(http.ticks(),2);assert.ok(Date.now()-started<9000,'auth failure must interrupt the blocked encoder');
    const repository=createPlatformRepository(env.DB);assert.equal((await repository.listCreatives('video-owner')).length,0);assert.equal((await repository.getWorkerJob(created.job.id)).status,'running');
  }finally{await http.close();env.DB.sqlite.close();await rm(directory,{recursive:true,force:true});}
});

test('ads-only mode needs no FFmpeg and does not claim video jobs', {timeout:15000},async()=>{
  let ticks=0,claims=0;const http=await listen((incoming,outgoing)=>{if(incoming.url.endsWith('/tick'))ticks++;else claims++;outgoing.setHeader('Content-Type','application/json');outgoing.end('{"processed":0}');});
  try{
    const result=await execute('/usr/bin/python3',['worker/run.py','--once','--mode','ads'],{cwd,timeout:10000,env:{...process.env,PATH:'',BXAGI_BASE_URL:http.base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:''},maxBuffer:64*1024});
    assert.match(result.stdout,/ads_monitor_tick/);assert.equal(ticks,1);assert.equal(claims,0);
  }finally{await http.close();}
});

test('SIGTERM stops continuous workers cleanly while the monitor thread is active', {timeout:15000},async()=>{
  const env=await fixture(),http=await httpFixture(env);let child;
  try{
    child=spawn('python3',['worker/run.py','--mode','all','--poll-seconds','5','--network-timeout','2'],{cwd,env:{...process.env,BXAGI_BASE_URL:http.base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:''},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('ads_monitor_tick')&&stdout.includes('cycle_finished'))resolve();});child.once('error',reject);});
    const closed=once(child,'close');child.kill('SIGTERM');const [code,signal]=await closed;
    assert.equal(code,0,stderr);assert.equal(signal,null);assert.match(stdout,/"event": "stopped"/);assert.ok(!stdout.includes(workerSecret));assert.equal(http.ticks(),1);
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');await http.close();env.DB.sqlite.close();}
});

test('interrupted job confirmation retains actual saved MP4 and recovers the finishing lease without re-encoding', {timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'bxagi-worker-interrupted-')),env=await fixture();
  try{
    const source=await sample(directory),created=await job(env,source.bytes),repository=createPlatformRepository(env.DB);
    const leased=(await repository.claimWorkerJobs(1,['ffmpeg']))[0];let failedConfirmation=false;
    const interrupted={...repository,async updateWorkerJob(id,patch){
      if(patch.status==='completed'&&!failedConfirmation){failedConfirmation=true;throw new Error('Injected interruption after durable creative save');}
      return repository.updateWorkerJob(id,patch);
    }};
    const completed=await call(env,`/worker/jobs/${created.job.id}/complete`,{user:null,method:'POST',bytes:source.bytes,injected:{repository:interrupted},headers:{Authorization:`Bearer ${workerSecret}`,'X-Job-Lease':leased.details.leaseId,'Content-Type':'video/mp4','Content-Length':String(source.bytes.length),'X-Result-Metadata':encodeURIComponent(JSON.stringify({fullDecodePassed:true,width:320,height:180,duration:1.2}))}});
    assert.equal(completed.status,202);assert.equal(completed.data.processingState,'saved_pending_job_confirmation');assert.equal(failedConfirmation,true);
    const creative=await repository.getCreative('video-owner',completed.data.creative.id),pending=await repository.getWorkerJob(leased.id);
    assert.equal(pending.status,'finishing');assert.equal(creative.metadata.sourceJobId,leased.id);assert.ok(creative.objectKey);
    assert.deepEqual(new Uint8Array(await (await env.BUCKET.get(creative.objectKey)).arrayBuffer()),new Uint8Array(source.bytes));
    await repository.updateWorkerJob(leased.id,{details:{...pending.details,leaseExpiresAt:'2000-01-01T00:00:00.000Z'}});
    const reclaimed=await call(env,'/worker/claim',{user:null,method:'POST',body:{capabilities:['ffmpeg'],limit:1},headers:{Authorization:`Bearer ${workerSecret}`}});
    assert.equal(reclaimed.status,200);assert.deepEqual(reclaimed.data.jobs,[]);
    const recovered=await repository.getWorkerJob(leased.id);assert.equal(recovered.status,'completed');assert.equal(recovered.details.resultCreativeId,creative.id);assert.equal(recovered.details.attempts,1);assert.equal(recovered.details.output.fullDecodePassed,true);
    assert.equal((await repository.listCreatives('video-owner')).length,1);assert.equal(env.BUCKET.values.size,2);assert.ok(await env.BUCKET.get(creative.objectKey));
    assert.deepEqual((await call(env,`/creatives/${creative.id}/content`)).data,new Uint8Array(source.bytes));
  }finally{env.DB.sqlite.close();await rm(directory,{recursive:true,force:true});}
});

test('slow BXAGI synchronization does not delay budget monitoring and task-level login expiry keeps the runner alive', {timeout:18000},async()=>{
  const adsTimes=[];let bxStarted=0,bxFinished=0,child,timer;
  const http=await listen((incoming,outgoing)=>{
    assert.equal(incoming.headers.authorization,`Bearer ${workerSecret}`);
    outgoing.setHeader('Content-Type','application/json');
    if(incoming.url==='/api/v2/worker/tick'){adsTimes.push(Date.now());outgoing.end('{"processed":0}');}
    else if(incoming.url==='/api/v2/worker/bxagi-tick'){
      bxStarted=Date.now();timer=setTimeout(()=>{bxFinished=Date.now();outgoing.end('{"processed":1,"jobs":[{"status":"requires_login"}]}');},6200);
    }else if(incoming.url==='/api/v2/worker/claim')outgoing.end('{"jobs":[]}');
    else{outgoing.writeHead(404);outgoing.end('{}');}
  });
  try{
    child=spawn('python3',['worker/run.py','--mode','all','--poll-seconds','5','--network-timeout','10'],{cwd,env:{...process.env,BXAGI_BASE_URL:http.base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:''},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('bxagi_monitor_tick')&&adsTimes.length>=2)resolve();});child.once('error',reject);});
    assert.ok(bxStarted>0&&bxFinished>bxStarted);assert.ok(adsTimes[1]<bxFinished,'the second ads tick must happen before the slow BXAGI response');assert.ok(adsTimes[1]-adsTimes[0]<5800);
    assert.equal(child.exitCode,null,'requires_login is a task state, not worker authentication failure');assert.ok(!stdout.includes('authentication_rejected'));assert.ok(!stdout.includes(workerSecret));
    const closed=once(child,'close');child.kill('SIGTERM');assert.equal((await closed)[0],0,stderr);
  }finally{clearTimeout(timer);if(child?.exitCode===null)child.kill('SIGKILL');await http.close();}
});

test('BXAGI-only mode needs no FFmpeg and once-all calls ads, BXAGI, then video in order', {timeout:15000},async()=>{
  const calls=[];const http=await listen((incoming,outgoing)=>{calls.push(incoming.url);outgoing.setHeader('Content-Type','application/json');outgoing.end(incoming.url.endsWith('/claim')?'{"jobs":[]}':'{"processed":0,"jobs":[{"status":"requires_login"}]}');});
  try{
    const only=await execute('/usr/bin/python3',['worker/run.py','--once','--mode','bxagi'],{cwd,timeout:10000,env:{...process.env,PATH:'',BXAGI_BASE_URL:http.base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:''},maxBuffer:64*1024});
    assert.match(only.stdout,/bxagi_monitor_tick/);assert.deepEqual(calls,['/api/v2/worker/bxagi-tick']);calls.length=0;
    await runner(http.base);assert.deepEqual(calls,['/api/v2/worker/tick','/api/v2/worker/bxagi-tick','/api/v2/worker/claim']);
  }finally{await http.close();}
});

test('BXAGI service authentication rejection stops the shared continuous runner', {timeout:10000},async()=>{
  const http=await listen((incoming,outgoing)=>{outgoing.setHeader('Content-Type','application/json');if(incoming.url==='/api/v2/worker/bxagi-tick'){outgoing.writeHead(401);outgoing.end('{"error":"service authentication rejected"}');}else outgoing.end(incoming.url.endsWith('/claim')?'{"jobs":[]}':'{"processed":0}');});
  try{
    await assert.rejects(execute('python3',['worker/run.py','--mode','all','--poll-seconds','5','--network-timeout','2'],{cwd,timeout:8000,env:{...process.env,BXAGI_BASE_URL:http.base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:''},maxBuffer:64*1024}),err=>{assert.equal(err.code,2);assert.match(err.stdout,/authentication_rejected/);assert.ok(!err.stdout.includes(workerSecret));return true;});
  }finally{await http.close();}
});

test('once-all returns failure when monitoring fails even if there are no video jobs', {timeout:15000},async()=>{
  const calls=[];const http=await listen((incoming,outgoing)=>{calls.push(incoming.url);outgoing.setHeader('Content-Type','application/json');if(incoming.url==='/api/v2/worker/tick'){outgoing.writeHead(503);outgoing.end('{"error":"temporarily unavailable"}');}else outgoing.end(incoming.url.endsWith('/claim')?'{"jobs":[]}':'{"processed":0}');});
  try{
    await assert.rejects(runner(http.base),err=>{assert.equal(err.code,1);assert.match(err.stdout,/ads_monitor_unavailable/);assert.match(err.stdout,/"failed": 1/);return true;});
    assert.deepEqual(calls,['/api/v2/worker/tick','/api/v2/worker/bxagi-tick','/api/v2/worker/claim']);
  }finally{await http.close();}
});

test('a stalled response body is bounded and continuous monitoring recovers on its next tick', {timeout:15000},async()=>{
  let requests=0,child;const http=await listen((incoming,outgoing)=>{
    requests++;outgoing.setHeader('Content-Type','application/json');
    if(requests===1){outgoing.writeHead(200);outgoing.write('{"processed":');}
    else outgoing.end('{"processed":0}');
  });
  try{
    child=spawn('/usr/bin/python3',['worker/run.py','--mode','ads','--poll-seconds','5','--network-timeout','1'],{cwd,env:{...process.env,PATH:'',BXAGI_BASE_URL:http.base,APP_WORKER_SECRET:workerSecret,SITES_SERVICE_TOKEN:''},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
    await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.includes('ads_monitor_tick'))resolve();});child.once('error',reject);child.once('close',code=>{if(code!==null)reject(new Error('Monitoring stopped before recovery'));});});
    assert.match(stdout,/ads_monitor_unavailable/);assert.equal(requests,2);assert.equal(child.exitCode,null);assert.equal(stderr,'');assert.ok(!stdout.includes(workerSecret));
    const closed=once(child,'close');child.kill('SIGTERM');assert.equal((await closed)[0],0);
  }finally{if(child?.exitCode===null)child.kill('SIGKILL');await http.close();}
});

test('standalone cron is explicit, can be disabled and requires the existing service secret',async()=>{
  const ts=(await import('typescript')).default;
  const parsed=ts.parseConfigFileTextToJson('wrangler.standalone.jsonc',await readFile(new URL('../wrangler.standalone.jsonc',import.meta.url),'utf8'));
  assert.equal(parsed.error,undefined);assert.deepEqual(parsed.config.triggers.crons,['* * * * *']);assert.equal(parsed.config.vars.BXAGI_BACKGROUND_ENABLED,'true');assert.equal(parsed.config.vars.APP_WORKER_SECRET,undefined);
  const native=JSON.parse(await readFile(new URL('../.openai/hosting.json',import.meta.url),'utf8'));assert.equal(native.triggers,undefined);
  const {runScheduledTicks}=await standaloneWorker();let called=false;
  assert.deepEqual(await runScheduledTicks({},async()=>{called=true;return Response.json({});}),{enabled:false,completed:0});assert.equal(called,false);
  await assert.rejects(runScheduledTicks({BXAGI_BACKGROUND_ENABLED:'true'},async()=>{called=true;return Response.json({});}),/service secret/);assert.equal(called,false);
});

test('standalone scheduled dispatch uses the heartbeat endpoint without a user and awaits completion',async()=>{
  const {runScheduledTicks}=await standaloneWorker(),env={BXAGI_BACKGROUND_ENABLED:'true',APP_WORKER_SECRET:workerSecret};
  const started=[];let release;const slow=new Promise(resolve=>{release=resolve;});let settled=false;
  const pending=runScheduledTicks(env,async(request,suppliedEnv)=>{
    const path=new URL(request.url).pathname;started.push(path);assert.equal(suppliedEnv,env);assert.equal(request.method,'POST');assert.equal(request.headers.get('Authorization'),`Bearer ${workerSecret}`);assert.equal(request.headers.get('oai-authenticated-user-id'),null);assert.equal(request.headers.get('Cookie'),null);assert.equal(await request.text(),'{}');
    await slow;
    return Response.json({error:'fixture-provider-details-should-stay-private'},{status:503});
  }).then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['/api/v2/worker/background-tick']);assert.equal(settled,false);
  release();await assert.rejects(pending,error=>{assert.match(error.message,/endpoints did not complete/);assert.ok(!error.message.includes('fixture-provider-details'));assert.ok(!error.message.includes(workerSecret));return true;});assert.equal(settled,true);
});

test('standalone scheduled hook runs the actual worker APIs with SQLite/R2 and leaves native runtime unchanged',async()=>{
  const env=await fixture(),{default:worker}=await standaloneWorker();
  try{
    await worker.scheduled({cron:'* * * * *',scheduledTime:Date.now(),noRetry(){}},{...env,BXAGI_BACKGROUND_ENABLED:'true'},{waitUntil(){throw new Error('Scheduled work must be awaited');}});
    const health=await call(env,'/system/health',{user:null});assert.equal(health.status,200);assert.equal(health.data.backgroundScheduling,false);
    assert.equal((await createPlatformRepository(env.DB).listCreatives('video-owner')).length,0);
  }finally{env.DB.sqlite.close();}
});
