# Local dev server that forbids caching, so an edited index.html never mixes
# with stale modules. Usage: python3 tools/serve.py [dir] [port]
import functools
import http.server
import sys


class NoStore(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


directory = sys.argv[1] if len(sys.argv) > 1 else '.'
port = int(sys.argv[2]) if len(sys.argv) > 2 else 8000
print(f'http://localhost:{port}')
http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(NoStore, directory=directory)).serve_forever()
