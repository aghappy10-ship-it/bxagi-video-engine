import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePlatformRequest } from '../server/platform-api.mjs';

test('ordinary health makes no outbound requests; optional probe only reads anonymous official configuration',async()=>{
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url,init});
    return Response.json({auth_required:true,access_token:'never-expose-upstream-fields',password:'never-expose-upstream-fields'});
  };
  const env={BXAGI_REQUIRED:'true'};
  let response=await handlePlatformRequest(new Request('https://platform.test/api/v2/system/health'),env,{fetcher});
  assert.equal(response.status,200);
  assert.equal(calls.length,0);
  response=await handlePlatformRequest(new Request('https://platform.test/api/v2/system/health?probeBxagi=true&url=https://untrusted.test'),env,{fetcher});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.bxagi.connection.reachable,true);
  assert.equal(result.bxagi.connection.authRequired,true);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://bxagi.xinlx.com/api/auth/config');
  assert.equal(calls[0].init.method,'GET');
  assert.ok(!calls[0].init.body);
  assert.ok(!calls[0].init.headers.Authorization);
  assert.ok(!JSON.stringify(result).includes('never-expose-upstream-fields'));
});

test('connection probe failure keeps platform health available and does not leak network details',async()=>{
  const response=await handlePlatformRequest(new Request('https://platform.test/api/v2/system/health?probeBxagi=true'),{},
    {fetcher:async()=>{throw new TypeError('Private network path, passwords and tokens must not appear in responses');}});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.bxagi.connection.reachable,false);
  assert.ok(result.bxagi.connection.error.code);
  assert.ok(!JSON.stringify(result).includes('Private network path'));
});
