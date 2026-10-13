import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createServer} from 'node:net';
import {Store} from '../server/store.mjs';
import {Vault} from '../server/vault.mjs';
import {Hub,localActor} from '../server/hub.mjs';
import {LineDriver,normalizeMessage} from '../server/drivers.mjs';
import {audioResult,basicSticker,imageResult,MEDIA_MAX_BYTES} from '../server/media.mjs';
import {runCli} from '../client/cli.mjs';
import {createApps} from '../server/app.mjs';
import {Tunnels} from '../server/tunnels.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=','base64');
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;};
const box=(type,...parts)=>{const body=Buffer.concat(parts);return Buffer.concat([u32(8+body.length),Buffer.from(type,'latin1'),body]);};
const mvhd=({version=0,scale=1000,duration=3000}={})=>version
  ?box('mvhd',Buffer.from([1,0,0,0]),Buffer.alloc(16),u32(scale),u64(duration),Buffer.alloc(80))
  :box('mvhd',Buffer.from([0,0,0,0]),Buffer.alloc(8),u32(scale),u32(duration),Buffer.alloc(80));
// Synthetic MP4-family container: structure only, no real AAC frames.
const m4a=({brand='M4A ',moov=true,mdat=true,...header}={})=>Buffer.concat([
  box('ftyp',Buffer.from(brand,'latin1'),u32(0),Buffer.from('isomM4A ','latin1')),...(moov?[box('moov',mvhd(header))]:[]),...(mdat?[box('mdat',Buffer.from('synthetic-aac-frames'))]:[])
]);

test('audio boundary accepts bounded M4A/3GP containers and reports only declared duration',()=>{
  const result=audioResult(m4a());
  assert.equal(result.mimeType,'audio/mp4');assert.equal(result.durationMs,3000);assert.equal(result.bytes,m4a().length);
  assert.equal(result.data,m4a().toString('base64'));assert.equal(result.untrustedContent,true);assert.match(result.sha256,/^[0-9a-f]{64}$/);
  assert.equal(audioResult(m4a({brand:'3gp4'})).mimeType,'audio/3gpp');
  assert.equal(audioResult(m4a({version:1,scale:48000,duration:90000})).durationMs,1875);
  assert.equal(audioResult(m4a({duration:0xffffffff})).durationMs,undefined);
  assert.equal(audioResult(m4a({scale:0})).durationMs,undefined);
  // A 64-bit box size is valid when it stays inside the payload.
  const large=Buffer.concat([u32(1),Buffer.from('mdat','latin1'),u64(16+4),Buffer.from('aac!')]);
  assert.equal(audioResult(Buffer.concat([m4a({mdat:false}),large])).mimeType,'audio/mp4');
});
test('audio boundary rejects other formats, malformed boxes and oversized media',()=>{
  const truncated=m4a().subarray(0,-1),overflow=Buffer.from(m4a());overflow.writeUInt32BE(1e6,0);
  const binaryType=Buffer.from(m4a());binaryType[m4a().indexOf('moov')]=0;
  for(const bytes of [png,Buffer.from('<svg onload="evil"/>'),m4a({moov:false}),m4a({mdat:false}),truncated,overflow,binaryType,Buffer.concat([box('moov',mvhd()),m4a()])])
    assert.throws(()=>audioResult(bytes),{code:'media_unsupported'});
  assert.throws(()=>audioResult(Buffer.alloc(0)),{code:'media_too_large'});
  assert.throws(()=>audioResult(Buffer.alloc(MEDIA_MAX_BYTES+1)),{code:'media_too_large'});
});
test('voice messages get an allowlisted audio descriptor without URLs, keys or metadata',()=>{
  const message=normalizeMessage({id:'1',contentType:'AUDIO',contentMetadata:{AUDLEN:'3000',OID:'secret-oid',url:'https://evil.test'},chunks:['secret-chunk']});
  assert.deepEqual(message.media,{kind:'audio',encrypted:true});assert.ok(!JSON.stringify(message).includes('secret'));assert.ok(!JSON.stringify(message).includes('evil'));
  assert.deepEqual(normalizeMessage({id:'2',contentType:3}).media,{kind:'audio',encrypted:false});
});

test('LINE placeholder sticker text and STKOPT 0 are ordinary markers, not custom stickers (#21)',()=>{
  // Exactly the reported shape: options "0" and customText "[スタンプ]".
  const reported=normalizeMessage({id:'1',contentType:'STICKER',contentMetadata:{STKID:'52002734',STKPKGID:'11537',STKVER:'1',STKOPT:'0',STKTXT:'[スタンプ]'}}).media;
  assert.deepEqual(reported,{kind:'sticker',stickerId:'52002734',packageId:'11537',version:'1',options:'0',customText:'[スタンプ]'});assert.equal(basicSticker(reported),true);
  for(const customText of [undefined,'','[Sticker]','[貼圖]','[스티커]','[Stiker]'])assert.equal(basicSticker({stickerId:'1',customText,options:'0'}),true,String(customText));
  for(const customText of ['Custom','[Sticker] hello','hello [Sticker]','[[Sticker]]','[a]\n[b]','[]',`[${'x'.repeat(41)}]`])assert.equal(basicSticker({stickerId:'1',customText}),false,customText);
  for(const options of ['A','S','P','AS','1','00'])assert.equal(basicSticker({stickerId:'1',options}),false,options);
  assert.equal(basicSticker({stickerId:'1',unsupported:true}),false);assert.equal(basicSticker({stickerId:'../1'}),false);assert.equal(basicSticker({}),false);
});
test('a reported placeholder sticker renders its static CDN preview; custom stickers still fail before any request',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;driver.stop();});let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://stickershop.line-scdn.net/stickershop/v1/sticker/52002734/android/sticker.png');assert.equal(options.redirect,'error');return new Response(png);};
  const result=await driver.media({kind:'group'},{id:'1',media:{kind:'sticker',stickerId:'52002734',packageId:'11537',options:'0',customText:'[スタンプ]'}});
  assert.equal(result.preview,true);assert.equal(result.mimeType,'image/png');assert.equal(calls,1);
  for(const media of [{customText:'Custom'},{options:'A'},{customText:'[Sticker] custom'}])
    await assert.rejects(driver.media({kind:'group'},{id:'1',media:{kind:'sticker',stickerId:'52002734',...media}}),{code:'sticker_unsupported'});
  assert.equal(calls,1);
});

test('OpenChat and personal voice messages use the bounded SDK OBS paths and validate audio (#22)',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});driver.client.authToken='synthetic-only';
  const original=globalThis.fetch;const urls=[];let body=m4a();t.after(()=>{globalThis.fetch=original;driver.stop();});
  globalThis.fetch=async request=>{const req=new Request(request);urls.push(req.url);assert.equal(req.redirect,'error');return req.url.endsWith('object_info.obs')?new Response('{"name":"../../unsafe.m4a"}'):new Response(body);};
  const square=await driver.media({id:'m-synthetic',kind:'openchat'},{id:'123',media:{kind:'audio'}});
  assert.equal(square.mimeType,'audio/mp4');assert.equal(square.durationMs,3000);assert.ok(urls[0].includes('/r/g2/m/123'));
  body=png;await assert.rejects(driver.media({id:'m-synthetic',kind:'openchat'},{id:'123',media:{kind:'audio'}}),{code:'media_unsupported'});
  // Personal plain voice message: upstream type re-checked, then the Talk message object.
  const raw={id:'456',to:'u-synthetic',from:'u-other',contentType:'AUDIO',contentMetadata:{}};
  driver.client.thrift.rename_thrift=(_,item)=>item;driver.client.request.request=async()=>[raw];body=m4a();urls.length=0;
  assert.equal((await driver.media({id:'u-synthetic',kind:'direct'},{id:'456',media:{kind:'audio'}})).mimeType,'audio/mp4');assert.ok(urls[0].includes('/r/talk/m/456'));
  // An archived audio descriptor never downloads an upstream image, and vice versa.
  raw.contentType='IMAGE';urls.length=0;
  await assert.rejects(driver.media({id:'u-synthetic',kind:'direct'},{id:'456',media:{kind:'audio'}}),{code:'media_unsupported'});
  raw.contentType='AUDIO';await assert.rejects(driver.media({id:'u-synthetic',kind:'direct'},{id:'456',media:{kind:'image'}}),{code:'media_unsupported'});
  assert.equal(urls.length,0);
});
test('personal E2EE voice message authenticates and decrypts with SDK key material only',async t=>{
  const driver=new LineDriver({device:'IOSIPAD'},{},{qr(){},pin(){},fault(){}});driver.client.authToken='synthetic';
  const raw={id:'789',to:'u-synthetic',from:'u-other',contentType:'AUDIO',chunks:['synthetic-envelope'],contentMetadata:{OID:'object-789',SID:'ema'}};
  driver.client.thrift.rename_thrift=(_,item)=>item;driver.client.request.request=async()=>[raw];driver.client.request.getHeader=()=>({'x-line-access':'synthetic'});
  const {keyMaterial,encryptedData}=await driver.client.e2ee.encryptByKeyMaterial(m4a(),Buffer.alloc(32,5));
  driver.client.e2ee.decryptE2EEDataMessage=async()=>({keyMaterial,fileName:'../../unsafe.m4a'});
  driver.client.e2ee.decryptByKeyMaterial=()=>assert.fail('Unauthenticated SDK decrypt helper must not be used');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;driver.stop();});
  globalThis.fetch=async request=>{const req=new Request(request);assert.equal(req.url,'https://obs.line-apps.com/r/talk/ema/object-789');return new Response(encryptedData);};
  const result=await driver.media({id:'u-synthetic',kind:'direct'},{id:'789',media:{kind:'audio',encrypted:true}});
  assert.equal(result.data,m4a().toString('base64'));assert.equal(result.mimeType,'audio/mp4');
  const corrupted=Buffer.from(encryptedData);corrupted[0]^=1;globalThis.fetch=async()=>new Response(corrupted);
  await assert.rejects(driver.media({id:'u-synthetic',kind:'direct'},{id:'789',media:{kind:'audio'}}),{code:'media_integrity_failed'});
});

async function fixture(t){
  const store=new Store(':memory:'),vault=new Vault(randomBytes(32),'test'),hub=new Hub(store,vault);
  t.after(()=>{hub.close();store.close();});
  const account=await hub.addAccount({label:'Synthetic',kind:'demo'});hub.designate(account.id,'demo-group',true);
  store.setSetting(`monitor:${account.id}`,true);
  hub.capture(account.id,'demo-group',normalizeMessage({id:'audio-1',from:'synthetic',contentType:'AUDIO',chunks:['key']}));
  hub.capture(account.id,'demo-group',normalizeMessage({id:'image-1',from:'synthetic',contentType:'IMAGE'}));
  // Captured by v0.7.14, before audio descriptors existed.
  hub.capture(account.id,'demo-group',{id:'legacy-audio',senderId:'synthetic',text:'',contentType:'AUDIO'});
  hub.capture(account.id,'demo-group',{id:'legacy-image',senderId:'synthetic',text:'',contentType:'IMAGE'});
  const driver=hub.driver(account.id),seen=[];
  driver.media=async(_chat,message)=>{seen.push(message.media);return message.media.kind==='audio'?audioResult(m4a()):imageResult(png);};
  return {hub,store,account,driver,seen};
}
test('hub returns audio by archived kind, recovers pre-upgrade voice records and validates the worker boundary',async t=>{
  const {hub,account,driver,seen}=await fixture(t);
  const audio=await hub.media(localActor,account.id,'demo-group','audio-1');
  assert.equal(audio.kind,'audio');assert.equal(audio.mimeType,'audio/mp4');assert.equal(audio.durationMs,3000);assert.equal(audio.data,m4a().toString('base64'));assert.equal(audio.untrustedContent,true);
  assert.equal((await hub.media(localActor,account.id,'demo-group','image-1')).kind,'image');
  // The reported voice message was archived without a descriptor; its type alone suffices.
  assert.equal((await hub.media(localActor,account.id,'demo-group','legacy-audio')).kind,'audio');assert.deepEqual(seen.at(-1),{kind:'audio'});
  await assert.rejects(hub.media(localActor,account.id,'demo-group','legacy-image'),{code:'media_metadata_missing'});
  const calls=seen.length;
  await assert.rejects(hub.media(localActor,account.id,'demo-group','audio-1',{kinds:['image','sticker']}),{code:'media_kind_mismatch'});
  await assert.rejects(hub.media(localActor,account.id,'demo-group','image-1',{kinds:['audio']}),{code:'media_kind_mismatch'});
  assert.equal(seen.length,calls);
  driver.media=async()=>imageResult(png);await assert.rejects(hub.media(localActor,account.id,'demo-group','audio-1'),{code:'media_unsupported'});
  hub.setLocalAccess(account.id,{read:false,send:true});await assert.rejects(hub.media(localActor,account.id,'demo-group','audio-1'),{code:'scope_denied'});
});
test('gateway MCP returns voice messages as audio content and keeps image/audio tools separate',async t=>{
  const {hub,store,account}=await fixture(t);
  const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const tunnels=new Tunnels(store,hub.vault,process.cwd(),port);t.after(()=>tunnels.close());
  const {gateway}=createApps({hub,tunnels,root:process.cwd(),adminPort:0,gatewayPort:port});const server=gateway.listen(port,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,token=hub.createToken({name:'Synthetic',grants:[{accountId:account.id,read:true,send:false}]}),headers={Authorization:`Bearer ${token.token}`};
  const http=await (await fetch(`${base}/api/v1/accounts/${account.id}/chats/demo-group/messages/audio-1/media`,{headers})).json();assert.equal(http.kind,'audio');assert.equal(http.mimeType,'audio/mp4');
  const client=new Client({name:'audio-test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers}}));t.after(()=>client.close());
  const audio=await client.callTool({name:'line_read_audio',arguments:{accountId:account.id,chatId:'demo-group',messageId:'audio-1'}});
  assert.equal(audio.isError,undefined);assert.equal(audio.content[1].type,'audio');assert.equal(audio.content[1].mimeType,'audio/mp4');assert.equal(audio.content[1].data,m4a().toString('base64'));
  assert.ok(!audio.content[0].text.includes(m4a().toString('base64')));assert.equal(JSON.parse(audio.content[0].text).durationMs,3000);
  const wrong=await client.callTool({name:'line_read_image',arguments:{accountId:account.id,chatId:'demo-group',messageId:'audio-1'}});
  assert.equal(wrong.isError,true);assert.equal(JSON.parse(wrong.content[0].text).error,'media_kind_mismatch');
  const image=await client.callTool({name:'line_read_audio',arguments:{accountId:account.id,chatId:'demo-group',messageId:'image-1'}});assert.equal(JSON.parse(image.content[0].text).error,'media_kind_mismatch');
});

async function cli(args,fetchImpl){let stdout='';const code=await runCli(args,{env:{LINE_BRIDGE_TOKEN:'synthetic'},stdin:Readable.from([]),stdout:{write:v=>stdout+=v},stderr:{write(){}},fetchImpl});return {code,...JSON.parse(stdout)};}
test('CLI writes a validated voice message to an exclusive file without transcribing it',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'linebridge-audio-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'voice.m4a'),args=['media','--account','a','--chat','c','--message','123','--output',file];
  const result=await cli(args,async()=>new Response(JSON.stringify({kind:'audio',...audioResult(m4a())})));
  assert.equal(result.code,0);assert.equal(result.kind,'audio');assert.equal(result.transcribed,false);assert.equal(result.durationMs,3000);assert.equal(result.data,undefined);
  assert.deepEqual(await readFile(file),m4a());
  const invalid=await cli(['media','--account','a','--chat','c','--message','123','--output',join(dir,'bad.m4a')],async()=>new Response(JSON.stringify({kind:'audio',...imageResult(png)})));
  assert.equal(invalid.error,'invalid_media');
  const image=await cli(['media','--account','a','--chat','c','--message','123','--output',join(dir,'image.png')],async()=>new Response(JSON.stringify({kind:'image',...imageResult(png)})));
  assert.equal(image.code,0);assert.equal(image.kind,'image');assert.equal(image.visionInvoked,false);
});
