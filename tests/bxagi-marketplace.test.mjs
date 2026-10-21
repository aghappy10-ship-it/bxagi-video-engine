import test from 'node:test';
import assert from 'node:assert/strict';
import { createBxagiMarketplace } from '../server/bxagi-marketplace.mjs';
import { assertMarketEmployee, assertReadableMarketEmployee, publicMarketSelection } from '../server/bxagi-market-eligibility.mjs';

const origin = 'https://bxagi.xinlx.com';
const secret = 'marketplace-fixture-credential';
const subject = 'verified-marketplace-owner';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const paths = {
  templates: '/api/v1/employees/templates',
  pricing: '/api/v1/employees/pricing',
  mine: '/api/v1/employees/mine',
  quota: '/api/billing/free-solo-quota',
  settings: '/api/settings',
};
const template = { id: 'creative-editor', name: '素材剪辑员工', description: '整理和优化广告素材', skills: ['media/video-edit'], category: '创意', has_subs: false, billing_tier_id: 'creative-price' };

test('offline, disconnected gateway and runtime failure preserve valid entitlement for reads and report distinct execution waits',async()=>{
  const mine={items:[{employee_id:template.id,conversation_id:'source',usable:true,conversation_exists:true,status:'active'}]};
  for(const [status,gateway,sandbox,code] of [['offline',false,'RUNNING','bxagi_node_offline'],['online',false,'RUNNING','bxagi_gateway_disconnected'],['online',true,'ERROR','bxagi_runtime_unavailable']]){
    const {api}=client({mine,nodes:{nodes:[{node_id:'authorized-node',status,gateway_connected:gateway}]},conversations:[{id:'source',employee_id:template.id,created_by_user_id:subject,node_id:'authorized-node',agent_type:'AgiAgent',sandbox_status:sandbox}]});
    const [employee]=(await api.inspect()).employees;
    assert.equal(employee.entitlementVerified,true);assert.equal(employee.sourceVerified,true);assert.equal(employee.activation.required,false);assert.equal(publicMarketSelection(employee).activationRequired,false);assert.equal(employee.usable,false);
    assert.equal(assertReadableMarketEmployee(employee),employee);
    assert.throws(()=>assertMarketEmployee(employee),error=>error.code===code&&error.status===503);
    assert.throws(()=>assertReadableMarketEmployee({...employee,installation:{...employee.installation,status:'expired'}}),{code:'bxagi_market_employee_activation_required'});
    assert.throws(()=>assertReadableMarketEmployee({...employee,sourceVerified:false}),{code:'bxagi_market_employee_activation_required'});
  }
});

function client(overrides = {}, handler) {
  const fixtures = {
    templates: [template],
    pricing: [{ id: 'creative-price', monthly_yuan: 39, annual_yuan: 299 }],
    mine: { items: [] },
    quota: { remaining: 0, quota: 3 },
    settings: { is_cloud_mode: true },
    nodes: { nodes: [{ node_id: 'authorized-node', status: 'online', gateway_connected: true }] },
    ...overrides,
  };
  const conversations = overrides.conversations || fixtures.mine.items?.filter(entry => entry.conversation_id).map(entry => ({
    id: entry.conversation_id, employee_id: entry.employee_id, created_by_user_id: subject,
    node_id: 'authorized-node', agent_type: 'AgiAgent', execution_status: 'idle', sandbox_status: 'RUNNING',
  })) || [];
  const calls = [];
  const api = createBxagiMarketplace({ accessToken: secret, subject, fetcher: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    calls.push({ url: parsed, options });
    if (handler) return handler(parsed, options);
    if (parsed.pathname === '/api/nodes') return json(fixtures.nodes);
    if (parsed.pathname === '/api/v1/app-conversations') {
      const ids = parsed.searchParams.getAll('ids');
      return json(conversations.filter(conversation => ids.includes(conversation.id)));
    }
    const key = Object.keys(paths).find(name => paths[name] === parsed.pathname);
    assert.ok(key, `Unexpected upstream path: ${parsed.pathname}`);
    return json(fixtures[key]);
  } });
  return { api, calls };
}

test('marketplace inspects only observed read APIs and exposes the template quote without private settings', async () => {
  const { api, calls } = client({ settings: { is_cloud_mode: true, api_key: secret, provider_token: secret, model: 'private-model' } });
  const result = await api.inspect();
  assert.deepEqual(Object.keys(result).sort(), ['employees', 'isCloudMode', 'quota']);
  assert.equal(result.isCloudMode, true);
  assert.deepEqual(result.quota, { remaining: 0, quota: 3 });
  assert.equal(result.employees.length, 1);
  const employee = result.employees[0];
  assert.deepEqual(Object.keys(employee).sort(), ['activation', 'activationState', 'availability', 'category', 'description', 'entitlementVerified', 'hasSubs', 'id', 'industry', 'installation', 'installed', 'marketId', 'marketVerified', 'name', 'provider', 'resourceType', 'roleCandidates', 'skills', 'sourceVerified', 'tags', 'usable']);
  assert.equal(employee.id, `bxagi:market:${template.id}`);
  assert.equal(employee.marketId, template.id);
  assert.equal(employee.name, template.name);
  assert.equal(employee.description, template.description);
  assert.equal(employee.category, template.category);
  assert.deepEqual(employee.skills, template.skills);
  assert.equal(employee.hasSubs, false);
  assert.equal(employee.installed, false);
  assert.equal(employee.installation, null);
  assert.equal(employee.marketVerified, true);
  assert.equal(employee.activationState, 'not_installed');
  assert.equal(employee.sourceVerified, false);
  assert.equal(employee.usable, false);
  assert.equal(employee.resourceType, 'marketplace_template');
  assert.equal(employee.activation.required, true);
  assert.equal(employee.activation.freeVerified, false);
  assert.deepEqual(employee.activation.quote, { monthly: 39, annual: 299, currency: 'CNY' });
  assert.equal(typeof employee.activation.reason, 'string');
  assert.deepEqual(calls.map(call => call.url.pathname).sort(), Object.values(paths).sort());
  assert.equal(calls.find(call => call.url.pathname === paths.mine).url.searchParams.get('include_inactive'), 'true');
  assert.equal(calls.find(call => call.url.pathname === paths.mine).url.searchParams.get('locale'), 'zh');
  assert.equal(calls.find(call => call.url.pathname === paths.templates).url.searchParams.get('locale'), 'zh');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('private-model'));
});

test('each template uses its own inline or referenced billing tier and does not borrow another quote', async () => {
  const { api } = client({ templates: [
    template,
    { id: 'inline', name: 'Inline', billing_tier: { monthly_yuan: 0, annual_yuan: 0 }, has_subs: true },
    { id: 'different', name: 'Different', billing_tier_id: 'other-price' },
    { id: 'unknown', name: 'Unknown', billing_tier_id: 'missing-price' },
  ], pricing: [
    { id: 'creative-price', monthly_yuan: 39, annual_yuan: 299 },
    { id: 'other-price', monthly_yuan: 89, annual_yuan: 899 },
  ] });
  const result = await api.inspect();
  const [paid, inline, different, unknown] = result.employees;
  assert.deepEqual(paid.activation.quote, { monthly: 39, annual: 299, currency: 'CNY' });
  assert.deepEqual(inline.activation.quote, { monthly: 0, annual: 0, currency: 'CNY' });
  assert.equal(inline.activation.freeVerified, true);
  assert.equal(inline.hasSubs, true);
  assert.deepEqual(different.activation.quote, { monthly: 89, annual: 899, currency: 'CNY' });
  assert.deepEqual(unknown.activation.quote, { monthly: null, annual: null, currency: 'CNY' });
  assert.equal(unknown.activation.freeVerified, false);
});

test('verified cloud Solo eligibility uses the official free quota while preserving the list price',async()=>{
  const {api}=client({quota:{remaining:1,quota:3}});const [employee]=(await api.inspect()).employees;
  assert.equal(employee.activation.freeVerified,true);assert.equal(employee.activation.freeBasis,'solo_quota');
  assert.equal(employee.activation.reason,'solo_quota_available');assert.deepEqual(employee.activation.quote,{monthly:0,annual:0,currency:'CNY'});
  assert.deepEqual(employee.activation.listQuote,{monthly:39,annual:299,currency:'CNY'});assert.equal(employee.activation.quoteScope,'activation_only');
  for(const hasSubs of [true,null,undefined]){const {api:other}=client({templates:[{...template,has_subs:hasSubs}],quota:{remaining:3,quota:3}});assert.equal((await other.inspect()).employees[0].activation.freeVerified,false);}
});

test('free status requires both numeric zero prices or an explicit local-mode setting', async () => {
  const { api } = client({ templates: [
    { id: 'both-zero', billing_tier: { monthly_yuan: 0, annual_yuan: 0 } },
    { id: 'partial-zero', billing_tier: { monthly_yuan: 0 } },
    { id: 'string-zero', billing_tier: { monthly_yuan: '0', annual_yuan: '0' } },
    { id: 'one-paid', billing_tier: { monthly_yuan: 0, annual_yuan: 10 } },
  ] });
  const result = await api.inspect();
  assert.deepEqual(result.employees.map(employee => employee.activation.freeVerified), [true, false, false, false]);
  const { api: local } = client({ templates: [{ id: 'no-tier' }], pricing: [], settings: { is_cloud_mode: false } });
  const localResult = await local.inspect();
  assert.equal(localResult.isCloudMode, false);
  assert.equal(localResult.employees[0].activation.freeVerified, true);
  const { api: unspecified } = client({ templates: [{ id: 'no-tier' }], pricing: [], settings: {} });
  const unspecifiedResult = await unspecified.inspect();
  assert.equal(unspecifiedResult.isCloudMode, null);
  assert.equal(unspecifiedResult.employees[0].activation.freeVerified, false);
});

test('installation flags are preserved and expired, disabled, or missing conversations still need activation', async () => {
  const ledger = [
    { employee_id: 'active', conversation_id: 'active-conversation', status: 'active', usable: true, conversation_exists: true },
    { employee_id: 'expired', conversation_id: 'expired-conversation', status: 'expired', usable: true, conversation_exists: true },
    { employee_id: 'disabled', conversation_id: 'disabled-conversation', status: 'active', usable: false, conversation_exists: true },
    { employee_id: 'missing', conversation_id: 'gone-conversation', status: 'active', usable: true, conversation_exists: false },
  ];
  const { api, calls } = client({ templates: ledger.map(row => ({ id: row.employee_id })), mine: { items: ledger } });
  const result = await api.inspect();
  assert.deepEqual(result.employees.map(employee => employee.installed), [true, true, true, true]);
  assert.deepEqual(result.employees.map(employee => employee.activation.required), [false, true, true, true]);
  assert.deepEqual(result.employees[1].installation, { providerId: 'expired', conversationId: 'expired-conversation', status: 'expired', usable: true, conversationExists: true });
  assert.equal(result.employees[0].activationState, 'ready');
  assert.equal(result.employees[0].sourceVerified, true);
  assert.equal(result.employees[0].usable, true);
  assert.equal(result.employees[0].resourceType, 'installed_employee');
  assert.ok(calls.every(call => !/install|renew/.test(call.url.pathname)));
  assert.equal(calls.filter(call => call.url.pathname === '/api/nodes').length, 1);
  const sourceCalls = calls.filter(call => call.url.pathname === '/api/v1/app-conversations');
  assert.equal(sourceCalls.length, 1);
  assert.equal(sourceCalls[0].url.searchParams.get('skip_live_status'), null);
  assert.deepEqual(sourceCalls[0].url.searchParams.getAll('ids'), ['active-conversation']);
});

test('catalog is template based and does not turn historical employee records into market offers', async () => {
  const { api } = client({ mine: { items: [
    { employee_id: 'historical-only', conversation_id: 'old-session', status: 'expired', usable: false, conversation_exists: false },
    { employee_id: template.id, conversation_id: 'current-session', usable: true, conversation_exists: true },
  ] } });
  const result = await api.inspect();
  assert.deepEqual(result.employees.map(employee => employee.marketId), [template.id]);
  assert.equal(result.employees[0].installation.providerId, template.id);
  assert.equal(result.employees[0].installation.conversationId, 'current-session');
});

test('a claimed active subscription becomes ready only with owned source and an online node', async () => {
  const installation = { employee_id: template.id, conversation_id: 'current-session', usable: true, conversation_exists: true, status: 'active' };
  const source = { id: installation.conversation_id, employee_id: template.id, created_by_user_id: subject, node_id: 'authorized-node', agent_type: 'AgiAgent', sandbox_status: 'RUNNING' };
  for (const [overrides, sourceVerified] of [
    [{ conversations: [] }, false],
    [{ conversations: [{ ...source, created_by_user_id: 'another-user' }] }, false],
    [{ conversations: [{ ...source, created_by_user_id: undefined }] }, false],
    [{ conversations: [{ ...source, employee_id: 'another-employee' }] }, false],
    [{ conversations: [source], nodes: { nodes: [{ node_id: 'authorized-node', status: 'offline', gateway_connected: false }] } }, true],
    [{ conversations: [source], nodes: { nodes: [] } }, false],
  ]) {
    const { api } = client({ mine: { items: [installation] }, ...overrides });
    const [employee] = (await api.inspect()).employees;
    assert.equal(employee.installed, true);
    assert.equal(employee.activationState, sourceVerified?'ready':'unverified');
    assert.equal(employee.sourceVerified, sourceVerified);
    assert.equal(employee.usable, false);
    assert.equal(employee.activation.required, !sourceVerified);
  }
});

test('newly installed source null slots stay unverified without accepting malformed records', async () => {
  const mine = { items: [{ employee_id: template.id, conversation_id: 'new-source', usable: true, conversation_exists: true, status: 'active' }] };
  for (const sourceResponse of [[null], [null, null]]) {
    const { api, calls } = client({ mine }, url => {
      if (url.pathname === '/api/v1/app-conversations') return json(sourceResponse);
      if (url.pathname === '/api/nodes') return json({ nodes: [{ node_id: 'authorized-node', status: 'online', gateway_connected: true }] });
      if (url.pathname === paths.templates) return json([template]);
      if (url.pathname === paths.pricing) return json([{ id: 'creative-price', monthly_yuan: 39, annual_yuan: 299 }]);
      if (url.pathname === paths.mine) return json(mine);
      if (url.pathname === paths.quota) return json({ remaining: 2, quota: 3 });
      return json({ is_cloud_mode: true });
    });
    const [employee] = (await api.inspect()).employees;
    assert.equal(employee.installed, true); assert.equal(employee.sourceVerified, false);
    assert.equal(employee.activationState, 'unverified'); assert.equal(employee.usable, false);
    assert.equal(employee.conversationId, undefined);
    assert.ok(calls.every(call => call.options.method === 'GET'));
  }
  for (const malformed of [[null, {}], [null, 'invalid-source'], { items: [null] }]) {
    const { api } = client({ mine }, url => url.pathname === '/api/v1/app-conversations' ? json(malformed)
      : url.pathname === '/api/nodes' ? json({ nodes: [] })
      : url.pathname === paths.templates ? json([template])
      : url.pathname === paths.pricing ? json([])
      : url.pathname === paths.mine ? json(mine)
      : url.pathname === paths.quota ? json({ remaining: 2, quota: 3 }) : json({ is_cloud_mode: true }));
    await assert.rejects(api.inspect(), error => error.code === 'unexpected_response' && error.marketDiagnostic === 'BXAGI 市场员工会话响应格式尚不能确认');
  }
});

test('market installation accepts equivalent UUID serialization but rejects a different source', async () => {
  const requested='19a3e398-9dd1-43eb-b615-ba052654382f';
  const mine={items:[{employee_id:template.id,conversation_id:requested,usable:true,conversation_exists:true,status:'active'}]};
  for(const returned of ['19a3e3989dd143ebb615ba052654382f','19a3e3989dd143ebb615ba052654382e']) {
    const {api}=client({mine},url=>url.pathname==='/api/v1/app-conversations'?json([{id:returned,employee_id:template.id,created_by_user_id:subject,node_id:'authorized-node',agent_type:'AgiAgent',runtime_api_key:secret}])
      :url.pathname==='/api/nodes'?json({nodes:[{node_id:'authorized-node',status:'online',gateway_connected:true}]})
      :url.pathname===paths.templates?json([template]):url.pathname===paths.pricing?json([]):url.pathname===paths.mine?json(mine)
      :url.pathname===paths.quota?json({remaining:2,quota:3}):json({is_cloud_mode:true}));
    if(returned.endsWith('e')){const [employee]=(await api.inspect()).employees;assert.equal(employee.activationState,'unverified');assert.equal(employee.sourceVerified,false);}
    else {const result=await api.inspect({diagnostics:true}),[employee]=result.employees;assert.equal(employee.activationState,'ready');assert.equal(employee.conversationId,returned);assert.equal(employee.installed,true);assert.equal(result.diagnostics.conversationBatches[0].sources[0].requested,true);assert.ok(!JSON.stringify(result).includes(secret));}
  }
});

test('unobserved API envelopes are rejected instead of treated as an empty marketplace', async () => {
  for (const overrides of [
    { templates: { items: [] } },
    { pricing: { items: [] } },
    { mine: [] },
    { settings: [] },
    { quota: [] },
  ]) {
    const { api } = client(overrides);
    await assert.rejects(api.inspect(), error => error.code === 'unexpected_response');
  }
});

test('sensitive fields and exact credential strings cannot escape a successful inspection', async () => {
  const { api } = client({
    templates: [{ ...template, name: `Employee ${secret}`, description: `Description ${secret}`, skills: [`skill/${secret}`], api_key: secret, internal_config: { token: secret } }],
    mine: { items: [{ employee_id: template.id, conversation_id: 'session', usable: true, conversation_exists: true, session_api_key: secret, agent_server_url: 'https://private.invalid' }] },
    settings: { is_cloud_mode: true, integrations: { secret }, password: secret },
  });
  const result = await api.inspect();
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes('private.invalid'));
  assert.equal(result.employees[0].api_key, undefined);
  assert.equal(result.employees[0].installation.session_api_key, undefined);
});

test('redirects cancel the response and never fetch the redirect destination', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let cancelled = 0;
    const { api, calls } = client({}, url => url.pathname === paths.templates ? new Response(new ReadableStream({ cancel() { cancelled++; } }), { status, headers: { Location: 'https://external.invalid/credential-target' } }) : json(url.pathname === paths.pricing ? [] : url.pathname === paths.mine ? { items: [] } : url.pathname === paths.quota ? { remaining: 0, quota: 0 } : {}));
    await assert.rejects(api.inspect(), error => !error.message.includes(secret));
    assert.equal(cancelled, 1);
    assert.ok(calls.length <= 5);
    assert.ok(calls.every(call => call.url.origin === origin));
    assert.equal(calls.filter(call => call.url.pathname === paths.templates).length, 1);
  }
});

test('network and upstream error details are redacted and do not trigger retries', async () => {
  for (const failure of [() => { throw new Error(`Network diagnostic ${secret}`); }, () => new Response(`Upstream diagnostic ${secret}`, { status: 403 })]) {
    const { api, calls } = client({}, failure);
    await assert.rejects(api.inspect(), error => !error.message.includes(secret));
    assert.ok(calls.length <= 5);
    const counts = new Map();
    for (const call of calls) counts.set(call.url.pathname, (counts.get(call.url.pathname) || 0) + 1);
    assert.ok([...counts.values()].every(count => count === 1));
  }
});

test('oversized JSON is refused before reading its body', async () => {
  let cancelled = 0;
  const { api } = client({}, () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(16 * 1024 * 1024 + 1) } }));
  await assert.rejects(api.inspect(), error => error.code === 'response_too_large');
  assert.ok(cancelled > 0);
});

test('template inspection reads only observed role and schedule endpoints and strips unrelated fields',async()=>{
  const {api,calls}=client({},url=>url.pathname.endsWith('/roles')?json({main_agent:{role_md:'真实岗位职责 '+secret},privateKey:secret}):json([{name:'定时复核',type:'daily',config:{cron_hour:8,secret}}]));
  const details=await api.readTemplateDetails('creative-editor');
  assert.equal(details.marketId,'creative-editor');assert.equal(details.scheduleCount,1);assert.deepEqual(details.schedules,[{name:'定时复核',type:'daily'}]);
  assert.ok(!JSON.stringify(details).includes(secret));assert.ok(!Object.hasOwn(details,'privateKey'));
  assert.deepEqual(calls.map(call=>call.url.pathname).sort(),['/api/v1/employees/templates/creative-editor/roles','/api/v1/employees/templates/creative-editor/schedules']);
});
