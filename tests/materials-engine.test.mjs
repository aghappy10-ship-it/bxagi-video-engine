import test from 'node:test';
import assert from 'node:assert/strict';
import { employeeProfiles, capabilityCatalog, inferScene, selectProductionEmployee, selectBuyingEmployee, normalizeEmployeeProfiles, employeeCan } from '../shared/employees.mjs';
import { buildCreativePlan, classifyWithModel, formatProfiles, presentationForInstructions, evaluateOptimizationContext } from '../shared/creative-engine.mjs';
import { computeImagePlacement, renderImageCreative, renderVideoCreative } from '../shared/creative-renderer.mjs';

test('scene metadata routes apparel, game and drama independently', () => {
  assert.equal(inferScene({ title: '冬季衣服新品', facts: ['羊毛外套'] }).scene, 'apparel');
  assert.equal(inferScene({ description: '手游玩家实录', filenames: ['gameplay.mp4'] }).scene, 'game');
  assert.equal(inferScene({ title: '短剧首集', filenames: ['episode_01.mp4'] }).scene, 'drama');
  assert.equal(inferScene({ title: '蓝色天空', mimeTypes: ['image/jpeg'] }).scene, 'general');
});
test('opaque image filename is not visual classification; filename evidence remains labelled', () => {
  const opaque = inferScene({ filenames: ['IMG_8299.JPG'], mimeTypes: ['image/jpeg'] });
  assert.equal(opaque.scene, 'general'); assert.equal(opaque.engine, 'rules'); assert.equal(opaque.needsModel, true);
  const named = inferScene({ filenames: ['jacket-product.jpg'] });
  assert.equal(named.scene, 'apparel'); assert.equal(named.needsModel, true); assert.match(named.basis[0], /文件名/);
  assert.equal(inferScene({ title: 'shirtless evening' }).scene, 'general');
  assert.equal(inferScene({ title: 'new product series' }).scene, 'general');
});
test('ambiguous multi-business metadata falls back without declaring certainty', () => {
  const result = inferScene({ title: '短剧游戏素材' });
  assert.equal(result.scene, 'general'); assert.equal(result.needsModel, true); assert.ok(result.confidence < .5);
});
test('registry supports arbitrary new scenes and objective/channel-specific buying roles', () => {
  const custom = [
    { id: 'dental_producer', role: 'production', scene: 'dental', keywords: ['牙科'], capabilities: ['copy.variants', 'image.layout'], instructions: '仅使用已提供事实' },
    { id: 'dental_leads', role: 'buying', scene: 'dental', objectives: ['lead'], channels: ['tencent'], capabilities: ['campaign.plan'] },
  ];
  assert.equal(inferScene({ title: '牙科预约' }, custom).scene, 'dental');
  assert.equal(selectProductionEmployee('dental', custom).id, 'dental_producer');
  assert.equal(selectBuyingEmployee({ scene: 'dental', objective: 'lead', channel: 'tencent' }, custom).id, 'dental_leads');
  assert.equal(selectBuyingEmployee({ scene: 'dental', objective: 'purchase', channel: 'oceanengine' }, custom).id, 'buying_general');
  assert.equal(selectProductionEmployee('new-unregistered-business').id, 'production_general');
  assert.equal(normalizeEmployeeProfiles([{ scene: 'dental', role: 'administrator' }]).length, 0);
  assert.ok(employeeProfiles.every(profile => profile.version && profile.instructions));
});
test('registry accepts customProfiles inside evidence, separates available capabilities from pending', () => {
  const profiles = [{ id: 'dentist', scene: 'dental', role: 'production', sceneKeywords: ['牙科'], capabilities: ['copy.variants', 'image.vision', 'invented.magic'] }];
  assert.equal(inferScene({ title: '牙科预约', customProfiles: profiles }).scene, 'dental');
  assert.deepEqual(normalizeEmployeeProfiles(profiles)[0].capabilities, ['copy.variants']);
  assert.equal(capabilityCatalog.find(capability => capability.id === 'image.vision').available, false);
  const original = inferScene({ title: '衣服' });
  const duplicate = inferScene({ title: '衣服' }, [{ id: 'apparel-custom', scene: 'apparel', role: 'production', keywords: ['衣服'], capabilities: ['copy.variants'] }]);
  assert.equal(duplicate.confidence, original.confidence);
});
test('plan creates three drafts preserving facts/assets without invented benefits', () => {
  const project = { id: 'p1', title: '新品', productName: '羊毛外套', description: '展示正面与背面', facts: ['成分：100% 羊毛', '颜色：蓝色'], objective: 'purchase' };
  const result = buildCreativePlan({ project, assets: [{ id: 'a1', projectId: 'p1', filename: 'coat.jpg', mimeType: 'image/jpeg' }, { id: 'a2', projectId: 'other', filename: 'other.jpg', mimeType: 'image/jpeg' }] });
  assert.equal(result.assignment.productionEmployeeId, 'production_apparel');
  assert.equal(result.variants.length, 3);
  assert.deepEqual(result.variants.map(variant => variant.format), ['portrait', 'square', 'landscape']);
  for (const variant of result.variants) {
    assert.equal(variant.status, 'draft'); assert.equal(variant.processing.status, 'ready_to_render');
    assert.deepEqual(variant.sourceAssetIds, ['a1']);
    assert.ok(variant.evidence.some(item => item.value === '成分：100% 羊毛'));
    assert.ok(!/保暖|优惠|限时|收益|提升|ROI/.test(variant.headline + variant.body));
  }
});
test('untrusted facts remain literal text and custom instructions cannot create benefits', () => {
  const malicious = '<img src=x onerror=alert(1)>'; // Canvas/React text is the required consumer contract.
  const result = buildCreativePlan({ project: { title: '咖啡', facts: [malicious], customProfiles: [{ id: 'coffee', scene: 'coffee', role: 'production', keywords: ['咖啡'], capabilities: ['copy.variants'], instructions: '声称治病' }] } });
  assert.equal(result.assignment.productionEmployeeId, 'coffee');
  assert.equal(result.variants[1].headline, malicious);
  assert.ok(!result.variants.some(variant => /治病/.test(variant.body)));
});
test('custom instruction style affects presentation and one-source plans match actual PNG inputs', () => {
  const result = buildCreativePlan({
    project: { title: '咖啡', facts: ['规格：250g', '来源：用户提供'], customProfiles: [{ id: 'coffee', role: 'production', scene: 'coffee', keywords: ['咖啡'], capabilities: ['image.layout', 'copy.variants'], instructions: '简洁，浅色版式。宣称百病全消' }] },
    assets: [{ id: 'a1', filename: 'front.jpg', mimeType: 'image/jpeg' }, { id: 'a2', filename: 'back.jpg', mimeType: 'image/jpeg' }],
  });
  assert.equal(result.variants[0].layout.theme, 'paper');
  assert.equal(result.variants[0].body, '规格：250g');
  assert.deepEqual(result.variants.map(variant => variant.sourceAssetIds), [['a1'], ['a2'], ['a1']]);
  assert.ok(!result.variants.some(variant => variant.body.includes('百病全消')));
  assert.deepEqual(presentationForInstructions('不要简洁'), { tone: 'neutral', theme: null });
});
test('video plans need timestamps and absent capabilities never pretend processing success', () => {
  const assets = [{ id: 'v1', filename: 'gameplay.mp4', mimeType: 'video/mp4' }];
  assert.equal(buildCreativePlan({ project: { title: '游戏' }, assets }).variants[0].processing.status, 'needs_segment_selection');
  const result = buildCreativePlan({ project: { title: '牙科', customProfiles: [{ role: 'production', id: 'no-image', scene: 'dental', keywords: ['牙科'], capabilities: ['copy.variants'] }] }, assets: [{ id: 'i1', filename: 'photo.png', mimeType: 'image/png' }] });
  assert.equal(result.variants[0].processing.supported, false);
  assert.equal(result.variants[0].processing.status, 'unsupported_capability');
  assert.equal(employeeCan(result.assignment.productionEmployee, 'image.layout'), false);
});
test('format geometry keeps full image by default and rejects invalid dimensions', () => {
  assert.deepEqual(formatProfiles.portrait, { width: 1080, height: 1920, ratio: '9:16', label: '竖版' });
  const placed = computeImagePlacement(2000, 1000, { x: 0, y: 0, width: 1080, height: 1920 });
  assert.equal(placed.width, 1080); assert.equal(placed.height, 540); assert.equal(placed.y, 690);
  assert.throws(() => computeImagePlacement(0, 1000, { x: 0, y: 0, width: 1080, height: 1920 }));
  const covered = computeImagePlacement(2000, 1000, { x: 0, y: 0, width: 1080, height: 1920 }, 'cover');
  assert.equal(covered.height, 1920); assert.ok(covered.x < 0);
});
test('renderers reject missing bytes, wrong formats and unavailable browser capabilities', async () => {
  await assert.rejects(renderImageCreative({ variant: { format: 'portrait' } }), /真实素材/);
  await assert.rejects(renderImageCreative({ sourceBlob: new Blob(['video'], { type: 'video/mp4' }), variant: { format: 'portrait' } }), /类型不受支持/);
  await assert.rejects(renderImageCreative({ sourceBlob: new Blob(['image'], { type: 'image/png' }), variant: { format: 'portrait' } }), /浏览器画布/);
  await assert.rejects(renderVideoCreative({ sourceBlob: new Blob(['video'], { type: 'video/mp4' }), variant: { format: 'portrait' } }), /起止时间/);
});
test('model classifier is optional and uses real compatible API only when configured', async () => {
  const noModel = await classifyWithModel({ title: '衣服' });
  assert.equal(noModel.modelConfigured, false); assert.equal(noModel.engine, 'rules');
  let called = false;
  const configured = await classifyWithModel({ title: '服装' }, { endpoint: 'https://provider.example/v1/chat/completions', apiKey: 'test-key', model: 'test-model', fetcher: async (url, request) => {
    called = true; assert.equal(request.headers.Authorization, 'Bearer test-key'); assert.equal(JSON.parse(request.body).model, 'test-model');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scene: 'apparel', confidence: .9, basis: ['Metadata mentions clothing'] }) } }] }), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(called, true); assert.equal(configured.engine, 'model-metadata');
  await assert.rejects(classifyWithModel({}, { endpoint: 'http://provider.example', apiKey: 'k', model: 'm' }), /HTTPS/);
});

const feedbackContext = (overrides = {}) => ({
  taskId: 'task-1', reason: '运营侧请求新的素材实验', iteration: 1,
  campaignSnapshot: { id: 'campaign-1', creativeIds: ['creative-a', 'creative-b'], targetRoi: 2 },
  metricSnapshot: { id: 'metric-1', source: 'manual', dataFresh: true, impressions: 300, clicks: 5, spend: 20, revenue: null, conversions: null, hasConversion: false },
  ...overrides,
});
test('unknown conversion and scarce CTR collect data without performance experiment claims', () => {
  const context = feedbackContext();
  const result = buildCreativePlan({ project: { id: 'p1', title: '服装', facts: ['规格：L'] } }, { optimizationContext: context });
  assert.equal(result.optimization.status, 'collect_data');
  assert.equal(result.optimization.signal, null);
  assert.equal(result.revision, 'task-1:r1');
  assert.ok(result.variants.every(variant => variant.experiment === null && variant.status === 'draft'));
  assert.ok(result.variants.every(variant => variant.evidence.some(item => item.source === 'project.fact' && item.value === '规格：L')));
  assert.match(result.optimization.reason, /继续收集/);
});
test('stale, untraceable or invalid click counts cannot drive feedback experiments', () => {
  const goodMetric = { id: 'metric-1', source: 'oceanengine', dataFresh: true, impressions: 3000, clicks: 50 };
  for (const context of [
    feedbackContext({ metricSnapshot: { ...goodMetric, dataFresh: false } }),
    feedbackContext({ metricSnapshot: { ...goodMetric, source: '' } }),
    feedbackContext({ metricSnapshot: { ...goodMetric, clicks: 4000 } }),
    feedbackContext({ metricSnapshot: { ...goodMetric, clicks: 3.5 } }),
    feedbackContext({ taskId: '', metricSnapshot: goodMetric }),
    feedbackContext({ metricSnapshot: { ...goodMetric, id: '' } }),
  ]) assert.equal(evaluateOptimizationContext(context).status, 'collect_data');
});
test('sufficient real CTR permits only CTR experiment despite unknown revenue', () => {
  const result = evaluateOptimizationContext(feedbackContext({ metricSnapshot: {
    id: 'metric-1', source: 'manual', dataFresh: true, impressions: 2000, clicks: 20,
    spend: 60, revenue: null, conversions: null, hasConversion: false, roi: 99,
  } }));
  assert.equal(result.status, 'experiment_ready');
  assert.deepEqual(result.signals.map(signal => signal.type), ['ctr']);
  assert.equal(result.signal.value, .01);
  assert.equal(result.scope, 'campaign'); assert.equal(result.creativeId, null);
  assert.ok(result.limitations.some(value => /整个投放计划/.test(value)));
  assert.ok(result.limitations.some(value => /manual/.test(value)));
  const zeroClicks = evaluateOptimizationContext(feedbackContext({ metricSnapshot: { id: 'm2', source: 'oceanengine', dataFresh: true, impressions: 2000, clicks: 0 } }));
  assert.equal(zeroClicks.status, 'experiment_ready'); assert.equal(zeroClicks.signal.value, 0);
});
test('ROI uses observed money and sample gates rather than claimed ratio', () => {
  const goodMetric = { id: 'metric-1', source: 'oceanengine', dataFresh: true, spend: 100, revenue: 150, conversions: 5, hasConversion: true, roi: 99 };
  const result = evaluateOptimizationContext(feedbackContext({ metricSnapshot: goodMetric }));
  assert.equal(result.status, 'experiment_ready'); assert.equal(result.signal.type, 'roi');
  assert.equal(result.signal.value, 1.5); assert.equal(result.belowTarget, true);
  for (const incomplete of [{ spend: 49 }, { conversions: 2 }, { revenue: null }, { hasConversion: false }]) {
    assert.equal(evaluateOptimizationContext(feedbackContext({ metricSnapshot: { ...goodMetric, ...incomplete } })).status, 'collect_data');
  }
});
test('feedback variants are revision-specific one-axis proposals retaining factual sources', () => {
  const input = { project: { id: 'p1', productName: '羊毛外套', facts: ['成分：100% 羊毛', '颜色：蓝色'], objective: 'purchase' }, assets: [{ id: 'a1', filename: 'coat.jpg', mimeType: 'image/jpeg' }, { id: 'a2', filename: 'back.jpg', mimeType: 'image/jpeg' }] };
  const metric = { id: 'metric-1', source: 'oceanengine', dataFresh: true, impressions: 2000, clicks: 50 };
  const first = buildCreativePlan(input, { optimizationContext: feedbackContext({ metricSnapshot: metric }) });
  const second = buildCreativePlan(input, { optimizationContext: feedbackContext({ iteration: 2, metricSnapshot: metric }) });
  assert.equal(first.optimization.status, 'experiment_ready');
  assert.equal(first.variants[0].experiment.axis, 'reference');
  assert.equal(first.variants[1].experiment.axis, 'headline');
  assert.equal(first.variants[2].experiment.axis, 'layout.theme');
  assert.equal(first.variants[1].headline, '成分：100% 羊毛');
  assert.equal(second.variants[1].headline, '颜色：蓝色');
  assert.equal(first.variants[0].headline, first.variants[2].headline);
  assert.equal(first.variants[0].body, first.variants[2].body);
  assert.notEqual(first.variants[0].layout.theme, first.variants[2].layout.theme);
  assert.equal(first.variants[0].layout.theme, first.variants[1].layout.theme);
  for (let index = 0; index < first.variants.length; index++) {
    const variant = first.variants[index];
    assert.notEqual(variant.id, second.variants[index].id);
    assert.equal(variant.format, 'portrait'); assert.deepEqual(variant.sourceAssetIds, ['a1']);
    assert.equal(variant.experiment.status, 'proposed'); assert.equal(variant.experiment.requiresNewPerformanceData, true);
    assert.equal(variant.optimizationTaskId, 'task-1');
    assert.ok(variant.evidence.some(item => item.source === 'performance.metric' && item.sourceId === 'metric-1'));
    assert.ok(!/保暖|收益|提高转化|限时优惠/.test(variant.headline + variant.body));
  }
  assert.equal(first.variants[1].headline, buildCreativePlan(input, { optimizationContext: feedbackContext({ metricSnapshot: metric }) }).variants[1].headline);
});
test('aggregate campaign data does not turn into creative attribution', () => {
  const metric = { id: 'metric-1', source: 'oceanengine', dataFresh: true, impressions: 2000, clicks: 50, scope: 'creative', creativeId: 'creative-a' };
  assert.equal(evaluateOptimizationContext(feedbackContext({ metricSnapshot: metric })).scope, 'campaign');
  const explicitlyAttributed = { ...metric, attribution: { scope: 'creative', creativeId: 'creative-a', verified: true } };
  assert.equal(evaluateOptimizationContext(feedbackContext({ metricSnapshot: explicitlyAttributed })).scope, 'creative');
  assert.equal(evaluateOptimizationContext(feedbackContext({ metricSnapshot: { ...explicitlyAttributed, attribution: { ...explicitlyAttributed.attribution, creativeId: 'other-project' } } })).scope, 'campaign');
});
test('no new product facts means visual experiments rather than fabricated benefit hooks', () => {
  const result = buildCreativePlan({ project: { id: 'p1', title: '衣服' }, assets: [{ id: 'a1', filename: 'cloth.jpg', mimeType: 'image/jpeg' }] }, { optimizationContext: feedbackContext({ metricSnapshot: { id: 'm1', source: 'manual', dataFresh: true, impressions: 2000, clicks: 20 } }) });
  assert.equal(result.variants[1].experiment.axis, 'layout.theme');
  assert.equal(result.variants[2].experiment.axis, 'layout.theme');
  assert.ok(result.variants.every(variant => variant.headline === '衣服' && variant.body === ''));
  assert.equal(new Set(result.variants.map(variant => variant.layout.theme)).size, 3);
});
test('video feedback stays pending actual external production instead of repeated clip pretending optimized', () => {
  const input = { project: { id: 'p1', title: '游戏', facts: ['实录画面'] }, assets: [{ id: 'v1', filename: 'gameplay.mp4', mimeType: 'video/mp4' }] };
  const context = feedbackContext({ metricSnapshot: { id: 'm1', source: 'oceanengine', dataFresh: true, impressions: 2000, clicks: 20 } });
  const feedback = buildCreativePlan(input, { optimizationContext: context });
  assert.equal(feedback.optimization.status, 'experiment_ready');
  assert.equal(feedback.optimization.needsExternalVideoProduction, true);
  assert.ok(feedback.variants.every(variant => variant.processing.supported === false
    && variant.processing.needs_external_video_production === true
    && variant.processing.status === 'needs_external_video_production'));
  const initial = buildCreativePlan(input);
  assert.ok(initial.variants.every(variant => variant.processing.supported === true && variant.processing.status === 'needs_segment_selection'));
});
