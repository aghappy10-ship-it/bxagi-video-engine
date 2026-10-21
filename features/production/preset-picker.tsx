'use client';

import { ArrowRight, ListChecks } from 'lucide-react';
import { Button } from '../../components/platform/ui';
import { buildProductionPreset, PRODUCTION_PRESETS } from './presets.mjs';
import './presets.css';

type Props = {
  targetCount: number;
  mediaType: string;
  format: string;
  appliedPreset: string | null;
  disabled?: boolean;
  onApply: (id: string) => void;
  onCustom: () => void;
};

export function ProductionPresetPicker({ targetCount, mediaType, format, appliedPreset, disabled, onApply, onCustom }: Props) {
  const plan = appliedPreset ? buildProductionPreset({ presetId: appliedPreset, targetCount, mediaType, format }) : null;
  return <section className="bx-production-presets" aria-label="制作方案">
    <div className="bx-production-presets-heading"><div><h3>选一个制作方向</h3><p>应用方案会替换下方制作要求。修改文字后转为自定义。</p></div>{plan && <button type="button" className="bx-text-button" disabled={disabled} onClick={onCustom}>转为自定义</button>}</div>
    <div className="bx-production-preset-grid">{PRODUCTION_PRESETS.map(preset => {
      const name = mediaType === 'image' ? preset.imageLabel : preset.label;
      const selected = preset.id === appliedPreset;
      return <article className={`bx-production-preset-card${selected ? ' is-selected' : ''}`} key={preset.id}>
        <strong>{name}</strong><p>{mediaType === 'image' ? preset.imageDescription : preset.description}</p>
        <Button secondary type="button" disabled={disabled} aria-pressed={selected} aria-label={`应用${name}方案并替换制作要求`} onClick={() => onApply(preset.id)}>{selected ? '已应用' : '应用方案'}<ArrowRight size={13}/></Button>
      </article>;
    })}</div>
    <div className="bx-production-plan" aria-live="polite"><header><span><ListChecks size={16}/>{plan ? '本批制作目标预览' : '自定义制作要求'}</span><small>{plan?.summary || `${targetCount} 条${mediaType === 'video' ? '视频' : '图片'}`}</small></header>
      {plan ? <><ol>{plan.goals.map((item: { number: number; goal: string }) => <li key={item.number}><span>版本 {item.number}</span><p>{item.goal}</p></li>)}</ol><p className="bx-production-plan-note">尚未分析源素材。开始优化后由 BXAGI 员工执行，并说明实际采用的片段与差异。</p></> : <p className="bx-production-plan-note">将提交下方的实际文字要求。预设未应用，不会自动附加上方方案；调整数量、类型或画幅后，请核对文字要求是否仍一致。</p>}
    </div>
  </section>;
}
