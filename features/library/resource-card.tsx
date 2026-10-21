'use client';

import { useState } from 'react';
import { CheckCircle2, Download } from 'lucide-react';
import { downloadContent, post } from '../../components/platform/api';
import { creativeDeliveryState, projectReadyCreatives } from '../../components/platform/automation.mjs';
import { Badge, Button, Status } from '../../components/platform/ui';
import { label, type Row } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';
import { downloadFilename, mediaDetails, MediaPreview, mediaTypeLabel, type MediaInfo, type ResourceKind } from './media';

export function ResourceCard({ state, row, kind, onCampaign }: {
    state: PlatformState;
    row: Row;
    kind: ResourceKind;
    onCampaign?: (creative: Row) => void;
}) {
    const [loaded, setLoaded] = useState<MediaInfo>({});
    const source = kind === 'assets';
    const project = state.data.projects.find(item => item.id === row.projectId);
    const rejected = row.status === 'rejected' || row.reviewStatus === 'rejected';
    const approved = !rejected && (row.status === 'approved' || row.reviewStatus === 'approved' || row.approved === true);
    const delivery = creativeDeliveryState(row, state.data);
    const usable = !source && !rejected && projectReadyCreatives(row.projectId, state.data).some((item: Row) => item.id === row.id);
    const status = rejected ? 'rejected' : usable ? approved ? 'approved' : row.status || 'draft' : delivery.status === 'partial' ? 'partial' : 'validating';

    function review() {
        if (!state.data.bxagi.connected) return state.openBxagiLogin();
        void state.run(`review-${row.id}`, () => post(`/creatives/${row.id}/review`, { approved: true }), '审核已记录，可创建投放计划。');
    }

    return <article className="bx-media-card">
        <div className="bx-media-preview">
            <MediaPreview row={row} kind={kind} onMetadata={setLoaded}/>
            <span className="bx-media-type">{mediaTypeLabel(row)}</span>
        </div>
        <div className="bx-media-body">
            <div className="bx-media-card-heading">
                <Badge tone={source ? 'neutral' : 'blue'}>{source ? '原始素材' : '实际成品'}</Badge>
                {!source && <Status status={status}/>}
            </div>
            <h3 title={label(row)}>{label(row)}</h3>
            <p className="bx-media-project">{project?.title || '素材项目'}</p>
            <p className="bx-media-metadata">{mediaDetails(row, loaded)}</p>
            {!source && <div className="bx-media-delivery">
                <CheckCircle2 size={15}/>
                <div><span>{delivery.label}</span><small>{rejected ? '内容审核未通过，等待重做' : approved ? '内容审核已完成' : '内容审核待确认'}</small></div>
            </div>}
            <div className="bx-media-actions">
                <Button secondary busy={state.busy === `download-${row.id}`} disabled={!!state.busy} onClick={() => state.run(`download-${row.id}`, () => downloadContent(kind, row.id, downloadFilename(row)))}>
                    <Download size={15}/>下载
                </Button>
                {!source && onCampaign && <Button disabled={!usable || !!state.busy} onClick={() => onCampaign(row)}>
                    {rejected ? '等待重做' : usable ? '设置预算' : '等待完整交付'}
                </Button>}
                {!source && usable && !approved && <button className="bx-text-button bx-media-review" disabled={!!state.busy} onClick={review}>
                    <CheckCircle2 size={15}/>{state.busy === `review-${row.id}` ? '正在记录审核…' : '内容审核通过'}
                </button>}
            </div>
        </div>
    </article>;
}
