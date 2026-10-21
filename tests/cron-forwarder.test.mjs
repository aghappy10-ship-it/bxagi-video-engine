import test from 'node:test';
import assert from 'node:assert/strict';
import scheduler, { forwardBackgroundTick, runScheduledTick } from '../worker/cron-forwarder.mjs';

const secret = 'fixture-scheduler-secret-with-32-or-more-characters';
const env = { SITE_URL: 'https://platform.example', BXAGI_SCHEDULER_SECRET: secret };

test('scheduler sends only fixed POST endpoint and discards response data', async () => {
  let calls = 0;
  const logs = [];
  const result = await runScheduledTick(env, { log: entry => logs.push(entry), fetcher: async (url, options) => {
    calls++;
    assert.equal(url, 'https://platform.example/api/v2/worker/background-tick');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.body, '{}');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('private-user-data', { status: 200 });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { httpStatus: 200 });
  assert.equal(logs[0].outcome, 'acknowledged');
  assert.doesNotMatch(JSON.stringify(logs), /private-user-data|fixture-scheduler-secret|platform\.example/);
});

test('scheduler refuses redirects without a second request or exposing Location', async () => {
  let calls = 0;
  const logs = [];
  await assert.rejects(runScheduledTick(env, { log: entry => logs.push(entry), fetcher: async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'manual');
    return new Response('private redirect body', { status: 302, headers: { Location: `https://other.example/${secret}` } });
  } }), { message: 'scheduler_redirect_refused' });
  assert.equal(calls, 1);
  assert.equal(logs[0].httpStatus, 302);
  assert.doesNotMatch(JSON.stringify(logs), /other\.example|private redirect|fixture-scheduler-secret/);
});

test('optional Sites service token stays on the fixed origin and out of logs', async () => {
  const siteToken = 'fixture-site-service-token';
  const logs = [];
  const destinations = [];
  const tokenEnv = { ...env, SITES_SERVICE_TOKEN: siteToken };
  await assert.rejects(runScheduledTick(tokenEnv, { log: entry => logs.push(entry), fetcher: async (url, options) => {
    destinations.push(url);
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(options.headers['OAI-Sites-Authorization'], `Bearer ${siteToken}`);
    assert.equal(options.redirect, 'manual');
    return new Response(`${secret} ${siteToken}`, { status: 307, headers: { Location: 'https://different-origin.example/collect' } });
  } }), { message: 'scheduler_redirect_refused' });
  assert.deepEqual(destinations, ['https://platform.example/api/v2/worker/background-tick']);
  assert.doesNotMatch(JSON.stringify(logs), /fixture-site-service-token|fixture-scheduler-secret|different-origin/);
  await assert.rejects(forwardBackgroundTick({ ...env, SITES_SERVICE_TOKEN: `${siteToken}\n` }, {
    fetcher: async () => { throw new Error('must not request'); },
  }), { message: 'scheduler_site_token_invalid' });
});

test('scheduler times out, aborts request and does not retry', async () => {
  let calls = 0;
  let requestSignal;
  const logs = [];
  await assert.rejects(runScheduledTick(env, { timeoutMs: 10, log: entry => logs.push(entry), fetcher: async (_url, options) => {
    calls++;
    requestSignal = options.signal;
    return new Promise(() => {});
  } }), { message: 'scheduler_request_timeout' });
  assert.equal(requestSignal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(logs[0].code, 'scheduler_request_timeout');
  assert.doesNotMatch(JSON.stringify(logs), /fixture-scheduler-secret/);
});

test('scheduler network exceptions and server bodies cannot leak into logs', async () => {
  const logs = [];
  await assert.rejects(runScheduledTick(env, { log: entry => logs.push(entry), fetcher: async () => {
    throw new Error(`Sensitive URL or header: ${secret}`);
  } }), { message: 'scheduler_request_failed' });
  await assert.rejects(runScheduledTick(env, { log: entry => logs.push(entry), fetcher: async () => {
    return new Response(`private body ${secret}`, { status: 401 });
  } }), { message: 'scheduler_http_failed' });
  assert.equal(logs[1].httpStatus, 401);
  assert.doesNotMatch(JSON.stringify(logs), /Sensitive|private body|fixture-scheduler-secret/);
});

test('scheduler rejects unsafe or missing configuration before any request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return new Response(); };
  for (const SITE_URL of [undefined, 'http://platform.example', 'https://user:pass@platform.example', 'https://platform.example/path', 'https://platform.example?q=x', 'https://platform.example#x']) {
    await assert.rejects(forwardBackgroundTick({ ...env, SITE_URL }, { fetcher }), { message: 'scheduler_site_invalid' });
  }
  for (const BXAGI_SCHEDULER_SECRET of [undefined, 'short', `${secret}\n`]) {
    await assert.rejects(forwardBackgroundTick({ ...env, BXAGI_SCHEDULER_SECRET }, { fetcher }), { message: 'scheduler_secret_invalid' });
  }
  assert.equal(calls, 0);
});

test('HTTP calls cannot invoke the cron function', async () => {
  const response = scheduler.fetch(new Request('https://worker.example/'), env);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
});
