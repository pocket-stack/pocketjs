#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("phase1b_conformance.py")
SPEC = importlib.util.spec_from_file_location("pocketjs_phase1b_conformance", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
phase1b_conformance = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = phase1b_conformance
SPEC.loader.exec_module(phase1b_conformance)


class Phase1BConformanceTest(unittest.TestCase):
    def fixture(
        self, *, board: str = "s3"
    ) -> tuple[Path, Path, Path, tempfile.TemporaryDirectory[str]]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        board_log = root / "board.log"
        tls_path = root / "tls.ndjson"
        dns_path = root / "dns.ndjson"
        board_ip = "172.16.10.231" if board == "s3" else "172.16.10.145"

        if board == "s3":
            lines = (
                "POCKET_NET_TLS_CONTRACT valid=1 https_explicit_opt_in=1 "
                "exact_host_tls_profile=1 distinct_tls_errors=1 "
                "expected_distinct_tls_errors=1 public=0 "
                f"provider={phase1b_conformance.EXPECTED_PROVIDER}",
                "POCKET_NET_FORMAL_TLS_BOOT frame_calls=0 "
                f"origin={phase1b_conformance.EXPECTED_ORIGIN} "
                "peer_ipv4=172.16.10.126 "
                f"plan_hash={phase1b_conformance.EXPECTED_PLAN} "
                f"factory_sha256={phase1b_conformance.EXPECTED_FACTORY} "
                f"ca_der_sha256={phase1b_conformance.EXPECTED_CA} "
                f"tls_provider={phase1b_conformance.EXPECTED_PROVIDER} "
                "public_capability=0",
                f"POCKET_NET_WIFI_GOT_IP ip={board_ip}",
                "POCKET_NET_DNS_READY hostname=pocketjs.test "
                "main=172.16.10.126 backup=172.16.10.126 "
                "fallback=172.16.10.126 readback=exact",
                "POCKET_NET_FORMAL_TLS_START "
                f"origin={phase1b_conformance.EXPECTED_ORIGIN} "
                "peer_ipv4=172.16.10.126 rounds=20 mode=success clock_trusted=1",
                "POCKET_NET_FORMAL_TLS_RUN status=ESP_OK rounds=20/20 "
                "requests=40/40 frame_calls=0 shutdown=1 poison=0x00000000 "
                "core_poison=0x00000000 poisoned_cores=0 core_cause=0 "
                "guest_yields=397 elapsed_ms=63279",
                "POCKET_NET_FORMAL_TLS_RESULT mode=success pass=1 esp_err=ESP_OK "
                "rounds=20/20 requests=40/40 frame_calls=0 shutdown=1 "
                "poison=0x00000000 leases_balanced=1 queued_leases=0 "
                "taken_leases=0 leases_taken=26 leases_released=26 "
                "runtime_requests=40",
            )
        else:
            lines = (
                "boot: chip revision: v1.3",
                "H_SDIO_DRV: Card init success, TRANSPORT_RX_ACTIVE",
                "POCKET_NET_TAB5_C6_POWER before_dir=0x01 before_out=0x01 "
                "before_high_z=0xfe after_dir=0x01 after_out=0x01 "
                "after_high_z=0xfe",
                "POCKET_NET_FORMAL_TLS_BOOT board=tab5-esp32p4 "
                f"origin={phase1b_conformance.EXPECTED_ORIGIN} "
                "peer_ipv4=172.16.10.126 dns_server=172.16.10.126 "
                "rounds=20 requests=40 test_mode=success public_capability=0 "
                "distinct_tls_errors=1 "
                f"plan={phase1b_conformance.EXPECTED_PLAN} "
                f"factory={phase1b_conformance.EXPECTED_FACTORY} "
                f"ca={phase1b_conformance.EXPECTED_CA} "
                f"tls_provider={phase1b_conformance.EXPECTED_PROVIDER}",
                f"POCKET_NET_WIFI_CONNECTED ip={board_ip} dns=172.16.10.126 "
                "hostname=pocketjs.test fixture_ready=1",
                "POCKET_NET_FORMAL_TLS_RUN status=ESP_OK rounds=20/20 "
                "requests=40/40 frame_calls=0 shutdown=1 poison=0x00000000 "
                "core_poison=0x00000000 poisoned_cores=0 core_cause=0 "
                "guest_yields=101 elapsed_ms=24932",
                "POCKET_NET_FORMAL_TLS_RESOURCE run_result=ESP_OK "
                "runtime_slots=1/1 active=0 pending=0 queued=0 taken=0 "
                "requests_started=40 leases_taken=26 leases_released=26 "
                "poison=0x00000000 guest_psram_only=1 shutdown=1 "
                "owner_stack_low_water_bytes=26696",
                "POCKET_NET_FORMAL_TLS_PASS board=tab5-esp32p4 rounds=20 "
                "requests=40 frame_calls=0 "
                f"plan={phase1b_conformance.EXPECTED_PLAN} "
                f"factory={phase1b_conformance.EXPECTED_FACTORY} "
                f"ca={phase1b_conformance.EXPECTED_CA} "
                f"tls_provider={phase1b_conformance.EXPECTED_PROVIDER} "
                "shutdown=1 poison=0x00000000 leases=26/26",
            )
        board_log.write_text("\n".join(lines) + "\n")

        tls: list[dict[str, object]] = [
            {
                "event": "peer_ready",
                "monotonic_ns": 30,
                "transport": "tls",
                "tls_min_version": "1.2",
                "tls_max_version": "1.2",
                "observe_tls_close_notify": True,
                "socket_timeout_ms": 60_000,
            }
        ]
        timestamp = 30
        request_id = 0
        expected_requests = iter(phase1b_conformance.EXPECTED_REQUESTS)
        for connection_id, request_count in enumerate(
            phase1b_conformance.CONNECTION_LENGTHS, 1
        ):
            timestamp += 1
            tls.append(
                {
                    "event": "tls_client_hello",
                    "monotonic_ns": timestamp,
                    "peer_ipv4": board_ip,
                    "server_name": "pocketjs.test",
                }
            )
            timestamp += 1
            tls.append(
                {
                    "event": "connection_open",
                    "monotonic_ns": timestamp,
                    "connection_id": connection_id,
                    "peer_ipv4": board_ip,
                    "tls_server_name": "pocketjs.test",
                    "tls_version": "TLSv1.2",
                    "tls_cipher": "ECDHE-RSA-AES256-GCM-SHA384",
                }
            )
            for index in range(1, request_count + 1):
                expected = next(expected_requests)
                request_id += 1
                timestamp += 1
                tls.append(
                    {
                        "event": "request",
                        "monotonic_ns": timestamp,
                        "request_id": request_id,
                        "connection_id": connection_id,
                        "connection_request_index": index,
                        "method": expected.method,
                        "path": expected.path,
                        "query_names": list(expected.query_names),
                        "body_bytes": expected.body_bytes,
                        "header_names": list(expected.header_names),
                    }
                )
            timestamp += 1
            graceful = connection_id in phase1b_conformance.GRACEFUL_CONNECTIONS
            tls.append(
                {
                    "event": "connection_close",
                    "monotonic_ns": timestamp,
                    "connection_id": connection_id,
                    "requests": request_count,
                    "tls_close_notify_observed": graceful,
                    "tls_close_state": "close_notify" if graceful else "not_observed",
                }
            )
        timestamp += 1
        tls.append(
            {
                "event": "peer_stop",
                "monotonic_ns": timestamp,
                "reason": "keyboard_interrupt",
            }
        )
        self.write_events(tls_path, tls)
        self.write_events(
            dns_path,
            [
                {
                    "event": "dns_ready",
                    "monotonic_ns": 10,
                    "authoritative_name": "pocketjs.test",
                    "authoritative_ipv4": "172.16.10.126",
                    "port": 53,
                    "interface": "en1",
                    "recursion_available": False,
                    "transports": ["udp", "tcp"],
                },
                {
                    "event": "dns_query",
                    "monotonic_ns": 20,
                    "outcome": "answer",
                    "peer_ipv4": board_ip,
                    "query_name": "pocketjs.test",
                    "query_type": 1,
                    "query_class": 1,
                    "answers": 1,
                    "rcode": 0,
                    "recursion_available": False,
                },
                {
                    "event": "dns_stop",
                    "monotonic_ns": timestamp + 1,
                    "reason": "keyboard_interrupt",
                },
            ],
        )
        return board_log, tls_path, dns_path, temporary

    @staticmethod
    def read_events(path: Path) -> list[dict[str, object]]:
        return [json.loads(line) for line in path.read_text().splitlines()]

    @staticmethod
    def write_events(path: Path, events: list[dict[str, object]]) -> None:
        path.write_text("".join(json.dumps(event, sort_keys=True) + "\n" for event in events))

    def analyze(self, board: str = "s3") -> phase1b_conformance.ConformanceSummary:
        board_log, tls_path, dns_path, temporary = self.fixture(board=board)
        self.addCleanup(temporary.cleanup)
        return self.call_analyze(board, board_log, tls_path, dns_path)

    def call_analyze(
        self, board: str, board_log: Path, tls_path: Path, dns_path: Path
    ) -> phase1b_conformance.ConformanceSummary:
        return phase1b_conformance.analyze(
            board=board,
            board_log=board_log,
            tls_events_path=tls_path,
            dns_events_path=dns_path,
            board_ipv4="172.16.10.231" if board == "s3" else "172.16.10.145",
            peer_ipv4="172.16.10.126",
        )

    def test_accepts_exact_s3_and_p4_evidence(self) -> None:
        for board in ("s3", "p4"):
            with self.subTest(board=board):
                summary = self.analyze(board)
                self.assertEqual(summary.guest_operations, 40)
                self.assertEqual(summary.wire_requests, 44)
                self.assertEqual(summary.tls_connections, 25)
                self.assertEqual(summary.close_notify_connections, 7)
                self.assertEqual(summary.forced_close_connections, 18)
                self.assertEqual(summary.maximum_requests_per_connection, 6)
                self.assertEqual(summary.leases, 26)

    def test_rejects_plan_or_runtime_integrity_failure(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        original = board_log.read_text()
        board_log.write_text(
            original.replace(phase1b_conformance.EXPECTED_PLAN, "sha256:wrong", 1)
        )
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "S3 boot"):
            self.call_analyze("s3", board_log, tls_path, dns_path)
        board_log.write_text(
            original.replace("poison=0x00000000", "poison=0x00000001", 1)
        )
        with self.assertRaises(phase1b_conformance.ConformanceValidationError):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_missing_redirect_hop_or_hidden_retry(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = self.read_events(tls_path)
        del events[next(index for index, event in enumerate(events) if event.get("event") == "request" and event.get("request_id") == 6)]
        self.write_events(tls_path, events)
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "request count"):
            self.call_analyze("s3", board_log, tls_path, dns_path)

        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = self.read_events(tls_path)
        retry = next(event for event in events if event.get("event") == "request" and event.get("path") == "/retry-once")
        retry["path"] = "/attempts"
        self.write_events(tls_path, events)
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "exact conformance sequence"):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_connection_reuse_or_close_drift(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = self.read_events(tls_path)
        request = next(event for event in events if event.get("event") == "request" and event.get("request_id") == 5)
        request["connection_id"] = 2
        self.write_events(tls_path, events)
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "exact conformance sequence"):
            self.call_analyze("s3", board_log, tls_path, dns_path)

        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = self.read_events(tls_path)
        close = next(event for event in events if event.get("event") == "connection_close" and event.get("connection_id") == 4)
        close["tls_close_notify_observed"] = True
        close["tls_close_state"] = "close_notify"
        self.write_events(tls_path, events)
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "close/reuse"):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_upload_or_header_drift(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = self.read_events(tls_path)
        echo = next(event for event in events if event.get("event") == "request" and event.get("path") == "/echo")
        echo["body_bytes"] = 8
        echo["header_names"] = ["host", "content-length"]
        self.write_events(tls_path, events)
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "exact conformance sequence"):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_wrong_sni_version_or_failed_handshake(self) -> None:
        for mutation in ("sni", "version", "handshake"):
            with self.subTest(mutation=mutation):
                board_log, tls_path, dns_path, temporary = self.fixture()
                self.addCleanup(temporary.cleanup)
                events = self.read_events(tls_path)
                if mutation == "sni":
                    next(event for event in events if event.get("event") == "tls_client_hello")["server_name"] = "wrong.invalid"
                elif mutation == "version":
                    next(event for event in events if event.get("event") == "connection_open")["tls_version"] = "TLSv1.3"
                else:
                    stop = events.pop()
                    events.append({"event": "tls_handshake_error", "monotonic_ns": int(stop["monotonic_ns"]) - 1})
                    events.append(stop)
                self.write_events(tls_path, events)
                with self.assertRaises(phase1b_conformance.ConformanceValidationError):
                    self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_cross_board_or_stale_dns_evidence(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = self.read_events(dns_path)
        events[1]["peer_ipv4"] = "172.16.10.145"
        self.write_events(dns_path, events)
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "selected board"):
            self.call_analyze("s3", board_log, tls_path, dns_path)

        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = self.read_events(dns_path)
        events[1]["monotonic_ns"] = 32
        self.write_events(dns_path, events)
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "stale"):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_p4_power_expander_drift(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture(board="p4")
        self.addCleanup(temporary.cleanup)
        board_log.write_text(board_log.read_text().replace("after_high_z=0xfe", "after_high_z=0xff"))
        with self.assertRaisesRegex(phase1b_conformance.ConformanceValidationError, "power expander"):
            self.call_analyze("p4", board_log, tls_path, dns_path)


if __name__ == "__main__":
    unittest.main()
