#!/usr/bin/env python3
"""BXAGI local production service. Python standard library + FFmpeg only.

Stable entrypoint and legacy imports; application code lives in bxagi/.
"""
from __future__ import annotations

if __package__:
    from .bxagi.cli import main
    from .bxagi.common import APIError, BOUNDARY_TOLERANCE, FORMATS, ID, MEDIA_FORMATS, ROOT, VERSION, now, number
    from .bxagi.campaigns import evaluate_campaign
    from .bxagi.http import Handler, Server
    from .bxagi.service import Service, ai_adapter
    from .bxagi.transcripts import parse_srt, plan_clips, sentence_gate, sentences, srt_time, stamp
else:
    from bxagi.cli import main
    from bxagi.common import APIError, BOUNDARY_TOLERANCE, FORMATS, ID, MEDIA_FORMATS, ROOT, VERSION, now, number
    from bxagi.campaigns import evaluate_campaign
    from bxagi.http import Handler, Server
    from bxagi.service import Service, ai_adapter
    from bxagi.transcripts import parse_srt, plan_clips, sentence_gate, sentences, srt_time, stamp


if __name__ == "__main__":
    main()
