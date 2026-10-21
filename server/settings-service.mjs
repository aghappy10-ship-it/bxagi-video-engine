import { AdsError, createProviderClient } from './adapters/provider-http.mjs';
import { connectionSummary, decryptConnectionSecrets, encryptConnectionSecrets } from './adapters/connection-secrets.mjs';

const DEFAULT_PREFERENCES = Object.freeze({ workspaceName: '', timezone: 'Asia/Shanghai', reportFrequency: 'daily', notifyOnDelivery: true, notifyOnFailure: true, notifyOnBudget: true });
const ACTIVE_STATES = new Set(['active', 'running', 'launching', 'submitting', 'pausing', 'needs_reconciliation']);
const fail = (code, message, status = 400) => new AdsError(code, message, { status });
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, name, limit, { optional = true } = {}) {
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw fail('settings_invalid', `${name}格式无效`);
  const result = value.trim();
  if (!optional && !result) throw fail('settings_invalid', `请填写${name}`);
  return result;
}
function publicSettings(row) {
  const source = object(row?.preferences) ? row.preferences : {};
  return { displayName: row?.displayName || '', notificationEmail: row?.notificationEmail || '', preferences: Object.fromEntries(Object.entries(DEFAULT_PREFERENCES).map(([key, value]) => [key, source[key] ?? value])), emailVerified: false, emailDeliveryAvailable: false };
}
function hasUnfinishedExecution(campaign) {
  return ACTIVE_STATES.has(campaign.status) || Boolean(campaign.operationId || campaign.remoteState?.writePending || campaign.remoteState?.uncertain);
}

/** Settings are tenant scoped; channel checks are read-only and never imply launch permission. */
export function createSettingsService({ repository: repo, env = {}, fetcher = fetch }) {
  async function owned(userId, id) {
    const row = await repo.getConnection(userId, id);
    if (!row || row.userId && row.userId !== userId) throw fail('not_found', '连接不存在', 404);
    return row;
  }
  async function bindings(userId, id) {
    if (typeof repo.listCampaignsByConnection === 'function') return repo.listCampaignsByConnection(userId, id);
    return (await repo.listCampaigns(userId)).filter(row => row.connectionId === id);
  }
  async function audit(userId, id, action, details = {}) { await repo.addAudit(userId, { action, entityType: 'connection', entityId: id, details }); }
  async function getPreferences(userId) { return publicSettings(await repo.getPreferences(userId)); }
  async function savePreferences(userId, input) {
    if (!object(input)) throw fail('settings_invalid', '设置内容无效');
    const current = await getPreferences(userId), patch = { displayName: current.displayName, notificationEmail: current.notificationEmail, preferences: { ...current.preferences } };
    if (Object.hasOwn(input, 'displayName')) patch.displayName = text(input.displayName, '显示名称', 60);
    if (Object.hasOwn(input, 'notificationEmail')) {
      patch.notificationEmail = text(input.notificationEmail, '通知邮箱', 254);
      if (patch.notificationEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.notificationEmail)) throw fail('settings_invalid', '请填写有效的通知邮箱');
    }
    if (Object.hasOwn(input, 'preferences')) {
      if (!object(input.preferences)) throw fail('settings_invalid', '工作区偏好格式无效');
      const preferences = input.preferences;
      if (Object.hasOwn(preferences, 'workspaceName')) patch.preferences.workspaceName = text(preferences.workspaceName, '工作区名称', 80);
      if (Object.hasOwn(preferences, 'timezone')) {
        const timezone = text(preferences.timezone, '时区', 80, { optional: false });
        try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone }).format(); } catch { throw fail('settings_invalid', '请选择有效的时区'); }
        patch.preferences.timezone = timezone;
      }
      if (Object.hasOwn(preferences, 'reportFrequency')) {
        if (!['daily', 'weekly', 'off'].includes(preferences.reportFrequency)) throw fail('settings_invalid', '汇报频率无效');
        patch.preferences.reportFrequency = preferences.reportFrequency;
      }
      for (const key of ['notifyOnDelivery', 'notifyOnFailure', 'notifyOnBudget']) if (Object.hasOwn(preferences, key)) {
        if (typeof preferences[key] !== 'boolean') throw fail('settings_invalid', '通知开关必须为布尔值');
        patch.preferences[key] = preferences[key];
      }
    }
    const saved = await repo.savePreferences(userId, patch);
    await repo.addAudit(userId, { action: 'settings.preferences_updated', entityType: 'preferences', entityId: userId, details: { fields: Object.keys(input).filter(key => ['displayName', 'notificationEmail', 'preferences'].includes(key)) } });
    return publicSettings(saved || patch);
  }
  async function updateConnection(userId, id, input) {
    if (!object(input)) throw fail('settings_invalid', '连接内容无效');
    const connection = await owned(userId, id), patch = {};
    if (input.channel !== undefined && input.channel !== connection.channel) throw fail('connection_channel_immutable', '更换渠道请新增连接');
    if (Object.hasOwn(input, 'label')) patch.label = text(input.label, '账户标签', 100);
    if (Object.hasOwn(input, 'accountId')) {
      patch.accountId = text(input.accountId, '账户 ID', 200, { optional: false });
      if (patch.accountId !== connection.accountId && (await bindings(userId, id)).length) throw fail('connection_in_use', '该连接已关联投放，请为其他账户新增连接', 409);
    }
    if (Object.hasOwn(input, 'appId')) patch.appId = text(input.appId, '应用 ID', 200);
    if (Object.hasOwn(input, 'expiresAt')) {
      if (input.expiresAt === null && connection.channel !== 'oceanengine') patch.expiresAt = null;
      else if (!input.expiresAt || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) throw fail('credentials_expired', '授权到期时间必须晚于当前时间');
      else patch.expiresAt = new Date(input.expiresAt).toISOString();
    }
    const accessToken = input.accessToken === undefined || input.accessToken === '' ? null : text(input.accessToken, '访问凭证', 16000, { optional: false });
    const appSecret = input.appSecret === undefined || input.appSecret === '' ? null : text(input.appSecret, '应用密钥', 16000, { optional: false });
    if (accessToken !== null || appSecret !== null) {
      const previous = await decryptConnectionSecrets(connection.secretsCiphertext, env.APP_ENCRYPTION_KEY);
      patch.secretsCiphertext = await encryptConnectionSecrets({ ...previous, ...(accessToken !== null ? { accessToken } : {}), ...(appSecret !== null ? { appSecret } : {}) }, env.APP_ENCRYPTION_KEY);
    }
    if (input.status !== undefined && !['configured', 'disabled'].includes(input.status)) throw fail('settings_invalid', '连接状态无效');
    if (input.status === 'disabled') return disableConnection(userId, id);
    const changedCredentials = accessToken !== null || appSecret !== null || patch.accountId !== undefined && patch.accountId !== connection.accountId || patch.appId !== undefined && patch.appId !== connection.appId || patch.expiresAt !== undefined && patch.expiresAt !== connection.expiresAt;
    if (input.status === 'configured' || changedCredentials) patch.status = connection.status === 'disabled' && input.status !== 'configured' ? 'disabled' : 'configured';
    const updated = await repo.updateConnection(userId, id, patch);
    await audit(userId, id, 'connection.updated', { fields: Object.keys(patch).map(key => key === 'secretsCiphertext' ? 'credentials' : key), credentialsChanged: accessToken !== null || appSecret !== null });
    return connectionSummary(updated);
  }
  async function testConnection(userId, id) {
    const connection = await owned(userId, id);
    if (connection.status === 'disabled') throw fail('connection_disabled', '请先启用连接，再验证读取权限', 409);
    if (connection.channel !== 'oceanengine') return { connection: connectionSummary(connection), status: 'adapter_pending', verified: false, message: connection.channel === 'volcano' ? '火山模型与媒体服务配置已保存；服务适配器尚未接入。' : '凭据已保存；该渠道适配器尚未接入，无法验证授权。' };
    if (!connection.expiresAt || !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now()) throw fail('credentials_expired', '授权已到期或未填写有效期，请更新后再验证', 409);
    if (!/^[1-9]\d{0,18}$/.test(connection.accountId) || BigInt(connection.accountId) > 9223372036854775807n) throw fail('settings_invalid', '巨量广告账户 ID 必须为精确正整数');
    const secrets = await decryptConnectionSecrets(connection.secretsCiphertext, env.APP_ENCRYPTION_KEY);
    if (!secrets.accessToken) throw fail('credentials_missing', '请补充访问凭证', 409);
    const request = createProviderClient({ accessToken: secrets.accessToken, fetcher });
    try {
      const result = await request('/open_api/v3.0/project/list/', { query: { advertiser_id: connection.accountId, fields: ['project_id', 'advertiser_id'], page: 1, page_size: 1 } });
      if (!Array.isArray(result.list) || result.list.some(row => String(row.advertiser_id) !== String(connection.accountId))) throw fail('invalid_provider_response', '渠道未返回可核实的账户项目列表', 502);
      const current = await owned(userId, id);
      if (current.status === 'disabled' || current.secretsCiphertext !== connection.secretsCiphertext || current.accountId !== connection.accountId || current.expiresAt !== connection.expiresAt) throw fail('connection_changed', '连接配置已变更，请重新验证最新凭据', 409);
      const updated = await repo.updateConnection(userId, id, { status: 'verified' });
      const checkedAt = new Date().toISOString();
      await audit(userId, id, 'connection.read_verified', { checkedAt, requestId: result._requestId, scope: 'project_read' });
      return { connection: connectionSummary(updated), status: 'read_verified', verified: true, checkedAt, message: '账户项目读取验证通过；实际投放权限和配置将在启动时检查。' };
    } catch (error) {
      const current = await owned(userId, id);
      if (current.status !== 'disabled' && current.secretsCiphertext === connection.secretsCiphertext && current.accountId === connection.accountId) await repo.updateConnection(userId, id, { status: 'configured' });
      await audit(userId, id, 'connection.verification_failed', { code: error instanceof AdsError ? error.code : 'verification_failed' });
      throw error;
    }
  }
  async function disableConnection(userId, id) {
    await owned(userId, id);
    if ((await bindings(userId, id)).some(hasUnfinishedExecution)) throw fail('connection_in_use', '请先在投放中心暂停关联投放，并核对未完成的渠道操作，再停用连接', 409);
    const updated = await repo.updateConnection(userId, id, { status: 'disabled' });
    await audit(userId, id, 'connection.disabled');
    return connectionSummary(updated);
  }
  async function deleteConnection(userId, id) {
    await owned(userId, id);
    if ((await bindings(userId, id)).length) throw fail('connection_in_use', '该连接关联投放记录，无法删除；可在暂停投放后停用连接', 409);
    await repo.deleteConnection(userId, id);
    await audit(userId, id, 'connection.deleted');
    return { deleted: true, id };
  }
  return { getPreferences, savePreferences, updateConnection, testConnection, disableConnection, deleteConnection };
}
