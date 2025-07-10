"""whosaid: live transcription with speaker labels. Serves the web UI and hands the browser short-lived
Deepgram tokens, so the real API key never leaves this machine.

Run:  python server.py   then open http://localhost:8765
"""

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).parent
GRANT_URL = "https://api.deepgram.com/v1/auth/grant"
TOKEN_TTL = 60  # only needs to last until the WebSocket connects
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/core.js": ("core.js", "text/javascript; charset=utf-8"),
}


def load_env(path):
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env(ROOT / ".env")
API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
MODEL = os.environ.get("DEEPGRAM_MODEL", "nova-3")
PORT = int(os.environ.get("PORT", "8765"))


def grant_token():
    req = urllib.request.Request(
        GRANT_URL,
        data=json.dumps({"ttl_seconds": TOKEN_TTL}).encode(),
        headers={
            "Authorization": f"Token {API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "whosaid/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)["access_token"]


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Reject other hostnames so a DNS-rebinding page can't read tokens.
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in ("localhost", "127.0.0.1"):
            self.send_error(403)
            return
        if self.path in STATIC:
            filename, content_type = STATIC[self.path]
            body = (ROOT / filename).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/token":
            self.handle_token()
        else:
            self.send_error(404)

    def handle_token(self):
        if not API_KEY:
            self.send_json(500, {"error": "DEEPGRAM_API_KEY is not set in .env"})
            return
        try:
            token = grant_token()
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            try:
                parsed = json.loads(detail)
                detail = parsed.get("err_msg") or parsed.get("message") or detail
            except ValueError:
                pass
            self.send_json(502, {"error": f"Deepgram {e.code}: {detail}"})
            return
        except Exception as e:  # network errors, timeouts
            self.send_json(502, {"error": str(e)})
            return
        self.send_json(200, {"access_token": token, "model": MODEL})

    def log_message(self, fmt, *args):
        if "/token" not in str(args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    if not API_KEY:
        print("Warning: DEEPGRAM_API_KEY is not set; add it to .env")
    print(f"whosaid running on http://localhost:{PORT}  (model: {MODEL})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
