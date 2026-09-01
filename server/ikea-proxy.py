#!/usr/bin/env python3
"""PlanStudio API: IKEA model proxy + passphrase-keyed cloud sync.

IKEA proxy — the rotera CDN serves real-scale GLB models without auth but
refuses requests carrying a browser Origin header, so the app cannot fetch
them client-side. This proxy fetches server-side and re-serves with CORS.

    GET /api/ikea/model?item=00263850[&cc=tr&lc=tr]  ->  model/gltf-binary

Only 8-digit item numbers are accepted and only web-api.ikea.com is ever
contacted (no SSRF surface). Downloads are capped at 40 MB.

Cloud sync — the client derives key = sha256(passphrase) and uses it as a
capability token (the server never sees the passphrase; anyone with the
same passphrase syncs the same data):

    GET/POST /api/sync/<key64hex>/state        project state JSON (<= 8 MB)
    GET      /api/sync/<key64hex>/manifest     {"blobs": {id: {size, sha}}}
    GET/PUT  /api/sync/<key64hex>/blob/<id>    GLB blobs (<= 100 MB each)

Data lives under SYNC_DIR (default /data/sync); per-key quota 1 GB.
"""
import hashlib
import http.server
import json
import os
import re
import sys
import threading
import urllib.request
import urllib.parse

REGIONS = [('tr', 'tr'), ('us', 'en'), ('gb', 'en'), ('de', 'de'), ('fi', 'en')]
MAX_BYTES = 40 * 1024 * 1024
ITEM_RE = re.compile(r'^\d{8}$')

SYNC_DIR = os.environ.get('SYNC_DIR', '/data/sync')
KEY_RE = re.compile(r'^[0-9a-f]{64}$')
MAX_STATE = 8 * 1024 * 1024
MAX_BLOB = 100 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
_sync_lock = threading.Lock()


def _key_dir(key):
    d = os.path.join(SYNC_DIR, key)
    os.makedirs(os.path.join(d, 'blobs'), exist_ok=True)
    return d


def _manifest_path(d):
    return os.path.join(d, 'manifest.json')


def _load_manifest(d):
    try:
        with open(_manifest_path(d)) as f:
            return json.load(f)
    except Exception:
        return {'blobs': {}}


def _save_manifest(d, m):
    tmp = _manifest_path(d) + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(m, f)
    os.replace(tmp, _manifest_path(d))


def _blob_file(d, blob_id):
    # ids are arbitrary UTF-8 names — store under their hash
    return os.path.join(d, 'blobs', hashlib.sha256(blob_id.encode()).hexdigest()[:40] + '.bin')


def _key_usage(d, m):
    total = sum(b.get('size', 0) for b in m['blobs'].values())
    try:
        total += os.path.getsize(os.path.join(d, 'state.json'))
    except OSError:
        pass
    return total


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

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

    # ---------- sync helpers ----------

    def _sync_route(self):
        """Returns (key, kind, blob_id) or None if the path is not /api/sync/…"""
        parsed = urllib.parse.urlparse(self.path)
        parts = [urllib.parse.unquote(p) for p in parsed.path.split('/') if p]
        if len(parts) < 3 or parts[0] != 'api' or parts[1] != 'sync':
            return None
        key = parts[2]
        if not KEY_RE.match(key):
            self._fail(400, 'bad key')
            return 'handled'
        kind = parts[3] if len(parts) > 3 else ''
        if kind == 'state' and len(parts) == 4:
            return (key, 'state', None)
        if kind == 'manifest' and len(parts) == 4:
            return (key, 'manifest', None)
        if kind == 'blob' and len(parts) == 5 and 0 < len(parts[4]) <= 300:
            return (key, 'blob', parts[4])
        self._fail(404, 'not found')
        return 'handled'

    def _read_body(self, cap):
        try:
            n = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            n = -1
        if n <= 0 or n > cap:
            self._fail(413, 'body missing or too large')
            return None
        remaining, chunks = n, []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 1 << 20))
            if not chunk:
                self._fail(400, 'truncated body')
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b''.join(chunks)

    def _send(self, code, body, ctype='application/json'):
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _sync_get(self, key, kind, blob_id):
        d = _key_dir(key)
        if kind == 'manifest':
            with _sync_lock:
                m = _load_manifest(d)
            return self._send(200, json.dumps(m).encode())
        if kind == 'state':
            try:
                with open(os.path.join(d, 'state.json'), 'rb') as f:
                    return self._send(200, f.read())
            except OSError:
                return self._fail(404, 'no state for this key yet')
        # blob
        with _sync_lock:
            m = _load_manifest(d)
        if blob_id not in m['blobs']:
            return self._fail(404, 'no such blob')
        try:
            with open(_blob_file(d, blob_id), 'rb') as f:
                return self._send(200, f.read(), 'application/octet-stream')
        except OSError:
            return self._fail(404, 'blob file missing')

    def _sync_put(self, key, kind, blob_id):
        d = _key_dir(key)
        if kind == 'state':
            body = self._read_body(MAX_STATE)
            if body is None:
                return
            try:
                json.loads(body)
            except Exception:
                return self._fail(400, 'state must be JSON')
            tmp = os.path.join(d, 'state.json.tmp')
            with open(tmp, 'wb') as f:
                f.write(body)
            os.replace(tmp, os.path.join(d, 'state.json'))
            return self._send(200, b'{"ok":true}')
        if kind == 'blob':
            body = self._read_body(MAX_BLOB)
            if body is None:
                return
            sha = hashlib.sha256(body).hexdigest()
            with _sync_lock:
                m = _load_manifest(d)
                old = m['blobs'].get(blob_id, {}).get('size', 0)
                if _key_usage(d, m) - old + len(body) > MAX_TOTAL:
                    return self._fail(413, 'per-key quota exceeded (1 GB)')
                with open(_blob_file(d, blob_id), 'wb') as f:
                    f.write(body)
                m['blobs'][blob_id] = {'size': len(body), 'sha': sha}
                _save_manifest(d, m)
            return self._send(200, json.dumps({'ok': True, 'sha': sha}).encode())
        return self._fail(405, 'method not allowed')

    def do_PUT(self):
        r = self._sync_route()
        if r is None or r == 'handled':
            if r is None:
                self._fail(404, 'not found')
            return
        key, kind, blob_id = r
        if kind not in ('blob',):
            return self._fail(405, 'method not allowed')
        self._sync_put(key, kind, blob_id)

    def do_POST(self):
        r = self._sync_route()
        if r is None or r == 'handled':
            if r is None:
                self._fail(404, 'not found')
            return
        key, kind, blob_id = r
        if kind != 'state':
            return self._fail(405, 'method not allowed')
        self._sync_put(key, kind, blob_id)

    def do_GET(self):
        r = self._sync_route()
        if r == 'handled':
            return
        if r is not None:
            key, kind, blob_id = r
            return self._sync_get(key, kind, blob_id)
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
