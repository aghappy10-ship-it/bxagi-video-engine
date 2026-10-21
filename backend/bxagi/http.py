"""HTTP transport, authentication, browser guards, and static/file responses."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import mimetypes
import re
import shutil
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from .common import APIError, ID, VERSION, now
from .service import ai_adapter


class Handler(BaseHTTPRequestHandler):
    server_version = f"BXAGI/{VERSION}"

    def log_message(self, format_, *args):
        logging.info("%s %s", self.command, urllib.parse.urlsplit(self.path).path)

    @property
    def app(self):
        return self.server.app

    def send_headers(self, status, content_type, length, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        origin = self.headers.get("Origin")
        if origin and origin in self.server.allowed_origins:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def respond(self, value, status=200):
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_headers(status, "application/json; charset=utf-8", len(data))
        self.wfile.write(data)

    def auth(self):
        token = self.server.token
        if token and not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {token}"):
            raise APIError(401, "需要有效的 Authorization: Bearer API token")

    def origin_allowed(self, origin):
        return origin in self.server.allowed_origins or origin == "http://" + self.headers.get("Host", "")

    def browser_guard(self):
        # Tokenless localhost still needs CSRF and DNS-rebinding protection.
        host = urllib.parse.urlsplit("//" + self.headers.get("Host", "")).hostname
        if not self.server.token and host not in ("127.0.0.1", "localhost", "::1"):
            raise APIError(403, "本地无 token 模式只接受 loopback Host")
        origin = self.headers.get("Origin")
        if origin and not self.origin_allowed(origin):
            raise APIError(403, "请求来源未授权，请配置 BX_ALLOWED_ORIGINS 或使用服务同源工作台")

    def length(self, maximum):
        if self.headers.get("Transfer-Encoding"):
            raise APIError(411, "不支持分块上传，请提供 Content-Length")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise APIError(411, "需要 Content-Length")
        if length <= 0:
            raise APIError(400, "请求内容不能为空")
        if length > maximum:
            raise APIError(413, "请求体超出大小限制")
        return length

    def body(self):
        data = self.rfile.read(self.length(3 * 1024 * 1024))
        try:
            result = json.loads(data)
        except (ValueError, UnicodeDecodeError):
            raise APIError(400, "请求体必须为 UTF-8 JSON")
        if not isinstance(result, dict):
            raise APIError(400, "请求体必须是 JSON 对象")
        return result

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        if not origin or not self.origin_allowed(origin):
            self.respond({"error": "未配置此跨域来源"}, 403)
            return
        self.send_headers(204, "text/plain", 0, {"Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Filename"})

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        self.connection.settimeout(60)
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        try:
            if path == "/api/health" and method == "GET":
                self.respond({"ok": True, "service": "BXAGI", "version": VERSION, "ffmpeg": bool(self.app.ffmpeg), "ffprobe": bool(self.app.ffprobe), "auth_required": bool(self.server.token),
                              "llm_configured": ai_adapter.get_model_status()["configured"], "asr_configured": ai_adapter.get_asr_status()["configured"]})
                return
            if path.startswith("/api/"):
                self.browser_guard()
                self.auth()
                self.api(method, path)
            elif method == "GET":
                self.static(path)
            else:
                raise APIError(404, "接口不存在")
        except APIError as exc:
            self.close_connection = True
            self.respond({"error": exc.message}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (TimeoutError, OSError) as exc:
            self.close_connection = True
            try:
                self.respond({"error": "文件或请求读取失败，请重试"}, 500)
            except OSError:
                pass
        except Exception:
            logging.exception("Request failed")
            self.close_connection = True
            self.respond({"error": "服务内部错误，操作未完成"}, 500)

    def api(self, method, path):
        if path == "/api/capabilities" and method == "GET":
            self.respond(self.app.capabilities(self.server.max_upload))
            return
        if path == "/api/assets":
            if method == "GET":
                self.respond({"assets": self.app.list_assets()})
                return
            if method == "POST":
                self.upload()
                return
        match = re.fullmatch(f"/api/assets/({ID})/(transcript|plan|transcribe)", path)
        if match and method == "POST":
            operations = {"transcript": self.app.import_transcript,
                          "plan": self.app.plan_asset,
                          "transcribe": self.app.transcribe_asset}
            self.respond(operations[match[2]](match[1], self.body()))
            return
        if path == "/api/jobs":
            if method == "POST":
                self.respond(self.app.create_job(self.body()), 201)
                return
            if method == "GET":
                self.respond({"jobs": self.app.list_jobs()})
                return
        match = re.fullmatch(f"/api/jobs/({ID})(/download)?", path)
        if match and method == "GET":
            job = self.app.get_job(match[1])
            if not match[2]:
                self.respond(job)
            else:
                if job["status"] != "passed" or not job["gates"]["passed"]:
                    raise APIError(409, "任务未通过全部门禁，不能下载正式输出")
                output = self.app.data_dir / "outputs" / f"{match[1]}.mp4"
                if not output.is_file():
                    raise APIError(410, "输出文件已不存在，请重新导出")
                self.send_file(output, "video/mp4", {"Content-Disposition": f'attachment; filename="BXAGI-{match[1]}.mp4"'})
                self.app.audit("output_downloaded", match[1])
            return
        if path == "/api/audit" and method == "GET":
            self.respond({"events": self.app.list_audit()})
            return
        if path == "/api/campaigns":
            if method == "GET":
                self.respond({"campaigns": self.app.list_campaigns()})
                return
            if method == "POST":
                self.respond(self.app.create_campaign(self.body()), 201)
                return
        match = re.fullmatch(f"/api/campaigns/({ID})/metrics", path)
        if match and method == "POST":
            self.respond(self.app.import_metrics(match[1], self.body()))
            return
        raise APIError(404, "接口不存在")

    def upload(self):
        if not self.app.ffprobe:
            raise APIError(503, "未安装 ffprobe，请先安装 FFmpeg")
        length = self.length(self.server.max_upload)
        filename = urllib.parse.unquote(self.headers.get("X-Filename", "video.mp4"))
        filename = filename.replace("\\", "/").split("/")[-1].replace("\x00", "")[:200] or "video.mp4"
        asset_id = uuid.uuid4().hex
        path = self.app.data_dir / "assets" / f"{asset_id}.media"
        digest = hashlib.sha256()
        try:
            with path.open("xb") as output:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise APIError(400, "上传中断，实际长度不足")
                    remaining -= len(chunk)
                    digest.update(chunk)
                    output.write(chunk)
            metadata = self.app.probe(path)
            asset = {"id": asset_id, "name": filename, "path": str(path), **metadata, "segments": None,
                     "sha256": digest.hexdigest(), "created_at": now()}
            self.respond(self.app.register_asset(asset, length), 201)
        except Exception:
            path.unlink(missing_ok=True)
            raise

    def send_file(self, path, mime=None, extra=None):
        self.send_headers(200, mime or mimetypes.guess_type(str(path))[0] or "application/octet-stream", path.stat().st_size, extra)
        with path.open("rb") as file:
            shutil.copyfileobj(file, self.wfile, length=256 * 1024)

    def static(self, path):
        if "\x00" in path or "\\" in path:
            raise APIError(400, "无效路径")
        root = self.server.static_dir.resolve()
        candidate = (root / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        if not candidate.is_relative_to(root):
            raise APIError(403, "不能访问此路径")
        if not candidate.is_file():
            raise APIError(404, "文件不存在")
        self.send_file(candidate)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32
