import test from 'node:test';
import assert from 'node:assert/strict';
import {dailySnapshots,metricTotals} from '../components/platform/metrics.mjs';
import {uploadMime} from '../components/platform/uploads.mjs';

test('daily totals do not add duplicate campaign snapshots or source copies',()=>{
  const metrics=[{id:'a',campaignId:'one',date:'2026-10-14',source:'manual',spend:300,createdAt:'2026-10-14T10:00:00Z'},
    {id:'b',campaignId:'one',date:'2026-10-14',source:'oceanengine',spend:200,createdAt:'2026-10-14T09:00:00Z'},
    {id:'c',campaignId:'one',date:'2026-10-14',source:'oceanengine',spend:250,createdAt:'2026-10-14T11:00:00Z'},
    {id:'d',campaignId:'two',date:'2026-10-14',source:'manual',spend:100}];
  assert.deepEqual(dailySnapshots(metrics).map(row=>row.id),['c','d']);
  assert.equal(metricTotals(metrics).spend,350);
});
test('unknown conversions never become a zero revenue or fabricated ROI',()=>{
  const unknown=metricTotals([{campaignId:'one',date:'2026-10-14',source:'manual',spend:100,revenue:999,hasConversion:false}]);
  assert.equal(unknown.revenue,null);assert.equal(unknown.roi,null);
  const mixed=metricTotals([{campaignId:'one',date:'2026-10-13',source:'manual',spend:100,revenue:200,hasConversion:true},{campaignId:'one',date:'2026-10-14',source:'manual',spend:100,revenue:null,hasConversion:true}]);
  assert.equal(mixed.revenue,null);assert.equal(mixed.roi,null);
});
test('known zero revenue and no spend remain distinct from unknown conversion',()=>{
  const zero=metricTotals([{campaignId:'one',date:'2026-10-14',source:'manual',spend:100,revenue:0,hasConversion:true}]);
  assert.equal(zero.revenue,0);assert.equal(zero.roi,0);
  const noSpend=metricTotals([{campaignId:'one',date:'2026-10-14',source:'manual',spend:0,revenue:200,hasConversion:true}]);assert.equal(noSpend.roi,null);
});
test('browser SRT and Markdown files send supported types instead of empty/octet-stream types',()=>{
  assert.equal(uploadMime('字幕.srt',''),'application/x-subrip');
  assert.equal(uploadMime('产品卖点.md','text/markdown'),'text/plain');
  assert.equal(uploadMime('captions.vtt','text/vtt'),'text/plain');
  assert.equal(uploadMime('原始照片.jpg','image/jpeg'),'image/jpeg');
  assert.equal(uploadMime('unknown.bin',''),'application/octet-stream');
});

import {campaignKnownSpend,operationOutcome} from '../components/platform/metrics.mjs';
test('campaign cumulative spend uses authenticated lifetime report when available',()=>{
  assert.equal(campaignKnownSpend([], 'one'),null);
  const metrics=[{campaignId:'one',date:'2026-10-13',spend:100,source:'oceanengine',metadata:{lifetimeSpend:500}},{campaignId:'one',date:'2026-10-14',spend:150,source:'oceanengine',metadata:{lifetimeSpend:650}},{campaignId:'two',date:'2026-10-14',spend:9999,source:'oceanengine'}];
  assert.deepEqual(campaignKnownSpend(metrics,'one'),{spend:650,source:'channel'});
});
test('HTTP 200 report or launch failures never display successful submission',()=>{
  assert.equal(operationOutcome({campaign:{status:'active',error:'令牌过期'},metric:null},'sync').error,'令牌过期');
  assert.equal(operationOutcome({campaign:{status:'blocked',error:'缺少官方参数'}},'launch').error,'缺少官方参数');
  assert.match(operationOutcome({campaign:{status:'active'},metric:null,decision:{action:'hold',reason:'数据不足'}},'sync').notice,/保留预算.*数据不足/);
});
