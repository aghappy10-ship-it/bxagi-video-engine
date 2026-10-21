"""Command-line startup and orderly shutdown for the local service."""
from __future__ import annotations

import argparse
import logging
import os
import signal
import threading
from .common import ROOT
from .service import Service
from .http import Handler, Server

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("BX_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BX_PORT", "8765")))
    parser.add_argument("--data-dir", default=os.environ.get("BX_DATA_DIR", str(ROOT / "data")))
    parser.add_argument("--workers", type=int, default=int(os.environ.get("BX_WORKERS", "2")))
    args = parser.parse_args()
    token = os.environ.get("BX_API_TOKEN", "")
    if args.host not in ("127.0.0.1", "localhost", "::1") and not token:
        parser.error("对外监听必须设置 BX_API_TOKEN；默认仅监听 127.0.0.1")
    if not 1 <= args.workers <= 4:
        parser.error("--workers 必须为 1–4")
    try:
        max_upload = int(os.environ.get("BX_MAX_UPLOAD_MB", "512")) * 1024 * 1024
        if not 1 * 1024 * 1024 <= max_upload <= 4096 * 1024 * 1024:
            raise ValueError()
    except ValueError:
        parser.error("BX_MAX_UPLOAD_MB 必须为 1–4096 的整数")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    app = Service(args.data_dir, args.workers)
    server = Server((args.host, args.port), Handler)
    server.app, server.token = app, token
    server.allowed_origins = {value.strip() for value in os.environ.get("BX_ALLOWED_ORIGINS", "").split(",") if value.strip() and value.strip() != "*"}
    server.max_upload, server.static_dir = max_upload, ROOT.parent / "legacy" / "workspace"

    def stop(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    logging.info("BXAGI service listening on %s:%s; ffmpeg=%s", args.host, args.port, bool(app.ffmpeg))
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        app.close()
