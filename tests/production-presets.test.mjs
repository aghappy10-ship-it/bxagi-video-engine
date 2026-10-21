import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildProductionPreset, initialProductionInstructions, PRODUCTION_PRESETS } from '../features/production/presets.mjs';
import { normalizeProductionSpec } from '../server/production-service.mjs';
import { instruction } from '../server/bxagi/task-prompts.mjs';

test('all preset combinations stay inside real production limits and expose matching variant goals', () => {
  for (const preset of PRODUCTION_PRESETS) for (const mediaType of ['video', 'image']) for (const format of ['portrait', 'square', 'landscape']) for (const targetCount of [1, 2, 3]) {
    const plan = buildProductionPreset({ presetId: preset.id, targetCount, mediaType, format });
    const spec = normalizeProductionSpec({ targetCount, mediaType, format, employeeMode: 'auto', instructions: plan.instructions });
    assert.equal(plan.goals.length, targetCount);
    assert.equal(new Set(plan.goals.map(item => item.goal)).size, targetCount);
    assert.equal(spec.instructions, plan.instructions);
    assert.ok(plan.instructions.length < 2000);
    assert.match(plan.instructions, new RegExp(`交付 ${targetCount} 条${mediaType === 'video' ? '视频' : '图片'}`));
    for (const variant of plan.goals) assert.ok(plan.instructions.includes(`${variant.number}. ${variant.goal}`));
    assert.doesNotMatch(plan.instructions, /已识别高光|效果已提升|已完成剪辑/);
    assert.match(plan.instructions, /不是已经识别出的片段/);
  }
  for (const invalid of [{ targetCount: 30 }, { mediaType: 'audio' }, { format: 'arbitrary' }, { presetId: 'unknown' }]) {
    assert.throws(() => buildProductionPreset({ presetId: 'highlights', targetCount: 3, mediaType: 'video', format: 'portrait', ...invalid }));
  }
});

test('preset text follows the existing normalized specification into the actual employee instruction', () => {
  const plan = buildProductionPreset({ presetId: 'openings', targetCount: 2, mediaType: 'video', format: 'portrait' });
  const spec = normalizeProductionSpec({ targetCount: 2, mediaType: 'video', format: 'portrait', instructions: plan.instructions });
  const prompt = instruction({ id: 'preset-test', details: { kind: 'production', productionSpec: spec, uploadedAssets: [{ id: 'source', path: 'input/original.mp4', kind: 'source' }] } });
  assert.ok(prompt.includes(JSON.stringify(spec)));
  assert.match(prompt, /实际交付恰好2条视频主成品/);
  assert.match(prompt, /不能复制相同文件凑数/);
  assert.match(prompt, /原声开场/);
  assert.doesNotMatch(plan.instructions, /3\. 主题开场/);
});

test('saved production text survives re-entry, while accepted decisions never fall back to editable saved text', () => {
  const saved = { instructions: '保留眼镜原始颜色与尺寸，不要添加折扣。' };
  assert.equal(initialProductionInstructions(saved), saved.instructions);
  assert.equal(initialProductionInstructions(saved, { metadata: { instructions: '已采纳要求：只改变封面。' }, reason: '其他原因' }), '已采纳要求：只改变封面。');
  assert.equal(initialProductionInstructions(saved, { reason: '已采纳要求：保持主体。' }), '已采纳要求：保持主体。');
  assert.equal(initialProductionInstructions(saved, {}), '');
});

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = new Map();
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename);
  const exports = {};
  cache.set(filename, exports);
  const nativeRequire = createRequire(filename);
  const require = specifier => {
    if (specifier.endsWith('.css')) return {};
    if (specifier.startsWith('.')) {
      const base = path.resolve(path.dirname(filename), specifier);
      const source = ['.tsx', '.ts'].map(ext => base + ext).find(candidate => fs.existsSync(candidate));
      if (source) return load(source);
    }
    return nativeRequire(specifier);
  };
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } });
  vm.runInThisContext(`(function(exports, require) {${outputText}\n})`, { filename })(exports, require);
  return exports;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
const { ProductionPresetPicker } = load('features/production/preset-picker.tsx');
const { Tasks } = load('components/platform/tasks.tsx');

test('custom mode does not present template goals as the instructions being submitted', () => {
  const common = { targetCount: 2, mediaType: 'video', format: 'portrait', onApply() {}, onCustom() {} };
  const preset = render(ProductionPresetPicker, { ...common, appliedPreset: 'openings' });
  assert.match(preset, /版本 1/); assert.match(preset, /版本 2/); assert.doesNotMatch(preset, /版本 3/);
  assert.match(preset, /应用方案会替换下方制作要求/);
  assert.match(preset, /尚未分析源素材/);
  const custom = render(ProductionPresetPicker, { ...common, appliedPreset: null });
  assert.match(custom, /自定义制作要求/);
  assert.match(custom, /预设未应用/);
  assert.doesNotMatch(custom, /版本 1|版本 2|本批制作目标预览/);
  const image = render(ProductionPresetPicker, { ...common, mediaType: 'image', format: 'square', targetCount: 3, appliedPreset: 'openings' });
  assert.match(image, /标题对照/); assert.match(image, /3 条图片/); assert.match(image, /方形 1:1/);
  assert.doesNotMatch(image, /原声开场/);
});

test('the real task composer shows persisted instructions instead of silently resetting them', () => {
  const project = { id: 'project', title: '测试素材包', sourceState: { version: 1, status: 'sealed' }, productionSpec: { targetCount: 2, instructions: '已有要求：保留红色镜框 <不要修改>' } };
  const state = { busy: '', data: { user: { id: 'owner' }, projects: [project], assets: [{ id: 'source', projectId: project.id, mimeType: 'image/jpeg', size: 100 }], creatives: [], jobs: [], employees: [], campaigns: [], metrics: [], connections: [], optimizationTasks: [], automationFlows: [], capabilities: {}, bxagi: { connected: true } } };
  const html = render(Tasks, { state, onProject() {}, onLibrary() {} });
  assert.match(html, /已有要求：保留红色镜框 &lt;不要修改&gt;/);
  assert.match(html, /应用方案会替换下方制作要求/);
  assert.match(html, /自定义制作要求/);
  assert.doesNotMatch(html, /本批制作目标预览/);
});
