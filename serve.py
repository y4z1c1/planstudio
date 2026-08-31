#!/usr/bin/env python3
"""Static dev server with caching disabled (browsers heuristically cache ES
modules served by plain http.server, which breaks development)."""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8741
    http.server.ThreadingHTTPServer(('', port), NoCacheHandler).serve_forever()
