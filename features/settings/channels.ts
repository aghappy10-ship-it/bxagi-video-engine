export const CONNECTION_CHANNELS = {
    oceanengine: { title: '巨量引擎', type: '广告投放', accountLabel: '广告主账户 ID', tokenLabel: 'Access Token', expiryRequired: true, description: '连接广告主账户，启动前核验素材、预算及账户权限。' },
    tencent: { title: '腾讯广告', type: '广告投放', accountLabel: '广告账户 ID', tokenLabel: 'Access Token', expiryRequired: true, description: '支持保存账户配置，投放适配器待接入。' },
    kuaishou: { title: '磁力引擎', type: '广告投放', accountLabel: '广告账户 ID', tokenLabel: 'Access Token', expiryRequired: true, description: '支持保存账户配置，投放适配器待接入。' },
    volcano: { title: '火山引擎', type: '模型与媒体服务', accountLabel: '项目 / 资源标识', tokenLabel: 'API Key / Access Key', expiryRequired: false, description: '用于模型与媒体处理服务；服务适配器待接入。' },
    custom: { title: '其他渠道', type: '待适配渠道', accountLabel: '业务账户标识', tokenLabel: '访问凭证', expiryRequired: false, description: '保存接入资料，执行与验证能力需单独适配。' },
} as const;
export type ConnectionChannel = keyof typeof CONNECTION_CHANNELS;
export function channelDefinition(channel: string) { return CONNECTION_CHANNELS[channel as ConnectionChannel] || CONNECTION_CHANNELS.custom; }
export function connectionState(connection: Record<string, any>) {
    if (connection.status === 'disabled') return { label: '已停用', tone: 'neutral' };
    const hasExpiry = Boolean(connection.expiresAt);
    if (hasExpiry && (connection.expired || Date.parse(connection.expiresAt) <= Date.now())) return { label: '授权已到期', tone: 'amber' };
    if (connection.status === 'verified') return { label: '读取权限已验证', tone: 'green' };
    return { label: '凭据已保存', tone: 'blue' };
}
