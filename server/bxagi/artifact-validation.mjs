/** Task-scoped paths and byte-level media validation. No storage or network access. */

const fail = (status, message, code = 'bxagi_workflow_error') => Object.assign(new Error(message), {
  status,
  code
});

export const MAX_FILE = 16 * 1024 * 1024;
export const sha256 = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
export const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'text/plain': 'txt',
  'text/srt': 'srt',
  'application/x-subrip': 'srt',
  'application/json': 'json',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg'
};

export function resultPath(job, path, entry) {
  const prefix = `bxagi-advertising/${job.id}/output/`;
  const invalid = () => fail(422, 'BXAGI成果必须在当前任务的专属交付目录', 'bxagi_invalid_artifact');
  if (typeof path !== 'string' || path !== path.trim() || path.length > 500 || /[\\%?#:\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) throw invalid();
  if (path.startsWith(prefix)) return path;
  // The observed worker sometimes emits only the filename. Resolve that exact
  // form inside this job, never strip directories or accept absolute paths.
  const extension = ['image/png', 'video/mp4', 'text/plain'].includes(entry?.mimeType) ? extensions[entry.mimeType] : null;
  if (path.includes('/') || path.length > 180 || path !== entry?.filename || !extension || path.length <= extension.length + 1 || !path.toLowerCase().endsWith('.' + extension)) throw invalid();
  return prefix + path;
}

const crcTable = Uint32Array.from({
  length: 256
}, (_, value) => {
  let n = value;
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}

export async function byteMetadata(bytes, mime) {
  const at = (start, word) => Array.from(word).every((c, i) => bytes[start + i] === c.charCodeAt(0));
  if (mime === 'image/png') {
    if (bytes.length < 24 || bytes[0] !== 137 || !at(1, 'PNG\r\n\x1a\n')) throw fail(422, '员工交付的PNG文件内容不正确', 'bxagi_invalid_artifact');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      width = view.getUint32(16),
      height = view.getUint32(20);
    if (width < 16 || height < 16 || width > 8192 || height > 8192 || width * height > 16777216) throw fail(422, '员工交付图片的实际尺寸无效', 'bxagi_invalid_artifact');
    const channels = {
      0: 1,
      2: 3,
      3: 1,
      4: 2,
      6: 4
    }[bytes[25]];
    if (bytes[24] !== 8 || !channels || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw fail(422, '员工图片需转换为8位非交错PNG', 'bxagi_invalid_artifact');
    let offset = 8,
      ended = false,
      header = false,
      palette = false;
    const data = [];
    while (offset < bytes.length) {
      if (offset + 12 > bytes.length) throw fail(422, 'PNG文件被截断', 'bxagi_invalid_artifact');
      const length = view.getUint32(offset),
        end = offset + 12 + length;
      if (end > bytes.length) throw fail(422, 'PNG区块被截断', 'bxagi_invalid_artifact');
      const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
      if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== view.getUint32(offset + 8 + length)) throw fail(422, 'PNG文件校验失败', 'bxagi_invalid_artifact');
      if (!header) {
        if (type !== 'IHDR' || length !== 13) throw fail(422, 'PNG缺少完整文件头', 'bxagi_invalid_artifact');
        header = true;
      } else if (type === 'IHDR') throw fail(422, 'PNG含重复文件头', 'bxagi_invalid_artifact');
      if (type === 'PLTE') palette = true;
      if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
      if (type === 'IEND') {
        if (length !== 0 || end !== bytes.length) throw fail(422, 'PNG结束区块无效', 'bxagi_invalid_artifact');
        ended = true;
      }
      offset = end;
    }
    if (!ended || !data.length || bytes[25] === 3 && !palette) throw fail(422, 'PNG缺少实际图像数据', 'bxagi_invalid_artifact');
    const stride = 1 + width * channels,
      expected = stride * height;
    if (expected > 68 * 1024 * 1024) throw fail(422, 'PNG解码大小超出处理范围', 'bxagi_invalid_artifact');
    const reader = new Blob(data).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    let count = 0;
    try {
      while (true) {
        const {
          done,
          value
        } = await reader.read();
        if (done) break;
        for (let at = 0; at < value.length; at++) {
          if ((count + at) % stride === 0 && value[at] > 4) throw fail(422, 'PNG扫描行编码无效', 'bxagi_invalid_artifact');
        }
        count += value.length;
        if (count > expected) throw fail(422, 'PNG解码长度无效', 'bxagi_invalid_artifact');
      }
      if (count !== expected) throw fail(422, 'PNG实际图像数据不完整', 'bxagi_invalid_artifact');
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error.status ? error : fail(422, 'PNG图像解码失败', 'bxagi_invalid_artifact');
    }
    return {
      width,
      height,
      technicalChecks: {
        pngChunks: true,
        pngCrc: true,
        pngInflate: true
      }
    };
  }
  if (mime === 'video/mp4') {
    if (bytes.length < 1024 || !at(4, 'ftyp')) throw fail(422, '员工交付的MP4文件内容不正确', 'bxagi_invalid_artifact');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0,
      ftyp = false,
      moov = false,
      mdat = false;
    const videos = [];
    const boxes = (start, end) => {
      const result = [];
      let p = start;
      while (p < end) {
        if (p + 8 > end) throw fail(422, 'MP4区块被截断', 'bxagi_invalid_artifact');
        let size = view.getUint32(p),
          head = 8;
        if (size === 1) {
          if (p + 16 > end) throw fail(422, 'MP4区块被截断', 'bxagi_invalid_artifact');
          const large = view.getBigUint64(p + 8);
          if (large > BigInt(bytes.length)) throw fail(422, 'MP4区块长度无效', 'bxagi_invalid_artifact');
          size = Number(large);
          head = 16;
        } else if (size === 0) size = end - p;
        if (size < head || p + size > end) throw fail(422, 'MP4区块长度无效', 'bxagi_invalid_artifact');
        result.push({
          type: new TextDecoder().decode(bytes.subarray(p + 4, p + 8)),
          start: p + head,
          end: p + size,
          size
        });
        p += size;
      }
      return result;
    };
    for (const box of boxes(0, bytes.length)) {
      if (box.type === 'ftyp') {
        if (offset !== 0 || box.size < 16) throw fail(422, 'MP4文件类型区块无效', 'bxagi_invalid_artifact');
        ftyp = true;
      }
      if (box.type === 'mdat' && box.end > box.start) mdat = true;
      if (box.type === 'moov') {
        if (moov) throw fail(422, 'MP4包含多个影片元数据区块', 'bxagi_invalid_artifact');
        moov = true;
        for (const track of boxes(box.start, box.end).filter(b => b.type === 'trak')) {
          const children = boxes(track.start, track.end),
            media = children.filter(b => b.type === 'mdia');
          if (media.length !== 1) throw fail(422, 'MP4轨道媒体信息缺失或重复', 'bxagi_invalid_artifact');
          const fields = boxes(media[0].start, media[0].end),
            handlers = fields.filter(b => b.type === 'hdlr');
          if (handlers.length !== 1 || handlers[0].end - handlers[0].start < 24 || bytes[handlers[0].start] !== 0) throw fail(422, 'MP4轨道类型信息无效', 'bxagi_invalid_artifact');
          if (!at(handlers[0].start + 8, 'vide')) continue;
          if (videos.length) throw fail(422, 'MP4包含多个视频轨道，无法确认唯一投放画面', 'bxagi_invalid_artifact');
          const headers = children.filter(b => b.type === 'tkhd'),
            timings = fields.filter(b => b.type === 'mdhd');
          if (headers.length !== 1 || timings.length !== 1) throw fail(422, 'MP4视频尺寸或时长信息缺失或重复', 'bxagi_invalid_artifact');
          const header = headers[0],
            timing = timings[0],
            headerVersion = bytes[header.start],
            timingVersion = bytes[timing.start];
          if (![0, 1].includes(headerVersion) || ![0, 1].includes(timingVersion) || header.end - header.start < (headerVersion === 1 ? 96 : 84) || timing.end - timing.start < (timingVersion === 1 ? 36 : 24)) throw fail(422, 'MP4视频尺寸或时长区块不完整', 'bxagi_invalid_artifact');
          const width = view.getUint32(header.start + (headerVersion === 1 ? 88 : 76)) / 65536,
            height = view.getUint32(header.start + (headerVersion === 1 ? 92 : 80)) / 65536;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || width * height > 16777216) throw fail(422, 'MP4视频实际尺寸无效', 'bxagi_invalid_artifact');
          const timescale = view.getUint32(timing.start + (timingVersion === 1 ? 20 : 12)),
            ticks = timingVersion === 1 ? view.getBigUint64(timing.start + 24) : BigInt(view.getUint32(timing.start + 16)),
            unknown = timingVersion === 1 ? 0xffffffffffffffffn : 0xffffffffn;
          if (timescale === 0 || ticks === 0n || ticks === unknown || ticks > BigInt(Number.MAX_SAFE_INTEGER)) throw fail(422, 'MP4视频实际时长缺失或无效', 'bxagi_invalid_artifact');
          const duration = Number(ticks) / timescale;
          if (!Number.isFinite(duration) || duration <= 0) throw fail(422, 'MP4视频实际时长无效', 'bxagi_invalid_artifact');
          videos.push({
            width,
            height,
            duration
          });
        }
      }
      offset = box.end;
    }
    if (!ftyp || !moov || !mdat || videos.length !== 1) throw fail(422, 'MP4缺少完整视频轨道或媒体数据', 'bxagi_invalid_artifact');
    return {
      ...videos[0],
      technicalChecks: {
        mp4Structure: true,
        fullDecode: false
      }
    };
  }
  if (mime === 'text/plain') {
    if (!bytes.length || bytes.includes(0)) throw fail(422, '员工文案文件为空或不是纯文本', 'bxagi_invalid_artifact');
    return {};
  }
  throw fail(422, '员工成果暂支持PNG、MP4和纯文本文件', 'bxagi_unsupported_artifact');
}
