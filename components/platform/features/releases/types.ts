export type PromotionMode = 'paid' | 'free' | 'both';
export type PromotionLink = { id: string; url: string; startEpisode: number | null };
export type ReleaseItem = {
    id: string;
    title: string;
    targetCount: number;
    promotionMode: PromotionMode;
    projectId: string;
    releaseStatus: 'unverified' | 'available' | 'unavailable';
    authorizationStatus: 'unverified' | 'confirmed' | 'denied';
    priority: 'high' | 'normal' | 'low';
    dailyBudget: number;
    paidLink: PromotionLink;
    freeLink: PromotionLink;
    failureStage: string;
    failureReason: string;
    verifiedAt: string | null;
    readiness: { ready: boolean; blockers: string[]; sourceCount: number; creativeCount: number };
};
export type ReleaseBatch = {
    id: string; title: string; revision: number; createdAt: string; updatedAt: string;
    items: ReleaseItem[];
    summary: { total: number; targetCount: number; ready: number; blocked: number };
};
export type ReleaseEdit = Omit<ReleaseItem, 'id' | 'readiness' | 'verifiedAt'>;
export const PROMOTION_LABELS: Record<PromotionMode, string> = { paid: '付费', free: '免费', both: '付费 + 免费' };
export const PRIORITY_LABELS: Record<ReleaseItem['priority'], string> = { high: '优先准备', normal: '正常', low: '暂缓' };
export const FAILURE_STAGES: Record<string, string> = { '': '无异常记录', source: '原始素材', production: '素材生产', authorization: '授权核验', link: '推广链接', delivery: '投放配置' };
