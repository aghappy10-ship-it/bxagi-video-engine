import { AdsError } from './provider-http.mjs';
function bytesFromBase64(value) { try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { throw new AdsError('encryption_key_invalid', 'APP_ENCRYPTION_KEY 必须是 32 字节的 base64 或 hex 密钥', { status: 503 }); } }
function toBase64(bytes) { return btoa(String.fromCharCode(...bytes)); }
async function keyFor(value) {
  if (!value || typeof value !== 'string') throw new AdsError('encryption_unconfigured', '请先配置 APP_ENCRYPTION_KEY 后保存广告账户密钥', { status: 503 });
  const raw = /^[a-f0-9]{64}$/i.test(value) ? Uint8Array.from(value.match(/../g), n => parseInt(n, 16)) : bytesFromBase64(value);
  if (raw.byteLength !== 32) throw new AdsError('encryption_key_invalid', 'APP_ENCRYPTION_KEY 必须为 32 字节', { status: 503 });
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
export async function encryptConnectionSecrets(payload, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('bxagi-connection-v1') }, await keyFor(key), new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({ v: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) });
}
export async function decryptConnectionSecrets(ciphertext, key) {
  const imported = await keyFor(key);
  try {
    const envelope = JSON.parse(ciphertext); if (envelope.v !== 1) throw new Error('Unknown version');
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytesFromBase64(envelope.iv), additionalData: new TextEncoder().encode('bxagi-connection-v1') }, imported, bytesFromBase64(envelope.ciphertext));
    return JSON.parse(new TextDecoder().decode(clear));
  } catch { throw new AdsError('credentials_unreadable', '广告账户密钥解密失败，请检查运行密钥或重新授权', { status: 503 }); }
}
export function connectionSummary(row) {
  if (!row) return null;
  const { id, channel, accountId, label, expiresAt, appId, status, createdAt, updatedAt } = row;
  return { id, channel, accountId, label, expiresAt, appId, status, createdAt, updatedAt, configured: Boolean(row.secretsCiphertext), expired: !expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now() };
}
