import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync,readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

// Actual auth code runs under workerd. Its external transport is intercepted
// only to send synthetic credentials to this local fixture, never to BXAGI.
const root=fileURLToPath(new URL('../',import.meta.url));
const TOKEN='edge-fixture-token-not-a-real-account';
const PASSWORD='edge-fixture-password-not-a-real-account';
const bundle=await build({stdin:{contents:"import {handleBxagiAuthRequest,probeBxagiConnection} from './server/bxagi-auth.mjs'; export default {async fetch(request,env){if(new URL(request.url).pathname==='/probe')return Response.json(await probeBxagiConnection({env}));return handleBxagiAuthRequest(request,env);}};",resolveDir:root,sourcefile:'edge-auth-fixture.mjs'},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',logLevel:'silent'});

async function harness(){
  const state={redirectStage:null,paths:[],targetHits:0,loginFieldsValid:false,meBearerValid:false};
  const server=createServer(async(request,response)=>{
    state.paths.push(request.url);
    if(request.url==='/api/auth/login'){
      const parts=[];for await(const part of request)parts.push(part);const payload=JSON.parse(Buffer.concat(parts).toString());
      state.loginFieldsValid=payload.login==='fixture-user'&&payload.login_type==='username'&&payload.password===PASSWORD&&typeof payload.device_id==='string';
      if(state.redirectStage==='login'){response.writeHead(307,{Location:'https://outside.invalid/must-not-receive-login'});response.end('redirect');return;}
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({access_token:TOKEN,user:{id:'unused-login-identity'}}));return;
    }
    if(request.url==='/api/auth/me'){
      state.meBearerValid=request.headers.authorization===`Bearer ${TOKEN}`;
      if(state.redirectStage==='me'){response.writeHead(302,{Location:'https://outside.invalid/must-not-receive-token'});response.end('redirect');return;}
      response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({id:'verified-edge-subject',username:'fixture-user'}));return;
    }
    if(request.url==='/api/auth/config'){response.writeHead(200,{'Content-Type':'application/json'});response.end('{"auth_required":true}');return;}
    state.targetHits++;response.writeHead(500);response.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');const local=`http://127.0.0.1:${server.address().port}`;
  const mf=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],bindings:{APP_ENCRYPTION_KEY:'57'.repeat(32)},
    outboundService:async request=>{
      const url=new URL(request.url);assert.equal(url.origin,'https://bxagi.xinlx.com');
      const method=request.method;const result=await fetch(local+url.pathname,{method,headers:request.headers,...(method==='GET'?{}:{body:await request.arrayBuffer()}),redirect:'manual'});
      return new Response(result.body,{status:result.status,headers:result.headers});
    },
  });
  const bindings=await mf.getBindings(),dir=new URL('../drizzle/',import.meta.url);
  for(const file of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync(new URL(file,dir),'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await bindings.DB.prepare(sql).run();
  const login=()=>mf.dispatchFetch('https://edge.test/api/v2/bxagi/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:'fixture-user',login_type:'username',password:PASSWORD})});
  return {mf,state,db:bindings.DB,login,async close(){await mf.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}

test('workerd executes actual login JSON, bearer identity verification and anonymous config probe without immediate fetch failure',{timeout:30000},async()=>{
  const h=await harness();try{
    const response=await h.login();assert.equal(response.status,200);const data=await response.json();assert.equal(data.connected,true);assert.equal(data.profile.id,'verified-edge-subject');assert.ok(h.state.loginFieldsValid);assert.ok(h.state.meBearerValid);assert.deepEqual(h.state.paths,['/api/auth/login','/api/auth/me']);assert.ok(!JSON.stringify(data).includes(TOKEN));assert.ok(!JSON.stringify(data).includes(PASSWORD));assert.ok(response.headers.get('Set-Cookie')?.includes('Partitioned'));
    const stored=await h.db.prepare('SELECT userId,subject,tokenCiphertext FROM bxagiSessions').first();assert.match(stored.userId,/^bxagi:[a-f0-9]{64}$/);assert.equal((await h.db.prepare('SELECT userId FROM bxagiAccounts WHERE subject = ?').bind('verified-edge-subject').first()).userId,stored.userId);assert.equal(stored.subject,'verified-edge-subject');assert.ok(stored.tokenCiphertext&&!stored.tokenCiphertext.includes(TOKEN));
    const probe=await h.mf.dispatchFetch('https://edge.test/probe');const result=await probe.json();assert.equal(result.reachable,true);assert.equal(result.authRequired,true);assert.deepEqual(h.state.paths,['/api/auth/login','/api/auth/me','/api/auth/config']);assert.equal(h.state.targetHits,0);
  }finally{await h.close();}
});
test('workerd refuses login and bearer redirects without transmitting fixture credentials to another destination',{timeout:30000},async()=>{
  const h=await harness();try{
    for(const stage of ['login','me']){h.state.redirectStage=stage;h.state.paths=[];const response=await h.login();assert.equal(response.status,503);const data=await response.json();assert.equal(data.error.code,'bxagi_redirect_refused');assert.deepEqual(h.state.paths,stage==='login'?['/api/auth/login']:['/api/auth/login','/api/auth/me']);assert.equal(h.state.targetHits,0);assert.equal((await h.db.prepare('SELECT count(*) n FROM bxagiSessions').first()).n,0);}
  }finally{await h.close();}
});
