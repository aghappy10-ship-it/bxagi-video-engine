import { notifyClientSessionChange } from './client-session-events.mjs';

export class ApiError extends Error {
    status: number;
    reasons: string[];
    code?: string;
    constructor(message: string, status: number, reasons: string[] = [], code?: string) { super(message); this.status = status; this.reasons = reasons; this.code = code; }
}
function apiPath(path: string): string {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path))
        throw new ApiError('请求地址不属于当前工作区。', 0, [], 'platform_request_scope');
    const base = 'https://platform.invalid';
    const url = new URL(`/api/v2${path}`, base);
    if (url.origin !== base || (url.pathname !== '/api/v2' && !url.pathname.startsWith('/api/v2/')) || url.hash)
        throw new ApiError('请求地址不属于当前工作区。', 0, [], 'platform_request_scope');
    return `${url.pathname}${url.search}`;
}
function isObject(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export async function platformRequest<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const target = apiPath(path);
    const response = await fetch(target, { ...options, credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const body = isObject(data) ? data : {};
        const error = isObject(body.error) ? body.error : {};
        const reasons = body.reasons || error.reasons || (isObject(body.details) ? body.details.reasons : undefined);
        const message = [typeof body.error === 'string' ? body.error : undefined, error.message, body.message].find(value => typeof value === 'string' && value.trim());
        const code = [error.code, body.code].find(value => typeof value === 'string' && value.trim());
        throw new ApiError(message || `请求失败 (${response.status})`, response.status, Array.isArray(reasons) ? reasons.filter(value => typeof value === 'string') : [], code);
    }
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (!isObject(data) || !contentType || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(contentType))
        throw new ApiError('服务返回格式异常，请刷新核实当前状态。', response.status, [], 'platform_invalid_response');
    const pathname = target.split('?', 1)[0];
    if ((pathname === '/api/v2/bxagi/auth/login' && data.connected === true) || (pathname === '/api/v2/bxagi/auth/logout' && data.connected === false))
        notifyClientSessionChange();
    return data as T;
}
export function post<T = any>(path: string, data: unknown): Promise<T> { return platformRequest<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
export function upload<T = any>(path: string, file: Blob, filename: string, metadata?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(filename) };
    if (metadata)
        headers['X-Creative-Metadata'] = encodeURIComponent(JSON.stringify(metadata));
    return platformRequest<T>(path, { method: 'POST', headers, body: file });
}
export function contentUrl(type: 'assets' | 'creatives', id: string) { return `/api/v2/${type}/${encodeURIComponent(id)}/content`; }
export async function contentBlob(type: 'assets' | 'creatives', id: string) {
    const response = await fetch(contentUrl(type, id), { credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store' });
    if (!response.ok)
        throw new ApiError('无法读取素材文件', response.status);
    return response.blob();
}
export function saveBlob(blob: Blob, filename: string) { const href = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = href; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000); }
export async function downloadContent(type: 'assets' | 'creatives', id: string, filename: string) { saveBlob(await contentBlob(type, id), filename); }
