import {toggleChatAccess} from './chat-access.js';
import {scopeText,saveTokenScope} from './token-scope.js';
import {createConnections,providerName} from './connections.js';
import { prepareSendIntent } from './send-intent.js';
import {label,errorText,coverage} from './locale.js';
import {icon,hydrateIcons} from './icons.js';
import {accountName,chatName,senderName} from './names.js';
import {createWizard} from './wizard.js';
import {createArchive} from './archive.js';
import {createDashboard} from './dashboard.js';
import {createActivity} from './activity.js';
import {aiInstructionsCard,renderAiInstructions} from './ai-instructions.js';
import {copyText,confirmButton,navIndicator} from './ui.js';
const $=selector=>document.querySelector(selector);
const escape=value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nice=label;
const zone='Asia/Taipei';
const when=value=>value?new Date(value).toLocaleString('zh-TW',{timeZone:zone,hour12:false}): '—';
// Today shows a time, this year a date and time, older entries the year too.
const short=value=>{
  if(!value)return '—';
  const date=new Date(value),now=new Date(),part=(d,options)=>d.toLocaleDateString('zh-TW',{timeZone:zone,...options});
  if(part(date,{})===part(now,{}))return date.toLocaleTimeString('zh-TW',{timeZone:zone,hour12:false,hour:'2-digit',minute:'2-digit'});
  return date.toLocaleString('zh-TW',{timeZone:zone,hour12:false,...(part(date,{year:'numeric'})===part(now,{year:'numeric'})?{}:{year:'numeric'}),month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
};
let state,selectedAccount,selectedChat,chats=[],loginAccount,loginTimer,loginView,toastTimer,sendAttempt,chatFilter='all',chatSearch='',chatAiFilter='monitored';
let startupChecked=false;
const savingAutoMonitor=new Set();
const savingChatMonitoring=new Set();
let refreshRunning=false,reading=false,sending=false,chatListRefreshPending=false;
let refreshTimer,refreshIntervalSeconds=15,refreshSettingsVersion;
let currentPage='dashboard',monitorAccount=null,monitorReading=false,monitorVersion='',monitorOptions='',accountOptions='';
let feedAccount=null,readerChat=null,chatInfoOpen=false;
const seenEvents=new Set(),seenMessages=new Set();
const observedSequences=new Map();
const observedDiscoveries=new Map();
// The dashboard cookie belongs to one service instance and lasts a day. Reopening
// the page issues a new one, so recover a restarted or idle session the same way
// once instead of failing every request until the user reloads.
async function sessionFetch(url,options){
  const response=await fetch(url,options);
  if(response.status!==401||(await response.clone().json().catch(()=>null))?.error!=='dashboard_session_required')return response;
  await fetch('/',{cache:'no-store'});
  return fetch(url,options);
}
async function api(path,options={}) {
  const res=await sessionFetch(`/admin${path}`,{...options,headers:{'Content-Type':'application/json','X-Line-Bridge':'dashboard',...options.headers}});
  const result=await res.json();if(!res.ok){const error=new Error(errorText(result.error,result.message));error.code=result.error;throw error;}return result;
}
// The toast is a manual popover so it stays above open modal dialogs; re-showing
// it moves it to the top of the top layer.
function toast(message,error=false) {
  const el=$('#toast');el.innerHTML=`${icon(error?'alert':'check',error?'':'draw')}<span>${escape(message)}</span>`;el.classList.toggle('error',error);el.classList.remove('show');
  if(el.showPopover){if(el.matches(':popover-open'))el.hidePopover();el.showPopover();}
  requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('show')));
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.classList.remove('show');toastTimer=setTimeout(()=>{if(el.matches?.(':popover-open'))el.hidePopover();},400);},error?9000:3600);
}
async function action(job){try{return await job();}catch(error){toast(error.message,true);}}
function badge(text,kind=''){return `<span class="badge ${kind}">${escape(text)}</span>`;}
function accountStatus(a){return a.status==='connected'&&a.accountHealth?.status==='retrying'?'驗證重試中':a.status==='connected'&&a.accountHealth?.status==='checking'?'驗證中':nice(a.status);}
function statusBadge(a){return badge(a.kind==='demo'?(a.status==='connected'?'沙盒':`沙盒 · ${nice(a.status)}`):accountStatus(a),a.status==='connected'&&(!a.accountHealth||a.accountHealth.status==='healthy')?'good':a.status==='error'?'danger':'warn');}
function presence(a){return a.status==='connected'?(!a.accountHealth||a.accountHealth.status==='healthy'?'on':'warn'):a.status==='error'?'error':['connecting','reconnecting','awaiting_login'].includes(a.status)?'warn':'';}
function configureRefreshTimer(seconds=60){
  if(refreshTimer&&seconds===refreshIntervalSeconds)return;
  clearInterval(refreshTimer);refreshIntervalSeconds=seconds;
  refreshTimer=setInterval(()=>{void refresh();},seconds*1000);
}
function renderRefreshSettings(){
  const settings=state.refresh,field=$('#refresh-interval');
  configureRefreshTimer(settings.intervalSeconds);
  if(refreshSettingsVersion!==settings.intervalSeconds&&!field.matches(':focus')){field.value=settings.intervalSeconds;refreshSettingsVersion=settings.intervalSeconds;}
  field.min=settings.minSeconds;field.max=settings.maxSeconds;field.title=`所有帳號共用，${settings.minSeconds}–${settings.maxSeconds} 秒`;
  $('#refresh-settings-form').classList.toggle('dirty',Number(field.value)!==settings.intervalSeconds);
}
function renderAccountHealth(a){
  const notice=$('#account-health-notice');if(notice){notice.hidden=!a.error;notice.textContent=a.error==='health_check_failed'?'帳號驗證暫時失敗，將自動重試。':a.error?`${nice(a.error)}。請恢復連線。`:'';}
  const checked=$('#account-last-checked');if(checked)checked.textContent=short(a.lastChecked);
}
function switchTab(tab){
  if(tab==='setup'){openSetup();return;}
  currentPage=tab;document.body.dataset.page=tab;
  document.querySelectorAll('.nav').forEach(e=>{e.classList.toggle('active',e.dataset.tab===tab);if(e.dataset.tab===tab)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});
  document.querySelectorAll('.page').forEach(e=>e.classList.toggle('active',e.id===tab));
  document.title=`${pageTitles[tab]} · LineBridge`;document.scrollingElement?.scrollTo(0,0);
  if(tab==='dashboard')dashboard.render();
  if(tab==='accounts'&&!selectedAccount&&state?.accounts.length)action(async()=>{selectedAccount=state.accounts[0].id;await loadChats();renderAccounts();});
  if(tab==='accounts')flushDiscoveredChats();
  if(tab==='monitoring'){monitorAccount=monitorAccount||selectedAccount;renderMonitoring();action(()=>refreshMonitorFeed(true));}
}
function openSetup(){
  const dialog=$('#setup-dialog');if(dialog.open)return;
  wizard.start();dialog.showModal();
}
function initializeStartup(){
  if(startupChecked||!state)return;
  // Wait for a successful state read, and never interrupt another open dialog.
  if(!state.accounts.length&&document.querySelector('dialog[open]'))return;
  startupChecked=true;
  if(!state.accounts.length)openSetup();
}
const pageTitles={dashboard:'總覽',monitoring:'監控',archive:'搜尋',accounts:'聊天室',access:'AI 存取',tunnel:'雲端連線',activity:'紀錄'};
document.querySelectorAll('[data-tab]').forEach(e=>{e.setAttribute('aria-label',e.textContent.trim());e.title=e.textContent.trim();e.addEventListener('click',()=>switchTab(e.dataset.tab));});
document.querySelectorAll('[data-close]').forEach(e=>e.addEventListener('click',()=>{$(`#${e.dataset.close}`).close();if(e.dataset.close==='account-dialog')wizard.cancelNewAccount();if(e.dataset.close==='secret-dialog')$('#new-secret').value='';}));
$('#secret-dialog').addEventListener('close',()=>{$('#new-secret').value='';});
// Dynamic markup uses data-go (navigate), data-copy (copy a node's text) and data-act.
const shortcuts={'add-account':()=>$('#account-dialog').showModal(),'try-demo':()=>action(tryDemo),discover:()=>$('#discover-chats')?.click()};
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-go],[data-copy],[data-act]');if(!target)return;
  if(target.dataset.go)switchTab(target.dataset.go);
  else if(target.dataset.copy)action(()=>copyText($(target.dataset.copy).textContent,target));
  else shortcuts[target.dataset.act]?.();
});
document.addEventListener('keydown',event=>{
  if(event.key!=='/'||event.ctrlKey||event.metaKey||event.altKey||event.target.closest?.('input,textarea,select,[contenteditable]')||document.querySelector('dialog[open]'))return;
  event.preventDefault();switchTab('archive');$('#archive-query').focus();
});
addEventListener('scroll',()=>document.body.classList.toggle('scrolled',scrollY>4),{passive:true});
hydrateIcons();navIndicator($('.nav-list'));
const wizard=createWizard({escape,action,nice,avatar,getState:()=>state,getSelected:()=>selectedAccount,
  select:async id=>{selectedAccount=id;selectedChat=null;sendAttempt=null;await loadChats();renderAccounts();},
  tryDemo,
  getChats:()=>chats,
  openChat:()=>$('#chat-dialog').showModal(),
  discover:async id=>{const data=await api(`/accounts/${id}/discover`,{method:'POST',body:'{}'});if(id===selectedAccount){chats=data.chats;renderAccountPane();}if(data.warnings.length)toast('部分聊天室探索失敗，請確認清單或新增已知 ID。',true);await refresh();return data.chats;},
  enable:async(id,body)=>{try{await api(`/accounts/${id}/local-setup`,{method:'POST',body:JSON.stringify(body)});}finally{await refresh();await loadChats();}},
  // Chats first, so the wizard re-syncs against the saved monitoring selection.
  updateScope:async(id,body)=>{try{await api(`/accounts/${id}/local-setup/scope`,{method:'PUT',body:JSON.stringify(body)});toast('已更新本機 AI 聊天室範圍；設定檔與憑證不變。');}finally{await loadChats();await refresh();}},
  revoke:async id=>{await api(`/accounts/${id}/local-setup`,{method:'DELETE'});await refresh();await loadChats();},
  openAccount:()=>{$('#account-form').elements.kind.value='line';$('#account-dialog').showModal();},
  connect:async qr=>{const a=state.accounts.find(a=>a.id===selectedAccount);if(a.kind==='demo'||!qr)await reconnect();else await login(a.id);},
  go:tab=>{$('#setup-dialog').close();if(tab==='monitoring')monitorAccount=selectedAccount;switchTab(tab);}
});
const dashboard=createDashboard({getState:()=>state,escape});
const archive=createArchive({api,action,escape,when,short,getState:()=>state,openChat:async(id,chat)=>{selectedAccount=id;selectedChat=chat;chatFilter='all';chatAiFilter='all';chatSearch='';sendAttempt=null;switchTab('accounts');await loadChats();renderAccounts();}});
$('#access-ai-instructions').innerHTML=aiInstructionsCard('access-ai-prompt');
$('#account-dialog').addEventListener('cancel',()=>wizard.cancelNewAccount());

async function refresh(){
  if(refreshRunning)return;refreshRunning=true;
  try {
    state=await api('/state');$('#service-error').hidden=true;$('#local-status').classList.remove('offline');$('#local-status-text').textContent='運作中';$('#local-status').title=`本機服務運作中 · ${state.vault}`;
    $('#app-version').textContent=`v${state.version}`;$('#app-version').title=`LineBridge ${state.version}`;$('#app-version').hidden=false;
    const selected=state.accounts.find(a=>a.id===selectedAccount);
    if(selected?.discovery&&observedDiscoveries.get(selected.id)!==selected.discovery.at){
      const next=await api(`/accounts/${selected.id}/chats`);
      if(selected.id===selectedAccount){
        observedDiscoveries.set(selected.id,selected.discovery.at);
        if(JSON.stringify(next)!==JSON.stringify(chats)){
          chats=next;
          chatListRefreshPending=true;
        }
      }
    }
    flushDiscoveredChats();
    renderRefreshSettings();renderAccounts();renderLocalAccess();renderTokens();renderAudit();renderTunnel();renderMonitoring();dashboard.render();archive.render();if($('#setup-dialog').open)wizard.sync();renderAiInstructions($('#access-ai-instructions'),state,null,action);initializeStartup();
    const base=state.tunnel.url || `http://127.0.0.1:${state.gateway.port}`;
    $('#mcp-url').textContent=`${base}/mcp`;$('#api-url').textContent=`${base}/openapi.json`;
    if(selectedAccount&&!state.accounts.some(a=>a.id===selectedAccount)){selectedAccount=null;selectedChat=null;chats=[];renderAccountPane();}
    const a=state.accounts.find(a=>a.id===selectedAccount);if(a){const sequence=a.monitor?.lastSequence || 0,previous=observedSequences.get(a.id),editing=$('#send-form textarea')?.matches(':focus');if(currentPage==='accounts'&&previous!==undefined&&sequence>previous&&selectedChat&&!reading&&!sending&&!editing)await readMessages();if(!reading&&!sending&&!editing&&currentPage==='accounts')observedSequences.set(a.id,sequence);}
    if(currentPage==='monitoring')await refreshMonitorFeed();
  }catch(error){$('#service-error').textContent=`無法連線本機服務：${error.message}`;$('#service-error').hidden=false;$('#local-status').classList.add('offline');$('#local-status-text').textContent='離線';}finally{refreshRunning=false;}
}
$('#refresh').addEventListener('click',()=>action(async()=>{const button=$('#refresh');button.classList.add('busy');try{await refresh();if(selectedAccount)await loadChats();}finally{setTimeout(()=>button.classList.remove('busy'),400);}}));
$('#refresh-interval').addEventListener('input',()=>$('#refresh-settings-form').classList.toggle('dirty',Number($('#refresh-interval').value)!==state?.refresh?.intervalSeconds));
$('#refresh-settings-form').addEventListener('submit',event=>{
  event.preventDefault();action(async()=>{
    const button=$('#save-refresh-settings');button.disabled=true;
    try{const settings=await api('/refresh-settings',{method:'PUT',body:JSON.stringify({intervalSeconds:Number($('#refresh-interval').value)})});state.refresh=settings;renderRefreshSettings();$('#refresh-settings-status').textContent=`已儲存：每 ${settings.intervalSeconds} 秒更新`;toast(`已儲存：每 ${settings.intervalSeconds} 秒更新`);}
    finally{button.disabled=false;}
  });
});
$('#pause').addEventListener('click',()=>action(async()=>{const button=$('#pause');button.disabled=true;try{await api('/pause',{method:'POST',body:JSON.stringify({enabled:!state.gateway.enabled})});await refresh();}finally{button.disabled=false;}}));
function renderAccounts(){
  $('#account-count').textContent=state.accounts.length;
  const signature=JSON.stringify([selectedAccount,state.accounts.map(a=>[a.id,a.label,a.profile?.displayName,a.kind,a.status,a.accountHealth?.status,a.designatedChats])]);
  if(signature!==accountOptions){
  accountOptions=signature;
  $('#account-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<button class="account-item ${selectedAccount===a.id?'selected':''}" data-account="${escape(a.id)}">${avatar(accountName(a),a.id,'',`<span class="presence ${presence(a)}"></span>`)}<span class="account-info"><strong>${escape(accountName(a))}</strong><small>${a.kind==='demo'?'沙盒':escape(accountStatus(a))} · AI ${a.designatedChats}</small></span></button>`).join(''):'<p class="pane-empty">尚無帳號</p>';
  document.querySelectorAll('[data-account]').forEach(e=>e.addEventListener('click',()=>action(async()=>{selectedAccount=e.dataset.account;selectedChat=null;sendAttempt=null;await loadChats();renderAccounts();})));
  }
  if(selectedAccount){const a=state.accounts.find(a=>a.id===selectedAccount);if(a){const el=$('#selected-status');if(el)el.innerHTML=statusBadge(a);renderAccountHealth(a);renderDiscoveryNotice(a);renderAutoMonitorSetting(a);}}
}
function renderDiscoveryNotice(account){
  const el=$('#discovery-notice');if(!el)return;
  const d=account.discovery,s=d?.stages ?? {},failed=['groups','direct','openchat'].filter(k=>s[k]&&(s[k].status==='failed'||s[k].status==='partial'));
  // Successful discovery is visible in the list itself; only problems need words.
  el.hidden=!d||(!failed.length&&!d.warnings.length);
  if(!el.hidden)el.textContent=failed.length?failed.map(k=>`${k==='openchat'?'OpenChat':k==='direct'?'一對一':'群組'}${s[k].status==='partial'?'只探索到部分':`探索失敗（${s[k].errorCode}）`}`).join(' · '):d.warnings.join(' ');
}
async function loadChats(){const id=selectedAccount;const result=await api(`/accounts/${id}/chats`);if(id!==selectedAccount)return;chats=result;observedDiscoveries.set(id,state?.accounts.find(a=>a.id===id)?.discovery?.at);if(selectedChat&&!chats.some(c=>c.id===selectedChat))selectedChat=null;renderAccountPane();if(selectedChat)await readMessages();}
function renderAccountPane(){
  chatListRefreshPending=false;
  const a=state?.accounts.find(a=>a.id===selectedAccount);if(!a){$('#chat-pane').innerHTML=`<div class="empty"><span class="empty-icon">${icon('chats')}</span><h3>${state?.accounts.length?'選擇帳號':'連接第一個帳號'}</h3><p>${state?.accounts.length?'從左側選擇帳號以查看聊天室。':'掃描 QR Code 連接 LINE，或先用沙盒體驗。'}</p>${state?.accounts.length?'':`<div class="btn-row"><button class="btn primary" data-act="add-account">${icon('plus')}新增帳號</button><button class="btn" data-act="try-demo">${icon('flask')}試用沙盒</button></div>`}</div>`;return;}
  const actions=[
    a.status!=='connected'&&a.kind==='line'&&a.canResume?'<button class="btn sm" id="resume-account">恢復工作階段</button>':'',
    a.status!=='connected'?`<button class="btn sm ${a.kind==='line'&&a.canResume?'':'primary'}" id="connect-account">${a.kind==='demo'?'重新連線':`${icon('qr')}掃描 QR Code`}</button>`:`<button class="btn sm" id="disconnect-account">${icon('power')}中斷連線</button>`,
    `<button class="icon-btn danger" id="remove-account" aria-label="移除帳號" title="移除帳號">${icon('trash')}</button>`
  ].join('');
  $('#chat-pane').innerHTML=`<div class="account-head">${avatar(accountName(a),a.id,'lg')}<div class="account-title"><h2>${escape(accountName(a))} <span id="selected-status">${statusBadge(a)}</span></h2><p>${a.kind==='demo'?'模擬資料，不連線 LINE':`${escape(nice(a.device))} · 驗證於 <span id="account-last-checked">${escape(short(a.lastChecked))}</span>`}</p></div><div class="account-actions">${actions}</div></div><div class="note warn account-error" id="account-health-notice" hidden></div><div class="chat-layout"><div class="chat-col"><div class="chat-tools"><div class="input-icon">${icon('search')}<label class="sr-only" for="chat-search">搜尋聊天室名稱或 ID</label><input id="chat-search" type="search" placeholder="搜尋聊天室" value="${escape(chatSearch)}"></div><button class="icon-btn" id="discover-chats" aria-label="探索聊天室" title="探索聊天室" ${a.status!=='connected'?'disabled':''}>${icon('refresh')}</button><button class="icon-btn" id="add-chat" aria-label="新增已知聊天室 ID" title="新增已知聊天室 ID">${icon('plus')}</button><select id="chat-filter" class="compact" aria-label="聊天室類型">${['all','group','direct','openchat'].map(kind=>`<option value="${kind}" ${chatFilter===kind?'selected':''}>${filterLabel(kind)}</option>`).join('')}</select><span class="badge good" title="開放給 AI 的聊天室">AI · ${chats.filter(c=>c.enabled).length}</span></div><div class="chat-sub"><span id="chat-search-count" role="status" aria-live="polite"></span></div><div class="note warn discovery-notice" id="discovery-notice" hidden></div><div class="chat-list" id="chat-list"></div></div><div class="chat-reader" id="reader">${selectedChat?readerLoading():`<div class="reader-placeholder">${icon('chat')}<span>選擇聊天室以查看訊息</span></div>`}</div></div>`;
  $('#account-health-notice').insertAdjacentHTML('afterend',`<div class="account-settings"><label class="toggle-card"><input type="checkbox" class="switch" id="account-auto-monitor" aria-describedby="account-auto-monitor-help"><span><strong>自動加入新聊天室</strong><small id="account-auto-monitor-help"></small></span></label><button class="btn sm" id="account-setup" data-go="setup">設定精靈</button></div>`);
  $('.chat-sub').insertAdjacentHTML('afterbegin',`<select id="chat-ai-filter" class="compact" aria-label="AI 監控篩選">${['monitored','unmonitored','all'].map(value=>`<option value="${value}" ${chatAiFilter===value?'selected':''}>${aiFilterLabel(value)}</option>`).join('')}</select>`);
  renderAccountHealth(a);renderDiscoveryNotice(a);renderAutoMonitorSetting(a);
  $('#account-auto-monitor').addEventListener('change',event=>action(()=>saveAutoMonitorSetting(a.id,event.target.checked)));
  $('#connect-account')?.addEventListener('click',()=>action(()=>a.kind==='demo'?reconnect():login(a.id)));
  $('#resume-account')?.addEventListener('click',()=>action(reconnect));
  $('#disconnect-account')?.addEventListener('click',()=>action(async()=>{await api(`/accounts/${a.id}/disconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}));
  $('#remove-account').addEventListener('click',()=>action(async()=>{if(!confirm(`移除「${accountName(a)}」？登入憑證與封存訊息都會刪除。`))return;await api(`/accounts/${a.id}`,{method:'DELETE'});selectedAccount=null;selectedChat=null;chats=[];await refresh();renderAccountPane();}));
  $('#discover-chats').addEventListener('click',()=>action(async()=>{const button=$('#discover-chats');button.disabled=true;button.classList.add('busy');try{const result=await api(`/accounts/${a.id}/discover`,{method:'POST',body:'{}'});chats=result.chats;toast(`找到 ${chats.length} 個聊天室${result.warnings.length?'（部分探索失敗）':''}`,!!result.warnings.length);await refresh();renderAccountPane();}finally{button.disabled=a.status!=='connected';button.classList.remove('busy');}}));
  $('#chat-filter').addEventListener('change',event=>{chatFilter=event.target.value;renderChatList();});
  $('#chat-ai-filter').addEventListener('change',event=>{chatAiFilter=event.target.value;renderChatList();});
  $('#add-chat').addEventListener('click',()=>$('#chat-dialog').showModal());
  $('#chat-search').addEventListener('input',event=>{chatSearch=event.target.value;renderChatList();});
  renderChatList();
}
function renderAutoMonitorSetting(a){
  const toggle=$('#account-auto-monitor');if(!toggle||!a)return;
  const active=!!a.localSetup?.grantActive,mismatch=active&&a.localSetup.selectionChanged===true;
  if(!savingAutoMonitor.has(a.id))toggle.checked=active&&a.localSetup.autoMonitorNewChats===true;
  toggle.disabled=!active||savingAutoMonitor.has(a.id);
  $('#account-auto-monitor-help').textContent=active?`監聽時每 ${state.refresh?.intervalSeconds??15} 秒探索；新聊天室會自動開放 AI 讀取與傳送並封存。關閉後保留已加入的聊天室。${mismatch?' 監控中的聊天室與本機 AI 授權範圍不一致，請用設定精靈確認並更新範圍。':''}`:'先完成設定精靈並啟用本機 AI，即可自動加入新聊天室。';
  $('#account-setup').hidden=active&&!mismatch;
}
async function saveAutoMonitorSetting(id,enabled){
  if(savingAutoMonitor.has(id))return;
  savingAutoMonitor.add(id);
  const account=state.accounts.find(a=>a.id===id);
  if(id===selectedAccount)renderAutoMonitorSetting(account);
  try{
    const setup=await api(`/accounts/${id}/local-setup`,{method:'PATCH',body:JSON.stringify({autoMonitorNewChats:enabled})});
    const current=state.accounts.find(a=>a.id===id);if(current)current.localSetup=setup;
    toast(enabled?'已開啟自動加入新聊天室':'已關閉自動加入新聊天室');
    await refresh();
  }finally{
    savingAutoMonitor.delete(id);
    const current=state.accounts.find(a=>a.id===id);if(current&&id===selectedAccount)renderAutoMonitorSetting(current);
  }
}
function readerLoading(){return '<div class="reader-loading" aria-label="正在讀取訊息"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>';}
function flushDiscoveredChats(){
  if(!chatListRefreshPending||currentPage!=='accounts'||reading||sending)return;
  if(!$('#chat-list')||!state?.accounts.some(a=>a.id===selectedAccount))return;
  // Discovery changes the sidebar only. Preserve the open reader, draft and
  // send intent, even while typing. Keep pending updates until requests finish.
  const filter=$('#chat-filter');
  for(const option of filter?.options??[])option.textContent=filterLabel(option.value);
  renderChatList();chatListRefreshPending=false;
}
function filterLabel(kind){return `${kind==='all'?'全部':nice(kind)} (${chats.filter(c=>kind==='all'||c.kind===kind).length})`;}
function aiFilterLabel(value){return `${value==='all'?'所有聊天室':value==='monitored'?'AI 監控':'非 AI 監控'} (${chats.filter(c=>value==='all'||!!c.enabled===(value==='monitored')).length})`;}
function renderChatMonitoring(){
  const chat=chats.find(c=>c.id===selectedChat),toggle=$('#toggle-chat-monitor'),status=$('#chat-monitor-status');
  if(!chat||!toggle||!status)return;
  status.textContent=chat.enabled?'AI監控中':'AI未監控';status.classList.toggle('on',!!chat.enabled);
  toggle.setAttribute('aria-checked',String(!!chat.enabled));toggle.title=chat.enabled?'停用 AI 監控':'啟用 AI 監控';
  toggle.disabled=savingChatMonitoring.has(`${selectedAccount}\n${chat.id}`);
}
async function saveChatMonitoring(accountId,chatId,enabled){
  const key=`${accountId}\n${chatId}`;if(savingChatMonitoring.has(key))return;
  savingChatMonitoring.add(key);
  if(accountId===selectedAccount){renderChatList();renderChatMonitoring();}
  try{
    const result=await toggleChatAccess({accountId,chatId,enabled,fetcher:sessionFetch,onState:saved=>{
      if(accountId===selectedAccount){const chat=chats.find(c=>c.id===chatId);if(chat)chat.enabled=saved.chat.enabled?1:0;renderChatList();renderChatMonitoring();}
    }});
    if(result.saved)toast('監控與本機 AI 授權已儲存；LINE 接收狀態請另看監控健康度。');
  }catch(error){
    // A toggle only extends an existing managed profile; before setup, open the wizard.
    if(error.code==='managed_setup_required')openSetup();
    throw error;
  }finally{
    savingChatMonitoring.delete(key);
    if(accountId===selectedAccount){renderChatList();renderChatMonitoring();}
  }
}
function renderChatList(){
  const target=$('#chat-list'),a=state?.accounts.find(a=>a.id===selectedAccount);if(!target||!a)return;
  const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase();
  const terms=normalize(chatSearch).trim().split(/\s+/).filter(Boolean);
  const visibleChats=chats.filter(c=>(chatAiFilter==='all'||!!c.enabled===(chatAiFilter==='monitored'))&&(chatFilter==='all'||c.kind===chatFilter)&&terms.every(term=>normalize(chatName(c)+' '+c.id).includes(term)));
  for(const option of $('#chat-ai-filter')?.options??[])option.textContent=aiFilterLabel(option.value);
  const count=$('.chat-tools .badge');if(count)count.textContent=`AI · ${chats.filter(c=>c.enabled).length}`;
  // The default view lists monitored rooms only; say where the others are.
  const hint=chatAiFilter==='monitored'&&chats.some(c=>!c.enabled)?' · 切換到「非 AI 監控」以新增聊天室':chats.length&&!chats.some(c=>c.enabled)?' · 點選「未監控」以啟用 AI 監控':'';
  $('#chat-search-count').textContent=`${visibleChats.length===chats.length?'':`${visibleChats.length} / `}${chats.length} 個聊天室${hint}`;
  target.innerHTML=visibleChats.length?visibleChats.map(c=>`<div class="chat-item ${selectedChat===c.id?'selected':''}" data-chat="${escape(c.id)}" role="button" tabindex="0">${avatar(chatName(c),c.id,'sm')}<div class="chat-item-main"><strong>${escape(chatName(c))}</strong><small>${escape(c.kind==='openchat'?'OpenChat · 實驗性':nice(c.kind))}</small></div><label class="ai-toggle" title="${c.enabled?'停用 AI 監控':'啟用 AI 監控'}"><input type="checkbox" data-designate="${escape(c.id)}" aria-label="AI 監控：${escape(chatName(c))}" ${c.enabled?'checked':''} ${savingChatMonitoring.has(`${a.id}\n${c.id}`)?'disabled':''}><span>${c.enabled?'AI':'未監控'}</span></label></div>`).join(''):chats.length?'<div class="list-empty">沒有符合的聊天室<button class="link-btn" id="clear-chat-search">清除篩選</button></div>':`<div class="list-empty">尚無聊天室<button class="btn sm" data-act="discover" ${a.status!=='connected'?'disabled':''}>探索聊天室</button></div>`;
  $('#clear-chat-search')?.addEventListener('click',()=>{chatSearch='';chatFilter='all';chatAiFilter='all';$('#chat-search').value='';$('#chat-filter').value='all';$('#chat-ai-filter').value='all';renderChatList();$('#chat-search').focus();});
  target.querySelectorAll('[data-chat]').forEach(el=>{const select=()=>action(async()=>{if(reading||sending)return;selectedChat=el.dataset.chat;sendAttempt=null;renderChatList();$('#reader').innerHTML=readerLoading();await readMessages();});el.addEventListener('click',event=>{if(!event.target.closest('label'))select();});el.addEventListener('keydown',event=>{if(event.target===el&&(event.key==='Enter'||event.key===' ')){event.preventDefault();select();}});});
  target.querySelectorAll('[data-designate]').forEach(el=>el.addEventListener('change',()=>action(()=>saveChatMonitoring(a.id,el.dataset.designate,el.checked))));
}
// Stable avatar tones make long chat and account lists easier to scan.
function avatar(name,id,size='',extra=''){
  let hash=7;for(const c of String(id??name))hash=(hash*31+c.codePointAt(0))>>>0;
  return `<span class="avatar ${size} tone-${hash%6}" aria-hidden="true">${escape(Array.from(String(name||'?'))[0])}${extra}</span>`;
}
async function reconnect(){await api(`/accounts/${selectedAccount}/reconnect`,{method:'POST',body:'{}'});await refresh();await loadChats();}
function renderOverview(){
  const lines=state.accounts.filter(a=>a.kind==='line'),demos=state.accounts.length-lines.length;
  $('#metric-accounts').textContent=lines.filter(a=>a.status==='connected').length;
  $('#metric-account-detail').textContent=`LINE ${lines.length}${demos?` · 沙盒 ${demos}`:''}`;
  const local=state.gateway.authentication==='local',localAccounts=state.accounts.filter(a=>a.designatedChats&&(a.localAccess?.read||a.localAccess?.send));
  $('#metric-tokens').textContent=local?'免權杖':state.tokens.filter(t=>!t.revoked&&Date.parse(t.expires_at)>Date.now()).length;
  $('#metric-access-detail').textContent=local?`本機 · ${localAccounts.length} 個帳號`:'有效權杖';
  const tunnel=$('#metric-tunnel');tunnel.textContent=state.tunnel.connected?'已連線':'未連線';tunnel.className=state.tunnel.connected?'good':'muted';
  $('#metric-tunnel-detail').textContent=providerName(state.tunnel.provider);
  const gateway=$('#metric-gateway');gateway.textContent=state.gateway.enabled?'可使用':'已暫停';gateway.className=state.gateway.enabled?'good':'warn';
  $('#pause').setAttribute('aria-checked',String(state.gateway.enabled));$('#pause').title=state.gateway.enabled?'暫停 AI 存取':'恢復 AI 存取';
}
function renderMonitoring(){
  if(!state)return;
  renderOverview();
  if(!state.accounts.some(a=>a.id===monitorAccount)){monitorAccount=selectedAccount || state.accounts[0]?.id || null;monitorVersion='';}
  const options=JSON.stringify(state.accounts.map(a=>[a.id,accountName(a)]));
  if(options!==monitorOptions){$('#monitor-account').innerHTML=state.accounts.length?state.accounts.map(a=>`<option value="${escape(a.id)}">${escape(accountName(a))}${a.kind==='demo'?' · 沙盒':''}</option>`).join(''):'<option value="">尚無帳號</option>';monitorOptions=options;}
  $('#monitor-account').value=monitorAccount || '';$('#monitor-account').disabled=!state.accounts.length;
  const a=state.accounts.find(a=>a.id===monitorAccount),m=a?.monitor ?? {enabled:false,status:'off',storedMessages:0};
  const toggle=$('#toggle-monitor');toggle.setAttribute('aria-checked',String(!!m.enabled));toggle.disabled=!a||(!m.enabled&&a.status!=='connected');
  const live=a&&m.enabled&&a.status==='connected',facts=a?[nice(a.status==='connected'?m.status:m.enabled?'disconnected':'off'),`${a.designatedChats} 個聊天室`,...(a.localSetup?.grantActive&&a.localSetup.autoMonitorNewChats?['自動加入新聊天室']:[]),`已存 ${(m.storedMessages || 0).toLocaleString('zh-TW')} 則`,...(m.lastMessage?[`最新 ${short(m.lastMessage)}`]:[])]:[];
  $('#monitor-detail').innerHTML=a?`<span class="dot ${live?'good live':m.enabled?'warn':''}"></span>${escape(facts.join(' · '))}`:'';
  const streams=Array.isArray(m.streams)?m.streams:Object.values(m.streams ?? {});
  const healthLabel={healthy:'正常',stale:`超過 ${(m.staleAfterMs??75000)/1000} 秒未成功`,waiting:'等待首次成功',initializing:'同步中',retrying:'重試中',disconnected:'帳號未連線',off:'已停止',sandbox:'沙盒',no_chats:'尚未開放聊天室'};
  $('#monitor-streams').innerHTML=a?streams.map(s=>{const kind=s.health==='healthy'?'good':['stale','retrying','disconnected'].includes(s.health)?'warn':'',tip=[`最後成功：${s.lastSuccessAt?when(s.lastSuccessAt):s.channel==='demo'?'沙盒不輪詢 LINE':'尚無紀錄'}`,...(s.lastAttemptAt?[`最後嘗試：${when(s.lastAttemptAt)}`]:[]),...(s.channel!=='talk'&&s.channel!=='demo'?[s.channel]:[])].join('\n');return `<span class="stream" title="${escape(tip)}"><span class="dot ${kind}${kind==='good'?' live':''}"></span>${escape(s.channel==='demo'?'沙盒模式':`${s.channel==='talk'?'一對一與群組':'OpenChat'} · ${healthLabel[s.health]||nice(s.status)}`)}</span>`;}).join('')||`<span class="stream"><span class="dot"></span>${escape(healthLabel[m.health]||'尚未開始輪詢')}</span>`:'';
  if(!a){feedAccount=null;$('#monitor-feed').innerHTML=`<div class="empty"><span class="empty-icon">${icon('pulse')}</span><h3>尚未連接帳號</h3><p>完成設定後，新訊息會出現在這裡。</p><div class="btn-row"><button class="btn primary" data-go="setup">開始設定</button></div></div>`;}
}
async function refreshMonitorFeed(force=false){
  const id=monitorAccount,a=state?.accounts.find(a=>a.id===id);if(!a||monitorReading)return;
  const version=JSON.stringify([id,a.monitor?.lastSequence,a.designatedChats,a.status]);if(!force&&version===monitorVersion)return;
  monitorReading=true;
  try{
    const after=Math.max(0,(a.monitor?.lastSequence || 0)-100);
    const [data,rooms]=await Promise.all([api(`/accounts/${id}/events?after=${after}&limit=100`),api(`/accounts/${id}/chats`)]);
    if(id!==monitorAccount)return;
    // Animate only messages that arrive while the feed is open.
    const first=feedAccount!==id;if(first){feedAccount=id;seenEvents.clear();}
    const list=data.events.slice().reverse(),feed=$('#monitor-feed');
    feed.classList.toggle('stagger',first);
    feed.innerHTML=list.length?list.map(event=>{const chat=rooms.find(c=>c.id===event.chatId),message=event.message,name=senderName(message,a,chat),at=message.timestamp || event.receivedAt;return `<article class="feed-item${!first&&!seenEvents.has(event.sequence)?' fresh':''}">${avatar(name,message.senderId||name)}<div class="feed-main"><div class="feed-top"><strong>${escape(name)}</strong><button class="feed-chat" data-open-chat="${escape(event.chatId)}">${escape(chatName(chat))}</button><time title="${escape(when(at))}">${escape(short(at))}</time></div><p class="feed-text${message.unavailableReason?' muted':''}">${escape(message.unavailableReason?'無法解密此訊息':message.text || `[${message.contentType || '非文字'} 訊息]`)}</p></div></article>`;}).join(''):`<div class="empty"><span class="empty-icon">${icon('inbox')}</span><h3>${a.monitor?.enabled?'等待新訊息':'尚無訊息'}</h3><p>${a.kind==='demo'?'到沙盒聊天室傳送訊息試試看。':a.monitor?.enabled?'新訊息會即時出現在這裡。':'開啟監聽以接收開放聊天室的新訊息。'}</p></div>`;
    list.forEach(event=>seenEvents.add(event.sequence));
    feed.querySelectorAll('[data-open-chat]').forEach(el=>el.addEventListener('click',()=>action(async()=>{selectedAccount=id;selectedChat=el.dataset.openChat;chatFilter='all';chatAiFilter='all';chatSearch='';sendAttempt=null;switchTab('accounts');await loadChats();renderAccounts();})));
    monitorVersion=version;
  }catch(error){if(id===monitorAccount)$('#monitor-feed').innerHTML=`<div class="empty"><span class="empty-icon">${icon('alert')}</span><h3>暫時無法讀取收件匣</h3><p>${escape(error.message)}</p></div>`;}
  finally{monitorReading=false;}
}
$('#monitor-account').addEventListener('change',()=>{monitorAccount=$('#monitor-account').value;monitorVersion='';$('#monitor-feed').innerHTML='<div class="empty"><span class="spinner"></span></div>';renderMonitoring();action(()=>refreshMonitorFeed(true));});
$('#toggle-monitor').addEventListener('click',()=>action(async()=>{const a=state.accounts.find(a=>a.id===monitorAccount);if(!a)return;const toggle=$('#toggle-monitor');toggle.disabled=true;toggle.setAttribute('aria-checked',String(!a.monitor?.enabled));try{await api(`/accounts/${a.id}/monitor`,{method:'POST',body:JSON.stringify({enabled:!a.monitor?.enabled})});await refresh();toast(state.accounts.find(account=>account.id===a.id)?.monitor.enabled?'已開始監聽':'已停止監聽');}finally{renderMonitoring();}}));
async function readMessages(){
  const accountId=selectedAccount,chatId=selectedChat,chat=chats.find(c=>c.id===chatId),a=state.accounts.find(a=>a.id===accountId);if(!chat)return;
  if(reading)return;reading=true;const draft=$('#send-form textarea')?.value ?? '';
  try{
    const data=await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`);
    if(accountId!==selectedAccount||chatId!==selectedChat)return;
    const key=`${accountId}\n${chatId}`,first=readerChat!==key;if(first){readerChat=key;seenMessages.clear();chatInfoOpen=false;}
    let previous=null,lastDay='';
    const bubbles=data.messages.map(m=>{
      const mine=m.senderId===a.profile?.mid,stamp=m.timestamp?new Date(m.timestamp):null,day=stamp?stamp.toLocaleDateString('zh-TW',{timeZone:zone,month:'long',day:'numeric',weekday:'short'}):'';
      const divider=day&&day!==lastDay?`<div class="day">${escape(day)}</div>`:'';if(day)lastDay=day;
      const grouped=!divider&&previous&&previous.sender===m.senderId&&stamp&&previous.stamp&&stamp-previous.stamp<300000;previous={sender:m.senderId,stamp};
      const time=stamp?stamp.toLocaleTimeString('zh-TW',{timeZone:zone,hour12:false,hour:'2-digit',minute:'2-digit'}):'時間未知';
      return `${divider}<div class="msg${mine?' mine':''}${grouped?' cont':''}${!first&&m.id&&!seenMessages.has(m.id)?' fresh':''}">${grouped?'':`<div class="msg-meta">${mine?'':`${escape(senderName(m,a,chat))} · `}${escape(time)}</div>`}<div class="msg-bubble${m.unavailableReason?' unavailable':''}">${escape((m.unavailableReason?'無法解密此訊息':m.text)||`[${m.contentType} 訊息]`)}</div></div>`;
    }).join('');
    data.messages.forEach(m=>m.id&&seenMessages.add(m.id));
    const demo=a.kind==='demo',seal=chat.kind==='openchat'?'OpenChat 使用 LINE 傳輸加密。':'支援時使用 Letter Sealing；僅在 LINE 要求時使用標準傳輸加密。';
    $('#reader').innerHTML=`<div class="reader-head">${avatar(chatName(chat),chat.id)}<div class="reader-title"><strong>${escape(chatName(chat))}</strong><span class="reader-meta">${escape(chat.kind==='openchat'?'OpenChat · 實驗性':nice(chat.kind))} · <span id="chat-monitor-status" class="${chat.enabled?'on':''}">${chat.enabled?'AI監控中':'AI未監控'}</span></span></div><div class="reader-actions"><button type="button" class="switch" id="toggle-chat-monitor" role="switch" aria-label="AI 監控" aria-checked="${!!chat.enabled}"></button><button class="icon-btn" id="search-chat-messages" aria-label="搜尋封存" title="搜尋封存">${icon('search')}</button><button class="icon-btn" id="refresh-messages" aria-label="重新整理訊息" title="重新整理">${icon('refresh')}</button><button class="icon-btn" id="chat-info" aria-label="聊天室 ID" title="聊天室 ID" aria-controls="chat-info-panel" aria-expanded="${chatInfoOpen}">${icon('info')}</button></div></div><div class="reader-id" id="chat-info-panel" ${chatInfoOpen?'':'hidden'}><code id="chat-id-value">${escape(chatId)}</code><button class="icon-btn sm" data-copy="#chat-id-value" aria-label="複製聊天室 ID" title="複製">${icon('copy')}</button></div><div class="message-list${first?' enter':''}"><p class="coverage">${escape(coverage(data.coverage))}</p>${bubbles||'<p class="reader-empty">尚無文字訊息</p>'}</div><div id="send-feedback" class="note warn" role="status" hidden></div><form class="compose" id="send-form">${demo?'':`<span class="compose-lock" title="${escape(seal)}" aria-label="${escape(seal)}" role="img">${icon('lock')}</span>`}<textarea name="text" rows="1" maxlength="5000" required placeholder="${demo?'傳送到沙盒':'輸入訊息，將傳送到 LINE'}" aria-label="訊息內容"></textarea><button class="send-btn" type="submit" aria-label="${demo?'傳送到沙盒':'傳送到 LINE'}" title="傳送（Ctrl+Enter）">${icon('send')}</button></form>`;
    renderChatMonitoring();
    $('#toggle-chat-monitor').addEventListener('click',()=>action(()=>{const current=chats.find(c=>c.id===chatId);if(current)return saveChatMonitoring(accountId,chatId,!current.enabled);}));
    $('#search-chat-messages').addEventListener('click',()=>action(async()=>{switchTab('archive');await archive.open(accountId,chatId);}));
    $('#refresh-messages').addEventListener('click',()=>action(readMessages));
    $('#chat-info').addEventListener('click',()=>{chatInfoOpen=!chatInfoOpen;$('#chat-info-panel').hidden=!chatInfoOpen;$('#chat-info').setAttribute('aria-expanded',String(chatInfoOpen));});
    const list=$('.message-list');list.scrollTop=list.scrollHeight;
    const textarea=$('#send-form textarea');textarea.value=draft;
    textarea.addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();$('#send-form').requestSubmit();}});
    $('#send-form').addEventListener('submit',event=>{
      event.preventDefault();const form=event.currentTarget;
      if(sending)return;
      sending=true;
      action(async()=>{
        const text=form.elements.text.value,button=form.querySelector('button'),feedback=$('#send-feedback');
        button.disabled=true;button.classList.add('sending');feedback.hidden=true;
        try{
          const intent=await prepareSendIntent(sendAttempt,accountId,chatId,text,{
            capability:()=>demo||chat.kind!=='direct'?Promise.resolve({officialAccount:false}):api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/text-capability`),
            confirm:()=>accountId===selectedAccount&&chatId===selectedChat&&form.elements.text.value===text&&window.confirm(`這是 LINE 官方帳號。此則訊息僅使用傳輸加密，不使用 Letter Sealing（端對端加密）。

收件者：${chatName(chat)}
${chatId}

${text}

同意傳送這一則訊息？`)
          });
          if(!intent||accountId!==selectedAccount||chatId!==selectedChat||form.elements.text.value!==text)return;
          sendAttempt=intent;
          const result=await api(`/accounts/${accountId}/chats/${encodeURIComponent(chatId)}/messages`,{method:'POST',body:JSON.stringify({text,idempotencyKey:sendAttempt.key,...(sendAttempt.acknowledgeOaTransport?{acknowledgeOaTransport:true}:{})})});
          sendAttempt=null;form.elements.text.value='';toast(result.delivery==='sandbox_only'?'已傳送到沙盒':'已送出');await readMessages();await refresh();
        }catch(error){
          if(['send_preparation_failed','line_send_rejected','oa_transport_acknowledgment_required','send_authorization_revoked'].includes(error.code))sendAttempt=null;
          feedback.textContent=error.message;feedback.hidden=false;throw error;
        }finally{button.disabled=false;button.classList.remove('sending');sending=false;flushDiscoveredChats();}
      });
    });
  }catch(error){if(accountId===selectedAccount&&chatId===selectedChat)$('#reader').innerHTML=`<div class="reader-placeholder">${icon('alert')}<span>${escape(error.message)}</span></div>`;}finally{reading=false;flushDiscoveredChats();}
}

$('#add-account').addEventListener('click',()=>$('#account-dialog').showModal());
$('#account-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;try{const body=Object.fromEntries(new FormData(form));const a=await api('/accounts',{method:'POST',body:JSON.stringify(body)});$('#account-dialog').close();form.reset();selectedAccount=a.id;selectedChat=null;sendAttempt=null;await refresh();await loadChats();wizard.accountAdded();if(a.kind==='line')await login(a.id);}finally{button.disabled=false;}});});
async function tryDemo(){const existing=state?.accounts.find(a=>a.kind==='demo');if(existing){selectedAccount=existing.id;if(existing.status!=='connected')await api(`/accounts/${existing.id}/reconnect`,{method:'POST',body:'{}'});}else{const a=await api('/accounts',{method:'POST',body:JSON.stringify({label:'沙盒帳號',kind:'demo',device:'IOSIPAD'})});selectedAccount=a.id;}selectedChat=null;sendAttempt=null;await refresh();await loadChats();toast('已開啟沙盒，使用模擬資料');}
$('#try-demo').addEventListener('click',()=>action(tryDemo));
$('#chat-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const chat=await api(`/accounts/${selectedAccount}/chats`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))});$('#chat-dialog').close();$('#chat-form').reset();await loadChats();if($('#setup-dialog').open)wizard.chatAdded(chat.id);});});
async function login(id){await api(`/accounts/${id}/login`,{method:'POST',body:'{}'});loginAccount=id;loginView='';$('#login-content').innerHTML='<div class="login-wait"><span class="spinner"></span><p>正在取得 QR Code…</p></div>';$('#login-dialog').showModal();clearInterval(loginTimer);loginTimer=setInterval(()=>{void pollLogin();},1500);await pollLogin();}
async function pollLogin(){
  if(!loginAccount)return;
  try{const data=await api(`/accounts/${loginAccount}/login`),view=JSON.stringify([data.qr,data.pin,data.status]);
    // Polling repeats every 1.5 s; redraw only when the QR, PIN or status changes.
    if(view!==loginView){loginView=view;$('#login-content').innerHTML=data.qr?`<div class="qr"><img src="${escape(data.qr)}" alt="LINE 登入 QR Code"><span class="qr-scan" aria-hidden="true"></span></div>${data.pin?`<p class="pin-label">請在手機確認此 PIN</p><strong class="pin">${escape(data.pin)}</strong>`:''}`:`<div class="login-wait"><span class="spinner"></span><p>${escape(nice(data.status))}</p></div>`;}
    if(data.status==='connected'){clearInterval(loginTimer);loginAccount=null;$('#login-dialog').close();toast('LINE 帳號已連線');await refresh();await loadChats();}
    else if(data.status==='error') {clearInterval(loginTimer);loginView='error';$('#login-content').innerHTML=`<div class="login-wait error">${icon('alert')}<p>登入失敗或已過期，請取消後重試。</p></div>`;await refresh();}
  }catch(error){toast(error.message,true);clearInterval(loginTimer);}
}
async function cancelLogin(){clearInterval(loginTimer);if(loginAccount)await api(`/accounts/${loginAccount}/disconnect`,{method:'POST',body:'{}'});loginAccount=null;$('#login-dialog').close();await refresh();if(selectedAccount)await loadChats();}
$('#cancel-login').addEventListener('click',()=>action(cancelLogin));$('#close-login').addEventListener('click',()=>action(cancelLogin));$('#login-dialog').addEventListener('cancel',event=>{event.preventDefault();action(cancelLogin);});

function renderTokens(){
  const accountLabel=id=>state.accounts.find(a=>a.id===id)?.label||'已移除帳號';
  $('#token-list').innerHTML=state.tokens.length?state.tokens.map(t=>{const expired=Date.parse(t.expires_at)<=Date.now(),active=!t.revoked&&!expired,managed=t.grants.some(g=>g.localOnly);return `<div class="token${active?'':' inactive'}"><span class="token-icon">${icon('key')}</span><div class="token-main"><div class="token-title"><strong>${escape(t.name)}</strong>${badge(t.revoked?'已撤銷':expired?'已過期':'有效',active?'good':'')}</div><div class="token-grants">${t.grants.map(g=>`<span class="chip">${escape(accountLabel(g.accountId))} · ${[g.read?'讀取':null,g.send?'傳送':null].filter(Boolean).join(' + ')} · ${managed?'本機 AI 設定':escape(scopeText(g))}</span>`).join('')}</div><small>到期 ${escape(short(t.expires_at))} · 上次使用 ${escape(short(t.last_used))}</small></div>${active?`<div class="token-actions">${managed?'':`<button class="btn sm" data-token-scope="${escape(t.id)}">編輯範圍</button>`}<button class="btn sm danger" data-revoke="${escape(t.id)}">撤銷</button></div>`:''}</div>`;}).join(''):`<div class="empty compact"><span class="empty-icon">${icon('key')}</span><h3>尚無權杖</h3><p>建立權杖並啟動雲端連線，即可授權雲端 AI。</p></div>`;
  document.querySelectorAll('[data-revoke]').forEach(e=>e.addEventListener('click',()=>action(async()=>{await api(`/tokens/${e.dataset.revoke}`,{method:'DELETE'});toast('權杖已撤銷');await refresh();})));
  document.querySelectorAll('[data-token-scope]').forEach(e=>e.addEventListener('click',()=>action(()=>openTokenScope(e.dataset.tokenScope))));
}
// Chats the token may list: designated chats, plus undesignated chats it already
// lists (which can only be removed). Each account keeps its current mode until changed.
let scopeToken=null,scopeChats=new Map();
async function openTokenScope(id){
  const token=state.tokens.find(t=>t.id===id);if(!token)throw new Error('找不到權杖；請重新整理。');
  scopeChats=new Map(await Promise.all(token.grants.map(async g=>[g.accountId,state.accounts.some(a=>a.id===g.accountId)?await api(`/accounts/${encodeURIComponent(g.accountId)}/chats`):[]])));
  scopeToken=token;$('#token-scope-name').textContent=`權杖：${token.name}`;
  $('#token-scope-list').innerHTML=token.grants.map(g=>{
    const account=state.accounts.find(a=>a.id===g.accountId),chats=(scopeChats.get(g.accountId)??[]).filter(c=>c.enabled||g.chatIds?.includes(c.id));
    const checked=c=>g.chatIds?g.chatIds.includes(c.id):!!c.enabled;
    return `<div class="token-scope-account" data-scope-account="${escape(g.accountId)}"><div class="grant-row"><div><strong>${escape(account?accountName(account):'已移除帳號')}</strong><small>${chats.filter(c=>c.enabled).length} 個開放聊天室</small></div><div class="grant-options"><label class="switch-label"><input type="checkbox" class="switch" name="read" ${g.read?'checked':''}>讀取</label><label class="switch-label"><input type="checkbox" class="switch" name="send" ${g.send?'checked':''}>傳送</label></div></div>
      <div class="segmented wide" role="radiogroup" aria-label="聊天室範圍"><label><input type="radio" name="scope-${escape(g.accountId)}" value="all" ${g.chatIds?'':'checked'}><span>所有開放聊天室</span></label><label><input type="radio" name="scope-${escape(g.accountId)}" value="selected" ${g.chatIds?'checked':''}><span>指定聊天室</span></label></div>
      <p class="dialog-note" data-scope-all ${g.chatIds?'hidden':''}>包含日後開放給 AI 的聊天室。之後若要新增聊天室，請先改為「指定聊天室」。</p>
      <div class="picker-list" data-scope-chats ${g.chatIds?'':'hidden'}>${chats.length?chats.map(c=>`<label class="pick"><input type="checkbox" data-scope-chat="${escape(c.id)}" ${checked(c)?'checked':''}><span class="pick-main"><strong>${escape(chatName(c))}</strong><small><span class="tag">${escape(nice(c.kind))}</span>${c.enabled?'':'<span class="tag">未開放</span>'}<code>${escape(c.id)}</code></small></span></label>`).join(''):'<p class="muted">尚無開放給 AI 的聊天室。</p>'}</div></div>`;
  }).join('');
  document.querySelectorAll('[data-scope-account]').forEach(row=>row.querySelectorAll('input[type=radio]').forEach(input=>input.addEventListener('change',()=>{const all=row.querySelector('input[value=all]').checked;row.querySelector('[data-scope-all]').hidden=!all;row.querySelector('[data-scope-chats]').hidden=all;})));
  $('#token-scope-dialog').showModal();
}
$('#token-scope-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{
  const token=scopeToken;if(!token)return;
  const grants=[...document.querySelectorAll('[data-scope-account]')].map(row=>{
    const all=row.querySelector('input[value=all]').checked,chatIds=[...row.querySelectorAll('[data-scope-chat]:checked')].map(e=>e.dataset.scopeChat);
    return {accountId:row.dataset.scopeAccount,read:row.querySelector('[name=read]').checked,send:row.querySelector('[name=send]').checked,...(all?{}:{chatIds})};
  }).filter(g=>g.read||g.send);
  if(!grants.length)throw new Error('至少需保留一個帳號的讀取或傳送權限；若要停用，請撤銷權杖。');
  if(grants.some(g=>g.chatIds&&!g.chatIds.length))throw new Error('「指定聊天室」至少需選擇一個聊天室；若要移除帳號權限，請關閉讀取與傳送。');
  const chatLabel=(accountId,chatId)=>{const c=scopeChats.get(accountId)?.find(c=>c.id===chatId);return c?chatName(c):chatId;};
  try{
    const result=await saveTokenScope({token,grants,request:api,names:{accountName:id=>{const a=state.accounts.find(a=>a.id===id);return a?accountName(a):'已移除帳號';},chatName:chatLabel}});
    if(result.unchanged){toast('範圍未變更');return;}if(result.cancelled)return;
    $('#token-scope-dialog').close();scopeToken=null;toast('已更新權杖範圍');
  }catch(error){
    // The displayed scope may be stale; reopen from refreshed state to retry.
    $('#token-scope-dialog').close();scopeToken=null;throw error;
  }finally{await refresh();}
});});
let localAccessSignature;
function renderLocalAccess(){
  const local=state.gateway.authentication==='local';
  $('#local-access-panel').hidden=!local;
  $('#local-access-mode').textContent=local?'本機免權杖':'需要權杖';$('#local-access-mode').className=`badge ${local?'good':''}`;
  $('#access-connection-description').textContent=local?'本機直接連線免權杖；通道連線仍需 Bearer 權杖。':'AI 以 Authorization: Bearer 權杖連線；讀取權限包含全文搜尋。';
  const signature=JSON.stringify(state.accounts.map(a=>[a.id,accountName(a),a.designatedChats,a.localAccess]));if(signature===localAccessSignature)return;localAccessSignature=signature;
  $('#local-access-list').innerHTML=state.accounts.length?state.accounts.map(a=>`<div class="grant-row" data-local-account="${escape(a.id)}"><div><strong>${escape(accountName(a))}</strong><small>${a.designatedChats} 個開放聊天室${a.kind==='demo'?' · 沙盒':''}</small></div><div class="grant-options"><label class="switch-label"><input type="checkbox" class="switch" name="read" ${a.localAccess.read?'checked':''}>讀取</label><label class="switch-label"><input type="checkbox" class="switch" name="send" ${a.localAccess.send?'checked':''}>傳送</label></div></div>`).join(''):'<p class="muted">請先連接帳號並開放聊天室。</p>';
  document.querySelectorAll('[data-local-account]').forEach(row=>row.querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>action(async()=>{const inputs=[...row.querySelectorAll('input')];inputs.forEach(i=>i.disabled=true);try{await api(`/accounts/${row.dataset.localAccount}/local-access`,{method:'PUT',body:JSON.stringify({read:row.querySelector('[name=read]').checked,send:row.querySelector('[name=send]').checked})});toast('已更新本機 AI 權限');}catch(error){input.checked=!input.checked;throw error;}finally{inputs.forEach(i=>i.disabled=false);await refresh();}}))));
}
function openToken(accountId){if(!state?.accounts.length){toast('請先新增帳號',true);return;}$('#grant-list').innerHTML=state.accounts.filter(a=>!accountId||a.id===accountId).map(a=>`<div class="grant-row" data-grant="${escape(a.id)}"><div><strong>${escape(accountName(a))}</strong><small>${a.designatedChats} 個開放聊天室${a.kind==='demo'?' · 沙盒':''}</small></div><div class="grant-options"><label class="switch-label"><input type="checkbox" class="switch" name="read">讀取</label><label class="switch-label"><input type="checkbox" class="switch" name="send">傳送</label></div></div>`).join('');$('#token-dialog').showModal();}
$('#new-token').addEventListener('click',()=>openToken());
$('#token-form').addEventListener('submit',event=>{event.preventDefault();action(async()=>{const form=event.currentTarget,grants=[...document.querySelectorAll('[data-grant]')].map(e=>({accountId:e.dataset.grant,read:e.querySelector('[name=read]').checked,send:e.querySelector('[name=send]').checked})).filter(g=>g.read||g.send);if(!grants.length)throw new Error('請至少為一個帳號開啟讀取或傳送。');const data=await api('/tokens',{method:'POST',body:JSON.stringify({name:form.elements.name.value,days:Number(form.elements.days.value),grants})});$('#token-dialog').close();$('#token-form').reset();$('#new-secret').value=data.token;$('#secret-dialog').showModal();await refresh();});});
$('#copy-secret').addEventListener('click',()=>action(async()=>{try{await navigator.clipboard.writeText($('#new-secret').value);}catch{$('#new-secret').select();if(!document.execCommand('copy'))throw new Error('請選取並手動複製權杖。');}confirmButton($('#copy-secret'));}));
const activity=createActivity({getState:()=>state,api,action,toast,refresh,escape,when,short});
function renderAudit(){activity.render();}
const connections=createConnections({api,action,toast,refresh,escape,when,getState:()=>state});
function renderTunnel(){connections.render();}
await refresh();configureRefreshTimer(state?.refresh?.intervalSeconds??15);
