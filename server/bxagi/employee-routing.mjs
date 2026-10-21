/** Deterministic market-role ranking; execution still requires verified activation. */
import { isMarketEmployee, assertMarketEmployee } from '../bxagi-market-eligibility.mjs';

const fail = (status, message, code = 'bxagi_workflow_error') => Object.assign(new Error(message), {
  status,
  code
});
const clean = (value, max = 2000) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function publicEmployee(employee, role) {
  return {
    id: employee.id,
    providerId: employee.providerId,
    name: employee.name,
    role,
    provider: 'bxagi',
    scene: 'general',
    description: employee.description,
    skills: employee.skills || [],
    usable: employee.usable,
    engine: 'bxagi',
    marketId: employee.marketId,
    resourceType: employee.resourceType,
    marketVerified: employee.marketVerified,
    activationState: employee.activationState,
    sourceVerified: employee.sourceVerified,
    capabilities: [],
    capabilityNotice: '岗位与技能来自BXAGI；任务能力由实际执行及交付验证'
  };
}

/** Rank actual execution roles, not generic mentions in a sales description. */
export function scoreBxagiMarketEmployee(employee, {
  kind,
  scene = 'general'
} = {}) {
  if (!isMarketEmployee(employee)) return 0;
  const name = clean(employee.name, 400),
    skills = (Array.isArray(employee.skills) ? employee.skills : []).filter(s => typeof s === 'string').join(' '),
    category = clean(employee.category, 400),
    description = clean(employee.description, 12000);
  const buyingName = /广告(?:采买|购买|投放|运营)|程序化(?:广告)?(?:采买|购买|投放)|付费媒体(?:采买|购买|投放|运营|优化)|媒体(?:采买|购买)|投放(?:优化|运营|管理|专家|员工)|流量优化|paid[ -]media[ -](?:buyer|buying|manager|operations)|programmatic[ -](?:buyer|buying)|media[ -]buy(?:er|ing)|ad(?:s|vertising)?[ -](?:buyer|buying|operations|campaign[ -](?:manager|management))/i;
  const productionName = /视频(?:优化|剪辑|制作|编辑|生成)|(?:推广|广告|短剧|影视)(?:.{0,6})(?:剪辑|制作|生成)|素材(?:剪辑|制作|生产|设计|优化|生成)|(?:图像|图片|图文|海报|商品图)(?:生成|制作|优化|设计)|效果图|(?:产品|商品|服装|服饰|西服)(?:.{0,5})(?:渲染|素材|视觉|摄影)|(?:广告|营销)(?:素材|视频)?(?:设计|创意|文案)|video[ -](?:editor|editing|production|optimization|creation)|image[ -](?:generation|creation)|creative[ -](?:production|designer)|product[ -]render/i;
  const buyingWorkflow = /programmatic[-_/]buying(?:[-_/]workflow)?|paid[-_/]media[-_/](?:buying|delivery|campaign[-_/](?:management|optimization))|media[-_/]buying|(?:ad|ads|advertising)[-_/](?:buying|campaign[-_/](?:management|optimization)|delivery)|(?:广告采买|广告投放|投放优化|付费媒体投放)(?:工作流|流程)/i;
  const productionWorkflow = /ffmpeg[-_/](?:cut|edit)|promo[-_/]cutting[-_/]workflow|video[-_/](?:edit(?:ing)?|cut(?:ting)?|production|optimization|creation|generation)|image[-_/](?:generation|creation|editing)|jdsuit[-_/]ai[-_/]render|suit[-_/]render[-_/]flow|(?:素材制作|视频剪辑|视频优化|图像生成|产品渲染)(?:工作流|流程)?/i;
  const roleName = kind === 'buying' ? buyingName : productionName,
    workflow = kind === 'buying' ? buyingWorkflow : productionWorkflow;
  const nonExecutor = kind === 'buying' && /审计|追踪|跟踪|归因|搜索词|分析|策略|audit|track(?:ing|er)?|attribution|search[ _-]query|analy(?:st|sis)|strateg(?:ist|y)/i.test(name);
  const nameMatch = roleName.test(name) && !nonExecutor,
    workflowMatch = workflow.test(skills);
  const multimedia = kind !== 'buying' && /multimedia[-_/]creation/i.test(skills);
  // Description/category alone never authorize a role: generic assistants often
  // mention every department, while game/course/mechanical design is not ad production.
  if (!nameMatch && !workflowMatch) return 0;
  let score = (nameMatch ? 110 : 0) + (workflowMatch ? 90 : multimedia ? 65 : 0) + (roleName.test(category) || workflow.test(category) ? 12 : 0) + (roleName.test(description) || workflow.test(description) ? 3 : 0);
  if (/助理|助手|assistant|generalist/i.test(name)) score -= 45;
  if (kind !== 'buying' && /教练|辅导|讲师|培训|coach|tutor|trainer/i.test(name)) score -= 70;
  const sceneWords = {
    apparel: /服装|服饰|西服|西装|衣服|商品|电商|apparel|clothing|suit[-_/ ]render|jdsuit|commerce/i,
    drama: /短剧|剧集|影视|drama|episode|promo[-_/]cutting/i,
    game: /游戏|试玩|game|gaming/i
  };
  const scope = [name, skills, category].join(' ');
  if (sceneWords[scene]?.test(scope)) score += 80;
  else if (kind !== 'buying' && Object.entries(sceneWords).some(([key, pattern]) => key !== scene && pattern.test(scope))) score -= 60;
  return Math.max(0, score);
}

export function chooseBxagiEmployee(employees, {
  kind,
  scene = 'general'
} = {}) {
  const available = employees.filter(isMarketEmployee);
  if (!available.length) throw fail(409, 'BXAGI员工市场暂无已验证候选；历史会话不能作为新任务员工', 'bxagi_market_employee_required');
  const ranked = available.map((employee, index) => {
    const score = scoreBxagiMarketEmployee(employee, {
      kind,
      scene
    });
    return {
      employee,
      score,
      index
    };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked[0].score === 0) throw fail(409, '员工市场暂无与本任务匹配的岗位，请配置对应市场员工', 'bxagi_market_role_unmatched');
  assertMarketEmployee(ranked[0].employee);
  return {
    employee: ranked[0].employee,
    mode: 'rules',
    basis: '规则路由：优先官方市场具体岗位及制作/投放工作流技能，按素材场景匹配；能力等待实际交付验证'
  };
}
