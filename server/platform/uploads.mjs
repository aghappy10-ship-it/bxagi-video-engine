/**
 * Stream actual media into tenant storage with bounded reads and header checks.
 * Callers supply an owner only after verifying the BXAGI session and project.
 */
import { fail } from './protocol.mjs';

const MAX_UPLOAD = 64 * 1024 * 1024;
const MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4',
  'text/plain', 'text/srt', 'application/x-subrip', 'application/json'
]);

function validateHeaderBytes(mime, bytes) {
  const at = (offset, chars) => Array.from(chars).every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  let valid = false;
  if (mime === 'image/png') {
    valid = bytes.length >= 24 && bytes[0] === 137 && at(1, 'PNG\r\n\x1a\n');
  } else if (mime === 'image/jpeg') {
    valid = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  } else if (mime === 'image/webp') {
    valid = at(0, 'RIFF') && at(8, 'WEBP');
  } else if (mime === 'image/gif') {
    valid = at(0, 'GIF87a') || at(0, 'GIF89a');
  } else if (mime === 'image/svg+xml') {
    valid = /<svg[\s>]/i.test(text) && !/<(?:script|foreignObject)|on\w+\s*=|(?:javascript|data:text\/html):/i.test(text);
  } else if (['video/mp4', 'video/quicktime', 'audio/mp4'].includes(mime)) {
    valid = at(4, 'ftyp');
  } else if (mime === 'video/webm') {
    valid = bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163;
  } else if (['audio/wav', 'audio/x-wav'].includes(mime)) {
    valid = at(0, 'RIFF') && at(8, 'WAVE');
  } else if (mime === 'audio/ogg') {
    valid = at(0, 'OggS');
  } else if (mime === 'audio/mpeg') {
    valid = at(0, 'ID3') || bytes[0] === 255 && (bytes[1] & 224) === 224;
  } else {
    valid = !bytes.includes(0) && !/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text);
  }
  if (!valid) {
    fail(415, '文件内容与声明的媒体类型不一致，或包含不支持的内容', 'invalid_media');
  }
  if (mime === 'image/png') {
    const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = d.getUint32(16),
      height = d.getUint32(20);
    if (!width || !height || width > 32768 || height > 32768 || width * height > 268435456) {
      fail(415, 'PNG实际尺寸无效或超出处理范围', 'invalid_dimensions');
    }
    return {
      width,
      height
    };
  }
  return {};
}

export async function putUpload(request, bucket, userId, kind) {
  if (!bucket?.put) {
    fail(503, '素材存储尚未配置', 'storage_unavailable');
  }
  const mime = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!MIME.has(mime)) {
    fail(415, '不支持该媒体类型', 'unsupported_media');
  }
  const declared = request.headers.get('Content-Length');
  const knownLength = declared === null ? null : Number(declared);
  if (knownLength !== null && (!Number.isSafeInteger(knownLength) || knownLength <= 0 || knownLength > MAX_UPLOAD)) {
    fail(413, '单个素材最大64MiB且不能为空', 'upload_too_large');
  }
  if (!request.body) {
    fail(400, '请选择实际素材文件', 'empty_upload');
  }
  let filename;
  try {
    filename = decodeURIComponent(request.headers.get('X-Filename') || '素材');
  } catch {
    fail(400, '文件名编码错误', 'invalid_filename');
  }
  filename = filename.replace(/[\/\\\x00-\x1f\x7f]/g, '_').slice(0, 180) || '素材';
  const reader = request.body.getReader();
  let count = 0;
  const initial = [];
  let initialLength = 0;
  while (initialLength < 512) {
    const {
      done,
      value
    } = await reader.read();
    if (done) {
      break;
    }
    count += value.byteLength;
    if (count > MAX_UPLOAD) {
      await reader.cancel();
      fail(413, '单个素材最大64MiB', 'upload_too_large');
    }
    initial.push(value);
    initialLength += value.byteLength;
  }
  if (!count) {
    fail(400, '素材文件为空', 'empty_upload');
  }
  const prefix = new Uint8Array(Math.min(initialLength, 512));
  let copied = 0;
  for (const chunk of initial) {
    const take = Math.min(chunk.length, prefix.length - copied);
    prefix.set(chunk.subarray(0, take), copied);
    copied += take;
    if (copied === prefix.length) {
      break;
    }
  }
  let metadata;
  try {
    metadata = validateHeaderBytes(mime, prefix);
  } catch (e) {
    await reader.cancel();
    throw e;
  }
  // SVG can contain active content after its header. Keep it as an attachment only;
  // browser previews are protected by an empty CSP and sandbox at the download route.
  const stream = new ReadableStream({
    async pull(controller) {
      if (initial.length) {
        controller.enqueue(initial.shift());
        return;
      }
      const {
        done,
        value
      } = await reader.read();
      if (done) {
        if (knownLength !== null && knownLength !== count) {
          controller.error(Object.assign(new Error('上传长度不匹配'), {
            status: 400
          }));
          return;
        }
        controller.close();
        return;
      }
      count += value.byteLength;
      if (count > MAX_UPLOAD) {
        await reader.cancel();
        controller.error(Object.assign(new Error('单个素材最大64MiB'), {
          status: 413
        }));
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
  const objectKey = `tenants/${encodeURIComponent(userId)}/${kind}/${crypto.randomUUID()}`;
  try {
    if (knownLength !== null && typeof globalThis.FixedLengthStream === 'function') {
      const fixed = new globalThis.FixedLengthStream(knownLength);
      const pipe = stream.pipeTo(fixed.writable);
      pipe.catch(() => {});
      await bucket.put(objectKey, fixed.readable, {
        httpMetadata: {
          contentType: mime
        },
        customMetadata: {
          filename,
          owner: userId
        }
      });
      await pipe;
    } else {
      await bucket.put(objectKey, stream, {
        httpMetadata: {
          contentType: mime
        },
        customMetadata: {
          filename,
          owner: userId
        }
      });
    }
  } catch (error) {
    await bucket.delete?.(objectKey);
    if (error.status) {
      throw error;
    }
    fail(503, '素材存储失败，请重试', 'upload_failed');
  }
  return {
    filename,
    mimeType: mime,
    size: count,
    objectKey,
    metadata
  };
}
