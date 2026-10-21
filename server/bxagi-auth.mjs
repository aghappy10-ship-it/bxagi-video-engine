import { createBxagiSessionRepository } from './bxagi-session-repository.mjs';
import { createBxagiAccountRepository } from './bxagi-account-repository.mjs';
import { encryptConnectionSecrets, decryptConnectionSecrets } from './adapters/connection-secrets.mjs';

export const BXAGI_ORIGIN='https://bxagi.xinlx.com';
export const BXAGI_SESSION_COOKIE='__Host-bxagi-session';
const MAX_SESSION_MS=7*24*60*60*1000;
const VALIDATION_TTL_MS=60*1000;
export class BxagiAuthError extends Error {
  constructor(message,{status=503,code='bxagi_unavailable',clearCookie=false}={}){super(message);this.name='BxagiAuthError';this.status=status;this.code=code;this.clearCookie=clearCookie;}
}
const error=(message,options)=>{throw new BxagiAuthError(message,options);};
const cleanText=(value,max=200)=>typeof value==='string'?value.trim().slice(0,max):'';
function cookieValue(request){const cookie=request.headers.get('Cookie')||'';return cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${BXAGI_SESSION_COOKIE}=`))?.slice(BXAGI_SESSION_COOKIE.length+1)||null;}
export function clearBxagiCookie(){return `${BXAGI_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0`;}
function sessionCookie(value,expiresAt){const seconds=Math.max(0,Math.floor((Date.parse(expiresAt)-Date.now())/1000));return `${BXAGI_SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=${seconds}`;}
async function digest(value){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');}
function randomSession(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function subjectOf(user){const id=user?.id;if((typeof id!=='string'&&typeof id!=='number')||!String(id).trim()||String(id).length>200||(typeof id==='number'&&!Number.isSafeInteger(id)))error('BXAGI未返回可验证的账户标识',{code:'bxagi_invalid_identity'});return String(id);}
function maskEmail(value){const text=cleanText(value);const at=text.lastIndexOf('@');return at>0?`${text.slice(0,1)}***${text.slice(at)}`:null;}
function maskPhone(value){const text=cleanText(value);return text?`${text.slice(0,Math.min(3,text.length))}***${text.length>5?text.slice(-2):''}`:null;}
/** Keep only public identity fields; upstream unknown fields may contain credentials. */
export function bxagiPublicProfile(user){return {id:subjectOf(user),username:cleanText(user.username)||null,displayName:cleanText(user.display_name||user.displayName||user.name||user.username)||'BXAGI用户',email:maskEmail(user.email),phone:maskPhone(user.phone)};}
function expiryHint(token){
  let deadline=Date.now()+MAX_SESSION_MS;
  // JWT claims are unverified and only shorten TTL. Identity ALWAYS comes from /auth/me.
  try{const part=token.split('.')[1];if(part){const text=atob(part.replace(/-/g,'+').replace(/_/g,'/'));const exp=JSON.parse(text).exp;if(typeof exp==='number'&&Number.isFinite(exp))deadline=Math.min(deadline,exp*1000);}}catch{}
  return new Date(deadline).toISOString();
}
async function boundedJson(response,max=64*1024,signal){
  if(!response.body)error('BXAGI响应缺少内容',{code:'bxagi_invalid_response'});const reader=response.body.getReader();const chunks=[];let total=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  try{
    while(true){if(signal?.aborted)error('BXAGI响应超时，请稍后重试',{code:'bxagi_upstream_unavailable'});const {done,value}=await reader.read();if(signal?.aborted)error('BXAGI响应超时，请稍后重试',{code:'bxagi_upstream_unavailable'});if(done)break;total+=value.byteLength;if(total>max)error('BXAGI响应超出允许范围',{code:'bxagi_invalid_response'});chunks.push(value);}
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{const body=JSON.parse(new TextDecoder().decode(bytes));if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();return body;}catch{error('BXAGI响应格式不正确',{code:'bxagi_invalid_response'});}
  }finally{signal?.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});}
}
async function upstream(path,{token,body,fetcher,env}){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),Math.max(1000,Math.min(Number(env.APP_BXAGI_TIMEOUT_MS)||12000,20000)));
  let upstreamStatus=null;
  try{
    // workerd rejects redirect:'error' before sending a request. Never follow a
    // redirect carrying login data or authorization: inspect manual responses.
    const response=await fetcher(`${BXAGI_ORIGIN}${path}`,{method:body?'POST':'GET',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal,redirect:'manual'});
    upstreamStatus=response.status;
    if((response.status>=300&&response.status<400)||response.redirected||(response.url&&new URL(response.url).origin!==BXAGI_ORIGIN)){
      await response.body?.cancel().catch(()=>{});
      error('BXAGI认证发生不允许的重定向',{code:'bxagi_redirect_refused'});
    }
    if(response.status===401)error(path.endsWith('/login')?'BXAGI账号或密码不正确':'BXAGI会话已失效，请重新登录',{status:401,code:path.endsWith('/login')?'bxagi_login_rejected':'bxagi_session_invalid',clearCookie:!path.endsWith('/login')});
    if(response.status===403)error('BXAGI账户未获授权，请检查账户状态',{status:403,code:'bxagi_forbidden'});
    if(!response.ok)error('BXAGI服务暂不可用，请稍后重试',{code:'bxagi_upstream_unavailable'});
    return await boundedJson(response,64*1024,controller.signal);
  }catch(err){
    const diagnostic={stage:path==='/api/auth/login'?'login':path==='/api/auth/me'?'me':'config',code:err instanceof BxagiAuthError?err.code:'bxagi_upstream_unavailable',upstreamStatus,errorName:['Error','TypeError','AbortError','BxagiAuthError'].includes(err?.name)?err.name:'Error',reason:controller.signal.aborted?'timeout':err instanceof BxagiAuthError?'upstream_rejected':'transport_exception'};
    console.warn('bxagi_auth_upstream',JSON.stringify(diagnostic));
    if(err instanceof BxagiAuthError)throw err;error('BXAGI服务暂不可用，请稍后重试',{code:'bxagi_upstream_unavailable'});
  }
  finally{clearTimeout(timeout);}
}
/** Anonymous read-only transport probe; no account, cookie or authorization. */
export async function probeBxagiConnection({env={},fetcher=fetch}={}){
  const checkedAt=new Date().toISOString();
  try{const config=await upstream('/api/auth/config',{fetcher,env});if(typeof config.auth_required!=='boolean')error('BXAGI未返回有效的认证配置',{code:'bxagi_invalid_response'});return {reachable:true,authRequired:config.auth_required,checkedAt};}
  catch(err){return {reachable:false,checkedAt,error:{code:err instanceof BxagiAuthError?err.code:'bxagi_upstream_unavailable',message:err instanceof BxagiAuthError?err.message:'BXAGI服务暂不可用，请稍后重试'}};}
}
async function verifiedAccount(accounts,subject){
  try{return await accounts.resolveVerifiedSubject(subject);}
  catch(err){if(err.status===409)error(err.message,{status:409,code:err.code});throw err;}
}
async function resolveSession(session,repository,env,{fetcher,required}){
  const sessionId=session.id,userId=session.userId,accounts=createBxagiAccountRepository(env.DB);
  if(!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=Date.now()){await repository.remove(userId,sessionId);error('BXAGI会话已过期，请重新登录',{status:401,code:'bxagi_session_expired',clearCookie:true});}
  if(!env.APP_ENCRYPTION_KEY)error('BXAGI账户凭据加密尚未配置',{code:'bxagi_encryption_unavailable'});
  const secrets=await decryptConnectionSecrets(session.tokenCiphertext,env.APP_ENCRYPTION_KEY);if(typeof secrets.accessToken!=='string'||!secrets.accessToken)error('BXAGI会话凭据不可用，请重新连接',{code:'bxagi_credentials_invalid'});
  let profile=session.profile,account=await accounts.getBySubject(session.subject);
  if(account&&account.userId!==userId)error('BXAGI账户与工作区映射不一致，请重新登录',{status:401,code:'bxagi_identity_changed',clearCookie:true});
  // A legacy cookie may create a mapping only after fresh official verification.
  if(required||!account||!Number.isFinite(Date.parse(session.lastValidatedAt))||Date.now()-Date.parse(session.lastValidatedAt)>=VALIDATION_TTL_MS){
    let me;
    try{me=await upstream('/api/auth/me',{token:secrets.accessToken,fetcher,env});}
    catch(err){if(err.status===401)await repository.remove(userId,sessionId);throw err;}
    if(subjectOf(me)!==session.subject){await repository.remove(userId,sessionId);error('BXAGI账户身份发生变化，请重新连接',{status:401,code:'bxagi_identity_changed',clearCookie:true});}
    account=account||await verifiedAccount(accounts,session.subject);
    if(account.userId!==userId)error('BXAGI账户与工作区映射不一致，请重新登录',{status:401,code:'bxagi_identity_changed',clearCookie:true});
    profile=bxagiPublicProfile(me);await repository.validate(userId,sessionId,{profile,lastValidatedAt:new Date().toISOString()});
  }
  // nativeUserId is an internal backwards-compatible alias, never a header identity.
  return {userId,nativeUserId:userId,subject:session.subject,profile,accessToken:secrets.accessToken,sessionId};
}
export async function resolveBxagiContext(request,env,{fetcher=fetch,required=false}={}){
  const opaque=cookieValue(request);
  if(!opaque){if(required)error('请先连接你的BXAGI账户',{status:401,code:'bxagi_login_required'});return null;}
  if(!/^[A-Za-z0-9_-]{43}$/.test(opaque))error('BXAGI会话已失效，请重新登录',{status:401,code:'bxagi_session_invalid',clearCookie:true});
  const repository=createBxagiSessionRepository(env.DB),sessionId=await digest(opaque),session=await repository.getById(sessionId);
  if(!session)error('BXAGI会话已失效，请重新登录',{status:401,code:'bxagi_session_invalid',clearCookie:true});
  return resolveSession(session,repository,env,{fetcher,required});
}
/** Service callers pass a DB-owned account owner, never an emulated cookie/header. */
export async function resolveBxagiContextForUser(userId,env,{fetcher=fetch,required=true}={}){
  if(typeof userId!=='string'||!userId||userId.length>256)error('缺少已验证的BXAGI用户',{status:401,code:'bxagi_login_required'});
  const repository=createBxagiSessionRepository(env.DB),session=await repository.latest(userId);
  if(!session){if(required)error('请先连接你的BXAGI账户',{status:401,code:'bxagi_login_required'});return null;}
  return resolveSession(session,repository,env,{fetcher,required});
}
export async function invalidateBxagiContext(context,env){const userId=context?.userId||context?.nativeUserId;if(userId&&context?.sessionId)await createBxagiSessionRepository(env.DB).remove(userId,context.sessionId);}
async function requestBody(request){
  if((request.headers.get('Content-Type')||'').split(';')[0].toLowerCase()!=='application/json')error('请求必须使用JSON内容',{status:415,code:'invalid_content_type'});
  return boundedJson(request,16*1024);
}
function checkOrigin(request){const origin=request.headers.get('Origin');if(request.headers.get('Sec-Fetch-Site')==='cross-site'||(origin&&origin!==new URL(request.url).origin))error('请在当前工作区连接账户',{status:403,code:'cross_site_request'});}
const response=(body,status=200,cookie)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(cookie?{'Set-Cookie':cookie}:{})}});
export async function handleBxagiAuthRequest(request,env,{fetcher=fetch}={}){
  try{
    const path=new URL(request.url).pathname.replace(/^\/api\/v2/,'');
    if(request.method==='POST')checkOrigin(request);
    if(path==='/bxagi/auth/status'&&request.method==='GET'){
      const context=await resolveBxagiContext(request,env,{fetcher});return response({connected:!!context,profile:context?.profile??null,provider:'BXAGI',identitySource:context?'verified_auth_me':null});
    }
    if(path==='/bxagi/auth/login'&&request.method==='POST'){
      const b=await requestBody(request),login=cleanText(b.login,200),password=typeof b.password==='string'?b.password:'';
      if(!login||!password||password.length>4096||!['username','phone'].includes(b.login_type))error('请输入有效的BXAGI账户与密码',{status:400,code:'invalid_login'});
      if(!env.APP_ENCRYPTION_KEY)error('BXAGI账户凭据加密尚未配置',{code:'bxagi_encryption_unavailable'});
      const deviceId=crypto.randomUUID();const logged=await upstream('/api/auth/login',{body:{login,login_type:b.login_type,password,device_id:deviceId},fetcher,env});
      const accessToken=typeof logged.access_token==='string'?logged.access_token:'';if(!accessToken||accessToken.length>16000)error('BXAGI未返回有效登录凭据',{code:'bxagi_invalid_response'});
      const me=await upstream('/api/auth/me',{token:accessToken,fetcher,env}),subject=subjectOf(me),profile=bxagiPublicProfile(me),expiresAt=expiryHint(accessToken);
      if(Date.parse(expiresAt)<=Date.now())error('BXAGI返回的会话已过期，请重新登录',{status:401,code:'bxagi_session_expired'});
      const account=await verifiedAccount(createBxagiAccountRepository(env.DB),subject),userId=account.userId;
      const repository=createBxagiSessionRepository(env.DB),opaque=randomSession(),id=await digest(opaque),tokenCiphertext=await encryptConnectionSecrets({accessToken},env.APP_ENCRYPTION_KEY);
      await repository.create(userId,{id,subject,profile,tokenCiphertext,deviceId,expiresAt,lastValidatedAt:new Date().toISOString()});
      const previous=cookieValue(request);if(previous&&/^[A-Za-z0-9_-]{43}$/.test(previous)){const old=await repository.getById(await digest(previous));if(old)await repository.remove(old.userId,old.id);}
      await repository.removeExpired();return response({connected:true,profile,provider:'BXAGI',identitySource:'verified_auth_me'},200,sessionCookie(opaque,expiresAt));
    }
    if(path==='/bxagi/auth/logout'&&request.method==='POST'){
      const opaque=cookieValue(request);if(opaque&&/^[A-Za-z0-9_-]{43}$/.test(opaque)){const repository=createBxagiSessionRepository(env.DB),session=await repository.getById(await digest(opaque));if(session)await repository.remove(session.userId,session.id);}return response({connected:false,profile:null,provider:'BXAGI'},200,clearBxagiCookie());
    }
    return response({error:{message:'BXAGI认证接口不存在',code:'not_found'}},404);
  }catch(err){const status=Number(err.status)||503;return response({error:{message:err instanceof BxagiAuthError?err.message:'BXAGI账户服务暂不可用，请稍后重试',code:err.code||'bxagi_unavailable'},...(err.clearCookie?{connected:false,invalidated:true}:{})},status,err.clearCookie?clearBxagiCookie():undefined);}
}
