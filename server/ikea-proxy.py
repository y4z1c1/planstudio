#!/usr/bin/env python3
"""Tiny CORS proxy for IKEA "rotera" 3D models.

The rotera CDN serves real-scale GLB models of IKEA products without auth,
but refuses requests carrying a browser Origin header — so the app cannot
fetch them client-side. This proxy fetches server-side and re-serves with
CORS enabled.

    GET /api/ikea/model?item=00263850[&cc=tr&lc=tr]  ->  model/gltf-binary

Only 8-digit item numbers are accepted and only web-api.ikea.com is ever
contacted (no SSRF surface). Regions are tried in order until one has the
model. Downloads are capped at 40 MB.
"""
import http.server
import re
import sys
import urllib.request
import urllib.parse

REGIONS = [('tr', 'tr'), ('us', 'en'), ('gb', 'en'), ('de', 'de'), ('fi', 'en')]
MAX_BYTES = 40 * 1024 * 1024
ITEM_RE = re.compile(r'^\d{8}$')


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')

    def _fail(self, code, msg):
        body = msg.encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.rstrip('/') != '/api/ikea/model':
            return self._fail(404, 'not found')
        q = urllib.parse.parse_qs(parsed.query)
        item = (q.get('item') or [''])[0]
        if not ITEM_RE.match(item):
            return self._fail(400, 'item must be an 8-digit IKEA article number')

        regions = list(REGIONS)
        cc = (q.get('cc') or [''])[0].lower()
        lc = (q.get('lc') or [''])[0].lower()
        if re.match(r'^[a-z]{2}$', cc) and re.match(r'^[a-z]{2}$', lc):
            regions.insert(0, (cc, lc))

        for c, l in regions:
            url = f'https://web-api.ikea.com/{c}/{l}/rotera/static/models/{item}-mini.glb'
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'planstudio-proxy'})
                with urllib.request.urlopen(req, timeout=20) as r:
                    data = r.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES or data[:4] != b'glTF':
                    continue
                self.send_response(200)
                self._cors()
                self.send_header('Content-Type', 'model/gltf-binary')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Cache-Control', 'public, max-age=86400')
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception:
                continue
        self._fail(404, 'no 3D model found for this item')

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8090
    http.server.ThreadingHTTPServer(('', port), Handler).serve_forever()
