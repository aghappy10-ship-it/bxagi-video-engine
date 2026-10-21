const kinds=new Set(['marketplace_template','installed_employee']);
export function isMarketEmployee(employee){return !!employee&&employee.provider==='bxagi'&&kinds.has(employee.resourceType)&&employee.marketVerified===true&&typeof employee.marketId==='string'&&employee.marketId.length>0&&employee.marketId.length<=200&&employee.id==='bxagi:market:'+employee.marketId;}
export function isReadableMarketEmployee(employee){return isMarketEmployee(employee)&&employee.resourceType==='installed_employee'&&employee.activationState==='ready'&&employee.sourceVerified===true&&employee.installation?.status!=='expired'&&(employee.entitlementVerified===true||employee.entitlementVerified===undefined&&employee.usable===true);}
export function isExecutableMarketEmployee(employee){return isReadableMarketEmployee(employee)&&employee.usable===true&&(!employee.availability||employee.availability==='ready');}
const availabilityErrors={node_offline:['bxagi_node_offline','BXAGI执行节点离线，保留当前任务等待连接恢复'],gateway_disconnected:['bxagi_gateway_disconnected','BXAGI节点网关断连，保留当前任务等待连接恢复'],node_unavailable:['bxagi_node_unavailable','BXAGI节点暂不可用，稍后重新检查'],runtime_unavailable:['bxagi_runtime_unavailable','BXAGI员工运行时暂不可用，保留当前任务等待恢复']};
const safeQuote=value=>value&&value.currency==='CNY'&&(value.monthly===null||typeof value.monthly==='number'&&Number.isFinite(value.monthly)&&value.monthly>=0)&&(value.annual===null||typeof value.annual==='number'&&Number.isFinite(value.annual)&&value.annual>=0)?{monthly:value.monthly,annual:value.annual,currency:'CNY'}:null;
export function publicMarketSelection(employee){
  if(!isMarketEmployee(employee))return null;
  const activation=employee.activation||{},quote=safeQuote(activation.quote),listQuote=safeQuote(activation.listQuote);
  return {id:employee.id,marketId:employee.marketId,name:typeof employee.name==='string'?employee.name.slice(0,180):employee.marketId,resourceType:employee.resourceType,activationState:employee.activationState,activationRequired:!isReadableMarketEmployee(employee),freeVerified:activation.freeVerified===true,
    ...(quote?{quote}:{}),...(listQuote?{listQuote}:{}),
    ...(['solo_quota','zero_price','private_deployment'].includes(activation.freeBasis)?{freeBasis:activation.freeBasis}:{}),
    ...(activation.quoteScope==='activation_only'?{quoteScope:'activation_only'}:{})};
}
export function assertReadableMarketEmployee(employee){if(!isMarketEmployee(employee))throw Object.assign(new Error('必须使用BXAGI员工市场的真实模板；历史会话仅保留记录，不作为执行员工'),{status:409,code:'bxagi_market_employee_required'});if(!isReadableMarketEmployee(employee))throw Object.assign(new Error('匹配的市场员工尚未完成验证的激活，平台未执行任何生产或投放'),{status:409,code:'bxagi_market_employee_activation_required',marketSelection:publicMarketSelection(employee)});return employee;}


export function assertMarketEmployee(employee){
  assertReadableMarketEmployee(employee);
  if(!isExecutableMarketEmployee(employee)){const [code,message]=availabilityErrors[employee.availability]||['bxagi_node_unavailable','BXAGI执行资源暂不可用，等待重新检查'];throw Object.assign(new Error(message),{status:503,code,marketSelection:publicMarketSelection(employee)});}
  return employee;
}
