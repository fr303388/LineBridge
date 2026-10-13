import assert from 'node:assert/strict';
import {seedSyntheticMonitor} from './synthetic-monitor-fixture.mjs';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const root=process.cwd(),data=mkdtempSync(join(tmpdir(),'linebridge-test-'));
const admin='http://127.0.0.1:4510',gateway='http://127.0.0.1:4511';
const service=spawn(process.execPath,[join(root,'bin/linebridge.mjs'),'serve'],{cwd:root,env:{...process.env,LINE_BRIDGE_TRUST_LOCAL: "1",LINE_BRIDGE_DATA:data,LINE_BRIDGE_ADMIN_PORT:'4510',LINE_BRIDGE_GATEWAY_PORT:'4511'},stdio:'ignore',windowsHide:true});
let client;
try{
  for(let i=0;i<100;i++){try{if((await fetch(`${gateway}/health`)).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const page=await fetch(admin),cookie=page.headers.get('set-cookie').split(';')[0];assert.equal(page.status,200);assert.match(await page.text(),/LineBridge/);
  const call=async(path,method='GET',value)=>{const response=await fetch(`${admin}/admin${path}`,{method,headers:{Cookie:cookie,Origin:admin,'X-Line-Bridge':'dashboard','Content-Type':'application/json'},...(value?{body:JSON.stringify(value)}:{})});const data=await response.json();assert.equal(response.ok,true,JSON.stringify(data));return data;};
  const account=await call('/accounts','POST',{label:'migration test',kind:'demo'}),id=account.id;
  seedSyntheticMonitor(data,id);await call(`/accounts/${id}/monitor`,'POST',{enabled:true});
  client=new Client({name:'LineBridge integration check',version:'1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`)));
  assert.equal((await call('/state')).tokens.length,0);
  const tools=await client.listTools();assert.equal(tools.tools.length,10);
  const result=await client.callTool({name:'line_list_chats',arguments:{accountId:id}});assert.ok(!result.isError);const chats=JSON.parse(result.content[0].text);assert.equal(chats.length,1);assert.equal(chats[0].id,'demo-group');
  const sent=await client.callTool({name:'line_send_message',arguments:{accountId:id,chatId:'demo-group',text:'synthetic-integration-message',idempotencyKey:'integration-0001'}});assert.ok(!sent.isError);
  const events=await client.callTool({name:'line_poll_events',arguments:{accountId:id,after:0}});assert.ok(!events.isError);const inbox=JSON.parse(events.content[0].text);assert.equal(inbox.events.length,1);assert.equal(inbox.events[0].message.text,'synthetic-integration-message');
  const archived=await client.callTool({name:'line_search_messages',arguments:{query:'synthetic-integration-message',mode:'phrase'}});assert.ok(!archived.isError);assert.equal(JSON.parse(archived.content[0].text).results[0].message.text,'synthetic-integration-message');
  const denied=await client.callTool({name:'line_read_messages',arguments:{accountId:id,chatId:'demo-openchat'}});assert.equal(denied.isError,true);assert.equal(JSON.parse(denied.content[0].text).error,'chat_not_designated');
  const duplicate=await client.callTool({name:'line_send_message',arguments:{accountId:id,chatId:'demo-group',text:'synthetic-integration-message',idempotencyKey:'integration-0001'}});assert.equal(JSON.parse(duplicate.content[0].text).replayed,true);
  await call(`/accounts/${id}/local-access`,'PUT',{read:true,send:false});
  const forbidden=await client.callTool({name:'line_send_message',arguments:{accountId:id,chatId:'demo-group',text:'forbidden',idempotencyKey:'integration-0002'}});assert.equal(forbidden.isError,true);
  await client.close();
  const token=await call('/tokens','POST',{name:'remote reader',days:1,grants:[{accountId:id,read:true,send:false}]});
  client=new Client({name:'LineBridge token integration check',version:'1.0'});await client.connect(new StreamableHTTPClientTransport(new URL(`${gateway}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token.token}`}}}));
  await call(`/tokens/${token.id}`,'DELETE');let revoked=false;try{await client.callTool({name:'line_list_accounts',arguments:{}});}catch{revoked=true;}assert.equal(revoked,true);
  assert.equal(readFileSync(join(data,'bridge.sqlite-wal')).includes(Buffer.from('synthetic-integration-message')),false);
  console.log('Node HTTP + official MCP client: token-free local setup, live permissions, encrypted inbox, send replay and token revocation passed. All sends were synthetic.');
}finally{
  await client?.close().catch(()=>{});service.kill();if(service.exitCode===null)await once(service,'exit');
  const target=resolve(data),parent=resolve(tmpdir())+sep;if(!target.startsWith(parent)||!target.slice(parent.length).startsWith('linebridge-test-'))throw new Error('Refusing unsafe test cleanup');rmSync(target,{recursive:true,force:true});
}
