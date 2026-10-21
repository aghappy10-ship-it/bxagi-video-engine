import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProviderClient } from '../server/adapters/provider-http.mjs';

test('channel redirects never forward credentials or write bodies, and writes require reconciliation', async () => {
  const received=[];
  const server=createServer((request,response)=>{
    received.push({path:request.url,token:request.headers['access-token']});
    if(request.url==='/redirect'){
      response.writeHead(307,{Location:'/destination','Content-Type':'text/html'});
      response.end('redirect, not a channel receipt');
    }else{response.writeHead(200,{'Content-Type':'application/json'});response.end('{"code":0,"data":{}}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const local=`http://127.0.0.1:${server.address().port}/redirect`;
    const client=createProviderClient({accessToken:'private-test-channel-token',fetcher:(_url,init)=>fetch(local,init)});
    for(const method of ['GET','POST']){
      await assert.rejects(client('/open_api/test/',{method,...(method==='POST'?{body:{advertiser_id:'123',operation:'ENABLE'}}:{})}),error=>{
        assert.equal(error.code,'provider_redirect_refused');
        assert.equal(error.uncertain,method==='POST');
        assert.ok(!error.message.includes('private-test-channel-token'));
        return true;
      });
    }
    assert.deepEqual(received.map(item=>item.path),['/redirect','/redirect']);
    assert.ok(received.every(item=>item.token==='private-test-channel-token'));
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('all redirect statuses are refused even without a Location or JSON receipt',async()=>{
  for(const status of [300,301,302,303,304,305,307,308]){
    let cancelled=false,calls=0;
    const request=createProviderClient({accessToken:'private-channel-token',fetcher:async()=>{
      calls++;
      if(status===304)return new Response(null,{status});
      return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('not JSON'));},cancel(){cancelled=true;}}),{status});
    }});
    await assert.rejects(request('/open_api/test/'),error=>error.code==='provider_redirect_refused'&&!error.uncertain);
    assert.equal(calls,1);
    if(status!==304)assert.equal(cancelled,true);
  }
});
