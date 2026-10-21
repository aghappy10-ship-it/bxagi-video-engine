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

// Render the real TSX components without a browser or a new test dependency.
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
    const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    });
    vm.runInThisContext(`(function(exports, require) {${outputText}\n})`, { filename })(exports, require);
    return exports;
}

const { Projects } = load('components/platform/projects.tsx');
const { Tasks } = load('components/platform/tasks.tsx');
const { Library } = load('components/platform/library.tsx');
const { WORKSPACE_NAV, screenFromHash } = load('components/platform/workspace/navigation.ts');
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
function state(overrides={}) {return {busy:'',data:{user:{id:'u'},projects:[],assets:[],creatives:[],jobs:[],employees:[],campaigns:[],metrics:[],connections:[],optimizationTasks:[],automationFlows:[],capabilities:{},bxagi:{connected:true},...overrides}};}
const project = {id:'p',title:'眼镜原始包',sourceState:{version:1,status:'sealed'},productionSpec:{targetCount:3}};
const source = {id:'a',projectId:'p',filename:'original-only.jpg',mimeType:'image/jpeg',size:200};

test('workspace exposes eight numbered business modules and preserves employee legacy navigation',()=>{
 assert.deepEqual(WORKSPACE_NAV.filter(item=>item.module).map(item=>item.module),['M1','M2','M3','M4','M5','M6','M7','M8']);
 assert.equal(screenFromHash('#tasks'),'tasks');
 assert.equal(screenFromHash('#employees'),'employees');
});

test('source workspace has explicit next-step action and no production or campaign controls',()=>{
 const html=render(Projects,{state:state({projects:[project],assets:[source]}),selectedId:'p',onSelect(){},onCreate(){},onTasks(){}});
 assert.match(html,/original-only.jpg/);
 assert.match(html,/创建优化任务/);
 assert.doesNotMatch(html,/开始优化|启动真实投放|设置投放预算/);
});

test('incomplete upload cannot start a production task',()=>{
 const html=render(Tasks,{state:state({projects:[{...project,sourceState:{version:1,status:'uploading'}}],assets:[source]}),onProject(){},onLibrary(){}});
 assert.match(html,/请先完成素材上传/);
 assert.match(html,/<button(?=[^>]*type="submit")(?=[^>]*disabled="")[^>]*>[\s\S]*?开始优化/);
 assert.doesNotMatch(html,/original-only.jpg/);
});

test('creative center excludes raw assets and does not count covers as primary deliverables',()=>{
 const html=render(Library,{state:state({projects:[project],assets:[source],creatives:[
 {id:'c',projectId:'p',filename:'optimized-ad.mp4',mimeType:'video/mp4',size:500,status:'approved',metadata:{deliverableRole:'primary'}},
 {id:'cover',projectId:'p',filename:'cover.jpg',mimeType:'image/jpeg',size:200,status:'approved',metadata:{deliverableRole:'cover'}},
 {id:'notes',projectId:'p',filename:'notes.txt',mimeType:'text/plain',size:100,status:'approved',metadata:{deliverableRole:'notes'}}
 ]}),onCampaign(){}});
 assert.doesNotMatch(html,/original-only.jpg/);
 assert.match(html,/optimized-ad.mp4/);
 assert.match(html,/准备投放 1 条/);
 assert.match(html,/交付说明与辅助文件 · 2 份/);
});

test('an advertising task does not block independent creative production',()=>{
 const html=render(Tasks,{state:state({projects:[project],assets:[source],jobs:[{id:'ad-job',projectId:'p',status:'running',details:{kind:'advertising'}}]}),onProject(){},onLibrary(){}});
 const submit=[...html.matchAll(/<button\b[^>]*>/g)].map(item=>item[0]).find(tag=>tag.includes('type="submit"'));
 assert.ok(submit);
 assert.doesNotMatch(submit,/disabled=/);
});
