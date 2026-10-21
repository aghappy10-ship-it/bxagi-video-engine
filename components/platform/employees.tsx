'use client';
import {useEffect,useRef,useState} from 'react';
import {Bot,ExternalLink,LogIn,RefreshCw,Search,Sparkles,Store} from 'lucide-react';
import {remoteErrorMessage} from './remote-jobs.mjs';
import {NodeHealthPanel} from './nodes';
import {RemoteJobCards} from './remote-jobs';
import {marketEntries,activationLabel,quoteText,listQuoteText,activationFeeNote,verifiedMarketSource,activationReasonText} from './market.mjs';
import {Badge,Button,Empty,Panel} from './ui';
import type {Row} from './types';
import type {PlatformState} from './use-platform';
import {ApiError,platformRequest} from './api';
const MARKET_URL='https://bxagi.xinlx.com/employee';
function text(value:unknown):string {if(value==null)return '';if(typeof value==='string'||typeof value==='number')return String(value);if(Array.isArray(value))return value.map(text).filter(Boolean).join('、');return '';}
function skills(entry:Row):string[]{return (Array.isArray(entry.skills)?entry.skills:[]).map(value=>typeof value==='string'?value:text(value?.name||value?.title||value?.label)).filter(Boolean);}
type ButlerReadiness={status:string;reason?:string;installed?:boolean;installationStatus?:string|null;conversationExists?:boolean|null;ownershipVerified?:boolean;freeBasis?:string|null;canInitialize?:boolean;canRepair?:boolean;standardBuiltinReflection?:boolean;ownedOnlineNodeCount?:number;ownedNodeStatusCounts?:{online:number;busy:number;offline:number;other:number}};
type ButlerState={capabilities:{enabled:boolean};readiness?:ButlerReadiness;schedulingEnabled?:boolean;dispatches:{returnedCount:number;limit:number};checkedAt:string};
type ButlerBootstrap={bootstrap:ButlerReadiness;checkedAt:string};
function butlerReason(readiness?:ButlerReadiness):string {
  const nodes=readiness?.ownedNodeStatusCounts;
  if(readiness?.reason==='butler_bootstrap_online_node_required'&&readiness.ownedOnlineNodeCount===0&&nodes?.online===0&&nodes.busy===0&&nodes.other===0&&nodes.offline>0)return 'BXAGI 执行节点当前离线，请在 BXAGI 恢复节点连接后重新检查。';
  const messages:Record<string,string>={
    butler_bootstrap_ready:'主会话与当前账号归属已核实，可以接收调度请求。',
    butler_bootstrap_initialization_available:'官方内置通用助理尚未启用，可免费初始化大管家。',
    butler_bootstrap_repair_available:'大管家主会话缺失，可通过免费初始化恢复。',
    butler_bootstrap_online_node_required:'当前账号需要可用的在线执行节点，请等待或恢复连接后重新检查。',
    butler_bootstrap_feature_disabled:'BXAGI 官方大管家功能尚未开启。',
    butler_bootstrap_renewal_not_authorized:'当前安装已过期，暂不能用于调度。',
    butler_bootstrap_payment_required:'当前条件涉及收费，无法免费初始化。',
    butler_bootstrap_free_contract_unverified:'尚未核实官方免费初始化条件。',
    butler_bootstrap_builtin_unverified:'尚未核实官方内置通用助理。',
    butler_bootstrap_verification_pending:'初始化已提交，等待核实主会话；可继续检查状态。',
    butler_bootstrap_result_unconfirmed:'初始化结果尚未核实；请检查状态，系统不会重复提交。',
    butler_bootstrap_runtime_unavailable:'大管家执行节点暂不可用，请恢复节点后检查状态。',
    butler_bootstrap_root_mismatch:'大管家主会话归属尚未核实。',
    butler_bootstrap_owned_node_required:'尚未找到当前账号对应的执行节点。',
    butler_readiness_unavailable:'大管家可用性暂未读取，请稍后检查。',
  };
  return messages[readiness?.reason||'']||(readiness?.status==='needs_reconciliation'?'初始化结果需要核实；系统不会重复提交。':readiness?.status==='waiting'?'大管家正在准备，请稍后检查状态。':readiness?'大管家当前不可用，具体条件尚待核实。':'');
}
export function ButlerPanel({state}:{state:PlatformState}){
  const [result,setResult]=useState<{owner:string;value:ButlerState}|null>(null),[busy,setBusy]=useState<'check'|'initialize'|null>(null),[error,setError]=useState('');
  const [initialization,setInitialization]=useState<{owner:string;value:ButlerReadiness}|null>(null);
  const revision=useRef(0),identity=useRef('');
  const owner=state.data.bxagi.connected?state.data.user.id:'';
  identity.current=owner;
  useEffect(()=>{revision.current++;setResult(null);setInitialization(null);setError('');setBusy(null);},[owner]);
  const current=result?.owner===owner?result.value:null;
  const initialized=initialization?.owner===owner?initialization.value:null;
  const readiness=current?.readiness;
  const ready=readiness?.status==='ready'&&readiness.installed===true&&readiness.conversationExists===true&&readiness.ownershipVerified===true;
  const canInitialize=!!owner&&!initialized&&readiness?.status==='available'&&readiness.freeBasis==='official_builtin'&&(readiness.canInitialize===true||readiness.canRepair===true);
  async function run(initialize=false){
    if(!owner||busy||(initialize&&!canInitialize))return;
    const requestRevision=++revision.current,requestOwner=owner;
    const isCurrent=()=>requestRevision===revision.current&&identity.current===requestOwner;
    setBusy(initialize?'initialize':'check');setError('');
    if(!initialize)setResult(null);
    try{
      if(initialize){
        // Keep the attempt visible even when a network response is lost; checking
        // status must never silently become another initialization request.
        setInitialization({owner:requestOwner,value:{status:'needs_reconciliation',reason:'butler_bootstrap_result_unconfirmed'}});
        const value=await platformRequest<ButlerBootstrap>('/bxagi/butler/initialize',{method:'POST'});
        if(!isCurrent())return;
        setInitialization({owner:requestOwner,value:value.bootstrap});
      }
      const value=await platformRequest<ButlerState>('/bxagi/butler/state');
      if(isCurrent())setResult({owner:requestOwner,value});
    }catch(reason){
      if(!isCurrent())return;
      if(reason instanceof ApiError&&reason.status===401){setResult(null);setError('BXAGI 登录已失效，请重新登录。');await state.refresh().catch(()=>{});}
      else setError(reason instanceof Error?reason.message:'大管家状态暂未读取，请稍后检查。');
    }finally{if(isCurrent())setBusy(null);}
  }
  const pendingInitialization=!ready&&initialized?.status!=='ready'?initialized:null;
  const availability=!current?owner?'尚未检查':'登录后检查':ready?'大管家可用':pendingInitialization?pendingInitialization.status==='blocked'?'初始化未完成':'初始化待核实':readiness?.status==='available'?'等待免费初始化':readiness?.status==='waiting'?'等待执行节点':'暂不可用';
  return <Panel title="BXAGI 大管家" subtitle="大管家选择市场岗位与生产步骤，员工执行并返回成品" action={<Button secondary busy={busy==='check'} disabled={!owner||!!busy} onClick={()=>run()}><RefreshCw size={15}/>{busy==='check'?'正在检查':'检查状态'}</Button>}>
    <div className="bx-inline-tags"><Badge tone={ready?'green':current?'amber':'neutral'}>{availability}</Badge>{current&&<><Badge tone={current.schedulingEnabled?'blue':'neutral'}>{current.schedulingEnabled?'平台调度已开启':'平台调度未开启'}</Badge><Badge>{current.capabilities.enabled?'官方功能已开启':'官方功能未开启'}</Badge><Badge>最近返回 {current.dispatches.returnedCount} 条记录 · 最多 {current.dispatches.limit} 条</Badge></>}</div>
    <p style={{fontSize:13,color:'#61718a',marginTop:12}}>{butlerReason(pendingInitialization||readiness)||'登录后检查大管家主会话与执行节点状态。'}{current&&' 调度状态与任务进度分别记录，实际执行与成品结果请查看任务记录。'}</p>
    {readiness?.standardBuiltinReflection===true&&<p className="bx-form-note">包含 BXAGI 内置的每周工作复盘与记忆维护</p>}
    {(canInitialize||busy==='initialize')&&<Button busy={busy==='initialize'} disabled={!!busy} onClick={()=>run(true)}><Sparkles size={15}/>{busy==='initialize'?'正在启用':'启用免费大管家'}</Button>}
    {current&&<small style={{display:'block',color:'#61718a',marginTop:12}}>检查时间：{new Date(current.checkedAt).toLocaleString('zh-CN')}</small>}
    {error&&<div className="bx-message error" role="alert">{error}</div>}
  </Panel>;
}
export function Employees({state,onLogin}:{state:PlatformState;onLogin?:()=>void}){
  const [query,setQuery]=useState(''),[expanded,setExpanded]=useState(''),[refreshing,setRefreshing]=useState(false);
  const connected=state.data.bxagi.connected;
  const directory=connected?marketEntries(state.data.employees) as Row[]:[];
  const search=query.trim().toLowerCase();
  const entries=directory.filter(entry=>[entry.name,entry.description,entry.category,entry.marketId,...skills(entry)].map(text).join(' ').toLowerCase().includes(search));
  async function refresh(){setRefreshing(true);try{await state.refresh();}catch(error){state.setError(error instanceof Error?error.message:'员工市场暂未更新，请稍后重试。');}finally{setRefreshing(false);}}
  return <><ButlerPanel state={state}/><NodeHealthPanel state={state}/><div className="bx-employee-intro"><span><Store size={25}/></span><div><h2>BXAGI 员工市场</h2><p>从官方员工市场读取岗位、技能和实际报价，工作流按市场岗位安排执行。</p></div><Badge tone={connected?'green':'amber'}>{connected?'BXAGI 已登录':'需要登录'}</Badge></div>{!connected?<Panel title="登录后读取员工市场"><Empty title="查看实际市场岗位" description="使用你的 BXAGI 账号读取员工市场与启用状态。" icon={<Bot size={28}/>} action={<Button onClick={onLogin||state.openBxagiLogin}><LogIn size={16}/>登录 BXAGI</Button>}/><a className="bx-text-button" href={MARKET_URL} target="_blank" rel="noopener noreferrer">浏览官方员工市场<ExternalLink size={14}/></a></Panel>:<><div className="bx-toolbar"><div className="bx-inline-tags"><Badge tone="blue">官方员工市场岗位</Badge><Badge>{directory.length} 个岗位</Badge></div><label className="bx-search"><Search size={16}/><input aria-label="搜索员工市场岗位" placeholder="搜索岗位、技能或市场编号" value={query} onChange={event=>setQuery(event.target.value)}/></label><Button secondary busy={refreshing} onClick={refresh}><RefreshCw size={15}/>刷新市场</Button></div>{remoteErrorMessage(state.data.bxagi.error)&&<div className="bx-message error" role="alert">{remoteErrorMessage(state.data.bxagi.error)}</div>}{entries.length?<div className="bx-employee-grid">{entries.map(entry=>{const capability=skills(entry),isExpanded=expanded===entry.id,verified=verifiedMarketSource(entry),ready=verified&&entry.activationState==='ready'&&entry.usable===true;return <article className="bx-employee-card" key={entry.id}><header><span className="bx-employee-avatar"><Bot size={24}/></span><div style={{minWidth:0}}><h3 style={{overflowWrap:'anywhere'}}>{text(entry.name)||`市场岗位 ${entry.marketId}`}</h3><small>{text(entry.category)||'市场岗位'} · 市场编号 {text(entry.marketId)}</small></div></header><div className="bx-inline-tags"><Badge tone="blue">市场岗位</Badge><Badge tone={ready?'green':'amber'}>{activationLabel(entry)}</Badge></div><p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{text(entry.description)||'市场尚未提供岗位介绍。'}</p>{capability.length>0&&<div className="bx-capability-list">{capability.map((skill,index)=><span key={`${index}-${skill}`}><Sparkles size={12}/>{skill}</span>)}</div>}<div style={{margin:'14px 0',padding:'12px 0',borderTop:'1px solid #e8edf5',borderBottom:'1px solid #e8edf5'}}><strong style={{display:'block',fontSize:14,color:'#465b77'}}>{quoteText(entry)}</strong><small style={{display:'block',fontSize:12,color:'#61718a',marginTop:5}}>{activationFeeNote(entry)}</small>{listQuoteText(entry)&&<small style={{display:'block',fontSize:12,color:'#61718a',marginTop:5}}>市场原价：{listQuoteText(entry)}</small>}</div>{activationReasonText(entry)&&<p>{activationReasonText(entry)}</p>}<button className="bx-text-button" aria-expanded={isExpanded} onClick={()=>setExpanded(isExpanded?'':entry.id)}>{isExpanded?'收起岗位详情':'查看岗位来源与状态'}</button>{isExpanded&&<div className="bx-instructions"><strong>官方市场编号</strong><p>{text(entry.marketId)}</p><strong>来源</strong><p>{entry.marketVerified===true?'市场来源已核实':'市场来源待核实'}</p><strong>启用状态</strong><p>{activationLabel(entry)}</p>{capability.length>0&&<><strong>市场技能</strong><p>{capability.join('、')}</p></>}<small>实际执行状态见任务记录；当前页面不执行安装、购买或续费。</small></div>}</article>})}</div>:<Panel><Empty title={search?'没有匹配的市场岗位':'暂未取得员工市场岗位'} description={search?'尝试其他岗位名称、技能或市场编号。':'请刷新官方市场数据；执行记录会单独展示。'} icon={<Store size={28}/>} action={<a className="bx-button secondary" href={MARKET_URL} target="_blank" rel="noopener noreferrer">打开官方员工市场<ExternalLink size={14}/></a>}/></Panel>}<Panel title="岗位来源与启用" action={<a className="bx-text-button" href={MARKET_URL} target="_blank" rel="noopener noreferrer">打开官方员工市场<ExternalLink size={14}/></a>}><div className="bx-capability-summary"><div><Badge tone="blue">依据市场岗位调度</Badge><p>目录以市场模板和已核实的对应启用资源为准。历史任务与会话在执行记录中展示。</p></div><div><Badge tone="amber">报价与启用分别核实</Badge><p>待启用或来源未核实的岗位会显示实际等待原因。未知报价不按免费处理，当前页面不触发付费操作。</p></div></div></Panel><details className="bx-advanced"><summary>查看实际员工执行记录</summary><RemoteJobCards state={state}/></details></>}</>;
}
