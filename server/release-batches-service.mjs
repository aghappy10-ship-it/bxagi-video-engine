import { createReleaseBatchRepository } from './release-batches-repository.mjs';
import { assertCreativeDeliveryComplete } from './creative-delivery-eligibility.mjs';
import { projectReadyCreatives } from '../components/platform/automation.mjs';
import { fail, requireRow } from './platform/protocol.mjs';

const MODES = ['paid', 'free', 'both'];
const STAGES = ['', 'source', 'production', 'authorization', 'link', 'delivery'];
const EDITABLE = ['revision', 'title', 'targetCount', 'promotionMode', 'projectId', 'releaseStatus', 'authorizationStatus', 'priority', 'dailyBudget', 'paidLink', 'freeLink', 'failureStage', 'failureReason'];
const has = (value, key) => Object.hasOwn(value, key);
const emptyLink = () => ({ id: '', url: '', startEpisode: null });

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, '请求包含不支持的字段', 'invalid_release_fields');
}
function text(value, label, max, { required = false, multiline = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/).test(value)) fail(400, `${label}格式错误或超过 ${max} 字`, 'invalid_release_field');
  const result = value.trim();
  if (required && !result) fail(400, `请填写${label}`, 'invalid_release_field');
  return result;
}
function integer(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(400, `${label}应为 1–${max} 的整数`, 'invalid_release_number');
  return value;
}
function choice(value, allowed, label) {
  if (!allowed.includes(value)) fail(400, `${label}无效`, 'invalid_release_field');
  return value;
}
function budget(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000 || Math.round(value * 100) / 100 !== value) fail(400, '日预算应为 0–1,000,000 元，最多两位小数', 'invalid_release_budget');
  return value;
}
function promotionLink(value) {
  fields(value, ['id', 'url', 'startEpisode']);
  const id = text(value.id ?? '', '推广链 ID', 80), url = text(value.url ?? '', '推广链接', 8000);
  const startEpisode = value.startEpisode == null ? null : integer(value.startEpisode, '起始集数', 10000);
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { fail(400, '请填写常读提供的 aweme://playlet 推广链接', 'invalid_release_link'); }
    if (parsed.protocol !== 'aweme:' || parsed.hostname !== 'playlet' || parsed.username || parsed.password || parsed.port || !['', '/'].includes(parsed.pathname) || parsed.hash || ![...parsed.searchParams].some(([key, val]) => key && val) || /%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(url)) fail(400, '仅支持带推广参数的 aweme://playlet 链接', 'invalid_release_link');
  }
  return { id, url, startEpisode };
}
const completeLink = link => Boolean(link?.id && link?.url && Number.isSafeInteger(link.startEpisode) && link.startEpisode > 0);

export function createReleaseBatchService({ repository, DB } = {}) {
  const batches = createReleaseBatchRepository(DB);
  const audit = (userId, row, action, details) => repository.addAudit(userId, { action, entityType: 'release_batch', entityId: row.id, details });

  async function present(userId, rows) {
    const facts = await batches.projectFacts(userId, rows.flatMap(row => row.details.items.map(item => item.projectId)));
    const jobs = new Map(facts.jobs.map(job => [job.id, job]));
    const prepared = new Map();
    for (const project of facts.projects.values()) {
      const candidates = projectReadyCreatives(project.id, facts);
      let count = 0;
      const countedFiles = new Set();
      for (const creative of candidates) {
        try {
          await assertCreativeDeliveryComplete({ repository: { getJob: async (owner, id) => owner === userId ? jobs.get(id) || null : null }, userId, creative });
          if (countedFiles.has(creative.objectKey)) continue;
          countedFiles.add(creative.objectKey);
          count++;
        } catch (error) {
          if (!['bxagi_delivery_incomplete', 'creative_not_primary'].includes(error.code)) throw error;
        }
      }
      prepared.set(project.id, { sourceCount: project.sourceCount, creativeCount: count });
    }
    return rows.map(row => {
      const items = row.details.items.map(item => {
        const counts = prepared.get(item.projectId) || { sourceCount: 0, creativeCount: 0 }, blockers = [];
        if (!item.projectId || !facts.projects.has(item.projectId)) blockers.push('未关联素材包');
        else {
          if (!counts.sourceCount) blockers.push('原始素材待上传');
          if (facts.projects.get(item.projectId).sourceState?.status === 'uploading') blockers.push('当前素材批次尚未上传完成');
          if (counts.creativeCount < item.targetCount) blockers.push(`完整主成品 ${counts.creativeCount}/${item.targetCount}`);
        }
        if (item.releaseStatus !== 'available') blockers.push(item.releaseStatus === 'unavailable' ? '剧目不可投放' : '上线状态待核实');
        if (item.authorizationStatus !== 'confirmed') blockers.push(item.authorizationStatus === 'denied' ? '投放授权未通过' : '投放授权待核实');
        if (['paid', 'both'].includes(item.promotionMode) && !completeLink(item.paidLink)) blockers.push('付费推广链待补全');
        if (['free', 'both'].includes(item.promotionMode) && !completeLink(item.freeLink)) blockers.push('免费推广链待补全');
        if (!item.dailyBudget) blockers.push('日预算待设置');
        if (item.failureStage || item.failureReason) blockers.push(item.failureReason || '存在未处理的问题');
        return { ...item, readiness: { ready: blockers.length === 0, blockers, ...counts } };
      });
      const ready = items.filter(item => item.readiness.ready).length;
      return { id: row.id, title: row.details.title, revision: row.details.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, items, summary: { total: items.length, targetCount: items.reduce((sum, item) => sum + item.targetCount, 0), ready, blocked: items.length - ready } };
    });
  }

  return {
    async list(userId) { return { batches: await present(userId, await batches.list(userId)) }; },
    async create(userId, body) {
      fields(body, ['title', 'names', 'targetCount', 'promotionMode']);
      const title = text(body.title, '批次名称', 100, { required: true });
      const targetCount = integer(body.targetCount, '每剧目标素材数', 30), promotionMode = choice(body.promotionMode, MODES, '推广类型');
      if (!Array.isArray(body.names) || body.names.length < 1 || body.names.length > 100) fail(400, '每个批次请导入 1–100 个剧名', 'invalid_release_names');
      const names = [...new Set(body.names.map(name => text(name, '剧名', 200, { required: true })))];
      const items = names.map(name => ({ id: crypto.randomUUID(), title: name, targetCount, promotionMode, projectId: '', releaseStatus: 'unverified', authorizationStatus: 'unverified', priority: 'normal', dailyBudget: 0, paidLink: emptyLink(), freeLink: emptyLink(), failureStage: '', failureReason: '', verifiedAt: null }));
      const row = await repository.createJob(userId, { projectId: '', employeeId: '', type: 'release_batch', status: 'draft', details: { version: 1, title, revision: 1, items } });
      await audit(userId, row, 'release_batch.created', { count: items.length, targetCount: items.length * targetCount, promotionMode });
      return { batch: (await present(userId, [row]))[0] };
    },
    async updateItem(userId, batchId, itemId, body) {
      const row = requireRow(await batches.get(userId, batchId));
      const previous = requireRow(row.details.items.find(item => item.id === itemId));
      fields(body, EDITABLE);
      integer(body.revision, '批次版本', Number.MAX_SAFE_INTEGER);
      if (row.details.revision !== body.revision) fail(409, '该批次已被更新，请刷新后再保存', 'release_batch_conflict');
      const next = { ...previous };
      if (has(body, 'title')) next.title = text(body.title, '剧名', 200, { required: true });
      if (has(body, 'targetCount')) next.targetCount = integer(body.targetCount, '每剧目标素材数', 30);
      if (has(body, 'promotionMode')) next.promotionMode = choice(body.promotionMode, MODES, '推广类型');
      if (has(body, 'projectId')) {
        next.projectId = text(body.projectId, '素材包 ID', 160);
        if (next.projectId) requireRow(await repository.getProject(userId, next.projectId));
      }
      if (has(body, 'releaseStatus')) next.releaseStatus = choice(body.releaseStatus, ['unverified', 'available', 'unavailable'], '上线状态');
      if (has(body, 'authorizationStatus')) next.authorizationStatus = choice(body.authorizationStatus, ['unverified', 'confirmed', 'denied'], '授权状态');
      if (next.releaseStatus !== previous.releaseStatus || next.authorizationStatus !== previous.authorizationStatus) next.verifiedAt = next.releaseStatus !== 'unverified' && next.authorizationStatus !== 'unverified' ? new Date().toISOString() : null;
      // A new drama identity cannot inherit an older title's manual verification.
      if (next.title !== previous.title) { next.releaseStatus = 'unverified'; next.authorizationStatus = 'unverified'; next.verifiedAt = null; }
      if (has(body, 'priority')) next.priority = choice(body.priority, ['high', 'normal', 'low'], '优先级');
      if (has(body, 'dailyBudget')) next.dailyBudget = budget(body.dailyBudget);
      if (has(body, 'paidLink')) next.paidLink = promotionLink(body.paidLink);
      if (has(body, 'freeLink')) next.freeLink = promotionLink(body.freeLink);
      if (next.paidLink.url && next.paidLink.url === next.freeLink.url) fail(400, '付费与免费推广链应分别填写，不能使用同一链接', 'duplicate_release_link');
      if (has(body, 'failureStage')) next.failureStage = choice(body.failureStage, STAGES, '问题阶段');
      if (has(body, 'failureReason')) next.failureReason = text(body.failureReason, '问题原因', 1000, { multiline: true });
      if (row.details.items.some(item => item.id !== itemId && item.title === next.title)) fail(409, '该批次已有同名剧目', 'duplicate_release_title');
      const details = { ...row.details, revision: row.details.revision + 1, items: row.details.items.map(item => item.id === itemId ? next : item) };
      const updated = await batches.update(userId, row.id, body.revision, details);
      if (!updated) fail(409, '该批次已被更新，请刷新后再保存', 'release_batch_conflict');
      await audit(userId, updated, 'release_batch.item_updated', { itemId, revision: details.revision, fields: Object.keys(body).filter(key => key !== 'revision') });
      return { batch: (await present(userId, [updated]))[0] };
    }
  };
}
