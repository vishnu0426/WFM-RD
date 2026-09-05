#!/usr/bin/env python3
"""Dev-only static file server for frontend/ that disables all caching.

Plain `python3 -m http.server` sends no Cache-Control header at all, so
Safari (and other browsers) can keep serving a stale cached copy of a JS
module across ordinary reloads - confirmed live: after shipping a real
fix, curl against this server already returned the corrected file, but
the browser kept executing the old one until a hard refresh. Every
response here carries Cache-Control: no-store so a normal reload always
gets the current file.
"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    http.server.test(HandlerClass=NoCacheHandler, port=port)
