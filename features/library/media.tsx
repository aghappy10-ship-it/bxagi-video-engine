'use client';
/* eslint-disable @next/next/no-img-element -- Private images use the authenticated content endpoint directly. */

import { useState } from 'react';
import { FileAudio, FileText, Film, Image as ImageIcon } from 'lucide-react';
import { contentUrl } from '../../components/platform/api';
import { label, mime, type Row } from '../../components/platform/types';

export type ResourceKind = 'assets' | 'creatives';
export type MediaType = 'image' | 'video' | 'audio' | 'text' | 'other';
export type MediaInfo = { width?: number; height?: number; duration?: number };
export const MEDIA_TYPES: { value: MediaType | 'all'; label: string }[] = [
    { value: 'all', label: '所有类型' },
    { value: 'image', label: '图片' },
    { value: 'video', label: '视频' },
    { value: 'audio', label: '音频' },
    { value: 'text', label: '文本与字幕' },
    { value: 'other', label: '其他文件' },
];

export function mediaType(row: Row): MediaType {
    const type = mime(row).toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    if (type.startsWith('text/') || /(?:subrip|subtitle|json|pdf)/.test(type)) return 'text';
    const filename = String(row.filename || row.originalName || '').toLowerCase();
    if (/\.(?:srt|vtt|txt|md|json|pdf)$/.test(filename)) return 'text';
    return 'other';
}

function positive(value: unknown) {
    if (value === null || value === undefined || value === '') return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function mediaSize(row: Row) {
    const value = row.size ?? row.byteLength;
    if (value === undefined || value === null || value === '') return '大小未记录';
    const size = Number(value);
    if (!Number.isFinite(size) || size < 0) return '大小未记录';
    if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
    if (size >= 1024 ** 2) return `${(size / 1024 ** 2).toFixed(1)} MB`;
    if (size >= 1024) return `${Math.round(size / 1024)} KB`;
    return `${size} B`;
}

export function durationLabel(value: unknown) {
    const duration = positive(value);
    if (!duration) return '';
    const seconds = Math.max(1, Math.round(duration));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours ? `${hours}:` : ''}${hours ? String(minutes).padStart(2, '0') : minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function mediaDetails(row: Row, loaded: MediaInfo = {}) {
    const width = positive(row.width) || positive(row.metadata?.width) || loaded.width;
    const height = positive(row.height) || positive(row.metadata?.height) || loaded.height;
    const duration = durationLabel(positive(row.duration) || positive(row.metadata?.duration) || loaded.duration);
    return [width && height ? `${width} × ${height}` : '', duration, mediaSize(row)].filter(Boolean).join(' · ');
}

export function mediaTypeLabel(row: Row) {
    return MEDIA_TYPES.find(item => item.value === mediaType(row))?.label || '文件';
}

export function downloadFilename(row: Row) {
    if (row.filename || row.originalName) return row.filename || row.originalName;
    const extension = mime(row).split('/')[1]?.split(';')[0] || 'bin';
    return `${label(row)}.${extension}`;
}

export function MediaPreview({ row, kind, onMetadata }: {
    row: Row;
    kind: ResourceKind;
    onMetadata?: (info: MediaInfo) => void;
}) {
    const [failed, setFailed] = useState(false);
    const type = mediaType(row);
    const source = contentUrl(kind, row.id);
    const Icon = type === 'image' ? ImageIcon : type === 'video' ? Film : type === 'audio' ? FileAudio : FileText;

    if (failed) return <div className="bx-media-placeholder"><Icon size={34}/><strong>预览暂不可用</strong><span>可以下载原文件查看</span></div>;
    if (type === 'image') {
        return <img src={source} alt={label(row)} loading="lazy" decoding="async" onError={() => setFailed(true)} onLoad={event => {
            onMetadata?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
        }}/>;
    }
    if (type === 'video') {
        return <video src={source} controls playsInline preload="metadata" aria-label={`${label(row)} 视频预览`} onError={() => setFailed(true)} onLoadedMetadata={event => {
            const video = event.currentTarget;
            onMetadata?.({ width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : undefined });
        }}>浏览器暂不支持此视频格式，请下载查看。</video>;
    }
    if (type === 'audio') {
        return <div className="bx-media-audio"><FileAudio size={36}/><audio src={source} controls preload="metadata" aria-label={`${label(row)} 音频预览`} onError={() => setFailed(true)} onLoadedMetadata={event => {
            onMetadata?.({ duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : undefined });
        }}>浏览器暂不支持此音频格式，请下载查看。</audio></div>;
    }
    return <div className="bx-media-placeholder"><FileText size={36}/><strong>{mediaTypeLabel(row)}</strong><span>下载原文件查看完整内容</span></div>;
}
