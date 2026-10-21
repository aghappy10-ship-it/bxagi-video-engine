/** Production requests, not detected highlights or promises about advertising results. */
export const PRODUCTION_PRESETS = Object.freeze([
  { id: 'highlights', label: '高光精剪', imageLabel: '画面聚焦', description: '围绕真实素材中的关键片段，形成不同叙事重点。', imageDescription: '围绕已有画面，分别突出主体、细节与使用情境。' },
  { id: 'openings', label: '开头对照', imageLabel: '标题对照', description: '保持主体内容一致，只改变开头表达，便于后续比较。', imageDescription: '保持主体与版式一致，只改变事实标题的表达。' },
  { id: 'benefits', label: '卖点对照', imageLabel: '卖点对照', description: '同一份资料分别呈现核心特点、细节证据和场景价值。', imageDescription: '用不同的信息重点表达已有卖点，保留真实外观。' },
]);

const FORMATS = { portrait: '竖屏 9:16', square: '方形 1:1', landscape: '横屏 16:9' };
const GOALS = {
  highlights: {
    video: [
      '关键片段：选取素材中真实存在的冲突、核心动作或主体展示，保留必要上下文。',
      '转折递进：用真实铺垫与后续变化构成完整片段，重点改变选段和节奏。',
      '悬念收尾：从已有内容中选择有后续期待的结束点，不捏造剧情或误导因果。',
    ],
    image: [
      '主体聚焦：从真实输入中选择清晰主体，以简洁构图突出主要信息。',
      '细节聚焦：使用原始资料中可核实的细节，改变取景与信息层级。',
      '情境聚焦：优先采用输入中已有的使用场景；没有场景资料时改用不同的主体构图。',
    ],
  },
  openings: {
    video: [
      '动作开场：用原素材中的关键动作或冲突开启视频，其余主体段落与其他版本保持一致。',
      '原声开场：用原素材已有的关键对白或声音引入，保持后续主体段落一致。',
      '主题开场：用用户已提供的事实制作简短主题字卡，保持后续主体段落一致。',
    ],
    image: [
      '直接表达：用用户事实写出简洁明确的主题标题，固定主体、版式和配色。',
      '细节表达：从同一事实中突出可核实细节，仅改变标题，保留其余画面。',
      '情境表达：仅在已有事实支持时改用场景化标题，保留主体、版式和配色。',
    ],
  },
  benefits: {
    video: [
      '核心特点：优先呈现用户资料中的主要卖点或内容主题，用真实画面支撑。',
      '细节证据：围绕已提供的细节展示依据，不添加未知参数或效果承诺。',
      '场景价值：用已有素材解释适用情境或故事看点，不补造人物、情节或使用效果。',
    ],
    image: [
      '核心特点：围绕一个已提供的主要卖点安排标题与真实主体画面。',
      '细节证据：使用可核实的细节画面与事实说明，不添加未知参数。',
      '场景价值：以已有事实表达适用情境；资料不足时用另一种版式呈现同一事实。',
    ],
  },
};

export function initialProductionInstructions(saved = {}, optimizationTask) {
  return String(optimizationTask
    ? optimizationTask.metadata?.instructions || optimizationTask.reason || ''
    : saved.instructions || '');
}

export function buildProductionPreset({ presetId, targetCount, mediaType, format }) {
  const preset = PRODUCTION_PRESETS.find(item => item.id === presetId);
  if (!preset || !Number.isInteger(targetCount) || targetCount < 1 || targetCount > 3 || !['video', 'image'].includes(mediaType) || !Object.hasOwn(FORMATS, format)) {
    throw new Error('请选择有效的制作方案、1–3条成品及画面规格。');
  }
  const label = mediaType === 'image' ? preset.imageLabel : preset.label;
  const mediaLabel = mediaType === 'video' ? '视频' : '图片';
  const goals = GOALS[presetId][mediaType].slice(0, targetCount).map((goal, index) => ({ number: index + 1, goal }));
  const instructions = [
    `制作方案：${label}。本批交付 ${targetCount} 条${mediaLabel}主成品，画幅为${FORMATS[format]}。`,
    '逐条制作目标：',
    ...goals.map(item => `${item.number}. ${item.goal}`),
    '先检查真实输入，再决定可用的画面、声音与事实；这些是制作目标，不是已经识别出的片段。',
    '保留真实主体和事实，不编造价格、优惠、参数、人物关系、剧情、销量或广告效果。资料不足时在制作说明中指出限制，不用虚构信息凑齐版本。',
    '每条主成品应有上述实际差异，不得复制同一文件凑数。',
    mediaType === 'video'
      ? '交付真实 MP4 与 PNG 封面，并在制作说明中逐条记录实际使用的来源文件、关键来源时间段及剪辑差异。'
      : '交付真实 PNG，并在制作说明中逐条记录实际使用的来源文件、事实与画面差异。',
    '只执行素材制作，不创建广告或改变投放预算；成品完成后仍需人工审核。',
  ].join('\n');
  return { id: preset.id, label, goals, instructions, summary: `${targetCount} 条${mediaLabel} · ${FORMATS[format]}` };
}
