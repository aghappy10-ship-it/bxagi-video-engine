import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Run the real component with deterministic hooks so delayed account-scoped
// responses and the initialization action can be checked without a browser.
const compiled=ts.transpileModule(readFileSync(new URL('../components/platform/employees.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
class ApiError extends Error {constructor(message,status){super(message);this.status=status;}}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const available={status:'available',reason:'butler_bootstrap_initialization_available',installed:false,conversationExists:false,ownershipVerified:false,freeBasis:'official_builtin',canInitialize:true,canRepair:false};
const ready={...available,status:'ready',reason:'butler_bootstrap_ready',installed:true,conversationExists:true,ownershipVerified:true,canInitialize:false};
const response=(readiness=available,extra={})=>({capabilities:{enabled:true},readiness,schedulingEnabled:true,dispatches:{returnedCount:1,limit:10},checkedAt:'2026-10-15T00:00:00.000Z',...extra});
function harness(request,{owner='alice'}={}){
  const slots=[],pendingEffects=[],calls=[];let cursor=0,changed=false,tree;
  const hooks={useState(initial){const n=cursor++;if(!slots[n])slots[n]={value:initial};return [slots[n].value,value=>{slots[n].value=typeof value==='function'?value(slots[n].value):value;changed=true;}];},useRef(initial){const n=cursor++;if(!slots[n])slots[n]={current:initial};return slots[n];},useEffect(effect,deps){const n=cursor++;if(!slots[n]||deps.some((value,index)=>value!==slots[n].deps[index])){slots[n]={deps};pendingEffects.push(effect);}}};
  const jsx=(type,props)=>({type,props});
  let refreshCount=0;
  const state={data:{bxagi:{connected:!!owner},user:{id:owner}},refresh:async()=>{refreshCount++;}};
  const module={exports:{}};
  vm.runInNewContext(compiled,{module,exports:module.exports,require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx,Fragment:'fragment'};
    if(name==='./api')return {ApiError,platformRequest:(path,options={})=>{calls.push({path,options});return request(path,options);}};
    if(name==='./ui')return {Panel:'section',Badge:'span',Button:'button'};
    if(['lucide-react','./remote-jobs.mjs','./remote-jobs','./market.mjs','./nodes'].includes(name))return {};
    throw Error('Unexpected component dependency: '+name);
  }});
  function render(){do{changed=false;cursor=0;tree=module.exports.ButlerPanel({state});while(pendingEffects.length)pendingEffects.shift()();}while(changed);return tree;}
  const nodes=(node=tree)=>!node||typeof node!=='object'?[]:Array.isArray(node)?node.flatMap(n=>nodes(n)):[node,...nodes(node.props?.children??null),...nodes(node.props?.action??null)];
  const content=(node=tree)=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(n=>content(n)).join(''):content(node.props?.children??null)+content(node.props?.action??null);
  const button=label=>nodes().find(node=>node.type==='button'&&content(node)===label);
  render();
  return {render,calls,content,button,state,refreshCount:()=>refreshCount,async click(label){const found=button(label);assert.ok(found,'button missing: '+label);assert.equal(!!found.props.disabled,false,'button disabled: '+label);await found.props.onClick();render();}};
}

test('butler status is checked manually and logged-out users have no initialization action',()=>{
  const h=harness(()=>{throw Error('unexpected request');},{owner:''});
  assert.equal(h.calls.length,0);assert.equal(h.button('检查状态').props.disabled,true);assert.equal(h.button('启用免费大管家'),undefined);assert.match(h.content(),/登录后检查/);
});

test('feature and scheduling switches alone never label the butler ready',async()=>{
  const h=harness(async()=>response({...available,status:'blocked',canInitialize:false,reason:'butler_bootstrap_root_mismatch'}));
  await h.click('检查状态');assert.match(h.content(),/平台调度已开启/);assert.match(h.content(),/主会话归属尚未核实/);assert.doesNotMatch(h.content(),/大管家可用|已验收|仅供查看/);assert.equal(h.button('启用免费大管家'),undefined);
});

test('free initialization requires explicit availability and free authority, including missing-main repair',async()=>{
  for(const [readiness,allowed] of [[available,true],[{...available,canInitialize:false,canRepair:true,reason:'butler_bootstrap_repair_available'},true],[{...available,canInitialize:undefined},false],[{...available,freeBasis:null},false],[{...available,status:'blocked'},false]]){
    const h=harness(async()=>response(readiness));await h.click('检查状态');assert.equal(!!h.button('启用免费大管家'),allowed);
  }
});

test('initialization sends one empty POST then rereads verified state instead of treating a receipt as success',async()=>{
  let initialized=false;
  const h=harness(async(path,options)=>{
    if(path.endsWith('/initialize')){assert.equal(options.method,'POST');assert.equal(options.body,undefined);initialized=true;return {bootstrap:{status:'waiting',reason:'butler_bootstrap_verification_pending'},checkedAt:'2026-10-15T00:00:00Z'};}
    return response(initialized?ready:available);
  });
  await h.click('检查状态');await h.click('启用免费大管家');
  assert.deepEqual(h.calls.map(c=>c.path),['/bxagi/butler/state','/bxagi/butler/initialize','/bxagi/butler/state']);assert.match(h.content(),/大管家可用/);assert.equal(h.button('启用免费大管家'),undefined);assert.doesNotMatch(h.content(),/任务成功|已验收/);
});

test('an uncertain initialization stays check-only and never retries on state refresh',async()=>{
  const h=harness(async path=>path.endsWith('/initialize')?{bootstrap:{status:'needs_reconciliation',reason:'butler_bootstrap_result_unconfirmed'}}:response());
  await h.click('检查状态');await h.click('启用免费大管家');await h.click('检查状态');
  assert.equal(h.calls.filter(c=>c.path.endsWith('/initialize')).length,1);assert.equal(h.button('启用免费大管家'),undefined);assert.match(h.content(),/不会重复提交/);
});

test('responses from the previous account cannot restore readiness or refresh the new account session',async()=>{
  const old=deferred();let n=0;
  const h=harness(async()=>++n===1?old.promise:response({...available,status:'blocked',canInitialize:false,reason:'butler_bootstrap_online_node_required'}));
  const checking=h.button('检查状态').props.onClick();h.render();
  h.state.data.user.id='bob';h.render();await h.click('检查状态');
  old.reject(new ApiError('old session expired',401));await checking;h.render();
  assert.equal(h.refreshCount(),0);assert.match(h.content(),/在线执行节点/);assert.doesNotMatch(h.content(),/登录已失效|大管家可用/);
});

test('account changes during initialization prevent a follow-up request with the new identity',async()=>{
  const old=deferred();
  const h=harness(async path=>path.endsWith('/initialize')?old.promise:response());
  await h.click('检查状态');const initializing=h.button('启用免费大管家').props.onClick();h.render();
  h.state.data.user.id='bob';h.render();old.resolve({bootstrap:ready});await initializing;h.render();
  assert.equal(h.calls.length,2);assert.match(h.content(),/尚未检查/);assert.equal(h.button('启用免费大管家'),undefined);
});

test('a current 401 clears readiness and refreshes the BXAGI session',async()=>{
  const h=harness(async()=>{throw new ApiError('expired',401);});await h.click('检查状态');
  assert.equal(h.refreshCount(),1);assert.match(h.content(),/BXAGI 登录已失效/);assert.equal(h.button('启用免费大管家'),undefined);
});


test('a bootstrap ready receipt cannot override a later failed readiness check',async()=>{
  let initialized=false;
  const h=harness(async path=>{if(path.endsWith('/initialize')){initialized=true;return {bootstrap:ready};}return response(initialized?{...available,status:'blocked',reason:'butler_bootstrap_root_mismatch',canInitialize:false}:available);});
  await h.click('检查状态');await h.click('启用免费大管家');
  assert.match(h.content(),/主会话归属尚未核实/);assert.doesNotMatch(h.content(),/大管家可用|可以接收调度请求/);
});


test('verified built-in reflection is disclosed without claiming execution or changing initialization authority',async()=>{
  for(const flag of [true,false,undefined]){
    const h=harness(async()=>response({...available,standardBuiltinReflection:flag}));await h.click('检查状态');
    assert.equal(h.content().includes('包含 BXAGI 内置的每周工作复盘与记忆维护'),flag===true);
    assert.equal(!!h.button('启用免费大管家'),true);assert.doesNotMatch(h.content(),/周报已执行|复盘已完成|记忆已维护/);
  }
  const blocked=harness(async()=>response({...available,canInitialize:false,standardBuiltinReflection:true}));await blocked.click('检查状态');assert.equal(blocked.button('启用免费大管家'),undefined);
});


test('confirmed offline nodes explain the recovery step without offering initialization or success',async()=>{
  const waiting={...available,status:'waiting',reason:'butler_bootstrap_online_node_required',canInitialize:false,ownedOnlineNodeCount:0,ownedNodeStatusCounts:{online:0,busy:0,offline:1,other:0},standardBuiltinReflection:true};
  const h=harness(async()=>response(waiting));await h.click('检查状态');
  assert.match(h.content(),/BXAGI 执行节点当前离线，请在 BXAGI 恢复节点连接后重新检查。/);assert.equal(h.button('检查状态').props.disabled,false);assert.equal(h.button('启用免费大管家'),undefined);assert.doesNotMatch(h.content(),/大管家可用|可以接收调度请求|任务成功/);
  for(const counts of [{online:0,busy:1,offline:1,other:0},{online:0,busy:0,offline:0,other:0},undefined]){
    const pending=harness(async()=>response({...waiting,ownedNodeStatusCounts:counts}));await pending.click('检查状态');assert.doesNotMatch(pending.content(),/当前离线/);assert.match(pending.content(),/可用的在线执行节点/);assert.equal(pending.button('启用免费大管家'),undefined);
  }
});
