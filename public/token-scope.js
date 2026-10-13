// Edit one manual token's grants in place. Its bearer and client configuration
// stay the same; the change applies only to this token, never to other clients.

// Omitted chatIds means every designated chat, including chats designated later.
export function scopeText(grant){return grant.chatIds?`${grant.chatIds.length} 個指定聊天室`:'所有開放聊天室';}

// Describe each change and whether it gains any permission or chat.
export function scopeChanges(current,next,{accountName=id=>id,chatName=(_accountId,chatId)=>chatId}={}){
  const lines=[];let widens=false;
  for(const id of new Set([...current,...next].map(g=>g.accountId))){
    const before=current.find(g=>g.accountId===id),after=next.find(g=>g.accountId===id),name=accountName(id);
    if(!after){lines.push(`${name}：移除此帳號的所有權限`);continue;}
    if(!before){lines.push(`${name}：新增帳號權限`);widens=true;}
    for(const [key,text] of [['read','讀取'],['send','傳送']])if(!!before?.[key]!==!!after[key]){if(before)lines.push(`${name}：${after[key]?'新增':'移除'}${text}權限`);if(after[key])widens=true;}
    const was=before?before.chatIds:[],now=after.chatIds;
    if(was&&!now){lines.push(`${name}：改為所有開放聊天室，包含日後開放的聊天室`);widens=true;}
    else if(!was&&now)lines.push(`${name}：改為只限 ${now.length} 個指定聊天室；日後開放的聊天室不會自動加入`);
    else if(was&&now){
      const added=now.filter(c=>!was.includes(c)),removed=was.filter(c=>!now.includes(c));
      if(added.length){widens=true;lines.push(`${name}：新增聊天室 ${added.map(c=>chatName(id,c)).join('、')}`);}
      if(removed.length)lines.push(`${name}：移除聊天室 ${removed.map(c=>chatName(id,c)).join('、')}`);
    }
  }
  return {changed:lines.length>0,widens,lines};
}

// The user confirms the exact change; the server rejects it if the token changed
// since it was displayed. A failed request is never retried here.
export async function saveTokenScope({token,grants,names,request,confirm=message=>globalThis.confirm(message)}){
  const summary=scopeChanges(token.grants,grants,names);
  if(!summary.changed)return {unchanged:true};
  const message=`${summary.widens?'擴大':'變更'}權杖「${token.name}」的授權範圍？\n\n${summary.lines.join('\n')}\n\n只會變更這把權杖，其他權杖與本機 AI 不受影響。使用此權杖的用戶端會立即套用新範圍，不需更換權杖或修改設定。`;
  if(!await confirm(message))return {cancelled:true};
  return {saved:true,token:await request(`/tokens/${encodeURIComponent(token.id)}/grants`,{method:'PUT',body:JSON.stringify({grants,currentGrants:token.grants,confirmed:true})})};
}
