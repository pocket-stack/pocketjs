#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Callable


MODULE_PATH = Path(__file__).with_name("phase1b_certificate_reject.py")
SPEC = importlib.util.spec_from_file_location(
    "pocketjs_phase1b_certificate_reject", MODULE_PATH
)
assert SPEC is not None and SPEC.loader is not None
phase1b_certificate_reject = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = phase1b_certificate_reject
SPEC.loader.exec_module(phase1b_certificate_reject)


class Phase1BCertificateRejectTest(unittest.TestCase):
    def fixture(
        self, *, board: str = "s3", profile: str = "hostname-mismatch"
    ) -> tuple[Path, Path, Path, tempfile.TemporaryDirectory[str]]:
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        board_log = root / "board.log"
        tls_path = root / "tls.ndjson"
        dns_path = root / "dns.ndjson"
        board_ip = "172.16.10.231" if board == "s3" else "172.16.10.145"
        mode, error_code, certificate_sha = phase1b_certificate_reject.PROFILES[
            profile
        ]

        lines = [
            "POCKET_NET_TLS_CONTRACT valid=1 https_explicit_opt_in=1 "
            "exact_host_tls_profile=1 distinct_tls_errors=1 "
            "expected_distinct_tls_errors=1 public=0",
            "POCKET_NET_FORMAL_TLS_BOOT board=test "
            "origin=https://pocketjs.test:8443 peer_ipv4=172.16.10.126 "
            f"test_mode={mode} public_capability=0 distinct_tls_errors=1 "
            f"plan_hash={phase1b_certificate_reject.EXPECTED_PLAN} "
            f"factory_sha256={phase1b_certificate_reject.EXPECTED_FACTORY} "
            f"plan={phase1b_certificate_reject.EXPECTED_PLAN} "
            f"factory={phase1b_certificate_reject.EXPECTED_FACTORY}",
            "POCKET_NET_FORMAL_TLS_START probe=1 "
            "origin=https://pocketjs.test:8443 peer_ipv4=172.16.10.126 "
            f"mode={mode}",
            "POCKET_NET_FORMAL_TLS_RUN status=ESP_ERR_INVALID_RESPONSE "
            "rounds=0/20 requests=0/40 frame_calls=0 service_turns=5 jobs=4 "
            "shutdown=1 poison=0x00000000 core_poison=0x00000000 "
            "poisoned_cores=0 guest_yields=28 elapsed_ms=1530",
        ]
        if board == "s3":
            lines.extend(
                (
                    "POCKET_NET_FORMAL_TLS_RESULT probe=1 "
                    f"mode={mode} pass=1 esp_err=ESP_ERR_INVALID_RESPONSE "
                    "rounds=0/20 requests=0/40 shutdown=1 poison=0x00000000 "
                    "leases_balanced=1 queued_leases=0 taken_leases=0 "
                    f"error_code={error_code}",
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
                    "poison=0x00000000 leases=0/0 elapsed_ms=1530",
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
                "tls_certificate_der_sha256": certificate_sha,
                "observe_tls_close_notify": True,
                "socket_timeout_ms": 60_000,
            },
            {
                "event": "tls_client_hello",
                "monotonic_ns": 400,
                "peer_ipv4": board_ip,
                "server_name": "pocketjs.test",
            },
            {
                "event": "tls_handshake_error",
                "monotonic_ns": 500,
                "peer_ipv4": board_ip,
                "error": "SSLError",
            },
            {
                "event": "peer_stop",
                "monotonic_ns": 700,
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
                "monotonic_ns": 800,
                "reason": "keyboard_interrupt",
            },
        ]
        tls_path.write_text("".join(json.dumps(event) + "\n" for event in tls))
        dns_path.write_text("".join(json.dumps(event) + "\n" for event in dns))
        return board_log, tls_path, dns_path, temporary

    def call_analyze(
        self,
        board: str,
        profile: str,
        board_log: Path,
        tls_path: Path,
        dns_path: Path,
    ) -> phase1b_certificate_reject.CertificateRejectSummary:
        return phase1b_certificate_reject.analyze(
            board=board,
            profile=profile,
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

    def test_accepts_all_profiles_for_both_boards(self) -> None:
        for board in ("s3", "p4"):
            for profile, (_, error_code, certificate_sha) in (
                phase1b_certificate_reject.PROFILES.items()
            ):
                with self.subTest(board=board, profile=profile):
                    board_log, tls_path, dns_path, temporary = self.fixture(
                        board=board, profile=profile
                    )
                    try:
                        summary = self.call_analyze(
                            board, profile, board_log, tls_path, dns_path
                        )
                    finally:
                        temporary.cleanup()
                    self.assertEqual(summary.error_code, error_code)
                    self.assertEqual(summary.certificate_der_sha256, certificate_sha)
                    self.assertEqual(summary.tls_client_hellos, 1)
                    self.assertEqual(summary.tls_handshake_errors, 1)

    def test_rejects_certificate_fingerprint_mismatch(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def replace_hash(events: list[dict[str, object]]) -> None:
            events[0]["tls_certificate_der_sha256"] = "0" * 64

        self.mutate_events(tls_path, replace_hash)
        with self.assertRaisesRegex(
            phase1b_certificate_reject.CertificateRejectValidationError,
            "exact certificate rejection profile",
        ):
            self.call_analyze(
                "s3", "hostname-mismatch", board_log, tls_path, dns_path
            )

    def test_rejects_wrong_artifact_identity(self) -> None:
        for board, field in (("s3", "plan_hash"), ("p4", "plan")):
            with self.subTest(board=board):
                board_log, tls_path, dns_path, temporary = self.fixture(board=board)
                self.addCleanup(temporary.cleanup)
                board_log.write_text(
                    board_log.read_text().replace(
                        f"{field}={phase1b_certificate_reject.EXPECTED_PLAN}",
                        f"{field}=sha256:{'0' * 64}",
                        1,
                    )
                )
                with self.assertRaisesRegex(
                    phase1b_certificate_reject.CertificateRejectValidationError,
                    "exact TLS conformance artifact|exact certificate rejection profile",
                ):
                    self.call_analyze(
                        board, "hostname-mismatch", board_log, tls_path, dns_path
                    )

    def test_rejects_wrong_guest_error_class(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)
        board_log.write_text(
            board_log.read_text().replace(
                "error_code=tls_hostname_mismatch",
                "error_code=tls_certificate_invalid",
            )
        )
        with self.assertRaisesRegex(
            phase1b_certificate_reject.CertificateRejectValidationError,
            "selected certificate rejection|unexpected HTTP work",
        ):
            self.call_analyze(
                "s3", "hostname-mismatch", board_log, tls_path, dns_path
            )

    def test_rejects_wrong_or_duplicate_sni(self) -> None:
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate):
                board_log, tls_path, dns_path, temporary = self.fixture()
                self.addCleanup(temporary.cleanup)

                def corrupt(events: list[dict[str, object]]) -> None:
                    if duplicate:
                        events.insert(2, dict(events[1]))
                    else:
                        events[1]["server_name"] = "wrong.test"

                self.mutate_events(tls_path, corrupt)
                with self.assertRaisesRegex(
                    phase1b_certificate_reject.CertificateRejectValidationError,
                    "exactly one tls_client_hello|wrong board identity or SNI",
                ):
                    self.call_analyze(
                        "s3", "hostname-mismatch", board_log, tls_path, dns_path
                    )

    def test_rejects_opened_connection_or_http_activity(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def add_open(events: list[dict[str, object]]) -> None:
            events.insert(3, {"event": "connection_open", "monotonic_ns": 600})

        self.mutate_events(tls_path, add_open)
        with self.assertRaisesRegex(
            phase1b_certificate_reject.CertificateRejectValidationError,
            "opened TLS connection",
        ):
            self.call_analyze(
                "s3", "hostname-mismatch", board_log, tls_path, dns_path
            )

    def test_rejects_reset_contamination_or_wrong_board(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def duplicate_query(events: list[dict[str, object]]) -> None:
            events.insert(2, dict(events[1]))

        self.mutate_events(dns_path, duplicate_query)
        with self.assertRaisesRegex(
            phase1b_certificate_reject.CertificateRejectValidationError,
            "exactly one query",
        ):
            self.call_analyze(
                "s3", "hostname-mismatch", board_log, tls_path, dns_path
            )

    def test_rejects_unlocked_tls_or_unclean_shutdown(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def unlock(events: list[dict[str, object]]) -> None:
            events[0]["tls_max_version"] = "1.3"

        self.mutate_events(tls_path, unlock)
        with self.assertRaisesRegex(
            phase1b_certificate_reject.CertificateRejectValidationError,
            "exact certificate rejection profile",
        ):
            self.call_analyze(
                "s3", "hostname-mismatch", board_log, tls_path, dns_path
            )
        self.mutate_events(
            tls_path, lambda events: events[0].__setitem__("tls_max_version", "1.2")
        )
        board_log.write_text(board_log.read_text().replace("shutdown=1", "shutdown=0"))
        with self.assertRaisesRegex(
            phase1b_certificate_reject.CertificateRejectValidationError,
            "shut down cleanly|selected certificate rejection",
        ):
            self.call_analyze(
                "s3", "hostname-mismatch", board_log, tls_path, dns_path
            )

    def test_rejects_out_of_order_evidence(self) -> None:
        board_log, tls_path, dns_path, temporary = self.fixture()
        self.addCleanup(temporary.cleanup)

        def reorder(events: list[dict[str, object]]) -> None:
            events[1]["monotonic_ns"] = 550

        self.mutate_events(tls_path, reorder)
        with self.assertRaisesRegex(
            phase1b_certificate_reject.CertificateRejectValidationError,
            "out of order",
        ):
            self.call_analyze(
                "s3", "hostname-mismatch", board_log, tls_path, dns_path
            )


if __name__ == "__main__":
    unittest.main()
