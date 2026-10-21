export type Screen = 'overview' | 'projects' | 'tasks' | 'library' | 'employees' | 'campaigns' | 'performance' | 'decisions' | 'settings' | 'evolution';
export type Row = Record<string, any> & {
    id: string;
};
export type Variant = Row & {
    title: string;
    headline: string;
    body: string;
    cta: string;
    format: string;
    sourceAssetIds?: string[];
    employeeId?: string;
};
export type BxagiNode = {
    nodeId: string;
    status: string;
    gatewayConnected: boolean | null;
    lastHeartbeatAt?: string | null;
    heartbeatAgeSeconds?: number | null;
    heartbeatState?: string;
    idleTimeoutMinutes?: number | null;
    cloudGateway?: boolean | null;
    stale?: boolean;
};
export type BxagiNodeState = {
    provider: string;
    checkedAt: string;
    observationStatus: 'verified' | 'unavailable';
    liveVerified: boolean;
    nodes: BxagiNode[];
    nodeCount: number;
    statusCounts: Record<string, number>;
    history: Record<string, any>[];
    lastSuccessfulAt?: string | null;
    persistenceStatus?: string;
    errorCode?: string;
};
export type Bootstrap = {
    user: {
        id: string;
        displayName?: string;
    };
    deliveryGroups?: Row[];
    decisions?: Row[];
    strategies?: Row[];
    audit?: Row[];
    preferences?: {
        displayName?: string;
        notificationEmail?: string;
        emailVerified?: boolean;
        emailDeliveryAvailable?: boolean;
        preferences?: { workspaceName?: string; timezone?: string; reportFrequency?: 'daily' | 'weekly' | 'off'; notifyOnDelivery?: boolean; notifyOnFailure?: boolean; notifyOnBudget?: boolean };
    };
    projects: Row[];
    assets: Row[];
    creatives: Row[];
    campaigns: Row[];
    connections: Row[];
    employees: Row[];
    metrics: Row[];
    optimizationTasks: Row[];
    jobs: Row[];
    automationFlows: Row[];
    capabilities: Record<string, any>;
    bxagi: {
        connected: boolean;
        profile?: Record<string, any>;
        user?: Record<string, any>;
        status?: string;
        error?: string | {
            code?: string;
            message?: string;
        };
        protocolVerified?: boolean;
        liveVerified?: boolean;
        jobs?: Row[];
    };
    remoteJobs?: Row[];
};
export const EMPTY: Bootstrap = { user: { id: '' }, projects: [], assets: [], creatives: [], campaigns: [], connections: [], employees: [], metrics: [], optimizationTasks: [], jobs: [], automationFlows: [], capabilities: {}, bxagi: { connected: false, status: 'disconnected' } };
export const SCENES: Record<string, string> = { apparel: '服装与商品', drama: '短剧与内容', game: '游戏与应用', general: '通用广告' };
export const OBJECTIVES: Record<string, string> = { purchase: '商品购买', install: '应用安装', lead: '获取线索', views: '内容观看' };
export const CHANNELS: Record<string, string> = { oceanengine: '巨量引擎', kuaishou: '磁力引擎', tencent: '腾讯广告', custom: '自定义渠道' };
export const FORMAT: Record<string, string> = { portrait: '竖版 9:16', square: '方形 1:1', landscape: '横版 16:9' };
export function sceneName(scene: string) { return SCENES[scene] || scene || '等待识别'; }
export function employeeName(data: Bootstrap, id?: string) { const employee = data.employees.find(e => e.id === id); return employee?.name || employee?.title || id || '上传后自动分配'; }
export function money(value: unknown) { const n = Number(value); return Number.isFinite(n) ? new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 }).format(n) : '—'; }
export function label(row: Row) { return row.title || row.name || row.filename || row.originalName || row.id; }
export function mime(row: Row) { return row.mimeType || row.mime || row.contentType || ''; }
export function bytes(value: unknown) { const n = Number(value) || 0; return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`; }
export function dateLabel(value: unknown) {
    if (!value)
        return '—';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
