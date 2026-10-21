'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { ListPlus } from 'lucide-react';
import { Button, Field, Modal } from '../../ui';
import { parseDramaNames } from './helpers.mjs';
import { PROMOTION_LABELS, type PromotionMode } from './types';

export type BatchInput = { title: string; names: string[]; targetCount: number; promotionMode: PromotionMode };
export function BatchImport({ onClose, onCreate, busy, error }: { onClose: () => void; onCreate: (input: BatchInput) => Promise<void>; busy: boolean; error: string }) {
    const [title, setTitle] = useState('');
    const [text, setText] = useState('');
    const [targetCount, setTargetCount] = useState(3);
    const [promotionMode, setPromotionMode] = useState<PromotionMode>('both');
    const { names, duplicates } = useMemo(() => parseDramaNames(text), [text]);
    const issue = names.length > 100 ? '每批最多 100 部剧，请拆分后导入。' : names.some((name: string) => name.length > 200) ? '单个剧名最多 200 个字符，请检查输入。' : '';
    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!title.trim() || !names.length || issue) return;
        await onCreate({ title: title.trim(), names, targetCount, promotionMode });
    }
    return <Modal title="导入一批剧目" description="先建立剧单，再逐部关联素材、核验授权并补齐推广链接。" onClose={onClose} closeDisabled={busy} className="bx-release-modal">
        <form onSubmit={submit}>
            <Field label="批次名称"><input value={title} onChange={event => setTitle(event.target.value)} maxLength={100} required placeholder="例如：10 月 20 日待投剧单" disabled={busy}/></Field>
            <Field label="剧名清单 · 每行一部" hint="最多 100 部；自动去除空行和完全相同的重复剧名。"><textarea value={text} onChange={event => setText(event.target.value)} rows={8} maxLength={24000} required placeholder={'剧目名称一\n剧目名称二\n剧目名称三'} disabled={busy}/></Field>
            <div className="bx-release-import-count"><strong>{names.length}<span> / 100 部</span></strong><span>{duplicates ? `已合并 ${duplicates} 个重复剧名` : '支持从表格整列粘贴'}</span></div>
            <div className="bx-form-grid">
                <Field label="每部素材目标" hint="可分别调整每部剧的目标数量。"><input type="number" min={1} max={30} step={1} required value={targetCount || ''} onChange={event => setTargetCount(Number(event.target.value))} disabled={busy}/></Field>
                <Field label="推广模式"><select value={promotionMode} onChange={event => setPromotionMode(event.target.value as PromotionMode)} disabled={busy}>{Object.entries(PROMOTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
            </div>
            <div className="bx-release-plan-total"><div><span>本批计划</span><strong>{names.length * (targetCount || 0)} <small>条素材</small></strong></div><p>此处保存生产目标，不会自动创建员工任务。实际产量以员工交付为准。</p></div>
            {(issue || error) && <p className="bx-release-error" role="alert">{issue || error}</p>}
            <footer className="bx-modal-footer"><Button type="button" secondary onClick={onClose} disabled={busy}>取消</Button><Button type="submit" busy={busy} disabled={!names.length || !!issue || !title.trim() || targetCount < 1 || targetCount > 30}><ListPlus size={16}/>建立准备清单</Button></footer>
        </form>
    </Modal>;
}
