/** The website has a single identity provider: its verified BXAGI session. */
export function isBxagiSessionRequired(error) {return Number(error?.status)===401&&error?.code!=='bxagi_login_rejected';}
export function normalizeSessionBootstrap(payload,empty) {
  const connected=payload?.bxagi?.connected===true;
  const verifiedTenant=typeof payload?.user?.id==='string'&&payload.user.id.trim().length>0;
  // Bootstrap authenticates before employee discovery; an employee outage is
  // different from an expired account session.
  const temporarilyUnavailable=payload?.bxagi?.status==='unavailable';
  if((!connected&&!temporarilyUnavailable)||!verifiedTenant)return {authenticated:false,data:empty};
  const data={...empty,...payload,user:{...empty.user,...payload.user},bxagi:{...empty.bxagi,...payload.bxagi},capabilities:payload.capabilities&&typeof payload.capabilities==='object'&&!Array.isArray(payload.capabilities)?payload.capabilities:{}};
  for(const [key,value] of Object.entries(empty))if(Array.isArray(value))data[key]=Array.isArray(payload[key])?payload[key]:[];
  return {authenticated:true,data};
}
export function clearSessionData(empty) {return empty;}
