import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../server/store.mjs';
import { Vault } from '../server/vault.mjs';
import { Hub } from '../server/hub.mjs';
import { Tunnels } from '../server/tunnels.mjs';
import { createApps } from '../server/app.mjs';
import {VERSION} from '../server/version.mjs';

async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function rawStatus(url,headers){return new Promise((resolve,reject)=>{const req=request(url,{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});}
test('HTTP and MCP share scopes; the gateway cannot expose dashboard routes or bypass Cloudflare Access',async t=>{
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);
  const adminPort=await freePort(),gatewayPort=await freePort(),root=resolve('.'),tunnels=new Tunnels(store,vault,root,gatewayPort);
  const apps=createApps({hub,tunnels,root,adminPort,gatewayPort});
  const adminServer=apps.admin.listen(adminPort,'127.0.0.1'),gatewayServer=apps.gateway.listen(gatewayPort,'127.0.0.1');
  t.after(()=>{hub.close();tunnels.close();adminServer.closeAllConnections();gatewayServer.closeAllConnections();adminServer.close();gatewayServer.close();store.close();});
  const a=await hub.addAccount({label:'Test sandbox',kind:'demo'});hub.designate(a.id,'demo-group',true);
  await hub.monitor(a.id,true);
  const token=hub.createToken({name:'AI',grants:[{accountId:a.id,read:true,send:true}]});
  const base=`http://127.0.0.1:${gatewayPort}`,headers={Authorization:`Bearer ${token.token}`};
  assert.equal((await fetch(`${base}/api/v1/version`)).status,401);
  assert.equal((await fetch(`${base}/api/v1/version`,{headers:{Authorization:'Bearer invalid'}})).status,401);
  const version=await (await fetch(`${base}/api/v1/version`,{headers})).json();assert.deepEqual(version,{service:'LineBridge',version:VERSION});
  const schema=await (await fetch(`${base}/openapi.json`,{headers})).json();assert.equal(schema.paths['/api/v1/version'].get.operationId,'getVersion');
  assert.equal((await fetch(`${base}/api/v1/accounts`)).status,401);
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{...headers,Origin:'https://attacker.example'}})).status,403);
  assert.equal(await rawStatus(`${base}/api/v1/accounts`,{...headers,Host:'attacker.example'}),403);
  assert.equal((await fetch(`${base}/admin/state`,{headers})).status,404);
  const endpoint=`${base}/api/v1/accounts/${a.id}/chats/demo-group/messages`;
  assert.equal((await fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"text":"hello"}'})).status,400);
  const first=await fetch(endpoint,{method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':'http-send-001'},body:'{"text":"hello"}'});
  assert.equal(first.status,200);assert.equal((await first.json()).delivery,'sandbox_only');
  const read=await (await fetch(endpoint,{headers})).json();assert.ok(read.messages.some(m=>m.text==='hello'));
  assert.equal((await fetch(`${endpoint}?fresh=true`,{headers})).status,200);
  assert.equal((await fetch(`${endpoint}?fresh=invalid`,{headers})).status,400);
  const search=await fetch(`${base}/api/v1/messages/search`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({query:'HELLO',mode:'phrase'})});assert.equal(search.status,200);assert.equal((await search.json()).results[0].message.text,'hello');
  assert.equal((await fetch(`${base}/api/v1/messages/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"query":"hello"}'})).status,401);
  const client=new Client({name:'integration-test',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}});
  await client.connect(transport);t.after(()=>client.close());
  const toolList=await client.listTools();assert.equal(toolList.tools.length,10);assert.equal(toolList.tools.find(tool=>tool.name==='line_read_audio').annotations.readOnlyHint,true);
  const versionTool=toolList.tools.find(tool=>tool.name==='line_get_version');assert.equal(versionTool.annotations.readOnlyHint,true);
  assert.equal(client.getServerVersion().version,VERSION);
  const mcpVersion=await client.callTool({name:'line_get_version',arguments:{}});assert.deepEqual(JSON.parse(mcpVersion.content[0].text),version);
  const result=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-group',limit:10}});
  assert.equal(JSON.parse(result.content[0].text).untrustedContent,true);
  const archived=await client.callTool({name:'line_search_messages',arguments:{query:'hello'}});assert.equal(JSON.parse(archived.content[0].text).results.length,1);
  const denied=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-openchat'}});assert.equal(denied.isError,true);
  const local=`http://127.0.0.1:${adminPort}`;
  assert.equal((await fetch(`${local}/admin/state`)).status,401);
  const index=await fetch(`${local}/`),cookie=index.headers.getSetCookie()[0].split(';')[0];assert.equal(index.status,200);
  const dashboard=await (await fetch(`${local}/admin/state`,{headers:{Cookie:cookie}})).json();assert.equal(dashboard.version,version.version);
  assert.equal((await fetch(`${local}/admin/pause`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{"enabled":false}'})).status,403);
  assert.equal(await rawStatus(`${local}/admin/state`,{Cookie:cookie,Host:'evil.example'}),403);
  const badCallback=await fetch(`${local}/oauth/cloudflare/callback?state=wrong&code=untrusted-secret`,{headers:{'Sec-Fetch-Site':'cross-site'}});
  assert.equal(badCallback.status,400);assert.equal(badCallback.headers.getSetCookie().length,0);assert.ok(!(await badCallback.text()).includes('untrusted-secret'));
  assert.equal(await rawStatus(`${local}/oauth/cloudflare/callback`,{Host:'evil.example','Sec-Fetch-Site':'cross-site'}),403);
  store.setSetting('tunnel',{provider:'cloudflare_quick',hostname:'',teamDomain:'',audience:''});tunnels.quickHost='test-tunnel.trycloudflare.com';
  assert.equal(await rawStatus(`${base}/api/v1/accounts`,{...headers,Host:tunnels.quickHost}),200);
  assert.equal(await rawStatus(`${base}/api/v1/accounts`,{Host:tunnels.quickHost}),401);
  tunnels.quickHost=null;assert.equal(await rawStatus(`${base}/api/v1/accounts`,{...headers,Host:'test-tunnel.trycloudflare.com'}),403);
  store.setSetting('tunnel',{provider:'cloudflare',hostname:'line.example.com',teamDomain:'example.cloudflareaccess.com',audience:'test-audience'});
  // A localhost or forwarded-host header cannot disable the configured Access requirement.
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers})).status,401);
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{...headers,'CF-Access-Jwt-Assertion':'fake'}})).status,401);
  assert.equal((await fetch(`${base}/health`)).status,200);
});

async function localGateway(t,requireToken=false){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault),adminPort=await freePort(),gatewayPort=await freePort(),root=resolve('.'),tunnels=new Tunnels(store,vault,root,gatewayPort);
  const apps=createApps({hub,tunnels,root,adminPort,gatewayPort,requireToken}),admin=apps.admin.listen(adminPort,'127.0.0.1'),gateway=apps.gateway.listen(gatewayPort,'127.0.0.1');
  t.after(()=>{hub.close();tunnels.close();for(const s of [admin,gateway]){s.closeAllConnections();s.close();}store.close();});
  return {store,hub,base:`http://127.0.0.1:${gatewayPort}`,adminBase:`http://127.0.0.1:${adminPort}`};
}

test('HTTP, admin search and MCP apply validated message time bounds with read scope',async t=>{
  const {hub,base,adminBase}=await localGateway(t,true);
  const account=await hub.addAccount({label:'Time fixture',kind:'demo'});hub.designate(account.id,'demo-group',true);await hub.monitor(account.id,true);
  for(const [id,timestamp] of [['start','2026-10-06T00:00:00Z'],['end','2026-10-07T00:00:00Z']])hub.capture(account.id,'demo-group',{id,text:'time needle',timestamp});
  const reader=hub.createToken({name:'Range reader',grants:[{accountId:account.id,read:true,send:false}]}),headers={Authorization:`Bearer ${reader.token}`,'Content-Type':'application/json'};
  const input={query:'needle',startTime:'2026-10-06T08:00:00+08:00',endTime:'2026-10-07T00:00:00Z'};
  const post=(body,requestHeaders=headers)=>fetch(`${base}/api/v1/messages/search`,{method:'POST',headers:requestHeaders,body:JSON.stringify(body)});
  const result=await post(input);assert.equal(result.status,200);assert.deepEqual((await result.json()).results.map(r=>r.message.id),['start']);
  for(const bad of [{startTime:'2026-10-06'},{endTime:'2026-02-30T00:00:00Z'},{startTime:input.endTime,endTime:input.startTime}])assert.equal((await post({...input,...bad})).status,400);
  const sender=hub.createToken({name:'No read',grants:[{accountId:account.id,read:false,send:true}]});assert.equal((await post({...input,accountId:account.id},{...headers,Authorization:`Bearer ${sender.token}`})).status,403);
  const index=await fetch(adminBase),cookie=index.headers.getSetCookie()[0].split(';')[0];
  const adminResult=await fetch(`${adminBase}/admin/messages/search`,{method:'POST',headers:{Cookie:cookie,Origin:adminBase,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify(input)});
  assert.equal(adminResult.status,200);assert.equal((await adminResult.json()).results.length,1);
  const client=new Client({name:'time-fixture',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}}));t.after(()=>client.close());
  const mcp=await client.callTool({name:'line_search_messages',arguments:input});assert.equal(JSON.parse(mcp.content[0].text).results[0].message.id,'start');
  const invalid=await client.callTool({name:'line_search_messages',arguments:{...input,startTime:'2026-10-06'}});assert.equal(invalid.isError,true);
  const reversed=await client.callTool({name:'line_search_messages',arguments:{...input,startTime:input.endTime}});assert.equal(reversed.isError,true);
});
test('only the local admin can save refresh settings, with strict bounds and state round-trip',async t=>{
  const {hub,base,adminBase}=await localGateway(t,true);
  const index=await fetch(adminBase),cookie=index.headers.getSetCookie()[0].split(';')[0];
  const headers={Cookie:cookie,Origin:adminBase,'X-Line-Bridge':'dashboard','Content-Type':'application/json'};
  const state=()=>fetch(`${adminBase}/admin/state`,{headers:{Cookie:cookie}}).then(r=>r.json());
  assert.equal((await state()).refresh.intervalSeconds,15);
  const path=`${adminBase}/admin/refresh-settings`;
  assert.equal((await fetch(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"intervalSeconds":120}'})).status,401);
  assert.equal((await fetch(path,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{"intervalSeconds":120}'})).status,403);
  for(const value of [2,3601,1.5,'60',null])assert.equal((await fetch(path,{method:'PUT',headers,body:JSON.stringify({intervalSeconds:value})})).status,400);
  const saved=await fetch(path,{method:'PUT',headers,body:'{"intervalSeconds":120}'});assert.equal(saved.status,200);assert.equal((await saved.json()).intervalSeconds,120);
  assert.equal((await state()).refresh.intervalSeconds,120);assert.equal(hub.store.setting('messageRefreshIntervalSeconds'),120);
  const a=await hub.addAccount({label:'Settings access',kind:'demo'}),token=hub.createToken({name:'reader',grants:[{accountId:a.id,read:true,send:false}]});
  assert.equal((await fetch(`${base}/admin/refresh-settings`,{method:'PUT',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},body:'{"intervalSeconds":3}'})).status,404);
});

test('same-VM HTTP and official MCP clients read/send without minting a token',async t=>{
  const {hub,store,base,adminBase}=await localGateway(t);
  assert.deepEqual(await (await fetch(`${base}/api/v1/accounts`)).json(),[]);
  const setup=await (await fetch(`${base}/api/v1/status`)).json();assert.equal(setup.authentication,'local');assert.equal(setup.setup.mcp,`${base}/mcp`);
  const a=await hub.addAccount({label:'Local sandbox',kind:'demo'});hub.designate(a.id,'demo-group',true);
  const endpoint=`${base}/api/v1/accounts/${a.id}/chats/demo-group/messages`;
  const sent=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'local-http-001'},body:JSON.stringify({text:'local synthetic message'})});assert.equal(sent.status,200);
  const client=new Client({name:'same-VM-agent',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));t.after(()=>client.close());
  assert.equal((await client.listTools()).tools.length,10);
  const read=await client.callTool({name:'line_read_messages',arguments:{accountId:a.id,chatId:'demo-group'}});assert.ok(JSON.parse(read.content[0].text).messages.some(m=>m.text==='local synthetic message'));
  const mcpSent=await client.callTool({name:'line_send_message',arguments:{accountId:a.id,chatId:'demo-group',text:'MCP synthetic message',idempotencyKey:'local-mcp-001'}});assert.equal(JSON.parse(mcpSent.content[0].text).delivery,'sandbox_only');
  const index=await fetch(adminBase),cookie=index.headers.getSetCookie()[0].split(';')[0];
  const update=await fetch(`${adminBase}/admin/accounts/${a.id}/local-access`,{method:'PUT',headers:{Cookie:cookie,Origin:adminBase,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body:JSON.stringify({read:true,send:false})});assert.equal(update.status,200);
  const denied=await client.callTool({name:'line_send_message',arguments:{accountId:a.id,chatId:'demo-group',text:'forbidden',idempotencyKey:'local-mcp-002'}});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).error,'scope_denied');
  assert.equal(hub.tokens().length,0);
  for(const headers of [{Authorization:'Bearer wrong'},{Authorization:'Basic anything'},{Forwarded:'for=203.0.113.9'},{'X-Forwarded-For':'203.0.113.9'},{'CF-Connecting-IP':'203.0.113.9'}])assert.equal((await fetch(`${base}/api/v1/accounts`,{headers})).status,401);
  for(const headers of [{Origin:'http://localhost'},{Referer:'https://attacker.example/'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Mode':'navigate'},{'Sec-Fetch-Dest':'document'}])assert.equal(await rawStatus(`${base}/api/v1/accounts`,headers),403);
  const token=hub.createToken({name:'Reader only',grants:[{accountId:a.id,read:true,send:false}]});
  assert.equal((await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json','Idempotency-Key':'token-local-001'},body:'{"text":"forbidden"}'})).status,403);
  store.revoke(token.id);assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{Authorization:`Bearer ${token.token}`}})).status,401);
  store.setSetting('aiEnabled',false);assert.equal((await fetch(`${base}/api/v1/accounts`)).status,503);store.setSetting('aiEnabled',true);
  for(const provider of ['cloudflare_quick','tailscale','cloudflare']){store.setSetting('tunnel',{provider,hostname:'',teamDomain:'',audience:''});assert.equal((await fetch(`${base}/api/v1/accounts`)).status,401,provider);}
  store.setSetting('tunnel',{provider:'local',hostname:'',teamDomain:'',audience:''});assert.equal((await fetch(`${base}/api/v1/accounts`)).status,200);
});

test('debug settings are admin-only and every enabled dashboard refresh includes its own status record',async t=>{
  const {hub,store,base,adminBase}=await localGateway(t,true);
  const page=await fetch(adminBase),cookie=page.headers.getSetCookie()[0].split(';')[0];
  const headers={Cookie:cookie,Origin:adminBase,'X-Line-Bridge':'dashboard','Content-Type':'application/json'};
  const state=()=>fetch(`${adminBase}/admin/state`,{headers:{Cookie:cookie}});
  const route=`${adminBase}/admin/debug-settings`,body='{"enabled":true}';
  assert.equal((await (await state()).json()).debugLogging.enabled,false);
  assert.equal(store.audits().filter(row=>row.action==='debug.refresh').length,0);
  assert.equal((await fetch(route,{method:'PUT',headers:{'Content-Type':'application/json'},body})).status,401);
  assert.equal((await fetch(route,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body})).status,403);
  assert.equal((await fetch(route,{method:'PUT',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
  for(const value of [{},{enabled:'true'},{enabled:true,extra:1}])assert.equal((await fetch(route,{method:'PUT',headers,body:JSON.stringify(value)})).status,400);
  assert.equal((await fetch(route,{method:'PUT',headers,body})).status,200);
  await hub.addAccount({label:'Debug sandbox',kind:'demo'});
  for(let i=1;i<=3;i++){
    const data=await (await state()).json();assert.equal(data.debugLogging.enabled,true);
    assert.equal(data.audit.filter(row=>row.action==='debug.refresh').length,i);
    assert.equal(data.audit[0].action,'debug.refresh');assert.equal(data.audit[0].details.accounts,1);assert.equal(data.audit[0].details.connected,1);
  }
  const accounts=hub.accounts;hub.accounts=()=>{throw new Error('private-debug-sentinel');};
  assert.equal((await state()).status,502);hub.accounts=accounts;
  const recovered=await (await state()).json();
  assert.ok(recovered.audit.some(row=>row.action==='debug.refresh'&&row.outcome==='failed'&&row.details.httpStatus===502));
  assert.ok(!JSON.stringify(recovered.audit).includes('private-debug-sentinel'));
  assert.equal((await fetch(route,{method:'PUT',headers,body:'{"enabled":false}'})).status,200);
  const count=store.audits().filter(row=>row.action==='debug.refresh').length;
  await state();await state();assert.equal(store.audits().filter(row=>row.action==='debug.refresh').length,count);
  const a=hub.store.accounts()[0],token=hub.createToken({name:'Reader',grants:[{accountId:a.id,read:true,send:false}]});
  assert.equal((await fetch(`${base}/admin/debug-settings`,{method:'PUT',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json'},body})).status,404);
});
test('strict token mode keeps localhost authenticated',async t=>{
  const {hub,base}=await localGateway(t,true),a=await hub.addAccount({label:'Strict sandbox',kind:'demo'});
  assert.equal((await fetch(`${base}/api/v1/accounts`)).status,401);
  const token=hub.createToken({name:'Strict reader',grants:[{accountId:a.id,read:true,send:false}]});
  const state=await (await fetch(`${base}/api/v1/status`,{headers:{Authorization:`Bearer ${token.token}`}})).json();assert.equal(state.authentication,'token');
});

test('dashboard combined setup enrolls privately; local profiles reject browsers/proxies and work with the data CLI',async t=>{
  const {LocalSetup}=await import('../server/local-setup.mjs'),{runCli}=await import('../client/cli.mjs');
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),hub=new Hub(store,vault),adminPort=await freePort(),gatewayPort=await freePort(),root=resolve('.'),tunnels=new Tunnels(store,vault,root,gatewayPort),items=new Map();
  const credentials={protection:'synthetic protected store',create:async(profile,url,value)=>{items.set(profile,{url,...value});},get:async profile=>{if(!items.has(profile))throw Object.assign(new Error('synthetic'),{code:'credentials_required'});return items.get(profile);},forget:async profile=>items.delete(profile)};
  const localSetup=new LocalSetup(hub,{credentials,gatewayPort}),apps=createApps({hub,tunnels,root,adminPort,gatewayPort,localSetup}),admin=apps.admin.listen(adminPort,'127.0.0.1'),gateway=apps.gateway.listen(gatewayPort,'127.0.0.1');
  t.after(()=>{hub.close();tunnels.close();for(const s of [admin,gateway]){s.closeAllConnections();s.close();}store.close();});
  const a=await hub.addAccount({label:'Synthetic enrollment',kind:'demo'}),local=`http://127.0.0.1:${adminPort}`,base=`http://127.0.0.1:${gatewayPort}`,route=`${local}/admin/accounts/${a.id}/local-setup`;
  const page=await fetch(local),cookie=page.headers.getSetCookie()[0].split(';')[0],headers={Cookie:cookie,Origin:local,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},body=JSON.stringify({chatIds:['demo-group'],read:true,send:true,confirmed:true});
  assert.equal((await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  assert.equal((await fetch(route,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body})).status,403);
  const {Origin,...missingOrigin}=headers;assert.equal((await fetch(route,{method:'POST',headers:missingOrigin,body})).status,403);
  assert.equal((await fetch(route,{method:'POST',headers:{...headers,'X-Forwarded-For':'203.0.113.9'},body})).status,403);
  assert.equal((await fetch(`${base}/admin/accounts/${a.id}/local-setup`,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
  assert.equal(store.tokens().length,0);
  const response=await fetch(route,{method:'POST',headers,body});assert.equal(response.status,200);const enrolled=await response.json(),stored=items.get(enrolled.profile);
  assert.equal(enrolled.ready,false);assert.equal(enrolled.health,'sandbox');assert.ok(!JSON.stringify(enrolled).includes(stored.token));
  const policy=JSON.stringify({autoMonitorNewChats:true});
  assert.equal((await fetch(route,{method:'PATCH',headers:{'Content-Type':'application/json'},body:policy})).status,401);
  assert.equal((await fetch(route,{method:'PATCH',headers:{...headers,Origin:'https://evil.example'},body:policy})).status,403);
  assert.equal((await fetch(route,{method:'PATCH',headers:missingOrigin,body:policy})).status,403);
  assert.equal((await fetch(route,{method:'PATCH',headers,body:'{"autoMonitorNewChats":"true"}'})).status,400);
  const changed=await fetch(route,{method:'PATCH',headers,body:policy});assert.equal(changed.status,200);
  const changedSetup=await changed.json();assert.equal(changedSetup.autoMonitorNewChats,true);assert.equal(changedSetup.profile,enrolled.profile);
  const policyState=await (await fetch(`${local}/admin/state`,{headers:{Cookie:cookie}})).json();
  assert.equal(policyState.accounts[0].localSetup.autoMonitorNewChats,true);assert.equal(policyState.chatCounts[a.id],hub.store.chats(a.id).length);
  assert.equal((await fetch(route,{method:'PATCH',headers,body:'{"autoMonitorNewChats":false}'})).status,200);
  let output='',stderr='';const code=await runCli(['accounts','--profile',enrolled.profile],{store:credentials,env:{},stdout:{write:s=>{output+=s;}},stderr:{write:s=>{stderr+=s;}}});assert.equal(code,0);assert.equal(stderr,'');assert.equal(JSON.parse(output)[0].permissions.send,true);
  const authorization={Authorization:`Bearer ${stored.token}`};
  for(const extra of [{Origin:local},{Referer:local},{'X-Forwarded-For':'203.0.113.9'},{Forwarded:'for=203.0.113.9'},{'CF-Connecting-IP':'203.0.113.9'}])assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:{...authorization,...extra}})).status,403);
  store.setSetting('tunnel',{provider:'cloudflare',hostname:'line.example.com',teamDomain:'example.cloudflareaccess.com',audience:'synthetic'});
  assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:authorization})).status,200,'Direct loopback managed profile remains available');
  assert.equal(await rawStatus(`${base}/api/v1/accounts`,{...authorization,Host:'line.example.com'}),403,'Managed profiles cannot authenticate remote tunnel traffic');
  const state=await (await fetch(`${local}/admin/state`,{headers:{Cookie:cookie}})).json();assert.ok(!JSON.stringify(state).includes(stored.token));
  await fetch(route,{method:'DELETE',headers});assert.equal(items.size,0);assert.equal((await fetch(`${base}/api/v1/accounts`,{headers:authorization})).status,401);
  assert.equal((await fetch(route,{method:'POST',headers,body:JSON.stringify({...JSON.parse(body),autoMonitorNewChats:'true'})})).status,400);
  const automatic=await (await fetch(route,{method:'POST',headers,body:JSON.stringify({...JSON.parse(body),autoMonitorNewChats:true})})).json();
  assert.equal(automatic.autoMonitorNewChats,true);
  hub.driver(a.id).rooms.push({id:'http-future-room',name:'Future room',kind:'openchat'});await hub.discover(a.id);
  const updatedState=await (await fetch(`${local}/admin/state`,{headers:{Cookie:cookie}})).json();
  assert.equal(updatedState.accounts[0].localSetup.autoMonitorNewChats,true);assert.ok(updatedState.accounts[0].localSetup.chatIds.includes('http-future-room'));
  const currentAuthorization={Authorization:`Bearer ${items.get(automatic.profile).token}`};
  const allowed=await (await fetch(`${base}/api/v1/accounts/${a.id}/chats`,{headers:currentAuthorization})).json();assert.ok(allowed.some(chat=>chat.id==='http-future-room'));
  await fetch(route,{method:'DELETE',headers});assert.equal(items.size,0);
  assert.equal((await fetch(route,{method:'PATCH',headers,body:policy})).status,409);
});

test('the status probe reports service identity without the protected store, tunnel checks or debug records',async t=>{
  const {LocalSetup}=await import('../server/local-setup.mjs');
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'synthetic'),hub=new Hub(store,vault),adminPort=await freePort(),items=new Map();let reads=0,tunnelChecks=0;
  const credentials={protection:'synthetic',create:async(profile,url,value)=>{items.set(profile,{url,...value});},get:async profile=>{reads++;return items.get(profile);},forget:async profile=>{items.delete(profile);}};
  const localSetup=new LocalSetup(hub,{credentials}),tunnels={config:()=>({provider:'local'}),status:async()=>{tunnelChecks++;return {provider:'local',connected:true};}};
  const apps=createApps({hub,tunnels,root:resolve('.'),adminPort,instance:'synthetic-instance',localSetup}),admin=apps.admin.listen(adminPort,'127.0.0.1');
  t.after(()=>{hub.close();admin.closeAllConnections();admin.close();store.close();});
  const a=await hub.addAccount({label:'Status sandbox',kind:'demo'});await localSetup.enable(a.id,{chatIds:['demo-group'],read:true,send:true,confirmed:true});
  const base=`http://127.0.0.1:${adminPort}`;
  assert.equal((await fetch(`${base}/admin/status`)).status,401);
  const cookie=(await fetch(base)).headers.getSetCookie()[0].split(';')[0];hub.debug.configure({enabled:true});reads=0;const audits=store.audits(3000).length;
  const status=await (await fetch(`${base}/admin/status`,{headers:{Cookie:cookie}})).json();
  assert.deepEqual(status,{version:VERSION,backend:'node',instance:'synthetic-instance',authentication:'token',gatewayEnabled:true,accounts:1});
  assert.equal(reads,0);assert.equal(tunnelChecks,0);assert.equal(store.audits(3000).length,audits);
  // The full dashboard state still verifies the profile and records its refresh.
  await (await fetch(`${base}/admin/state`,{headers:{Cookie:cookie}})).json();
  assert.ok(reads>0);assert.equal(tunnelChecks,1);assert.equal(store.audits(3000).length,audits+1);
});
