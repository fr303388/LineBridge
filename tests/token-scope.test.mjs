import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub,digest} from '../server/hub.mjs';
import {LocalSetup} from '../server/local-setup.mjs';
import {ChatAccess} from '../server/chat-access.mjs';
import {createApps} from '../server/app.mjs';
import {scopeText,scopeChanges,saveTokenScope} from '../public/token-scope.js';

// The reported setup: a Local AI managed profile for demo-group, plus remote
// read-only and read+send tokens created from the AI access page (all chats).
async function fixture(t){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),hub=new Hub(store,vault);
  const items=new Map(),credentials={protection:'synthetic',async create(profile,url,value){items.set(profile,{url,...value});},async get(profile){if(!items.has(profile))throw Error('locked');return items.get(profile);},async forget(profile){items.delete(profile);}};
  const setup=new LocalSetup(hub,{credentials}),access=new ChatAccess(setup,{ownershipTimeoutMs:20});
  const {id}=await hub.addAccount({label:'Synthetic',kind:'demo'});
  await setup.enable(id,{chatIds:['demo-group'],read:true,send:true,confirmed:true});
  t.after(()=>{hub.close();store.close();});
  const readOnly=hub.createToken({name:'NAS read',grants:[{accountId:id,read:true,send:false}]});
  const readSend=hub.createToken({name:'NAS read+send',grants:[{accountId:id,read:true,send:true}]});
  const update=(token,grants,extra={})=>hub.updateTokenScope(token.id,{grants,currentGrants:store.token(token.id).grants,confirmed:true,...extra});
  const designate=(enabled,chat='demo-openchat')=>access.apply(id,chat,{enabled,confirmed:true,snapshot:access.preview(id,chat).snapshot});
  return {store,hub,setup,access,id,readOnly,readSend,update,designate};
}
const chatsOf=(f,token)=>f.hub.chats(f.hub.authenticate(token.token),f.id).map(c=>c.id).sort();

test('adding a chat no longer requires reissuing remote tokens: pin, designate, then explicitly widen each token (#20)',async t=>{
  const f=await fixture(t);
  // Before: designating a new chat would silently widen both all-chats tokens.
  await assert.rejects(f.designate(true),{code:'manual_grant_conflict'});
  // 1. Pin each remote token to the chats it can use today. No access is gained.
  for(const token of [f.readOnly,f.readSend])f.update(token,[{accountId:f.id,read:true,send:token===f.readSend,chatIds:['demo-group']}]);
  // 2. Designating the new chat no longer conflicts, and neither token gains it.
  await f.designate(true);
  for(const token of [f.readOnly,f.readSend])assert.deepEqual(chatsOf(f,token),['demo-group']);
  // 3. The user explicitly widens only the token that should see the new chat.
  const saved=f.update(f.readSend,[{accountId:f.id,read:true,send:true,chatIds:['demo-group','demo-openchat']}]);
  assert.deepEqual(saved.grants,[{accountId:f.id,read:true,send:true,chatIds:['demo-group','demo-openchat']}]);assert.equal(saved.hash,undefined);
  assert.deepEqual(chatsOf(f,f.readSend),['demo-group','demo-openchat']);assert.deepEqual(chatsOf(f,f.readOnly),['demo-group']);
  // The bearer, expiry and the other clients' grants are unchanged.
  assert.equal(f.store.token(f.readSend.id).hash,digest(f.readSend.token));assert.equal(f.store.token(f.readSend.id).expires_at,f.readSend.expires_at);
  assert.ok(f.hub.authenticate(f.readSend.token));assert.deepEqual(f.store.token(f.setup.record(f.id).tokenId).grants[0].chatIds,['demo-group','demo-openchat']);
  assert.equal(f.store.audits().filter(a=>a.action==='token.scope').length,3);
  assert.doesNotMatch(JSON.stringify(f.store.audits()),new RegExp(f.readSend.token));
});

test('scope edits can change permissions, return to all chats, and remove an account grant',async t=>{
  const f=await fixture(t),actor=()=>f.hub.authenticate(f.readOnly.token);
  f.update(f.readOnly,[{accountId:f.id,read:true,send:true}]);
  assert.equal(f.hub.accounts(actor())[0].permissions.send,true);
  f.update(f.readOnly,[{accountId:f.id,read:false,send:true,chatIds:['demo-group']}]);
  await assert.rejects(f.hub.read(actor(),f.id,'demo-group'),{code:'scope_denied'});
  const other=(await f.hub.addAccount({label:'Second',kind:'demo'})).id;
  const both=f.hub.createToken({name:'two accounts',grants:[{accountId:f.id,read:true,send:false},{accountId:other,read:true,send:false}]});
  f.update(both,[{accountId:other,read:true,send:false}]);assert.deepEqual(f.store.token(both.id).grants.map(g=>g.accountId),[other]);
});

test('scope edits fail closed on stale, inactive, managed, undesignated or malformed input',async t=>{
  const f=await fixture(t),grants=[{accountId:f.id,read:true,send:false,chatIds:['demo-group']}],before=()=>f.store.token(f.readOnly.id).grants;
  const original=before();
  assert.throws(()=>f.hub.updateTokenScope(f.readOnly.id,{grants,currentGrants:[{accountId:f.id,read:true,send:true}],confirmed:true}),{code:'token_scope_changed'});
  // Reordered chat lists still identify the current scope.
  f.update(f.readOnly,[{accountId:f.id,read:true,send:false,chatIds:['demo-group']}]);
  assert.throws(()=>f.update(f.readOnly,[{accountId:f.id,read:true,send:false,chatIds:['demo-openchat']}]),{code:'chat_not_designated'});
  assert.throws(()=>f.update(f.readOnly,[{accountId:f.id,read:true,send:false,chatIds:['missing-chat']}]),{code:'chat_not_found'});
  assert.throws(()=>f.update(f.readOnly,[{accountId:f.id,read:true,send:false,chatIds:['demo-group','demo-group']}]),{code:'duplicate_chat'});
  assert.throws(()=>f.update(f.readOnly,[{accountId:f.id,read:false,send:false}]),{code:'empty_grant'});
  assert.throws(()=>f.update(f.readOnly,[{accountId:f.id,read:true,send:false},{accountId:f.id,read:true,send:false}]),{code:'duplicate_grant'});
  assert.throws(()=>f.update(f.readOnly,[{accountId:'missing',read:true,send:false}]),{code:'account_not_found'});
  for(const bad of [{confirmed:false},{grants:[{accountId:f.id,read:true,send:false,localOnly:true}]},{grants:[]},{extra:true}])
    assert.throws(()=>f.update(f.readOnly,grants,bad),{name:'ZodError'});
  assert.throws(()=>f.hub.updateTokenScope('missing',{grants,currentGrants:[],confirmed:true}),{code:'token_not_found'});
  const managed=f.store.token(f.setup.record(f.id).tokenId);
  assert.throws(()=>f.update(managed,[{accountId:f.id,read:true,send:true,chatIds:['demo-group']}]),{code:'managed_token'});
  f.store.revoke(f.readSend.id);assert.throws(()=>f.update(f.readSend,grants),{code:'token_inactive'});
  const expired=f.hub.createToken({name:'expired',grants:[{accountId:f.id,read:true,send:false}]});
  f.store.db.prepare('UPDATE tokens SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',expired.id);assert.throws(()=>f.update(expired,grants),{code:'token_inactive'});
  assert.deepEqual(before(),[{accountId:f.id,read:true,send:false,chatIds:['demo-group']}]);assert.notDeepEqual(before(),original);
});

test('a chat the token already lists stays editable after it is undesignated, but cannot be re-added',async t=>{
  const f=await fixture(t);
  f.update(f.readOnly,[{accountId:f.id,read:true,send:false,chatIds:['demo-group']}]);f.update(f.readSend,[{accountId:f.id,read:true,send:true,chatIds:['demo-group']}]);
  await f.designate(true);f.update(f.readOnly,[{accountId:f.id,read:true,send:false,chatIds:['demo-group','demo-openchat']}]);
  // Undesignation is a shared gate: the listed chat is no longer readable.
  f.hub.designate(f.id,'demo-openchat',false);assert.deepEqual(chatsOf(f,f.readOnly),['demo-group']);
  f.update(f.readOnly,[{accountId:f.id,read:true,send:true,chatIds:['demo-group','demo-openchat']}]);
  f.update(f.readOnly,[{accountId:f.id,read:true,send:true,chatIds:['demo-group']}]);
  assert.throws(()=>f.update(f.readOnly,[{accountId:f.id,read:true,send:true,chatIds:['demo-group','demo-openchat']}]),{code:'chat_not_designated'});
});

test('HTTP token scope update requires dashboard session, origin, explicit confirmation and the current grants',async t=>{
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const f=await fixture(t),apps=createApps({hub:f.hub,localSetup:f.setup,tunnels:{config:()=>({provider:'local'})},root:resolve('.'),adminPort:port}),server=apps.admin.listen(port,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${port}`,route=`${base}/admin/tokens/${f.readOnly.id}/grants`;
  const body=JSON.stringify({grants:[{accountId:f.id,read:true,send:false,chatIds:['demo-group']}],currentGrants:f.readOnly.grants,confirmed:true});
  assert.equal((await fetch(route,{method:'PUT',headers:{'Content-Type':'application/json'},body})).status,401);
  const cookie=(await fetch(base)).headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,'Content-Type':'application/json'};
  assert.equal((await fetch(route,{method:'PUT',headers,body})).status,403);
  Object.assign(headers,{Origin:base,'X-Line-Bridge':'dashboard'});
  assert.equal((await fetch(route,{method:'PUT',headers,body:JSON.stringify({...JSON.parse(body),confirmed:false})})).status,400);
  const response=await fetch(route,{method:'PUT',headers,body});assert.equal(response.status,200);
  const saved=await response.json();assert.deepEqual(saved.grants[0].chatIds,['demo-group']);assert.equal(saved.hash,undefined);assert.equal(saved.token,undefined);
  const stale=await fetch(route,{method:'PUT',headers,body});assert.equal(stale.status,409,'A stale scope is never overwritten');assert.equal((await stale.json()).error,'token_scope_changed');
  assert.deepEqual(f.store.token(f.readOnly.id).grants[0].chatIds,['demo-group']);assert.ok(f.hub.authenticate(f.readOnly.token));
});

test('browser summarizes each change, flags widening, and sends only the confirmed scope once',async()=>{
  const names={accountName:id=>({a:'Account A',b:'Account B'})[id],chatName:(_a,c)=>({g:'Group',o:'OpenChat',x:'Other'})[c]??c};
  const all=[{accountId:'a',read:true,send:false}],pinned=[{accountId:'a',read:true,send:false,chatIds:['g']}];
  assert.equal(scopeText(all[0]),'所有開放聊天室');assert.equal(scopeText(pinned[0]),'1 個指定聊天室');
  let s=scopeChanges(all,pinned,names);assert.equal(s.widens,false);assert.match(s.lines[0],/Account A：改為只限 1 個指定聊天室/);
  s=scopeChanges(pinned,all,names);assert.equal(s.widens,true);assert.match(s.lines[0],/包含日後開放/);
  s=scopeChanges(pinned,[{accountId:'a',read:true,send:false,chatIds:['g','o']}],names);assert.equal(s.widens,true);assert.deepEqual(s.lines,['Account A：新增聊天室 OpenChat']);
  s=scopeChanges([{accountId:'a',read:true,send:false,chatIds:['g','o']}],pinned,names);assert.equal(s.widens,false);assert.deepEqual(s.lines,['Account A：移除聊天室 OpenChat']);
  s=scopeChanges(pinned,[{accountId:'a',read:false,send:true,chatIds:['g']}],names);assert.equal(s.widens,true);assert.deepEqual(s.lines,['Account A：移除讀取權限','Account A：新增傳送權限']);
  s=scopeChanges([...pinned,{accountId:'b',read:true,send:false}],pinned,names);assert.equal(s.widens,false);assert.deepEqual(s.lines,['Account B：移除此帳號的所有權限']);
  assert.equal(scopeChanges(pinned,[{...pinned[0],chatIds:['g']}],names).changed,false);
  const token={id:'tok/1',name:'NAS read',grants:pinned},requests=[];let message;
  const request=async(path,options)=>{requests.push([path,options]);return {id:'tok/1'};};
  assert.deepEqual(await saveTokenScope({token,grants:pinned,names,request,confirm:()=>assert.fail('No confirmation for no change')}),{unchanged:true});
  assert.deepEqual(await saveTokenScope({token,grants:all,names,request,confirm:text=>{message=text;return false;}}),{cancelled:true});assert.equal(requests.length,0);
  assert.match(message,/^擴大權杖「NAS read」/);assert.match(message,/只會變更這把權杖/);assert.match(message,/不需更換權杖/);
  const result=await saveTokenScope({token,grants:all,names,request,confirm:()=>true});assert.equal(result.saved,true);assert.equal(requests.length,1);
  assert.equal(requests[0][0],'/tokens/tok%2F1/grants');assert.equal(requests[0][1].method,'PUT');
  assert.deepEqual(JSON.parse(requests[0][1].body),{grants:all,currentGrants:pinned,confirmed:true});
});
