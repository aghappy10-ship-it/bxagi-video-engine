"""Adapter checks use a local fake HTTP service; no paid inference or downloads."""
import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

import ai_adapter as ai


CUES = [
    {"index": 1, "start": 0, "end": 2, "text": "This begins"},
    {"index": 2, "start": 2, "end": 4, "text": "a complete sentence."},
    {"index": 3, "start": 4, "end": 6, "text": "下一句完整。"},
    {"index": 4, "start": 6, "end": 8, "text": "最后一句。"},
]


class ModelAdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                cls.request_path = self.path
                cls.authorization = self.headers.get("Authorization")
                cls.received = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_response(cls.response_code)
                self.send_header("Content-Type", "application/json")
                if cls.response_code == 302:
                    self.send_header("Location", f"http://127.0.0.1:{cls.server.server_port}/redirected")
                self.end_headers()
                self.wfile.write(cls.response_bytes)

            def log_message(self, *args):
                pass
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.config = patch.dict(os.environ, {
            "BX_MODEL_ENABLED": "true", "BX_MODEL_API_KEY": "private-test-key",
            "BX_MODEL_BASE_URL": f"http://127.0.0.1:{self.server.server_port}/v1",
            "BX_MODEL_NAME": "local-fixture-model", "BX_WHISPER_MODEL": "",
        }, clear=True)
        self.config.start()
        self.addCleanup(self.config.stop)
        type(self).response_code = 200
        self.set_plan({"clips": [
            {"start_cue": 1, "end_cue": 2, "title": "Opening", "reason": "Complete explanation"},
            {"start_cue": 3, "end_cue": 4, "title": "Closing"},
        ]})

    def set_plan(self, value, *, finish="stop", usage=None):
        type(self).response_bytes = json.dumps({
            "choices": [{"finish_reason": finish, "message": {"content": json.dumps(value)}}],
            "usage": usage if usage is not None else {"prompt_tokens": 123, "completion_tokens": 45, "total_tokens": 168},
        }).encode()

    def plan(self, cues=CUES):
        return ai.plan_clips(cues, target_count=2, min_seconds=2, max_seconds=4)

    def test_real_http_path_authentication_and_mapped_timing(self):
        result = self.plan()
        self.assertEqual([(c["start"], c["end"]) for c in result["clips"]], [(0, 4), (4, 8)])
        self.assertEqual(self.request_path, "/v1/chat/completions")
        self.assertEqual(self.authorization, "Bearer private-test-key")
        self.assertEqual(self.received["response_format"], {"type": "json_object"})
        self.assertEqual(result["usage"]["total_tokens"], 168)
        self.assertIsNone(result["cost"])
        self.assertNotIn("private-test-key", json.dumps(result))
        self.assertNotIn("private-test-key", json.dumps(ai.get_model_status()))

    def test_unconfigured_or_disabled_never_makes_a_request(self):
        for variable, value in (("BX_MODEL_ENABLED", "false"), ("BX_MODEL_API_KEY", ""),
                                ("BX_MODEL_NAME", ""), ("BX_MODEL_BASE_URL", "")):
            with self.subTest(variable=variable), patch.dict(os.environ, {variable: value}), patch("ai_adapter.urlopen") as call:
                self.assertFalse(ai.get_model_status()["configured"])
                with self.assertRaises(ai.AIUnavailable):
                    self.plan()
                call.assert_not_called()

    def test_model_indices_duration_overlap_and_boundary_validation(self):
        malformed = [
            {"clips": [{"start_cue": 2, "end_cue": 2}]},
            {"clips": [{"start_cue": 1, "end_cue": 1}]},
            {"clips": [{"start_cue": 1, "end_cue": 99}]},
            {"clips": [{"start_cue": True, "end_cue": 2}]},
            {"clips": [{"start_cue": 3, "end_cue": 1}]},
            {"clips": [{"start_cue": 1, "end_cue": 4}]},
            {"clips": [{"start_cue": 1, "end_cue": 2}, {"start_cue": 1, "end_cue": 2}]},
            {"clips": [{"start_cue": 1, "end_cue": 2, "path": "/etc/passwd"}]},
            {"clips": []},
        ]
        for content in malformed:
            with self.subTest(content=content):
                self.set_plan(content)
                with self.assertRaises(ai.AIOperationError):
                    self.plan()

    def test_malformed_and_incomplete_response_errors_are_credential_safe(self):
        for body in (b"invalid-private-test-key", b"[]", b'{"choices":[null]}', b'{"choices":[]}'):
            type(self).response_bytes = body
            with self.subTest(body=body), self.assertRaises(ai.AIOperationError) as failure:
                self.plan()
            self.assertNotIn("private-test-key", str(failure.exception))
        self.set_plan({"clips": [{"start_cue": 1, "end_cue": 2}]}, finish="length")
        with self.assertRaises(ai.AIOperationError):
            self.plan()
        type(self).response_code = 401
        type(self).response_bytes = b'{"error":"private-test-key"}'
        with self.assertRaisesRegex(ai.AIOperationError, "HTTP 401") as failure:
            self.plan()
        self.assertNotIn("private-test-key", str(failure.exception))

    def test_provider_redirect_is_rejected_without_forwarding_authentication(self):
        type(self).response_code = 302
        with self.assertRaisesRegex(ai.AIOperationError, "HTTP 302"):
            self.plan()
        self.assertEqual(self.request_path, "/v1/chat/completions")

    def test_inconsistent_transcript_and_limits_rejected_before_network(self):
        bad = [dict(cue) for cue in CUES]
        bad[1]["start"] = 1
        with patch("ai_adapter.urlopen") as call:
            with self.assertRaises(ai.AIOperationError):
                self.plan(bad)
            with self.assertRaises(ai.AIOperationError):
                ai.plan_clips(CUES, min_seconds=float("nan"))
            with self.assertRaises(ai.AIOperationError):
                ai.plan_clips(CUES, target_count=13)
            call.assert_not_called()

    def test_backend_id_cues_and_absent_usage(self):
        cues = [{"id": cue["index"], **{k: v for k, v in cue.items() if k != "index"}} for cue in CUES]
        self.set_plan({"clips": [{"start_cue": 1, "end_cue": 2}]}, usage={})
        result = self.plan(cues)
        self.assertIsNone(result["usage"])

    def test_asr_without_local_model_never_imports_or_downloads(self):
        with self.assertRaises(ai.AIUnavailable):
            ai.transcribe_local("unavailable.mp4")
        self.assertFalse(ai.get_asr_status()["configured"])
        with tempfile.TemporaryDirectory() as local:
            with patch.dict(os.environ, {"BX_WHISPER_MODEL": local}), patch("ai_adapter.importlib.util.find_spec", return_value=None):
                self.assertFalse(ai.get_asr_status()["configured"])
                with self.assertRaises(ai.AIUnavailable):
                    ai.transcribe_local(Path(local) / "input.mp4")


if __name__ == "__main__":
    unittest.main()
