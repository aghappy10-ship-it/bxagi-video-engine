const extensions={srt:'application/x-subrip',txt:'text/plain',md:'text/plain',vtt:'text/plain',json:'application/json',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',svg:'image/svg+xml',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4'};
export function uploadMime(filename,type='') {
  const extension=String(filename).split('.').pop().toLowerCase();
  if(['srt','txt','md','vtt'].includes(extension))return extensions[extension];
  return type||extensions[extension]||'application/octet-stream';
}
export function typedUploadBlob(file) {const type=uploadMime(file.name,file.type);return type===file.type?file:file.slice(0,file.size,type);}
export async function inspectCreative(blob) {
  if(blob.type.startsWith('image/') && typeof createImageBitmap==='function') {
    const bitmap=await createImageBitmap(blob);try{return {width:bitmap.width,height:bitmap.height,validation:'browser-metadata'};}finally{bitmap.close();}
  }
  if(blob.type.startsWith('video/')) {
    const video=document.createElement('video');const url=URL.createObjectURL(blob);video.preload='metadata';
    try {return await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{reject(new Error('无法读取视频元数据，请用本地媒体服务重新导出。'));},20000);video.onloadedmetadata=()=>{clearTimeout(timeout);if(!video.videoWidth||!video.videoHeight)return reject(new Error('视频画面尺寸无效。'));resolve({width:video.videoWidth,height:video.videoHeight,duration:Number.isFinite(video.duration)&&video.duration>0?video.duration:null,validation:'browser-metadata'});};video.onerror=()=>{clearTimeout(timeout);reject(new Error('浏览器无法解码这个视频，请导出 MP4 后重试。'));};video.src=url;});}
    finally {video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
  }
  return {validation:'operator-reviewed'};
}
