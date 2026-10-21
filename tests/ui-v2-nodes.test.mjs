import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { nodeConnectionLabel, nodeObservationLabel, nodeHistoryLabel } from '../components/platform/nodes.mjs';

test('node labels distinguish verified offline, gateway disconnect and failed observations',()=>{
  assert.equal(nodeConnectionLabel({status:'offline',gatewayConnected:false}),'节点离线');
  assert.equal(nodeConnectionLabel({status:'online',gatewayConnected:false}),'网关未连接');
  assert.equal(nodeConnectionLabel({status:'busy',gatewayConnected:true}),'节点忙碌');
  assert.equal(nodeConnectionLabel({status:'online',stale:true}),'上次记录 · 待重新核实');
  const snapshot={observationStatus:'verified',liveVerified:true,nodeCount:1,nodes:[{status:'offline'}]};
  assert.equal(nodeObservationLabel(snapshot),'等待节点恢复');
  assert.equal(nodeObservationLabel({...snapshot,observationStatus:'unavailable'}),'状态暂未读取');
  assert.equal(nodeObservationLabel({...snapshot,nodeCount:0,nodes:[]}),'尚无执行节点');
});

const compiled=ts.transpileModule(readFileSync(new URL('../components/platform/nodes.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(request) {
  const slots=[],effects=[],calls=[];let cursor=0,changed=false,tree;
  const hooks={useState(initial){const n=cursor++;if(!slots[n])slots[n]={value:initial};return [slots[n].value,value=>{slots[n].value=value;changed=true;}];},useRef(initial){const n=cursor++;if(!slots[n])slots[n]={current:initial};return slots[n];},useEffect(effect,deps){const n=cursor++;if(!slots[n]||deps.some((value,index)=>value!==slots[n].deps[index])){slots[n]={deps};effects.push(effect);}}};
  const jsx=(type,props)=>({type,props}),state={data:{user:{id:'alice'},bxagi:{connected:true}},refresh:async()=>{}};
  const module={exports:{}};
  vm.runInNewContext(compiled,{module,exports:module.exports,require(name){
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='./api')return {ApiError:Error,platformRequest:(path,options={})=>{calls.push({path,options});return request(path,options);}};
    if(name==='./ui')return {Panel:'section',Badge:'span',Button:'button'};
    if(name==='./types')return {dateLabel:value=>value||'—'};
    if(name==='./nodes.mjs')return {nodeConnectionLabel,nodeObservationLabel,nodeHistoryLabel};
    if(name==='lucide-react')return {};
    throw Error('Unexpected dependency '+name);
  }});
  const content=(node=tree)=>node==null||typeof node==='boolean'?'':typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(value=>content(value??null)).join(''):content(node.props?.children??null)+content(node.props?.action??null);
  function render(){do{changed=false;cursor=0;tree=module.exports.NodeHealthPanel({state});while(effects.length)effects.shift()();}while(changed);return tree;}
  render();return {state,calls,content,render,check:()=>tree.props.action.props.onClick()};
}
test('node inspection is read-only and an old account response never leaks into the new account',async()=>{
  let resolve;
  const response=new Promise(done=>{resolve=done;});
  const h=harness(()=>response);
  assert.equal(h.calls.length,0);
  const pending=h.check();h.render();h.state.data.user.id='bob';h.render();
  resolve({observationStatus:'verified',liveVerified:true,nodeCount:1,nodes:[{nodeId:'alice-private-node',status:'offline'}],checkedAt:'2026-10-15T00:00:00Z'});
  await pending;h.render();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].path,'/bxagi/nodes/state');assert.equal(h.calls[0].options.method,undefined);
  assert.doesNotMatch(h.content(),/alice-private-node|节点离线/);assert.match(h.content(),/尚未检查/);
});
test('unavailable inspection never presents cached online nodes as current health',async()=>{
  const h=harness(async()=>({observationStatus:'unavailable',liveVerified:false,nodeCount:1,nodes:[{nodeId:'cached-node',status:'online',gatewayConnected:true}],checkedAt:'2026-10-15T00:00:00Z'}));
  await h.check();h.render();assert.match(h.content(),/历史记录 · 待核实/);assert.match(h.content(),/本次未取得实时节点状态/);assert.doesNotMatch(h.content(),/节点在线/);
});


test('node history distinguishes first evidence from connection and heartbeat transitions',()=>{
  assert.equal(nodeHistoryLabel({kind:'node',from:null,to:{status:'offline'}}),'首次记录：节点离线');
  assert.match(nodeHistoryLabel({kind:'node',from:{status:'online',gatewayConnected:true,heartbeatState:'fresh'},to:{status:'offline',gatewayConnected:false,heartbeatState:'stale'}}),/节点在线 → 节点离线；心跳已超时/);
  assert.equal(nodeHistoryLabel({kind:'inspection',from:'verified',to:'unavailable'}),'节点状态读取暂不可用');
});
