"""Shared API errors, limits, version, and scalar validation."""
from __future__ import annotations

import datetime as dt
import math
from pathlib import Path

VERSION = "1.1.0"
ROOT = Path(__file__).resolve().parents[1]
ID = r"[a-f0-9]{32}"
FORMATS = {"landscape": (1280, 720), "portrait": (720, 1280), "square": (720, 720)}
BOUNDARY_TOLERANCE = 0.08
MEDIA_FORMATS = "mov,matroska,avi,mpeg,mpegts"


class APIError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)

def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

def number(value, name, low=0, high=1e12):
    if isinstance(value, bool):
        raise APIError(400, f"{name} 必须是数值")
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise APIError(400, f"{name} 必须是数值")
    if not math.isfinite(value) or value < low or value > high:
        raise APIError(400, f"{name} 超出有效范围 {low}–{high}")
    return value
