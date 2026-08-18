#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import ipaddress
import json
import os
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("dns_peer.py")
SPEC = importlib.util.spec_from_file_location("pocketjs_dns_peer", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
dns_peer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dns_peer
SPEC.loader.exec_module(dns_peer)


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

    def wait_for_count(self, event: str, count: int, timeout: float = 2) -> bool:
        with self._condition:
            return self._condition.wait_for(
                lambda: sum(name == event for name, _ in self.records) >= count,
                timeout,
            )


class FailingSink:
    def __init__(self) -> None:
        self.ready = threading.Event()

    def emit(self, event: str, **fields: object) -> None:
        del fields
        if event == "dns_ready":
            self.ready.set()
            return
        raise OSError("injected event sink failure")

def encode_name(name: str) -> bytes:
    labels = name.rstrip(".").split(".") if name.rstrip(".") else []
    return b"".join(bytes((len(label),)) + label.encode() for label in labels) + b"\0"


def make_opt(
    *,
    version: int = 0,
    payload_bytes: int = 4096,
    flags: int = 0,
    options: bytes = b"",
    declared_length: int | None = None,
) -> bytes:
    ttl = (version << 16) | flags
    data_length = len(options) if declared_length is None else declared_length
    return b"\0" + struct.pack(
        "!HHIH", dns_peer.TYPE_OPT, payload_bytes, ttl, data_length
    ) + options


def make_query(
    name: str = "pocketjs.test",
    *,
    transaction_id: int = 0x1234,
    flags: int = dns_peer.FLAG_RD,
    query_type: int = dns_peer.TYPE_A,
    query_class: int = dns_peer.CLASS_IN,
    additional: tuple[bytes, ...] = (),
    question_count: int = 1,
) -> bytes:
    return (
        struct.pack(
            "!HHHHHH",
            transaction_id,
            flags,
            question_count,
            0,
            0,
            len(additional),
        )
        + encode_name(name)
        + struct.pack("!HH", query_type, query_class)
        + b"".join(additional)
    )


def response_header(response: bytes) -> tuple[int, int, int, int, int, int]:
    return struct.unpack_from("!HHHHHH", response)


def question_end(response: bytes) -> int:
    offset = dns_peer.DNS_HEADER_BYTES
    while response[offset]:
        offset += 1 + response[offset]
    return offset + 1 + 4


def answer_ipv4(response: bytes) -> tuple[int, int, str]:
    offset = question_end(response)
    pointer, record_type, record_class, ttl, data_length = struct.unpack_from(
        "!HHHIH", response, offset
    )
    self_address = socket.inet_ntoa(response[offset + 12 : offset + 16])
    if pointer != 0xC00C or record_type != 1 or record_class != 1 or data_length != 4:
        raise AssertionError("unexpected A response encoding")
    return ttl, offset + 16, self_address


def receive_exact(connection: socket.socket, byte_count: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < byte_count:
        chunk = connection.recv(byte_count - len(chunks))
        if not chunk:
            raise ConnectionError("connection closed")
        chunks.extend(chunk)
    return bytes(chunks)


class DnsPeerTest(unittest.TestCase):
    def ensure_process_stopped(self, process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        process.send_signal(signal.SIGINT)
        try:
            process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=3)

    def start_server(
        self, allowed_cidrs: tuple[str, ...] = ("127.0.0.0/8",)
    ) -> tuple[dns_peer.DnsPeerServer, RecordingSink, int]:
        events = RecordingSink()
        server = dns_peer.DnsPeerServer(
            ("127.0.0.1", 0),
            authoritative_name="pocketjs.test",
            authoritative_address=ipaddress.IPv4Address("172.16.10.126"),
            ttl_seconds=30,
            allowed_networks=tuple(
                ipaddress.IPv4Network(cidr) for cidr in allowed_cidrs
            ),
            interface=None,
            socket_timeout_ms=200,
            events=events,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.assertTrue(events.wait_for("dns_ready"))

        def stop() -> None:
            server.shutdown()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

        self.addCleanup(stop)
        return server, events, server.server_address[1]

    def udp_query(self, port: int, query: bytes, timeout: float = 0.5) -> bytes:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client:
            client.settimeout(timeout)
            client.sendto(query, ("127.0.0.1", port))
            return client.recvfrom(dns_peer.MAX_DNS_MESSAGE_BYTES + 1)[0]

    def tcp_query(self, port: int, query: bytes) -> bytes:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
            client.sendall(struct.pack("!H", len(query)) + query)
            response_length = struct.unpack("!H", receive_exact(client, 2))[0]
            return receive_exact(client, response_length)

    def assert_exact_answer(self, response: bytes, transaction_id: int = 0x1234) -> None:
        response_id, flags, questions, answers, authorities, additionals = response_header(
            response
        )
        self.assertEqual(response_id, transaction_id)
        self.assertTrue(flags & dns_peer.FLAG_QR)
        self.assertTrue(flags & dns_peer.FLAG_AA)
        self.assertTrue(flags & dns_peer.FLAG_RD)
        self.assertFalse(flags & dns_peer.FLAG_RA)
        self.assertEqual(flags & 0xF, dns_peer.RCODE_NOERROR)
        self.assertEqual((questions, answers, authorities, additionals), (1, 1, 0, 0))
        ttl, end, address = answer_ipv4(response)
        self.assertEqual(ttl, 30)
        self.assertEqual(address, "172.16.10.126")
        self.assertEqual(end, len(response))

    def test_udp_and_tcp_exact_a_are_authoritative(self) -> None:
        _, events, port = self.start_server()
        query = make_query(name="PocketJS.TEST")
        self.assert_exact_answer(self.udp_query(port, query))
        self.assert_exact_answer(self.tcp_query(port, query))
        answers = [
            fields
            for event, fields in events.records
            if event == "dns_query" and fields["outcome"] == "answer"
        ]
        self.assertEqual({answer["transport"] for answer in answers}, {"udp", "tcp"})
        self.assertTrue(all(answer["recursion_available"] is False for answer in answers))

    def test_recursion_desired_never_enables_recursion(self) -> None:
        _, _, port = self.start_server()
        exact = self.udp_query(port, make_query(flags=dns_peer.FLAG_RD))
        self.assertEqual(response_header(exact)[1] & 0xF, dns_peer.RCODE_NOERROR)
        self.assertFalse(response_header(exact)[1] & dns_peer.FLAG_RA)

        outside = self.udp_query(port, make_query("example.com", flags=dns_peer.FLAG_RD))
        _, flags, questions, answers, _, _ = response_header(outside)
        self.assertEqual(flags & 0xF, dns_peer.RCODE_REFUSED)
        self.assertTrue(flags & dns_peer.FLAG_RD)
        self.assertFalse(flags & dns_peer.FLAG_RA)
        self.assertEqual((questions, answers), (1, 0))

    def test_descendant_is_nxdomain_and_other_type_is_refused(self) -> None:
        _, _, port = self.start_server()
        missing = self.udp_query(port, make_query("missing.pocketjs.test"))
        missing_flags = response_header(missing)[1]
        self.assertEqual(missing_flags & 0xF, dns_peer.RCODE_NXDOMAIN)
        self.assertTrue(missing_flags & dns_peer.FLAG_AA)

        aaaa = self.udp_query(port, make_query(query_type=28))
        aaaa_flags = response_header(aaaa)[1]
        self.assertEqual(aaaa_flags & 0xF, dns_peer.RCODE_REFUSED)
        self.assertFalse(aaaa_flags & dns_peer.FLAG_AA)

    def test_disallowed_source_is_silently_dropped(self) -> None:
        _, events, port = self.start_server(("10.0.0.0/8",))
        with self.assertRaises(socket.timeout):
            self.udp_query(port, make_query(), timeout=0.2)
        drops = [fields for event, fields in events.records if event == "dns_drop"]
        self.assertEqual(drops[0]["reason"], "source_not_allowed")

        with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
            client.sendall(struct.pack("!H", len(make_query())) + make_query())
            try:
                closed = client.recv(1)
            except ConnectionResetError:
                closed = b""
            self.assertEqual(closed, b"")

    def test_short_oversized_and_response_messages_are_dropped(self) -> None:
        _, events, port = self.start_server()
        messages = (
            b"\x12\x34",
            b"x" * (dns_peer.MAX_DNS_MESSAGE_BYTES + 1),
            make_query(flags=dns_peer.FLAG_QR),
        )
        for message in messages:
            with self.subTest(message_bytes=len(message)):
                with self.assertRaises(socket.timeout):
                    self.udp_query(port, message, timeout=0.2)
        outcomes = [
            fields.get("reason")
            for event, fields in events.records
            if event in {"dns_drop", "dns_query"}
        ]
        self.assertIn("message_too_short", outcomes)
        self.assertIn("message_too_large", outcomes)
        self.assertIn("response_message_not_accepted", outcomes)

    def test_malformed_question_returns_format_error(self) -> None:
        _, _, port = self.start_server()
        malformed = (
            make_query(question_count=2),
            struct.pack("!HHHHHH", 0x1234, 0, 1, 0, 0, 0)
            + b"\xc0\x0c"
            + struct.pack("!HH", 1, 1),
            make_query() + b"trailing",
        )
        for query in malformed:
            with self.subTest(query=query):
                response = self.udp_query(port, query)
                _, flags, questions, answers, authorities, additionals = response_header(
                    response
                )
                self.assertEqual(flags & 0xF, dns_peer.RCODE_FORMERR)
                self.assertEqual(
                    (questions, answers, authorities, additionals), (0, 0, 0, 0)
                )

    def test_edns0_is_bounded_and_unknown_options_are_not_echoed(self) -> None:
        _, _, port = self.start_server()
        option = struct.pack("!HH3s", 65001, 3, b"abc")
        response = self.udp_query(
            port,
            make_query(
                additional=(
                    make_opt(
                        payload_bytes=65535,
                        flags=dns_peer.EDNS_DO,
                        options=option,
                    ),
                )
            ),
        )
        _, flags, _, answers, _, additionals = response_header(response)
        self.assertEqual(flags & 0xF, dns_peer.RCODE_NOERROR)
        self.assertEqual((answers, additionals), (1, 1))
        _, offset, _ = answer_ipv4(response)
        owner, record_type, payload, ttl, data_length = struct.unpack_from(
            "!BHHIH", response, offset
        )
        self.assertEqual(owner, 0)
        self.assertEqual(record_type, dns_peer.TYPE_OPT)
        self.assertEqual(payload, dns_peer.MAX_DNS_MESSAGE_BYTES)
        self.assertEqual(ttl, 0)
        self.assertEqual(data_length, 0)
        self.assertEqual(offset + 11, len(response))

    def test_edns_bad_version_returns_badvers(self) -> None:
        _, _, port = self.start_server()
        response = self.udp_query(
            port, make_query(additional=(make_opt(version=1),))
        )
        _, flags, _, answers, _, additionals = response_header(response)
        self.assertEqual(flags & 0xF, 0)
        self.assertEqual((answers, additionals), (0, 1))
        offset = question_end(response)
        _, record_type, _, ttl, _ = struct.unpack_from("!BHHIH", response, offset)
        self.assertEqual(record_type, dns_peer.TYPE_OPT)
        self.assertEqual(ttl >> 24, 1)

    def test_malformed_edns_returns_format_error(self) -> None:
        _, _, port = self.start_server()
        malformed = (
            make_query(additional=(make_opt(options=b"xx", declared_length=4),)),
            make_query(additional=(make_opt(), make_opt())),
            make_query(additional=(b"\x03bad" + make_opt()[1:],)),
        )
        for query in malformed:
            with self.subTest(query=query):
                response = self.udp_query(port, query)
                self.assertEqual(
                    response_header(response)[1] & 0xF, dns_peer.RCODE_FORMERR
                )

    def test_tcp_oversized_frame_is_closed_without_allocation(self) -> None:
        _, events, port = self.start_server()
        with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
            client.sendall(struct.pack("!H", dns_peer.MAX_DNS_MESSAGE_BYTES + 1))
            self.assertEqual(client.recv(1), b"")
        drops = [fields for event, fields in events.records if event == "dns_drop"]
        self.assertTrue(
            any(drop["reason"] == "invalid_message_length" for drop in drops)
        )

    def test_tcp_partial_frames_and_timeout_are_rejected(self) -> None:
        _, events, port = self.start_server()

        def send_incomplete(payload: bytes, *, close_write: bool) -> None:
            with socket.create_connection(("127.0.0.1", port), timeout=1) as client:
                client.sendall(payload)
                if close_write:
                    client.shutdown(socket.SHUT_WR)
                try:
                    closed = client.recv(1)
                except ConnectionResetError:
                    closed = b""
                self.assertEqual(closed, b"")

        query = make_query()
        send_incomplete(b"\x00", close_write=True)
        send_incomplete(
            struct.pack("!H", len(query)) + query[:5],
            close_write=True,
        )
        send_incomplete(struct.pack("!H", len(query)), close_write=False)
        self.assertTrue(events.wait_for_count("dns_drop", 3))
        incomplete = [
            fields
            for event, fields in events.records
            if event == "dns_drop" and fields["reason"] == "incomplete_message"
        ]
        self.assertEqual(len(incomplete), 3)

    def test_shutdown_closes_active_tcp_before_long_timeout(self) -> None:
        events = RecordingSink()
        server = dns_peer.DnsPeerServer(
            ("127.0.0.1", 0),
            authoritative_name="pocketjs.test",
            authoritative_address=ipaddress.IPv4Address("172.16.10.126"),
            ttl_seconds=30,
            allowed_networks=(ipaddress.IPv4Network("127.0.0.0/8"),),
            interface=None,
            socket_timeout_ms=dns_peer.MAX_SOCKET_TIMEOUT_MS,
            events=events,
        )
        failures: list[BaseException] = []

        def serve() -> None:
            try:
                server.serve_forever()
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        self.assertTrue(events.wait_for("dns_ready"))
        try:
            with socket.create_connection(server.server_address, timeout=1) as client:
                client.sendall(b"\x00")
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    with server._active_tcp_lock:
                        if server._active_tcp is not None:
                            break
                    time.sleep(0.01)
                else:
                    self.fail("TCP worker did not enter its bounded read")
                started = time.monotonic()
                server.shutdown()
                thread.join(timeout=1)
                self.assertFalse(thread.is_alive())
                self.assertLess(time.monotonic() - started, 1)
                try:
                    closed = client.recv(1)
                except (ConnectionResetError, OSError):
                    closed = b""
                self.assertEqual(closed, b"")
        finally:
            server.shutdown()
            thread.join(timeout=1)
        self.assertEqual(failures, [])

    def test_worker_event_failure_stops_server(self) -> None:
        events = FailingSink()
        server = dns_peer.DnsPeerServer(
            ("127.0.0.1", 0),
            authoritative_name="pocketjs.test",
            authoritative_address=ipaddress.IPv4Address("172.16.10.126"),
            ttl_seconds=30,
            allowed_networks=(ipaddress.IPv4Network("127.0.0.0/8"),),
            interface=None,
            socket_timeout_ms=200,
            events=events,
        )
        failures: list[BaseException] = []

        def serve() -> None:
            try:
                server.serve_forever()
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        self.assertTrue(events.ready.wait(timeout=1))
        with self.assertRaises(socket.timeout):
            self.udp_query(server.server_address[1], make_query(), timeout=0.2)
        thread.join(timeout=1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(failures), 1)
        self.assertIsInstance(failures[0], RuntimeError)
        self.assertIn("worker failed", str(failures[0]))

    def test_partial_worker_start_is_torn_down(self) -> None:
        real_thread = threading.Thread
        for failure in (
            RuntimeError("injected second worker start failure"),
            KeyboardInterrupt(),
        ):
            with self.subTest(failure=type(failure).__name__):
                events = RecordingSink()
                server = dns_peer.DnsPeerServer(
                    ("127.0.0.1", 0),
                    authoritative_name="pocketjs.test",
                    authoritative_address=ipaddress.IPv4Address("172.16.10.126"),
                    ttl_seconds=30,
                    allowed_networks=(ipaddress.IPv4Network("127.0.0.0/8"),),
                    interface=None,
                    socket_timeout_ms=200,
                    events=events,
                )
                created_threads: list[threading.Thread] = []

                class FailingThread:
                    ident = None

                    def start(self) -> None:
                        raise failure

                def make_thread(*args: object, **kwargs: object) -> object:
                    if created_threads:
                        return FailingThread()
                    worker = real_thread(*args, **kwargs)
                    created_threads.append(worker)
                    return worker

                with mock.patch.object(
                    dns_peer.threading, "Thread", side_effect=make_thread
                ):
                    with self.assertRaises(type(failure)):
                        server.serve_forever()
                self.assertTrue(server._closed)
                self.assertEqual(len(created_threads), 1)
                self.assertFalse(created_threads[0].is_alive())

    def test_cli_configuration_bounds_are_rejected(self) -> None:
        for cidr in ("0.0.0.0/1", "128.0.0.0/1", "8.8.8.0/24"):
            with self.subTest(cidr=cidr), self.assertRaises(Exception) as raised:
                dns_peer.parse_allow_cidr(cidr)
            self.assertIn("outside RFC1918", str(raised.exception))
        with self.assertRaises(Exception) as ttl_error:
            dns_peer.ttl_integer(str(dns_peer.MAX_TTL_SECONDS + 1))
        self.assertIn("must not exceed", str(ttl_error.exception))
        with self.assertRaises(Exception) as timeout_error:
            dns_peer.socket_timeout_integer(str(dns_peer.MAX_SOCKET_TIMEOUT_MS + 1))
        self.assertIn("must not exceed", str(timeout_error.exception))

        with self.assertRaisesRegex(ValueError, "outside RFC1918"):
            dns_peer.DnsPeerServer(
                ("127.0.0.1", 0),
                authoritative_name="pocketjs.test",
                authoritative_address=ipaddress.IPv4Address("172.16.10.126"),
                ttl_seconds=30,
                allowed_networks=(ipaddress.IPv4Network("8.8.8.0/24"),),
                interface=None,
                socket_timeout_ms=200,
                events=RecordingSink(),
            )

    @unittest.skipUnless(sys.platform == "darwin", "Darwin safety policy")
    def test_darwin_wildcard_aliases_require_interface(self) -> None:
        args = dns_peer.build_parser().parse_args(
            (
                "serve",
                "--host",
                "0.0.0.0",
                "--port",
                "0",
                "--allow-cidr",
                "127.0.0.0/8",
            )
        )
        self.assertEqual(args.host, "0.0.0.0")
        with self.assertRaisesRegex(ValueError, "requires --interface"):
            dns_peer.run_server(args)
        for host in ("0", "", "localhost"):
            with self.subTest(host=host), self.assertRaises(Exception):
                dns_peer.parse_bind_host(host)

    @unittest.skipUnless(hasattr(os, "O_NOFOLLOW"), "secure event files")
    def test_event_file_rejects_symlink_nonregular_and_unsafe_mode(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pocketjs-dns-events-") as temporary:
            directory = Path(temporary)
            safe_path = directory / "safe.ndjson"
            sink = dns_peer.EventSink(safe_path, quiet=True)
            sink.emit("test")
            sink.close()
            self.assertEqual(safe_path.stat().st_mode & 0o777, 0o600)

            target = directory / "target.ndjson"
            target.write_text("")
            symlink = directory / "symlink.ndjson"
            symlink.symlink_to(target)
            with self.assertRaises(OSError):
                dns_peer.EventSink(symlink, quiet=True)

            fifo = directory / "events.fifo"
            os.mkfifo(fifo)
            with self.assertRaises(OSError):
                dns_peer.EventSink(fifo, quiet=True)

            unsafe = directory / "unsafe.ndjson"
            unsafe.write_text("")
            unsafe.chmod(0o644)
            with self.assertRaises(PermissionError):
                dns_peer.EventSink(unsafe, quiet=True)

    def test_cli_sigint_is_a_clean_stop(self) -> None:
        process = subprocess.Popen(
            (
                sys.executable,
                str(MODULE_PATH),
                "serve",
                "--host",
                "127.0.0.1",
                "--port",
                "0",
                "--allow-cidr",
                "127.0.0.0/8",
            ),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        self.addCleanup(self.ensure_process_stopped, process)
        assert process.stdout is not None and process.stderr is not None
        ready_line = process.stdout.readline()
        self.assertTrue(ready_line)
        ready = json.loads(ready_line)
        self.assertEqual(ready["event"], "dns_ready")
        self.assert_exact_answer(self.udp_query(int(ready["port"]), make_query()))
        process.send_signal(signal.SIGINT)
        output, error_output = process.communicate(timeout=3)
        self.assertEqual(process.returncode, 0, error_output)
        events = [ready] + [json.loads(line) for line in output.splitlines()]
        self.assertTrue(any(event["event"] == "dns_stop" for event in events))
        self.assertFalse(any(event["event"] == "dns_internal_error" for event in events))


if __name__ == "__main__":
    unittest.main()
