#!/usr/bin/env python3
"""Trusted, bounded FFmpeg compute and ad monitoring runner (Python stdlib only)."""
from __future__ import annotations

import argparse
from http import client as http_client
import json
import math
import os
from pathlib import Path
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib import error, parse, request

MAX_BYTES = 64 * 1024 * 1024
MAX_JSON = 256 * 1024
FORMATS = {"portrait": (720, 1280), "square": (720, 720), "landscape": (1280, 720)}
JOB_PATH = re.compile(r"^/api/v2/worker/jobs/[a-f0-9-]{36}/(source|complete|fail)$")


class RunnerError(Exception):
    """Only fixed, non-sensitive messages reach logs and the failure endpoint."""


class AuthenticationError(RunnerError):
    pass


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A redirect could send the service bearer to another origin.
        raise RunnerError("HTTP redirect rejected")


def event(name, **values):
    print(json.dumps({"event": name, **values}, ensure_ascii=False), flush=True)


def bounded_number(value, name, minimum, maximum):
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise RunnerError(f"Invalid {name}") from None
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise RunnerError(f"Invalid {name}")
    return result


class Client:
    def __init__(self, base_url, secret, site_token="", timeout=45):
        try:
            parsed = parse.urlsplit(base_url)
            parsed.port  # Validate malformed or out-of-range ports before any request.
        except ValueError:
            raise RunnerError("Invalid base URL") from None
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if parsed.scheme not in {"http", "https"} or (parsed.scheme != "https" and not local):
            raise RunnerError("Base URL must use HTTPS (HTTP is allowed only for localhost)")
        if not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise RunnerError("Invalid base URL")
        if parsed.path not in {"", "/", "/api/v2", "/api/v2/"}:
            raise RunnerError("Base URL must be the site origin or /api/v2")
        if not secret or any(c in secret + site_token for c in "\r\n"):
            raise RunnerError("APP_WORKER_SECRET is missing or invalid")
        self.origin = parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        self.secret, self.site_token, self.timeout = secret, site_token, timeout
        self.opener = request.build_opener(NoRedirect())

    def open(self, path, *, method="GET", data=None, headers=None):
        if path not in {"/api/v2/worker/tick", "/api/v2/worker/bxagi-tick", "/api/v2/worker/claim"} and not JOB_PATH.fullmatch(path):
            raise RunnerError("Invalid worker endpoint")
        h = {"Authorization": f"Bearer {self.secret}", "User-Agent": "BXAGI-Compute/2.0"}
        if self.site_token:
            h["OAI-Sites-Authorization"] = f"Bearer {self.site_token}"
        h.update(headers or {})
        try:
            return self.opener.open(request.Request(self.origin + path, data=data, headers=h, method=method), timeout=self.timeout)
        except error.HTTPError as exc:
            status = exc.code
            exc.close()
            if status in {401, 403}:
                raise AuthenticationError("Worker or site service authentication rejected") from None
            raise RunnerError(f"Worker HTTP status {status}") from None
        except (error.URLError, OSError, TimeoutError, http_client.HTTPException):
            raise RunnerError("Worker network request failed") from None

    def read_response(self, response, limit):
        chunks, total, started = [], 0, time.monotonic()
        length = response.headers.get("Content-Length")
        if length is not None:
            try:
                declared = int(length)
            except ValueError:
                raise RunnerError("Invalid worker response length") from None
            if not 0 <= declared <= limit:
                raise RunnerError("Worker response exceeds configured limit")
        else:
            declared = None
        try:
            read = getattr(response, "read1", response.read)
            while True:
                part = read(min(64 * 1024, limit + 1 - total))
                if not part:
                    break
                chunks.append(part)
                total += len(part)
                if total > limit or time.monotonic() - started > self.timeout * 2:
                    raise RunnerError("Worker response exceeds configured limit")
        except (error.URLError, OSError, TimeoutError, http_client.HTTPException):
            raise RunnerError("Worker response read failed") from None
        if declared is not None and total != declared:
            raise RunnerError("Worker response is incomplete")
        return b"".join(chunks)

    def json(self, path, body, *, headers=None):
        data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()
        with self.open(path, method="POST", data=data, headers={"Content-Type": "application/json", "Content-Length": str(len(data)), **(headers or {})}) as response:
            raw = self.read_response(response, MAX_JSON)
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise RunnerError("Invalid worker JSON response") from None
        if not isinstance(value, dict):
            raise RunnerError("Invalid worker response object")
        return value

    def download(self, job, target):
        started = time.monotonic()
        with self.open(job["sourcePath"], headers={"X-Job-Lease": job["leaseId"]}) as response:
            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    declared = int(length)
                except ValueError:
                    raise RunnerError("Invalid source content length") from None
                if declared <= 0 or declared > MAX_BYTES:
                    raise RunnerError("Source exceeds 64 MiB")
            else:
                declared = None
            size = 0
            with target.open("wb") as output:
                try:
                    read = getattr(response, "read1", response.read)
                    while True:
                        chunk = read(64 * 1024)
                        if not chunk:
                            break
                        size += len(chunk)
                        if size > MAX_BYTES or time.monotonic() - started > self.timeout * 2:
                            raise RunnerError("Source transfer exceeds configured limit")
                        output.write(chunk)
                except (error.URLError, OSError, TimeoutError, http_client.HTTPException):
                    raise RunnerError("Source transfer failed") from None
        if size <= 0 or (declared is not None and size != declared):
            raise RunnerError("Source transfer is incomplete")

    def complete(self, job, output, metadata):
        size = output.stat().st_size
        if not 1024 <= size <= MAX_BYTES:
            raise RunnerError("Output must be 1 KiB to 64 MiB")
        headers = {"X-Job-Lease": job["leaseId"], "Content-Type": "video/mp4", "Content-Length": str(size),
                   "X-Result-Metadata": parse.quote(json.dumps(metadata, separators=(",", ":")), safe="")}
        with output.open("rb") as body:
            with self.open(job["completePath"], method="POST", data=body, headers=headers) as response:
                raw = self.read_response(response, MAX_JSON)
        try:
            result = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise RunnerError("Invalid completion response") from None
        if not isinstance(result, dict) or not isinstance(result.get("creative"), dict):
            raise RunnerError("Completion did not return a stored creative")
        return result["creative"].get("id")


def run_process(argv, deadline, description, stop_event=None):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RunnerError("Media processing deadline exceeded")
    # Temporary files avoid unbounded pipe buffers from a broken media file.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        try:
            process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
        except OSError:
            raise RunnerError("FFmpeg or ffprobe could not start") from None
        try:
            while process.poll() is None:
                if stop_event is not None and stop_event.is_set():
                    raise AuthenticationError("Monitoring authentication rejected")
                if time.monotonic() >= deadline:
                    raise RunnerError("Media processing deadline exceeded")
                time.sleep(.2)
            if process.returncode:
                raise RunnerError(f"{description} failed")
            stdout.seek(0)
            return stdout.read(MAX_JSON + 1)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


def probe(path, deadline, stop_event=None):
    raw = run_process(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-format_whitelist", "mov,matroska,webm",
                       "-show_entries", "stream=index,codec_type,width,height,duration,avg_frame_rate:format=duration",
                       "-of", "json", str(path)], deadline, "Media inspection", stop_event)
    if len(raw) > MAX_JSON:
        raise RunnerError("Media inspection output exceeds limit")
    try:
        value = json.loads(raw)
        streams = value.get("streams", [])
        video = next(s for s in streams if s.get("codec_type") == "video")
        width, height = int(video["width"]), int(video["height"])
        duration = bounded_number(value.get("format", {}).get("duration", video.get("duration")), "video duration", .01, 7200)
        if not 16 <= width <= 8192 or not 16 <= height <= 8192 or width * height > 33554432:
            raise RunnerError("Video dimensions exceed supported limit")
    except (KeyError, TypeError, ValueError, StopIteration):
        raise RunnerError("Source has no supported video stream") from None
    return {"width": width, "height": height, "duration": duration,
            "audio": any(s.get("codec_type") == "audio" for s in streams)}


def render(source, output, recipe, deadline, stop_event=None):
    info = probe(source, deadline, stop_event)
    format_name = recipe.get("format", "portrait")
    if format_name not in FORMATS or recipe.get("semanticCut", False) is not False:
        raise RunnerError("Unsupported video recipe")
    width, height = FORMATS[format_name]
    start, duration = 0.0, info["duration"]
    trim = recipe.get("trim")
    if trim is not None:
        if not isinstance(trim, dict) or trim.get("basis") != "explicit_timestamps" or recipe.get("preserveFullVideo") is not False:
            raise RunnerError("Video trims require explicit timestamps")
        start = bounded_number(trim.get("startSeconds"), "trim start", 0, info["duration"])
        end = bounded_number(trim.get("endSeconds"), "trim end", start + .01, info["duration"])
        duration = end - start
    elif recipe.get("preserveFullVideo") is False:
        raise RunnerError("Missing explicit video timestamps")
    # Cap average bitrate to leave headroom for the MP4 container within 64 MiB.
    audio_rate = 48000 if info["audio"] else 0
    video_rate = min(1800000, int(MAX_BYTES * .85 * 8 / duration) - audio_rate)
    if video_rate < 24000:
        raise RunnerError("Full video is too long for the 64 MiB output limit")
    filters = f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30"
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe",
            "-format_whitelist", "mov,matroska,webm", "-threads", "2", "-i", str(source)]
    if trim is not None:
        args += ["-ss", str(start), "-t", str(duration)]
    args += ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
             "-vf", filters, "-c:v", "libx264", "-preset", "veryfast", "-threads", "2", "-b:v", str(video_rate),
             "-maxrate", str(video_rate), "-bufsize", str(video_rate * 2), "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "48k", "-ac", "2", "-movflags", "+faststart", "-fs", str(MAX_BYTES), str(output)]
    run_process(args, deadline, "Video encoding", stop_event)
    if not output.exists() or not 1024 <= output.stat().st_size <= MAX_BYTES:
        raise RunnerError("Encoded video is outside upload limits")
    actual = probe(output, deadline, stop_event)
    if (actual["width"], actual["height"]) != (width, height) or abs(actual["duration"] - duration) > max(.3, duration * .002):
        raise RunnerError("Encoded video dimensions or duration did not match recipe")
    # Decode every output frame and audio sample. A header-only probe is insufficient.
    run_process(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-protocol_whitelist", "file,pipe",
                 "-format_whitelist", "mov", "-threads", "2", "-i", str(output), "-map", "0:v:0", "-map", "0:a:0?",
                 "-f", "null", "-"], deadline, "Full output decode", stop_event)
    return {"fullDecodePassed": True, "width": actual["width"], "height": actual["height"], "duration": actual["duration"]}


def validate_job(job):
    if not isinstance(job, dict) or job.get("type") != "video_optimize" or not isinstance(job.get("recipe"), dict):
        raise RunnerError("Unsupported worker job")
    if not re.fullmatch(r"[a-f0-9-]{36}", str(job.get("id", ""))) or not re.fullmatch(r"[a-f0-9-]{36}", str(job.get("leaseId", ""))):
        raise RunnerError("Invalid worker job lease")
    for field, endpoint in (("sourcePath", "source"), ("completePath", "complete"), ("failPath", "fail")):
        if job.get(field) != f"/api/v2/worker/jobs/{job['id']}/{endpoint}":
            raise RunnerError("Invalid worker job endpoint")


def process_job(client, job, process_timeout, stop_event=None):
    validate_job(job)
    try:
        with tempfile.TemporaryDirectory(prefix="bxagi-compute-") as directory:
            source, output = Path(directory) / "source.media", Path(directory) / "creative.mp4"
            deadline = time.monotonic() + process_timeout
            client.download(job, source)
            metadata = render(source, output, job["recipe"], deadline, stop_event)
            if stop_event is not None and stop_event.is_set():
                raise AuthenticationError("Monitoring authentication rejected")
            client.complete(job, output, metadata)
        event("video_completed", width=metadata["width"], height=metadata["height"], duration=metadata["duration"], fullDecodePassed=True)
        return True
    except AuthenticationError:
        raise
    except (RunnerError, OSError, TimeoutError):
        # Do not include raw provider messages, paths, media metadata, or tokens in logs.
        try:
            client.json(job["failPath"], {"error": "视频处理未通过实际编码、完整解码或结果上传检查，请检查素材与执行器"}, headers={"X-Job-Lease": job["leaseId"]})
        except AuthenticationError:
            raise
        except RunnerError:
            event("failure_report_unavailable")
        event("video_failed")
        return False


def monitor_tick(client, channel="ads"):
    path = "/api/v2/worker/bxagi-tick" if channel == "bxagi" else "/api/v2/worker/tick"
    try:
        tick = client.json(path, {})
        processed = tick.get("processed", 0)
        if isinstance(processed, bool) or not isinstance(processed, (int, float)) or not math.isfinite(processed) or not 0 <= processed <= 100000:
            raise RunnerError("Invalid worker processed count")
        event(f"{channel}_monitor_tick", processed=int(processed))
        return True
    except AuthenticationError:
        raise
    except (RunnerError, ValueError, TypeError):
        event(f"{channel}_monitor_unavailable")
        return False


def cycle(client, process_timeout, limit, *, include_tick=True, include_bxagi=False, stop_event=None):
    failures = 0
    if include_tick:
        if not monitor_tick(client):
            failures += 1
    if include_bxagi:
        if not monitor_tick(client, "bxagi"):
            failures += 1
    claimed = client.json("/api/v2/worker/claim", {"capabilities": ["ffmpeg"], "limit": limit})
    jobs = claimed.get("jobs")
    if not isinstance(jobs, list) or len(jobs) > 5:
        raise RunnerError("Invalid worker job batch")
    # One lease per polling pass is the default; later jobs do not wait behind a long encode.
    for job in jobs:
        if stop_event is not None and stop_event.is_set():
            raise AuthenticationError("Monitoring authentication rejected")
        if not process_job(client, job, process_timeout, stop_event):
            failures += 1
    event("cycle_finished", claimed=len(jobs), failed=failures)
    return failures


def monitor_loop(client, poll, stop_event, channel="ads"):
    try:
        while not stop_event.is_set():
            started = time.monotonic()
            monitor_tick(client, channel)
            stop_event.wait(max(0, poll - (time.monotonic() - started)))
    except AuthenticationError:
        stop_event.set()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Run trusted video compute, ad monitoring and BXAGI task synchronization")
    parser.add_argument("--once", action="store_true", help="Process one polling pass and exit")
    parser.add_argument("--mode", choices=["all", "ads", "bxagi", "video"], default="all", help="Run all workers, ads monitoring only, BXAGI synchronization only, or video compute only")
    parser.add_argument("--poll-seconds", type=float)
    parser.add_argument("--process-timeout", type=float)
    parser.add_argument("--network-timeout", type=float)
    parser.add_argument("--limit", type=int, default=1, choices=[1], help="Claim one video per lease pass")
    args = parser.parse_args(argv)
    def stop_requested(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop_requested)
    stop_event = threading.Event()
    monitors = []
    try:
        poll = bounded_number(args.poll_seconds if args.poll_seconds is not None else os.environ.get("BXAGI_POLL_SECONDS", "30"), "poll interval", 5, 60)
        process_timeout = bounded_number(args.process_timeout if args.process_timeout is not None else os.environ.get("BXAGI_PROCESS_TIMEOUT", "900"), "processing timeout", 10, 1200)
        network_timeout = bounded_number(args.network_timeout if args.network_timeout is not None else os.environ.get("BXAGI_NETWORK_TIMEOUT", "45"), "network timeout", 1, 120)
        if args.mode in {"all", "video"} and (not shutil.which("ffmpeg") or not shutil.which("ffprobe")):
            raise RunnerError("FFmpeg and ffprobe must be installed")
        client = Client(os.environ.get("BXAGI_BASE_URL", ""), os.environ.get("APP_WORKER_SECRET", ""),
                        os.environ.get("SITES_SERVICE_TOKEN", ""), network_timeout)
        if not args.once and args.mode == "all":
            for channel in ("ads", "bxagi"):
                monitor_client = Client(os.environ.get("BXAGI_BASE_URL", ""), os.environ.get("APP_WORKER_SECRET", ""),
                                        os.environ.get("SITES_SERVICE_TOKEN", ""), network_timeout)
                monitor = threading.Thread(target=monitor_loop, args=(monitor_client, poll, stop_event, channel), name=f"bxagi-{channel}-monitor", daemon=True)
                monitors.append(monitor)
                monitor.start()
        while True:
            started = time.monotonic()
            try:
                if stop_event.is_set():
                    raise AuthenticationError("Monitoring authentication rejected")
                if args.mode in {"ads", "bxagi"}:
                    failures = 0 if monitor_tick(client, args.mode) else 1
                else:
                    failures = cycle(client, process_timeout, args.limit, include_tick=args.mode == "all" and args.once,
                                     include_bxagi=args.mode == "all" and args.once, stop_event=stop_event)
                if args.once:
                    return 1 if failures else 0
            except AuthenticationError:
                raise
            except RunnerError:
                event("poll_failed")
                if args.once:
                    return 1
            stop_event.wait(max(0, poll - (time.monotonic() - started)))
    except AuthenticationError:
        event("authentication_rejected")
        return 2
    except RunnerError as exc:
        event("configuration_rejected", reason=str(exc))
        return 2
    except KeyboardInterrupt:
        event("stopped")
        return 0
    finally:
        stop_event.set()
        for monitor in monitors:
            # Network I/O itself has a bounded timeout; this keeps shutdown responsive.
            monitor.join(timeout=1)


if __name__ == "__main__":
    sys.exit(main())
