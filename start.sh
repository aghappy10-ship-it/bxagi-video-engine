#!/usr/bin/env bash
set -euo pipefail

BX_PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$BX_PROJECT_ROOT"

BX_PYTHON_BIN=""
for BX_CANDIDATE in python3 python; do
  if command -v "$BX_CANDIDATE" >/dev/null 2>&1 && "$BX_CANDIDATE" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then
    BX_PYTHON_BIN="$BX_CANDIDATE"
    break
  fi
done

if [[ -z "$BX_PYTHON_BIN" ]]; then
  echo '启动失败：需要 Python 3.10 或更高版本，并将 python3 或 python 加入 PATH。' >&2
  exit 1
fi

for BX_MEDIA_TOOL in ffmpeg ffprobe; do
  if ! command -v "$BX_MEDIA_TOOL" >/dev/null 2>&1 || ! "$BX_MEDIA_TOOL" -version >/dev/null 2>&1; then
    echo "启动失败：未找到可用的 $BX_MEDIA_TOOL。请安装完整 FFmpeg 并加入 PATH，然后重新启动。" >&2
    exit 1
  fi
done

if [[ ! -f backend/server.py ]]; then
  echo '启动失败：缺少 backend/server.py，请解压完整交付包。' >&2
  exit 1
fi

echo '启动 BXAGI 生产服务；默认工作台地址 http://127.0.0.1:8765，按 Ctrl+C 停止。'
exec "$BX_PYTHON_BIN" backend/server.py "$@"
