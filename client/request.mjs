import {ClientError, EXIT, unknownDelivery} from './errors.mjs';
import {preparationDiagnostic} from './send-diagnostic.mjs';

const errors = {
  oa_transport_acknowledgment_required:'Official Account messages are transport-encrypted, not Letter Sealed. Obtain explicit approval for this recipient and message, then use --acknowledge-oa-transport. No message was sent; do not retry automatically.',
  send_authorization_revoked:'Send permission expired or changed during preparation. No message was sent.',
  invalid_flex:'Invalid Flex payload or missing transport-security acknowledgment.', flex_transport_unsupported:'OpenChat Flex is not verified and is blocked; no fallback was used.',
  media_metadata_missing:'Message has no image, sticker or audio metadata.', media_not_archived:'Message is not in this scoped chat archive.',
  media_unsupported:'Unsupported media type, format or dimensions.', sticker_unsupported:'Custom-text or option-bearing stickers are not supported.',
  media_kind_mismatch:'This tool does not return this media kind; use the media API.',
  media_too_large:'Media exceeds the 1 MiB limit.', media_unavailable:'LINE media is unavailable, expired, or access was rejected.',
  media_history_unavailable:'Personal-chat media is outside the latest 100 upstream messages.', invalid_message_id:'Invalid archived message ID.',
  media_key_unavailable:'Existing decryption keys are unavailable; no key registration was attempted.',
  media_integrity_failed:'Encrypted media integrity verification failed; no image was returned.',
  unauthorized:'A scoped Bearer token is required or invalid.', invalid_token:'The token has expired or been revoked.',
  scope_denied:'The token lacks the required account permission.', chat_not_designated:'The chat is not designated for this client.',
  cloudflare_access_required:'Cloudflare Access authentication is also required.', invalid_access_assertion:'Cloudflare Access authentication failed.',
  host_denied:'The gateway rejected this hostname.', browser_origin_denied:'The gateway rejected the client origin.',
  invalid_input:'The gateway rejected the request fields.', invalid_cursor:'The gateway rejected the cursor.', invalid_limit:'The gateway rejected the page limit.',
  invalid_text:'The gateway rejected the message text.', idempotency_required:'The gateway requires a valid idempotency key.',
  idempotency_conflict:'This idempotency key belongs to a different message.', account_disconnected:'The account is disconnected.',
  login_required:'The account requires operator authorization.', account_not_found:'The account was not found.', not_found:'The endpoint was not found.',
  rate_limited:'Rate limit reached. Wait before making another explicit request.', account_busy:'The account has too many pending operations.',
  gateway_paused:'The operator has paused client access.', upstream_unavailable:'The upstream operation is unavailable.', access_not_configured:'Cloudflare Access is not configured.'
};
function remoteError(status,body) {
  if(body?.error==='delivery_unknown')return unknownDelivery(status);
  const code = Object.hasOwn(errors,body?.error) ? body.error : 'gateway_error';
  const exitCode = [401,403].includes(status) ? EXIT.denied : status===429 || status>=500 ? EXIT.unavailable : EXIT.remote;
  return new ClientError(code,errors[code] || 'The gateway rejected the request. Check its status and configuration.',exitCode,status);
}
export async function gatewayRequest({url,credentials,path,method='GET',body,key,timeoutMs=45000,send=false,fetchImpl=fetch}) {
  const headers = {Accept:'application/json',Authorization:`Bearer ${credentials.token}`};
  if(credentials.cfAccessClientId) {
    headers['CF-Access-Client-Id']=credentials.cfAccessClientId;
    headers['CF-Access-Client-Secret']=credentials.cfAccessClientSecret;
  }
  if(body!==undefined) headers['Content-Type']='application/json';
  if(key)headers['Idempotency-Key']=key;
  let response, result;
  try {
    // One fetch only, no redirects or retries; the deadline covers the body too.
    response = await fetchImpl(`${url}${path}`,{method,headers,redirect:'error',signal:AbortSignal.timeout(timeoutMs),...(body===undefined?{}:{body:JSON.stringify(body)})});
    const reader=response.body?.getReader();
    if(!reader)throw new Error('Missing response');
    const chunks=[];let size=0;
    try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4*1024*1024)throw new Error('Response limit');chunks.push(Buffer.from(value));} }
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result===null || typeof result!=='object')throw new Error('Invalid response');
  } catch(error) {
    if(send)throw unknownDelivery();
    const timeout=['TimeoutError','AbortError'].includes(error?.name);
    throw new ClientError(timeout?'request_timeout':'transport_error',timeout?'The request timed out. No retry was made.':'The gateway did not return a usable JSON response. Check its URL, availability and TLS configuration. No retry was made.',EXIT.transport);
  }
  if(!response.ok) {
    if(send&&result.error==='send_preparation_failed'){
      const diagnostic=preparationDiagnostic(result.message);
      if(diagnostic)throw new ClientError('send_preparation_failed',`Message preparation failed (${diagnostic}). No message was sent. No retry was made.`,EXIT.remote,response.status);
    }
    if(send && response.status>=500)throw unknownDelivery(response.status);
    throw remoteError(response.status,result);
  }
  // A successful HTTP status alone cannot confirm a send. Match the gateway's
  // minimum acknowledgement contract before reporting success to automation.
  if(send && (result.error!==undefined || typeof result.messageId!=='string' || !result.messageId.trim()))throw unknownDelivery(response.status);
  return result;
}
