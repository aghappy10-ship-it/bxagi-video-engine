import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { createPlatformRepository } from '../server/platform-repository.mjs';
function fixture() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../drizzle/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const DB = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind(...args) {
          return {
            async first() { return statement.get(...args) ?? null; },
            async all() { return {results: statement.all(...args)}; },
            async run() { return {meta: {changes: Number(statement.run(...args).changes)}}; },
          };
        },
      };
    },
  };
  return {db, repo: createPlatformRepository(DB)};
}

test('one durable flow per owned project and concurrent claims are exclusive',async()=>{const {db,repo}=fixture();try{const p=await repo.createProject('a',{title:'test'});await assert.rejects(repo.ensureAutomaticFlow('b',p.id,{bxagiSubject:'b'}));const [a,b]=await Promise.all([repo.ensureAutomaticFlow('a',p.id,{bxagiSubject:'s'}),repo.ensureAutomaticFlow('a',p.id,{bxagiSubject:'s'})]);assert.equal(a.id,b.id);assert.equal((await repo.listJobs('a')).length,1);assert.equal((await repo.listDueAutomaticFlows(3,'b')).length,0);const [x,y]=await Promise.all([repo.claimAutomaticFlow('a',a.id,'one'),repo.claimAutomaticFlow('a',a.id,'two')]);assert.equal(Number(!!x)+Number(!!y),1);assert.equal(await repo.claimAutomaticFlow('b',a.id,'wrong'),null);assert.equal((await repo.listDueAutomaticFlows(3,'a')).length,0);}finally{db.close()}});
test('new upload signal survives stale flow save and lease release is fenced',async()=>{const {db,repo}=fixture();try{const p=await repo.createProject('a',{title:'test'}),f=await repo.ensureAutomaticFlow('a',p.id,{bxagiSubject:'s'}),claimed=await repo.claimAutomaticFlow('a',f.id,'lease');await repo.ensureAutomaticFlow('a',p.id,{bxagiSubject:'s'});const future=new Date(Date.now()+3600000).toISOString();const saved=await repo.saveAutomaticFlow('a',f.id,'lease',claimed.details.signalVersion,{status:'waiting',details:{nextActionAt:future,productionJobId:'actual-job',bxagiSubject:'spoof',signalVersion:0,enabled:false,operationId:'spoof'}});assert.equal(saved.details.signalVersion,2);assert.equal(saved.details.bxagiSubject,'s');assert.equal(saved.details.enabled,true);assert.equal(saved.details.operationId,'lease');assert.ok(saved.details.nextActionAt<future);assert.equal(await repo.saveAutomaticFlow('a',f.id,'other',2,{status:'queued',details:{}}),null);await repo.releaseAutomaticFlow('a',f.id,'other');assert.equal((await repo.getAutomaticFlow('a',p.id)).details.operationId,'lease');await repo.releaseAutomaticFlow('a',f.id,'lease');assert.equal((await repo.listDueAutomaticFlows(3,'a')).length,1);assert.equal(await repo.ensureAutomaticFlow('a',p.id,{bxagiSubject:'different'}),null);}finally{db.close()}});
test('legacy scheduler excludes jobs owned by enabled automatic flow',async()=>{const {db,repo}=fixture();try{const p=await repo.createProject('a',{title:'test'}),j=await repo.createBxagiProductionJob('a',{projectId:p.id,employeeId:'x',details:{bxagiSubject:'s',kind:'production'}});assert.equal((await repo.listDueBxagiJobs()).length,1);await repo.ensureAutomaticFlow('a',p.id,{bxagiSubject:'s'});assert.equal((await repo.listDueBxagiJobs()).length,0);assert.equal((await repo.getJob('a',j.id)).status,'queued');}finally{db.close()}});
