"""FFmpeg dependency detection, media limits, encoding, and decode verification."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import threading
from .common import APIError, BOUNDARY_TOLERANCE, FORMATS, MEDIA_FORMATS
from .transcripts import srt_time


class MediaEngine:
    def __init__(self, data_dir, stop):
        self.data_dir = data_dir
        self.stop = stop
        self.ffmpeg, self.ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        self.subtitle_filter = False
        self.cjk_font_available = False
        if self.ffmpeg:
            try:
                filters = subprocess.run([self.ffmpeg, "-hide_banner", "-filters"], capture_output=True, timeout=10)
                self.subtitle_filter = b" subtitles " in filters.stdout
            except (OSError, subprocess.TimeoutExpired):
                pass
        font_list = shutil.which("fc-list")
        if font_list:
            try:
                fonts = subprocess.run([font_list, ":lang=zh", "--format", "%{family}\n"], capture_output=True, timeout=5)
                self.cjk_font_available = bool(fonts.returncode == 0 and fonts.stdout.strip())
            except (OSError, subprocess.TimeoutExpired):
                pass
        elif os.name == "nt":
            fonts_dir = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
            self.cjk_font_available = any((fonts_dir / name).is_file() for name in ("msyh.ttc", "msyh.ttf", "simsun.ttc", "simhei.ttf"))
        self.process_lock = threading.Lock()
        self.processes = {}

    def probe(self, path):
        if not self.ffprobe:
            raise APIError(503, "未安装 ffprobe，请安装 FFmpeg 并确保 ffprobe 在 PATH 中")
        try:
            result = subprocess.run([self.ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS, "-show_streams", "-show_format", "-of", "json", str(path)],
                                    capture_output=True, timeout=30, check=False)
            if result.returncode:
                raise ValueError("probe failed")
            data = json.loads(result.stdout)
            video = next(stream for stream in data["streams"] if stream["codec_type"] == "video" and not stream.get("disposition", {}).get("attached_pic"))
            duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
            width, height = int(video["width"]), int(video["height"])
            if not math.isfinite(duration) or duration <= 0 or duration > 43200 or width <= 0 or height <= 0 or width * height > 100_000_000:
                raise ValueError("invalid media limits")
            return {"duration": duration, "width": width, "height": height,
                    "has_audio": any(stream["codec_type"] == "audio" for stream in data["streams"])}
        except (ValueError, KeyError, StopIteration, subprocess.TimeoutExpired):
            raise APIError(422, "视频无法解析、缺少有效视频流或超出媒体限制（最长 12 小时）")

    def run_process(self, args, job_id, timeout=600):
        if self.stop.is_set():
            raise RuntimeError("服务正在停止，任务已中断")
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with self.process_lock:
            self.processes[job_id] = process
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            if process.returncode != 0:
                # Internal paths and user filenames never enter the user-facing log.
                raise RuntimeError(f"FFmpeg 处理失败（退出码 {process.returncode}）；请检查媒体与依赖")
            if self.stop.is_set():
                raise RuntimeError("服务停止导致任务中断")
            return stdout
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise RuntimeError("FFmpeg 超过单步骤 10 分钟限制，请缩短素材")
        finally:
            with self.process_lock:
                self.processes.pop(job_id, None)

    def render(self, job, asset, segments, job_id):
        """Encode, merge, probe, and fully decode; return only verified media."""
        work = self.data_dir / "work" / job_id
        work.mkdir(exist_ok=True)
        output = self.data_dir / "outputs" / f"{job_id}.mp4"
        width, height = FORMATS[job["format"]]
        expected = sum(clip["end"] - clip["start"] for clip in job["clips"])
        try:
            parts = []
            for i, clip in enumerate(job["clips"]):
                part = work / f"part-{i:03d}.mp4"
                filter_ = f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1"
                if job["burn_subtitles"]:
                    subtitle = work / f"part-{i:03d}.srt"
                    selected = [item for item in segments if item["start"] >= clip["start"] - BOUNDARY_TOLERANCE and item["end"] <= clip["end"] + BOUNDARY_TOLERANCE]
                    subtitle.write_text("\n\n".join(f"{n + 1}\n{srt_time(item['start'] - clip['start'])} --> {srt_time(item['end'] - clip['start'])}\n{item['text']}" for n, item in enumerate(selected)) + "\n", encoding="utf-8")
                    escaped = str(subtitle).replace("\\", "\\\\").replace(":", "\\:").replace("'", "'\\''")
                    filter_ += f",subtitles=filename='{escaped}'"
                args = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-format_whitelist", MEDIA_FORMATS,
                        "-ss", f"{clip['start']:.6f}", "-i", asset["path"], "-t", f"{clip['end'] - clip['start']:.6f}", "-map", "0:V:0", "-map", "0:a:0?",
                        "-vf", filter_, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-threads", "1",
                        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-movflags", "+faststart", str(part)]
                self.run_process(args, job_id)
                parts.append(part)
            manifest = work / "concat.txt"
            # Relative controlled filenames avoid user paths in concat syntax.
            manifest.write_text("".join(f"file '{part.name}'\n" for part in parts), encoding="utf-8")
            self.run_process([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", str(manifest), "-c", "copy", "-movflags", "+faststart", str(output)], job_id)
            metadata = self.probe(output)
            if metadata["width"] != width or metadata["height"] != height or abs(metadata["duration"] - expected) > max(0.3, len(parts) * 0.08):
                raise RuntimeError("导出时长或画幅不符，媒体门禁拒绝")
            self.run_process([self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-err_detect", "explode", "-threads", "1", "-i", str(output), "-map", "0:v:0", "-map", "0:a:0?", "-f", "null", "-"], job_id)
            return output, metadata
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def close(self):
        self.stop.set()
        with self.process_lock:
            for process in list(self.processes.values()):
                process.terminate()
