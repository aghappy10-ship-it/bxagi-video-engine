'use client';

import { useRef, useState } from 'react';
import { post, upload } from '../../components/platform/api';
import { typedUploadBlob, inspectCreative } from '../../components/platform/uploads.mjs';
import type { Row } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';

type UploadBatch = { id: string; remaining: { file: File; uploadRequestId: string }[]; assetIds: string[]; count: number };
export function useProjectFiles(state: PlatformState, project: Row) {
    const [progress, setProgress] = useState('');
    const [retryCount, setRetryCount] = useState<number | null>(null);
    const pending = useRef<UploadBatch | null>(null);
    const importing = useRef(false);
    const uploadLimit = 64 * 1024 * 1024;
    const uploadLimitMiB = Math.round(uploadLimit / 1024 / 1024);
    function checkFiles(files: File[]) {
        if (!files.length) return false;
        if (!state.data.bxagi.connected) { state.openBxagiLogin(); return false; }
        const oversized = files.find(file => file.size > uploadLimit);
        if (oversized) { state.setError(`${oversized.name} 超过单文件 ${uploadLimitMiB} MiB 上限，请压缩或分段后上传。`); return false; }
        return true;
    }
    async function importAssets(files: File[], retry = false) {
        if (state.busy || importing.current || (!retry && !checkFiles(files))) return;
        if (pending.current && !retry) { state.setError('请先完成上一批上传，再添加新的文件。'); return; }
        importing.current = true;
        try {
            const result = await state.run('upload-assets', async () => {
                if (!pending.current) {
                    const reused = state.data.assets.filter(asset => asset.projectId === project.id).map(asset => asset.id);
                    const opened = await post(`/projects/${project.id}/upload-batches`, { expectedCount: reused.length + files.length, reuseAssetIds: reused });
                    if (!opened.batch?.id) throw new Error('未取得上传批次，请刷新后重新选择文件。');
                    pending.current = { id: opened.batch.id, remaining: files.map(file => ({ file, uploadRequestId: crypto.randomUUID() })), assetIds: reused, count: reused.length + files.length };
                }
                const batch = pending.current;
                while (batch.remaining.length) {
                    const { file, uploadRequestId } = batch.remaining[0];
                    setProgress(`正在上传 ${batch.assetIds.length + 1}/${batch.count}：${file.name}`);
                    const saved = await upload(`/projects/${project.id}/assets?batchId=${encodeURIComponent(batch.id)}`, typedUploadBlob(file), file.name, { batchId: batch.id, uploadRequestId });
                    const id = saved.asset?.id || saved.id;
                    if (!id) throw new Error('文件上传结果尚未确认，请刷新核对后继续。');
                    batch.assetIds.push(id);
                    batch.remaining.shift();
                }
                setProgress('文件已上传，正在确认素材包…');
                return post(`/projects/${project.id}/upload-batches/${encodeURIComponent(batch.id)}/complete`, { assetIds: batch.assetIds });
            });
            if (result) { pending.current = null; setRetryCount(null); state.setNotice('素材已保存。前往任务中心设置成品数量与员工，再开始优化。'); }
            else if (pending.current) setRetryCount(pending.current.remaining.length);
        } finally { importing.current = false; setProgress(''); }
    }
    async function importCreatives(files: File[]) {
        if (!checkFiles(files) || state.busy || importing.current) return;
        importing.current = true;
        try {
            await state.run('upload-creatives', async () => {
                for (const [index, file] of files.entries()) {
                    setProgress(`正在保存实际成品 ${index + 1}/${files.length}：${file.name}`);
                    const blob = typedUploadBlob(file);
                    const metadata = await inspectCreative(blob);
                    await upload(`/projects/${project.id}/creatives`, blob, file.name, { title: file.name, format: 'source', sourceAssetIds: [], ...metadata });
                }
                return { uploaded: files.length };
            }, '实际成品已保存，可前往投放中心。');
        } finally { importing.current = false; setProgress(''); }
    }
    return { progress, retryCount, retryAssets: () => importAssets([], true), uploadLimitMiB, importAssets, importCreatives };
}
