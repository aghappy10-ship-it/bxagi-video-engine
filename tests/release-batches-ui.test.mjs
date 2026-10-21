import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell, exportFilename, parseDramaNames, releaseBatchCsv, taskViewFromHash } from '../components/platform/features/releases/helpers.mjs';

test('task views follow direct links and browser history without affecting other screens', () => {
    assert.equal(taskViewFromHash('#tasks?view=releases'), 'releases');
    assert.equal(taskViewFromHash('#tasks'), 'tasks');
    assert.equal(taskViewFromHash('#tasks?view=employees'), 'employees');
    assert.equal(taskViewFromHash('#employees'), 'employees');
    assert.equal(taskViewFromHash('#tasks?view=unknown'), 'tasks');
    assert.equal(taskViewFromHash('#projects'), null);
});

test('drama import removes blank rows and exact duplicates without splitting punctuation', () => {
    assert.deepEqual(parseDramaNames('  第一部：新篇 \r\n第二部,归来\n\n第一部：新篇\n'), { names: ['第一部：新篇', '第二部,归来'], duplicates: 1 });
});

test('CSV values neutralize formulas with whitespace prefixes and preserve quotes and newlines', () => {
    for (const input of ['=1+1', '+1', '-5+5', '@SUM(1)', '  =cmd', '\t=1', '\r123', '\n123', '\uFEFF=1']) assert.equal(csvCell(input), `"'${input}"`);
    assert.equal(csvCell('剧名,"第二季"\n完结'), '"剧名,""第二季""\n完结"');
    assert.equal(csvCell('正常文字'), '"正常文字"');
});

test('batch export retains independent links and full promotion ID precision', () => {
    const batch = { items: [{ title: '=恶意公式', targetCount: 30, readiness: { creativeCount: 3, ready: false, blockers: ['素材未齐备', '待核验'] }, promotionMode: 'both', projectId: 'p', releaseStatus: 'unverified', authorizationStatus: 'unverified', dailyBudget: 100, paidLink: { id: '1234567890123456', url: 'aweme://playlet?x=1&mode=paid', startEpisode: 9 }, freeLink: { id: '0012345678901234', url: 'aweme://playlet?x=1&mode=free', startEpisode: 2 }, failureStage: '', failureReason: '' }] };
    const csv = releaseBatchCsv(batch, [{ id: 'p', title: '素材包A' }]);
    assert.ok(csv.startsWith('\uFEFF'));
    assert.ok(csv.includes('"\'=恶意公式"'));
    assert.ok(csv.includes('"\'1234567890123456"'));
    assert.ok(csv.includes('"\'0012345678901234"'));
    assert.ok(csv.includes('aweme://playlet?x=1&mode=paid'));
    assert.ok(csv.includes('aweme://playlet?x=1&mode=free'));
    assert.ok(csv.includes('"素材包A"'));
    assert.ok(csv.includes('"素材未齐备；待核验"'));
    assert.equal(exportFilename('剧单/10:20'), '剧单_10_20.csv');
});
