"""Minimal allowlist forward proxy for Brain sandboxes.

Only exact host:port pairs from BRAIN_EGRESS_ALLOWLIST (comma-separated)
are proxied. Everything else is refused. No redirect following here; the
client receives upstream bytes verbatim. Runs as the sole egress member of
the internal sandbox network.
"""
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ALLOW = {entry.strip() for entry in os.environ.get("BRAIN_EGRESS_ALLOWLIST", "").split(",") if entry.strip()}
MAX_BODY = 1024 * 1024


def host_port(value: str, default_port: int = 80) -> tuple[str, int]:
    if ":" in value:
        host, port = value.rsplit(":", 1)
        return host, int(port)
    return value, default_port


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _deny(self, target: str) -> None:
        body = f"egress denied: {target}\n".encode()
        self.send_response(403)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_CONNECT(self) -> None:  # noqa: N802
        target = self.path
        if target not in ALLOW:
            self._deny(target)
            return
        host, port = host_port(target, 443)
        try:
            upstream = socket.create_connection((host, port), timeout=10)
        except OSError:
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200, "Connection Established")
        self.end_headers()

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                try:
                    dst.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        threading.Thread(target=pump, args=(self.connection, upstream), daemon=True).start()
        pump(upstream, self.connection)

    def _forward(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.hostname:
            self._deny(self.path)
            return
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        target = f"{parsed.hostname}:{port}"
        if target not in ALLOW:
            self._deny(target)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self._deny("body-too-large")
            return
        body = self.rfile.read(length) if length else b""
        import http.client

        conn_cls = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(parsed.hostname, port, timeout=15)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        headers = {k: v for k, v in self.headers.items() if k.lower() not in {"host", "proxy-connection", "proxy-authorization"}}
        conn.request(self.command, path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read(MAX_BODY + 1)
        self.send_response(resp.status, resp.reason)
        for key, value in resp.getheaders():
            if key.lower() in {"transfer-encoding", "connection", "content-length"}:
                continue
            self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        conn.close()

    do_GET = _forward
    do_POST = _forward
    do_PUT = _forward
    do_DELETE = _forward

    def log_message(self, *args):  # keep stdout clean
        pass


if __name__ == "__main__":
    port = int(os.environ.get("BRAIN_PROXY_PORT", "18080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
