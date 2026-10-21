import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { handleBxagiAuthRequest,resolveBxagiContext,resolveBxagiContextForUser,probeBxagiConnection,BXAGI_SESSION_COOKIE,BXAGI_ORIGIN } from '../server/bxagi-auth.mjs';
import { createBxagiAccountRepository } from '../server/bxagi-account-repository.mjs';
import { createBxagiSessionRepository } from '../server/bxagi-session-repository.mjs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
import { handlePlatformRequest } from '../server/platform-api.mjs';
const TOKEN='UPSTREAM_ONLY_ACCESS_TOKEN_123456';
const PASSWORD='password is never persisted';
function database(){const sqlite=new DatabaseSync(':memory:'),dir=new URL('../drizzle/',import.meta.url);for(const name of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));return {sqlite,prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};}
function fixture(){const state={calls:[],token:TOKEN,meStatus:200,user:{id:'verified-bxagi-id',username:'alice',name:'Alice',email:'alice@example.test',phone:'13800138000',access_token:TOKEN,password:PASSWORD}};const fetcher=async(url,options={})=>{state.calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null,headers:options.headers});assert.ok(url.startsWith(BXAGI_ORIGIN));if(url.endsWith('/api/auth/login'))return Response.json({access_token:state.token,user:{id:'untrusted-login-profile',email:'same@example.test'}});if(url.endsWith('/api/auth/me')){assert.equal(options.headers.Authorization,`Bearer ${state.token}`);return Response.json(state.meStatus===200?state.user:{detail:'do not expose server details '+TOKEN},{status:state.meStatus});}throw new Error('Undocumented auth endpoint requested');};return {env:{DB:database(),APP_ENCRYPTION_KEY:'57'.repeat(32)},state,fetcher};}
function request(path,{user=null,method='GET',body,cookie,headers={}}={}){const h=new Headers(headers);if(user)h.set('oai-authenticated-user-id',user);if(body!==undefined)h.set('Content-Type','application/json');if(cookie)h.set('Cookie',cookie);return new Request(`https://app.test/api/v2/bxagi/auth/${path}`,{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{})});}
async function call(f,path,options={}){const result=await handleBxagiAuthRequest(request(path,options),f.env,{fetcher:f.fetcher});return {status:result.status,data:await result.json(),cookie:result.headers.get('Set-Cookie')};}
async function login(f,options={}){const result=await call(f,'login',{method:'POST',body:{login:'alice',login_type:'username',password:PASSWORD},...options});assert.equal(result.status,200,JSON.stringify(result.data));return {...result,cookiePair:result.cookie.split(';')[0]};}

test('official login is followed by auth/me verification; only encrypted token and opaque cookie are persisted',async()=>{
  const f=fixture(),result=await login(f);assert.deepEqual(f.state.calls.map(c=>c.url),[`${BXAGI_ORIGIN}/api/auth/login`,`${BXAGI_ORIGIN}/api/auth/me`]);assert.equal(f.state.calls[0].body.login_type,'username');assert.equal(f.state.calls[0].body.password,PASSWORD);assert.match(f.state.calls[0].body.device_id,/^[a-f0-9-]{36}$/);
  assert.equal(result.data.profile.id,'verified-bxagi-id');assert.equal(result.data.identitySource,'verified_auth_me');assert.equal(result.data.profile.email,'a***@example.test');assert.ok(!JSON.stringify(result.data).includes(TOKEN));assert.ok(!JSON.stringify(result.data).includes(PASSWORD));
  assert.match(result.cookie,/Secure; HttpOnly; SameSite=None; Partitioned/);assert.match(result.cookie,/Path=\//);assert.ok(!result.cookie.includes('Domain='));const opaque=result.cookiePair.split('=')[1];assert.match(opaque,/^[A-Za-z0-9_-]{43}$/);assert.ok(!opaque.includes('.'));
  const row=f.env.DB.sqlite.prepare('SELECT * FROM bxagiSessions').get();assert.match(row.userId,/^bxagi:[a-f0-9]{64}$/);assert.equal(f.env.DB.sqlite.prepare('SELECT userId FROM bxagiAccounts WHERE subject = ?').get(row.subject).userId,row.userId);assert.equal(row.subject,'verified-bxagi-id');assert.match(row.id,/^[a-f0-9]{64}$/);assert.notEqual(row.id,opaque);assert.ok(row.tokenCiphertext);assert.ok(!JSON.stringify(row).includes(TOKEN));assert.ok(!JSON.stringify(row).includes(PASSWORD));assert.ok(Date.parse(row.expiresAt)-Date.now()<=7*24*60*60*1000);
  const context=await resolveBxagiContext(request('status',{cookie:result.cookiePair}),f.env,{fetcher:f.fetcher,required:true});assert.equal(context.accessToken,TOKEN);assert.equal(context.userId,row.userId);assert.equal(context.nativeUserId,context.userId);assert.equal(context.subject,'verified-bxagi-id');
});
test('registered BXAGI accounts log in without hosting identity or a repeated terms flag',async()=>{
  const f=fixture();assert.equal((await call(f,'status')).data.connected,false);await assert.rejects(resolveBxagiContext(request('status'),f.env,{fetcher:f.fetcher,required:true}),e=>e.status===401&&e.code==='bxagi_login_required');
  assert.equal((await call(f,'login',{method:'POST',body:{}})).status,400);assert.equal(f.state.calls.length,0);
  delete f.env.APP_ENCRYPTION_KEY;assert.equal((await call(f,'login',{method:'POST',body:{login:'alice',login_type:'username',password:PASSWORD}})).status,503);assert.equal(f.state.calls.length,0);
  f.env.APP_ENCRYPTION_KEY='57'.repeat(32);assert.equal((await login(f)).data.connected,true);
});
test('forged hosting headers cannot select a tenant and verified subjects remain distinct despite matching emails',async()=>{
  const f=fixture(),a=await login(f),first=await resolveBxagiContext(request('status',{cookie:a.cookiePair,user:'forged-other-owner'}),f.env,{fetcher:f.fetcher,required:true});
  assert.match(first.userId,/^bxagi:/);assert.notEqual(first.userId,'forged-other-owner');
  assert.equal((await call(f,'status',{user:first.userId})).data.connected,false);
  f.state.user={...f.state.user,id:'verified-second-subject'};const b=await login(f,{user:first.userId});const second=await resolveBxagiContext(request('status',{cookie:b.cookiePair,user:first.userId}),f.env,{fetcher:f.fetcher,required:true});
  assert.notEqual(second.userId,first.userId);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiAccounts').get().n,2);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,2);
});
test('status uses a short cache while business/service contexts revalidate stable upstream identity',async()=>{
  const f=fixture(),session=await login(f);const initial=f.state.calls.length;assert.equal((await call(f,'status',{cookie:session.cookiePair})).data.connected,true);assert.equal(f.state.calls.length,initial);
  const owner=f.env.DB.sqlite.prepare('SELECT userId FROM bxagiAccounts').get().userId;const service=await resolveBxagiContextForUser(owner,f.env,{fetcher:f.fetcher,required:true});assert.equal(service.userId,owner);assert.equal(service.nativeUserId,owner);assert.equal(service.subject,'verified-bxagi-id');assert.equal(f.state.calls.length,initial+1);
  f.env.DB.sqlite.prepare('UPDATE bxagiSessions SET lastValidatedAt = ?').run('2020-01-01T00:00:00Z');assert.equal((await call(f,'status',{cookie:session.cookiePair})).status,200);assert.equal(f.state.calls.length,initial+2);
  assert.equal(await resolveBxagiContextForUser('unknown-native',f.env,{fetcher:f.fetcher,required:false}),null);
});
test('401 or changed upstream subject invalidates the owned session; temporary service failure never falls back',async()=>{
  const f=fixture(),session=await login(f);f.env.DB.sqlite.prepare('UPDATE bxagiSessions SET lastValidatedAt = ?').run('2020-01-01T00:00:00Z');f.state.meStatus=503;const outage=await call(f,'status',{cookie:session.cookiePair});assert.equal(outage.status,503);assert.equal(outage.cookie,null);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,1);assert.ok(!JSON.stringify(outage.data).includes(TOKEN));
  f.state.meStatus=401;const expired=await call(f,'status',{cookie:session.cookiePair});assert.equal(expired.status,401);assert.equal(expired.data.invalidated,true);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);assert.match(expired.cookie,/Max-Age=0/);
  f.state.meStatus=200;const changed=await login(f);f.state.user.id='different-upstream-account';await assert.rejects(resolveBxagiContext(request('status',{cookie:changed.cookiePair}),f.env,{fetcher:f.fetcher,required:true}),e=>e.status===401&&e.code==='bxagi_identity_changed');assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);
});
test('unverified JWT claims shorten TTL only and never supply identity; local expiry deletes the session',async()=>{
  const f=fixture();f.state.token=`header.${Buffer.from(JSON.stringify({sub:'forged-user',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;const session=await login(f);assert.equal(session.data.profile.id,'verified-bxagi-id');const row=f.env.DB.sqlite.prepare('SELECT * FROM bxagiSessions').get();assert.ok(Date.parse(row.expiresAt)-Date.now()<=3600*1000);
  f.env.DB.sqlite.prepare('UPDATE bxagiSessions SET expiresAt = ?').run('2020-01-01T00:00:00Z');const expired=await call(f,'status',{cookie:session.cookiePair});assert.equal(expired.status,401);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);
});
test('switching this browser replaces only its prior opaque session and does not merge account workspaces',async()=>{
  const f=fixture(),first=await login(f),anotherBrowser=await login(f);const firstOwner=f.env.DB.sqlite.prepare('SELECT userId FROM bxagiAccounts').get().userId;
  f.state.user={...f.state.user,id:'second-bxagi-account'};const switched=await login(f,{cookie:first.cookiePair});
  assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions WHERE userId = ?').get(firstOwner).n,1);assert.equal((await call(f,'status',{cookie:first.cookiePair})).status,401);
  assert.equal((await call(f,'status',{cookie:anotherBrowser.cookiePair})).data.profile.id,'verified-bxagi-id');assert.equal((await call(f,'status',{cookie:switched.cookiePair})).data.profile.id,'second-bxagi-account');
  assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiAccounts').get().n,2);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiLegacyBindings WHERE userId = ?').get(firstOwner).n,1);
});
async function legacySession(f,owner='opaque-legacy-owner'){
  const logged=await login(f),row=f.env.DB.sqlite.prepare('SELECT * FROM bxagiSessions').get();
  f.env.DB.sqlite.prepare('DELETE FROM bxagiAccounts').run();f.env.DB.sqlite.prepare('UPDATE bxagiSessions SET userId = ? WHERE id = ?').run(owner,row.id);
  return {...logged,owner,row:{...row,userId:owner}};
}
test('a legacy cookie and a new browser preserve the sole verified subject workspace without a hosting identity',async()=>{
  const f=fixture(),old=await legacySession(f),repo=createPlatformRepository(f.env.DB),project=await repo.createProject(old.owner,{title:'保留原有工作区'}),calls=f.state.calls.length;
  const context=await resolveBxagiContext(request('status',{cookie:old.cookiePair,user:'forged-new-owner'}),f.env,{fetcher:f.fetcher});assert.equal(context.userId,old.owner);assert.equal(f.state.calls.length,calls+1);assert.equal(f.env.DB.sqlite.prepare('SELECT source FROM bxagiAccounts').get().source,'legacy_session');
  const fresh=await login(f,{user:'unrelated-hosting-user'}),second=await resolveBxagiContext(request('status',{cookie:fresh.cookiePair}),f.env,{fetcher:f.fetcher,required:true});assert.equal(second.userId,old.owner);assert.equal((await repo.getProject(second.userId,project.id)).id,project.id);assert.equal(await repo.getProject('forged-new-owner',project.id),null);
});
test('logout and expired legacy sessions keep identity ledger evidence for the next verified login',async()=>{
  for(const action of ['logout','expiry']){
    const f=fixture(),old=await legacySession(f);
    if(action==='logout')assert.equal((await call(f,'logout',{method:'POST',cookie:old.cookiePair,body:{}})).status,200);
    else {f.env.DB.sqlite.prepare('UPDATE bxagiSessions SET expiresAt = ?').run('2020-01-01T00:00:00Z');assert.equal((await call(f,'status',{cookie:old.cookiePair})).status,401);}
    assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);assert.equal(f.env.DB.sqlite.prepare('SELECT userId FROM bxagiLegacyBindings').get().userId,old.owner);
    await login(f);assert.equal(f.env.DB.sqlite.prepare('SELECT userId FROM bxagiAccounts').get().userId,old.owner);
  }
});
test('ambiguous legacy owners are rejected after official verification and cannot be chosen by forged headers or body IDs',async()=>{
  const f=fixture(),old=await legacySession(f),now=new Date().toISOString();f.env.DB.sqlite.prepare('INSERT INTO bxagiLegacyBindings (subject,userId,createdAt) VALUES (?,?,?)').run(old.row.subject,'second-old-workspace',now);
  const attempted=await call(f,'login',{user:old.owner,method:'POST',body:{login:'alice',login_type:'username',password:PASSWORD,userId:old.owner}});assert.equal(attempted.status,409);assert.equal(attempted.data.error.code,'bxagi_legacy_conflict');assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiAccounts').get().n,0);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,1);
  await assert.rejects(resolveBxagiContext(request('status',{cookie:old.cookiePair,user:old.owner}),f.env,{fetcher:f.fetcher}),e=>e.status===409&&e.code==='bxagi_legacy_conflict');assert.ok(!JSON.stringify(attempted.data).includes(TOKEN));
});
test('a second verified subject cannot claim a legacy workspace already mapped to another account',async()=>{
  const f=fixture(),old=await legacySession(f);await resolveBxagiContext(request('status',{cookie:old.cookiePair}),f.env,{fetcher:f.fetcher});
  f.env.DB.sqlite.prepare('INSERT INTO bxagiLegacyBindings (subject,userId,createdAt) VALUES (?,?,?)').run('second-subject',old.owner,new Date().toISOString());f.state.user.id='second-subject';
  const result=await call(f,'login',{method:'POST',body:{login:'bob',login_type:'username',password:PASSWORD}});assert.equal(result.status,409);assert.equal(result.data.error.code,'bxagi_account_conflict');assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiAccounts').get().n,1);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,1);
});
test('concurrent verified account mapping selects one stable owner and a mismatched stored cookie fails its identity fence',async()=>{
  const f=fixture(),accounts=createBxagiAccountRepository(f.env.DB),results=await Promise.all([accounts.resolveVerifiedSubject('concurrent-subject'),accounts.resolveVerifiedSubject('concurrent-subject')]);assert.equal(results[0].userId,results[1].userId);assert.match(results[0].userId,/^bxagi:[a-f0-9]{64}$/);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiAccounts').get().n,1);
  const session=await login(f);f.env.DB.sqlite.prepare('UPDATE bxagiSessions SET userId = ? WHERE subject = ?').run('tampered-owner','verified-bxagi-id');await assert.rejects(resolveBxagiContext(request('status',{cookie:session.cookiePair,user:'tampered-owner'}),f.env,{fetcher:f.fetcher}),e=>e.status===401&&e.code==='bxagi_identity_changed');
});
test('logout removes only server session, clears cookie and uses no undocumented upstream endpoints',async()=>{
  const f=fixture(),session=await login(f),calls=f.state.calls.length;const result=await call(f,'logout',{method:'POST',cookie:session.cookiePair,body:{}});assert.equal(result.status,200);assert.equal(result.data.connected,false);assert.equal(f.state.calls.length,calls);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);assert.match(result.cookie,/Max-Age=0/);
});
test('embedded session set and clear cookies preserve CHIPS attributes while cross-origin authenticated actions stay blocked',async()=>{
  const f=fixture(),session=await login(f,{headers:{Origin:'https://app.test','Sec-Fetch-Site':'same-origin'}});const before=f.state.calls.length;
  for(const headers of [{Origin:'https://outside.test'},{'Sec-Fetch-Site':'cross-site'}]){const blocked=await call(f,'logout',{method:'POST',body:{},cookie:session.cookiePair,headers});assert.equal(blocked.status,403);}
  assert.equal(f.state.calls.length,before);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,1);
  const cleared=await call(f,'logout',{method:'POST',body:{},cookie:session.cookiePair,headers:{Origin:'https://app.test','Sec-Fetch-Site':'same-origin'}});
  for(const cookie of [session.cookie,cleared.cookie]){assert.ok(cookie.startsWith(`${BXAGI_SESSION_COOKIE}=`));assert.match(cookie,/Path=\//);assert.match(cookie,/Secure; HttpOnly; SameSite=None; Partitioned/);assert.ok(!cookie.includes('Domain='));}
  assert.match(cleared.cookie,/Max-Age=0/);assert.equal(cleared.status,200);
});
test('cross-site auth actions are rejected and upstream identity without stable id cannot create a session',async()=>{
  const f=fixture();assert.equal((await call(f,'login',{method:'POST',body:{},headers:{Origin:'https://outside.test'}})).status,403);assert.equal(f.state.calls.length,0);f.state.user={email:'same@example.test'};const invalid=await call(f,'login',{method:'POST',body:{login:'alice',login_type:'username',password:PASSWORD}});assert.equal(invalid.status,503);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);
});
test('slow provider response bodies are bounded by the same timeout as headers',async()=>{
  const f=fixture();f.env.APP_BXAGI_TIMEOUT_MS=1000;let cancelled=false;f.fetcher=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"access_token":'));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}});const before=Date.now();const result=await call(f,'login',{method:'POST',body:{login:'alice',login_type:'username',password:PASSWORD}});assert.equal(result.status,503);assert.equal(result.data.error.code,'bxagi_upstream_unavailable');assert.equal(cancelled,true);assert.ok(Date.now()-before<3000);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);
});
test('all authentication redirects are rejected and cancelled without sending credentials to their location',async()=>{
  const f=fixture();
  for(const redirectStage of ['login','me']){
    let attempts=0,cancelled=false;
    const fetcher=async(url,init)=>{attempts++;assert.equal(init.redirect,'manual');if(redirectStage==='me'&&url.endsWith('/login'))return Response.json({access_token:TOKEN});return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('redirect'));},cancel(){cancelled=true;}}),{status:307,headers:{Location:'https://outside.test/never-follow'}});};
    const result=await handleBxagiAuthRequest(request('login',{method:'POST',body:{login:'fixture',login_type:'username',password:PASSWORD}}),f.env,{fetcher});assert.equal(result.status,503);assert.equal((await result.json()).error.code,'bxagi_redirect_refused');assert.equal(attempts,redirectStage==='login'?1:2);assert.equal(cancelled,true);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);
  }
});
test('connection probe only performs the observed anonymous config GET and excludes upstream extra fields',async()=>{
  let calls=0;const result=await probeBxagiConnection({fetcher:async(url,init)=>{calls++;assert.equal(url,`${BXAGI_ORIGIN}/api/auth/config`);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.ok(!Object.hasOwn(init.headers,'Authorization'));assert.ok(!Object.hasOwn(init,'body'));return Response.json({auth_required:true,access_token:TOKEN,password:PASSWORD});}});
  assert.equal(calls,1);assert.equal(result.reachable,true);assert.equal(result.authRequired,true);assert.deepEqual(Object.keys(result).sort(),['authRequired','checkedAt','reachable']);assert.ok(!JSON.stringify(result).includes(TOKEN));assert.ok(!JSON.stringify(result).includes(PASSWORD));
  const failed=await probeBxagiConnection({fetcher:async()=>Response.json({detail:'do not expose '+TOKEN},{status:503})});assert.equal(failed.reachable,false);assert.equal(failed.error.code,'bxagi_upstream_unavailable');assert.ok(!JSON.stringify(failed).includes(TOKEN));
});
function mediaBucket(){const values=new Map();return {async put(key,stream){const bytes=new Uint8Array(await new Response(stream).arrayBuffer());values.set(key,bytes);return {size:bytes.length};},async get(key){const bytes=values.get(key);return bytes?{size:bytes.length,body:new Blob([bytes]).stream(),async arrayBuffer(){return bytes.slice().buffer;}}:null;},async delete(key){values.delete(key);}};}
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6XAAAAABJRU5ErkJggg==','base64'));
const employee={id:'bxagi:market:official-employee',providerId:'official-employee',provider:'bxagi',marketId:'official-employee',resourceType:'installed_employee',marketVerified:true,activationState:'ready',sourceVerified:true,installed:true,name:'商品素材与广告运营员工',description:'服装电商素材创意与广告投放',skills:['图片设计','广告运营'],usable:true};
async function platform(f,path,{user=null,method='GET',body,bytes,cookie,headers={},workforce={async listEmployees(){return [employee];}},adsService}={}){const h=new Headers(headers);if(user)h.set('oai-authenticated-user-id',user);if(body!==undefined)h.set('Content-Type','application/json');if(cookie)h.set('Cookie',cookie);const r=await handlePlatformRequest(new Request(`https://app.test/api/v2${path}`,{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:bytes?{body:bytes}:{})}),f.env,{fetcher:f.fetcher,bxagiWorkforce:workforce,...(adsService?{adsService}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('Set-Cookie')};}
test('BXAGI-only mode protects records, exposes actual employee catalog and queues production instead of local rendering',async()=>{
  const f=fixture();f.env.BXAGI_REQUIRED='true';f.env.BUCKET=mediaBucket();
  assert.equal((await platform(f,'/bootstrap')).status,401);assert.equal((await platform(f,'/projects',{user:'forged-owner',method:'POST',body:{title:'不能伪造身份'}})).status,401);
  const logged=await platform(f,'/bxagi/auth/login',{method:'POST',body:{login:'alice',login_type:'username',password:PASSWORD}});assert.equal(logged.status,200);const cookie=logged.cookie.split(';')[0],owner=f.env.DB.sqlite.prepare('SELECT userId FROM bxagiAccounts').get().userId;
  const created=await platform(f,'/projects',{method:'POST',body:{title:'衣服推广',facts:['纯棉面料']},cookie});assert.equal(created.status,201);const p=created.data.project;assert.equal(p.userId,owner);assert.equal(p.productionEmployeeId,'');assert.equal(p.sourceState.status,'empty');
  const uploaded=await platform(f,`/projects/${p.id}/assets`,{method:'POST',bytes:png,cookie,headers:{'Content-Type':'image/png','Content-Length':String(png.length)}});assert.equal(uploaded.status,201);assert.equal(uploaded.data.job,null);assert.equal((await platform(f,`/projects/${p.id}/plan`,{method:'POST',body:{}})).status,401);
  const bootstrap=await platform(f,'/bootstrap',{cookie});assert.equal(bootstrap.status,200);assert.equal(bootstrap.data.bxagi.connected,true);assert.deepEqual(bootstrap.data.employees.map(e=>e.id),[employee.id]);assert.equal(bootstrap.data.capabilities.productionEngine,'bxagi');assert.ok(!JSON.stringify(bootstrap.data).includes(TOKEN));assert.ok(!JSON.stringify(bootstrap.data).includes('tokenCiphertext'));
  const planned=await platform(f,`/projects/${p.id}/production`,{method:'POST',body:{productionSpec:{targetCount:1,mediaType:'image',format:'square',employeeMode:'auto'}},cookie});assert.equal(planned.status,200,JSON.stringify(planned.data));assert.equal(planned.data.provider,'bxagi');assert.equal(planned.data.queued,true);assert.deepEqual(planned.data.variants,[]);assert.equal(planned.data.job.status,'queued');assert.equal(planned.data.assignment.productionEmployeeId,employee.id);
  const repo=createPlatformRepository(f.env.DB);assert.equal((await repo.listCreatives(owner)).length,0);assert.equal(await repo.getJob('foreign-owner',planned.data.job.id),null);
  const ownWithForgedHeader=await platform(f,`/bxagi/jobs/${planned.data.job.id}/sync`,{user:'forged-owner',method:'POST',body:{},cookie,workforce:{async listEmployees(){return [employee];},async startEmployee(){return {executionId:'fixture-execution'};}}});assert.notEqual(ownWithForgedHeader.status,404);
  const exported=await platform(f,`/projects/${p.id}/export`,{cookie});assert.ok(!JSON.stringify(exported.data).includes(TOKEN));assert.ok(!JSON.stringify(exported.data).includes(PASSWORD));
});
test('BXAGI identity outage fails closed without deleting records or falling back to a hosting header',async()=>{
  const f=fixture();f.env.BXAGI_REQUIRED=true;f.env.BUCKET=mediaBucket();const session=await login(f),owner=f.env.DB.sqlite.prepare('SELECT userId FROM bxagiAccounts').get().userId;
  const p=(await platform(f,'/projects',{method:'POST',body:{title:'原有素材项目'},cookie:session.cookiePair})).data.project;f.state.meStatus=503;
  const boot=await platform(f,'/bootstrap',{cookie:session.cookiePair,user:owner});assert.equal(boot.status,503);assert.equal((await platform(f,`/projects/${p.id}/plan`,{method:'POST',body:{},cookie:session.cookiePair})).status,503);
  assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,1);assert.equal((await createPlatformRepository(f.env.DB).getProject(owner,p.id)).id,p.id);
});
test('an authenticated catalog 401 invalidates its owner session instead of retaining a cached connected profile',async()=>{
  const f=fixture();f.env.BXAGI_REQUIRED=true;const session=await login(f);const workforce={async listEmployees(){throw Object.assign(new Error('BXAGI会话失效'),{status:401,code:'workforce_unauthorized'});}};
  const boot=await platform(f,'/bootstrap',{cookie:session.cookiePair,workforce});assert.equal(boot.status,401);assert.equal(boot.data.connected,false);assert.equal(boot.data.projects,undefined);assert.equal(boot.data.employees,undefined);assert.match(boot.cookie,/Max-Age=0/);assert.equal(f.env.DB.sqlite.prepare('SELECT count(*) n FROM bxagiSessions').get().n,0);
});
test('explicit launch in BXAGI mode authorizes own creatives and queues a buying employee without immediate paid API calls',async()=>{
  const f=fixture();f.env.BXAGI_REQUIRED=true;f.env.BUCKET=mediaBucket();const session=await login(f),cookie=session.cookiePair;const p=(await platform(f,'/projects',{method:'POST',body:{title:'服装广告'},cookie})).data.project;
  const c=(await platform(f,`/projects/${p.id}/creatives`,{method:'POST',bytes:png,cookie,headers:{'Content-Type':'image/png','Content-Length':String(png.length),'X-Creative-Metadata':encodeURIComponent(JSON.stringify({title:'真实成品',width:1,height:1,validation:'operator-reviewed'}))}})).data.creative;
  const campaign=(await platform(f,'/campaigns',{method:'POST',body:{projectId:p.id,creativeIds:[c.id],name:'投放计划',channel:'oceanengine',dailyBudget:100,totalBudget:1000,maxDailyBudget:200},cookie})).data.campaign;let paidCalls=0;const adsService={async launch(){paidCalls++;throw new Error('must not launch before employee result');},async pause(){paidCalls++;throw new Error('must not pause before employee result');}};
  const launch=await platform(f,`/campaigns/${campaign.id}/launch`,{method:'POST',body:{},cookie,adsService});assert.equal(launch.status,200,JSON.stringify(launch.data));assert.equal(launch.data.provider,'bxagi');assert.equal(launch.data.job.details.kind,'buying');assert.equal(launch.data.campaign.status,'draft');assert.equal(launch.data.campaign.remoteId,null);assert.equal(paidCalls,0);const owner=f.env.DB.sqlite.prepare('SELECT userId FROM bxagiAccounts').get().userId;assert.equal((await createPlatformRepository(f.env.DB).getCreative(owner,c.id)).status,'approved');
});
test('BXAGI production insert is atomic per owner project and job operation locks cannot recover uncertain writes',async()=>{
  const f=fixture(),repo=createPlatformRepository(f.env.DB),p=await repo.createProject('native-a',{title:'并发素材项目'});const payload={projectId:p.id,employeeId:employee.id,type:'bxagi_workflow',status:'queued',details:{provider:'bxagi',kind:'production',bxagiSubject:'verified-bxagi-id'}};
  const results=await Promise.all([repo.createBxagiProductionJob('native-a',payload),repo.createBxagiProductionJob('native-a',payload)]);assert.equal(results.filter(Boolean).length,1);const job=results.find(Boolean);await assert.rejects(repo.createBxagiProductionJob('native-b',payload),e=>e.status===404);assert.equal(await repo.claimBxagiJobOperation('native-b',job.id,'foreign'),null);
  assert.ok(await repo.claimBxagiJobOperation('native-a',job.id,'first'));assert.equal(await repo.claimBxagiJobOperation('native-a',job.id,'second'),null);await repo.updateJob('native-a',job.id,{details:{...job.details,operationId:'first',operationExpiresAt:'2020-01-01T00:00:00Z'}});assert.ok(await repo.claimBxagiJobOperation('native-a',job.id,'recovered'));await repo.updateJob('native-a',job.id,{details:{...job.details,operationId:'recovered',operationExpiresAt:'2020-01-01T00:00:00Z',remoteWritePending:'send_instruction'}});assert.equal(await repo.claimBxagiJobOperation('native-a',job.id,'must-not-recover'),null);
  await repo.releaseBxagiJobOperation('native-b',job.id,'recovered');assert.equal((await repo.getJob('native-a',job.id)).details.operationId,'recovered');assert.deepEqual(await repo.listDueBxagiJobs(100),[]);
});
test('background synchronization cannot dispatch an expired temporary flow-test job',async()=>{
  const f=fixture(),repo=createPlatformRepository(f.env.DB),owner='expiry-test-owner';
  const project=await repo.createProject(owner,{title:'限定流程测试'});
  const job=await repo.createBxagiProductionJob(owner,{projectId:project.id,employeeId:employee.id,details:{bxagiSubject:'verified-bxagi-id',flowTestRunId:'fixed-test-run',flowTestExpiresAt:new Date(Date.now()-1000).toISOString()}});
  assert.deepEqual(await repo.listDueBxagiJobs(3),[]);
  await repo.updateJob(owner,job.id,{details:{...job.details,flowTestExpiresAt:new Date(Date.now()+60000).toISOString()}});
  assert.deepEqual((await repo.listDueBxagiJobs(3)).map(row=>row.id),[job.id]);
  await repo.updateJob(owner,job.id,{details:{provider:'bxagi',kind:'production',bxagiSubject:'verified-bxagi-id'}});
  assert.deepEqual((await repo.listDueBxagiJobs(3)).map(row=>row.id),[job.id]);
});
