#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable


MODULE_PATH = Path(__file__).with_name("phase1b_version_reject.py")
SPEC = importlib.util.spec_from_file_location(
    "pocketjs_phase1b_version_reject", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
phase1b_version_reject = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = phase1b_version_reject
SPEC.loader.exec_module(phase1b_version_reject)


class Phase1BVersionRejectTest(unittest.TestCase):
    def fixture(
        self, *, board: str = "s3"
    ) -> tuple[Path, Path, Path, tempfile.TemporaryDirectory[str]]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        board_log = root / "board.log"
        tls_path = root / "tls.ndjson"
        dns_path = root / "dns.ndjson"
        board_ip = "172.16.10.231" if board == "s3" else "172.16.10.145"

        lines = [
            "POCKET_NET_TLS_CONTRACT valid=1 distinct_tls_errors=1 public=0",
            "POCKET_NET_FORMAL_TLS_BOOT board=test "
            "origin=https://pocketjs.test:8443 peer_ipv4=172.16.10.126 "
            "dns_server=172.16.10.126 test_mode=version_reject "
            "public_capability=0 distinct_tls_errors=1",
            "POCKET_NET_FORMAL_TLS_START probe=1 "
            "origin=https://pocketjs.test:8443 peer_ipv4=172.16.10.126 "
            "mode=version_reject",
            "POCKET_NET_FORMAL_TLS_RUN status=ESP_ERR_INVALID_RESPONSE "
            "rounds=0/20 requests=0/40 frame_calls=0 service_turns=5 jobs=4 "
            "shutdown=1 poison=0x00000000 core_poison=0x00000000 "
            "poisoned_cores=0 guest_yields=62 elapsed_ms=7219",
        ]
        if board == "s3":
            lines.append(
                "POCKET_NET_FORMAL_TLS_RESULT probe=1 mode=version_reject pass=1 "
                "esp_err=ESP_ERR_INVALID_RESPONSE rounds=0/20 requests=0/40 "
                "shutdown=1 poison=0x00000000 leases_balanced=1 queued_leases=0 "
                "taken_leases=0 error_code=tls_alert"
            )
            lines.append(
                "POCKET_NET_FORMAL_TLS_NEGATIVE_PASS mode=version_reject "
                "error_code=tls_alert shutdown=1 poison=0x00000000"
            )
        else:
            lines.extend(
                (
                    "POCKET_NET_FORMAL_TLS_RESOURCE probe=1 active=0 pending=0 "
                    "queued=0 taken=0 leases_taken=0 leases_released=0 "
                    "leases_cleaned=0 poison=0x00000000 shutdown=1",
                    "POCKET_NET_FORMAL_TLS_NEGATIVE_PASS board=tab5-esp32p4 "
                    "probe=1 mode=version_reject error_code=tls_alert shutdown=1 "
                    "poison=0x00000000 leases=0/0 elapsed_ms=2580",
                )
            )
        board_log.write_text("\n".join(lines) + "\n")

        tls = [
            {
                "event": "peer_ready",
                "monotonic_ns": 100,
                "transport": "tls",
                "port": 8443,
                "tls_min_version": "1.3",
                "tls_max_version": "1.3",
                "observe_tls_close_notify": True,
                "socket_timeout_ms": 60_000,
            },
            {
                "event": "tls_handshake_error",
                "monotonic_ns": 400,
                "peer_ipv4": board_ip,
                "error": "SSLError",
            },
            {
                "event": "peer_stop",
                "monotonic_ns": 600,
                "reason": "keyboard_interrupt",
            },
        ]
        dns = [
            {
                "event": "dns_ready",
                "monotonic_ns": 50,
                "authoritative_name": "pocketjs.test",
                "authoritative_ipv4": "172.16.10.126",
                "port": 53,
                "interface": "en1",
                "recursion_available": False,
                "transports": ["udp", "tcp"],
            },
            {
                "event": "dns_query",
                "monotonic_ns": 300,
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
                "monotonic_ns": 700,
                "reason": "keyboard_interrupt",
            },
        ]
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in tls))
        dns_path.write_text("".join(json.dumps(event) + "\n" for event in dns))
        return board_log, tls_path, dns_path, temporary

    def analyze(self, board: str = "s3") -> phase1b_version_reject.VersionRejectSummary:
        board_log, tls_path, dns_path, temporary = self.fixture(board=board)
        self.addCleanup(temporary.cleanup)
        return self.call_analyze(board, board_log, tls_path, dns_path)

    def call_analyze(
        self, board: str, board_log: Path, tls_path: Path, dns_path: Path
    ) -> phase1b_version_reject.VersionRejectSummary:
        return phase1b_version_reject.analyze(
            board=board,
            board_log=board_log,
            tls_events_path=tls_path,
            dns_events_path=dns_path,
            board_ipv4="172.16.10.231" if board == "s3" else "172.16.10.145",
            peer_ipv4="172.16.10.126",
        )

    def mutate_events(
        self,
        path: Path,
        mutate: Callable[[list[dict[str, object]]], None],
    ) -> list[dict[str, object]]:
        events = [json.loads(line) for line in path.read_text().splitlines()]
        mutate(events)
        path.write_text("".join(json.dumps(event) + "\n" for event in events))
        return events

    def test_accepts_exact_s3_and_p4_evidence(self) -> None:
        for board in ("s3", "p4"):
            with self.subTest(board=board):
                summary = self.analyze(board)
                self.assertEqual(summary.board, board)
                self.assertEqual(summary.error_code, "tls_alert")
                self.assertEqual(summary.tls_handshake_errors, 1)
                self.assertGreater(summary.guest_yields, 0)

    def test_rejects_open_connection_or_http_activity(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def add_request(events: list[dict[str, object]]) -> None:
            events.insert(2, {"event": "connection_open", "monotonic_ns": 450})

        self.mutate_events(tls_path, add_request)
        with self.assertRaisesRegex(
            phase1b_version_reject.VersionRejectValidationError, "opened TLS"
        ):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_unlocked_peer_version(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def unlock(events: list[dict[str, object]]) -> None:
            events[0]["tls_min_version"] = "1.2"

        self.mutate_events(tls_path, unlock)
        with self.assertRaisesRegex(
            phase1b_version_reject.VersionRejectValidationError, "TLS 1.3-only"
        ):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_reset_contaminated_second_handshake(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def duplicate(events: list[dict[str, object]]) -> None:
            events.insert(
                2,
                {
                    "event": "tls_handshake_error",
                    "monotonic_ns": 500,
                    "peer_ipv4": "172.16.10.231",
                    "error": "SSLError",
                },
            )

        self.mutate_events(tls_path, duplicate)
        with self.assertRaisesRegex(
            phase1b_version_reject.VersionRejectValidationError,
            "exactly one failed handshake",
        ):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_wrong_board_identity(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def wrong_peer(events: list[dict[str, object]]) -> None:
            events[1]["peer_ipv4"] = "172.16.10.99"

        self.mutate_events(dns_path, wrong_peer)
        with self.assertRaisesRegex(
            phase1b_version_reject.VersionRejectValidationError, "selected board"
        ):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_unclean_shutdown_or_live_lease(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        board_log.write_text(
            board_log.read_text().replace("leases_balanced=1", "leases_balanced=0")
        )
        with self.assertRaisesRegex(
            phase1b_version_reject.VersionRejectValidationError, "live leases"
        ):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_missing_cooperative_yield(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        board_log.write_text(
            board_log.read_text().replace("guest_yields=62", "guest_yields=0")
        )
        with self.assertRaisesRegex(
            phase1b_version_reject.VersionRejectValidationError, "cooperative"
        ):
            self.call_analyze("s3", board_log, tls_path, dns_path)

    def test_rejects_stale_or_out_of_order_evidence(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def stale(events: list[dict[str, object]]) -> None:
            events[1]["monotonic_ns"] = 40

        self.mutate_events(dns_path, stale)
        with self.assertRaisesRegex(
            phase1b_version_reject.VersionRejectValidationError, "out of order"
        ):
            self.call_analyze("s3", board_log, tls_path, dns_path)


if __name__ == "__main__":
    unittest.main()
