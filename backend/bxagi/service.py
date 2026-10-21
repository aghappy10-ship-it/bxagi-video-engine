"""Application use cases, persistent job lifecycle, and bounded worker queue."""
from __future__ import annotations

import json
from pathlib import Path
import queue
import re
import threading
import uuid
if __package__ == "bxagi":
    import ai_adapter  # Direct script and unittest discovery from backend/.
else:
    from .. import ai_adapter  # Imported as backend.bxagi.
from .campaigns import evaluate_campaign
from .common import APIError, FORMATS, number, now
from .media import MediaEngine
from .repository import Repository
from .transcripts import parse_srt, plan_clips, sentence_gate


class Service:
    def __init__(self, data_dir, workers=2):
        self.data_dir = Path(data_dir).resolve()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        for folder in ("assets", "outputs", "work"):
            (self.data_dir / folder).mkdir(exist_ok=True)
        self.db_path = self.data_dir / "state.sqlite3"
        self.workers = max(1, min(int(workers), 4))
        self.stop = threading.Event()
        self.queue = queue.Queue(maxsize=100)
        self.repository = Repository(self.db_path)
        self.repository.setup()
        self.media = MediaEngine(self.data_dir, self.stop)
        with self.db() as db:
            interrupted = db.execute("SELECT id FROM jobs WHERE status='running'").fetchall()
            for row in interrupted:
                gates = {"passed": False, "checks": [{"name": "media_decode", "status": "unverified", "detail": "进程重启，导出未完成"}], "errors": ["运行中断"]}
                db.execute("UPDATE jobs SET status='failed',error=?,gates=?,updated_at=? WHERE id=?",
                           ("运行被中断，服务重启后标记失败；请重新创建任务", json.dumps(gates, ensure_ascii=False), now(), row["id"]))
                self.audit("job_recovered_failed", row["id"], {"reason": "interrupted"}, db)
            pending = db.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at").fetchall()
        for row in pending:
            try:
                self.queue.put_nowait(row["id"])
            except queue.Full:
                self.fail_job(row["id"], "恢复队列超过 100 个任务，请重新创建任务")
        self.threads = []
        for i in range(self.workers):
            thread = threading.Thread(target=self.worker, name=f"export-{i + 1}", daemon=True)
            thread.start()
            self.threads.append(thread)

    def db(self):
        return self.repository.db()

    def setup(self):
        self.repository.setup()

    def audit(self, event, entity_id=None, detail=None, db=None):
        self.repository.audit(event, entity_id, detail, db)

    @property
    def ffmpeg(self):
        return self.media.ffmpeg

    @property
    def ffprobe(self):
        return self.media.ffprobe

    @property
    def subtitle_filter(self):
        return self.media.subtitle_filter

    @property
    def cjk_font_available(self):
        return self.media.cjk_font_available

    def probe(self, path):
        return self.media.probe(path)

    def run_process(self, args, job_id, timeout=600):
        return self.media.run_process(args, job_id, timeout)

    def asset(self, asset_id):
        with self.db() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        if not row:
            raise APIError(404, "视频不存在")
        return dict(row)

    def public_asset(self, asset):
        return {key: asset[key] for key in ("id", "name", "duration", "width", "height", "created_at")} | {
            "has_audio": bool(asset["has_audio"]), "has_transcript": bool(asset.get("segments")), "sha256": asset["sha256"]}

    def list_assets(self):
        with self.db() as db:
            return [self.public_asset(dict(row)) for row in db.execute("SELECT * FROM assets ORDER BY created_at DESC LIMIT 500")]

    def register_asset(self, asset, size):
        with self.db() as db:
            db.execute("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)", tuple(asset[key] for key in
                       ("id", "name", "path", "duration", "width", "height", "has_audio", "segments", "sha256", "created_at")))
            self.audit("asset_uploaded", asset["id"], {"bytes": size, "duration": asset["duration"]}, db)
        return self.public_asset(asset)

    def import_transcript(self, asset_id, body):
        asset = self.asset(asset_id)
        segments = parse_srt(body.get("srt"), asset["duration"])
        with self.db() as db:
            db.execute("UPDATE assets SET segments=? WHERE id=?", (json.dumps(segments, ensure_ascii=False), asset["id"]))
            self.audit("transcript_imported", asset["id"], {"segments": len(segments)}, db)
        return {"segments": segments}

    def transcribe_asset(self, asset_id, body):
        asset = self.asset(asset_id)
        if body.get("engine") != "local":
            raise APIError(400, "转写必须显式指定 engine:'local'；只支持已配置的本地模型")
        try:
            result = ai_adapter.transcribe_local(asset["path"])
            segments = parse_srt(result["srt"], asset["duration"])
        except ai_adapter.AIUnavailable as exc:
            raise APIError(503, str(exc))
        except ai_adapter.AIOperationError as exc:
            raise APIError(502, str(exc))
        with self.db() as db:
            db.execute("UPDATE assets SET segments=? WHERE id=?", (json.dumps(segments, ensure_ascii=False), asset["id"]))
            self.audit("transcript_generated", asset["id"], {"segments": len(segments), "engine": "faster-whisper"}, db)
        return {**result, "segments": segments, "notice": "模型自动转写，请人工校对；句界和媒体门禁仍需通过"}

    def plan_asset(self, asset_id, body):
        asset = self.asset(asset_id)
        segments = json.loads(asset["segments"]) if asset["segments"] else []
        if not segments:
            raise APIError(422, "请先导入 SRT，或显式运行已配置的本地转写；没有字幕时不能规划完整句")
        if body.get("use_ai") is True:
            count = int(number(body.get("count", 3), "count", 1, 12))
            minimum = number(body.get("min_duration", 5), "min_duration", 0.1, 300)
            maximum = number(body.get("max_duration", 45), "max_duration", minimum, 300)
            try:
                result = ai_adapter.plan_clips(segments, target_count=count, min_seconds=minimum, max_seconds=maximum, strategy=body.get("strategy", "hook"))
                gate, errors = sentence_gate(result["clips"], segments, asset["duration"])
                if gate["status"] != "pass":
                    raise APIError(422, "; ".join(errors))
            except ai_adapter.AIUnavailable as exc:
                raise APIError(503, str(exc))
            except ai_adapter.AIOperationError as exc:
                raise APIError(502, str(exc))
            for clip in result["clips"]:
                clip["id"] = uuid.uuid4().hex
                clip["strategy"] = body.get("strategy", "hook")
                clip["score"] = None
            self.audit("clips_model_planned", asset["id"], {"count": len(result["clips"]), "engine": result["engine"], "usage": result.get("usage")})
            return result
        if "use_ai" in body and not isinstance(body["use_ai"], bool):
            raise APIError(400, "use_ai 必须为布尔值")
        clips = plan_clips(segments, asset["duration"], body)
        self.audit("clips_planned", asset["id"], {"count": len(clips), "engine": "deterministic-srt"})
        return {"clips": clips, "engine": "deterministic-srt", "notice": "使用导入 SRT 的完整句标点边界；未验证字幕与语音一致性；不足时返回较少片段"}

    def create_job(self, body):
        asset = self.asset(body.get("asset_id"))
        clips = body.get("clips")
        if not isinstance(clips, list) or not 1 <= len(clips) <= 100:
            raise APIError(400, "clips 必须含 1–100 个片段")
        clean = []
        for item in clips:
            if not isinstance(item, dict):
                raise APIError(400, "片段必须是对象")
            start = number(item.get("start"), "start", 0, asset["duration"])
            end = number(item.get("end"), "end", start + 0.01, asset["duration"] + 0.005)
            clean.append({"start": start, "end": end})
        if sum(clip["end"] - clip["start"] for clip in clean) > 3600:
            raise APIError(400, "单任务合计导出时长不能超过 1 小时")
        format_ = body.get("format", "landscape")
        if format_ not in FORMATS:
            raise APIError(400, "format 支持 landscape、portrait、square")
        burn = body.get("burn_subtitles", False)
        if not isinstance(burn, bool):
            raise APIError(400, "burn_subtitles 必须为布尔值")
        if burn and not self.subtitle_filter:
            raise APIError(503, "当前 FFmpeg 缺少 subtitles/libass 字幕滤镜，请安装包含 libass 的 FFmpeg")
        if burn and not self.cjk_font_available and asset["segments"] and re.search(r"[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]", asset["segments"]):
            raise APIError(503, "检测不到中日韩字幕字体，拒绝烧录缺字字幕；请安装 Noto Sans CJK（Debian/Ubuntu: fonts-noto-cjk），或关闭字幕烧录")
        if self.queue.full():
            raise APIError(429, "队列已满，最多 100 个等待任务")
        job_id, created = uuid.uuid4().hex, now()
        with self.db() as db:
            db.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (job_id, asset["id"], str(body.get("title", "未命名导出"))[:200], json.dumps(clean), format_, int(burn), "queued", None, None, None, created, created))
            self.audit("job_created", job_id, {"asset_id": asset["id"], "clip_count": len(clean), "format": format_}, db)
        try:
            self.queue.put_nowait(job_id)
        except queue.Full:
            self.fail_job(job_id, "队列已满，请重新创建任务")
        return {"id": job_id, "status": "queued"}

    def get_job(self, job_id):
        with self.db() as db:
            row = db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            raise APIError(404, "任务不存在")
        job = dict(row)
        job["clips"] = json.loads(job["clips"])
        job["gates"] = json.loads(job["gates"]) if job["gates"] else {"passed": False, "checks": [], "errors": []}
        job["burn_subtitles"] = bool(job["burn_subtitles"])
        job.pop("output_path", None)
        if job["status"] == "passed" and job["gates"]["passed"]:
            job["output_url"] = f"/api/jobs/{job_id}/download"
        return job

    def list_jobs(self):
        with self.db() as db:
            ids = [row["id"] for row in db.execute("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 500")]
        return [self.get_job(job_id) for job_id in ids]

    def fail_job(self, job_id, error, gates=None):
        if gates is None:
            gates = {"passed": False, "checks": [{"name": "media_decode", "status": "unverified", "detail": "未完成媒体验证"}], "errors": [error]}
        gates["passed"] = False
        with self.db() as db:
            db.execute("UPDATE jobs SET status='failed',error=?,gates=?,output_path=NULL,updated_at=? WHERE id=?",
                       (str(error)[:2000], json.dumps(gates, ensure_ascii=False), now(), job_id))
            self.audit("job_failed", job_id, {"reason": str(error)[:500]}, db)
        (self.data_dir / "outputs" / f"{job_id}.mp4").unlink(missing_ok=True)

    def worker(self):
        while not self.stop.is_set():
            try:
                job_id = self.queue.get(timeout=0.2)
            except queue.Empty:
                continue
            try:
                self.export(job_id)
            except Exception as exc:
                self.fail_job(job_id, str(exc))
            finally:
                self.queue.task_done()

    def export(self, job_id):
        job = self.get_job(job_id)
        if job["status"] != "queued":
            return
        with self.db() as db:
            db.execute("UPDATE jobs SET status='running',updated_at=? WHERE id=?", (now(), job_id))
            self.audit("job_started", job_id, {}, db)
        asset = self.asset(job["asset_id"])
        segments = json.loads(asset["segments"]) if asset["segments"] else []
        gate, errors = sentence_gate(job["clips"], segments, asset["duration"])
        gates = {"passed": False, "checks": [gate, {"name": "media_decode", "status": "unverified", "detail": "等待真实导出后解码核验"}], "errors": errors}
        with self.db() as db:
            db.execute("UPDATE jobs SET gates=? WHERE id=?", (json.dumps(gates, ensure_ascii=False), job_id))
        if gate["status"] != "pass":
            self.fail_job(job_id, "; ".join(errors), gates)
            return
        if not self.ffmpeg or not self.ffprobe:
            self.fail_job(job_id, "请安装 FFmpeg 和 ffprobe，并加入 PATH", gates)
            return
        try:
            output, metadata = self.media.render(job, asset, segments, job_id)
            width, height = FORMATS[job["format"]]
            gates["checks"][1] = {"name": "media_decode", "status": "pass", "detail": f"完整 FFmpeg 解码成功；{width}×{height}；时长 {metadata['duration']:.3f}s"}
            gates["passed"] = True
            with self.db() as db:
                db.execute("UPDATE jobs SET status='passed',gates=?,output_path=?,updated_at=? WHERE id=?",
                           (json.dumps(gates, ensure_ascii=False), str(output), now(), job_id))
                self.audit("job_passed", job_id, {"duration": metadata["duration"], "bytes": output.stat().st_size}, db)
        except Exception as exc:
            gates["checks"][1] = {"name": "media_decode", "status": "fail", "detail": str(exc)}
            gates["errors"].append(str(exc))
            self.fail_job(job_id, str(exc), gates)

    def list_campaigns(self):
        with self.db() as db:
            return [json.loads(row["data"]) for row in db.execute("SELECT data FROM campaigns ORDER BY created_at DESC LIMIT 500")]

    def create_campaign(self, body):
        campaign_id = uuid.uuid4().hex
        campaign = {"id": campaign_id, "name": str(body.get("name", "未命名投放草案"))[:200], "status": "draft", "execution": "not_connected",
                    "daily_budget": number(body.get("daily_budget", body.get("dailyBudget", 100)), "daily_budget", 0.01, 1e7),
                    "target_roi": number(body.get("target_roi", body.get("targetRoi", 1.5)), "target_roi", 0.01, 1000),
                    "max_daily_budget": number(body.get("max_daily_budget", body.get("maxDailyBudget", 1000)), "max_daily_budget", 0.01, 1e7),
                    "min_spend": number(body.get("min_spend", body.get("minSpend", 100)), "min_spend", 0, 1e9),
                    "spend": None, "revenue": None, "conversions": None, "has_conversion": False, "data_fresh": False,
                    "created_at": now(), "updated_at": now()}
        if campaign["daily_budget"] > campaign["max_daily_budget"]:
            raise APIError(400, "每日预算不能超过预算上限")
        campaign["recommendation"] = evaluate_campaign(campaign)
        with self.db() as db:
            db.execute("INSERT INTO campaigns VALUES(?,?,?,?)", (campaign_id, json.dumps(campaign, ensure_ascii=False), campaign["created_at"], campaign["updated_at"]))
            self.audit("campaign_draft_created", campaign_id, {"execution": "none"}, db)
        return campaign

    def import_metrics(self, campaign_id, body):
        with self.db() as db:
            row = db.execute("SELECT * FROM campaigns WHERE id=?", (campaign_id,)).fetchone()
            if not row:
                raise APIError(404, "投放草案不存在")
            campaign = json.loads(row["data"])
            # Each import replaces a snapshot; absent fields become unknown.
            for key in ("spend", "revenue", "conversions"):
                campaign[key] = number(body[key], key) if key in body and body[key] is not None else None
            for key in ("has_conversion", "data_fresh"):
                if key in body and not isinstance(body[key], bool):
                    raise APIError(400, f"{key} 必须为布尔值")
                campaign[key] = body.get(key) is True
            campaign["updated_at"] = now()
            campaign["recommendation"] = evaluate_campaign(campaign)
            db.execute("UPDATE campaigns SET data=?,updated_at=? WHERE id=?", (json.dumps(campaign, ensure_ascii=False), campaign["updated_at"], campaign_id))
            self.audit("campaign_metrics_imported", campaign_id, {"action": campaign["recommendation"]["action"], "executed": False}, db)
        return campaign

    def list_audit(self):
        with self.db() as db:
            return [{**dict(row), "detail": json.loads(row["detail"])} for row in db.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 500")]

    def capabilities(self, max_upload):
        model_status, asr_status = ai_adapter.get_model_status(), ai_adapter.get_asr_status()
        return {"backend": True, "engine": "deterministic-srt-ffmpeg", "ffmpeg": bool(self.ffmpeg), "ffprobe": bool(self.ffprobe),
                "upload": True, "transcript_import": True, "automatic_transcription": asr_status["configured"], "ai_planning": model_status["configured"],
                "llm_configured": model_status["configured"], "model": model_status, "asr": asr_status,
                "clip_planning": "完整句标点规则；所有策略当前按时间顺序选取，不推断爆款质量",
                "real_export": bool(self.ffmpeg and self.ffprobe), "formats": list(FORMATS), "burn_subtitles": self.subtitle_filter,
                "cjk_font_available": self.cjk_font_available,
                "quality_gates": ["sentence_boundary", "media_decode"], "semantic_quality_verified": False,
                "boundary_tolerance_ms": 80,
                "campaign_drafts": True, "campaign_recommendations": True, "ad_platform_connected": False, "ad_execution": False,
                "workers": self.workers, "max_queued_jobs": 100, "max_upload_bytes": max_upload,
                "max_asset_duration_seconds": 43200, "max_output_duration_seconds": 3600}

    def close(self):
        self.media.close()
        for thread in self.threads:
            thread.join(timeout=5)
