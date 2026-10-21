"""SRT parsing, conservative complete-sentence planning, and boundary gates."""
from __future__ import annotations

import re
import uuid
from .common import APIError, BOUNDARY_TOLERANCE, number

SENTENCE_END = re.compile(r'[.!?。！？…][\s"\'”’」』）)]*$')

def stamp(value):
    match = re.fullmatch(r"(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})", value.strip())
    if not match:
        raise APIError(400, "SRT 时间必须为 HH:MM:SS,mmm")
    h, m, s, ms = map(int, match.groups())
    if m >= 60 or s >= 60:
        raise APIError(400, "SRT 时间中的分秒无效")
    return h * 3600 + m * 60 + s + ms / 1000

def parse_srt(value, duration=None):
    if not isinstance(value, str) or not value.strip():
        raise APIError(400, "请提供非空 SRT 字幕")
    if len(value.encode("utf-8")) > 2 * 1024 * 1024:
        raise APIError(413, "SRT 最大 2 MB")
    blocks = re.split(r"\n\s*\n", value.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n").strip())
    segments = []
    for block in blocks:
        lines = block.splitlines()
        if lines and lines[0].strip().isdigit():
            lines = lines[1:]
        if len(lines) < 2 or "-->" not in lines[0]:
            raise APIError(400, "SRT 字幕块缺少时间或文本")
        parts = lines[0].split("-->")
        if len(parts) != 2:
            raise APIError(400, "SRT 时间格式无效")
        start, end = stamp(parts[0]), stamp(parts[1].split()[0])
        text = re.sub(r"<[^>]+>", "", " ".join(line.strip() for line in lines[1:])).strip()
        if not text or end <= start:
            raise APIError(400, "SRT 字幕文本为空或结束时间不晚于开始时间")
        if segments and start < segments[-1]["end"] - 0.001:
            raise APIError(400, "SRT 字幕必须按时间排序，且不能重叠")
        if duration is not None and end > duration + 0.05:
            raise APIError(400, "SRT 字幕超出视频时长")
        segments.append({"id": len(segments) + 1, "start": start, "end": end, "text": text})
    if len(segments) > 10000:
        raise APIError(413, "SRT 字幕最多 10,000 条")
    return segments

def sentences(segments):
    """Conservative imported-transcript boundary rule, not semantic NLP."""
    groups, pending = [], []
    for segment in segments:
        pending.append(segment)
        if SENTENCE_END.search(segment["text"]):
            groups.append({"start": pending[0]["start"], "end": pending[-1]["end"],
                           "text": " ".join(item["text"] for item in pending)})
            pending = []
    return groups

def plan_clips(segments, duration, options):
    count = int(number(options.get("count", 3), "count", 1, 30))
    minimum = number(options.get("min_duration", 5), "min_duration", 0.1, 600)
    maximum = number(options.get("max_duration", 45), "max_duration", minimum, 600)
    strategy = options.get("strategy", "hook")
    if strategy not in ("hook", "narrative", "selling", "chronological", "balanced", "summary", "complete"):
        raise APIError(400, "不支持的剪辑策略")
    groups = sentences(segments)
    clips, i = [], 0
    while i < len(groups) and len(clips) < count:
        first, j = groups[i], i
        while j + 1 < len(groups) and groups[j]["end"] - first["start"] < minimum:
            if groups[j + 1]["end"] - first["start"] > maximum:
                break
            j += 1
        length = groups[j]["end"] - first["start"]
        if minimum <= length <= maximum and groups[j]["end"] <= duration + 0.05:
            text = " ".join(group["text"] for group in groups[i:j + 1])
            clips.append({"id": uuid.uuid4().hex, "title": text[:42], "start": first["start"],
                          "end": groups[j]["end"], "text": text, "strategy": strategy,
                          "score": None})
            i = j + 1
        else:
            i += 1
    return clips

def sentence_gate(clips, segments, duration):
    errors = []
    if not segments:
        return {"name": "sentence_boundary", "status": "unverified", "detail": "未导入 SRT，无法核验完整句边界；禁止正式导出下载"}, ["缺少字幕，句边界未验证"]
    groups = sentences(segments)
    starts = [group["start"] for group in groups]
    ends = [group["end"] for group in groups]
    for i, clip in enumerate(clips, 1):
        if not any(abs(clip["start"] - value) <= BOUNDARY_TOLERANCE for value in starts):
            errors.append(f"片段 {i} 起点不在已核验完整句边界")
        if not any(abs(clip["end"] - value) <= BOUNDARY_TOLERANCE for value in ends):
            errors.append(f"片段 {i} 终点不在已核验完整句边界")
        if clip["end"] > duration + BOUNDARY_TOLERANCE:
            errors.append(f"片段 {i} 超出视频时长")
    return {"name": "sentence_boundary", "status": "fail" if errors else "pass",
            "detail": "; ".join(errors) if errors else "各片段始末匹配导入字幕的完整句边界（标点规则；不验证转写准确性）"}, errors

def srt_time(value):
    millis = max(0, round(value * 1000))
    seconds, ms = divmod(millis, 1000)
    minutes, secs = divmod(seconds, 60)
    hours, mins = divmod(minutes, 60)
    return f"{hours:02d}:{mins:02d}:{secs:02d},{ms:03d}"
