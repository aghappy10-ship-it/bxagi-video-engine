import { contentBlob, upload } from './api';
import { FORMAT, type Row, type Variant } from './types';
export async function producePlanFiles({ projectId, projectTitle, variants, employeeId, optimizationTaskId, onProgress }: {
    projectId: string;
    projectTitle: string;
    variants: Variant[];
    employeeId?: string;
    optimizationTaskId?: string;
    onProgress?: (message: string) => void;
}) {
    const { renderImageCreative } = await import('../../shared/creative-renderer.mjs');
    const creativeIds: string[] = [];
    const skipped: string[] = [];
    for (const [index, variant] of variants.entries()) {
        if (variant.processing?.supported === false) {
            skipped.push(variant.processing.reason || '员工未接通此素材处理工具');
            continue;
        }
        const metadata = { variantId: variant.id, title: variant.title, format: variant.format, employeeId: employeeId || variant.employeeId, sourceAssetIds: variant.sourceAssetIds || [], optimizationTaskId };
        if (variant.mediaType === 'image') {
            const sourceId = variant.sourceAssetIds?.[0];
            if (!sourceId)
                throw new Error('生产方案缺少实际图片来源。');
            onProgress?.(`员工正在生成 ${FORMAT[variant.format] || variant.format} 实际素材。`);
            const result = await renderImageCreative({ sourceBlob: await contentBlob('assets', sourceId), variant, onProgress: () => { } });
            const saved = await upload(`/projects/${projectId}/creatives`, result.blob, `${projectTitle}-${variant.format}${optimizationTaskId ? `-优化-${index + 1}` : ''}.png`, { ...metadata, validation: result.validation, width: result.width, height: result.height });
            creativeIds.push(saved.creative.id);
        }
        else if (variant.mediaType === 'text') {
            onProgress?.('员工正在保存基于真实事实的文案文件。');
            const blob = new Blob([[variant.headline, variant.body, variant.cta].filter(Boolean).join('\n\n')], { type: 'text/plain' });
            const saved = await upload(`/projects/${projectId}/creatives`, blob, `${projectTitle}-${variant.format}${optimizationTaskId ? `-优化-${index + 1}` : ''}.txt`, { ...metadata, validation: 'operator-reviewed' });
            creativeIds.push(saved.creative.id);
        }
        else {
            skipped.push(variant.processing?.reason || '视频由已连接媒体执行器处理，或使用浏览器的明确时间段导出。');
        }
    }
    return { creativeIds, skipped };
}
