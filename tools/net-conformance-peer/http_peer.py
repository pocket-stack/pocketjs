#!/usr/bin/env python3
"""Independent HTTP/1.1 peer for PocketJS LAN smoke and wire tests.

The server intentionally uses only Python's socket APIs. It does not import
PocketJS code or share an HTTP parser with a PocketJS backend.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import socket
import socketserver
import ssl
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable
from urllib.parse import parse_qs, urlsplit


SERVER_NAME = "pocketjs-independent-mac-peer/1"
DEFAULT_BODY_LIMIT = 16 * 1024
DEFAULT_HEADER_LIMIT = 16 * 1024
MAX_CHUNK_SIZE_LINE_BYTES = 18
MAX_ATTEMPT_TOKENS = 1024
VALID_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
STATUS_REASONS = {
    200: "OK",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    307: "Temporary Redirect",
    308: "Permanent Redirect",
    400: "Bad Request",
    404: "Not Found",
    405: "Method Not Allowed",
    413: "Content Too Large",
    431: "Request Header Fields Too Large",
    500: "Internal Server Error",
    503: "Service Unavailable",
}


class RequestError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class Request:
    method: str
    target: str
    path: str
    query: dict[str, list[str]]
    version: str
    headers: tuple[tuple[str, str], ...]
    body: bytes

    def header_values(self, name: str) -> list[str]:
        lowered = name.lower()
        return [value for key, value in self.headers if key.lower() == lowered]


class EventSink:
    def __init__(self, path: Path | None, quiet: bool) -> None:
        self._lock = threading.Lock()
        self._quiet = quiet
        self._file: BinaryIO | None = path.open("ab") if path is not None else None

    def emit(self, event: str, **fields: object) -> None:
        record = {
            "event": event,
            "monotonic_ns": time.monotonic_ns(),
            **fields,
        }
        encoded = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode()
        with self._lock:
            if not self._quiet:
                sys.stdout.buffer.write(encoded)
                sys.stdout.buffer.flush()
            if self._file is not None:
                self._file.write(encoded)
                self._file.flush()

    def close(self) -> None:
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None


class PeerState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._next_connection_id = 1
        self._connections = 0
        self._active_connections = 0
        self._requests = 0
        self._attempts: dict[str, int] = {}

    def connection_opened(self) -> int:
        with self._lock:
            connection_id = self._next_connection_id
            self._next_connection_id += 1
            self._connections += 1
            self._active_connections += 1
            return connection_id

    def connection_closed(self) -> None:
        with self._lock:
            self._active_connections -= 1

    def request_received(self) -> int:
        with self._lock:
            self._requests += 1
            return self._requests

    def attempt(self, token: str) -> int | None:
        with self._lock:
            if token not in self._attempts and len(self._attempts) >= MAX_ATTEMPT_TOKENS:
                return None
            count = self._attempts.get(token, 0) + 1
            self._attempts[token] = count
            return count

    def attempt_count(self, token: str) -> int:
        with self._lock:
            return self._attempts.get(token, 0)

    def metrics(self) -> dict[str, int]:
        with self._lock:
            return {
                "connections": self._connections,
                "active_connections": self._active_connections,
                "requests": self._requests,
                "attempt_tokens": len(self._attempts),
            }


class ThreadingPeerServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        *,
        body_limit: int,
        header_limit: int,
        socket_timeout_ms: int,
        delay_ceiling_ms: int,
        events: EventSink,
        tls_context: ssl.SSLContext | None = None,
        observe_tls_close_notify: bool = False,
        tls_handshake_delay_ms: int = 0,
    ) -> None:
        self.body_limit = body_limit
        self.header_limit = header_limit
        self.socket_timeout = socket_timeout_ms / 1000
        self.delay_ceiling_ms = delay_ceiling_ms
        self.events = events
        self.state = PeerState()
        self.tls_context = tls_context
        self.observe_tls_close_notify = observe_tls_close_notify
        self.tls_handshake_delay_ms = tls_handshake_delay_ms
        if self.tls_context is not None:
            self.tls_context.set_servername_callback(self._record_tls_server_name)
        super().__init__(address, PeerHandler)

    def _record_tls_server_name(
        self,
        secure_request: ssl.SSLSocket,
        server_name: str | None,
        initial_context: ssl.SSLContext,
    ) -> None:
        del initial_context
        secure_request.pocketjs_server_name = server_name  # type: ignore[attr-defined]
        try:
            peer_ipv4 = secure_request.getpeername()[0]
        except OSError:
            peer_ipv4 = None
        self.events.emit(
            "tls_client_hello",
            peer_ipv4=peer_ipv4,
            server_name=server_name,
        )

    def get_request(self) -> tuple[socket.socket, tuple[str, int]]:
        request, address = super().get_request()
        if self.tls_context is None:
            return request, address

        request.settimeout(self.socket_timeout)
        secure_request = self.tls_context.wrap_socket(
            request,
            server_side=True,
            do_handshake_on_connect=False,
            suppress_ragged_eofs=not self.observe_tls_close_notify,
        )
        return secure_request, address

    def handle_error(
        self,
        request: socket.socket,
        client_address: tuple[str, int],
    ) -> None:
        if getattr(request, "pocketjs_handshake_failed", False):
            return
        super().handle_error(request, client_address)


class PeerHandler(socketserver.BaseRequestHandler):
    server: ThreadingPeerServer

    def setup(self) -> None:
        super().setup()
        self.tls_close_state: str | None = None
        self.request.settimeout(self.server.socket_timeout)
        if isinstance(self.request, ssl.SSLSocket):
            if self.server.observe_tls_close_notify:
                self.tls_close_state = "not_observed"
            try:
                if self.server.tls_handshake_delay_ms:
                    self.server.events.emit(
                        "tls_handshake_delay",
                        peer_ipv4=self.client_address[0],
                        delay_ms=self.server.tls_handshake_delay_ms,
                    )
                    time.sleep(self.server.tls_handshake_delay_ms / 1000)
                self.request.do_handshake()
            except OSError as error:
                self.request.pocketjs_handshake_failed = True  # type: ignore[attr-defined]
                self.server.events.emit(
                    "tls_handshake_error",
                    peer_ipv4=self.client_address[0],
                    error=type(error).__name__,
                )
                raise
        self.connection_id = self.server.state.connection_opened()
        self.connection_request_index = 0
        fields: dict[str, object] = {
            "connection_id": self.connection_id,
            "peer_ipv4": self.client_address[0],
            "transport": "plaintext",
        }
        if isinstance(self.request, ssl.SSLSocket):
            cipher = self.request.cipher()
            fields.update(
                transport="tls",
                tls_version=self.request.version(),
                tls_cipher=cipher[0] if cipher is not None else None,
                tls_server_name=getattr(
                    self.request, "pocketjs_server_name", None
                ),
            )
        self.server.events.emit("connection_open", **fields)

    def finish(self) -> None:
        self.server.state.connection_closed()
        fields: dict[str, object] = {
            "connection_id": self.connection_id,
            "requests": self.connection_request_index,
        }
        if self.tls_close_state is not None:
            fields["tls_close_state"] = self.tls_close_state
            fields["tls_close_notify_observed"] = (
                self.tls_close_state == "close_notify"
            )
        self.server.events.emit("connection_close", **fields)
        super().finish()

    def handle(self) -> None:
        buffered = b""
        while True:
            try:
                request, buffered = self._read_request(buffered)
            except RequestError as error:
                self._send_fixed(error.status, error.message.encode(), keep_alive=False)
                return
            except ssl.SSLEOFError:
                if self.tls_close_state is not None:
                    self.tls_close_state = "ragged_eof"
                return
            except (ConnectionError, socket.timeout):
                return

            if request is None:
                return

            self.connection_request_index += 1
            request_id = self.server.state.request_received()
            self.server.events.emit(
                "request",
                connection_id=self.connection_id,
                connection_request_index=self.connection_request_index,
                request_id=request_id,
                method=request.method,
                path=request.path,
                query_names=sorted(request.query),
                header_names=sorted({name.lower() for name, _ in request.headers}),
                body_bytes=len(request.body),
            )

            keep_alive = request.version == "HTTP/1.1"
            connection_values = request.header_values("connection")
            if any(value.lower() == "close" for value in connection_values):
                keep_alive = False

            try:
                keep_alive = self._route(request, keep_alive)
            except RequestError as error:
                self._send_fixed(error.status, error.message.encode(), keep_alive=False)
                return
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
                return
            if not keep_alive:
                return

    def _read_request(self, buffered: bytes) -> tuple[Request | None, bytes]:
        marker = b"\r\n\r\n"
        while marker not in buffered:
            if len(buffered) >= self.server.header_limit:
                raise RequestError(431, "request headers exceed configured limit")
            chunk = self.request.recv(min(4096, self.server.header_limit - len(buffered)))
            if not chunk:
                if buffered:
                    raise RequestError(400, "connection closed in request headers")
                if self.tls_close_state is not None:
                    self.tls_close_state = "close_notify"
                return None, b""
            buffered += chunk

        header_block, buffered = buffered.split(marker, 1)
        if len(header_block) + len(marker) > self.server.header_limit:
            raise RequestError(431, "request headers exceed configured limit")

        lines = header_block.split(b"\r\n")
        if not lines or not lines[0]:
            raise RequestError(400, "missing request line")
        try:
            method, target, version = lines[0].decode("ascii").split(" ")
        except (UnicodeDecodeError, ValueError) as error:
            raise RequestError(400, "invalid request line") from error
        if version not in {"HTTP/1.0", "HTTP/1.1"} or not target.startswith("/"):
            raise RequestError(400, "unsupported request target or HTTP version")

        headers: list[tuple[str, str]] = []
        for raw_line in lines[1:]:
            if raw_line.startswith((b" ", b"\t")) or b":" not in raw_line:
                raise RequestError(400, "invalid request header")
            raw_name, raw_value = raw_line.split(b":", 1)
            try:
                name = raw_name.decode("ascii")
                value = raw_value.decode("iso-8859-1").strip(" \t")
            except UnicodeDecodeError as error:
                raise RequestError(400, "invalid request header encoding") from error
            if not name or not all(character.isalnum() or character in "!#$%&'*+-.^_`|~" for character in name):
                raise RequestError(400, "invalid request header name")
            headers.append((name, value))

        content_lengths = [
            value for name, value in headers if name.lower() == "content-length"
        ]
        transfer_encodings = [
            value for name, value in headers if name.lower() == "transfer-encoding"
        ]
        trailer_declarations = [
            value for name, value in headers if name.lower() == "trailer"
        ]
        if len(transfer_encodings) > 1:
            raise RequestError(400, "duplicate Transfer-Encoding")
        if transfer_encodings and content_lengths:
            raise RequestError(400, "Transfer-Encoding conflicts with Content-Length")
        if transfer_encodings:
            if version != "HTTP/1.1" or transfer_encodings[0].lower() != "chunked":
                raise RequestError(400, "unsupported request transfer coding")
            if trailer_declarations:
                raise RequestError(400, "chunked request trailers are not supported")
            body, buffered = self._read_chunked_request_body(buffered)
            parsed = urlsplit(target)
            return (
                Request(
                    method=method,
                    target=target,
                    path=parsed.path,
                    query=parse_qs(parsed.query, keep_blank_values=True),
                    version=version,
                    headers=tuple(headers),
                    body=body,
                ),
                buffered,
            )
        if len(content_lengths) > 1:
            raise RequestError(400, "duplicate Content-Length")
        if content_lengths and (
            not content_lengths[0]
            or any(character < "0" or character > "9" for character in content_lengths[0])
        ):
            raise RequestError(400, "invalid Content-Length")
        body_length = int(content_lengths[0]) if content_lengths else 0
        if body_length > self.server.body_limit:
            raise RequestError(413, "request body exceeds configured limit")

        while len(buffered) < body_length:
            chunk = self.request.recv(min(4096, body_length - len(buffered)))
            if not chunk:
                raise RequestError(400, "connection closed in request body")
            buffered += chunk
        body, buffered = buffered[:body_length], buffered[body_length:]
        parsed = urlsplit(target)
        return (
            Request(
                method=method,
                target=target,
                path=parsed.path,
                query=parse_qs(parsed.query, keep_blank_values=True),
                version=version,
                headers=tuple(headers),
                body=body,
            ),
            buffered,
        )

    def _read_chunked_request_body(self, buffered: bytes) -> tuple[bytes, bytes]:
        body = bytearray()
        while True:
            size_line, buffered = self._read_bounded_line(
                buffered,
                MAX_CHUNK_SIZE_LINE_BYTES,
                "chunk size line exceeds configured limit",
            )
            if not size_line or any(
                byte not in b"0123456789abcdefABCDEF" for byte in size_line
            ):
                raise RequestError(400, "invalid chunk size")
            chunk_size = int(size_line, 16)
            if chunk_size > self.server.body_limit - len(body):
                raise RequestError(413, "request body exceeds configured limit")
            if chunk_size == 0:
                while len(buffered) < 2:
                    chunk = self.request.recv(2 - len(buffered))
                    if not chunk:
                        raise RequestError(400, "connection closed in chunk trailer")
                    buffered += chunk
                if not buffered.startswith(b"\r\n"):
                    raise RequestError(400, "chunked request trailers are not supported")
                return bytes(body), buffered[2:]

            required = chunk_size + 2
            while len(buffered) < required:
                chunk = self.request.recv(min(4096, required - len(buffered)))
                if not chunk:
                    raise RequestError(400, "connection closed in chunk data")
                buffered += chunk
            if buffered[chunk_size:required] != b"\r\n":
                raise RequestError(400, "chunk data is missing CRLF")
            body.extend(buffered[:chunk_size])
            buffered = buffered[required:]

    def _read_bounded_line(
        self,
        buffered: bytes,
        maximum_bytes: int,
        limit_message: str,
    ) -> tuple[bytes, bytes]:
        marker = b"\r\n"
        while marker not in buffered:
            if len(buffered) >= maximum_bytes:
                raise RequestError(400, limit_message)
            chunk = self.request.recv(min(4096, maximum_bytes - len(buffered)))
            if not chunk:
                raise RequestError(400, "connection closed in chunk size")
            buffered += chunk
        line, remainder = buffered.split(marker, 1)
        if len(line) + len(marker) > maximum_bytes:
            raise RequestError(400, limit_message)
        return line, remainder

    def _route(self, request: Request, keep_alive: bool) -> bool:
        if request.path == "/health":
            if request.method not in {"GET", "HEAD"}:
                return self._method_not_allowed(keep_alive)
            body = json.dumps(
                {
                    "status": "ok",
                    "peer": "mac",
                    "protocol": "pocketjs-independent-peer-v1",
                },
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
            return self._send_fixed(
                200,
                b"" if request.method == "HEAD" else body,
                keep_alive=keep_alive,
                content_length=len(body),
                headers=(("Content-Type", "application/json"),),
            )

        if request.path == "/echo":
            if request.method != "POST":
                return self._method_not_allowed(keep_alive)
            return self._send_fixed(
                200,
                request.body,
                keep_alive=keep_alive,
                headers=(("Content-Type", "application/octet-stream"),),
            )

        if request.path == "/chunked":
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            delay_ms = self._query_milliseconds(request, "fragment_ms", 0)
            self._send_headers(
                200,
                keep_alive=keep_alive,
                headers=(
                    ("Content-Type", "application/octet-stream"),
                    ("Transfer-Encoding", "chunked"),
                    ("Trailer", "X-PocketJS-Trailer"),
                ),
            )
            for chunk in (b"PocketJS", b"-independent-", b"peer"):
                self._send_fragment(b"%X\r\n" % len(chunk) + chunk + b"\r\n", delay_ms)
            self._send_fragment(b"0\r\nX-PocketJS-Trailer: complete\r\n\r\n", delay_ms)
            return keep_alive

        if request.path == "/delay":
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            delay_ms = self._query_milliseconds(request, "ms", 1000)
            phase = self._single_query_value(request, "phase", "headers")
            body = b"delayed-response"
            if phase == "headers":
                time.sleep(delay_ms / 1000)
                return self._send_fixed(200, body, keep_alive=keep_alive)
            if phase == "body":
                self._send_headers(
                    200,
                    keep_alive=keep_alive,
                    headers=(("Content-Length", str(len(body))),),
                )
                time.sleep(delay_ms / 1000)
                self.request.sendall(body)
                return keep_alive
            if phase == "chunk":
                self._send_headers(
                    200,
                    keep_alive=keep_alive,
                    headers=(("Transfer-Encoding", "chunked"),),
                )
                self.request.sendall(b"7\r\ndelayed\r\n")
                time.sleep(delay_ms / 1000)
                self.request.sendall(b"9\r\n-response\r\n0\r\n\r\n")
                return keep_alive
            return self._send_fixed(400, b"unknown delay phase", keep_alive=False)

        if request.path == "/disconnect":
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            phase = self._single_query_value(request, "phase", "before_headers")
            if phase == "before_headers":
                return False
            if phase == "mid_headers":
                self.request.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 32\r\nX-PocketJS"
                )
                return False
            if phase == "mid_body":
                self._send_headers(
                    200,
                    keep_alive=False,
                    headers=(("Content-Length", "32"),),
                )
                self.request.sendall(b"partial")
                return False
            return self._send_fixed(400, b"unknown disconnect phase", keep_alive=False)

        if request.path.startswith("/malformed/"):
            if request.method != "GET":
                return self._method_not_allowed(False)
            return self._send_malformed(request.path.removeprefix("/malformed/"))

        if request.path == "/redirect":
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            target = self._single_query_value(request, "to", "/health")
            try:
                status = int(self._single_query_value(request, "status", "302"))
            except ValueError:
                return self._send_fixed(400, b"invalid redirect status", keep_alive=False)
            if (
                status not in VALID_REDIRECT_STATUSES
                or not target.startswith("/")
                or "\r" in target
                or "\n" in target
            ):
                return self._send_fixed(400, b"invalid redirect", keep_alive=False)
            return self._send_fixed(
                status,
                b"redirect",
                keep_alive=keep_alive,
                headers=(("Location", target),),
            )

        if request.path.startswith("/status/"):
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            try:
                status = int(request.path.removeprefix("/status/"))
            except ValueError:
                status = 0
            if status < 400 or status > 599:
                return self._send_fixed(400, b"status must be in 400..599", keep_alive=False)
            return self._send_fixed(status, f"status-{status}".encode(), keep_alive=keep_alive)

        if request.path == "/retry-once":
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            token = self._attempt_token(request)
            if token is None:
                return self._send_fixed(400, b"token must contain 1..64 safe characters", keep_alive=False)
            attempt = self.server.state.attempt(token)
            if attempt is None:
                return self._send_fixed(503, b"attempt token capacity exhausted", keep_alive=False)
            if attempt == 1:
                return False
            return self._send_fixed(
                200,
                f"attempt-{attempt}".encode(),
                keep_alive=keep_alive,
                headers=(("X-PocketJS-Attempt", str(attempt)),),
            )

        if request.path == "/attempts":
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            token = self._attempt_token(request)
            if token is None:
                return self._send_fixed(400, b"token must contain 1..64 safe characters", keep_alive=False)
            body = json.dumps(
                {"attempts": self.server.state.attempt_count(token)},
                separators=(",", ":"),
            ).encode()
            return self._send_fixed(
                200,
                body,
                keep_alive=keep_alive,
                headers=(("Content-Type", "application/json"),),
            )

        if request.path == "/metrics":
            if request.method != "GET":
                return self._method_not_allowed(keep_alive)
            body = json.dumps(
                self.server.state.metrics(), sort_keys=True, separators=(",", ":")
            ).encode()
            return self._send_fixed(
                200,
                body,
                keep_alive=keep_alive,
                headers=(("Content-Type", "application/json"),),
            )

        return self._send_fixed(404, b"not found", keep_alive=keep_alive)

    def _send_malformed(self, case: str) -> bool:
        responses = {
            "te-cl": (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
                b"Content-Length: 5\r\nConnection: close\r\n\r\n5\r\nhello\r\n0\r\n\r\n"
            ),
            "duplicate-content-length": (
                b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Length: 5\r\n"
                b"Connection: close\r\n\r\nhello"
            ),
            "obs-fold": (
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nX-PocketJS: first\r\n"
                b" second\r\nConnection: close\r\n\r\nok"
            ),
            "te-duplicate": (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
                b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n"
            ),
            "te-combined": (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n"
                b"Connection: close\r\n\r\n0\r\n\r\n"
            ),
            "te-unknown": (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n"
                b"Connection: close\r\n\r\nopaque"
            ),
            "trailer-forbidden": (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
                b"Trailer: Content-Length\r\nConnection: close\r\n\r\n"
                b"2\r\nok\r\n0\r\nContent-Length: 2\r\n\r\n"
            ),
            "chunk-size": (
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n"
                b"Connection: close\r\n\r\nZ\r\ninvalid\r\n0\r\n\r\n"
            ),
        }
        response = responses.get(case)
        if response is None:
            return self._send_fixed(404, b"unknown malformed case", keep_alive=False)
        self.request.sendall(response)
        return False

    def _method_not_allowed(self, keep_alive: bool) -> bool:
        return self._send_fixed(405, b"method not allowed", keep_alive=keep_alive)

    def _send_fixed(
        self,
        status: int,
        body: bytes,
        *,
        keep_alive: bool,
        content_length: int | None = None,
        headers: Iterable[tuple[str, str]] = (),
    ) -> bool:
        all_headers = list(headers)
        all_headers.append(
            ("Content-Length", str(len(body) if content_length is None else content_length))
        )
        self._send_headers(status, keep_alive=keep_alive, headers=all_headers)
        if body:
            self.request.sendall(body)
        return keep_alive

    def _send_headers(
        self,
        status: int,
        *,
        keep_alive: bool,
        headers: Iterable[tuple[str, str]],
    ) -> None:
        reason = STATUS_REASONS.get(status, "Test Status")
        lines = [
            f"HTTP/1.1 {status} {reason}",
            f"Server: {SERVER_NAME}",
            f"X-PocketJS-Connection: {self.connection_id}",
            f"X-PocketJS-Request: {self.connection_request_index}",
            f"Connection: {'keep-alive' if keep_alive else 'close'}",
        ]
        lines.extend(f"{name}: {value}" for name, value in headers)
        self.request.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))

    def _send_fragment(self, fragment: bytes, delay_ms: int) -> None:
        self.request.sendall(fragment)
        if delay_ms:
            time.sleep(delay_ms / 1000)

    def _query_milliseconds(self, request: Request, name: str, default: int) -> int:
        try:
            value = int(self._single_query_value(request, name, str(default)))
        except ValueError as error:
            raise RequestError(400, f"{name} must be an integer") from error
        if value < 0 or value > self.server.delay_ceiling_ms:
            raise RequestError(
                400, f"{name} must be in 0..{self.server.delay_ceiling_ms}"
            )
        return value

    @staticmethod
    def _single_query_value(request: Request, name: str, default: str) -> str:
        values = request.query.get(name)
        return values[0] if values else default

    @staticmethod
    def _attempt_token(request: Request) -> str | None:
        values = request.query.get("token")
        if not values:
            return None
        token = values[0]
        if not 1 <= len(token) <= 64:
            return None
        if not all(character.isalnum() or character in "-_." for character in token):
            return None
        return token


def build_probe_path(prefix: str, endpoint: str) -> str:
    normalized = prefix.rstrip("/")
    return f"{normalized}{endpoint}" if normalized else endpoint


def read_bounded(response: http.client.HTTPResponse, limit: int) -> bytes:
    body = response.read(limit + 1)
    if len(body) > limit:
        raise RuntimeError(f"response body exceeds probe limit of {limit} bytes")
    return body


def connection_identity(connection: http.client.HTTPConnection) -> tuple[str, int]:
    if connection.sock is None:
        raise RuntimeError("peer closed a connection that should remain persistent")
    address = connection.sock.getsockname()
    return str(address[0]), int(address[1])


def create_server_tls_context(
    cert_path: Path,
    key_path: Path,
    minimum_version: str,
) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = tls_version(minimum_version)
    context.load_cert_chain(certfile=cert_path, keyfile=key_path)
    return context


def certificate_der_sha256(cert_path: Path) -> str:
    pem = cert_path.read_text(encoding="ascii")
    der = ssl.PEM_cert_to_DER_cert(pem)
    return hashlib.sha256(der).hexdigest()


def tls_version(value: str) -> ssl.TLSVersion:
    return {
        "1.2": ssl.TLSVersion.TLSv1_2,
        "1.3": ssl.TLSVersion.TLSv1_3,
    }[value]


def run_probe(args: argparse.Namespace) -> int:
    parsed = urlsplit(args.base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError(
            "--base-url must be an http:// or https:// host[:port][/prefix] URL"
        )
    if parsed.scheme == "http" and args.ca_cert:
        raise ValueError("--ca-cert requires an https:// base URL")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if parsed.scheme == "https":
        ca_path = Path(args.ca_cert).expanduser() if args.ca_cert else None
        context = ssl.create_default_context(cafile=ca_path)
        connection: http.client.HTTPConnection = http.client.HTTPSConnection(
            parsed.hostname,
            port,
            timeout=args.timeout_ms / 1000,
            context=context,
        )
    else:
        connection = http.client.HTTPConnection(
            parsed.hostname, port, timeout=args.timeout_ms / 1000
        )
    health_path = build_probe_path(parsed.path, "/health")
    echo_path = build_probe_path(parsed.path, "/echo")
    started = time.monotonic()
    try:
        for round_index in range(1, args.rounds + 1):
            round_started = time.monotonic()
            connection.request("GET", health_path, headers={"Connection": "keep-alive"})
            health = connection.getresponse()
            health_body = read_bounded(health, args.response_limit_bytes)
            if health.status != 200:
                raise RuntimeError(f"health returned HTTP {health.status}")
            if args.health_contains.encode() not in health_body:
                raise RuntimeError(
                    f"health body does not contain {args.health_contains!r}"
                )
            persistent_identity = connection_identity(connection)

            echo_body = (
                f"pocketjs-mac-probe-round-{round_index}:".encode()
                + bytes((0, 1, 127, 128, 254, 255))
            )
            connection.request(
                "POST",
                echo_path,
                body=echo_body,
                headers={
                    "Content-Type": "application/octet-stream",
                    "Connection": "keep-alive",
                },
            )
            if connection_identity(connection) != persistent_identity:
                raise RuntimeError("server did not reuse the health connection for echo")
            echo = connection.getresponse()
            echoed = read_bounded(echo, args.response_limit_bytes)
            if echo.status != 200:
                raise RuntimeError(f"echo returned HTTP {echo.status}")
            if echoed != echo_body:
                raise RuntimeError(
                    f"echo mismatch: sent {len(echo_body)} bytes, received {len(echoed)}"
                )
            if connection_identity(connection) != persistent_identity:
                raise RuntimeError("server closed the persistent connection after echo")

            record = {
                "event": "probe_round_pass",
                "round": round_index,
                "health_bytes": len(health_body),
                "echo_bytes": len(echoed),
                "latency_ms": round((time.monotonic() - round_started) * 1000, 3),
            }
            print(json.dumps(record, sort_keys=True, separators=(",", ":")), flush=True)
            if round_index != args.rounds and args.interval_ms:
                time.sleep(args.interval_ms / 1000)
    finally:
        connection.close()

    print(
        json.dumps(
            {
                "event": "probe_pass",
                "rounds": args.rounds,
                "elapsed_ms": round((time.monotonic() - started) * 1000, 3),
            },
            sort_keys=True,
            separators=(",", ":"),
        ),
        flush=True,
    )
    return 0


def run_server(args: argparse.Namespace) -> int:
    if bool(args.tls_cert) != bool(args.tls_key):
        raise ValueError("--tls-cert and --tls-key must be provided together")
    if args.observe_tls_close_notify and not args.tls_cert:
        raise ValueError("--observe-tls-close-notify requires TLS")
    if args.tls_handshake_delay_ms and not args.tls_cert:
        raise ValueError("--tls-handshake-delay-ms requires TLS")
    if args.tls_handshake_delay_ms > args.delay_ceiling_ms:
        raise ValueError("--tls-handshake-delay-ms exceeds --delay-ceiling-ms")
    tls_context = None
    tls_certificate_der_sha256 = None
    if args.tls_cert:
        if args.tls_max_version and tls_version(
            args.tls_max_version
        ) < tls_version(args.tls_min_version):
            raise ValueError("--tls-max-version must not be below --tls-min-version")
        cert_path = Path(args.tls_cert).expanduser()
        tls_context = create_server_tls_context(
            cert_path,
            Path(args.tls_key).expanduser(),
            args.tls_min_version,
        )
        tls_certificate_der_sha256 = certificate_der_sha256(cert_path)
        if args.tls_max_version:
            tls_context.maximum_version = tls_version(args.tls_max_version)

    event_path = Path(args.events).expanduser() if args.events else None
    if event_path is not None:
        event_path.parent.mkdir(parents=True, exist_ok=True)
    events = EventSink(event_path, args.quiet_events)
    server = ThreadingPeerServer(
        (args.host, args.port),
        body_limit=args.max_request_body_bytes,
        header_limit=args.max_header_bytes,
        socket_timeout_ms=args.socket_timeout_ms,
        delay_ceiling_ms=args.delay_ceiling_ms,
        events=events,
        tls_context=tls_context,
        observe_tls_close_notify=args.observe_tls_close_notify,
        tls_handshake_delay_ms=args.tls_handshake_delay_ms,
    )
    host, port = server.server_address[:2]
    events.emit(
        "peer_ready",
        bind_host=host,
        port=port,
        transport="tls" if tls_context is not None else "plaintext",
        tls_min_version=args.tls_min_version if tls_context is not None else None,
        tls_max_version=(
            args.tls_max_version if tls_context is not None else None
        ),
        tls_certificate_der_sha256=tls_certificate_der_sha256,
        observe_tls_close_notify=args.observe_tls_close_notify,
        tls_handshake_delay_ms=args.tls_handshake_delay_ms,
        socket_timeout_ms=args.socket_timeout_ms,
        max_header_bytes=args.max_header_bytes,
        max_request_body_bytes=args.max_request_body_bytes,
    )
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        events.emit("peer_stop", reason="keyboard_interrupt")
    finally:
        server.server_close()
        events.close()
    return 0


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def nonnegative_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    serve = commands.add_parser("serve", help="run the independent HTTP peer")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=nonnegative_integer, default=8088)
    serve.add_argument(
        "--max-request-body-bytes", type=positive_integer, default=DEFAULT_BODY_LIMIT
    )
    serve.add_argument(
        "--max-header-bytes", type=positive_integer, default=DEFAULT_HEADER_LIMIT
    )
    serve.add_argument("--socket-timeout-ms", type=positive_integer, default=5000)
    serve.add_argument("--delay-ceiling-ms", type=positive_integer, default=120000)
    serve.add_argument("--events", help="append redacted NDJSON events to this path")
    serve.add_argument("--quiet-events", action="store_true")
    serve.add_argument("--tls-cert", help="PEM server certificate chain")
    serve.add_argument("--tls-key", help="PEM private key for --tls-cert")
    serve.add_argument(
        "--tls-min-version",
        choices=("1.2", "1.3"),
        default="1.2",
        help="minimum accepted TLS version (default: 1.2)",
    )
    serve.add_argument(
        "--tls-max-version",
        choices=("1.2", "1.3"),
        help="optional maximum accepted TLS version for version-specific tests",
    )
    serve.add_argument(
        "--observe-tls-close-notify",
        action="store_true",
        help="distinguish a client TLS close_notify from an abrupt EOF",
    )
    serve.add_argument(
        "--tls-handshake-delay-ms",
        type=nonnegative_integer,
        default=0,
        help="bounded delay before the server processes ClientHello",
    )
    serve.set_defaults(entrypoint=run_server)

    probe = commands.add_parser(
        "probe", help="run Mac-to-device /health and binary /echo smoke"
    )
    probe.add_argument("--base-url", required=True)
    probe.add_argument("--rounds", type=positive_integer, default=1)
    probe.add_argument("--interval-ms", type=nonnegative_integer, default=0)
    probe.add_argument("--timeout-ms", type=positive_integer, default=5000)
    probe.add_argument("--response-limit-bytes", type=positive_integer, default=65536)
    probe.add_argument("--health-contains", default="")
    probe.add_argument(
        "--ca-cert",
        help="PEM CA bundle for HTTPS verification; system trust is used when omitted",
    )
    probe.set_defaults(entrypoint=run_probe)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.entrypoint(args)
    except (OSError, RuntimeError, ValueError) as error:
        print(
            json.dumps(
                {"event": "peer_error", "error": type(error).__name__, "message": str(error)},
                sort_keys=True,
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
