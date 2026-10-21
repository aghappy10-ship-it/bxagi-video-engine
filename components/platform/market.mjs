const bxagi=entry=>String(entry?.provider||'').toLowerCase()==='bxagi';
const text=value=>typeof value==='string'?value.trim():typeof value==='number'&&Number.isFinite(value)?String(value):'';
export function marketEntries(rows=[]) {
  return (Array.isArray(rows)?rows:[]).filter(entry=>bxagi(entry)&&text(entry.marketId)&&['marketplace_template','installed_employee'].includes(entry.resourceType));
}
export function verifiedMarketSource(entry) {return entry?.marketVerified===true&&entry?.sourceVerified===true;}
export function activationLabel(entry) {
  if(entry?.marketVerified!==true)return '市场来源待核实';
  if(entry.activationState==='not_installed')return '待启用';
  if(entry.activationState==='ready'){if(entry.sourceVerified!==true)return '启用资源待核实';return entry.usable===true?'已启用':'已启用 · 暂不可执行';}
  return '启用状态待核实';
}
function amount(value) {
  if(typeof value==='number')return Number.isFinite(value)&&value>=0?value:null;
  if(typeof value==='string'&&/^\d+(?:\.\d{1,2})?$/.test(value.trim()))return Number(value.trim());
  return null;
}
function formatQuote(quote) {
  if(!quote||quote.currency!=='CNY')return '';
  const monthly=amount(quote.monthly),annual=amount(quote.annual),parts=[];
  const format=value=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(value);
  if(monthly!==null)parts.push(`¥${format(monthly)}/月`);
  if(annual!==null)parts.push(`¥${format(annual)}/年`);
  return parts.join(' · ');
}
export function freeActivationVerified(entry) {return entry?.marketVerified===true&&entry?.activation?.freeVerified===true;}
export function soloQuotaActivationVerified(entry) {return freeActivationVerified(entry)&&entry.activation.freeBasis==='solo_quota';}
export function quoteText(entry) {
  if(soloQuotaActivationVerified(entry))return '本次启用免费 · 使用 Solo 免费名额';
  return formatQuote(entry?.activation?.quote)||'报价待核实';
}
export function listQuoteText(entry) {return formatQuote(entry?.activation?.listQuote);}
export function activationFeeNote(entry) {
  if(soloQuotaActivationVerified(entry))return '启用前重新核对可用名额';
  if(freeActivationVerified(entry))return '当前部署无需订阅费用（已核实）';
  return formatQuote(entry?.activation?.quote)?'报价按市场返回显示，启用费用仍以官方确认方案为准':'市场未返回可核实报价，不能视为免费';
}
const activationReasons={
  already_installed:'已启用',
  renewal_required:'需续费',
  installed_unavailable:'启用资源暂不可用',
  private_deployment:'私有部署',
  zero_price_verified:'零订阅价',
  solo_quota_available:'Solo 免费名额可用',
  quota_available_but_not_price_locked:'有免费名额，最终费用待确认',
  deployment_mode_unknown:'部署模式未核实',
  payment_required:'需付费启用',
  price_unknown:'报价待核实',
};
export function activationReasonText(entry) {
  const reason=entry?.activation?.reason;
  const code=text(typeof reason==='object'&&reason!==null?reason.code:reason);
  return code?(activationReasons[code]||'启用条件待核实'):'';
}
