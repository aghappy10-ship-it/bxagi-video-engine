import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSrt,planClips,validateClip,evaluateCampaign,csv} from '../legacy/workspace/domain.mjs';
const srt=`1\n00:00:00,000 --> 00:00:03,000\n为什么会这样？\n\n2\n00:00:03,100 --> 00:00:06,000\n原来真相在这里。\n\n3\n00:00:06,100 --> 00:00:09,000\n因为需要解决\n\n4\n00:00:09,100 --> 00:00:12,000\n这个问题！\n\n5\n00:00:12,100 --> 00:00:18,000\n终于找到答案。`;
test('SRT parse and actionable invalid ranges',()=>{
  const segments=parseSrt(srt);assert.equal(segments.length,5);assert.equal(segments[1].start,3.1);
  assert.throws(()=>parseSrt('1\n00:00:03,000 --> 00:00:01,000\n错误。'),/结束时间/);
  assert.throws(()=>parseSrt('1\n00:00:00,000 --> 00:00:03,000\n一句。\n\n2\n00:00:02,000 --> 00:00:04,000\n另一句。'),/重叠/);
});
test('plans respect sentence punctuation, limits and no overlapping candidates',()=>{
  const rows=parseSrt(srt),clips=planClips(rows,{count:3,minDuration:5,maxDuration:7,duration:18});
  assert.ok(clips.length);clips.forEach(c=>{assert.ok(c.end-c.start>=5);assert.ok(c.end-c.start<=7);assert.equal(validateClip(c,rows,18).sentencePassed,true);assert.equal(validateClip(c,rows,18).passed,false)});
  for(let i=1;i<clips.length;i++)assert.ok(clips[i].start>=clips[i-1].end);
  assert.equal(planClips([{start:0,end:6,text:'没有标点'}]).length,0);
});
test('mid-sentence cuts and unavailable transcript never pass sentence gate',()=>{
  const rows=parseSrt(srt);
  assert.equal(validateClip({start:9.1,end:12},rows,18).passed,false);
  assert.equal(validateClip({start:0,end:2.5},rows,18).passed,false);
  assert.equal(validateClip({start:0,end:6},[],18).passed,false);
  assert.equal(validateClip({start:0,end:60},rows,18).passed,false);
  assert.equal(validateClip({start:0,end:6},rows,18).checks.at(-1).status,'unverified');
});
test('unknown conversions and stale data hold without invented ROI',()=>{
  assert.equal(evaluateCampaign({dailyBudget:500,spend:200,revenue:0,hasConversion:false}).roi,null);
  assert.equal(evaluateCampaign({dailyBudget:500,spend:200,revenue:0,hasConversion:false}).action,'hold');
  assert.equal(evaluateCampaign({dailyBudget:500,spend:600,revenue:0,hasConversion:false}).action,'pause');
  assert.equal(evaluateCampaign({dailyBudget:500,spend:600,revenue:0,hasConversion:true,conversions:0,dataFresh:false}).action,'hold');
});
test('budget cap requires approval and stop-loss respects actual zero conversions',()=>{
  const good={dailyBudget:900,spend:500,revenue:1600,conversions:8,hasConversion:true,targetRoi:1.5};
  assert.equal(evaluateCampaign(good).action,'approval');assert.equal(evaluateCampaign({...good,dailyBudget:500}).action,'increase');
  assert.equal(evaluateCampaign({...good,revenue:0,conversions:0}).action,'pause');
});
test('malformed or missing money cannot become a valid zero measurement',()=>{
  const c={dailyBudget:500,spend:300,revenue:1000,conversions:5,hasConversion:true};
  for(const invalid of ['wrong',null,'',undefined,true,NaN,Infinity]){
    assert.equal(evaluateCampaign({...c,revenue:invalid}).action,'hold');
    assert.equal(evaluateCampaign({...c,revenue:invalid}).roi,null);
    assert.equal(evaluateCampaign({...c,dailyBudget:invalid}).action,'hold');
  }
});
test('CSV quotes, unicode and formula injection handling',()=>{
  const out=csv([{name:'=HYPERLINK("x")',spend:12,note:'第一行\n第二行'}]);
  assert.ok(out.startsWith('\uFEFF'));assert.ok(out.includes('"\'=HYPERLINK(""x"")"'));assert.ok(out.includes('"第一行\n第二行"'));
});
test('long transcripts retain deterministic complete-sentence selections',()=>{
  const rows=Array.from({length:1500},(_,i)=>({start:i*2,end:i*2+1.8,text:i%13===0?'为什么这个价格竟然不同？':'这一段完整解释了产品的使用方法。'}));
  const clips=planClips(rows,{count:6,minDuration:5,maxDuration:90,strategy:'hook'});
  assert.deepEqual(clips.map(c=>[c.start,c.end]),[[0,79.8],[104,183.8],[208,287.8],[312,391.8],[416,495.8],[520,599.8]]);
  assert.ok(clips.every(c=>validateClip(c,rows,3000).sentencePassed));
});
test('direct planner rejects unsorted transcript windows before selection',()=>{
  assert.throws(()=>planClips([{start:3,end:5,text:'第一句。'},{start:0,end:2,text:'第二句。'}]),/倒序/);
});
