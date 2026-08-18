#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable


MODULE_PATH = Path(__file__).with_name("phase1b_handshake_interrupt.py")
SPEC = importlib.util.spec_from_file_location(
    "pocketjs_phase1b_handshake_interrupt", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
phase1b_handshake_interrupt = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = phase1b_handshake_interrupt
SPEC.loader.exec_module(phase1b_handshake_interrupt)


class Phase1BHandshakeInterruptTest(unittest.TestCase):
    def fixture(
        self, *, board: str = "s3", profile_name: str = "timeout"
    ) -> tuple[Path, Path, Path, tempfile.TemporaryDirectory[str]]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        board_log = root / "board.log"
        tls_path = root / "tls.ndjson"
        dns_path = root / "dns.ndjson"
        board_ip = "172.16.10.231" if board == "s3" else "172.16.10.145"
        profile = phase1b_handshake_interrupt.PROFILES[profile_name]
        mode = profile["mode"]
        error_code = profile["error_code"]
        connect_timeout_us = profile["connect_timeout_us"]
        cancel_after_ms = profile["cancel_after_ms"]
        elapsed_ms = 2_200 if profile_name == "timeout" else 650

        lines = [
            "POCKET_NET_TLS_CONTRACT valid=1 https_explicit_opt_in=1 "
            "exact_host_tls_profile=1 distinct_tls_errors=1 public=0",
            "POCKET_NET_FORMAL_TLS_BOOT board=test "
            "origin=https://pocketjs.test:8443 peer_ipv4=172.16.10.126 "
            f"test_mode={mode} public_capability=0 distinct_tls_errors=1 "
            f"connect_timeout_us={connect_timeout_us} "
            f"cancel_after_ms={cancel_after_ms} "
            f"plan_hash={phase1b_handshake_interrupt.EXPECTED_PLAN} "
            f"factory_sha256={phase1b_handshake_interrupt.EXPECTED_FACTORY} "
            f"plan={phase1b_handshake_interrupt.EXPECTED_PLAN} "
            f"factory={phase1b_handshake_interrupt.EXPECTED_FACTORY}",
            "POCKET_NET_FORMAL_TLS_START probe=1 "
            "origin=https://pocketjs.test:8443 peer_ipv4=172.16.10.126 "
            f"mode={mode} connect_timeout_us={connect_timeout_us} "
            f"cancel_after_ms={cancel_after_ms}",
            "POCKET_NET_FORMAL_TLS_RUN status=ESP_ERR_INVALID_RESPONSE "
            "rounds=0/20 requests=0/40 frame_calls=0 service_turns=5 jobs=4 "
            "shutdown=1 poison=0x00000000 core_poison=0x00000000 "
            f"poisoned_cores=0 guest_yields=28 elapsed_ms={elapsed_ms}",
        ]
        if board == "s3":
            lines.extend(
                (
                    "POCKET_NET_FORMAL_TLS_RESULT probe=1 "
                    f"mode={mode} pass=1 esp_err=ESP_ERR_INVALID_RESPONSE "
                    "rounds=0/20 requests=0/40 shutdown=1 poison=0x00000000 "
                    "leases_balanced=1 queued_leases=0 taken_leases=0 "
                    f"error_code={error_code} error_operation=http.fetch",
                    "POCKET_NET_FORMAL_TLS_NEGATIVE_PASS "
                    f"mode={mode} error_code={error_code} shutdown=1 "
                    "poison=0x00000000",
                )
            )
        else:
            lines.extend(
                (
                    "POCKET_NET_FORMAL_TLS_RESOURCE probe=1 active=0 pending=0 "
                    "queued=0 taken=0 leases_taken=0 leases_released=0 "
                    "leases_cleaned=0 poison=0x00000000 shutdown=1",
                    "POCKET_NET_FORMAL_TLS_NEGATIVE_PASS board=tab5-esp32p4 "
                    f"probe=1 mode={mode} error_code={error_code} shutdown=1 "
                    "poison=0x00000000 leases=0/0",
                )
            )
        board_log.write_text("\n".join(lines) + "\n")

        tls = [
            {
                "event": "peer_ready",
                "monotonic_ns": 100,
                "transport": "tls",
                "port": 8443,
                "tls_min_version": "1.2",
                "tls_max_version": "1.2",
                "tls_certificate_der_sha256": (
                    phase1b_handshake_interrupt.EXPECTED_CERTIFICATE
                ),
                "tls_handshake_delay_ms": (
                    phase1b_handshake_interrupt.HANDSHAKE_DELAY_MS
                ),
                "observe_tls_close_notify": True,
                "socket_timeout_ms": 60_000,
            },
            {
                "event": "tls_handshake_delay",
                "monotonic_ns": 400,
                "peer_ipv4": board_ip,
                "delay_ms": 10_000,
            },
            {
                "event": "tls_client_hello",
                "monotonic_ns": 10_000_000_400,
                "peer_ipv4": board_ip,
                "server_name": "pocketjs.test",
            },
            {
                "event": "tls_handshake_error",
                "monotonic_ns": 10_000_000_500,
                "peer_ipv4": board_ip,
                "error": "SSLEOFError",
            },
            {
                "event": "peer_stop",
                "monotonic_ns": 10_000_000_700,
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
                "monotonic_ns": 10_000_000_800,
                "reason": "keyboard_interrupt",
            },
        ]
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in tls))
        dns_path.write_text("".join(json.dumps(event) + "\n" for event in dns))
        return board_log, tls_path, dns_path, temporary

    def analyze(
        self,
        board: str,
        profile_name: str,
        board_log: Path,
        tls_path: Path,
        dns_path: Path,
    ) -> phase1b_handshake_interrupt.HandshakeInterruptSummary:
        return phase1b_handshake_interrupt.analyze(
            board=board,
            profile_name=profile_name,
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
    ) -> None:
        events = [json.loads(line) for line in path.read_text().splitlines()]
        mutate(events)
        path.write_text("".join(json.dumps(event) + "\n" for event in events))

    def test_accepts_timeout_and_cancel_for_both_boards(self) -> None:
        for board in ("s3", "p4"):
            for profile_name, profile in (
                phase1b_handshake_interrupt.PROFILES.items()
            ):
                with self.subTest(board=board, profile=profile_name):
                    board_log, tls_path, dns_path, temporary = self.fixture(
                        board=board, profile_name=profile_name
                    )
                    try:
                        summary = self.analyze(
                            board, profile_name, board_log, tls_path, dns_path
                        )
                    finally:
                        temporary.cleanup()
                    self.assertEqual(summary.error_code, profile["error_code"])
                    self.assertEqual(summary.handshake_delay_ms, 10_000)
                    self.assertGreater(summary.guest_yields, 0)

    def test_rejects_wrong_deadline_or_cancel_snapshot(self) -> None:
        for profile_name, field in (
            ("timeout", "connect_timeout_us"),
            ("cancel", "cancel_after_ms"),
        ):
            with self.subTest(profile=profile_name):
                board_log, tls_path, dns_path, temporary = self.fixture(
                    profile_name=profile_name
                )
                self.addCleanup(temporary.cleanup)
                expected = phase1b_handshake_interrupt.PROFILES[profile_name][field]
                board_log.write_text(
                    board_log.read_text().replace(
                        f"{field}={expected}", f"{field}=1"
                    )
                )
                with self.assertRaisesRegex(
                    phase1b_handshake_interrupt.HandshakeInterruptValidationError,
                    "exact delayed-handshake interrupt profile",
                ):
                    self.analyze(
                        "s3", profile_name, board_log, tls_path, dns_path
                    )

    def test_rejects_late_or_impossibly_early_board_result(self) -> None:
        for elapsed in (100, 30_000):
            with self.subTest(elapsed=elapsed):
                board_log, tls_path, dns_path, temporary = self.fixture()
                self.addCleanup(temporary.cleanup)
                board_log.write_text(
                    board_log.read_text().replace(
                        "elapsed_ms=2200", f"elapsed_ms={elapsed}"
                    )
                )
                with self.assertRaisesRegex(
                    phase1b_handshake_interrupt.HandshakeInterruptValidationError,
                    "bounded window",
                ):
                    self.analyze("s3", "timeout", board_log, tls_path, dns_path)

    def test_rejects_wrong_artifact_or_guest_error(self) -> None:
        for expected in (
            phase1b_handshake_interrupt.EXPECTED_PLAN,
            phase1b_handshake_interrupt.EXPECTED_FACTORY,
        ):
            with self.subTest(artifact=expected):
                board_log, tls_path, dns_path, temporary = self.fixture()
                self.addCleanup(temporary.cleanup)
                board_log.write_text(
                    board_log.read_text().replace(expected, f"sha256:{'0' * 64}")
                )
                with self.assertRaisesRegex(
                    phase1b_handshake_interrupt.HandshakeInterruptValidationError,
                    "exact TLS interruption artifact",
                ):
                    self.analyze("s3", "timeout", board_log, tls_path, dns_path)

        board_log, tls_path, dns_path, temporary = self.fixture(profile_name="cancel")
        self.addCleanup(temporary.cleanup)
        board_log.write_text(
            board_log.read_text().replace("error_code=aborted", "error_code=timed_out")
        )
        with self.assertRaisesRegex(
            phase1b_handshake_interrupt.HandshakeInterruptValidationError,
            "selected handshake interruption|unexpected HTTP work",
        ):
            self.analyze("s3", "cancel", board_log, tls_path, dns_path)

    def test_rejects_wrong_peer_profile_or_certificate(self) -> None:
        for field, value in (
            ("tls_handshake_delay_ms", 1),
            ("tls_max_version", "1.3"),
            ("tls_certificate_der_sha256", "0" * 64),
        ):
            with self.subTest(field=field):
                board_log, tls_path, dns_path, temporary = self.fixture()
                self.addCleanup(temporary.cleanup)
                self.mutate_events(
                    tls_path, lambda events: events[0].__setitem__(field, value)
                )
                with self.assertRaisesRegex(
                    phase1b_handshake_interrupt.HandshakeInterruptValidationError,
                    "exact delayed TLS 1.2 profile",
                ):
                    self.analyze("s3", "timeout", board_log, tls_path, dns_path)

    def test_rejects_opened_connection_or_http_activity(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        self.mutate_events(
            tls_path,
            lambda events: events.insert(
                4, {"event": "connection_open", "monotonic_ns": 10_000_000_600}
            ),
        )
        with self.assertRaisesRegex(
            phase1b_handshake_interrupt.HandshakeInterruptValidationError,
            "opened TLS connection",
        ):
            self.analyze("s3", "timeout", board_log, tls_path, dns_path)

    def test_rejects_wrong_board_duplicate_sni_or_dns(self) -> None:
        for target in ("sni", "dns"):
            with self.subTest(target=target):
                board_log, tls_path, dns_path, temporary = self.fixture()
                self.addCleanup(temporary.cleanup)
                if target == "sni":
                    self.mutate_events(
                        tls_path,
                        lambda events: events[2].__setitem__(
                            "peer_ipv4", "172.16.10.145"
                        ),
                    )
                else:
                    self.mutate_events(
                        dns_path, lambda events: events.insert(2, dict(events[1]))
                    )
                with self.assertRaises(
                    phase1b_handshake_interrupt.HandshakeInterruptValidationError
                ):
                    self.analyze("s3", "timeout", board_log, tls_path, dns_path)

    def test_rejects_short_or_out_of_order_server_delay(self) -> None:
        for monotonic in (9_000_000_000, 350):
            with self.subTest(monotonic=monotonic):
                board_log, tls_path, dns_path, temporary = self.fixture()
                self.addCleanup(temporary.cleanup)
                self.mutate_events(
                    tls_path,
                    lambda events: events[2].__setitem__(
                        "monotonic_ns", monotonic
                    ),
                )
                with self.assertRaisesRegex(
                    phase1b_handshake_interrupt.HandshakeInterruptValidationError,
                    "out of order",
                ):
                    self.analyze("s3", "timeout", board_log, tls_path, dns_path)


if __name__ == "__main__":
    unittest.main()
