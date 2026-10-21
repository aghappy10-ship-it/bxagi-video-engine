/** Only the explicit catalog route selects the catalog; selected packages do not override it. */
export function projectViewFromHash(hash = '') {
    const [screen, query = ''] = String(hash).replace(/^#/, '').split('?', 2);
    return screen === 'projects' && new URLSearchParams(query).get('view') === 'catalog' ? 'catalog' : 'packages';
}

export function catalogRunActive(status) {
    return !!status?.run && ['queued', 'running', 'waiting'].includes(status.run.status);
}

/** Respect the server's rate-limit deadline; absent background health uses page-driven work. */
export function catalogNextPoll(status, now = Date.now()) {
    if (!status) return { action: 'status', delay: 10000 };
    const nextCycle = status.run?.status === 'completed' && status.source.autoSync && !!status.run.nextRunAt;
    if ((catalogRunActive(status) || nextCycle) && status.source.configured && status.integration.configured && !status.scheduler.running) {
        const next = Date.parse(status.run.nextRunAt || '');
        return { action: 'advance', delay: Math.max(1000, Number.isFinite(next) ? next - now : 0) };
    }
    return { action: 'status', delay: catalogRunActive(status) ? 4000 : 15000 };
}

export const CATALOG_RUN_LABELS = {
    queued: '已排队', running: '正在抓取', waiting: '等待下一页', paused: '已暂停', completed: '本轮完成', failed: '抓取失败',
};

export const CATALOG_CONNECTION_LABELS = {
    unconfigured: '未配置', pending: '已保存 · 待验证', verified: '读取已验证', error: '连接异常',
};

// Never render upstream error bodies: they can contain request parameters or credentials.
export function catalogErrorMessage(error, fallback = '操作未完成，请稍后重试。') {
    const code = String(error?.code || '');
    if (error?.status === 401) return '登录已失效，请重新登录 BXAGI。';
    if (error?.status === 403) return '当前账号没有访问该内容源的权限。';
    if (error?.status === 429 || code.includes('rate_limit')) return '请求较多，请稍后重试。';
    if (code.includes('contract') || code.includes('integration')) return '常读取数接口待接通，请联系平台管理员。';
    if (code.includes('secret') || code.includes('credential')) return '请检查分销商标识与签名密钥。';
    return fallback;
}
