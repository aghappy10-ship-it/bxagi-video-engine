import { formatProfiles } from './creative-engine.mjs';

const themes = {
  ink: { background: '#13202b', foreground: '#ffffff', muted: '#c7d2dd', accent: '#f3c858' },
  paper: { background: '#f4f2ec', foreground: '#162b31', muted: '#52646a', accent: '#186d67' },
  indigo: { background: '#1d2448', foreground: '#ffffff', muted: '#d0d5ed', accent: '#c3d5ff' },
};

/** Pure geometry helper also used by tests. Contain keeps the entire source. */
export function computeImagePlacement(sourceWidth, sourceHeight, bounds, fit = 'contain') {
  if (![sourceWidth, sourceHeight, bounds?.width, bounds?.height].every(value => Number.isFinite(value) && value > 0)
    || !Number.isFinite(bounds?.x) || !Number.isFinite(bounds?.y)) throw new Error('图片尺寸或画布边界无效。');
  if (!['contain', 'cover'].includes(fit)) throw new Error('未知的图片适配方式。');
  const scale = fit === 'cover' ? Math.max(bounds.width / sourceWidth, bounds.height / sourceHeight)
    : Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight);
  const width = sourceWidth * scale, height = sourceHeight * scale;
  return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height, scale };
}

function assertSource(sourceBlob, prefix) {
  if (typeof Blob === 'undefined' || !(sourceBlob instanceof Blob) || !sourceBlob.size) throw new Error('需要上传的真实素材文件。');
  if (!sourceBlob.type.startsWith(prefix)) throw new Error(`此处理器需要 ${prefix === 'image/' ? '图片' : '视频'}文件，当前类型不受支持。`);
}
function aborted(signal) {
  if (signal?.aborted) throw new DOMException('素材生成已取消。', 'AbortError');
}
async function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  if (typeof Image === 'undefined') throw new Error('当前运行环境不支持图片解码。');
  const url = URL.createObjectURL(blob), image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('原始图片无法解码，请检查文件是否完整。'));
      image.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

function linesForText(ctx, value, maxWidth, maxLines) {
  const lines = [];
  let current = '';
  for (const character of Array.from(String(value || '').slice(0, 20_000))) {
    if (character === '\n') { lines.push(current); current = ''; }
    else if (current && ctx.measureText(current + character).width > maxWidth) { lines.push(current); current = character; }
    else current += character;
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && current) lines.push(current);
  // Ellipsis reflects omission only; copy never gets invented to fill a design.
  if (lines.join('').length < String(value || '').replaceAll('\n', '').length && lines.length) {
    let last = lines.at(-1);
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}
function drawText(ctx, value, { x, y, width, size, color, maxLines = 2, weight = 600 }) {
  ctx.fillStyle = color;
  ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'top';
  const lines = linesForText(ctx, value, width, maxLines);
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * size * 1.32));
  return lines.length * size * 1.32;
}

/** Real raster output from source bytes. No vision/AI content alteration is claimed. */
export async function renderImageCreative({ sourceBlob, variant, onProgress, signal } = {}) {
  assertSource(sourceBlob, 'image/');
  if (!formatProfiles[variant?.format]) throw new Error('素材画幅无效。');
  if (variant?.processing?.supported === false) throw new Error('此员工不支持当前素材处理能力。');
  if (typeof document === 'undefined') throw new Error('图片版式生成需要浏览器画布。');
  aborted(signal);
  onProgress?.(0);
  let source;
  try {
    source = await decodeImage(sourceBlob);
    if (!source.width || !source.height) throw new Error('原始图片尺寸无效。');
    aborted(signal);
    onProgress?.(20);
    const { width, height } = formatProfiles[variant.format];
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法初始化图片画布。');
    const theme = themes[variant.layout?.theme] || themes.ink;
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);
    const landscape = variant.format === 'landscape', square = variant.format === 'square';
    const panel = landscape ? { x: 64, y: 64, width: 1120, height: 952 }
      : square ? { x: 64, y: 224, width: 952, height: 610 }
        : { x: 64, y: 260, width: 952, height: 1280 };
    const placed = computeImagePlacement(source.width, source.height, panel, variant.layout?.fit || 'contain');
    ctx.save();
    ctx.beginPath(); ctx.rect(panel.x, panel.y, panel.width, panel.height); ctx.clip();
    ctx.drawImage(source.image, placed.x, placed.y, placed.width, placed.height);
    ctx.restore();
    onProgress?.(60);
    const copyX = landscape ? 1248 : 64, copyWidth = landscape ? 608 : 952;
    const headlineHeight = drawText(ctx, variant.headline || '', {
      x: copyX, y: landscape ? 164 : 64, width: copyWidth, size: square ? 54 : 64,
      color: theme.foreground, maxLines: 2,
    });
    const bodyY = landscape ? 204 + headlineHeight : square ? 866 : 1588;
    drawText(ctx, variant.body || '', { x: copyX, y: bodyY, width: copyWidth, size: square ? 30 : 34, color: theme.muted, maxLines: landscape ? 7 : 2, weight: 400 });
    const ctaY = landscape ? 866 : square ? 994 : 1800;
    drawText(ctx, variant.cta || '', { x: copyX, y: ctaY, width: copyWidth, size: 32, color: theme.accent, maxLines: 1 });
    aborted(signal);
    const blob = await new Promise((resolve, reject) => canvas.toBlob(value => value?.size ? resolve(value) : reject(new Error('图片导出失败，没有产生实际文件。')), 'image/png'));
    if (blob.type !== 'image/png') throw new Error('浏览器未产生预期的 PNG 文件。');
    aborted(signal);
    onProgress?.(100);
    return { blob, mimeType: 'image/png', extension: 'png', width, height, validation: 'browser-metadata', sourceWidth: source.width, sourceHeight: source.height, fit: variant.layout?.fit || 'contain' };
  } finally { source?.close(); }
}

/** A real clip requires known timestamps; metadata classification does not infer them. */
export async function renderVideoCreative({ sourceBlob, variant, clip, onProgress, signal } = {}) {
  assertSource(sourceBlob, 'video/');
  if (!formatProfiles[variant?.format]) throw new Error('素材画幅无效。');
  if (variant?.processing?.supported === false) throw new Error('此员工不支持当前素材处理能力。');
  if (!Number.isFinite(clip?.start) || !Number.isFinite(clip?.end) || clip.start < 0 || clip.end <= clip.start) throw new Error('需要明确的视频片段起止时间；自动语义选段尚未配置。');
  if (typeof document === 'undefined') throw new Error('视频剪辑生成需要浏览器媒体接口。');
  aborted(signal);
  const { renderBrowserClip } = await import('../legacy/workspace/video-engine.mjs');
  const output = await renderBrowserClip(sourceBlob, clip, { format: variant.format, onProgress, signal });
  return { ...output, validation: 'browser-metadata', clip: { start: clip.start, end: clip.end }, appliedOperations: ['trim', 'fit', 'browser-encode'], copyApplied: false };
}
