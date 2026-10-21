/* BXAGI deterministic business rules. No model inference or ad execution. */
const terminal = /[。！？.!?…][”’"'）)\]】]*\s*$/u;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const number = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export function fmtTime(seconds) {
  const n = Math.max(0, Math.floor(number(seconds)));
  const h = Math.floor(n / 3600);
  return `${h ? h + ':' : ''}${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
function srtTime(raw) {
  const m = raw.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!m || +m[2] > 59 || +m[3] > 59) throw new Error(`字幕时间格式无效：${raw}`);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}
export function parseSrt(srt) {
  if (typeof srt !== 'string' || !srt.trim()) throw new Error('请导入包含时间轴的 SRT 字幕。');
  if (srt.length > 10_000_000) throw new Error('字幕文件过大，请限制在 10 MB 以内。');
  const blocks = srt.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const rows = blocks.map((block, index) => {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex(x => x.includes('-->'));
    if (timeIndex < 0) throw new Error(`第 ${index + 1} 个字幕块缺少时间轴。`);
    const match = lines[timeIndex].match(/^\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{3})(?:\s+.*)?$/);
    if (!match) throw new Error(`第 ${index + 1} 个字幕块的时间轴格式有误。`);
    const start = srtTime(match[1]),
      end = srtTime(match[2]);
    const text = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]*>/g, '').trim();
    if (end <= start) throw new Error(`第 ${index + 1} 个字幕块的结束时间必须大于开始时间。`);
    if (!text) throw new Error(`第 ${index + 1} 个字幕块没有正文。`);
    return {
      id: index + 1,
      start,
      end,
      text
    };
  });
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].start < rows[i - 1].start || rows[i].start < rows[i - 1].end - 0.001) {
      throw new Error(`第 ${i + 1} 个字幕块倒序或与上一块重叠，请先修正字幕。`);
    }
  }
  return rows;
}
function cleanSegments(segments) {
  if (!Array.isArray(segments)) throw new Error('字幕数据格式无效。');
  return segments.map((s, i) => {
    const row = {
      ...s,
      start: number(s.start, NaN),
      end: number(s.end, NaN),
      text: String(s.text || '')
    };
    if (!finite(row.start) || !finite(row.end) || row.start < 0 || row.end <= row.start) throw new Error(`字幕 ${i + 1} 的时间范围无效。`);
    if (i > 0 && row.start < number(segments[i - 1].end, Infinity) - .001) throw new Error(`字幕 ${i + 1} 倒序或与上一段重叠。`);
    return row;
  });
}
export function planClips(segments, options = {}) {
  const rows = cleanSegments(segments);
  const count = clamp(Math.floor(number(options.count, 3)), 1, 30);
  const minDuration = clamp(number(options.minDuration, 5), 0.5, 600);
  const maxDuration = clamp(number(options.maxDuration, 45), 0.5, 600);
  if (maxDuration < minDuration) throw new Error('最长时长必须大于或等于最短时长。');
  const strategy = ['hook', 'narrative', 'selling'].includes(options.strategy) ? options.strategy : 'hook';
  const duration = number(options.duration, Infinity);
  const patterns = {
    hook: /为什么|竟然|原来|没想到|但是|突然|秘密|真相|居然|到底|[？！!?]/gu,
    narrative: /因为|所以|于是|终于|后来|结果|因此|但是|然而/gu,
    selling: /价格|优惠|省|只需|限时|解决|效果|功能|特点|体验|适合|好处|购买/gu
  };
  const target = Math.min(maxDuration, Math.max(minDuration, 22));
  // Score subtitle windows with prefix sums; never allocate every candidate's text.
  // Repeated best-window selection preserves the existing greedy ranking while
  // keeping memory proportional to the transcript and requested clip count.
  const sentenceEnds = rows.map(row => terminal.test(row.text));
  const keywordPrefix = [0];
  for (const row of rows) {
    keywordPrefix.push(keywordPrefix.at(-1) + (row.text.match(patterns[strategy]) || []).length);
  }
  const selected = [];
  while (selected.length < count) {
    let best = null;
    const occupied = [...selected].sort((a, b) => a.start - b.start);
    let occupiedIndex = 0;
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && !sentenceEnds[i - 1]) continue;
      const start = rows[i].start;
      while (occupiedIndex < occupied.length && occupied[occupiedIndex].end <= start) occupiedIndex++;
      const next = occupied[occupiedIndex];
      if (next && start >= next.start && start < next.end) continue;
      const limit = Math.min(duration, start + maxDuration, next?.start ?? Infinity);
      for (let j = i; j < rows.length && rows[j].end <= limit + .001; j++) {
        const length = rows[j].end - start;
        if (length < minDuration - .001 || !sentenceEnds[j]) continue;
        // Tolerance must never permit a genuine overlap with an already chosen clip.
        if (next && rows[j].end > next.start) break;
        const matches = keywordPrefix[j + 1] - keywordPrefix[i];
        const score = 50 + matches * 7 - Math.abs(length - target) * .4 - i * .001;
        if (!best || score > best.score || score === best.score && (start < best.start || start === best.start && rows[j].end < best.end)) {
          best = {
            start,
            end: rows[j].end,
            first: i,
            last: j,
            score,
            strategy
          };
        }
      }
    }
    if (!best) break;
    selected.push(best);
  }
  return selected.sort((a, b) => a.start - b.start).map((item, index) => {
    const text = rows.slice(item.first, item.last + 1).map(row => row.text).join(' ');
    return {
      id: `clip-${index + 1}-${Math.round(item.start * 1000)}`,
      title: `${strategy === 'hook' ? '冲突钩子' : strategy === 'selling' ? '卖点提取' : '连贯叙事'} ${String(index + 1).padStart(2, '0')} · ${text.slice(0, 20)}`,
      start: item.start,
      end: item.end,
      text,
      strategy,
      score: Math.round(item.score * 10) / 10
    };
  });
}
export function validateClip(clip, segments = [], duration = Infinity) {
  const start = number(clip?.start, NaN),
    end = number(clip?.end, NaN);
  const rangeOk = finite(start) && finite(end) && start >= 0 && end > start && end <= duration + .001;
  const checks = [{
    name: '时间范围',
    status: rangeOk ? 'pass' : 'fail',
    detail: rangeOk ? '片段在原片时间范围内。' : '开始、结束时间无效，或片段超出原片。'
  }];
  let rows;
  try {
    rows = cleanSegments(segments);
  } catch (e) {
    checks.push({
      name: '字幕句界',
      status: 'fail',
      detail: e.message
    });
    return {
      passed: false,
      checks,
      errors: checks.filter(x => x.status === 'fail').map(x => x.detail)
    };
  }
  if (!rows.length) {
    checks.push({
      name: '字幕句界',
      status: 'unverified',
      detail: '没有字幕，无法确认是否在台词句中切断；仅可导出待复核草稿。'
    });
  } else {
    const first = rows.findIndex(x => Math.abs(x.start - start) <= .08);
    const last = rows.findIndex(x => Math.abs(x.end - end) <= .08);
    const boundaryOk = first >= 0 && last >= first;
    const sentenceOk = boundaryOk && (first === 0 || terminal.test(rows[first - 1].text)) && terminal.test(rows[last].text);
    checks.push({
      name: '字幕块边界',
      status: boundaryOk ? 'pass' : 'fail',
      detail: boundaryOk ? '开始与结束均对齐字幕时间轴（容差 80 ms）。' : '切点未对齐字幕块边界。'
    });
    checks.push({
      name: '完整句子标点',
      status: sentenceOk ? 'pass' : 'fail',
      detail: sentenceOk ? '句首与句末有字幕结构及句末标点依据。' : '字幕块边界不等于完整句子；请检查前一句结尾和片段末尾的句末标点。'
    });
  }
  checks.push({
    name: '成片媒体检查',
    status: 'unverified',
    detail: '须在生产服务完成编码、全片解码和时长检查后确认。'
  });
  const sentencePassed = checks.filter(x => x.name !== '成片媒体检查').every(x => x.status === 'pass');
  return {
    passed: false,
    sentencePassed,
    checks,
    errors: checks.filter(x => x.status === 'fail').map(x => x.detail)
  };
}
export function evaluateCampaign(campaign = {}) {
  const amount = value => typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
  const budget = amount(campaign.dailyBudget ?? campaign.daily_budget);
  const spend = amount(campaign.spend),
    revenue = amount(campaign.revenue);
  const fresh = (campaign.dataFresh ?? campaign.data_fresh) !== false;
  const hasConversion = (campaign.hasConversion ?? campaign.has_conversion) === true;
  const conversions = campaign.conversions == null || campaign.conversions === '' ? null : Number(campaign.conversions);
  const max = Math.min(1000, Math.max(0, number(campaign.maxDailyBudget ?? campaign.max_daily_budget, 1000)));
  const target = Math.max(.01, number(campaign.targetRoi ?? campaign.target_roi, 1.5));
  const minSpend = Math.max(0, number(campaign.minSpend ?? campaign.min_spend, 100));
  const result = (action, reason, newBudget = finite(budget) ? budget : 0, roi = null) => ({
    action,
    reason,
    newBudget,
    roi
  });
  if (budget < 0 || spend < 0 || revenue < 0 || !finite(budget) || !finite(spend) || !finite(revenue)) return result('hold', '金额无效，请修正数据。');
  if (!fresh) return result('hold', '数据已过期或拉取失败，本轮保持预算，不做决策。');
  if (budget > max) return result('approval', `当前日预算超过 ${max} 元，需要人工审核预算上限。`);
  if (!hasConversion || conversions === null || !finite(conversions) || conversions < 0) {
    return spend >= budget && budget > 0 ? result('pause', '没有有效转化回传，ROI 未知；已达到日预算，仅建议按消耗节奏暂停。') : result('hold', '没有有效转化回传，ROI 未知；仅按消耗节奏观察。');
  }
  const roi = spend > 0 ? revenue / spend : null;
  if (spend < minSpend || roi === null) return result('hold', '样本消耗不足，保持预算继续观察。', budget, roi);
  if (roi < target * .65) return result('pause', `ROI ${roi.toFixed(2)} 低于止损线 ${(target * .65).toFixed(2)}，建议暂停。`, budget, roi);
  if (roi >= target * 1.15 && conversions >= 3) {
    const next = Math.round(budget * 1.2 * 100) / 100;
    if (next > max) return result('approval', `建议加量至 ${next} 元将超过上限 ${max} 元，须人工确认。`, next, roi);
    return result('increase', `ROI ${roi.toFixed(2)} 且转化样本达到 3 次，建议预算增加 20%。`, next, roi);
  }
  return result('hold', '指标处于观察区间，保持预算。', budget, roi);
}
export function csv(rows) {
  if (!Array.isArray(rows) || !rows.length) return '\uFEFF';
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    let s = value == null ? '' : String(value);
    // Avoid executing formula cells when the report is opened in spreadsheet software.
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  return '\uFEFF' + [keys.map(cell).join(','), ...rows.map(row => keys.map(k => cell(row[k])).join(','))].join('\r\n');
}
export const productLines = [{
  id: 'studio',
  name: 'BX Studio',
  subtitle: '把原片变成可复核、可交付的素材',
  features: ['原片与 SRT 导入', '句界剪辑方案', '真实视频导出', '生产队列与质量报告'],
  available: ['浏览器本地草稿剪辑', 'SRT 规则选段与句界校验', 'FFmpeg MP4 编码与媒体完整性验收', '本地生产服务、任务留痕', '模型选段与本地 ASR 接口代码（需另行配置）'],
  pending: ['模型凭证、ASR 本地权重与实际推理验证', '模型剧情理解与语义验收', '解说撰写、TTS 配音与混音', '多用户权限与 GPU 节点调度'],
  delivery: '浏览器工作台 + 单节点本地生产服务',
  metering: '原片分钟、合格素材数；记录真实成本后核定报价'
}, {
  id: 'ads',
  name: 'BX Ads',
  subtitle: '让预算纪律和运营过程可以追溯',
  features: ['投放计划', '数据导入', '预算规则', '决策记录'],
  available: ['本地投放计划与状态管理', 'CSV 指标导入及导出', 'ROI 未知与数据过期处理', '止损、加量和人工确认建议'],
  pending: ['巨量、快手、腾讯广告官方适配器', '广告主账户授权与平台权限审核', '转化回传和定时拉取', '真实下单、调预算及分钟级监控'],
  delivery: '单租户运营工作台；官方账户接入后扩展执行',
  metering: '管理账户、有效计划与服务费；广告消耗单独结算'
}, {
  id: 'insight',
  name: 'BX Insight',
  subtitle: '从真实数据里找到下一条素材的方向',
  features: ['指标总览', '计划对比', '数据导出', '产线证据'],
  available: ['基于导入数据计算消耗、收入、ROI', '转化缺失显式标记为未知', '素材生产与验收记录查看', '工作区 JSON 备份与恢复'],
  pending: ['素材 ID 与平台创意 ID 自动映射', '有对照组的 A/B 检验', '跨平台归因与去重', '剪辑方法论自动回写'],
  delivery: '与 Studio、Ads 共用工作区和数据口径',
  metering: '数据源及分析服务；因果归因须先验证数据条件'
}];
