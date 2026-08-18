#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("phase1b_soak.py")
SPEC = importlib.util.spec_from_file_location("pocketjs_phase1b_soak", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
phase1b_soak = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = phase1b_soak
SPEC.loader.exec_module(phase1b_soak)


class Phase1BSoakTest(unittest.TestCase):
    def fixture(
        self, *, board: str = "s3"
    ) -> tuple[Path, Path, Path, tempfile.TemporaryDirectory[str]]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        board_log = root / "board.log"
        tls_path = root / "tls.ndjson"
        dns_path = root / "dns.ndjson"
        board_ip = "172.16.10.231" if board == "s3" else "172.16.10.145"

        lines: list[str] = []
        for run in range(1, 4):
            if board == "s3":
                lines.extend(
                    (
                        "POCKET_NET_RESOURCE phase=formal_before "
                        "internal_free=240000 internal_min=239000 "
                        "psram_free=8380000 psram_min=8379000",
                        f"POCKET_NET_FORMAL_TLS_RESULT probe={run} mode=success "
                        "pass=1 rounds=20/20 requests=40/40 shutdown=1 "
                        "poison=0x00000000 leases_balanced=1 guest_yields=400",
                        "POCKET_NET_RESOURCE phase=formal_after "
                        f"internal_free={230000 - run * 100} internal_min=190000 "
                        f"psram_free={8370000 - run * 10} psram_min=5070000",
                    )
                )
            else:
                lines.extend(
                    (
                        f"POCKET_NET_FORMAL_TLS_RESOURCE probe={run} "
                        f"internal_before=410000 internal_after={407000 - run * 100} "
                        "internal_min=365000 psram_before=33549000 "
                        f"psram_after={33548000 - run * 10} psram_min=30240000",
                        f"POCKET_NET_FORMAL_TLS_PASS board=tab5-esp32p4 probe={run} "
                        "rounds=20 requests=40 shutdown=1 poison=0x00000000 "
                        "leases=40/40 guest_yields=400",
                    )
                )
        board_log.write_text("\n".join(lines) + "\n")

        tls: list[dict[str, object]] = [
            {
                "event": "peer_ready",
                "socket_timeout_ms": 60_000,
                "transport": "tls",
                "tls_min_version": "1.2",
                "tls_max_version": "1.2",
                "observe_tls_close_notify": True,
            }
        ]
        for run in range(1, 4):
            base = (run - 1) * 600_000_000_000
            tls.append(
                {
                    "event": "tls_client_hello",
                    "monotonic_ns": base,
                    "peer_ipv4": board_ip,
                    "server_name": "pocketjs.test",
                }
            )
            tls.append(
                {
                    "event": "connection_open",
                    "monotonic_ns": base + 1,
                    "peer_ipv4": board_ip,
                    "connection_id": run,
                    "tls_server_name": "pocketjs.test",
                    "tls_version": "TLSv1.2",
                }
            )
            for request in range(1, 41):
                health = request % 2 == 1
                tls.append(
                    {
                        "event": "request",
                        "monotonic_ns": base + request + 1,
                        "connection_id": run,
                        "connection_request_index": request,
                        "method": "GET" if health else "POST",
                        "path": "/health" if health else "/echo",
                        "body_bytes": 0 if health else 12,
                        "query_names": [],
                        "header_names": (
                            ["accept-encoding", "host"]
                            if health
                            else ["accept-encoding", "host", "transfer-encoding"]
                        ),
                    }
                )
            tls.append(
                {
                    "event": "connection_close",
                    "monotonic_ns": base + 500_000_000_000,
                    "connection_id": run,
                    "requests": 40,
                    "tls_close_state": "close_notify",
                    "tls_close_notify_observed": True,
                }
            )
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in tls))
        dns_path.write_text(
            json.dumps(
                {
                    "event": "dns_ready",
                    "authoritative_name": "pocketjs.test",
                    "authoritative_ipv4": "172.16.10.126",
                    "port": 53,
                    "interface": "en1",
                    "recursion_available": False,
                    "transports": ["udp", "tcp"],
                }
            )
            + "\n"
            + json.dumps(
                {
                    "event": "dns_query",
                    "outcome": "answer",
                    "peer_ipv4": board_ip,
                    "query_name": "pocketjs.test",
                    "query_type": 1,
                    "query_class": 1,
                    "answers": 1,
                    "rcode": 0,
                    "recursion_available": False,
                }
            )
            + "\n"
        )
        return board_log, tls_path, dns_path, temporary

    def analyze(self, board: str = "s3") -> phase1b_soak.SoakSummary:
        board_log, tls_path, dns_path, temporary = self.fixture(board=board)
        self.addCleanup(temporary.cleanup)
        return phase1b_soak.analyze(
            board=board,
            board_log=board_log,
            tls_events_path=tls_path,
            dns_events_path=dns_path,
            board_ipv4="172.16.10.231" if board == "s3" else "172.16.10.145",
            peer_ipv4="172.16.10.126",
            minimum_duration_seconds=900,
            minimum_runs=3,
            max_internal_peak_bytes=65536,
            max_psram_peak_bytes=4194304,
            max_internal_drift_bytes=16384,
            max_psram_drift_bytes=4096,
        )

    def test_accepts_s3_and_p4_soak_evidence(self) -> None:
        for board in ("s3", "p4"):
            with self.subTest(board=board):
                summary = self.analyze(board)
                self.assertEqual(summary.runs, 3)
                self.assertEqual(summary.requests, 120)
                self.assertEqual(summary.close_notify_connections, 3)
                self.assertEqual(summary.minimum_guest_yields, 400)

    def test_rejects_task_watchdog_report(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        board_log.write_text(board_log.read_text() + "E task_wdt: timeout\n")
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "watchdog"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_missing_cooperative_yield(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        board_log.write_text(
            board_log.read_text().replace("guest_yields=400", "guest_yields=0", 1)
        )
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "yield"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_wrong_sni(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = [json.loads(line) for line in tls_path.read_text().splitlines()]
        hello = next(
            event for event in events if event.get("event") == "tls_client_hello"
        )
        hello["server_name"] = "wrong.invalid"
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in events))
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "SNI"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_peer_timeout_that_preempts_client(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = [json.loads(line) for line in tls_path.read_text().splitlines()]
        events[0]["socket_timeout_ms"] = 5_000
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in events))
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "peer socket"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_peer_without_locked_tls_profile(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = [json.loads(line) for line in tls_path.read_text().splitlines()]
        events[0]["tls_max_version"] = None
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in events))
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "TLS 1.2"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_reset_contaminated_handshake(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = [json.loads(line) for line in tls_path.read_text().splitlines()]
        events.extend(
            (
                {
                    "event": "tls_client_hello",
                    "monotonic_ns": 1_700_000_000_001,
                    "peer_ipv4": "172.16.10.231",
                    "server_name": "pocketjs.test",
                },
                {
                    "event": "tls_handshake_error",
                    "monotonic_ns": 1_760_000_000_001,
                    "peer_ipv4": "172.16.10.231",
                    "error_type": "TimeoutError",
                },
            )
        )
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in events))
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "handshake"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_resource_drift(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        board_log.write_text(
            board_log.read_text().replace(
                "internal_free=229700 internal_min=190000",
                "internal_free=200000 internal_min=190000",
            )
        )
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "drift"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_incomplete_request_set(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = [json.loads(line) for line in tls_path.read_text().splitlines()]
        request_index = next(
            index
            for index, event in enumerate(events)
            if event.get("event") == "request" and event.get("connection_id") == 3
        )
        del events[request_index]
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in events))
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "requests"):
            self.call_analyze(board_log, tls_path, dns_path)

    def test_rejects_wrong_request_sequence(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        events = [json.loads(line) for line in tls_path.read_text().splitlines()]
        request = next(event for event in events if event.get("event") == "request")
        request["path"] = "/status/200"
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in events))
        with self.assertRaisesRegex(phase1b_soak.SoakValidationError, "sequence"):
            self.call_analyze(board_log, tls_path, dns_path)

    def call_analyze(self, board_log: Path, tls_path: Path, dns_path: Path) -> None:
        phase1b_soak.analyze(
            board="s3",
            board_log=board_log,
            tls_events_path=tls_path,
            dns_events_path=dns_path,
            board_ipv4="172.16.10.231",
            peer_ipv4="172.16.10.126",
            minimum_duration_seconds=900,
            minimum_runs=3,
            max_internal_peak_bytes=65536,
            max_psram_peak_bytes=4194304,
            max_internal_drift_bytes=16384,
            max_psram_drift_bytes=4096,
        )


if __name__ == "__main__":
    unittest.main()
