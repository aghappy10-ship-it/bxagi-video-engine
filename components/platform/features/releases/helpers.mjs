export function parseDramaNames(text) {
    const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const names = [...new Set(lines)];
    return { names, duplicates: lines.length - names.length };
}

export function taskViewFromHash(hash) {
    const [screen, query = ''] = String(hash || '').split('?');
    if (screen === '#employees') return 'employees';
    if (screen !== '#tasks') return null;
    const view = new URLSearchParams(query).get('view');
    return view === 'releases' || view === 'employees' ? view : 'tasks';
}

// Quote every cell and neutralize spreadsheet formulas, including leading whitespace.
export function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s\uFEFF]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
}

export function releaseBatchCsv(batch, projects = []) {
    const projectNames = new Map(projects.map(project => [project.id, project.title]));
    const modes = { paid: '付费', free: '免费', both: '付费 + 免费' };
    const release = { unverified: '待核验', available: '已核验可投放', unavailable: '不可投放' };
    const auth = { unverified: '待核验', confirmed: '已确认', denied: '未获授权' };
    const rows = [['剧名', '素材目标（条）', '已交付成品（条）', '推广模式', '素材包', '发布状态', '授权状态', '日预算（元）', '付费链 ID', '付费链接', '付费起始集', '免费链 ID', '免费链接', '广告起始集', '资料状态', '待补齐项', '异常阶段', '异常说明']];
    for (const item of batch.items) rows.push([
        item.title, item.targetCount, item.readiness.creativeCount, modes[item.promotionMode],
        projectNames.get(item.projectId) || item.projectId || '', release[item.releaseStatus], auth[item.authorizationStatus],
        item.dailyBudget, promotionIdCell(item.paidLink.id), item.paidLink.url, item.paidLink.startEpisode,
        promotionIdCell(item.freeLink.id), item.freeLink.url, item.freeLink.startEpisode,
        item.readiness.ready ? '资料齐备（未发起投放）' : '待补齐', item.readiness.blockers.join('；'), item.failureStage, item.failureReason,
    ]);
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function promotionIdCell(value) {
    const id = String(value || '');
    return /^\d+$/.test(id) ? `'${id}` : id;
}

export function exportFilename(title) {
    return `${String(title || '剧目准备清单').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80)}.csv`;
}
