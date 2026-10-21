'use client';

import { ArrowRight } from 'lucide-react';
import { post } from '../../components/platform/api';
import { Button, Field, Modal } from '../../components/platform/ui';
import { OBJECTIVES } from '../../components/platform/types';
import type { PlatformState } from '../../components/platform/use-platform';

export function NewProject({ state, onClose, onCreated }: {
    state: PlatformState;
    onClose: () => void;
    onCreated: (id: string) => void;
}) {
    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const result = await state.run('new-project', () => post('/projects', {
            title: form.get('title'),
            productName: form.get('productName'),
            description: form.get('description'),
            facts: String(form.get('facts') || '').split('\n').map(fact => fact.trim()).filter(Boolean),
            objective: form.get('objective'),
            audience: form.get('audience'),
            landingUrl: form.get('landingUrl'),
        }), '素材包已创建，可以上传原始资料。');
        if (result) {
            onCreated((result.project || result).id);
            onClose();
        }
    }

    return <Modal title="新建素材包" description="先整理你要推广的内容，再上传图片、视频或其他原始资料。" onClose={onClose}>
        <form onSubmit={submit}>
            <div className="bx-form-grid">
                <Field label="素材包名称 *" className="full"><input name="title" required maxLength={160} placeholder="例如：轻量眼镜 / 秋季推广素材" autoFocus/></Field>
                <Field label="产品 / 内容名称" className="full"><input name="productName" placeholder="商品、游戏、短剧或服务名称（选填）"/></Field>
                <Field label="资料说明" className="full"><textarea name="description" rows={3} placeholder="简单介绍这批资料，其他信息可以稍后补充。"/></Field>
            </div>
            <details className="bx-advanced"><summary>补充推广资料（选填）</summary><div className="bx-form-grid">
                <Field label="营销目标"><select name="objective" defaultValue="purchase">{Object.entries(OBJECTIVES).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></Field>
                <Field label="目标人群"><input name="audience" placeholder="例如：城市通勤与周末徒步人群"/></Field>
                <Field label="已确认的卖点和事实" className="full" hint="一行一条。价格、优惠、功效与剧情信息以你提供的事实为准。"><textarea name="facts" rows={3} placeholder={'例如：三种颜色可选\n商品支持七天无理由退货'}/></Field>
                <Field label="转化落地页" className="full"><input type="url" name="landingUrl" placeholder="https://"/></Field>
            </div></details>
            <footer className="bx-modal-footer">
                <Button secondary type="button" onClick={onClose}>取消</Button>
                <Button type="submit" busy={state.busy === 'new-project'}>创建素材包<ArrowRight size={16}/></Button>
            </footer>
        </form>
    </Modal>;
}
