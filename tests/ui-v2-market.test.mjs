import test from 'node:test';
import assert from 'node:assert/strict';
import {marketEntries,activationLabel,quoteText,listQuoteText,activationFeeNote,freeActivationVerified,activationReasonText} from '../components/platform/market.mjs';
const market={provider:'bxagi',id:'bxagi:market:design',marketId:'design',resourceType:'marketplace_template',marketVerified:true,sourceVerified:true,activationState:'not_installed',usable:false};

test('market roles exclude historical conversation profiles while keeping proven installed market resources',()=>{
  const historical={provider:'bxagi',id:'bxagi:used-before',providerId:'used-before',conversationId:'conversation-1',usable:true};
  const installed={...market,id:'bxagi:market:installed',marketId:'installed',resourceType:'installed_employee',activationState:'ready',usable:true};
  assert.deepEqual(marketEntries([historical,market,installed,{...market,provider:'other'}]).map(row=>row.marketId),['design','installed']);
});
test('activation status comes from verified market activation, never from conversation presence alone',()=>{
  assert.equal(activationLabel(market),'待启用');
  assert.equal(activationLabel({...market,activationState:'ready',usable:true}),'已启用');
  assert.equal(activationLabel({...market,activationState:'ready',usable:true,sourceVerified:false}),'启用资源待核实');
  assert.equal(activationLabel({...market,activationState:'not_installed',sourceVerified:false}),'待启用');
  assert.equal(activationLabel({...market,activationState:'ready',usable:false}),'已启用 · 暂不可执行');
});
test('unknown quote and numeric zero without verified free eligibility are not presented as free',()=>{
  assert.equal(quoteText(market),'报价待核实');
  assert.equal(quoteText({...market,activation:{quote:{monthly:null,annual:null,currency:'CNY'}}}),'报价待核实');
  assert.equal(freeActivationVerified({...market,activation:{freeVerified:false,quote:{monthly:0,annual:0,currency:'CNY'}}}),false);
  assert.equal(freeActivationVerified({...market,activation:{freeVerified:false}}),false);
});
test('actual market quotes stay visible while verified deployment subscription waiver is honored',()=>{
  const paid={...market,activation:{freeVerified:true,quote:{monthly:29.9,annual:300,currency:'CNY'}}};
  assert.equal(quoteText(paid),'¥29.9/月 · ¥300/年');assert.equal(freeActivationVerified(paid),true);
  assert.equal(freeActivationVerified({...paid,sourceVerified:false}),true);
  assert.equal(freeActivationVerified({...paid,activation:{...paid.activation,freeVerified:false}}),false);
  const zero={...market,activation:{freeVerified:true,quote:{monthly:'0',annual:0,currency:'CNY'}}};
  assert.equal(quoteText(zero),'¥0/月 · ¥0/年');assert.equal(freeActivationVerified(zero),true);
  assert.equal(freeActivationVerified({...zero,marketVerified:false}),false);
});
test('market activation reasons use Chinese explanations without implying quota is a verified free price',()=>{
  assert.equal(activationReasonText({...market,activation:{reason:'quota_available_but_not_price_locked'}}),'有免费名额，最终费用待确认');
  assert.equal(activationReasonText({...market,activation:{reason:'renewal_required'}}),'需续费');
  assert.equal(activationReasonText({...market,activation:{reason:{code:'private_deployment'}}}),'私有部署');
  assert.equal(activationReasonText({...market,activation:{reason:'new_internal_code'}}),'启用条件待核实');
  assert.equal(activationReasonText(market),'');
});
test('verified Solo quota displays this activation as free and retains list prices separately',()=>{
  const solo={...market,sourceVerified:false,activation:{freeVerified:true,freeBasis:'solo_quota',reason:'solo_quota_available',quote:{monthly:0,annual:0,currency:'CNY'},listQuote:{monthly:99,annual:999,currency:'CNY'}}};
  assert.equal(quoteText(solo),'本次启用免费 · 使用 Solo 免费名额');
  assert.equal(activationFeeNote(solo),'启用前重新核对可用名额');
  assert.equal(listQuoteText(solo),'¥99/月 · ¥999/年');
  assert.equal(activationReasonText(solo),'Solo 免费名额可用');
  assert.equal(quoteText({...solo,activation:{...solo.activation,freeVerified:false}}),'¥0/月 · ¥0/年');
  assert.equal(activationFeeNote({...solo,marketVerified:false}),'报价按市场返回显示，启用费用仍以官方确认方案为准');
  assert.equal(activationFeeNote({...solo,activation:{...solo.activation,freeBasis:'private_deployment'}}),'当前部署无需订阅费用（已核实）');
  assert.equal(activationFeeNote({...solo,activation:{...solo.activation,freeBasis:'zero_price'}}),'当前部署无需订阅费用（已核实）');
});
