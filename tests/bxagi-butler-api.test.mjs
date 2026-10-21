import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {handlePlatformRequest} from '../server/platform-api.mjs';
import {createPlatformRepository} from '../server/platform-repository.mjs';
import {BXAGI_SESSION_COOKIE} from '../server/bxagi-auth.mjs';

function fixture(){
  const sqlite=new DatabaseSync(':memory:'),directory=new URL('../drizzle/',import.meta.url);
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,directory),'utf8'));
  const DB={prepare(sql){const statement=sqlite.prepare(sql);return {bind(...args){return {async first(){return statement.get(...args)??null;},async all(){return {results:statement.all(...args)};},async run(){return {meta:{changes:Number(statement.run(...args).changes)}};}};}};}};
  const env={DB,APP_ENCRYPTION_KEY:'ab'.repeat(32),BXAGI_REQUIRED:true},calls=[],accounts=new Map([['alice',{subject:'bxagi-alice',token:'PRIVATE_AUTH_FIXTURE_ALICE'}],['bob',{subject:'bxagi-bob',token:'PRIVATE_AUTH_FIXTURE_BOB'}]]);
  const state={enabled:true,historyStatus:200,historySlow:false};
  const fetcher=async(url,options)=>{
    const parsed=new URL(url);assert.equal(parsed.origin,'https://bxagi.xinlx.com');calls.push({path:parsed.pathname,method:options.method,authorization:options.headers.Authorization});
    if(parsed.pathname==='/api/auth/login'){const body=JSON.parse(options.body),account=accounts.get(body.login);assert.ok(account);return Response.json({access_token:account.token});}
    const account=[...accounts.values()].find(row=>options.headers.Authorization===`Bearer ${row.token}`);assert.ok(account);
    if(parsed.pathname==='/api/auth/me')return Response.json({id:account.subject,username:account.subject});
    assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.redirect,'manual');
    if(parsed.pathname==='/api/v1/feature-flags')return Response.json({butler_mode:state.enabled,general_mode:true,session_api_key:account.token});
    if(parsed.pathname==='/api/v1/employees/templates')return Response.json([{id:'general_assistant',name:'通用助理',has_subs:false}]);
    if(parsed.pathname==='/api/v1/employees/mine')return Response.json({items:[]});
    if(parsed.pathname==='/api/nodes')return Response.json({nodes:[{node_id:'owned-node',status:'online',gateway_connected:true}]});
    if(parsed.pathname==='/api/v1/employees/templates/general_assistant/schedules')return Response.json([]);
    if(parsed.pathname==='/locales/zh-CN/translation.json')return Response.json({'EMPLOYEE$BUILTIN_BADGE':'内置 · 免费 · 不占名额','GENERAL_CHAT$HIRE_BUTTON':'免费雇佣通用助理'});
    assert.equal(parsed.pathname,'/api/v1/butler/dispatches');assert.equal(parsed.searchParams.get('limit'),'10');assert.equal(parsed.searchParams.get('offset'),'0');assert.equal([...parsed.searchParams].length,2);
    if(state.historySlow)return new Response(new ReadableStream({cancel(){state.cancelled=true;}}));
    if(state.historyStatus!==200)return new Response(`private upstream ${account.token}`,{status:state.historyStatus});
    return Response.json({items:state.enabled?[{client_message_id:'dispatch-'+account.subject,conversation_id:'unverified-conversation',status:'completed',created_at:'2026-10-14T13:20:34Z',route:{employee_name:'视频优化专家',employee_id:'unverified-instance',session_api_key:account.token},text:account.token,ack_text:'private instruction text',error:'private error text',device_id:'private-device'}]:[],total:999,token:account.token});
  };
  const call=async(path='/bxagi/butler/state',{cookie,method='GET',body,headers={},injected={}}={})=>{
    const h=new Headers(headers);if(cookie)h.set('Cookie',cookie);if(body!==undefined)h.set('Content-Type','application/json');
    const response=await handlePlatformRequest(new Request('https://app.test/api/v2'+path,{method,headers:h,...(body!==undefined?{body:JSON.stringify(body)}:{})}),env,{fetcher,...injected});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0],allow:response.headers.get('Allow')};
  };
  const login=async login=>{const result=await call('/bxagi/auth/login',{method:'POST',body:{login,login_type:'username',password:'fixture-password',termsAccepted:true}});assert.equal(result.status,200,JSON.stringify(result.data));return result.cookie;};
  return {sqlite,env,calls,accounts,state,call,login,repository:createPlatformRepository(DB)};
}

test('official butler state requires the BXAGI cookie, refuses caller scope and offers no write method',async()=>{
  const f=fixture();try{
    for(const headers of [{},{'oai-authenticated-user-id':'forged-owner'},{Authorization:'Bearer private-worker-key'}])assert.equal((await f.call(undefined,{headers})).status,401);
    assert.equal(f.calls.length,0);
    const cookie=await f.login('alice');f.calls.length=0;
    const post=await f.call(undefined,{cookie,method:'POST',body:{userId:'bob',token:'caller-token'}});assert.equal(post.status,405);assert.equal(post.allow,'GET');
    for(const query of ['?userId=bob','?token=caller-token','?limit=100','?deviceId=other'])assert.equal((await f.call('/bxagi/butler/state'+query,{cookie})).status,400);
    assert.equal(f.calls.some(call=>call.path.startsWith('/api/v1/')),false);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n,0);
  }finally{f.sqlite.close();}
});

test('official enabled state and recent record count stay read-only, session-scoped and do not imply employee execution or production delivery',async()=>{
  const f=fixture();try{
    const alice=await f.login('alice'),bob=await f.login('bob'),owner=f.sqlite.prepare('SELECT userId FROM bxagiSessions WHERE subject=?').get('bxagi-alice').userId;
    const project=await f.repository.createProject(owner,{title:'ongoing actual video'}),job=await f.repository.createJob(owner,{projectId:project.id,employeeId:'market-editor',type:'bxagi_workflow',status:'running',details:{kind:'production',bxagiSubject:'bxagi-alice',messageSentAt:'2026-10-14T13:20:34Z',conversationId:'ongoing-video'}}),before=await f.repository.getJob(owner,job.id);
    for(const [cookie,subject] of [[alice,'bxagi-alice'],[bob,'bxagi-bob']]){
      f.calls.length=0;const response=await f.call(undefined,{cookie,headers:{Authorization:'Bearer CALLER_TOKEN','oai-authenticated-user-id':'forged-owner'}});
      assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.readOnly,true);assert.equal(response.data.capabilities.enabled,true);assert.equal(response.data.capabilities.mode,'official_butler');assert.equal(response.data.capabilities.dispatchEnabled,false);assert.equal(response.data.capabilities.planningOnlyApiVerified,false);assert.equal(response.data.capabilities.marketRoutingVerified,false);assert.equal(response.data.dispatchExecutionVerified,false);assert.equal(response.data.executionStatus,'unverified');assert.equal(response.data.dispatches.returnedCount,1);assert.equal(response.data.dispatches.limit,10);assert.equal(response.data.dispatches.offset,0);assert.equal(response.data.dispatches.items[0].clientMessageId,'dispatch-'+subject);assert.equal(response.data.dispatches.items[0].status,'completed');assert.equal(response.data.dispatches.deliveryVerified,false);assert.equal(response.data.dispatches.ownershipVerified,false);
      assert.equal(response.data.readiness.status,'available');assert.equal(response.data.readiness.ownershipVerified,false);assert.equal(response.data.schedulingEnabled,false);assert.equal(f.calls.filter(call=>call.path.startsWith('/api/v1/')).length,6);assert.equal(f.calls.filter(call=>call.path.startsWith('/api/v1/')).every(call=>call.authorization===`Bearer ${f.accounts.get(subject==='bxagi-alice'?'alice':'bob').token}`),true);
      for(const value of ['PRIVATE_AUTH_FIXTURE','CALLER_TOKEN','private instruction text','private error text','unverified-instance','private-device'])assert.equal(JSON.stringify(response.data).includes(value),false);
      assert.equal(response.data.dispatches.total,undefined);assert.deepEqual(await f.repository.getJob(owner,job.id),before);
    }
    f.state.enabled=false;const disabled=await f.call(undefined,{cookie:alice});assert.equal(disabled.status,200);assert.equal(disabled.data.capabilities.enabled,false);assert.equal(disabled.data.dispatches.returnedCount,0);assert.equal(disabled.data.dispatchExecutionVerified,false);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs WHERE type <> 'bxagi_node_health'").get().n,1);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM jobs WHERE type = 'bxagi_node_health'").get().n,2);
  }finally{f.sqlite.close();}
});

test('butler read failures expose no upstream body, preserve current jobs and follow session invalidation on 401',async()=>{
  for(const status of [500,403,401]){
    const f=fixture();try{
      const cookie=await f.login('alice');f.state.historyStatus=status;f.calls.length=0;
      const response=await f.call(undefined,{cookie});assert.equal(response.status,status===500?502:status);assert.equal(JSON.stringify(response.data).includes('PRIVATE_AUTH_FIXTURE'),false);assert.equal(JSON.stringify(response.data).includes('private upstream'),false);assert.equal(f.calls.filter(call=>call.path.startsWith('/api/v1/')).every(call=>call.method==='GET'),true);
      if(status===401){assert.equal(response.cookie,`${BXAGI_SESSION_COOKIE}=`);assert.equal((await f.call(undefined,{cookie})).status,401);}else assert.equal(response.cookie,undefined);
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n,0);
    }finally{f.sqlite.close();}
  }
});

test('butler state bounds a stalled history read without retries, scheduling or production state changes',async()=>{
  const f=fixture();try{
    const cookie=await f.login('alice');f.state.historySlow=true;f.calls.length=0;
    const response=await f.call(undefined,{cookie});assert.equal(response.status,502);assert.equal(response.data.error.code,'upstream_timeout');assert.equal(f.state.cancelled,true);assert.equal(f.calls.filter(call=>call.path.startsWith('/api/v1/')).length,2);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM jobs').get().n,0);assert.equal(response.cookie,undefined);
  }finally{f.sqlite.close();}
});


test('free initialization is BXAGI-account scoped, rejects input and cross-site writes, and never accepts caller identity',async()=>{
  const f=fixture();let called=0;try{
    const cookie=await f.login('alice');const injected={createButlerBootstrap:({context})=>({async ensure({authorizationExpiresAt}){called++;assert.equal(context.subject,'bxagi-alice');assert.ok(Date.parse(authorizationExpiresAt)>Date.now());return {status:'ready',templateId:'general_assistant',ownershipVerified:true};}})};
    assert.equal((await f.call('/bxagi/butler/initialize',{method:'POST',injected})).status,401);
    assert.equal((await f.call('/bxagi/butler/initialize',{cookie,method:'GET',injected})).status,405);
    for(const opts of [{body:{userId:'bob'}},{body:{}},{headers:{Origin:'https://other.test'}},{headers:{'Sec-Fetch-Site':'cross-site'}}])assert.ok([400,403].includes((await f.call('/bxagi/butler/initialize',{cookie,method:'POST',injected,...opts})).status));
    assert.equal((await f.call('/bxagi/butler/initialize?userId=bob',{cookie,method:'POST',injected})).status,400);assert.equal(called,0);
    const good=await f.call('/bxagi/butler/initialize',{cookie,method:'POST',headers:{Authorization:'Bearer forged'},injected});assert.equal(good.status,200);assert.equal(good.data.bootstrap.status,'ready');assert.equal(called,1);assert.equal(JSON.stringify(good).includes('PRIVATE_AUTH_FIXTURE'),false);
  }finally{f.sqlite.close();}
});
