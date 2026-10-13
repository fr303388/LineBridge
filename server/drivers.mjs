import { BaseClient } from '@evex/linejs/base';
import { Agent, fetch as lineFetch } from 'undici';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fail, SendRejectedError } from './errors.mjs';
import {AliasResolver,contactName} from './aliases.mjs';
import {ACCOUNT_CHECK_TIMEOUT_MS,accountCheckError,accountDiagnostic} from './account-health.mjs';
import {mediaDescriptor,archivedMedia,basicSticker,imageResult,audioResult,boundedResponse,decryptAuthenticatedMedia,MEDIA_TIMEOUT_MS} from './media.mjs';
import {assertFlexTransport,validateFlex} from './flex.mjs';
import {officialAccountCapability,OA_NOTICE} from './official-account.mjs';
import {prepareText} from './send-preparation.mjs';
import {dispatchText} from './send-dispatch.mjs';
import {guardRpcTransport} from './rpc-transport.mjs';
import {existingKeyE2EE} from './encryption-policy.mjs';

export function discoveryErrorCode(error) {
  const code=error?.data?.errorCode ?? error?.data?.code ?? error?.code;
  return typeof code==='number' ? String(code) : typeof code==='string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'protocol_error';
}

export function joinedSquareRooms(response) {
  const rooms=new Map();
  for(const event of response.events ?? []) {
    const membership=event.payload?.notifiedCreateSquareChatMember;
    const chat=membership?.chat,state=membership?.chatMember?.membershipState;
    if(chat?.squareChatMid && (state==='JOINED' || state===1)) rooms.set(chat.squareChatMid,{id:chat.squareChatMid,name:chat.name || chat.squareChatMid,kind:'openchat'});
  }
  return [...rooms.values()];
}

export function normalizeMessage(raw, extra={}) {
  let timestamp = null;
  const numeric = Number(raw.createdTime ?? raw.timestamp);
  if (Number.isFinite(numeric) && numeric > 0 && numeric < 8640000000000000) timestamp = new Date(numeric).toISOString();
  return { id: String(raw.id ?? ''), senderId: String(raw.from ?? ''), text: String(raw.text ?? ''), timestamp,
    contentType: String(raw.contentType ?? 'NONE'), ...(mediaDescriptor(raw)?{media:mediaDescriptor(raw)}:{}), ...extra };
}

export function squareMessages(response) {
  const unique = new Map();
  for (const event of response.events ?? []) {
    const payload = event.payload?.receiveMessage ?? event.payload?.sendMessage ?? event.payload?.notificationMessage;
    const raw = payload?.squareMessage?.message;
    if (raw?.id && !unique.has(String(raw.id))) unique.set(String(raw.id), normalizeMessage(raw, { senderName: payload.senderDisplayName ?? null }));
  }
  return [...unique.values()].sort((a,b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

export class LineDriver {
  constructor(account, storage, events, { fetch: transport } = {}) {
    this.account = account;
    this.storage = storage;
    this.events = events;
    this.abort = new AbortController();
    this.requestSignal = new AsyncLocalStorage();
    // Node 26's fetch negotiates HTTP/2 and multiplexes every RPC onto one LINE
    // connection. LINE stalls the other calls on it while the Talk long-poll is
    // held, so OpenChat polls, account checks, reads and sends time out behind
    // it. Each concurrent RPC gets its own HTTP/1.1 socket instead.
    this.dispatcher = new Agent({ allowH2: false });
    const networkTransport=transport?'custom':'http1';
    transport ??= (url, init) => lineFetch(url, { ...init, dispatcher: this.dispatcher });
    this.client = new BaseClient({ device: account.device, storage, legy: { encrypted: 'auto' },
      fetch: async request => {
        const signal = AbortSignal.any([this.abort.signal, request.signal, this.requestSignal.getStore()].filter(Boolean));
        const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
        return transport(request.url, { method: request.method, headers: request.headers, body, redirect: request.redirect, signal });
      } });
    guardRpcTransport(this.client,{driverSignal:this.abort.signal,receiverSignal:()=>this.requestSignal.getStore(),networkTransport});
    this.client.on('qrcall', url => events.qr(url));
    this.client.on('pincall', pin => events.pin(String(pin)));
    this.client.on('update:authtoken', token => {
      this.client.authToken = token;
      void storage.set('bridge.authToken', token).catch(() => events.fault('vault_write_failed'));
    });
    this.client.on('end', () => events.fault('session_expired'));
    // LINE rotates refresh tokens, but the SDK refreshes once per rejected call
    // and drops the rotated token. Concurrent receivers would spend the same token
    // and a later refresh would fail, forcing a new QR login. Share one refresh.
    this.client.auth.tryRefreshToken = () => this.refreshing ??= this.refreshAccess().finally(() => { this.refreshing = null; });
    // Do not attach the library's log event: it includes raw credentials and message bodies.
  }
  async refreshAccess() {
    const refreshToken = await this.storage.get('refreshToken');
    if (typeof refreshToken !== 'string' || !refreshToken) throw Object.assign(new Error('No refresh token is stored.'), { name: 'RefreshError' });
    const result = await this.client.auth.refresh({ request: { refreshToken } });
    if (typeof result?.accessToken !== 'string' || !result.accessToken) throw Object.assign(new Error('LINE returned no access token.'), { name: 'RefreshError' });
    this.client.authToken = result.accessToken;
    this.client.emit('update:authtoken', result.accessToken);
    if (typeof result.refreshToken === 'string' && result.refreshToken) await this.storage.set('refreshToken', result.refreshToken);
    if (result.tokenIssueTimeEpochSec != null && result.durationUntilRefreshInSec != null) await this.storage.set('expire', result.tokenIssueTimeEpochSec + result.durationUntilRefreshInSec);
  }
  async login(qr=false) {
    const token = qr ? undefined : await this.storage.get('bridge.authToken');
    if (!qr && !token) fail(409,'login_required','Connect this account with QR login first.');
    // BaseClient avoids high-level login's catch-all E2EE key re-registration on token resume.
    try{await this.client.loginProcess.login(qr ? { qr: true } : { authToken: token });}
    catch(error){
      // Resuming cannot repair rejected or unrefreshable credentials; ask for QR.
      if(!qr&&accountDiagnostic(error).kind==='auth')fail(409,'login_required','LINE requires a new QR login to authorize this device.');
      throw error;
    }
    this.ready = true;
    return { displayName: this.client.profile.displayName, mid: this.client.profile.mid };
  }
  stop() { this.ready=false; this.client.disabled=true; this.abort.abort(); void this.dispatcher?.destroy().catch(() => {}); }
  // The SDK accepts a deadline, but no per-call signal. Scope cancellation to
  // this async request so stopping a receiver leaves concurrent account RPCs alone.
  monitorRequest(signal,operation) { signal.throwIfAborted();return this.requestSignal.run(signal,operation); }
  async check(signal) {
    const deadline=AbortSignal.any([this.abort.signal,AbortSignal.timeout(ACCOUNT_CHECK_TIMEOUT_MS),signal].filter(Boolean));
    try{
      const p=await this.monitorRequest(deadline,()=>this.client.talk.getProfile());
      deadline.throwIfAborted();
      if(!p||typeof p.mid!=='string'||!p.mid||typeof p.displayName!=='string')throw new Error('invalid_profile');
      this.client.profile=p;return {displayName:p.displayName,mid:p.mid};
    }catch(error){throw accountCheckError(error);}
  }
  get aliases(){return this.aliasResolver ??= new AliasResolver(this.client,this.storage);}
  async resolveMessageNames(chat,messages){return this.aliases.resolveMessages(chat,messages);}
  async decryptMessage(raw){return existingKeyE2EE(this.client).decryptE2EEMessage(raw);}
  async discover() {
    const result=[], warnings=[], stages={};
    try {
      const joined = await this.client.talk.getAllChatMids({ request:{withMemberChats:true} });
      const ids = joined.memberChatMids ?? [];
      for(let offset=0;offset<ids.length;offset+=100) {
        const response=await this.client.talk.getChats({ chatMids:ids.slice(offset,offset+100) });
        for(const chat of response.chats ?? []) result.push({ id:chat.chatMid,name:chat.chatName || chat.chatMid,kind:'group' });
      }
      stages.groups={status:'ok',count:result.filter(c=>c.kind==='group').length};
    } catch(error) {stages.groups={status:'failed',errorCode:discoveryErrorCode(error)};warnings.push(`Group discovery failed (${stages.groups.errorCode}).`);}
    try {
      const mids=await this.client.talk.getAllContactIds();
      const names={aliases:0,profiles:0,unavailable:0};
      for(let offset=0;offset<(mids?.length ?? 0);offset+=100) {
        const response=await this.client.talk.getContactsV2({ mids:mids.slice(offset,offset+100) });
        await this.aliases.rememberContacts(response.contacts);
        for(const [mid,entry] of Object.entries(response.contacts ?? {})) {
          const contact=entry.contact ?? entry;
          const id=contact.mid ?? mid;
          if(id){result.push({id,name:contactName(contact) || '名稱暫時無法取得',kind:'direct'});names[contact.displayNameOverridden?.trim()?'aliases':contact.displayName?.trim()?'profiles':'unavailable']++;}
        }
      }
      stages.direct={status:'ok',count:result.filter(c=>c.kind==='direct').length,names};
    } catch(error) {stages.direct={status:'failed',errorCode:discoveryErrorCode(error)};warnings.push(`Contact discovery failed (${stages.direct.errorCode}).`);}
    try {
      let continuationToken;
      const rooms=new Map();
      // Bounded pagination: avoids unbounded enumeration of account data.
      for(let page=0;page<20;page++) {
        // getJoinedSquareChats returns NOT_IMPLEMENTED. The initial event snapshot
        // contains memberships for joined rooms, unlike getJoinableSquareChats.
        const response=await this.client.square.fetchMyEvents({limit:200,continuationToken});
        for(const chat of joinedSquareRooms(response)) rooms.set(chat.id,chat);
        continuationToken=response.continuationToken;
        if(!continuationToken) break;
      }
      result.push(...rooms.values());
      stages.openchat={status:continuationToken?'partial':'ok',count:rooms.size,source:'membership_events'};
      if(continuationToken) warnings.push('OpenChat discovery reached its page limit; some rooms may be missing.');
    } catch(error) {stages.openchat={status:'failed',errorCode:discoveryErrorCode(error)};warnings.push(`OpenChat discovery failed (${stages.openchat.errorCode}).`);}
    return { chats:result.filter(c => c.id),warnings,stages };
  }
  async read(chat,limit,cursor) {
    if(chat.kind==='openchat') {
      const response=await this.client.square.fetchSquareChatEvents({squareChatMid:chat.id,limit,direction:'BACKWARD',...(cursor ? {syncToken:cursor} : {})});
      return {messages:await this.resolveMessageNames(chat,squareMessages(response).slice(-limit)),cursor:response.syncToken ?? null,coverage:'A bounded page of OpenChat events; media content is not downloaded.'};
    }
    if(cursor) fail(400,'cursor_unsupported','Personal chats support recent messages only in this version.');
    // v0.1.3 lacks the convenience wrapper. These field IDs match the LINE Talk RPC.
    const response=await this.client.request.request([[11,2,chat.id],[8,3,limit]],'getRecentMessagesV2',4,false,'/S4');
    if(!Array.isArray(response)) fail(502,'protocol_mismatch','LINE returned an unexpected history response.');
    const messages=[];
    for(const item of response) {
      const raw=this.client.thrift.rename_thrift('Message',item);
      try { messages.push(normalizeMessage(await this.decryptMessage(raw))); }
      catch { messages.push(normalizeMessage({...raw,text:''},{unavailableReason:'E2EE decryption failed; this message was not exposed.'})); }
    }
    return {messages:await this.resolveMessageNames(chat,messages.sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)))),cursor:null,coverage:'Recent messages returned by LINE; full historical sync is not supported.'};
  }
  async media(chat,message) {
    const deadline=AbortSignal.any([this.abort.signal,AbortSignal.timeout(MEDIA_TIMEOUT_MS)]);
    return this.monitorRequest(deadline,async()=>{
      const media=archivedMedia(message);
      if(!media)fail(409,'media_metadata_missing','This archived message predates media metadata support. Legacy metadata is not automatically reconstructed.');
      if(media.kind==='sticker'){
        if(!basicSticker(media))fail(415,'sticker_unsupported','Only basic sticker previews with validated IDs are supported; custom-text or option-bearing stickers are not rendered.');
        const url=`https://stickershop.line-scdn.net/stickershop/v1/sticker/${media.stickerId}/android/sticker.png`;
        const response=await fetch(url,{redirect:'error',signal:deadline});
        return {...imageResult(await boundedResponse(response,deadline),true),notice:'Static sticker preview only; animation, sound and custom text are not interpreted.'};
      }
      const types={image:['IMAGE','1'],audio:['AUDIO','3']}[media.kind];
      if(!types)fail(415,'media_unsupported','This message is not a supported image or audio message.');
      // Isolated SDK OBS adapter: no credential-bearing redirects, arbitrary paths,
      // filenames, unbounded blob() calls, or mutation of the live client fetch.
      // The SDK may register a missing group key from its read helper. Shadow
      // registration on a request-local E2EE object; media reads must never enroll
      // keys or mutate the shared client's encryption behavior.
      const readE2ee=Object.create(this.client.e2ee);
      readE2ee.tryRegisterE2EEGroupKey=readE2ee.registerE2EEKeyPair=()=>fail(409,'media_key_unavailable','An existing decryption key is required; media reads never register keys.');
      readE2ee.decryptByKeyMaterial=(bytes,key)=>decryptAuthenticatedMedia(readE2ee,bytes,key);
      const obs=new this.client.obs.constructor({authToken:this.client.authToken,request:this.client.request,e2ee:readE2ee,fetch:async(info,init)=>{
        const req=new Request(info,init),url=new URL(req.url);
        if(url.origin!=='https://obs.line-apps.com'||!/^\/r\/(?:talk|g2)\/[A-Za-z0-9_./-]+$/.test(url.pathname)||url.search||url.hash||url.username||url.password||req.method!=='GET')fail(415,'media_unsupported','Unsupported media resource.');
        const response=await fetch(new Request(req,{redirect:'error',signal:deadline}));
        return new Response(await boundedResponse(response,deadline),{headers:response.headers});
      }});
      let file;
      if(chat.kind==='openchat')file=await obs.downloadMessageData({messageId:message.id,isSquare:true});
      else {
        const response=await this.client.request.request([[11,2,chat.id],[8,3,100]],'getRecentMessagesV2',4,false,'/S4');
        const raw=Array.isArray(response)?response.map(item=>this.client.thrift.rename_thrift('Message',item)).find(m=>String(m.id)===message.id):null;
        if(!raw)fail(409,'media_history_unavailable','Media is outside the latest 100 upstream messages; encrypted metadata is not retained.');
        if(!types.includes(String(raw.contentType)))fail(415,'media_unsupported',`Upstream message is not ${media.kind==='audio'?'audio':'an image'}.`);
        if(raw.chunks?.length){
          if(!/^[A-Za-z0-9_-]{1,150}$/.test(raw.contentMetadata?.OID??'')||!/^[A-Za-z0-9_-]{1,80}$/.test(raw.contentMetadata?.SID??''))fail(415,'media_unsupported','Encrypted media locator is unavailable or unsupported.');
          file=await obs.downloadMediaByE2EE(raw);
        }else file=await obs.downloadMessageData({messageId:message.id});
      }
      if(!file)fail(502,'media_unavailable','Media could not be retrieved or decrypted.');
      return media.kind==='audio'?audioResult(await file.arrayBuffer()):imageResult(await file.arrayBuffer());
    });
  }
  async sendFlex(chat,input) {
    const payload=validateFlex(input);assertFlexTransport(chat);
    let message;
    try{
      // Same Talk wire contract as pinned SDK LineClient.sendFlex. Flex is
      // natively transport-only; never change account or text E2EE settings.
      // Explicit false also disables the SDK's automatic E2EE retry branch.
      message=await this.client.talk.sendMessage({to:chat.id,e2ee:false,contentType:'FLEX',contentMetadata:{ALTTEXT:payload.altText,FLEXCONTAINER:JSON.stringify(payload.contents)}});
    }catch(error){const code=discoveryErrorCode(error);if(error?.name==='RequestError'&&code!=='protocol_error'&&code!=='UNKNOWN')throw new SendRejectedError(502,'line_send_rejected',`LINE rejected Flex (${code}). No fallback was attempted.`);throw error;}
    if(!message?.id)fail(502,'send_unconfirmed','LINE did not return a message ID. Delivery is unknown; inspect the chat before sending again.');
    return {messageId:String(message.id),timestamp:normalizeMessage(message).timestamp,delivery:'accepted_by_line',protection:'line_transport',notice:'Flex is not Letter Sealed. Acceptance does not prove client rendering or recipient interaction.'};
  }
  async textCapability(chat) {
    try {
      const operation=()=>officialAccountCapability(this.client,chat);
      const capability=await this.monitorRequest(AbortSignal.timeout(15000),operation);
      return {officialAccount:capability.officialAccount,notice:capability.officialAccount?OA_NOTICE:undefined};
    }catch(error){throw new SendRejectedError(502,'send_preparation_failed',`Message preparation failed (${error.diagnostic??'MESSAGE_PREPARATION_SDK_ERROR'}). No message was sent.`);}
  }
  async send(chat,text,{acknowledgeOaTransport=false}={},beforeDispatch=()=>{}) {
    let options,officialAccount=false,protection=chat.kind==='openchat'?'line_transport':'letter_sealing';
    if(chat.kind!=='openchat') {
      try {
        const capability=chat.kind==='direct'?await this.monitorRequest(AbortSignal.timeout(15000),()=>officialAccountCapability(this.client,chat)):{officialAccount:false};
        if(capability.officialAccount){
          officialAccount=true;
          if(acknowledgeOaTransport!==true)throw new SendRejectedError(409,'oa_transport_acknowledgment_required',OA_NOTICE+' Supply acknowledgeOaTransport:true only after explicit user approval. No message was sent.');
          options={to:chat.id,text,e2ee:false};protection='line_transport';
        }else{
          const chunks=await prepareText(this.client,chat,text,capability.negotiation);
          options={to:chat.id,chunks,e2ee:true,contentType:'NONE',contentMetadata:{e2eeVersion:'2',contentType:'0',e2eeMark:'2'}};
        }
      } catch(preparation) {
        if(preparation instanceof SendRejectedError)throw preparation;
        const error=preparation.original??preparation;
        // This explicit LINE response means the chat expects standard messaging.
        // Missing keys, timeouts and other errors must not silently downgrade it.
        if(error?.name==='RequestError' && !preparation.diagnostic?.startsWith('BUDDY_LOOKUP_') && discoveryErrorCode(error)==='E2EE_RETRY_PLAIN') {
          options={to:chat.id,text,e2ee:false};protection='line_transport';
        } else {
          throw new SendRejectedError(502,'send_preparation_failed',`Message preparation failed (${preparation.diagnostic??'MESSAGE_PREPARATION_SDK_ERROR'}). No message was sent. Review this preparation stage before another attempt; do not reset keys or weaken encryption.`);
        }
      }
    }
    let response;
    try {
      response=await dispatchText(this.client,chat,chat.kind==='openchat'?{squareChatMid:chat.id,text}:options,beforeDispatch);
    } catch(error) {
      const code=discoveryErrorCode(error);
      if(error?.name==='RequestError' && code!=='protocol_error' && code!=='UNKNOWN') {
        throw new SendRejectedError(502,'line_send_rejected',`LINE rejected the message (${code}). Check the account and chat permissions before trying again.`);
      }
      throw error;
    }
    const message=response?.createdSquareMessage?.message ?? response?.squareMessage?.message ?? response;
    if(!message?.id) fail(502,'send_unconfirmed','LINE did not return a message ID. Delivery is unknown; inspect the chat before sending again.');
    return {messageId:String(message.id),timestamp:normalizeMessage(message).timestamp,delivery:'accepted_by_line',protection,...(officialAccount?{notice:OA_NOTICE}:{})};
  }
}

export class DemoDriver {
  constructor() {
    this.ready=true;
    this.rooms=[{id:'demo-group',name:'Project room',kind:'group'},{id:'demo-openchat',name:'OpenChat sandbox',kind:'openchat'}];
    this.messages=new Map(this.rooms.map((room,i)=>[room.id,[
      {id:`sample-${i}-1`,senderId:'sample-person',senderName:'Sample member',text:i ? 'This is a synthetic OpenChat message for testing the gateway.' : 'The account bridge is ready for a scoped AI client.',timestamp:'2026-09-30T08:00:00.000Z',contentType:'NONE'},
      {id:`sample-${i}-2`,senderId:'sample-person-2',senderName:'Sample teammate',text:'Only designated chats can be read or sent to. No LINE account is connected in this sandbox.',timestamp:'2026-09-30T08:01:00.000Z',contentType:'NONE'}
    ]]));
  }
  async login() { this.ready=true; return this.check(); }
  async check() { return {displayName:'Sample account',mid:'synthetic'}; }
  async discover() { return {chats:this.rooms,warnings:[]}; }
  async read(chat,limit) { return {messages:(this.messages.get(chat.id) ?? []).slice(-limit),cursor:null,coverage:'Synthetic sandbox data. No LINE network calls.'}; }
  async send(chat,text) {
    const message={id:`demo-${randomUUID()}`,senderId:'synthetic',text,timestamp:new Date().toISOString(),contentType:'NONE'};
    const list=this.messages.get(chat.id) ?? []; list.push(message);this.messages.set(chat.id,list.slice(-100));
    return {messageId:message.id,timestamp:message.timestamp,delivery:'sandbox_only'};
  }
  stop() { this.ready=false; }
}
