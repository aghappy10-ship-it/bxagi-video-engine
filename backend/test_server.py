"""Real HTTP/FFmpeg integration checks for the BXAGI production service.

Run from the project root with:
    python -m unittest discover -s backend -p 'test_*.py' -v

Every test uses an isolated data directory and an authenticated subprocess.
Video fixtures and downloaded output are actual, decodable media.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


SERVER = Path(__file__).with_name("server.py")
TOKEN = "integration-test-token"
SRT = """1
00:00:00,000 --> 00:00:02,000
第一句完整说明。

2
00:00:02,000 --> 00:00:04,000
第二句包含价格信息。

3
00:00:04,000 --> 00:00:06,000
第三句给出使用方法。

4
00:00:06,000 --> 00:00:08,000
第四句总结结束。
"""


class ProductionServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise unittest.SkipTest("Integration tests require ffmpeg and ffprobe on PATH")
        cls.fixture_dir = tempfile.TemporaryDirectory(prefix="bxagi-media-fixture-")
        cls.fixture = Path(cls.fixture_dir.name) / "source.mp4"
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=8",
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
                "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(cls.fixture),
            ],
            check=True, capture_output=True, timeout=30,
        )
        cls.fixture_bytes = cls.fixture.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.fixture_dir.cleanup()

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="bxagi-service-test-")
        self.data_dir = Path(self.temp_dir.name) / "data"
        self.data_dir.mkdir()
        self.log_path = Path(self.temp_dir.name) / "server.log"
        self.log_file = self.log_path.open("ab")
        self.opener = build_opener(ProxyHandler({}))
        self.process = None
        self._start_server()

    def tearDown(self):
        self._stop_server()
        self.log_file.close()
        self.temp_dir.cleanup()

    def _start_server(self, *, token=TOKEN, environment=None):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        env = os.environ.copy()
        if token is None:
            env.pop("BX_API_TOKEN", None)
        else:
            env["BX_API_TOKEN"] = token
        env["BX_ALLOWED_ORIGINS"] = ""
        env.update(environment or {})
        self.process = subprocess.Popen(
            [
                sys.executable, str(SERVER), "--host", "127.0.0.1",
                "--port", str(self.port), "--data-dir", str(self.data_dir),
            ],
            cwd=SERVER.parent, env=env,
            stdout=self.log_file, stderr=subprocess.STDOUT,
        )
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self.fail("Server exited during startup: " + self._server_log())
            try:
                status, _, _ = self._request("GET", "/api/health")
                if status == 200:
                    return
            except (URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(0.05)
        self.fail("Server did not become ready: " + self._server_log())

    def _stop_server(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)

    def _server_log(self):
        self.log_file.flush()
        return self.log_path.read_text(errors="replace")[-6000:]

    def _request(self, method, path, body=None, *, token=TOKEN, headers=None, raw=False):
        request_headers = dict(headers or {})
        if token is not None:
            request_headers["Authorization"] = f"Bearer {token}"
        if body is not None and not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        elif body is not None:
            request_headers.setdefault("Content-Type", "application/octet-stream")
        request = Request(self.base_url + path, body, request_headers, method=method)
        try:
            response = self.opener.open(request, timeout=20)
        except HTTPError as error:
            response = error
        with response:
            status = response.status
            response_headers = dict(response.headers)
            contents = response.read()
        if raw:
            return status, contents, response_headers
        return status, json.loads(contents) if contents else {}, response_headers

    def _json(self, method, path, body=None, *, expected=(200, 201, 202), **kwargs):
        status, result, _ = self._request(method, path, body, **kwargs)
        self.assertIn(status, expected, result)
        return result

    def _upload(self, *, transcript=True):
        asset = self._json(
            "POST", "/api/assets", self.fixture_bytes,
            headers={"X-Filename": "integration-source.mp4"},
        )
        self.assertTrue(asset.get("id"), asset)
        self.assertAlmostEqual(float(asset["duration"]), 8, delta=0.15)
        self.assertEqual((asset["width"], asset["height"]), (320, 240))
        if transcript:
            parsed = self._json("POST", f"/api/assets/{asset['id']}/transcript", {"srt": SRT})
            self.assertEqual(len(parsed["segments"]), 4)
        return asset

    def _submit(self, asset, clips, *, title="Integration export", format="landscape", burn_subtitles=False):
        job = self._json("POST", "/api/jobs", {
            "asset_id": asset["id"], "title": title, "clips": clips,
            "format": format, "burn_subtitles": burn_subtitles,
        })
        self.assertTrue(job.get("id"), job)
        self.assertIn(job["status"], ("queued", "running"))
        return job

    def _wait_for_job(self, job_id, timeout=90):
        deadline = time.monotonic() + timeout
        result = {}
        while time.monotonic() < deadline:
            result = self._json("GET", f"/api/jobs/{job_id}")
            if result.get("status") in ("passed", "failed"):
                return result
            self.assertIn(result.get("status"), ("queued", "running"), result)
            time.sleep(0.1)
        self.fail(f"Job failed to finish: {result}; log: {self._server_log()}")

    @staticmethod
    def _gate(job, name):
        return next((gate for gate in job.get("gates", {}).get("checks", [])
                     if gate.get("name") == name), {})

    def test_authenticated_routes_and_health_do_not_expose_token(self):
        status, body, _ = self._request("GET", "/api/assets", token=None)
        self.assertIn(status, (401, 403), body)
        status, body, _ = self._request("GET", "/api/jobs", token="incorrect")
        self.assertIn(status, (401, 403), body)
        health = self._json("GET", "/api/health")
        self.assertNotIn(TOKEN, json.dumps(health))
        audit = self._json("GET", "/api/audit")
        self.assertNotIn(TOKEN, json.dumps(audit))

    def test_hostile_origin_is_rejected_even_with_a_valid_token(self):
        status, body, _ = self._request(
            "GET", "/api/assets", headers={"Origin": "https://attacker.invalid"},
        )
        self.assertEqual(status, 403, body)
        status, body, _ = self._request(
            "POST", "/api/campaigns", {"name": "Cross-origin write", "daily_budget": 100},
            headers={"Origin": "https://attacker.invalid"},
        )
        self.assertEqual(status, 403, body)
        self.assertEqual(self._json("GET", "/api/campaigns")["campaigns"], [])

    def test_tokenless_local_service_rejects_a_spoofed_host(self):
        self._stop_server()
        self._start_server(token=None)
        status, body, _ = self._request("GET", "/api/assets", token=None)
        self.assertEqual(status, 200, body)
        status, body, _ = self._request(
            "GET", "/api/assets", token=None, headers={"Host": "attacker.invalid"},
        )
        self.assertEqual(status, 403, body)

    def test_complete_flow_exports_a_decodable_merged_video(self):
        asset = self._upload()
        plan = self._json("POST", f"/api/assets/{asset['id']}/plan", {
            "count": 2, "min_duration": 2, "max_duration": 4,
            "strategy": "hook", "use_ai": False,
        })
        self.assertGreaterEqual(len(plan["clips"]), 1)
        self.assertLessEqual(len(plan["clips"]), 2)
        self.assertTrue(plan.get("engine"))
        clips = sorted(plan["clips"], key=lambda clip: clip["start"])
        for clip in clips:
            self.assertIn(clip["start"], (0, 2, 4, 6))
            self.assertIn(clip["end"], (2, 4, 6, 8))
            self.assertLess(clip["start"], clip["end"])
        for left, right in zip(clips, clips[1:]):
            self.assertLessEqual(left["end"], right["start"])
        job = self._submit(asset, [{"start": 0, "end": 2}, {"start": 4, "end": 6}])
        result = self._wait_for_job(job["id"])
        self.assertEqual(result["status"], "passed", result)
        self.assertTrue(result["gates"]["passed"], result)
        for name in ("sentence_boundary", "media_decode"):
            self.assertEqual(self._gate(result, name).get("status"), "pass", result)
        self.assertTrue(result.get("output_url"), result)
        status, data, headers = self._request("GET", f"/api/jobs/{job['id']}/download", raw=True)
        self.assertEqual(status, 200)
        self.assertGreater(len(data), 1000)
        self.assertIn("video/mp4", headers.get("Content-Type", ""))
        output = Path(self.temp_dir.name) / "download.mp4"
        output.write_bytes(data)
        probe = subprocess.run([
            "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(output)
        ], capture_output=True, text=True, check=True, timeout=20)
        media = json.loads(probe.stdout)
        self.assertAlmostEqual(float(media["format"]["duration"]), 4, delta=0.35)
        video = next(stream for stream in media["streams"] if stream["codec_type"] == "video")
        self.assertGreater(video["width"], video["height"])
        subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(output), "-f", "null", "-"
        ], capture_output=True, check=True, timeout=30)
        status, _, _ = self._request("GET", f"/api/jobs/{job['id']}/download", token=None)
        self.assertIn(status, (401, 403))

    def test_later_window_burns_shifted_subtitles_into_real_output_pixels(self):
        asset = self._upload(transcript=False)
        ascii_srt = "\n\n".join(
            f"{index + 1}\n00:00:{index * 2:02d},000 --> 00:00:{index * 2 + 2:02d},000\nTEST {word}."
            for index, word in enumerate(("FIRST", "SECOND", "THIRD", "FOURTH"))
        ) + "\n"
        self._json("POST", f"/api/assets/{asset['id']}/transcript", {"srt": ascii_srt})
        frames = {}
        for burn_subtitles in (False, True):
            job = self._submit(
                asset, [{"start": 4, "end": 6}], format="portrait", burn_subtitles=burn_subtitles,
            )
            result = self._wait_for_job(job["id"])
            self.assertEqual(result["status"], "passed", result)
            status, data, _ = self._request("GET", f"/api/jobs/{job['id']}/download", raw=True)
            self.assertEqual(status, 200)
            output = Path(self.temp_dir.name) / f"subtitle-{burn_subtitles}.mp4"
            output.write_bytes(data)
            # The 4:3 source occupies the middle 540 pixels of the 720x1280 frame.
            # Its bottom 160 pixels therefore contain black padding until actual
            # subtitle rendering adds text. Inspect the output pixels at 0.5 s,
            # when the source's 4-to-6-second cue must already be visible.
            decoded = subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", "0.5",
                "-i", str(output), "-frames:v", "1", "-vf", "crop=720:160:0:1120",
                "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
            ], capture_output=True, check=True, timeout=30)
            self.assertEqual(len(decoded.stdout), 720 * 160 * 3)
            frames[burn_subtitles] = decoded.stdout
        baseline, burned = frames[False], frames[True]
        self.assertLessEqual(max(baseline), 8, "The comparison region must contain only black padding")
        visible_channels = sum(after > 80 and before < 10 for before, after in zip(baseline, burned))
        mean_difference = sum(abs(after - before) for before, after in zip(baseline, burned)) / len(baseline)
        self.assertGreater(visible_channels, 200, "Later-window subtitle text is missing from actual exported pixels")
        self.assertGreater(mean_difference, 0.1, "Subtitle burn must visibly differ from the unburned output")

    def test_partial_sentence_fails_closed_and_cannot_be_downloaded(self):
        asset = self._upload()
        job = self._submit(asset, [{"start": 0.5, "end": 1.5}])
        result = self._wait_for_job(job["id"])
        self.assertEqual(result["status"], "failed", result)
        self.assertFalse(result["gates"]["passed"])
        self.assertEqual(self._gate(result, "sentence_boundary").get("status"), "fail", result)
        self.assertFalse(result.get("output_url"))
        status, _, _ = self._request("GET", f"/api/jobs/{job['id']}/download")
        self.assertIn(status, (400, 404, 409, 422))

    def test_missing_transcript_is_unverified_and_not_an_official_export(self):
        asset = self._upload(transcript=False)
        job = self._submit(asset, [{"start": 0, "end": 2}])
        result = self._wait_for_job(job["id"])
        self.assertEqual(result["status"], "failed", result)
        self.assertFalse(result["gates"]["passed"])
        self.assertEqual(self._gate(result, "sentence_boundary").get("status"), "unverified", result)
        self.assertFalse(result.get("output_url"))

    def test_invalid_media_upload_is_rejected_without_retaining_an_asset(self):
        status, result, _ = self._request(
            "POST", "/api/assets", b"this is not a media container",
            headers={"X-Filename": "invalid.mp4"},
        )
        self.assertIn(status, (400, 415, 422), result)
        self.assertEqual(self._json("GET", "/api/assets")["assets"], [])

    def test_invalid_transcript_does_not_replace_valid_transcript(self):
        asset = self._upload()
        status, result, _ = self._request(
            "POST", f"/api/assets/{asset['id']}/transcript", {"srt": "invalid subtitle text"},
        )
        self.assertIn(status, (400, 422), result)
        plan = self._json("POST", f"/api/assets/{asset['id']}/plan", {
            "count": 1, "min_duration": 2, "max_duration": 4, "use_ai": False,
        })
        self.assertTrue(plan["clips"], "Rejected edit must leave the prior valid transcript usable")

    def test_missing_conversion_or_stale_data_never_recommends_spend(self):
        campaign = self._json("POST", "/api/campaigns", {
            "name": "Integration campaign", "daily_budget": 100,
            "target_roi": 2, "max_daily_budget": 1000, "min_spend": 100,
        })
        self.assertTrue(campaign.get("id"), campaign)
        missing = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
            "spend": 300, "revenue": 1500, "conversions": 0,
            "has_conversion": False, "data_fresh": True,
        })
        self.assertEqual(missing["recommendation"]["action"], "pause", missing)
        self.assertIsNone(missing["recommendation"]["roi"], missing)
        stale = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
            "spend": 300, "revenue": 1500, "conversions": 10,
            "has_conversion": True, "data_fresh": False,
        })
        self.assertEqual(stale["recommendation"]["action"], "hold", stale)
        self.assertIsNone(stale["recommendation"]["roi"], stale)
        campaigns = self._json("GET", "/api/campaigns")["campaigns"]
        self.assertEqual(len(campaigns), 1)
        self.assertEqual(campaigns[0]["id"], campaign["id"])

    def test_valid_campaign_increase_requires_roi_and_three_conversions(self):
        campaign = self._json("POST", "/api/campaigns", {
            "name": "Qualified increase", "daily_budget": 500, "target_roi": 2,
            "max_daily_budget": 1000,
        })
        for conversions, expected_action, expected_budget in ((2, "hold", 500), (3, "increase", 600)):
            with self.subTest(conversions=conversions):
                imported = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
                    "spend": 200, "revenue": 600, "conversions": conversions,
                    "has_conversion": True, "data_fresh": True,
                })
                recommendation = imported["recommendation"]
                self.assertEqual(recommendation["action"], expected_action, imported)
                self.assertEqual(recommendation["newBudget"], expected_budget, imported)
                self.assertAlmostEqual(recommendation["roi"], 3)

    def test_low_roi_pause_preserves_the_existing_budget(self):
        campaign = self._json("POST", "/api/campaigns", {
            "name": "Stop loss", "daily_budget": 500, "target_roi": 2,
        })
        imported = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
            "spend": 200, "revenue": 200, "conversions": 5,
            "has_conversion": True, "data_fresh": True,
        })
        recommendation = imported["recommendation"]
        self.assertEqual(recommendation["action"], "pause", imported)
        self.assertEqual(recommendation["newBudget"], 500, imported)
        self.assertAlmostEqual(recommendation["roi"], 1)

    def test_minimum_sample_and_unknown_conversion_hold_below_budget(self):
        campaign = self._json("POST", "/api/campaigns", {
            "name": "Insufficient sample", "daily_budget": 500, "target_roi": 2,
        })
        small_sample = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
            "spend": 99, "revenue": 600, "conversions": 5,
            "has_conversion": True, "data_fresh": True,
        })
        self.assertEqual(small_sample["recommendation"]["action"], "hold", small_sample)
        self.assertEqual(small_sample["recommendation"]["newBudget"], 500, small_sample)
        unknown = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
            "spend": 200, "revenue": 600, "conversions": 0,
            "has_conversion": False, "data_fresh": True,
        })
        self.assertEqual(unknown["recommendation"]["action"], "hold", unknown)
        self.assertIsNone(unknown["recommendation"]["roi"], unknown)

    def test_crossing_budget_cap_requires_approval_and_preserves_proposed_budget(self):
        campaign = self._json("POST", "/api/campaigns", {
            "name": "At cap", "daily_budget": 900, "target_roi": 2,
            "max_daily_budget": 1000,
        })
        imported = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
            "spend": 200, "revenue": 600, "conversions": 5,
            "has_conversion": True, "data_fresh": True,
        })
        self.assertEqual(imported["recommendation"]["action"], "approval", imported)
        self.assertEqual(imported["recommendation"]["newBudget"], 1080, imported)
        above_global_cap = self._json("POST", "/api/campaigns", {
            "name": "Above global cap", "daily_budget": 1100, "target_roi": 2,
            "max_daily_budget": 2000,
        })
        imported = self._json("POST", f"/api/campaigns/{above_global_cap['id']}/metrics", {
            "spend": 200, "revenue": 600, "conversions": 5,
            "has_conversion": True, "data_fresh": True,
        })
        self.assertEqual(imported["recommendation"]["action"], "approval", imported)
        self.assertEqual(imported["recommendation"]["newBudget"], 1100, imported)

    def test_invalid_monetary_strings_are_rejected_without_changing_metrics(self):
        status, body, _ = self._request("POST", "/api/campaigns", {
            "name": "Invalid budget", "daily_budget": "not-an-amount",
        })
        self.assertIn(status, (400, 422), body)
        self.assertEqual(self._json("GET", "/api/campaigns")["campaigns"], [])
        campaign = self._json("POST", "/api/campaigns", {
            "name": "Reject invalid metrics", "daily_budget": 500,
        })
        before = self._json("POST", f"/api/campaigns/{campaign['id']}/metrics", {
            "spend": 200, "revenue": 500, "conversions": 5,
            "has_conversion": True, "data_fresh": True,
        })
        for field in ("spend", "revenue"):
            with self.subTest(field=field):
                invalid = {"spend": 200, "revenue": 500, "conversions": 5,
                           "has_conversion": True, "data_fresh": True, field: "invalid"}
                status, body, _ = self._request(
                    "POST", f"/api/campaigns/{campaign['id']}/metrics", invalid,
                )
                self.assertIn(status, (400, 422), body)
                persisted = self._json("GET", "/api/campaigns")["campaigns"][0]
                for key in ("spend", "revenue", "conversions", "recommendation"):
                    self.assertEqual(persisted[key], before[key])

    def test_restart_recovers_interrupted_job_and_preserves_upload(self):
        asset = self._upload(transcript=False)
        job = self._submit(asset, [{"start": 0, "end": 2}])
        self.assertEqual(self._wait_for_job(job["id"])["status"], "failed")
        self._stop_server()
        with sqlite3.connect(self.data_dir / "state.sqlite3") as connection:
            connection.execute(
                "UPDATE jobs SET status='running', error='', output_path=NULL WHERE id=?", (job["id"],)
            )
        self._start_server()
        result = self._json("GET", f"/api/jobs/{job['id']}")
        self.assertEqual(result["status"], "failed", result)
        self.assertRegex(str(result.get("error", "")).lower(), r"interrupt|restart|中断|重启")
        self.assertFalse(result.get("output_url"))
        self.assertEqual(self._json("GET", "/api/assets")["assets"][0]["id"], asset["id"])
        jobs = self._json("GET", "/api/jobs")["jobs"]
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], "failed")

    def test_restart_resumes_a_persisted_queued_job_and_validates_real_output(self):
        asset = self._upload()
        job = self._submit(asset, [{"start": 0.5, "end": 1.5}])
        self.assertEqual(self._wait_for_job(job["id"])["status"], "failed")
        self._stop_server()
        # Persist a valid waiting job while the process is offline; startup must
        # enqueue it and produce a new file, rather than trust a prior status.
        with sqlite3.connect(self.data_dir / "state.sqlite3") as connection:
            connection.execute(
                "UPDATE jobs SET clips=?,status='queued',error=NULL,gates=NULL,output_path=NULL WHERE id=?",
                (json.dumps([{"start": 4, "end": 6}]), job["id"]),
            )
        self._start_server()
        result = self._wait_for_job(job["id"])
        self.assertEqual(result["status"], "passed", result)
        self.assertTrue(result["gates"]["passed"], result)
        for name in ("sentence_boundary", "media_decode"):
            self.assertEqual(self._gate(result, name).get("status"), "pass", result)
        status, contents, _ = self._request("GET", result["output_url"], raw=True)
        self.assertEqual(status, 200)
        self.assertGreater(len(contents), 1000)
        events = self._json("GET", "/api/audit")["events"]
        self.assertTrue(any(event["event"] == "job_passed" and event["entity_id"] == job["id"] for event in events))

    def test_missing_ffmpeg_dependencies_report_unavailable_and_reject_upload(self):
        self._stop_server()
        self._start_server(environment={"PATH": ""})
        health = self._json("GET", "/api/health")
        self.assertFalse(health["ffmpeg"], health)
        self.assertFalse(health["ffprobe"], health)
        self.assertFalse(self._json("GET", "/api/capabilities")["real_export"])
        status, body, _ = self._request("POST", "/api/assets", self.fixture_bytes)
        self.assertEqual(status, 503, body)
        self.assertEqual(self._json("GET", "/api/assets")["assets"], [])
        campaign = self._json("POST", "/api/campaigns", {"name": "No media dependencies"})
        self.assertEqual(campaign["execution"], "not_connected")


if __name__ == "__main__":
    unittest.main(verbosity=2)
