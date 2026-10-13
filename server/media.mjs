import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {fail} from './errors.mjs';

export const MEDIA_MAX_BYTES=1024*1024;
export const MEDIA_TIMEOUT_MS=25000;
// Pinned SDK encryptByKeyMaterial appends HMAC-SHA256(ciphertext, macKey),
// but its decrypt helper never verifies it. Authenticate before decrypting.
export async function decryptAuthenticatedMedia(e2ee,input,keyMaterial){
  const bytes=Buffer.from(input);
  const key=typeof keyMaterial==='string'?Buffer.from(keyMaterial,'base64'):Buffer.from(keyMaterial??[]);
  if(bytes.length<=32||bytes.length>MEDIA_MAX_BYTES||key.length!==32)fail(502,'media_integrity_failed','Encrypted media integrity could not be verified.');
  const keys=await e2ee.deriveKeyMaterial(key),ciphertext=bytes.subarray(0,-32),mac=bytes.subarray(-32);
  const expected=createHmac('sha256',keys.macKey).update(ciphertext).digest();
  if(!timingSafeEqual(mac,expected))fail(502,'media_integrity_failed','Encrypted media integrity could not be verified.');
  return Buffer.from(await e2ee.___decryptAESCTR(keys.encKey,keys.nonce,ciphertext));
}
export function mediaDescriptor(raw){
  const type=String(raw.contentType),m=raw.contentMetadata??{};
  if(type==='IMAGE'||type==='1')return {kind:'image',encrypted:!!raw.chunks?.length};
  if(type==='AUDIO'||type==='3')return {kind:'audio',encrypted:!!raw.chunks?.length};
  if(type!=='STICKER'&&type!=='7')return undefined;
  const result={kind:'sticker'};
  for(const [key,name] of [['STKID','stickerId'],['STKPKGID','packageId'],['STKVER','version']])if(typeof m[key]==='string'&&/^\d{1,20}$/.test(m[key]))result[name]=m[key];
  for(const [key,name] of [['STKOPT','options'],['STKTXT','customText']])if(m[key]!==undefined){if(typeof m[key]==='string'&&m[key].length<=1000)result[name]=m[key];else result.unsupported=true;}
  return result;
}
// Audio archived before audio support has no descriptor, but needs none: the
// driver re-fetches and re-checks the upstream message before any download.
export function archivedMedia(message){return message.media??(['AUDIO','3'].includes(String(message.contentType))?{kind:'audio'}:undefined);}
// LINE labels ordinary stickers with a localized placeholder such as "[Sticker]"
// or "[スタンプ]" in STKTXT, and STKOPT "0" means no option. Neither changes the
// image. Any other text or option still marks a custom or option-bearing sticker.
const STICKER_PLACEHOLDER=/^\[[^[\]\r\n]{1,40}\]$/u;
export function basicSticker(media){
  return /^\d{1,20}$/.test(media?.stickerId??'')&&!media.unsupported&&[undefined,'','0'].includes(media.options)&&(!media.customText||STICKER_PLACEHOLDER.test(media.customText));
}
// Only bounded, raster PNG/JPEG output. Never trust upstream filenames or MIME.
export function imageResult(input,preview=false){
  const bytes=Buffer.from(input);let mimeType,width,height;
  if(!bytes.length||bytes.length>MEDIA_MAX_BYTES)fail(413,'media_too_large','Image exceeds the 1 MiB limit.');
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'){
    mimeType='image/png';width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
    let offset=8,ended=false,pixels=false;
    while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);if(offset+12+length>bytes.length)break;
      if(type==='acTL')fail(415,'media_unsupported','Animated PNG is not supported; request a static preview.');
      if(type==='IDAT')pixels=true;offset+=length+12;if(type==='IEND'){ended=length===0&&offset===bytes.length;break;}}
    if(!ended||!pixels||bytes.readUInt32BE(8)!==13)fail(415,'media_unsupported','Malformed PNG image.');
  }else if(bytes.length>4&&bytes[0]===255&&bytes[1]===216){
    if(bytes.at(-2)!==255||bytes.at(-1)!==217)fail(415,'media_unsupported','Truncated JPEG image.');
    mimeType='image/jpeg';let i=2;
    while(i+4<=bytes.length){
      if(bytes[i++]!==255)break;
      while(bytes[i]===255)i++;
      const marker=bytes[i++];if(marker===217||marker===218)break;
      if(marker===1||(marker>=208&&marker<=215))continue;
      if(i+2>bytes.length)break;const size=bytes.readUInt16BE(i);
      if(size<2||i+size>bytes.length)break;
      if([192,193,194].includes(marker)&&size>=8){height=bytes.readUInt16BE(i+3);width=bytes.readUInt16BE(i+5);break;}i+=size;
    }
  }
  if(!mimeType||!width||!height||width>8192||height>8192||width*height>16_000_000)fail(415,'media_unsupported','Only bounded PNG/JPEG images up to 16 megapixels are supported.');
  return {mimeType,width,height,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64'),preview,untrustedContent:true};
}
// Only bounded MP4-family (M4A/3GP) audio. The container is walked, never decoded;
// the 1 MiB cap keeps the base64 reply inside the private worker pipe limit.
export function audioResult(input){
  const bytes=Buffer.from(input),unsupported=()=>fail(415,'media_unsupported','Only bounded M4A/3GP audio is supported.');
  if(!bytes.length||bytes.length>MEDIA_MAX_BYTES)fail(413,'media_too_large','Audio exceeds the 1 MiB limit.');
  const boxes=(start,end,visit)=>{
    for(let offset=start;offset<end;){
      if(offset+8>end)unsupported();
      let size=bytes.readUInt32BE(offset),header=8;const type=bytes.toString('latin1',offset+4,offset+8);
      if(size===1){if(offset+16>end)unsupported();size=Number(bytes.readBigUInt64BE(offset+8));header=16;}else if(size===0)size=end-offset;
      if(!/^[\x20-\x7e]{4}$/.test(type)||size<header||offset+size>end)unsupported();
      visit(type,offset,offset+header,offset+size);offset+=size;
    }
  };
  let brand,moov=false,mdat=false,durationMs;
  boxes(0,bytes.length,(type,start,body,end)=>{
    if(start===0){if(type!=='ftyp'||end-body<8)unsupported();brand=bytes.toString('latin1',body,body+4);}
    if(type==='mdat')mdat=true;
    if(type==='moov'){moov=true;boxes(body,end,(child,_start,data,childEnd)=>{
      if(child!=='mvhd'||childEnd-data<20)return;
      const v1=bytes[data]===1;if(v1&&childEnd-data<32)return;
      const scale=bytes.readUInt32BE(data+(v1?20:12)),length=v1?Number(bytes.readBigUInt64BE(data+24)):bytes.readUInt32BE(data+16);
      const ms=Math.round(length*1000/scale);if(scale>0&&length!==0xffffffff&&Number.isSafeInteger(ms)&&ms<=86_400_000)durationMs=ms;
    });}
  });
  if(!brand||!moov||!mdat)unsupported();
  return {mimeType:/^3g/.test(brand)?'audio/3gpp':'audio/mp4',bytes:bytes.length,...(durationMs!==undefined?{durationMs}:{}),sha256:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64'),untrustedContent:true};
}
export async function boundedResponse(response,signal){
  if(!response.ok){await response.body?.cancel();fail(502,'media_unavailable','LINE media is unavailable, expired, or access was rejected.');}
  if(Number(response.headers.get('content-length'))>MEDIA_MAX_BYTES){await response.body?.cancel();fail(413,'media_too_large','Media exceeds the 1 MiB limit.');}
  const reader=response.body?.getReader();if(!reader)fail(502,'media_unavailable','Media body is unavailable.');
  const chunks=[];let size=0;
  try{for(;;){signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MEDIA_MAX_BYTES)fail(413,'media_too_large','Media exceeds the 1 MiB limit.');chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}
  finally{await reader.cancel().catch(()=>{});}
}
