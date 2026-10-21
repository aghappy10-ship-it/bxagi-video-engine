/** D1-backed BXAGI sessions; only opaque-cookie hashes locate browser sessions. */
const parse=row=>{if(!row)return null;let profile;try{profile=JSON.parse(row.profile);}catch{profile={};}return {...row,profile};};
export function createBxagiSessionRepository(DB){
  if(!DB?.prepare)throw Object.assign(new Error('账户会话存储暂不可用'),{status:503,code:'bxagi_storage_unavailable'});
  const query=(sql,...params)=>DB.prepare(sql).bind(...params);
  return {
    async getById(id){return parse(await query('SELECT * FROM bxagiSessions WHERE id = ?',id).first());},
    async latest(userId){return parse(await query('SELECT * FROM bxagiSessions WHERE userId = ? AND expiresAt > ? ORDER BY createdAt DESC, rowid DESC LIMIT 1',userId,new Date().toISOString()).first());},
    async get(userId,id){return parse(await query('SELECT * FROM bxagiSessions WHERE userId = ? AND id = ?',userId,id).first());},
    async create(userId,session){
      const now=new Date().toISOString();
      await query('INSERT INTO bxagiSessions (id,userId,createdAt,updatedAt,subject,tokenCiphertext,profile,deviceId,expiresAt,lastValidatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',session.id,userId,now,now,session.subject,session.tokenCiphertext,JSON.stringify(session.profile),session.deviceId,session.expiresAt,session.lastValidatedAt).run();
      return this.get(userId,session.id);
    },
    async validate(userId,id,{profile,lastValidatedAt}){await query('UPDATE bxagiSessions SET profile = ?, lastValidatedAt = ?, updatedAt = ? WHERE userId = ? AND id = ?',JSON.stringify(profile),lastValidatedAt,new Date().toISOString(),userId,id).run();return this.get(userId,id);},
    async removeOtherSubjects(userId,subject){await query('INSERT OR IGNORE INTO bxagiLegacyBindings (subject,userId,createdAt) SELECT subject,userId,createdAt FROM bxagiSessions WHERE userId = ? AND subject <> ?',userId,subject).run();await query('DELETE FROM bxagiSessions WHERE userId = ? AND subject <> ?',userId,subject).run();},
    async remove(userId,id){await query('INSERT OR IGNORE INTO bxagiLegacyBindings (subject,userId,createdAt) SELECT subject,userId,createdAt FROM bxagiSessions WHERE userId = ? AND id = ?',userId,id).run();await query('DELETE FROM bxagiSessions WHERE userId = ? AND id = ?',userId,id).run();},
    async removeExpired(){const now=new Date().toISOString();await query('INSERT OR IGNORE INTO bxagiLegacyBindings (subject,userId,createdAt) SELECT subject,userId,createdAt FROM bxagiSessions WHERE expiresAt <= ?',now).run();await query('DELETE FROM bxagiSessions WHERE expiresAt <= ?',now).run();},
  };
}
