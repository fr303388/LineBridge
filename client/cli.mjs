import {parseArgs} from 'node:util';
import {createReadStream} from 'node:fs';
import {TextDecoder} from 'node:util';
import {CredentialStore, configDirectory, credentialInput, endpoint, profileName} from './credentials.mjs';
import {ClientError, EXIT, usage} from './errors.mjs';
import {gatewayRequest} from './request.mjs';
import {VERSION} from '../server/version.mjs';
import {discoverLocal} from './discovery.mjs';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateFlex} from '../server/flex.mjs';
import {imageResult,audioResult} from '../server/media.mjs';
import {validateTimeRange} from '../public/search-time.js';

export const DATA_COMMANDS = ['discover','version','accounts','chats','read','refresh','search','events','send','send-flex','media','auth'];
const common = ['profile','url','timeout-ms','credential-stdin'];
const commandOptions = {
  discover:['data-dir'],
  version:[],
  accounts:[], chats:['account'], read:['account','chat','limit','cursor'], refresh:['account','chat','limit'], events:['account','after','limit'],
  search:['query','query-file','query-stdin','account','chat','mode','before','limit','start-time','end-time'],
  send:['account','chat','key','text','text-file','stdin','acknowledge-oa-transport'],
  'send-flex':['account','chat','key','payload','payload-file','stdin'],
  media:['account','chat','message','output'],
  auth:['token-stdin']
};
const booleans = new Set(['help','credential-stdin','token-stdin','query-stdin','stdin','acknowledge-oa-transport']);
export const HELP = `LineBridge ${VERSION} data client (Node.js 24+, Windows/macOS)

  linebridge discover [--data-dir DIR] [--timeout-ms 7000]
  linebridge version [--profile NAME | --url GATEWAY]
  linebridge accounts
  linebridge chats --account ACCOUNT
  linebridge read --account ACCOUNT --chat CHAT [--limit 30] [--cursor CURSOR]
  linebridge refresh --account ACCOUNT --chat CHAT [--limit 30]
  linebridge events --account ACCOUNT [--after 0] [--limit 100]
  linebridge search --query QUERY [--account ACCOUNT] [--chat CHAT]
                    [--mode all|phrase] [--before SEQUENCE] [--limit 30]
                    [--start-time TIMESTAMP] [--end-time TIMESTAMP]
  linebridge send --account ACCOUNT --chat CHAT --key IDEMPOTENCY_KEY
                  (--text TEXT | --text-file UTF8_FILE | --stdin) [--acknowledge-oa-transport]
  linebridge auth enroll --url GATEWAY (--token-stdin | --credential-stdin)
  linebridge media --account ACCOUNT --chat CHAT --message MESSAGE --output FILE
  linebridge send-flex --account ACCOUNT --chat CHAT --key IDEMPOTENCY_KEY
                       --payload-file JSON_FILE
  linebridge auth forget [--profile NAME]

Common: --profile NAME (default: default), --url GATEWAY, --timeout-ms 45000,
        --credential-stdin (transient JSON credentials through a private pipe).
Discover uses only --data-dir and --timeout-ms. It lists existing local setup
profiles and the running CLI paths, without credentials or changing any setup.
Then use accounts --profile NAME and chats --profile NAME --account ACCOUNT.
Version checks the connected gateway app; --version prints the installed CLI version.
Search also accepts --query-file UTF8_FILE or --query-stdin instead of --query.
Search time bounds use message timestamps: start inclusive, end exclusive.
Use YYYY-MM-DDTHH:mm:ss[.SSS] with Z or an explicit UTC offset (e.g. +08:00).
Either bound may be omitted; keep the same time bounds on every page.
Refresh immediately reads the latest upstream messages for one permitted chat,
bypassing the automatic refresh interval. Upstream failures return errors,
not a cached-only result. It does not start monitoring.
Limits: 1-100 records per page; deadline 1-120000 ms. No automatic pagination,
redirects or retries. Pass returned cursor/nextBefore explicitly to continue.
OA text requires explicit --acknowledge-oa-transport approval: transport-encrypted,
not Letter Sealed. Verified OA recipients only; normal chats still use E2EE.
Credentials are never accepted as command-line arguments or printed.
Environment: LINE_BRIDGE_URL, LINE_BRIDGE_TOKEN, CF_ACCESS_CLIENT_ID,
             CF_ACCESS_CLIENT_SECRET, LINE_BRIDGE_CLIENT_CONFIG.
Enrollment stores an EXISTING scoped token using OS protection. It does not
create tokens, expand grants, log in to LINE, or set up a persistent service.
Sends require explicit user authorization. Unknown delivery exits 8 and must
be inspected before any further send. See CLI.md for exit codes and examples.
Media writes a NEW local PNG/JPEG image or M4A/3GP voice file; it never overwrites
files, invokes vision or transcribes audio.
Flex requires acknowledgeTransportSecurity:true in its JSON payload: Flex is not
Letter Sealed. Personal Talk only; OpenChat Flex is blocked pending verification.
`;

function parse(argv) {
  const command=argv[0];
  if(!DATA_COMMANDS.includes(command))usage('Use discover, version, accounts, chats, read, refresh, search, events, send or auth. See --help.');
  const allowed=new Set([...(command==='discover'?['timeout-ms']:common),...commandOptions[command],'help']);
  const options=Object.fromEntries([...allowed].map(name=>[name,{type:booleans.has(name)?'boolean':'string'}]));
  let parsed;
  try { parsed=parseArgs({args:argv.slice(1),options,allowPositionals:command==='auth',tokens:true}); }
  catch { usage('Invalid command options. See linebridge COMMAND --help. Credentials are accepted only through environment variables or stdin.'); }
  const seen=new Set();
  for(const token of parsed.tokens)if(token.kind==='option'){if(seen.has(token.name))usage('Do not repeat command options.');seen.add(token.name);}
  const action=parsed.positionals[0];
  if(command==='auth' && !parsed.values.help && (parsed.positionals.length!==1 || !['enroll','forget'].includes(action)))usage('Use auth enroll or auth forget.');
  return {command,action,values:parsed.values};
}
function integer(value, fallback, min, max, name) {
  if(value===undefined)return fallback;
  if(!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value)<min || Number(value)>max)usage(`${name} must be an integer between ${min} and ${max}.`);
  return Number(value);
}
function identifier(value,name) {
  if(typeof value!=='string' || !value.trim() || value.length>150 || /[\x00-\x1f\x7f]/.test(value))usage(`Supply an explicit ${name} ID (1-150 characters, without control characters).`);
  return value;
}
function oneOf(values,options) {
  if(options.filter(name=>values[name]!==undefined).length!==1)usage(`Supply exactly one of ${options.map(name=>`--${name}`).join(', ')}.`);
}
export async function boundedText(stream,{maxBytes=20000,timeoutMs=45000} = {}) {
  return new Promise((resolve,reject)=>{
    const chunks=[];let size=0,done=false;
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);stream.removeListener('data',data);stream.removeListener('end',end);stream.removeListener('error',failed);stream.removeListener('close',closed);if(error){stream.pause();reject(error);}else{try{resolve(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(Buffer.concat(chunks)));}catch{reject(new ClientError('invalid_utf8','Input must be valid UTF-8.',EXIT.usage));}}};
    const data=chunk=>{const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes)finish(new ClientError('input_too_large','Input exceeds the command size limit.',EXIT.usage));else chunks.push(bytes);};
    const end=()=>finish();
    const failed=()=>finish(new ClientError('input_error','Input could not be read.',EXIT.usage));
    const closed=()=>{if(!stream.readableEnded)failed();};
    const timer=setTimeout(()=>finish(new ClientError('input_timeout','Input did not finish before the deadline.',EXIT.transport)),timeoutMs);
    stream.on('data',data);stream.once('end',end);stream.once('error',failed);stream.once('close',closed);
    if(stream.readableEnded)end();else if(stream.destroyed)failed();
  });
}
async function inputText(values,names,context,maxBytes) {
  const [literal,file,stdin]=names;
  oneOf(values,names);
  if(values[literal]!==undefined)return values[literal];
  if(values[stdin]) {
    if(context.stdin.isTTY)usage('Pipe input through stdin; interactive input is not echoed or prompted by this client.');
    return boundedText(context.stdin,{maxBytes,timeoutMs:context.timeoutMs});
  }
  const stream=createReadStream(values[file]);
  try { return await boundedText(stream,{maxBytes,timeoutMs:context.timeoutMs}); }
  finally { stream.destroy(); }
}
async function stdinCredentials(values,context) {
  if(context.stdin.isTTY)usage('Provide credentials through a private stdin pipe, not an interactive terminal.');
  const text=await boundedText(context.stdin,{maxBytes:4096,timeoutMs:context.timeoutMs});
  if(values['token-stdin'])return credentialInput({token:text.replace(/\r?\n$/,'')});
  let parsed;
  try { parsed=JSON.parse(text); } catch { usage('Credential stdin must be valid JSON.'); }
  return credentialInput(parsed);
}
async function credentials(values,context) {
  if(values['credential-stdin'])return {url:endpoint(values.url || context.env.LINE_BRIDGE_URL || 'http://127.0.0.1:3211'),...await stdinCredentials(values,context)};
  // An explicitly selected profile wins over ambient environment credentials.
  if(values.profile===undefined && context.env.LINE_BRIDGE_TOKEN!==undefined) {
    return {url:endpoint(values.url || context.env.LINE_BRIDGE_URL || 'http://127.0.0.1:3211'),...credentialInput({token:context.env.LINE_BRIDGE_TOKEN,...(context.env.CF_ACCESS_CLIENT_ID!==undefined || context.env.CF_ACCESS_CLIENT_SECRET!==undefined ? {cfAccessClientId:context.env.CF_ACCESS_CLIENT_ID,cfAccessClientSecret:context.env.CF_ACCESS_CLIENT_SECRET} : {})})};
  }
  const stored=await context.store.get(profileName(values.profile));
  const override=values.url || context.env.LINE_BRIDGE_URL;
  if(override && endpoint(override)!==stored.url)usage('The gateway URL differs from the enrolled profile. Enroll a separate profile for that gateway or use explicit transient credentials.');
  return stored;
}
async function execute(argv,context) {
  const {command,action,values}=parse(argv);
  if(values.help){context.stderr.write(HELP);return {version:VERSION,commands:DATA_COMMANDS};}
  if(command==='discover')return discoverLocal({dataDir:values['data-dir'],env:context.env,timeoutMs:integer(values['timeout-ms'],7000,1,120000,'timeout-ms'),fetchImpl:context.fetchImpl});
  profileName(values.profile);
  context.timeoutMs=integer(values['timeout-ms'],45000,1,120000,'timeout-ms');
  if(values.url!==undefined)endpoint(values.url);
  if(command==='auth') {
    if(action==='forget') {
      if(values.url!==undefined || values['token-stdin'] || values['credential-stdin'])usage('auth forget accepts only profile and timeout options.');
      return context.store.forget(profileName(values.profile));
    }
    oneOf(values,['token-stdin','credential-stdin']);
    const url=endpoint(values.url || context.env.LINE_BRIDGE_URL || 'http://127.0.0.1:3211');
    return context.store.set(profileName(values.profile),url,await stdinCredentials(values,context));
  }
  if(values['credential-stdin'] && (values.stdin || values['query-stdin']))usage('Credentials and message/query text cannot both consume stdin. Use an enrolled profile or transient environment credentials.');
  if(values['credential-stdin'] && values.profile!==undefined)usage('Choose an enrolled profile or transient credential stdin, not both.');
  const account=values.account===undefined?undefined:identifier(values.account,'account'),chat=values.chat===undefined?undefined:identifier(values.chat,'chat');
  if(['chats','read','refresh','events','send','send-flex','media'].includes(command) && !account)usage('Supply --account with an explicit account ID.');
  if(['read','refresh','send','send-flex','media'].includes(command) && !chat)usage('Supply --chat with an explicit chat ID.');
  if(chat && !account)usage('--chat requires --account.');
  const base=account?`/api/v1/accounts/${encodeURIComponent(account)}`:undefined;
  const limit=integer(values.limit,command==='events'?100:30,1,100,'limit');
  let request;
  if(command==='version')request={path:'/api/v1/version'};
  if(command==='accounts')request={path:'/api/v1/accounts'};
  if(command==='chats')request={path:`${base}/chats`};
  if(command==='events')request={path:`${base}/events?${new URLSearchParams({after:String(integer(values.after,0,0,Number.MAX_SAFE_INTEGER,'after')),limit:String(limit)})}`};
  if(command==='read'||command==='refresh') {
    const params=new URLSearchParams({limit:String(limit)});
    if(command==='refresh')params.set('fresh','true');
    if(values.cursor!==undefined){if(!values.cursor || values.cursor.length>4096)usage('cursor must contain 1-4096 characters.');params.set('cursor',values.cursor);}
    request={path:`${base}/chats/${encodeURIComponent(chat)}/messages?${params}`};
  }
  if(command==='search') {
    let timeRange;try{timeRange=validateTimeRange({startTime:values['start-time'],endTime:values['end-time']});}catch(error){usage(error.message);}
    if(values.mode!==undefined && !['all','phrase'].includes(values.mode))usage('Search mode must be all or phrase.');
    const before=integer(values.before,undefined,1,Number.MAX_SAFE_INTEGER,'before');
    const query=await inputText(values,['query','query-file','query-stdin'],context,800);
    if(!query.trim() || query.trim().length>200)usage('Search queries need 1-200 characters.');
    request={path:'/api/v1/messages/search',method:'POST',body:{query,mode:values.mode || 'all',limit,...timeRange,...(account?{accountId:account}:{}),...(chat?{chatId:chat}:{}),...(before===undefined?{}:{before})}};
  }
  if(command==='send') {
    if(typeof values.key!=='string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(values.key))usage('Supply --key with 8-128 letters, digits, dots, underscores, colons or hyphens. Keep the same key for the same request.');
    const text=await inputText(values,['text','text-file','stdin'],context,20000);
    if(!text.trim() || text.length>5000)usage('Message text needs 1-5000 characters.');
    request={path:`${base}/chats/${encodeURIComponent(chat)}/messages`,method:'POST',body:{text,...(values['acknowledge-oa-transport']?{acknowledgeOaTransport:true}:{})},key:values.key,send:true};
  }
  if(command==='send-flex'){
    if(typeof values.key!=='string'||!/^[A-Za-z0-9._:-]{8,128}$/.test(values.key))usage('Supply a valid explicit --key.');
    const input=await inputText(values,['payload','payload-file','stdin'],context,30000);
    let payload;try{payload=validateFlex(JSON.parse(input));}catch{usage('Invalid Flex JSON: use the documented typed subset and acknowledgeTransportSecurity:true.');}
    request={path:`${base}/chats/${encodeURIComponent(chat)}/flex`,method:'POST',body:payload,key:values.key,send:true};
  }
  if(command==='media'){
    if(!values.output||/[\x00-\x1f]/.test(values.output))usage('Supply --output with a new local file path.');
    if(!/^[A-Za-z0-9_-]{1,150}$/.test(values.message??''))usage('Supply --message with a valid archived message ID.');
    request={path:`${base}/chats/${encodeURIComponent(chat)}/messages/${encodeURIComponent(values.message)}/media`};
  }
  const selected=await credentials(values,context);
  const result=await gatewayRequest({...request,url:selected.url,credentials:selected,timeoutMs:context.timeoutMs,fetchImpl:context.fetchImpl});
  if(command==='media'){
    // Validate the kind the gateway declared; older gateways only return images.
    const audio=result.kind==='audio';
    let checked;try{const bytes=Buffer.from(result.data??'','base64');checked=audio?audioResult(bytes):imageResult(bytes,result.preview===true);if(checked.sha256!==result.sha256||checked.mimeType!==result.mimeType)throw new Error();}catch{throw new ClientError('invalid_media',`Gateway returned invalid ${audio?'audio':'image'} data.`,EXIT.transport);}
    const output=resolve(values.output);
    try{await writeFile(output,Buffer.from(checked.data,'base64'),{flag:'wx',mode:0o600});}catch{throw new ClientError('output_failed','Could not create the output file. Existing files are never overwritten.',EXIT.usage);}
    const {data,...metadata}=checked;
    return audio?{kind:'audio',...metadata,path:output,transcribed:false,notice:'Local audio file created. It has not been played or transcribed; use an audio-capable tool if needed and delete it when no longer needed.'}
      :{...(result.kind?{kind:result.kind}:{}),...metadata,path:output,visionInvoked:false,notice:'Local image file created. Read it with an image-capable tool to inspect its contents; delete it when no longer needed.'};
  }
  return result;
}
export async function runCli(argv,{env=process.env,stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,store=new CredentialStore({directory:configDirectory(env),env}),fetchImpl=fetch} = {}) {
  try {
    if(Number(process.versions.node.split('.')[0])<24)usage('LineBridge requires Node.js 24 or newer.');
    const result=await execute(argv,{env,stdin,stdout,stderr,store,fetchImpl});
    stdout.write(`${JSON.stringify(result)}\n`);
    return EXIT.ok;
  } catch(error) {
    const safe=error instanceof ClientError ? error : new ClientError('client_error','The client could not complete the command. No automatic retry was made.',EXIT.internal);
    const result={error:safe.code,message:safe.message,...(safe.status===undefined?{}:{status:safe.status})};
    stdout.write(`${JSON.stringify(result)}\n`);
    stderr.write(`${safe.code}: ${safe.message}\n`);
    return safe.exitCode;
  }
}
