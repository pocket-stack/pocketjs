#!/usr/bin/env python3

from __future__ import annotations

import argparse
import contextlib
import http.client
import importlib.util
import io
import json
import os
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("http_peer.py")
SPEC = importlib.util.spec_from_file_location("pocketjs_http_peer", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
http_peer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = http_peer
SPEC.loader.exec_module(http_peer)

PKI_MODULE_PATH = Path(__file__).with_name("generate_test_pki.py")
PKI_SPEC = importlib.util.spec_from_file_location(
    "pocketjs_generate_test_pki", PKI_MODULE_PATH
)
assert PKI_SPEC is not None and PKI_SPEC.loader is not None
generate_test_pki = importlib.util.module_from_spec(PKI_SPEC)
sys.modules[PKI_SPEC.name] = generate_test_pki
PKI_SPEC.loader.exec_module(generate_test_pki)


class QuietSink:
    def emit(self, event: str, **fields: object) -> None:
        del event, fields


class RecordingSink:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self.records: list[tuple[str, dict[str, object]]] = []

    def emit(self, event: str, **fields: object) -> None:
        with self._condition:
            self.records.append((event, fields))
            self._condition.notify_all()

    def wait_for(self, event: str, timeout: float = 2) -> bool:
        with self._condition:
            return self._condition.wait_for(
                lambda: any(name == event for name, _ in self.records), timeout
            )

    def snapshot(self) -> list[tuple[str, dict[str, object]]]:
        with self._condition:
            return list(self.records)


def make_server(
    tls_context: ssl.SSLContext | None = None,
    events: QuietSink | RecordingSink | None = None,
    *,
    observe_tls_close_notify: bool = False,
    tls_handshake_delay_ms: int = 0,
) -> http_peer.ThreadingPeerServer:
    return http_peer.ThreadingPeerServer(
        ("127.0.0.1", 0),
        body_limit=16 * 1024,
        header_limit=16 * 1024,
        socket_timeout_ms=1000,
        delay_ceiling_ms=2000,
        events=events if events is not None else QuietSink(),
        tls_context=tls_context,
        observe_tls_close_notify=observe_tls_close_notify,
        tls_handshake_delay_ms=tls_handshake_delay_ms,
    )


class PeerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = make_server()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host, cls.port = cls.server.server_address

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_health_echo_and_keep_alive(self) -> None:
        connection = http.client.HTTPConnection(self.host, self.port, timeout=2)
        connection.request("GET", "/health")
        health = connection.getresponse()
        connection_id = health.getheader("X-PocketJS-Connection")
        self.assertEqual(health.status, 200)
        self.assertIn(b'"status":"ok"', health.read())

        payload = b"binary:\x00\xff"
        connection.request("POST", "/echo", body=payload)
        echo = connection.getresponse()
        self.assertEqual(echo.status, 200)
        self.assertEqual(echo.getheader("X-PocketJS-Connection"), connection_id)
        self.assertEqual(echo.read(), payload)
        connection.close()

    def test_chunked_echo_and_keep_alive(self) -> None:
        connection = http.client.HTTPConnection(self.host, self.port, timeout=2)
        payload_chunks = (b"binary:", b"\x00", b"\xff", b"-chunked")
        connection.request(
            "POST",
            "/echo",
            body=iter(payload_chunks),
            encode_chunked=True,
        )
        echo = connection.getresponse()
        connection_id = echo.getheader("X-PocketJS-Connection")
        self.assertEqual(echo.status, 200)
        self.assertEqual(echo.read(), b"binary:\x00\xff-chunked")

        connection.request("GET", "/health", headers={"Connection": "close"})
        health = connection.getresponse()
        self.assertEqual(health.status, 200)
        self.assertEqual(health.getheader("X-PocketJS-Connection"), connection_id)
        self.assertIn(b'"status":"ok"', health.read())
        connection.close()

    def test_invalid_chunked_uploads_are_rejected(self) -> None:
        cases = {
            "transfer-encoding-and-content-length": (
                b"Transfer-Encoding: chunked\r\nContent-Length: 1\r\n",
                b"0\r\n\r\n",
                400,
            ),
            "duplicate-transfer-encoding": (
                b"Transfer-Encoding: chunked\r\n"
                b"Transfer-Encoding: chunked\r\n",
                b"0\r\n\r\n",
                400,
            ),
            "combined-transfer-coding": (
                b"Transfer-Encoding: gzip, chunked\r\n",
                b"0\r\n\r\n",
                400,
            ),
            "http-1.0": (
                b"Transfer-Encoding: chunked\r\n",
                b"0\r\n\r\n",
                400,
            ),
            "chunk-extension": (
                b"Transfer-Encoding: chunked\r\n",
                b"1;extension=yes\r\na\r\n0\r\n\r\n",
                400,
            ),
            "invalid-chunk-size": (
                b"Transfer-Encoding: chunked\r\n",
                b"Z\r\ninvalid\r\n",
                400,
            ),
            "declared-trailer": (
                b"Transfer-Encoding: chunked\r\nTrailer: X-Test\r\n",
                b"0\r\n\r\n",
                400,
            ),
            "actual-trailer": (
                b"Transfer-Encoding: chunked\r\n",
                b"1\r\na\r\n0\r\nX-Test: value\r\n\r\n",
                400,
            ),
            "body-limit": (
                b"Transfer-Encoding: chunked\r\n",
                b"4001\r\n",
                413,
            ),
            "size-line-limit": (
                b"Transfer-Encoding: chunked\r\n",
                b"00000000000000000\r\n",
                400,
            ),
        }
        for name, (headers, body, expected_status) in cases.items():
            version = "HTTP/1.0" if name == "http-1.0" else "HTTP/1.1"
            with self.subTest(case=name):
                wire = self.raw_request(
                    f"POST /echo {version}\r\n".encode()
                    + b"Host: peer\r\nConnection: close\r\n"
                    + headers
                    + b"\r\n"
                    + body
                )
                status_line = wire.split(b"\r\n", 1)[0]
                self.assertEqual(
                    int(status_line.split(b" ", 2)[1]),
                    expected_status,
                )

    def test_valid_chunked_response_has_trailer(self) -> None:
        wire = self.raw_request(b"GET /chunked HTTP/1.1\r\nHost: peer\r\nConnection: close\r\n\r\n")
        self.assertIn(b"Transfer-Encoding: chunked\r\n", wire)
        self.assertIn(b"8\r\nPocketJS\r\n", wire)
        self.assertTrue(wire.endswith(b"0\r\nX-PocketJS-Trailer: complete\r\n\r\n"))

    def test_malformed_te_cl_is_sent_verbatim(self) -> None:
        cases = {
            "te-cl": (b"Transfer-Encoding: chunked\r\n", b"Content-Length: 5\r\n"),
            "duplicate-content-length": (
                b"Content-Length: 5\r\nContent-Length: 5\r\n",
            ),
            "obs-fold": (b"X-PocketJS: first\r\n second\r\n",),
            "te-duplicate": (
                b"Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n",
            ),
            "te-combined": (b"Transfer-Encoding: gzip, chunked\r\n",),
            "te-unknown": (b"Transfer-Encoding: gzip\r\n",),
            "trailer-forbidden": (b"0\r\nContent-Length: 2\r\n\r\n",),
            "chunk-size": (b"Z\r\ninvalid\r\n",),
        }
        for case, expected_fragments in cases.items():
            with self.subTest(case=case):
                wire = self.raw_request(
                    (
                        f"GET /malformed/{case} HTTP/1.1\r\n"
                        "Host: peer\r\nConnection: close\r\n\r\n"
                    ).encode()
                )
                for fragment in expected_fragments:
                    self.assertIn(fragment, wire)

    def test_disconnect_mid_body_is_incomplete(self) -> None:
        wire = self.raw_request(
            b"GET /disconnect?phase=mid_body HTTP/1.1\r\nHost: peer\r\n\r\n"
        )
        headers, body = wire.split(b"\r\n\r\n", 1)
        self.assertIn(b"Content-Length: 32", headers)
        self.assertEqual(body, b"partial")

    def test_retry_once_counts_without_logging_token(self) -> None:
        first = self.raw_request(
            b"GET /retry-once?token=test-token HTTP/1.1\r\nHost: peer\r\n\r\n"
        )
        self.assertEqual(first, b"")
        second = self.raw_request(
            b"GET /retry-once?token=test-token HTTP/1.1\r\nHost: peer\r\n\r\n"
        )
        self.assertIn(b"X-PocketJS-Attempt: 2\r\n", second)

    def raw_request(self, request: bytes) -> bytes:
        with socket.create_connection((self.host, self.port), timeout=2) as connection:
            connection.sendall(request)
            chunks: list[bytes] = []
            while True:
                chunk = connection.recv(4096)
                if not chunk:
                    return b"".join(chunks)
                chunks.append(chunk)


class TLSPeerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.temporary = tempfile.TemporaryDirectory(prefix="pocketjs-peer-pki-")
        cls.pki = generate_test_pki.generate_pki(Path(cls.temporary.name))

    @classmethod
    def tearDownClass(cls) -> None:
        cls.temporary.cleanup()

    def start_profile(
        self,
        cert_name: str,
        key_name: str,
        *,
        maximum_version: ssl.TLSVersion | None = None,
        events: RecordingSink | None = None,
        observe_tls_close_notify: bool = False,
        tls_handshake_delay_ms: int = 0,
    ) -> tuple[http_peer.ThreadingPeerServer, str, int]:
        tls_context = http_peer.create_server_tls_context(
            self.pki[cert_name], self.pki[key_name], "1.2"
        )
        if maximum_version is not None:
            tls_context.maximum_version = maximum_version
        server = make_server(
            tls_context,
            events,
            observe_tls_close_notify=observe_tls_close_notify,
            tls_handshake_delay_ms=tls_handshake_delay_ms,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop() -> None:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

        self.addCleanup(stop)
        host, port = server.server_address
        return server, host, port

    def trusted_context(self) -> ssl.SSLContext:
        return ssl.create_default_context(cafile=self.pki["ca_cert"])

    def ensure_cli_stopped(self, process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        process.send_signal(signal.SIGINT)
        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=3)

    def start_cli_profile(
        self,
        cert_name: str,
        key_name: str,
        *,
        maximum_version: str | None = None,
    ) -> tuple[subprocess.Popen[str], dict[str, object]]:
        command = [
            sys.executable,
            str(MODULE_PATH),
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--tls-cert",
            str(self.pki[cert_name]),
            "--tls-key",
            str(self.pki[key_name]),
        ]
        if maximum_version is not None:
            command.extend(("--tls-max-version", maximum_version))
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(self.ensure_cli_stopped, process)
        assert process.stdout is not None and process.stderr is not None
        ready_line = process.stdout.readline()
        if not ready_line:
            _, error_output = process.communicate(timeout=3)
            self.fail(f"TLS peer CLI did not become ready: {error_output}")
        ready = json.loads(ready_line)
        self.assertEqual(ready["event"], "peer_ready")
        self.assertEqual(ready["socket_timeout_ms"], 5000)
        self.assertEqual(
            ready["tls_certificate_der_sha256"],
            http_peer.certificate_der_sha256(self.pki[cert_name]),
        )
        return process, ready

    def stop_cli_profile(
        self, process: subprocess.Popen[str]
    ) -> list[dict[str, object]]:
        process.send_signal(signal.SIGINT)
        output, error_output = process.communicate(timeout=3)
        self.assertEqual(process.returncode, 0, error_output)
        return [json.loads(line) for line in output.splitlines()]

    def run_cli_probe(self, port: int) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            (
                sys.executable,
                str(MODULE_PATH),
                "probe",
                "--base-url",
                f"https://localhost:{port}",
                "--ca-cert",
                str(self.pki["ca_cert"]),
                "--rounds",
                "2",
                "--health-contains",
                '"status":"ok"',
            ),
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def assert_cli_profile_rejected(self, cert_name: str, key_name: str) -> None:
        process, ready = self.start_cli_profile(cert_name, key_name)
        result = self.run_cli_probe(int(ready["port"]))
        events = self.stop_cli_profile(process)
        self.assertEqual(result.returncode, 1)
        error_event = json.loads(result.stderr)
        self.assertEqual(error_event["event"], "peer_error")
        self.assertEqual(error_event["error"], "SSLCertVerificationError")
        self.assertFalse(any(event["event"] == "request" for event in events))
        hellos = [
            event for event in events if event["event"] == "tls_client_hello"
        ]
        self.assertEqual(hellos[0]["server_name"], "localhost")
        self.assertTrue(
            any(event["event"] == "tls_handshake_error" for event in events)
        )

    def assert_profile_rejected(
        self, cert_name: str, key_name: str
    ) -> ssl.SSLCertVerificationError:
        events = RecordingSink()
        _, _, port = self.start_profile(
            cert_name,
            key_name,
            events=events,
        )
        connection = http.client.HTTPSConnection(
            "localhost", port, timeout=2, context=self.trusted_context()
        )
        self.addCleanup(connection.close)
        with self.assertRaises(ssl.SSLCertVerificationError) as raised:
            connection.request("GET", "/health")
        self.assertTrue(events.wait_for("tls_handshake_error"))
        records = events.snapshot()
        self.assertFalse(any(event == "request" for event, _ in records))
        hellos = [
            fields for event, fields in records if event == "tls_client_hello"
        ]
        self.assertEqual(hellos[0]["server_name"], "localhost")
        return raised.exception

    def test_tls_probe_health_echo_and_keep_alive(self) -> None:
        events = RecordingSink()
        _, _, port = self.start_profile(
            "server_cert",
            "server_key",
            maximum_version=ssl.TLSVersion.TLSv1_2,
            events=events,
        )
        args = argparse.Namespace(
            base_url=f"https://localhost:{port}",
            ca_cert=str(self.pki["ca_cert"]),
            timeout_ms=2000,
            response_limit_bytes=16 * 1024,
            health_contains='"status":"ok"',
            rounds=2,
            interval_ms=0,
        )
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            self.assertEqual(http_peer.run_probe(args), 0)
        output_lines = [json_line for json_line in output.getvalue().splitlines()]
        self.assertEqual(len(output_lines), 3)
        self.assertIn('"event":"probe_pass"', output_lines[-1])
        connection_events = [
            fields for event, fields in events.records if event == "connection_open"
        ]
        self.assertEqual(connection_events[0]["tls_version"], "TLSv1.2")
        self.assertEqual(connection_events[0]["tls_server_name"], "localhost")
        hello_events = [
            fields for event, fields in events.records if event == "tls_client_hello"
        ]
        self.assertEqual(hello_events[0]["server_name"], "localhost")

    def tls_health_connection(self, port: int) -> ssl.SSLSocket:
        raw = socket.create_connection(("127.0.0.1", port), timeout=2)
        secure = self.trusted_context().wrap_socket(raw, server_hostname="localhost")
        secure.sendall(
            b"GET /health HTTP/1.1\r\n"
            b"Host: localhost\r\n"
            b"Connection: keep-alive\r\n\r\n"
        )
        response = http.client.HTTPResponse(secure)
        response.begin()
        self.assertEqual(response.status, 200)
        self.assertIn(b'"status":"ok"', response.read())
        return secure

    def test_observes_client_close_notify(self) -> None:
        events = RecordingSink()
        _, _, port = self.start_profile(
            "server_cert",
            "server_key",
            maximum_version=ssl.TLSVersion.TLSv1_2,
            events=events,
            observe_tls_close_notify=True,
        )
        secure = self.tls_health_connection(port)
        try:
            try:
                raw = secure.unwrap()
            except OSError:
                secure.close()
            else:
                raw.close()
        finally:
            secure.close()
        self.assertTrue(events.wait_for("connection_close"))
        closes = [
            fields for event, fields in events.snapshot() if event == "connection_close"
        ]
        self.assertEqual(closes[0]["tls_close_state"], "close_notify")
        self.assertIs(closes[0]["tls_close_notify_observed"], True)

    def test_observes_ragged_tls_eof(self) -> None:
        events = RecordingSink()
        _, _, port = self.start_profile(
            "server_cert",
            "server_key",
            maximum_version=ssl.TLSVersion.TLSv1_2,
            events=events,
            observe_tls_close_notify=True,
        )
        secure = self.tls_health_connection(port)
        descriptor = secure.detach()
        os.close(descriptor)
        self.assertTrue(events.wait_for("connection_close"))
        closes = [
            fields for event, fields in events.snapshot() if event == "connection_close"
        ]
        self.assertEqual(closes[0]["tls_close_state"], "ragged_eof")
        self.assertIs(closes[0]["tls_close_notify_observed"], False)

    def test_delays_tls_handshake_without_serving_http(self) -> None:
        events = RecordingSink()
        _, _, port = self.start_profile(
            "server_cert",
            "server_key",
            maximum_version=ssl.TLSVersion.TLSv1_2,
            events=events,
            tls_handshake_delay_ms=250,
        )
        raw = socket.create_connection(("127.0.0.1", port), timeout=1)
        raw.settimeout(0.05)
        with self.assertRaises((TimeoutError, socket.timeout)):
            self.trusted_context().wrap_socket(raw, server_hostname="localhost")
        raw.close()
        self.assertTrue(events.wait_for("tls_handshake_delay"))
        self.assertTrue(events.wait_for("tls_handshake_error"))
        records = events.snapshot()
        self.assertFalse(any(event == "connection_open" for event, _ in records))
        self.assertFalse(any(event == "request" for event, _ in records))

    def test_wrong_hostname_is_rejected(self) -> None:
        error = self.assert_profile_rejected("wrong_host_cert", "wrong_host_key")
        self.assertIn("Hostname mismatch", str(error))

    def test_untrusted_ca_is_rejected(self) -> None:
        error = self.assert_profile_rejected(
            "untrusted_server_cert", "untrusted_server_key"
        )
        self.assertIn("certificate verify failed", str(error))

    def test_bad_signature_is_rejected(self) -> None:
        error = self.assert_profile_rejected(
            "bad_signature_server_cert", "server_key"
        )
        self.assertIn("certificate verify failed", str(error))

    def test_expired_certificate_is_rejected(self) -> None:
        error = self.assert_profile_rejected(
            "expired_server_cert", "expired_server_key"
        )
        self.assertEqual(error.verify_code, 10)

    def test_not_yet_valid_certificate_is_rejected(self) -> None:
        error = self.assert_profile_rejected(
            "not_yet_valid_server_cert", "not_yet_valid_server_key"
        )
        self.assertEqual(error.verify_code, 9)

    def test_cli_tls12_serve_and_probe(self) -> None:
        process, ready = self.start_cli_profile(
            "server_cert", "server_key", maximum_version="1.2"
        )
        result = self.run_cli_probe(int(ready["port"]))
        events = self.stop_cli_profile(process)
        self.assertEqual(result.returncode, 0, result.stderr)
        probe_events = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(probe_events[-1]["event"], "probe_pass")
        self.assertEqual(probe_events[-1]["rounds"], 2)
        connections = [
            event for event in events if event["event"] == "connection_open"
        ]
        self.assertEqual(connections[0]["tls_version"], "TLSv1.2")
        self.assertEqual(connections[0]["tls_server_name"], "localhost")
        self.assertEqual(
            len([event for event in events if event["event"] == "request"]), 4
        )

    def test_cli_rejects_wrong_hostname_before_http(self) -> None:
        self.assert_cli_profile_rejected("wrong_host_cert", "wrong_host_key")

    def test_cli_rejects_unknown_ca_before_http(self) -> None:
        self.assert_cli_profile_rejected(
            "untrusted_server_cert", "untrusted_server_key"
        )

    def test_cli_rejects_bad_signature_before_http(self) -> None:
        self.assert_cli_profile_rejected("bad_signature_server_cert", "server_key")

    def test_cli_rejects_expired_certificate_before_http(self) -> None:
        self.assert_cli_profile_rejected(
            "expired_server_cert", "expired_server_key"
        )

    def test_cli_rejects_not_yet_valid_certificate_before_http(self) -> None:
        self.assert_cli_profile_rejected(
            "not_yet_valid_server_cert", "not_yet_valid_server_key"
        )


if __name__ == "__main__":
    unittest.main()
