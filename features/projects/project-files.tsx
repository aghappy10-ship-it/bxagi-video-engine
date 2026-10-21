'use client';

import { useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Image as ImageIcon, UploadCloud } from 'lucide-react';
import { Badge, Button, Empty, Panel } from '../../components/platform/ui';
import type { Row } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';
import { ResourceCard } from '../library/resource-card';
import { useProjectFiles } from './use-project-files';

type FileActions = ReturnType<typeof useProjectFiles>;

export function ProjectSources({ state, assets, files }: { state: PlatformState; assets: Row[]; files: FileActions }) {
    const input = useRef<HTMLInputElement>(null);
    const [dragging, setDragging] = useState(false);
    const [showAll, setShowAll] = useState(false);
    const visible = showAll ? assets : assets.slice(0, 4);

    function chooseAssets() {
        if (!state.data.bxagi.connected) return state.openBxagiLogin();
        input.current?.click();
    }

    return <Panel className="bx-projects-sources" title={<span className="bx-projects-section-title">原始素材<Badge>{assets.length} 份</Badge></span>} subtitle="上传图片、视频、音频或文本，文件按本次上传批次保存。" action={assets.length ? <Button secondary disabled={!!state.busy || files.retryCount !== null} busy={state.busy === 'upload-assets'} onClick={chooseAssets}><UploadCloud size={16}/>添加素材</Button> : undefined}>
        <input ref={input} type="file" className="visually-hidden" multiple accept="image/*,video/*,audio/*,.srt,.txt,.md,.vtt" onChange={event => {
            const picked = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = '';
            void files.importAssets(picked);
        }}/>
        {!assets.length ? <button type="button" className={`bx-projects-upload ${dragging ? 'is-dragging' : ''}`} disabled={!!state.busy || files.retryCount !== null} onClick={chooseAssets} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => {
            event.preventDefault();
            setDragging(false);
            void files.importAssets(Array.from(event.dataTransfer.files));
        }}>
            <span className="bx-projects-upload-icon"><UploadCloud size={30}/></span>
            <strong>拖入素材，或点击上传</strong>
            <span>可一次添加多份文件，每份不超过 {files.uploadLimitMiB} MiB</span>
            <small>图片 · 视频 · 音频 · 字幕 · 文本</small>
        </button> : <>
            <div className="bx-media-grid bx-projects-file-grid">{visible.map(asset => <ResourceCard key={asset.id} state={state} row={asset} kind="assets"/>)}</div>
            {assets.length > 4 && <button className="bx-text-button bx-projects-show-more" onClick={() => setShowAll(!showAll)}>{showAll ? '收起文件' : `查看全部 ${assets.length} 份原始素材`}<ChevronDown size={15}/></button>}
            <p className="bx-projects-file-limit">每份文件最多 {files.uploadLimitMiB} MiB；文件保存后，可前往任务中心安排优化。</p>
        </>}
        {state.busy === 'upload-assets' && files.progress && <p className="bx-projects-upload-progress" role="status"><UploadCloud size={15}/>{files.progress}</p>}
    </Panel>;
}

export function ProjectDeliveries({ state, creatives, readyCount, files, onCampaign }: {
    state: PlatformState;
    creatives: Row[];
    readyCount: number;
    files: FileActions;
    onCampaign: (creative: Row) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const [showAll, setShowAll] = useState(false);
    const visible = showAll ? creatives : creatives.slice(0, 4);

    function chooseCreatives() {
        if (!state.data.bxagi.connected) return state.openBxagiLogin();
        input.current?.click();
    }

    return <Panel className="bx-projects-deliveries" title={<span className="bx-projects-section-title">实际成品<Badge>{creatives.length} 份</Badge></span>} subtitle="已归档的真实文件可以预览与下载；完整交付后可审核和设置预算。" action={<Button secondary disabled={!!state.busy || files.retryCount !== null} busy={state.busy === 'upload-creatives'} onClick={chooseCreatives}><UploadCloud size={16}/>导入已有成品</Button>}>
        <input ref={input} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,.svg,.txt" multiple onChange={event => {
            const picked = Array.from(event.currentTarget.files || []);
            event.currentTarget.value = '';
            void files.importCreatives(picked);
        }}/>
        {state.busy === 'upload-creatives' && files.progress && <p className="bx-projects-upload-progress" role="status"><UploadCloud size={15}/>{files.progress}</p>}
        {creatives.length ? <>
            <div className="bx-projects-delivery-summary"><CheckCircle2 size={16}/><span>{readyCount} 份完整文件可设置预算</span>{creatives.length > readyCount && <small>其余文件的交付或审核状态见下方</small>}</div>
            <div className="bx-media-grid bx-projects-file-grid">{visible.map(creative => <ResourceCard key={creative.id} state={state} row={creative} kind="creatives" onCampaign={onCampaign}/>)}</div>
            {creatives.length > 4 && <button className="bx-text-button bx-projects-show-more" onClick={() => setShowAll(!showAll)}>{showAll ? '收起文件' : `查看全部 ${creatives.length} 份成品`}<ChevronDown size={15}/></button>}
        </> : <Empty icon={<ImageIcon size={28}/>} title="实际交付将在这里出现" description="员工处理完成并回收文件后，这里会展示真实成品。你也可以导入已经制作好的文件。"/>}
    </Panel>;
}
