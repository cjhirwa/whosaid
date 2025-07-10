import http.client
import json
import os
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import server


class LoadEnvTest(unittest.TestCase):
    def test_parses_values_and_skips_comments(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text('# comment\nLT_A=one\nLT_B = "two"\n\nnot a pair\nLT_C=\'th=ree\'\n', encoding="utf-8")
            with mock.patch.dict(os.environ, {}, clear=False):
                server.load_env(path)
                self.assertEqual(os.environ["LT_A"], "one")
                self.assertEqual(os.environ["LT_B"], "two")
                self.assertEqual(os.environ["LT_C"], "th=ree")

    def test_does_not_override_existing_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text("LT_D=from-file\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {"LT_D": "from-env"}):
                server.load_env(path)
                self.assertEqual(os.environ["LT_D"], "from-env")

    def test_missing_file_is_ignored(self):
        server.load_env(Path("does-not-exist.env"))


class HandlerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, path, host="localhost"):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path, headers={"Host": f"{host}:{self.port}"})
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp, body

    def test_serves_page(self):
        resp, body = self.get("/")
        self.assertEqual(resp.status, 200)
        self.assertIn(b"<title>whosaid</title>", body)
        self.assertEqual(resp.getheader("Cache-Control"), "no-store")

    def test_serves_core_script(self):
        resp, body = self.get("/core.js")
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/javascript"))
        self.assertIn(b"class Transcript", body)

    def test_does_not_serve_other_files(self):
        for path in ("/.env", "/server.py", "/../.env", "/core.js/../.env"):
            resp, _ = self.get(path)
            self.assertEqual(resp.status, 404, path)

    def test_unknown_path_is_404(self):
        resp, _ = self.get("/nope")
        self.assertEqual(resp.status, 404)

    def test_rejects_foreign_host(self):
        resp, _ = self.get("/token", host="evil.example.com")
        self.assertEqual(resp.status, 403)

    def test_token_without_key(self):
        with mock.patch.object(server, "API_KEY", ""):
            resp, body = self.get("/token")
        self.assertEqual(resp.status, 500)
        self.assertIn("DEEPGRAM_API_KEY", json.loads(body)["error"])

    def test_token_success(self):
        with mock.patch.object(server, "API_KEY", "k"), mock.patch.object(server, "grant_token", return_value="jwt"):
            resp, body = self.get("/token")
        self.assertEqual(resp.status, 200)
        self.assertEqual(json.loads(body), {"access_token": "jwt", "model": server.MODEL})
        self.assertEqual(resp.getheader("Cache-Control"), "no-store")

    def test_token_upstream_error_is_reported(self):
        error = server.urllib.error.HTTPError(
            server.GRANT_URL, 403, "Forbidden", {}, None
        )
        error.read = lambda: b'{"err_msg": "Insufficient permissions."}'
        with mock.patch.object(server, "API_KEY", "k"), mock.patch.object(server, "grant_token", side_effect=error):
            resp, body = self.get("/token")
        self.assertEqual(resp.status, 502)
        self.assertEqual(json.loads(body)["error"], "Deepgram 403: Insufficient permissions.")


if __name__ == "__main__":
    unittest.main()
