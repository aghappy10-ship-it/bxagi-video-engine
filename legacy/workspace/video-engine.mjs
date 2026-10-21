/* Real local video production using native browser media APIs. */
const supportedMime = () => ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
function mediaError(video) {
  const code = video.error?.code;
  return new Error(code === 4 ? '浏览器不支持此视频编码。请使用 H.264 MP4，或在生产服务中转码。' : '视频无法解码，请检查文件是否完整。');
}
function onceMedia(video, event, timeoutMs = 20_000, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener('error', fail);
      signal?.removeEventListener('abort', abort);
    };
    const success = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(mediaError(video));
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('导出已取消', 'AbortError'));
    };
    if (signal?.aborted) {
      reject(new DOMException('导出已取消', 'AbortError'));
      return;
    }
    video.addEventListener(event, success, {
      once: true
    });
    video.addEventListener('error', fail, {
      once: true
    });
    signal?.addEventListener('abort', abort, {
      once: true
    });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('读取视频超时，请检查文件或改用生产服务。'));
    }, timeoutMs);
  });
}
export async function inspectVideo(file) {
  if (!(file instanceof Blob) || !file.size) throw new Error('请选择有效的视频文件。');
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.playsInline = true;
  const url = URL.createObjectURL(file);
  try {
    const ready = onceMedia(video, 'loadedmetadata');
    video.src = url;
    await ready;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
      throw new Error('未能读取有效的视频时长或尺寸，请使用标准 MP4 或生产服务转码。');
    }
    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      url,
      hasVideo: true
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
export async function renderBrowserClip(file, clip, options = {}) {
  if (!(file instanceof Blob) || !file.size) throw new Error('请重新选择原片。视频文件不会保存在工作区备份中。');
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) throw new Error('此浏览器不支持本地视频导出。请使用桌面 Chrome/Edge，或部署 FFmpeg 生产服务。');
  if (document.hidden) throw new Error('请保持工作台在前台，再开始本地导出。');
  const start = Number(clip?.start),
    end = Number(clip?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('片段的开始和结束时间无效。');
  if (end - start > 600) throw new Error('浏览器单片段导出限制为 10 分钟；长素材请使用生产服务。');
  const mimeType = supportedMime();
  if (!mimeType) throw new Error('此浏览器没有可用的视频录制编码器。请使用生产服务。');
  const sizes = {
    landscape: [1280, 720],
    portrait: [720, 1280],
    square: [720, 720]
  };
  const [width, height] = sizes[options.format] || sizes.landscape;
  const signal = options.signal;
  if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.loop = false;
  const url = URL.createObjectURL(file);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', {
    alpha: false
  });
  if (!ctx) {
    URL.revokeObjectURL(url);
    throw new Error('无法初始化视频画布。');
  }
  const AudioClass = window.AudioContext || window.webkitAudioContext;
  let audioContext, canvasStream, mixedStream, recorder, frameHandle, watchdog, cleanupAbort;
  try {
    if (!AudioClass) throw new Error('此浏览器不支持本地音频采集，请使用生产服务。');
    // Resume from the export button's user gesture, before asynchronous metadata work.
    audioContext = new AudioClass();
    await audioContext.resume();
    const ready = onceMedia(video, 'loadeddata', 30_000, signal);
    video.src = url;
    await ready;
    if (!Number.isFinite(video.duration) || end > video.duration + .02) throw new Error('片段超出原片时长。');
    if (start > 0) {
      const seek = onceMedia(video, 'seeked', 20_000, signal);
      video.currentTime = start;
      await seek;
    }
    const source = audioContext.createMediaElementSource(video),
      audioOutput = audioContext.createMediaStreamDestination();
    source.connect(audioOutput); // No speaker destination: audio is recorded without duplicate playback.
    canvasStream = canvas.captureStream(30);
    mixedStream = new MediaStream([...canvasStream.getVideoTracks(), ...audioOutput.stream.getAudioTracks()]);
    const scale = Math.min(width / video.videoWidth, height / video.videoHeight),
      w = video.videoWidth * scale,
      h = video.videoHeight * scale;
    const draw = () => {
      ctx.fillStyle = '#080f1e';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
    };
    draw();
    recorder = new MediaRecorder(mixedStream, {
      mimeType,
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 128_000
    });
    const chunks = [];
    let finished = false,
      failure = null,
      lastTime = start,
      lastMotion = performance.now();
    const stop = error => {
      if (finished) return;
      finished = true;
      failure = error || null;
      video.pause();
      if (recorder.state !== 'inactive') recorder.stop();
    };
    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', event => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener('stop', () => failure ? reject(failure) : resolve());
      recorder.addEventListener('error', event => stop(event.error || new Error('浏览器视频录制失败。')));
    });
    cleanupAbort = () => stop(new DOMException('导出已取消', 'AbortError'));
    signal?.addEventListener('abort', cleanupAbort, {
      once: true
    });
    video.addEventListener('error', () => stop(mediaError(video)), {
      once: true
    });
    video.addEventListener('ended', () => stop(), {
      once: true
    });
    const progress = () => {
      if (finished) return;
      draw();
      if (video.currentTime > lastTime + .01) {
        lastTime = video.currentTime;
        lastMotion = performance.now();
      }
      options.onProgress?.(Math.min(99, (video.currentTime - start) / (end - start) * 100));
      if (video.currentTime >= end - .015) {
        stop();
        return;
      }
      frameHandle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(progress) : requestAnimationFrame(progress);
    };
    if (signal?.aborted) throw new DOMException('导出已取消', 'AbortError');
    recorder.start(250);
    options.onProgress?.(0);
    // Start playback and recording as one sequence; errors always stop the recorder.
    try {
      await video.play();
    } catch (e) {
      stop(new Error('浏览器阻止了媒体播放。请重新点击导出，或使用生产服务。'));
    }
    progress();
    const begin = performance.now();
    watchdog = setInterval(() => {
      if (document.hidden) stop(new Error('导出期间工作台进入后台，本次草稿已停止。请保持页面前台后重试。'));else if (performance.now() - lastMotion > 15_000) stop(new Error('原片播放停滞，导出停止。请检查视频编码或使用生产服务。'));else if (performance.now() - begin > (end - start) * 1000 + 30_000) stop(new Error('导出时间超出预期，请使用生产服务。'));
    }, 500);
    await stopped;
    const blob = new Blob(chunks, {
      type: recorder.mimeType || mimeType
    });
    if (blob.size < 1024) throw new Error('导出的文件为空或过小，请改用生产服务。');
    // Reopen encoded data; do not treat a successful recorder event as media validation.
    const output = document.createElement('video'),
      outputUrl = URL.createObjectURL(blob);
    output.preload = 'metadata';
    let actualDuration = null;
    try {
      const metadata = onceMedia(output, 'loadedmetadata', 20_000, signal);
      output.src = outputUrl;
      await metadata;
      if (!output.videoWidth || !output.videoHeight) throw new Error('导出草稿无法重新打开。');
      if (Number.isFinite(output.duration) && output.duration > 0) actualDuration = output.duration;
    } finally {
      output.removeAttribute('src');
      output.load();
      URL.revokeObjectURL(outputUrl);
    }
    options.onProgress?.(100);
    return {
      blob,
      mimeType: blob.type,
      extension: blob.type.includes('mp4') ? 'mp4' : 'webm',
      duration: actualDuration,
      requestedDuration: end - start,
      validation: 'browser-metadata-only',
      width,
      height
    };
  } finally {
    clearInterval(watchdog);
    signal?.removeEventListener('abort', cleanupAbort);
    if (frameHandle != null) {
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);else cancelAnimationFrame(frameHandle);
    }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    video.pause();
    video.removeAttribute('src');
    video.load();
    mixedStream?.getTracks().forEach(track => track.stop());
    canvasStream?.getTracks().forEach(track => track.stop());
    if (audioContext && audioContext.state !== 'closed') await audioContext.close();
    URL.revokeObjectURL(url);
  }
}
