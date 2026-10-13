import express from 'express';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { ZodError } from 'zod';
import { adminActor, localActor } from './hub.mjs';
import { directLocalRequest, browserRequest } from './local-access.mjs';
import { fail, publicError } from './errors.mjs';
import { mcpHandler } from './mcp.mjs';
import { openapi } from './openapi.mjs';
import {Cloudflare,CALLBACK} from './cloudflare.mjs';
import {VERSION} from './version.mjs';
import {LocalSetup} from './local-setup.mjs';
import {ChatAccess} from './chat-access.mjs';

function freshQuery(req){if(req.query.fresh===undefined)return false;if(!['true','false'].includes(req.query.fresh))fail(400,'invalid_input','fresh must be true or false.');return req.query.fresh==='true';}
function harden(app) {
  app.disable('x-powered-by');app.set('trust proxy',false);
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});next();
  });
}
function errors(error,req,res,next) {
  if(res.headersSent)return next(error);
  const e=error instanceof ZodError ? {status:400,code:'invalid_input',message:'Invalid request fields.'} : error?.type==='entity.parse.failed' ? {status:400,code:'invalid_json',message:'Invalid JSON body.'} : error?.type==='entity.too.large' ? {status:413,code:'body_too_large',message:'Request is too large.'} : publicError(error);
  res.status(e.status).json({error:e.code,message:e.message});
}
export function createApps({hub,tunnels,root,adminPort=3210,gatewayPort=3211,cloudflare=new Cloudflare(hub.store,hub.vault,adminPort),instance=null,dataDir=null,shutdown,prepareMaintenance,requireToken=true,localSetup=new LocalSetup(hub,{gatewayPort})}) {
  const admin=express(),gateway=express();harden(admin);harden(gateway);
  const jobs=new Set();let draining=false;
  const admission=(req,res,next)=>draining?res.status(503).json({error:'service_stopping'}):next();
  const asyncRoute=fn=>(req,res,next)=>{
    if(draining){res.status(503).json({error:'service_stopping'});return;}
    const job=Promise.resolve().then(()=>fn(req,res,next));jobs.add(job);
    void job.catch(next).finally(()=>jobs.delete(job));
  };
  for(const app of [admin,gateway])app.use(admission);
  const session=randomBytes(32).toString('base64url');
  const adminHosts=new Set([`localhost:${adminPort}`,`127.0.0.1:${adminPort}`]);
  admin.use((req,res,next)=>{
    if(!adminHosts.has(req.headers.host))return res.status(403).json({error:'local_dashboard_only'});
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)||Object.keys(req.headers).some(name=>/^(forwarded|via|true-client-ip|x-real-ip|x-original-host|x-original-url|x-forwarded-.*|cf-.*)$/.test(name)))return res.status(403).json({error:'local_dashboard_only'});
    const callback=req.method==='GET'&&req.path===CALLBACK;
    if(!callback&&req.headers.origin && ![`http://localhost:${adminPort}`,`http://127.0.0.1:${adminPort}`].includes(req.headers.origin))return res.status(403).json({error:'origin_denied'});
    if(!callback&&req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'origin_denied'});
    if(req.path==='/' && req.method==='GET')res.cookie('lb_admin',session,{httpOnly:true,sameSite:'strict',path:'/',maxAge:86400000});
    next();
  });
  admin.use('/admin',(req,res,next)=>{
    const cookie=(req.headers.cookie ?? '').split(';').some(c=>c.trim()===`lb_admin=${session}`);
    if(!cookie)return res.status(401).json({error:'dashboard_session_required',message:'Open the local dashboard first.'});
    if(!['GET','HEAD'].includes(req.method) && (req.headers['x-line-bridge']!=='dashboard' || !req.headers.origin))return res.status(403).json({error:'origin_required'});
    next();
  });
  admin.use(express.json({limit:'32kb'}));
  admin.use(admission); // An admitted request may still have been reading its body.
  admin.get(CALLBACK,asyncRoute(async(req,res)=>{
    try{await cloudflare.finish(req.query);res.type('html').send('<!doctype html><html lang="zh-TW"><meta charset="utf-8"><title>LineBridge</title><h1>Cloudflare 已連接</h1><p>可以關閉這個分頁，返回 LineBridge。</p></html>');}
    catch(error){res.status(publicError(error).status).type('html').send('<!doctype html><html lang="zh-TW"><meta charset="utf-8"><title>LineBridge</title><h1>Cloudflare 授權未完成</h1><p>請返回 LineBridge 重新連接。</p></html>');}
  }));
  const authentication=()=>!requireToken&&tunnels.config().provider==='local'?'local':'token';
  const chatAccess=new ChatAccess(localSetup,{authentication});
  admin.get('/admin/discovery',(req,res)=>res.json({version:VERSION,instance,cli:{node:process.execPath,script:join(root,'bin/linebridge.mjs'),platform:process.platform},gatewayEnabled:hub.store.setting('aiEnabled',true),profiles:localSetup.discover()}));
  // Service identity for `linebridge status`, `stop` and the tray. Unlike /state it
  // never opens the protected credential store, queries tunnels or writes debug logs.
  admin.get('/admin/status',(req,res)=>res.json({version:VERSION,backend:'node',instance,...(prepareMaintenance?{dataDir,maintenanceVersion:1}:{}),authentication:authentication(),gatewayEnabled:hub.store.setting('aiEnabled',true),accounts:hub.store.accounts().length}));
  admin.get('/admin/state',asyncRoute(async(req,res)=>{
    const startedAt=Date.now();
    try{
      const state={version:VERSION,backend:'node',locale:'zh-TW',instance,cli:{node:process.execPath,script:join(root,'bin/linebridge.mjs'),platform:process.platform},accounts:await Promise.all(hub.accounts(adminActor).map(async a=>({...a,localSetup:await localSetup.status(a.id),localAccess:hub.localAccess(a.id),discovery:hub.store.setting(`discovery:${a.id}`,null)}))),tokens:hub.tokens(),tunnel:await tunnels.status(),cloudflare:cloudflare.status(),
        chatCounts:Object.fromEntries(hub.store.accounts().map(a=>[a.id,hub.store.chats(a.id).length])),
        gateway:{port:gatewayPort,mcp:'/mcp',api:'/api/v1',authentication:authentication(),requireToken,enabled:hub.store.setting('aiEnabled',true)},refresh:hub.refreshSettings(),vault:hub.vault.protection};
      hub.debug.refresh(startedAt,state);
      res.json({...state,debugLogging:hub.debug.settings(),audit:hub.store.audits()});
    }catch(error){hub.debug.refresh(startedAt,null,error);throw error;}
  }));
  admin.put('/admin/debug-settings',(req,res)=>res.json(hub.debug.configure(req.body)));
  admin.put('/admin/refresh-settings',asyncRoute(async(req,res)=>res.json(await hub.setRefreshSettings(req.body))));
  admin.post('/admin/pause',(req,res)=>{if(typeof req.body.enabled!=='boolean')fail(400,'invalid_input','enabled must be a boolean.');hub.store.setSetting('aiEnabled',req.body.enabled);hub.store.audit('local-admin','gateway.toggle',null,null,req.body.enabled?'enabled':'paused');res.json({enabled:req.body.enabled});});
  admin.post('/admin/accounts',asyncRoute(async(req,res)=>res.status(201).json(await hub.addAccount(req.body))));
  admin.post('/admin/accounts/:id/login',(req,res)=>res.json(hub.beginLogin(req.params.id)));
  admin.get('/admin/accounts/:id/login',(req,res)=>res.json(hub.loginState(req.params.id)));
  admin.post('/admin/accounts/:id/reconnect',asyncRoute(async(req,res)=>res.json(await hub.connect(req.params.id))));
  admin.post('/admin/accounts/:id/disconnect',(req,res)=>{hub.disconnect(req.params.id,req.body.forget===true);res.json({ok:true});});
  admin.delete('/admin/accounts/:id',asyncRoute(async(req,res)=>{const setup=await localSetup.revoke(req.params.id);if(setup.phase==='cleanup_required')fail(503,'credential_store_unavailable','Access is revoked. Unlock protected storage and retry removal to clean up the managed profile.');hub.remove(req.params.id);res.json({ok:true});}));
  admin.post('/admin/accounts/:id/local-setup',asyncRoute(async(req,res)=>res.json(await localSetup.enable(req.params.id,req.body))));
  admin.patch('/admin/accounts/:id/local-setup',asyncRoute(async(req,res)=>res.json(await localSetup.updateSettings(req.params.id,req.body))));
  admin.delete('/admin/accounts/:id/local-setup',asyncRoute(async(req,res)=>res.json(await localSetup.revoke(req.params.id))));
  admin.put('/admin/accounts/:id/local-setup/scope',asyncRoute(async(req,res)=>{
    const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
    try{res.json(await chatAccess.applyScope(req.params.id,req.body,{signal:controller.signal}));}finally{res.off('close',cancel);}
  }));
  admin.post('/admin/accounts/:id/monitor',asyncRoute(async(req,res)=>res.json(await hub.monitor(req.params.id,req.body.enabled))));
  admin.put('/admin/accounts/:id/local-access',(req,res)=>res.json(hub.setLocalAccess(req.params.id,req.body)));
  admin.get('/admin/accounts/:id/events',(req,res)=>res.json(hub.events(adminActor,req.params.id,Number(req.query.after??0),Number(req.query.limit??100))));
  admin.post('/admin/messages/search',(req,res)=>res.json(hub.search(adminActor,req.body)));
  admin.get('/admin/accounts/:id/chats',(req,res)=>res.json(hub.chats(adminActor,req.params.id)));
  admin.post('/admin/accounts/:id/discover',asyncRoute(async(req,res)=>res.json(await hub.discover(req.params.id))));
  admin.post('/admin/accounts/:id/chats',(req,res)=>res.status(201).json(hub.addChat(req.params.id,req.body)));
  admin.get('/admin/accounts/:id/chats/:chatId/access',(req,res)=>res.json(chatAccess.preview(req.params.id,req.params.chatId)));
  admin.patch('/admin/accounts/:id/chats/:chatId',asyncRoute(async(req,res)=>{
    const controller=new AbortController(),cancel=()=>{if(!res.writableEnded)controller.abort();};res.once('close',cancel);
    try{res.json(await chatAccess.apply(req.params.id,req.params.chatId,req.body,{signal:controller.signal}));}finally{res.off('close',cancel);}
  }));
  admin.get('/admin/accounts/:id/chats/:chatId/messages',asyncRoute(async(req,res)=>res.json(await hub.read(adminActor,req.params.id,req.params.chatId,Number(req.query.limit ?? 30),req.query.cursor,freshQuery(req)))));
  admin.get('/admin/accounts/:id/chats/:chatId/text-capability',asyncRoute(async(req,res)=>res.json(await hub.textCapability(adminActor,req.params.id,req.params.chatId))));
  admin.post('/admin/accounts/:id/chats/:chatId/messages',asyncRoute(async(req,res)=>res.json(await hub.send(adminActor,req.params.id,req.params.chatId,req.body.text,req.body.idempotencyKey,'text',{acknowledgeOaTransport:req.body.acknowledgeOaTransport}))));
  admin.post('/admin/tokens',(req,res)=>res.status(201).json(hub.createToken(req.body)));
  admin.put('/admin/tokens/:id/grants',(req,res)=>res.json(hub.updateTokenScope(req.params.id,req.body)));
  admin.delete('/admin/tokens/:id',(req,res)=>{hub.store.revoke(req.params.id);hub.store.audit('local-admin','token.revoke',null,null,'ok');res.json({ok:true});});
  admin.put('/admin/tunnel',(req,res)=>res.json(tunnels.configure(req.body)));
  admin.post('/admin/tunnel/start',asyncRoute(async(req,res)=>res.json(await tunnels.start(req.body.connectorToken))));
  admin.post('/admin/tunnel/stop',asyncRoute(async(req,res)=>res.json(await tunnels.stop())));
  admin.post('/admin/tunnel/ngrok/token',(req,res)=>res.json(tunnels.setNgrokToken(req.body.authtoken)));
  admin.delete('/admin/tunnel/ngrok/token',(req,res)=>res.json(tunnels.forgetNgrokToken()));
  admin.post('/admin/tunnel/install',asyncRoute(async(req,res)=>res.json(await tunnels.install(req.body.provider))));
  admin.post('/admin/tunnel/tailscale/connect',asyncRoute(async(req,res)=>res.json(await tunnels.connectTailscale())));
  admin.put('/admin/cloudflare/client',(req,res)=>res.json(cloudflare.configure(req.body)));
  admin.post('/admin/cloudflare/login',(req,res)=>res.json(cloudflare.begin()));
  admin.post('/admin/cloudflare/disconnect',asyncRoute(async(req,res)=>res.json(await cloudflare.disconnect())));
  admin.get('/admin/cloudflare/resources',asyncRoute(async(req,res)=>res.json(await cloudflare.resources(req.query.accountId))));
  admin.post('/admin/cloudflare/setup',asyncRoute(async(req,res)=>res.json(await cloudflare.provision(tunnels,gatewayPort,req.body))));
  admin.post('/admin/cloudflare/service-token',(req,res)=>res.json(cloudflare.serviceToken()));
  if(shutdown)admin.post('/admin/shutdown',asyncRoute(async(req,res)=>{
    if(req.body.instance!==instance)fail(409,'instance_mismatch','The service instance has changed.');
    if(req.body.maintenanceId!==undefined){if(!prepareMaintenance)fail(409,'shutdown_unsupported','Maintenance shutdown is unavailable.');await prepareMaintenance(req.body.maintenanceId);}
    res.once('finish',()=>{void shutdown().catch(()=>{process.exitCode=1;});});res.json({stopping:true});
  }));
  admin.use(express.static(join(root,'public'),{index:'index.html',etag:false,maxAge:0}));
  admin.use((req,res)=>res.status(404).json({error:'not_found'}));admin.use(errors);

  let accessKeyset,accessIssuer;
  gateway.use((req,res,next)=>{
    const hosts=new Set([`localhost:${gatewayPort}`,`127.0.0.1:${gatewayPort}`,tunnels.gatewayHostname()].filter(Boolean));
    if(!hosts.has(req.headers.host))return res.status(403).json({error:'host_denied'});
    if(browserRequest(req))return res.status(403).json({error:'browser_origin_denied',message:'Use a server-side AI client. The dashboard is on its separate local port.'});
    next();
  });
  gateway.get('/health',(req,res)=>res.json({service:'LineBridge',version:VERSION,status:'running'}));
  gateway.use(asyncRoute(async(req,res,next)=>{
    const c=tunnels.config();
    const header=req.headers.authorization;
    req.actor=header===undefined&&directLocalRequest(req,gatewayPort,c.provider,requireToken)?localActor:hub.authenticate(header?.startsWith('Bearer ')?header.slice(7):undefined);
    // Managed credentials are valid only on a direct server-side loopback
    // connection, even if a tunnel is configured or its proxy spoofs Host.
    if(req.actor.localOnly&&!directLocalRequest(req,gatewayPort,'local'))fail(403,'local_profile_only','This managed profile is limited to direct local AI clients.');
    // Once configured, enforce Access on ALL gateway requests, independent of spoofable Host/forwarding headers.
    if(c.provider==='cloudflare' && c.hostname&&!req.actor.localOnly) {
      if(!c.teamDomain||!c.audience)fail(503,'access_not_configured','Cloudflare Access must be configured before remote access.');
      const assertion=req.headers['cf-access-jwt-assertion'];
      if(typeof assertion!=='string')fail(401,'cloudflare_access_required','Cloudflare Access authentication is required in addition to a LINE Bridge Bearer token.');
      const issuer=`https://${c.teamDomain}`;
      if(accessIssuer!==issuer){accessIssuer=issuer;accessKeyset=createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`),{timeoutDuration:5000});}
      try{await jwtVerify(assertion,accessKeyset,{issuer,audience:c.audience,algorithms:['RS256']});tunnels.accessLastValidated=new Date().toISOString();}
      catch{fail(401,'invalid_access_assertion','Cloudflare Access authentication failed.');}
    }
    if(!hub.store.setting('aiEnabled',true))fail(503,'gateway_paused','The user has paused AI access.');
    // A supplied credential is always validated; invalid credentials never
    // silently fall back to the VM's local permissions.
    hub.limit(req.actor);next();
  }));
  gateway.use(express.json({limit:'32kb'}));
  gateway.use(admission);
  gateway.get('/api/v1/version',(req,res)=>res.json({service:'LineBridge',version:VERSION}));
  gateway.get('/api/v1/status',(req,res)=>res.json({enabled:true,authentication:req.actor.local?'local':'token',accounts:hub.accounts(req.actor),setup:{dashboard:`http://127.0.0.1:${adminPort}`,mcp:`http://127.0.0.1:${gatewayPort}/mcp`,steps:['Pair your LINE account by scanning its QR code on your phone.','Designate chats, enable monitoring and create a scoped AI token.','Start a tunnel on this PC and connect your cloud AI with its HTTPS URL and token.']}}));
  gateway.get('/api/v1/accounts',(req,res)=>res.json(hub.accounts(req.actor)));
  gateway.get('/api/v1/accounts/:id/chats',(req,res)=>res.json(hub.chats(req.actor,req.params.id)));
  gateway.get('/api/v1/accounts/:id/events',(req,res)=>res.json(hub.events(req.actor,req.params.id,Number(req.query.after??0),Number(req.query.limit??100))));
  gateway.post('/api/v1/messages/search',(req,res)=>res.json(hub.search(req.actor,req.body)));
  gateway.get('/api/v1/accounts/:id/chats/:chatId/messages',asyncRoute(async(req,res)=>res.json(await hub.read(req.actor,req.params.id,req.params.chatId,Number(req.query.limit ?? 30),req.query.cursor,freshQuery(req)))));
  gateway.post('/api/v1/accounts/:id/chats/:chatId/messages',asyncRoute(async(req,res)=>res.json(await hub.send(req.actor,req.params.id,req.params.chatId,req.body.text,req.headers['idempotency-key'],'text',{acknowledgeOaTransport:req.body.acknowledgeOaTransport}))));
  gateway.get('/openapi.json',(req,res)=>res.json(openapi));
  gateway.get('/api/v1/accounts/:id/chats/:chatId/messages/:messageId/media',asyncRoute(async(req,res)=>{res.set('Cache-Control','no-store');res.json(await hub.media(req.actor,req.params.id,req.params.chatId,req.params.messageId));}));
  gateway.post('/api/v1/accounts/:id/chats/:chatId/flex',asyncRoute(async(req,res)=>res.json(await hub.sendFlex(req.actor,req.params.id,req.params.chatId,req.body,req.headers['idempotency-key']))));
  gateway.post('/mcp',asyncRoute((req,res)=>mcpHandler(hub,req,res)));
  gateway.all('/mcp',(req,res)=>res.status(405).json({error:'method_not_allowed',message:'Use stateless Streamable HTTP POST.'}));
  gateway.use((req,res)=>res.status(404).json({error:'not_found'}));gateway.use(errors);
  return {admin,gateway,async drain(){draining=true;while(jobs.size)await Promise.allSettled([...jobs]);}};
}
