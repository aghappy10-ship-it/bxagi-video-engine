import test from 'node:test';
import assert from 'node:assert/strict';
import { nextBxagiRecovery,bxagiRecoveryDue,isTransientBxagiError } from '../server/bxagi-recovery.mjs';
test('retry backoff grows with bounded jitter, caps at five minutes and preserves first outage time',()=>{
  let state=null;const now=Date.parse('2026-10-15T00:00:00Z');
  for(let attempt=1;attempt<=24;attempt++){
    state=nextBxagiRecovery(state,'bxagi_node_offline',{now:now+attempt*1000,random:()=>0.5});
    assert.equal(state.attempt,Math.min(20,attempt));assert.equal(state.firstFailureAt,new Date(now+1000).toISOString());
    assert.equal(Date.parse(state.nextRetryAt)-(now+attempt*1000),Math.min(300,15*2**Math.min(attempt-1,5))*1000);
    assert.equal(bxagiRecoveryDue({details:{recovery:state}},Date.parse(state.nextRetryAt)-1),false);assert.equal(bxagiRecoveryDue({details:{recovery:state}},Date.parse(state.nextRetryAt)),true);
  }
  assert.equal(isTransientBxagiError({status:401,code:'upstream_unavailable'}),false);assert.equal(isTransientBxagiError({status:403,code:'bxagi_node_offline'}),false);assert.equal(isTransientBxagiError({status:502,uncertain:true}),false);
  assert.notEqual(nextBxagiRecovery(null,'upstream_unavailable',{now,random:()=>0}).nextRetryAt,nextBxagiRecovery(null,'upstream_unavailable',{now,random:()=>1}).nextRetryAt);
});
