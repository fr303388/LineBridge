import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,readdir,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {shutdownDesktop,maintenance,tryLease,writeRecord,lifecycleLease} from '../server/maintenance.mjs';
import {removeClientFixture} from './client-test-utils.mjs';
import {Vault} from '../server/vault.mjs';
import {Store} from '../server/store.mjs';
const exec=promisify(execFile),cli=resolve('bin/linebridge.mjs'),tray=resolve('server/tray.mjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function ports({holdReservedPort=false}={}){
  for(let attempt=0;attempt<30;attempt++){
    const servers=[];let blocker;
    try{
      const bind=async port=>{const s=createServer();servers.push(s);await new Promise((ok,fail)=>{s.once('error',fail);s.listen(port,'127.0.0.1',ok);});return s;};
      const admin=(await bind(0)).address().port,gateway=(await bind(0)).address().port;if(gateway>=65535)continue;
      const reserved=await bind(gateway+1);if(holdReservedPort)blocker=reserved;return {admin,gateway,blocker};
    }catch(error){if(error.code!=='EADDRINUSE')throw error;}
    finally{await Promise.all(servers.filter(s=>s.listening&&s!==blocker).map(s=>new Promise(r=>s.close(r))));}
  }
  throw new Error('No free maintenance test ports');
}
async function fixture(t,{holdReservedPort=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'linebridge-maintenance-')),data=await realpath(directory),children=[];
  // Metadata uses the service's canonical path, including Windows short TEMP paths.
  // Explicit synthetic host model for Linux: exercise JS lifecycle/IPC and
  // real locks/sockets, never claim to test native Windows/macOS code here.
  const preload=join(data,'synthetic-host.mjs');
  await writeFile(preload,"if(process.platform==='linux')Object.defineProperty(process,'platform',{value:'darwin'});");
  const env={...process.env,NODE_OPTIONS:`--import=${pathToFileURL(preload).href}`,LINE_BRIDGE_DATA:data};
  const p=await ports({holdReservedPort});
  function start(file,args=[]){
    const child=spawn(process.execPath,[file,...args],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});children.push(child);
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const closed=new Promise(r=>child.on('close',r));
    return {child,closed,get output(){return output;},async until(pattern){for(let i=0;i<200;i++){if(pattern.test(output))return;if(child.exitCode!==null)throw new Error(output);await pause(30);}throw new Error('Synthetic child not ready: '+output);}};
  }
  async function run(command,...args){return exec(process.execPath,[cli,command,'--data-dir',data,...args],{env,timeout:15000,windowsHide:true});}
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.stdin.end();child.kill();}
    if(p.blocker?.listening)await new Promise(r=>p.blocker.close(r));
    // Only the service whose instance metadata lives in this disposable fixture.
    try{const m=JSON.parse(await readFile(join(data,'service.json'),'utf8'));if(m.dataDir===data&&m.pid!==process.pid)process.kill(m.pid);}catch{}
    await pause(80);await removeClientFixture(directory);
  });
  return {data,p,env,start,run,serve:(...flags)=>start(cli,['serve','--data-dir',data,'--admin-port',String(p.admin),'--gateway-port',String(p.gateway),'--trust-local',...flags])};
}
test('maintenance closes the modeled desktop, tray and owned service, waits for exit, and supports repeated shutdown and explicit update resume',async t=>{
  const f=await fixture(t),vault=await Vault.open(f.data),store=new Store(join(f.data,'bridge.sqlite'));
  store.setSetting('tunnel',{provider:'local'});const a=store.addAccount('synthetic','demo','IOSIPAD');store.putSecret(a.id,'synthetic',vault.seal('preserved',`${a.id}:synthetic`));store.reserve('synthetic','ledger-key','fingerprint');store.finishSend('synthetic','ledger-key','sent',{messageId:'synthetic-sent'});store.close();
  const protectedFile=join(f.data,'protected-profile-sentinel');await writeFile(protectedFile,'synthetic protected credential');
  const native=join(f.data,'synthetic-desktop.mjs');
  await writeFile(native,`import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,${JSON.stringify([tray,'--data-dir',f.data,'--admin-port',String(f.p.admin),'--gateway-port',String(f.p.gateway)])}.concat(['--desktop-pid',String(process.pid)]),{stdio:['pipe','pipe','inherit']});
    child.stdout.on('data',bytes=>process.stdout.write(bytes));
    child.on('exit',code=>setTimeout(()=>process.exit(code??1),250));
    process.on('SIGTERM',()=>child.stdin.end());`);
  // Track and reap this fixture service directly. The Linux container's PID 1
  // can leave a detached service as a zombie after its tray parent exits.
  const owned=f.start(cli,['serve','--data-dir',f.data,'--admin-port',String(f.p.admin),'--gateway-port',String(f.p.gateway),'--require-token']);await owned.until(/Dashboard:/);
  const desktop=f.start(native);await desktop.until(/ready\t/);
  const before=JSON.parse((await f.run('status')).stdout);assert.equal(before.status,'running');assert.equal(before.adminPort,f.p.admin);
  const trayInfo=JSON.parse(await readFile(join(f.data,'tray.json'),'utf8'));assert.equal(trayInfo.desktopPid,desktop.child.pid);
  const result=JSON.parse((await f.run('shutdown','--instance',before.instance)).stdout);
  assert.equal(result.status,'stopped');assert.equal(result.maintenance,true);assert.equal(await desktop.closed,0);assert.equal(await owned.closed,0);assert.match(desktop.output,/quit\t/);
  assert.equal((await maintenance(f.data)).service.instance,before.instance);
  assert.deepEqual(JSON.parse((await f.run('shutdown','--instance',before.instance)).stdout),result);
  const blocked=f.serve();assert.equal(await blocked.closed,1);assert.match(blocked.output,/maintenance_active/);
  const trayBlocked=f.start(tray,['--data-dir',f.data]);assert.equal(await trayBlocked.closed,1);assert.doesNotMatch(trayBlocked.output,/ready\t/);
  const resumed=f.serve('--resume');await resumed.until(/Dashboard:/);assert.equal(await maintenance(f.data),null);
  const after=JSON.parse((await f.run('status')).stdout);assert.notEqual(after.instance,before.instance);
  await f.run('shutdown');assert.equal(await resumed.closed,0);
  assert.equal(await readFile(protectedFile,'utf8'),'synthetic protected credential');
  const saved=new Store(join(f.data,'bridge.sqlite'));try{assert.equal(saved.send('synthetic','ledger-key').state,'sent');assert.equal(saved.send('synthetic','ledger-key').fingerprint,'fingerprint');assert.ok(saved.secret(a.id,'synthetic'));}finally{saved.close();}
});
test('wrong instance or data directory never writes a maintenance marker or stops another service',async t=>{
  const f=await fixture(t),service=f.serve();await service.until(/Dashboard:/);
  await assert.rejects(f.run('shutdown','--instance','wrong'),e=>/instance_mismatch/.test(e.stderr));assert.equal(await maintenance(f.data),null);
  const info=JSON.parse(await readFile(join(f.data,'service.json'),'utf8'));
  await writeRecord(f.data,'service.json',{...info,dataDir:join(f.data,'wrong')});
  await assert.rejects(shutdownDesktop({dataDir:f.data}),{code:'instance_mismatch'});assert.equal(await maintenance(f.data),null);
  await writeRecord(f.data,'service.json',info);assert.equal((await fetch(`http://127.0.0.1:${f.p.gateway}/health`)).ok,true);
  await f.run('shutdown');assert.equal(await service.closed,0);
});
test('bounded timeout retains maintenance and refuses resume while an owned tray is still draining',async t=>{
  const f=await fixture(t),lock=tryLease(f.data,'tray');
  const owner=f.start('-e',['setInterval(()=>{},1000)']);
  await writeRecord(f.data,'tray.json',{runtime:'tray',instance:'synthetic-stuck',pid:owner.child.pid,desktopPid:null,dataDir:f.data});
  const start=Date.now();await assert.rejects(shutdownDesktop({dataDir:f.data,timeoutMs:1000}),{code:'shutdown_timeout'});assert.ok(Date.now()-start<2500);assert.ok(await maintenance(f.data));
  const blocked=f.serve('--resume');assert.equal(await blocked.closed,1);assert.match(blocked.output,/maintenance_busy/);
  lock.close();owner.child.kill();await owner.closed;await rm(join(f.data,'tray.json'));
  assert.equal((await shutdownDesktop({dataDir:f.data})).status,'stopped');
  const resumed=f.serve('--resume');await resumed.until(/Dashboard:/);await f.run('shutdown');assert.equal(await resumed.closed,0);
});
test('CLI timeout keeps the production worker pipe and data lock until a synthetic in-flight RPC drains',async t=>{
  const f=await fixture(t),unlock=join(f.data,'release-worker'),entered=join(f.data,'worker-entered'),source=join(f.data,'synthetic-service.mjs');
  // Only the child adapter is synthetic. The actual protocol loop, parent
  // start/event handlers, service, CLI and SQLite locks all run unchanged.
  const workerSource=`import {LineDriver} from ${JSON.stringify(pathToFileURL(resolve('server/drivers.mjs')).href)};
    import {access,writeFile} from 'node:fs/promises';
    LineDriver.prototype.login=async function(){this.ready=true;return {mid:'synthetic'};};
    LineDriver.prototype.read=async()=>{
      await writeFile(${JSON.stringify(entered)},'synthetic');
      const deadline=Date.now()+15000;
      for(;;){try{await access(${JSON.stringify(unlock)});return {ok:true};}catch{}if(Date.now()>=deadline)throw new Error('synthetic deadline');await new Promise(r=>setTimeout(r,20));}
    };
    await import(${JSON.stringify(pathToFileURL(resolve('protocol/worker.mjs')).href)});`;
  await writeFile(source,`import childProcess from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    import {access} from 'node:fs/promises';
    const spawn=childProcess.spawn;
    childProcess.spawn=(file,args,options)=>{
      if(args[0]!==${JSON.stringify(resolve('protocol/worker.mjs'))})return spawn(file,args,options);
      const child=spawn(file,['--input-type=module','-e',${JSON.stringify(workerSource)}],options);
      console.log('synthetic-worker-pid:'+child.pid);return child;
    };syncBuiltinESMExports();
    const {startService}=await import(${JSON.stringify(pathToFileURL(resolve('server/main.mjs')).href)});
    const service=await startService({dataDir:${JSON.stringify(f.data)},adminPort:${f.p.admin},gatewayPort:${f.p.gateway},requireToken:false,defaultProvider:'local'});
    await service.hub.worker.call('connect',{accountId:'synthetic',account:{device:'IOSIPAD'},storage:{}});
    void service.hub.worker.call('read',{accountId:'synthetic'},20000).then(()=>console.log('synthetic-result'),()=>console.log('synthetic-failed'));
    for(;;){try{await access(${JSON.stringify(entered)});break;}catch{}await new Promise(r=>setTimeout(r,20));}
    console.log('synthetic-ready');`);
  const service=f.start(source);
  try{
    await service.until(/synthetic-ready/);
    const started=Date.now();await assert.rejects(f.run('shutdown','--timeout-ms','1000'),e=>/shutdown_timeout/.test(e.stderr));assert.ok(Date.now()-started<3500);
    assert.equal(service.child.exitCode,null);assert.equal(tryLease(f.data,'service'),null);assert.equal((await maintenance(f.data)).serviceDrained,false);
    const workerPid=Number(service.output.match(/synthetic-worker-pid:(\d+)/)[1]);assert.doesNotThrow(()=>process.kill(workerPid,0));
    const blocked=f.serve('--resume');assert.equal(await blocked.closed,1);assert.match(blocked.output,/maintenance_busy/);
    await writeFile(unlock,'synthetic release');
    assert.equal(JSON.parse((await f.run('shutdown')).stdout).status,'stopped');assert.equal(await service.closed,0);
    assert.match(service.output,/synthetic-result/);assert.doesNotMatch(service.output,/synthetic-failed/);assert.equal((await maintenance(f.data)).serviceDrained,true);
    assert.throws(()=>process.kill(workerPid,0),{code:'ESRCH'});
  }finally{await writeFile(unlock,'synthetic cleanup');await Promise.race([service.closed,pause(2000)]);}
});
test('shutdown serializes with startup and a marker survives a failed resume bind',async t=>{
  const f=await fixture(t);tryLease(f.data,'service').close();
  const gate=await lifecycleLease(f.data);let completed=false;
  const stopping=shutdownDesktop({dataDir:f.data}).then(value=>{completed=true;return value;});
  await pause(100);assert.equal(completed,false);assert.equal(await maintenance(f.data),null);gate.close();await stopping;
  const blocker=createServer();await new Promise(r=>blocker.listen(f.p.admin,'127.0.0.1',r));
  try{const failed=f.serve('--resume');assert.equal(await failed.closed,1);assert.match(failed.output,/already in use/);assert.ok(await maintenance(f.data));}
  finally{await new Promise(r=>blocker.close(r));}
  const starts=[f.serve('--resume'),f.serve()];
  await Promise.race(starts.map(s=>s.until(/Dashboard:/).catch(()=>{})));
  for(let i=0;i<100&&!starts.some(s=>/Dashboard:/.test(s.output));i++)await pause(30);
  assert.equal(starts.filter(s=>/Dashboard:/.test(s.output)).length,1);
  await f.run('shutdown');await Promise.all(starts.map(s=>s.closed));
});
test('missing data and held unidentified service locks fail closed, without enrollment or a marker',async t=>{
  const f=await fixture(t),before=await readdir(f.data);
  await assert.rejects(shutdownDesktop({dataDir:f.data}),{code:'unknown_data_directory'});assert.deepEqual(await readdir(f.data),before);
  const lock=tryLease(f.data,'service');
  try{await assert.rejects(shutdownDesktop({dataDir:f.data}),{code:'instance_unavailable'});assert.equal(await maintenance(f.data),null);}finally{lock.close();}
});

test('concurrent shutdowns share maintenance and wait for a busy reserved port without touching its owner',async t=>{
  // Hold the original reservation through startup: rebinding after the service
  // is ready lets another parallel test claim the connector port in between.
  const f=await fixture(t,{holdReservedPort:true}),blocker=f.p.blocker;
  assert.equal(blocker.address().port,f.p.gateway+1);
  const service=f.serve();
  try{
    await service.until(/Dashboard:/);
    const first=f.run('shutdown','--timeout-ms','1000'),second=f.run('shutdown','--timeout-ms','1000');
    await Promise.all([first,second].map(p=>assert.rejects(p,e=>/shutdown_timeout/.test(e.stderr))));
    assert.equal(blocker.listening,true);assert.equal(await service.closed,0);
    assert.equal(JSON.parse((await f.run('status')).stdout).maintenance,true);
  }finally{await new Promise(r=>blocker.close(r));}
  assert.equal((await shutdownDesktop({dataDir:f.data})).status,'stopped');
});

test('an impostor HTTP instance and a legacy service are refused before maintenance or POST',async t=>{
  const {createServer:createHttpServer}=await import('node:http'),f=await fixture(t);tryLease(f.data,'service').close();
  let mode='impostor',posts=0;
  const server=createHttpServer((req,res)=>{
    if(req.method==='POST')posts++;
    if(req.url==='/'){res.setHeader('Set-Cookie','lb_admin=synthetic');res.end('synthetic');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({backend:'node',instance:mode==='impostor'?'wrong':'expected',...(mode==='impostor'?{dataDir:f.data,maintenanceVersion:1}:{})}));
  });await new Promise(r=>server.listen(f.p.admin,'127.0.0.1',r));
  try{
    await writeRecord(f.data,'service.json',{runtime:'node',instance:'expected',pid:process.pid,dataDir:f.data,adminPort:f.p.admin,gatewayPort:f.p.gateway});
    await assert.rejects(shutdownDesktop({dataDir:f.data}),{code:'instance_mismatch'});mode='legacy';
    await assert.rejects(shutdownDesktop({dataDir:f.data}),{code:'shutdown_unsupported'});
    assert.equal(posts,0);assert.equal(await maintenance(f.data),null);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(join(f.data,'service.json'));}
});

test('a process exit without a service drain acknowledgment cannot be reported as graceful success',async t=>{
  const f=await fixture(t),source=join(f.data,'synthetic-undrained.mjs');
  await writeFile(source,`import {createServer} from 'node:http';
    import {tryLease,writeRecord} from ${JSON.stringify(pathToFileURL(resolve('server/maintenance.mjs')).href)};
    const data=${JSON.stringify(f.data)},port=${f.p.admin};const lock=tryLease(data,'service');
    await writeRecord(data,'service.json',{runtime:'node',instance:'synthetic-undrained',pid:process.pid,dataDir:data,adminPort:port,gatewayPort:${f.p.gateway}});
    const server=createServer((req,res)=>{
      if(req.url==='/'){res.setHeader('Set-Cookie','lb_admin=synthetic');res.end('synthetic');return;}
      res.setHeader('Content-Type','application/json');
      if(req.url==='/admin/shutdown'){res.once('finish',()=>process.exit(0));res.end('{"stopping":true}');}
      else res.end(JSON.stringify({instance:'synthetic-undrained',backend:'node',dataDir:data,maintenanceVersion:1}));
    });server.listen(port,'127.0.0.1',()=>console.log('synthetic-ready'));`);
  const service=f.start(source);await service.until(/synthetic-ready/);
  await assert.rejects(shutdownDesktop({dataDir:f.data}),{code:'drain_unconfirmed'});assert.equal(await service.closed,0);
  assert.equal((await maintenance(f.data)).serviceDrained,false);
  await assert.rejects(shutdownDesktop({dataDir:f.data}),{code:'drain_unconfirmed'});
});
