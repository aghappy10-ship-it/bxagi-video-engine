/** Scene-aware employee registry. A profile is a routing recipe, not a model claim. */
export const EMPLOYEE_REGISTRY_VERSION = '2.0.0';

export const capabilityCatalog = Object.freeze([
  { id: 'copy.variants', name: '事实文案变体', available: true, status: 'available', runtime: 'rules', inputs: ['text'], outputs: ['text'] },
  { id: 'image.layout', name: '真实图片多画幅排版', available: true, status: 'available', runtime: 'browser-canvas', inputs: ['image'], outputs: ['image/png'] },
  { id: 'video.trim', name: '明确时间段视频剪辑', available: true, status: 'available', runtime: 'browser-mediarecorder', inputs: ['video', 'timestamps'], outputs: ['video/webm', 'video/mp4'] },
  { id: 'campaign.plan', name: '投放计划', available: true, status: 'available', runtime: 'server', inputs: ['objective', 'channel', 'budget'], outputs: ['campaign'] },
  { id: 'budget.guardrails', name: '预算限额', available: true, status: 'available', runtime: 'server', inputs: ['budget', 'performance'], outputs: ['bounded-decision'] },
  { id: 'metrics.evaluate', name: '真实反馈评价', available: true, status: 'available', runtime: 'server', inputs: ['verified-or-labelled-manual-metrics'], outputs: ['decision'] },
  { id: 'optimization.task', name: '素材优化任务', available: true, status: 'available', runtime: 'server', inputs: ['performance'], outputs: ['draft-task'] },
  { id: 'image.vision', name: '图片语义识别', available: false, status: 'needs_model', runtime: 'multimodal-model', inputs: ['image'], outputs: ['scene'] },
  { id: 'audio.transcribe', name: '自动语音识别', available: false, status: 'needs_model', runtime: 'asr', inputs: ['audio', 'video'], outputs: ['transcript'] },
  { id: 'video.semantic_cut', name: '自动语义选段', available: false, status: 'needs_model', runtime: 'model', inputs: ['transcript', 'video'], outputs: ['timestamps'] },
  { id: 'video.generate', name: '生成式视频', available: false, status: 'needs_provider', runtime: 'video-model', inputs: ['prompt'], outputs: ['video'] },
]);
const callableCapabilityIds = new Set(capabilityCatalog.filter(capability => capability.available).map(capability => capability.id));
const productionCapabilities = ['copy.variants', 'image.layout', 'video.trim'];
const buyingCapabilities = ['campaign.plan', 'budget.guardrails', 'metrics.evaluate', 'optimization.task'];
const definitions = [
  ['apparel', '服装商品', ['衣服', '服装', '外套', '短袖', '连衣裙', '衬衫', '裤子', '羽绒服', 'apparel', 'clothing', 't-shirt', 'shirt', 'dress', 'jacket']],
  ['drama', '短剧内容', ['短剧', '电视剧', '剧集', '影视', 'drama', 'episode']],
  ['game', '游戏', ['游戏', '手游', '端游', '玩家', '玩法', 'game', 'gaming', 'gameplay', 'rpg', 'mmorpg']],
  ['general', '通用广告', []],
];

const asText = value => typeof value === 'string' ? value.trim() : '';
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [];
const makeProfile = ([scene, label, keywords], role) => Object.freeze({
  id: `${role}_${scene}`, name: `${label}${role === 'production' ? '素材员工' : '投放员工'}`,
  role, type: role, kind: role, scene, scenes: [scene], keywords,
  version: EMPLOYEE_REGISTRY_VERSION, objectives: ['purchase', 'install', 'lead', 'views'], channels: ['*'],
  capabilities: role === 'production' ? [...productionCapabilities] : [...buyingCapabilities],
  instructions: role === 'production'
    ? `依据用户提供的${label}素材和事实生成多个广告表达。保留来源，禁止新增未经证明的功效、折扣、价格、剧情或游戏机制。`
    : `结合${label}业务、营销目标和渠道权限管理预算。只使用真实反馈；缺少转化数据时保持预算，不推算收益。`,
  capabilityDetails: role === 'production'
    ? { 'copy.variants': 'rules', 'image.layout': 'browser-canvas', 'video.trim': 'browser-mediarecorder' }
    : { 'campaign.plan': 'local-plan', 'budget.guardrails': 'server-guardrail', 'metrics.evaluate': 'verified-or-labelled-manual', 'optimization.task': 'new-draft-request' },
});

export const employeeProfiles = Object.freeze(definitions.flatMap(def => [makeProfile(def, 'production'), makeProfile(def, 'buying')]));

/** Custom scenes are data, never a closed enum or executable user instructions. */
export function normalizeEmployeeProfiles(customProfiles = []) {
  return (Array.isArray(customProfiles) ? customProfiles : []).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const role = raw.role || raw.kind || raw.type;
    if (!['production', 'buying'].includes(role)) return [];
    const scenes = strings(raw.scenes).length ? strings(raw.scenes) : [asText(raw.scene)].filter(Boolean);
    if (!scenes.length) return [];
    // A custom employee cannot advertise code paths that the platform cannot run.
    const capabilities = strings(raw.capabilities).filter(capability => callableCapabilityIds.has(capability));
    return [{
      id: asText(raw.id) || `custom_${role}_${index}`, name: asText(raw.name) || `${scenes[0]}员工`,
      role, type: role, kind: role, scene: scenes[0], scenes,
      keywords: strings(raw.keywords || raw.sceneKeywords), version: asText(raw.version) || '1.0.0',
      objectives: strings(raw.objectives).length ? strings(raw.objectives) : ['*'],
      channels: strings(raw.channels).length ? strings(raw.channels) : ['*'],
      instructions: asText(raw.instructions), capabilities,
      capabilityDetails: raw.capabilityDetails && typeof raw.capabilityDetails === 'object' ? { ...raw.capabilityDetails } : {},
      custom: true,
    }];
  });
}

function keywordFound(text, keyword) {
  const haystack = text.toLocaleLowerCase(), needle = keyword.toLocaleLowerCase();
  if (!/^[a-z0-9 -]+$/i.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(haystack);
}

/** Metadata classification only: MIME/filenames never imply visual understanding. */
export function inferScene(input = {}, customProfiles = []) {
  const extraProfiles = input.customProfiles || customProfiles;
  const registry = [...employeeProfiles, ...normalizeEmployeeProfiles(extraProfiles)];
  const observations = [
    { source: '标题', text: asText(input.title), weight: 3 },
    { source: '产品名称', text: asText(input.productName), weight: 3 },
    { source: '描述', text: asText(input.description), weight: 2 },
    ...strings(input.facts).map(text => ({ source: '用户事实', text, weight: 3 })),
    ...strings(input.filenames).map(text => ({ source: '文件名', text, weight: 1 })),
  ].filter(observation => observation.text);
  const scores = new Map();
  const sceneKeywords = new Map();
  for (const profile of registry.filter(profile => profile.role === 'production' && profile.scene !== 'general')) {
    const existing = sceneKeywords.get(profile.scene) || new Set();
    profile.keywords.forEach(keyword => existing.add(keyword));
    sceneKeywords.set(profile.scene, existing);
  }
  for (const [scene, keywords] of sceneKeywords) {
    const record = { scene, score: 0, basis: [] };
    for (const observation of observations) {
      const hits = [...keywords].filter(keyword => keywordFound(observation.text, keyword));
      if (!hits.length) continue;
      record.score += observation.weight * Math.min(hits.length, 3);
      record.basis.push(`${observation.source}包含「${hits.join('、')}」`);
    }
    scores.set(scene, record);
  }
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score || a.scene.localeCompare(b.scene));
  const winner = ranked[0], runner = ranked[1];
  const ambiguous = winner && runner && runner.score > 0 && winner.score < runner.score * 1.5;
  if (!winner?.score || ambiguous) return {
    scene: 'general', confidence: ambiguous ? 0.3 : 0.2,
    basis: ambiguous ? ['元数据出现多个业务场景，使用通用素材员工。', ...winner.basis, ...runner.basis]
      : ['标题、描述、用户事实和文件名中没有足够的业务线索，使用通用素材员工。'],
    engine: 'rules', needsModel: true,
    mediaTypes: [...new Set(strings(input.mimeTypes))],
  };
  const total = ranked.reduce((sum, record) => sum + record.score, 0);
  return {
    scene: winner.scene, confidence: Math.min(0.92, 0.45 + Math.min(winner.score, 10) * 0.04 + (winner.score / total) * 0.07),
    basis: [...new Set(winner.basis)], engine: 'rules', needsModel: winner.score < 3,
    mediaTypes: [...new Set(strings(input.mimeTypes))],
  };
}

const sceneName = scene => asText(typeof scene === 'object' ? scene?.scene : scene) || 'general';
const matches = (values, target) => values.includes('*') || values.includes(target);

export function selectProductionEmployee(scene, customProfiles = []) {
  const target = sceneName(scene);
  const registry = [...normalizeEmployeeProfiles(customProfiles), ...employeeProfiles];
  const objective = typeof scene === 'object' ? scene.objective : null;
  const channel = typeof scene === 'object' ? scene.channel : null;
  const candidates = registry.filter(profile => profile.role === 'production' && profile.scenes.includes(target)
    && (!objective || matches(profile.objectives, objective)) && (!channel || matches(profile.channels, channel)));
  const score = profile => (objective && profile.objectives.includes(objective) ? 2 : 0)
    + (channel && profile.channels.includes(channel) ? 4 : 0) + (profile.custom ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0]
    || employeeProfiles.find(profile => profile.id === 'production_general');
}

/** Scene, conversion objective and channel all participate in buying assignment. */
export function selectBuyingEmployee({ scene = 'general', objective = 'views', channel = 'custom' } = {}, customProfiles = []) {
  const target = sceneName(scene);
  const registry = [...normalizeEmployeeProfiles(customProfiles), ...employeeProfiles];
  const candidates = registry.filter(profile => profile.role === 'buying'
    && (profile.scenes.includes(target) || profile.scenes.includes('general') || profile.scenes.includes('*'))
    && matches(profile.objectives, objective) && matches(profile.channels, channel));
  const score = profile => (profile.scenes.includes(target) ? 8 : 0)
    + (profile.objectives.includes(objective) ? 2 : 0) + (profile.channels.includes(channel) ? 4 : 0) + (profile.custom ? 1 : 0);
  return candidates.sort((a, b) => score(b) - score(a))[0]
    || employeeProfiles.find(profile => profile.id === 'buying_general');
}

export function employeeCan(profile, capability) {
  return Array.isArray(profile?.capabilities) && profile.capabilities.includes(capability);
}
