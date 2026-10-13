import test from 'node:test';
import assert from 'node:assert/strict';
import {Protocols} from '@evex/linejs/thrift';
import {LineDriver} from '../server/drivers.mjs';
import {LiveMonitor} from '../protocol/monitor.mjs';
import {monitorStatus} from '../server/inbox.mjs';
import {Store} from '../server/store.mjs';
import {TALK_IDLE_EXPIRY_MIN_MS} from '../server/monitor-policy.mjs';

const START=Date.parse('2026-10-13T00:00:00Z');
const settle=async(times=50)=>{for(let i=0;i<times;i++)await new Promise(resolve=>setImmediate(resolve));};
const gone=(headers={})=>({holdMs:110000,respond:()=>new Response(null,{status:410,headers})});
// A real driver and pinned SDK: only the network is synthetic. Each Talk poll
// is held for holdMs of mocked time and answered in order; later polls stay pending.
function fixture(t,{polls,latest=5,latestFails=false,cursor={revision:5n,globalRev:0,individualRev:0}}){
  t.mock.timers.enable({apis:['Date','setTimeout'],now:START});
  const calls={sync:0,latest:0},saved=[],states=[];let client;
  const driver=new LineDriver({device:'IOSIPAD'},{},{fault:()=>{}},{fetch:async(url,{signal})=>{
    if(new URL(url).pathname==='/SYNC4'){
      const poll=polls[calls.sync++];
      if(!poll)return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
      t.mock.timers.setTime(Date.now()+poll.holdMs);return poll.respond();
    }
    calls.latest++;
    return latestFails?new Response(null,{status:503}):new Response(client.thrift.writeThrift([[10,0,latest]],'getLastOpRevision',Protocols[4]));
  }});
  client=driver.client;client.legy.encrypted=false;client.authToken='synthetic-token-only';client.profile={mid:'u-self'};
  driver.storage={get:async key=>key==='monitor.talk'?cursor:undefined,set:async(key,value)=>{saved.push([key,value]);}};
  const monitor=new LiveMonitor(driver,(_event,state)=>states.push(state),()=>assert.fail('No messages are captured'),{random:()=>0});
  monitor.update([{id:'c-group',kind:'group'}]);
  t.after(async()=>{monitor.stop();await monitor.done();driver.stop();});
  return {calls,saved,states,tick:async ms=>{t.mock.timers.tick(ms);await settle();}};
}

test('a held empty Talk HTTP 410 confirmed by the latest revision is an idle expiry, not a failure',async t=>{
  const f=fixture(t,{polls:[gone()]});await f.tick(1000);
  assert.equal(f.calls.sync,1);assert.equal(f.calls.latest,1);
  const state=f.states.at(-1);
  assert.equal(state.status,'running');assert.equal(state.error,undefined);assert.equal(state.ready,true);
  assert.equal(state.lastSuccessAt,new Date(START+1000+110000).toISOString());assert.equal(state.lastIdleExpiryAt,state.lastSuccessAt);
  assert.equal(state.lastFailure,null);assert.equal(state.nextRetryAt,null);
  assert.ok(!f.states.some(s=>s.status==='retrying'));
  // The unchanged cursor is durably saved, exactly like an empty sync page.
  assert.deepEqual(f.saved,[['monitor.talk',{revision:5n,globalRev:0,individualRev:0}]]);
  // Health reports a healthy receiver instead of a sticky retrying state.
  const store=new Store(':memory:');t.after(()=>store.close());const account=store.addAccount('Synthetic','line','IOSIPAD');
  store.putChat(account.id,{id:'c-group',name:'Group',kind:'group'});store.designate(account.id,'c-group',true);store.setSetting(`monitor:${account.id}`,true);
  const health=monitorStatus(store,account.id,{talk:state});assert.equal(health.health,'healthy');assert.equal(health.status,'running');
  assert.equal(health.streams.talk.lastIdleExpiryAt,state.lastIdleExpiryAt);
  // The poll is re-armed promptly with the same cursor.
  await f.tick(250);assert.equal(f.calls.sync,2);assert.equal(f.states.at(-1).status,'polling');
  assert.equal(f.states.at(-1).lastIdleExpiryAt,state.lastIdleExpiryAt);
});

test('an idle expiry honors a bounded Retry-After before polling again',async t=>{
  const f=fixture(t,{polls:[gone({'retry-after':'12'})]});await f.tick(1000);
  assert.equal(f.states.at(-1).status,'running');
  await f.tick(11999);assert.equal(f.calls.sync,1);
  await f.tick(1);assert.equal(f.calls.sync,2);
});

test('a 410 stays a visible failure unless it is a held, empty, revision-confirmed idle expiry',async t=>{
  for(const [name,options,latestCalls] of [
    ['newer upstream operation',{polls:[gone()],latest:6},1],
    ['revision check failure',{polls:[gone()],latestFails:true},1],
    ['quick 410',{polls:[{holdMs:TALK_IDLE_EXPIRY_MIN_MS-1,respond:()=>new Response(null,{status:410})}]},0],
    ['non-empty 410 body',{polls:[{holdMs:110000,respond:()=>new Response('SYNTHETIC_PRIVATE_BODY',{status:410})}]},0],
    ['other held empty status',{polls:[{holdMs:110000,respond:()=>new Response(null,{status:404})}]},0],
  ])await t.test(name,async t=>{
    const f=fixture(t,options);await f.tick(1000);
    const state=f.states.at(-1);
    assert.equal(state.status,'retrying');assert.equal(state.error,'monitor_poll_failed');assert.equal(state.lastIdleExpiryAt,undefined);
    assert.equal(state.lastFailure.stage,'poll');assert.equal(state.lastFailure.kind,'http');assert.equal(state.lastSuccessAt,null);
    assert.equal(f.calls.latest,latestCalls);assert.deepEqual(f.saved,[]);
    assert.ok(!JSON.stringify(f.states).includes('SYNTHETIC_PRIVATE'));
  });
});

test('a confirmed idle expiry after a real failure clears retrying and keeps the earlier diagnostic',async t=>{
  const reset={holdMs:5,respond:()=>{throw Object.assign(new TypeError('SYNTHETIC_PRIVATE_HOST'),{cause:{code:'ECONNRESET'}});}};
  const f=fixture(t,{polls:[reset,gone()]});await f.tick(1000);
  const failure=f.states.at(-1);assert.equal(failure.status,'retrying');assert.equal(failure.lastFailure.kind,'network');
  await f.tick(failure.lastFailure.retryInMs);
  const recovered=f.states.at(-1);
  assert.equal(recovered.status,'running');assert.equal(recovered.error,undefined);assert.ok(recovered.lastIdleExpiryAt);
  assert.deepEqual(recovered.lastFailure,failure.lastFailure);assert.equal(f.calls.sync,2);
  assert.ok(!JSON.stringify(f.states).includes('SYNTHETIC_PRIVATE'));
});
