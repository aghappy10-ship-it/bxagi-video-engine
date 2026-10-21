import { BarChart3, BrainCircuit, FolderOpen, GalleryVerticalEnd, LayoutDashboard, ListTodo, Settings, Target, TrendingUp } from 'lucide-react';
import type { Screen } from '../types';

export const WORKSPACE_NAV = [
  { id: 'overview', label: '工作台', english: 'Workspace', group: '首页', module: '', Icon: LayoutDashboard },
  { id: 'projects', label: '原始素材管理', english: 'Source packages', group: '素材与生产', module: 'M1', Icon: FolderOpen },
  { id: 'tasks', label: '任务中心', english: 'Tasks & workforce', group: '素材与生产', module: 'M2', Icon: ListTodo },
  { id: 'library', label: '优化素材中心', english: 'Creative library', group: '素材与生产', module: 'M3', Icon: GalleryVerticalEnd },
  { id: 'campaigns', label: '投放中心', english: 'Delivery workspace', group: '投放与经营', module: 'M4', Icon: Target },
  { id: 'performance', label: '数据中心', english: 'Business analytics', group: '投放与经营', module: 'M5', Icon: BarChart3 },
  { id: 'decisions', label: '经营决策', english: 'Business decisions', group: '投放与经营', module: 'M6', Icon: TrendingUp },
  { id: 'settings', label: '系统管理', english: 'Settings & connections', group: '系统与进化', module: 'M7', Icon: Settings },
  { id: 'evolution', label: '进化中心', english: 'Learning & strategy', group: '系统与进化', module: 'M8', Icon: BrainCircuit },
] as const;

export const SCREEN_DESCRIPTIONS: Record<Screen, string> = {
  overview: '从原始素材到真实投放，掌握整个工作区的进展。',
  projects: '上传原始素材包，或接入内容源同步剧目资料。',
  tasks: '安排员工生产，批量整理剧目、推广链接与投放准备。',
  library: '集中预览优化后的成品，确认版本并准备投放。',
  employees: '从官方市场选择员工，查看能力与执行条件。',
  campaigns: '按素材包组织投放，每条成品拥有独立预算、状态和效果。',
  performance: '汇总所有素材包与渠道的效果，比较趋势和投入产出。',
  decisions: '结合真实效果，决定当前的预算、素材与投放方向。',
  settings: '管理个人资料、BXAGI 身份、内容源与投放渠道。',
  evolution: '沉淀素材经验与投放策略，让下一轮决策有据可循。',
};
export function screenFromHash(hash: string): Screen {
  const value = hash.replace(/^#/, '').split(/[/?]/)[0];
  if (value === 'employees') return 'employees';
  return WORKSPACE_NAV.some(item => item.id === value) ? value as Screen : 'overview';
}
export function screenDefinition(screen: Screen) {
  return WORKSPACE_NAV.find(item => item.id === (screen === 'employees' ? 'tasks' : screen)) || WORKSPACE_NAV[0];
}
