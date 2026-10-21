@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "BX_PYTHON_COMMAND="
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
  if not errorlevel 1 set "BX_PYTHON_COMMAND=py -3"
)
if not defined BX_PYTHON_COMMAND (
  where python >nul 2>nul
  if not errorlevel 1 (
    python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 set "BX_PYTHON_COMMAND=python"
  )
)
if not defined BX_PYTHON_COMMAND (
  echo 启动失败：需要 Python 3.10 或更高版本，请安装后重新启动。
  exit /b 1
)

ffmpeg -version >nul 2>nul
if errorlevel 1 (
  echo 启动失败：未找到可用的 ffmpeg。请安装完整 FFmpeg 并将 bin 目录加入 PATH。
  exit /b 1
)
ffprobe -version >nul 2>nul
if errorlevel 1 (
  echo 启动失败：未找到可用的 ffprobe。请安装完整 FFmpeg 并将 bin 目录加入 PATH。
  exit /b 1
)
if not exist "backend\server.py" (
  echo 启动失败：缺少 backend\server.py，请解压完整交付包。
  exit /b 1
)

echo 启动 BXAGI 生产服务；默认工作台地址 http://127.0.0.1:8765，按 Ctrl+C 停止。
%BX_PYTHON_COMMAND% backend\server.py %*
exit /b %errorlevel%
