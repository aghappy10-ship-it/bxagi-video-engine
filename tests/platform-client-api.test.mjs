import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as sessionEvents from '../components/platform/client-session-events.mjs';

const source = ts.transpileModule(readFileSync(new URL('../components/platform/api.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(responder) {
    const calls = [];
    const exports = {};
    vm.runInNewContext(source, {
        exports, URL,
        require(name) {
            assert.equal(name, './client-session-events.mjs');
            return sessionEvents;
        },
        fetch: async (path, options) => {
            calls.push({ path, options });
            return responder(path, options);
        },
    });
    return { ...exports, calls };
}

test('successful JSON requests retain paths, queries, and fixed same-origin transport', async () => {
    const api = harness(() => Response.json({ accepted: true }, { status: 201 }));
    const result = await api.platformRequest('/projects/a/export?format=json&name=a%20b', {
        credentials: 'include', mode: 'cors', redirect: 'follow', cache: 'force-cache',
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(api.calls[0].path, '/api/v2/projects/a/export?format=json&name=a%20b');
    const options = api.calls[0].options;
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
});

test('JSON success accepts structured JSON media types', async () => {
    const api = harness(() => new Response('{"accepted":true}', { headers: { 'Content-Type': 'application/vnd.bxagi+json; charset=utf-8' } }));
    assert.equal((await api.platformRequest('/bootstrap')).accepted, true);
});

test('HTML, empty, malformed, or non-object successful responses never acknowledge writes', async () => {
    const responses = [
        new Response('<html>gateway</html>', { headers: { 'Content-Type': 'text/html' } }),
        new Response('', { status: 200 }),
        new Response(null, { status: 204 }),
        new Response('{', { headers: { 'Content-Type': 'application/json' } }),
        new Response('{}', { headers: { 'Content-Type': 'text/html' } }),
        Response.json(null), Response.json([]), Response.json('unexpected'),
    ];
    for (const response of responses) {
        const api = harness(() => response);
        await assert.rejects(api.post('/projects', { title: 'test' }), error =>
            error instanceof api.ApiError && error.code === 'platform_invalid_response' && error.status === response.status);
        assert.equal(api.calls.length, 1, 'invalid acknowledgements must not be replayed');
    }
});

test('non-JSON and null HTTP errors retain status for session invalidation', async () => {
    for (const response of [Response.json(null, { status: 401 }), new Response('<html>unauthorized</html>', { status: 401 }), Response.json([], { status: 503 })]) {
        const api = harness(() => response);
        await assert.rejects(api.platformRequest('/bootstrap'), error =>
            error instanceof api.ApiError && error.status === response.status && error.message === `请求失败 (${response.status})`);
    }
});

test('structured server errors retain code and textual reasons without object coercion', async () => {
    const api = harness(() => Response.json({ error: { message: '会话失效', code: 'bxagi_session_invalid', reasons: ['请重新登录', { unknown: true }] } }, { status: 401 }));
    await assert.rejects(api.platformRequest('/bootstrap'), error => {
        assert.equal(error.status, 401);
        assert.equal(error.code, 'bxagi_session_invalid');
        assert.equal(error.message, '会话失效');
        assert.deepEqual(Array.from(error.reasons), ['请重新登录']);
        return true;
    });
});

test('legacy top-level error strings and details reasons remain supported', async () => {
    const api = harness(() => Response.json({ error: '暂不可用', code: 'temporarily_unavailable', details: { reasons: ['稍后查看'] } }, { status: 503 }));
    await assert.rejects(api.platformRequest('/bootstrap'), error =>
        error.message === '暂不可用' && error.code === 'temporarily_unavailable' && error.reasons[0] === '稍后查看');
});

test('invalid error fields fall back to a safe message and preserve HTTP status', async () => {
    const api = harness(() => Response.json({ error: { message: { internal: true }, code: ['invalid'], reasons: 'invalid' }, message: 42 }, { status: 403 }));
    await assert.rejects(api.platformRequest('/bootstrap'), error =>
        error.status === 403 && error.message === '请求失败 (403)' && error.code === undefined && error.reasons.length === 0);
});

test('out-of-scope and ambiguous paths are rejected before fetch', async () => {
    const api = harness(() => Response.json({}));
    for (const path of ['https://other.example/api', '//other.example/api', '/../../auth', '/projects/%2e%2e/%2e%2e/auth', '/\\other.example', '/bootstrap\n', '/bootstrap#ignored']) {
        await assert.rejects(api.platformRequest(path), error => error.code === 'platform_request_scope');
    }
    assert.equal(api.calls.length, 0);
});

test('transport failures and uncertain writes are surfaced once without automatic retry', async () => {
    const failure = new TypeError('Network request failed');
    const api = harness(() => { throw failure; });
    await assert.rejects(api.post('/projects', { title: 'test' }), error => error === failure);
    assert.equal(api.calls.length, 1);
});

test('only confirmed authentication boundaries notify subscribers without data', async () => {
    const received = [];
    const unsubscribe = sessionEvents.subscribeClientSessionChange((...args) => received.push(args));
    try {
        for (const [path, connected, expected] of [
            ['/bxagi/auth/login', true, 1], ['/bxagi/auth/logout', false, 2],
            ['/bxagi/auth/login', false, 2], ['/bxagi/auth/logout', true, 2],
            ['/bxagi/auth/session', true, 2], ['/projects', true, 2],
        ]) {
            const api = harness(() => Response.json({ connected, profile: { id: 'never-in-event' } }));
            await api.post(path, {});
            assert.equal(received.length, expected);
        }
        assert.deepEqual(received, [[], []]);
    } finally { unsubscribe(); }
});

test('failed or malformed authentication responses never signal a session change', async () => {
    let notifications = 0;
    const unsubscribe = sessionEvents.subscribeClientSessionChange(() => notifications++);
    try {
        for (const response of [Response.json({ connected: true }, { status: 401 }), new Response('{"connected":true}', { headers: { 'Content-Type': 'text/html' } }), Response.json(null)]) {
            const api = harness(() => response);
            await assert.rejects(api.post('/bxagi/auth/login', {}));
        }
        assert.equal(notifications, 0);
    } finally { unsubscribe(); }
});

test('subscriber failure does not hide acknowledged authentication or block other listeners', async () => {
    let notified = 0;
    const removeFaulty = sessionEvents.subscribeClientSessionChange(() => { throw new Error('UI listener failed'); });
    const removeHealthy = sessionEvents.subscribeClientSessionChange(() => notified++);
    try {
        const api = harness(() => Response.json({ connected: true }));
        assert.equal((await api.post('/bxagi/auth/login', {})).connected, true);
        assert.equal(notified, 1);
        removeHealthy();
        sessionEvents.notifyClientSessionChange();
        assert.equal(notified, 1);
    } finally { removeFaulty(); removeHealthy(); }
});

test('binary file requests preserve bytes and use the same transport boundary', async () => {
    const api = harness(() => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'video/mp4' } }));
    const blob = await api.contentBlob('creatives', 'owned-file');
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
    assert.equal(api.calls[0].path, '/api/v2/creatives/owned-file/content');
    assert.equal(api.calls[0].options.mode, 'same-origin');
    assert.equal(api.calls[0].options.redirect, 'error');
});
