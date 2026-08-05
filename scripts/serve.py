#!/usr/bin/env python3
"""개발용 정적 서버. no-store 를 붙여 브라우저·시뮬레이터가 옛 JS/CSS 를 물지 않게 한다
(CLAUDE.md 함정 6). `python3 scripts/serve.py [포트]`"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f"http://localhost:{port}  (no-store)")
ThreadingHTTPServer(("", port), partial(NoCache, directory=".")).serve_forever()
