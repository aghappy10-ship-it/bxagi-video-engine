export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (!quoted && field === '') quoted = true;else if (quoted) quoted = false;else field += ch;
    } else if (ch === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('CSV 引号未闭合，请检查导出文件。');
  row.push(field);
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
export function csvNumber(v, name, row, optional = false) {
  const text = String(v ?? '').trim().replace(/^[¥￥$]/, '').replace(/,/g, '');
  if (!text && optional) return null;
  const n = Number(text);
  if (!text || !Number.isFinite(n) || n < 0) throw new Error(`CSV 第 ${row} 行的${name}无效，需为非负数。`);
  return n;
}
export function validateReportImport(workspace, text, filename) {
  const file = {
    name: filename
  };
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('CSV 没有数据行。');
  if (rows.length > 20001) throw new Error('一次最多导入 20,000 条记录。');
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = names => headers.findIndex(h => names.includes(h));
  const map = {
    campaign: col(['campaign', 'campaign_name', '计划', '计划名称', '广告计划']),
    spend: col(['spend', '消耗', '花费', 'cost']),
    revenue: col(['revenue', '收入', '归因收入']),
    conversions: col(['conversions', 'conversion', '转化', '转化数', '转化次数']),
    date: col(['date', '日期']),
    fresh: col(['data_fresh', '数据新鲜度'])
  };
  if (map.campaign < 0 || map.spend < 0 || map.revenue < 0) throw new Error('CSV 必须包含 campaign / 计划、spend / 消耗、revenue / 收入表头。');
  const parsed = rows.slice(1).map((r, i) => {
    const name = (r[map.campaign] || '').trim();
    if (!name) throw new Error(`CSV 第 ${i + 2} 行缺少计划名称。`);
    const conversions = map.conversions >= 0 ? csvNumber(r[map.conversions], '转化', i + 2, true) : null;
    if (conversions !== null && !Number.isInteger(conversions)) throw new Error(`CSV 第 ${i + 2} 行转化数必须为整数。`);
    return {
      name: name.slice(0, 200),
      spend: csvNumber(r[map.spend], '消耗', i + 2),
      revenue: csvNumber(r[map.revenue], '收入', i + 2),
      conversions,
      hasConversion: conversions !== null,
      date: map.date >= 0 ? String(r[map.date] || '').slice(0, 100) : '',
      dataFresh: map.fresh < 0 || !['false', '0', '否', '过期', 'stale'].includes(String(r[map.fresh] || '').trim().toLowerCase())
    };
  });
  if (workspace.metrics.length + parsed.length > 20000) throw new Error('导入将超过 20,000 条报表容量，请先导出并清理旧记录。');
  const campaignById = new Map(workspace.campaigns.map(campaign => [campaign.id, campaign]));
  const campaignNames = new Set(workspace.campaigns.filter(campaign => !campaign.demo).map(campaign => campaign.name));
  const newNames = new Set(parsed.filter(row => !campaignNames.has(row.name)).map(row => row.name));
  if (workspace.campaigns.length + newNames.size > 1000) throw new Error('导入将超过 1,000 个投放计划容量，请分开保存工作区。');
  const signature = row => JSON.stringify([row.name, row.date, row.spend, row.revenue, row.conversions]);
  const existing = new Set(workspace.metrics.filter(metric => !metric.demo && metric.source === file.name).map(metric => signature({
    ...metric,
    name: campaignById.get(metric.campaignId)?.name
  })));
  const signatures = new Set();
  for (const row of parsed) {
    const key = signature(row);
    if (signatures.has(key)) throw new Error('CSV 含完全重复的计划/日期/指标行，请先去重。');
    signatures.add(key);
    if (existing.has(key)) throw new Error('该文件已有相同记录，已拒绝重复导入。请更换为新增报表。');
  }
  return parsed;
}
