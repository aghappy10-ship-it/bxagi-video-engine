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

const { Status, Button } = load('components/platform/ui.tsx');
const { LoginForm, loginError } = load('features/account/login-form.tsx');
const { ApiError } = load('components/platform/api.ts');
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('running production tasks do not render as launched advertising', () => {
    assert.match(render(Status, { status: 'running' }), /执行中/);
    assert.doesNotMatch(render(Status, { status: 'running', context: 'production' }), /投放中/);
    assert.match(render(Status, { status: 'running', context: 'campaign' }), /投放中/);
});

test('a busy submit control is actually disabled and exposes its busy state', () => {
    const html = render(Button, { type: 'submit', busy: true, children: '登录工作区' });
    assert.match(html, /<button[^>]*disabled=""/);
    assert.match(html, /<button[^>]*aria-busy="true"/);
    assert.match(html, /登录工作区/);
});

test('BXAGI login inputs have explicit labels and password-manager semantics', () => {
    const html = render(LoginForm, { state: { requiresLogin: true, error: '', notice: '' } });
    const labelIds = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map(match => match[1]);
    assert.equal(labelIds.length, 2);
    for (const id of labelIds) assert.ok(html.includes(`id="${id}"`));
    const password = [...html.matchAll(/<input\b[^>]*>/g)].map(match => match[0]).find(input => input.includes('name="password"'));
    assert.ok(password);
    assert.match(password, /type="password"/);
    assert.match(password, /autoComplete="current-password"/);
    assert.match(html, /aria-label="BXAGI 账号登录"/);
    assert.match(html, /role="group" aria-label="登录方式"/);
    assert.doesNotMatch(html, /OpenAI|ChatGPT|GPT/);
});

test('login distinguishes missing environment configuration from an upstream 503', () => {
    const missingConfiguration = new ApiError('Internal configuration details', 503, [], 'bxagi_encryption_unavailable');
    const upstreamUnavailable = new ApiError('Internal upstream details', 503, [], 'bxagi_upstream_unavailable');
    assert.equal(loginError(missingConfiguration), '当前环境未完成登录配置，请使用正式站点或联系管理员。');
    assert.equal(loginError(upstreamUnavailable), 'BXAGI 服务暂时未响应，请稍后重试。');
});
