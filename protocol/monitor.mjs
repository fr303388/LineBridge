import {normalizeMessage} from '../server/drivers.mjs';
import timers from 'node:timers/promises';
import {TALK_POLL_TIMEOUT_MS,DEFAULT_REFRESH_INTERVAL_SECONDS,TALK_REARM_MS,TALK_IDLE_EXPIRY_MIN_MS,talkRearmDelayMs,monitorRetryMs} from '../server/monitor-policy.mjs';
import {rpcDiagnostic} from '../server/rpc-transport.mjs';
import {SquareSync} from './square-sync.mjs';
export {SQUARE_BASELINE_PAGE_DELAY_MS,SQUARE_BASELINE_MAX_PAGES,SQUARE_BASELINE_BURST_MS} from './square-sync.mjs';

export function talkChatId(message,ownMid){
  return message.to===ownMid ? String(message.from ?? '') : String(message.to ?? '');
}
export function nextTalkCursor(previous,response){
  const result={...previous},op=response.operationResponse;
  if(response.fullSyncResponse?.nextRevision!=null)result.revision=response.fullSyncResponse.nextRevision;
  if(op?.globalEvents?.lastRevision!=null)result.globalRev=op.globalEvents.lastRevision;
  if(op?.individualEvents?.lastRevision!=null)result.individualRev=op.individualEvents.lastRevision;
  for(const event of op?.operations ?? [])if(event.revision!=null)result.revision=event.revision;
  return result;
}
const pause=(ms,signal)=>timers.setTimeout(ms,undefined,{signal}).catch(error=>{if(!signal.aborted)throw error;});
const errorNames=new Set(['Error','TimeoutError','AbortError','TypeError','RequestError','ClientClosed']);
const networkCodes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const protocolCodes=new Set(['NOT_AUTHORIZED_DEVICE','AUTHENTICATION_FAILED','NOT_AUTHORIZED','FORBIDDEN','NOT_FOUND','INTERNAL_ERROR','INVALID_PARAMETER','MUST_REFRESH_V3_TOKEN','EXCESSIVE_ACCESS','NOT_IMPLEMENTED','UNKNOWN']);
export function pollDiagnostic(error,stage,elapsedMs,pollTimeoutMs,retryInMs){
  // Never copy messages, stacks, URLs, headers, payloads, or arbitrary codes.
  // In particular, SDK parse failures embed raw response headers and bodies.
  const errorName=errorNames.has(error?.name)?error.name:'UnknownError';
  const candidate=error?.code??error?.cause?.code;
  const upstream=error?.data?.errorCode??error?.data?.code;
  const code=networkCodes.has(candidate)?candidate:protocolCodes.has(upstream)?upstream:undefined;
  const transport=rpcDiagnostic(error);
  const httpFailed=transport.httpStatus!==undefined&&(transport.httpStatus<200||transport.httpStatus>=300);
  const kind=stage==='checkpoint'?'storage':stage==='capture'?'capture':errorName==='TimeoutError'?'timeout':errorName==='AbortError'||errorName==='ClientClosed'?'cancelled':networkCodes.has(code)?'network':transport.httpStatus===429?'rate_limit':httpFailed?'http':transport.responseParse||errorName==='RequestError'?'protocol':'unknown';
  return {kind,stage,errorName,...(code?{code}:{}),elapsedMs,pollTimeoutMs,retryInMs,...transport};
}

// Bounded polling avoids the library's unhandled push-loop failures. There are
// no read receipts or send calls in this listener. Cursors advance after durable ACK.
export class LiveMonitor {
  constructor(driver,event,capture,{refreshIntervalMs=DEFAULT_REFRESH_INTERVAL_SECONDS*1000,talkRearmMs=TALK_REARM_MS,diagnostics=false,random=Math.random,pollJitter=Math.random}={}){this.driver=driver;this.event=event;this.capture=capture;this.diagnostics=diagnostics;this.random=random;this.pollJitter=pollJitter;this.talkRearmMs=talkRearmMs;this.active=true;this.abort=new AbortController();this.intervalChanged=new AbortController();this.refreshIntervalMs=refreshIntervalMs;this.allowed=new Map();this.rooms=new Map();this.pollStates=new Map();this.square=new SquareSync(this);this.talkTask=this.talkLoop();}
  setRefreshInterval(ms){this.refreshIntervalMs=ms;this.intervalChanged.abort();this.intervalChanged=new AbortController();}
  async waitForNextPoll(signal,{jitter=false}={}){
    const since=Date.now(),factor=jitter?0.8+0.4*this.pollJitter():1;
    while(!signal.aborted){
      const remaining=Math.round(this.refreshIntervalMs*factor)-(Date.now()-since);if(remaining<=0)return;
      await pause(remaining,AbortSignal.any([signal,this.intervalChanged.signal]));
    }
  }
  update(chats){
    this.allowed=new Map(chats.map(c=>[c.id,c]));
    this.square.update(chats);
  }
  stop(){this.active=false;this.abort.abort();for(const room of this.rooms.values())room.stop();}
  async done(){await Promise.all([this.talkTask,this.square.task]);}
  retryDelay(attempt,error){return monitorRetryMs(attempt,rpcDiagnostic(error).retryAfterMs,this.random);}
  diagnostic(...args){return pollDiagnostic(...args);}
  request(signal,operation){signal.throwIfAborted();return this.driver.monitorRequest?this.driver.monitorRequest(signal,operation):operation();}
  status(channel,status,error,success=false,details={}){
    if(!this.active)return;
    const now=new Date().toISOString(),previous=this.pollStates.get(channel);
    const state={channel,status,error:success&&!details.keepError?undefined:error??previous?.error,lastPoll:now,
      source:channel==='talk'?'talk':details.source??previous?.source??'room_events',
      lastAttemptAt:status==='polling'?now:previous?.lastAttemptAt??null,
      lastSuccessAt:success?now:previous?.lastSuccessAt??null,
      ready:success?status==='running':previous?.ready??false,
      pollTimeoutMs:details.pollTimeoutMs??previous?.pollTimeoutMs??null,
      pollDeadlineAt:status==='polling'&&details.pollTimeoutMs?new Date(Date.parse(now)+details.pollTimeoutMs).toISOString():null,
      nextRetryAt:status==='retrying'&&details.diagnostic?new Date(Date.parse(now)+details.diagnostic.retryInMs).toISOString():null,
      lastFailure:details.diagnostic?{at:now,...details.diagnostic}:previous?.lastFailure??null,
      ...(details.idleExpiry||previous?.lastIdleExpiryAt?{lastIdleExpiryAt:details.idleExpiry?now:previous.lastIdleExpiryAt}:{}),
      ...(this.diagnostics&&(details.pagination??previous?.pagination)?{pagination:details.pagination??previous.pagination}:{})};
    this.pollStates.set(channel,state);this.event('monitor_status',state);
  }
  pageDiagnostic(channel,pagination){
    if(!this.active||!this.diagnostics)return;
    const previous=this.pollStates.get(channel);if(!previous)return;
    // Update response metadata without moving attempt/success times or deadlines.
    const state={...previous,pagination};this.pollStates.set(channel,state);this.event('monitor_status',state);
  }
  async talkLoop(){
    let cursor,retries=0,fastEmpty=0;
    const signal=this.abort.signal;
    while(this.active){
      if(![...this.allowed.values()].some(c=>c.kind!=='openchat')){await pause(1000,signal);continue;}
      let stage='initialize',startedAt=Date.now(),timeoutMs=this.driver.client.config?.timeout??30000;
      try{
        if(!cursor){cursor=await this.driver.storage.get('monitor.talk');if(!cursor){const revision=await this.request(signal,()=>this.driver.client.request.request([],'getLastOpRevision',4,false,'/S4'));if(!['number','bigint'].includes(typeof revision))throw new Error('revision_unavailable');cursor={revision,globalRev:0,individualRev:0};}}
        stage='poll';startedAt=Date.now();timeoutMs=TALK_POLL_TIMEOUT_MS;
        this.status('talk','polling',undefined,false,{pollTimeoutMs:timeoutMs});
        const response=await this.request(signal,()=>this.driver.client.talk.sync({...cursor,limit:100,timeout:timeoutMs}));
        if(!response||!response.fullSyncResponse&&!response.operationResponse||response.operationResponse?.operations!=null&&!Array.isArray(response.operationResponse.operations))throw Object.assign(new Error('Invalid Talk sync response'),{name:'RequestError'});
        if(!this.active)break;
        for(const operation of response.operationResponse?.operations ?? []){
          if(!['SEND_MESSAGE','RECEIVE_MESSAGE',25,26].includes(operation.type)||!operation.message)continue;
          const raw=operation.message,chatId=talkChatId(raw,this.driver.client.profile.mid);
          if(!this.active||!this.allowed.has(chatId))continue;
          let message;
          stage='decrypt';try{message=normalizeMessage(await this.request(signal,()=>this.driver.decryptMessage?this.driver.decryptMessage(raw):this.driver.client.e2ee.decryptE2EEMessage(raw)));}
          catch{message=normalizeMessage({...raw,text:''},{unavailableReason:'E2EE decryption failed; this message was not exposed.'});}
          if(this.active&&this.allowed.has(chatId)&&message.id){
            stage='resolve_names';if(this.driver.resolveMessageNames)[message]=await this.request(signal,()=>this.driver.resolveMessageNames(this.allowed.get(chatId),[message]));
            stage='capture';if(this.active&&this.allowed.has(chatId))await this.capture(chatId,message);
          }
        }
        if(!this.active)break;
        stage='checkpoint';const next=nextTalkCursor(cursor,response);await this.driver.storage.set('monitor.talk',next);cursor=next;
        this.status('talk','running',undefined,true);retries=0;
        fastEmpty=!response.fullSyncResponse&&response.operationResponse?.operations?.length===0&&Date.now()-startedAt<1000?fastEmpty+1:0;
        await pause(Math.max(this.talkRearmMs,talkRearmDelayMs(fastEmpty)),signal);
      }catch(failure){
        if(!this.active)break;fastEmpty=0;let error=failure;
        if(stage==='poll'&&await this.idleExpiry(error,cursor,Date.now()-startedAt,signal)){
          // Same outcome as an empty poll: nothing to capture, cursor durably saved.
          try{
            stage='checkpoint';await this.driver.storage.set('monitor.talk',cursor);
            this.status('talk','running',undefined,true,{idleExpiry:true});retries=0;
            await pause(Math.max(this.talkRearmMs,rpcDiagnostic(failure).retryAfterMs??0),signal);continue;
          }catch(checkpointError){if(!this.active)break;error=checkpointError;}
        }
        const retryInMs=this.retryDelay(retries++,error);this.status('talk','retrying','monitor_poll_failed',false,{diagnostic:pollDiagnostic(error,stage,Date.now()-startedAt,timeoutMs,retryInMs)});await pause(retryInMs,signal);
      }
    }
  }
  // An empty HTTP 410 that ends a held Talk poll is LINE expiring an idle long
  // poll, but only if LINE's latest operation revision confirms nothing newer
  // than this cursor exists. Otherwise it remains a visible poll failure.
  async idleExpiry(error,cursor,elapsedMs,signal){
    const meta=rpcDiagnostic(error);
    if(meta.endpointClass!=='talk_sync'||meta.httpStatus!==410||meta.responseEmpty!==true||meta.responseParse||elapsedMs<TALK_IDLE_EXPIRY_MIN_MS||!this.active)return false;
    try{
      const latest=await this.request(signal,()=>this.driver.client.request.request([],'getLastOpRevision',4,false,'/S4'));
      return this.active&&['number','bigint'].includes(typeof latest)&&BigInt(latest)<=BigInt(cursor.revision);
    }catch{return false;}
  }
}
