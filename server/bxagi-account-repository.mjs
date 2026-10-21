/** Stable verified-subject identity. Never match email or caller user headers. */
const conflict=(code,message)=>Object.assign(new Error(message),{status:409,code});
async function subjectOwner(subject){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subject)));return `bxagi:${Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')}`;}
export function createBxagiAccountRepository(DB){
  if(!DB?.prepare)throw Object.assign(new Error('账户映射存储暂不可用'),{status:503,code:'bxagi_storage_unavailable'});
  const query=(sql,...params)=>DB.prepare(sql).bind(...params);
  const getBySubject=subject=>query('SELECT * FROM bxagiAccounts WHERE subject = ?',subject).first();
  return {
    getBySubject,
    getByUserId:userId=>query('SELECT * FROM bxagiAccounts WHERE userId = ?',userId).first(),
    async resolveVerifiedSubject(subject){
      if(typeof subject!=='string'||!subject||subject.length>200)throw Object.assign(new Error('缺少已验证的BXAGI账户标识'),{status:401,code:'bxagi_invalid_identity'});
      const existing=await getBySubject(subject);if(existing)return existing;
      const rows=(await query('SELECT userId FROM bxagiLegacyBindings WHERE subject = ? UNION SELECT userId FROM bxagiSessions WHERE subject = ?',subject,subject).all()).results??[];
      if(rows.length>1)throw conflict('bxagi_legacy_conflict','该BXAGI账号关联多个旧工作区，需要确认归属；系统不会自动合并');
      const userId=rows.length===1?rows[0].userId:await subjectOwner(subject),source=rows.length===1?'legacy_session':'bxagi_subject',now=new Date().toISOString();
      try{await query('INSERT INTO bxagiAccounts (subject,userId,source,createdAt,updatedAt) VALUES (?,?,?,?,?) ON CONFLICT(subject) DO NOTHING',subject,userId,source,now,now).run();}
      catch(err){if(/UNIQUE constraint/i.test(String(err?.message)))throw conflict('bxagi_account_conflict','旧工作区已关联另一个BXAGI账号，需要确认归属；系统不会自动合并');throw err;}
      const account=await getBySubject(subject);
      if(!account||account.userId!==userId)throw conflict('bxagi_account_conflict','BXAGI账户与工作区映射发生冲突，请确认归属');
      return account;
    },
  };
}
