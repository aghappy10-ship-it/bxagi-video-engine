import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogErrorMessage, catalogNextPoll, projectViewFromHash } from '../features/catalog/helpers.mjs';

const now = Date.parse('2026-10-20T10:00:00Z');
function status(overrides = {}) {
    return {
        source: { configured: true, autoSync: false }, integration: { configured: true }, scheduler: { running: false },
        run: { status: 'queued', nextRunAt: null }, ...overrides,
    };
}

test('explicit catalog deep links survive normal project selection and other hashes remain package views', () => {
    assert.equal(projectViewFromHash('#projects?view=catalog'), 'catalog');
    assert.equal(projectViewFromHash('#projects?foo=1&view=catalog'), 'catalog');
    for (const hash of ['', '#projects', '#projects?view=packages', '#tasks?view=catalog']) assert.equal(projectViewFromHash(hash), 'packages');
});

test('page-driven advancement observes the server deadline and never schedules a busy loop', () => {
    assert.deepEqual(catalogNextPoll(status(), now), { action: 'advance', delay: 1000 });
    assert.deepEqual(catalogNextPoll(status({ run: { status: 'waiting', nextRunAt: new Date(now + 12000).toISOString() } }), now), { action: 'advance', delay: 12000 });
    assert.deepEqual(catalogNextPoll(status({ run: { status: 'running', nextRunAt: new Date(now - 1000).toISOString() } }), now), { action: 'advance', delay: 1000 });
});

test('auto-sync restarts completed runs at the scheduled deadline, but never paused or failed runs', () => {
    const source = { configured: true, autoSync: true };
    const nextRunAt = new Date(now + 9000).toISOString();
    assert.deepEqual(catalogNextPoll(status({ source, run: { status: 'completed', nextRunAt } }), now), { action: 'advance', delay: 9000 });
    for (const state of ['paused', 'failed']) assert.equal(catalogNextPoll(status({ source, run: { status: state, nextRunAt } }), now).action, 'status');
    assert.equal(catalogNextPoll(status({ source, run: { status: 'completed', nextRunAt: null } }), now).action, 'status');
    assert.equal(catalogNextPoll(status({ run: { status: 'completed', nextRunAt } }), now).action, 'status');
});

test('a healthy background scheduler, missing credentials, or missing adapter never triggers page advancement', () => {
    for (const override of [{ scheduler: { running: true } }, { source: { configured: false, autoSync: true } }, { integration: { configured: false } }]) {
        assert.equal(catalogNextPoll(status(override), now).action, 'status');
    }
});

test('UI error messages never echo source credentials or raw upstream response bodies', () => {
    const secret = 'private-source-secret';
    assert.equal(catalogErrorMessage({ status: 500, message: secret }), '操作未完成，请稍后重试。');
    assert.equal(catalogErrorMessage({ status: 400, code: 'credential_invalid', message: secret }), '请检查分销商标识与签名密钥。');
    assert.equal(catalogErrorMessage({ status: 401, message: secret }), '登录已失效，请重新登录 BXAGI。');
});
