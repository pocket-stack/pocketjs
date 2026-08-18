#!/usr/bin/env python3

from __future__ import annotations

import argparse
import ipaddress
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
KEY_VALUE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)")
ORIGIN = "https://pocketjs.test:8443"
EXPECTED_PLAN = "sha256:fe3014e4d3628eb60aaeedd414432eb8c9a5932e904b258a9d05a17c7f6abcce"
EXPECTED_FACTORY = "sha256:f71e8e98407f49d71589df91acaab864c8b1f759eb4d2b2ffb26edfd8b3ce3e6"
PROFILES = {
    "hostname-mismatch": (
        "hostname_reject",
        "tls_hostname_mismatch",
        "3751d9105ff41923f6c683acccdf50e42d9ff5d3a0d1c15eb70b866b680afcae",
    ),
    "unknown-ca": (
        "certificate_reject",
        "tls_certificate_invalid",
        "292097740611d88eca9444cd67bbfc345c318acd9108524510d48afb749f6e3c",
    ),
    "expired": (
        "certificate_reject",
        "tls_certificate_invalid",
        "20187c3b45165626069b97c343e10b2c75025712520c80dc8e5b0597ba015565",
    ),
    "not-yet-valid": (
        "certificate_reject",
        "tls_certificate_invalid",
        "733521cb7dead745e11696e2f41c96e1a29bcb1492a1b0c4dbc4ea3a9b6875bd",
    ),
    "bad-signature": (
        "certificate_reject",
        "tls_certificate_invalid",
        "c2021f4c1bc33bbf83e5cbc6dd91dfc28c4c77e401402455ba1628d9d669c752",
    ),
}


class CertificateRejectValidationError(ValueError):
    pass


@dataclass(frozen=True)
class CertificateRejectSummary:
    board: str
    board_ipv4: str
    profile: str
    certificate_der_sha256: str
    dns_answers: int
    tls_client_hellos: int
    tls_handshake_errors: int
    guest_yields: int
    elapsed_ms: int
    error_code: str


def fail(message: str) -> None:
    raise CertificateRejectValidationError(message)


def fields(line: str) -> dict[str, str]:
    return dict(KEY_VALUE.findall(ANSI_ESCAPE.sub("", line)))


def integer(values: dict[str, str], name: str) -> int:
    value = values.get(name)
    if value is None:
        fail(f"board log is missing {name}")
    try:
        return int(value, 0)
    except ValueError as error:
        raise CertificateRejectValidationError(f"invalid integer {name}={value}") from error


def monotonic_ns(event: dict[str, Any], context: str) -> int:
    value = event.get("monotonic_ns")
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        fail(f"{context} has no valid monotonic_ns")
    return value


def canonical_ipv4(value: str, option: str) -> str:
    try:
        parsed = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise CertificateRejectValidationError(
            f"{option} must be an IPv4 literal"
        ) from error
    if str(parsed) != value or parsed.is_unspecified:
        fail(f"{option} must be a canonical, specified IPv4 literal")
    return value


def load_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise CertificateRejectValidationError(
                f"{path}:{line_number}: invalid NDJSON"
            ) from error
        if not isinstance(event, dict):
            fail(f"{path}:{line_number}: event must be an object")
        events.append(event)
    return events


def exactly_one(
    events: list[dict[str, Any]], event_name: str, evidence_name: str
) -> dict[str, Any]:
    matches = [event for event in events if event.get("event") == event_name]
    if len(matches) != 1:
        fail(f"{evidence_name} must contain exactly one {event_name} event")
    return matches[0]


def validate_board_log(
    lines: list[str], board: str, peer_ipv4: str, mode: str, error_code: str
) -> tuple[int, int]:
    if any("task_wdt" in line for line in lines):
        fail("board log contains a task watchdog report")
    if any("Guru Meditation" in line or "assert failed" in line for line in lines):
        fail("board log contains a crash or assertion")
    if any("POCKET_NET_FORMAL_TLS_FAIL" in line for line in lines):
        fail("board log contains POCKET_NET_FORMAL_TLS_FAIL")

    boots = [line for line in lines if "POCKET_NET_FORMAL_TLS_BOOT" in line]
    if len(boots) != 1:
        fail("board evidence must contain exactly one formal TLS boot")
    boot = fields(boots[0])
    if (
        boot.get("origin") != ORIGIN
        or boot.get("peer_ipv4") != peer_ipv4
        or boot.get("public_capability") != "0"
    ):
        fail("board boot is not the exact test-only TLS certificate profile")

    if board == "s3":
        if (
            boot.get("plan_hash") != EXPECTED_PLAN
            or boot.get("factory_sha256") != EXPECTED_FACTORY
        ):
            fail("S3 boot is not the exact TLS conformance artifact")
        starts = [line for line in lines if "POCKET_NET_FORMAL_TLS_START" in line]
        contracts = [line for line in lines if "POCKET_NET_TLS_CONTRACT" in line]
        if len(starts) != 1 or len(contracts) != 1:
            fail("S3 evidence is missing its exact start or descriptor snapshot")
        start = fields(starts[0])
        contract = fields(contracts[0])
        if (
            start.get("mode") != mode
            or start.get("origin") != ORIGIN
            or start.get("peer_ipv4") != peer_ipv4
            or contract.get("valid") != "1"
            or contract.get("distinct_tls_errors") != "1"
            or contract.get("expected_distinct_tls_errors") != "1"
            or contract.get("public") != "0"
        ):
            fail("S3 start is not the exact certificate rejection profile")
    elif (
        boot.get("test_mode") != mode
        or boot.get("distinct_tls_errors") != "1"
        or boot.get("plan") != EXPECTED_PLAN
        or boot.get("factory") != EXPECTED_FACTORY
    ):
        fail("P4 boot is not the exact certificate rejection profile")

    runs = [line for line in lines if "POCKET_NET_FORMAL_TLS_RUN" in line]
    if len(runs) != 1:
        fail("board evidence must contain exactly one formal TLS run")
    run = fields(runs[0])
    if (
        run.get("status") != "ESP_ERR_INVALID_RESPONSE"
        or run.get("rounds") != "0/20"
        or run.get("requests") != "0/40"
        or run.get("frame_calls") != "0"
        or run.get("shutdown") != "1"
        or run.get("poison") != "0x00000000"
        or run.get("core_poison") != "0x00000000"
        or run.get("poisoned_cores") != "0"
    ):
        fail("formal TLS run did not fail closed and shut down cleanly")
    guest_yields = integer(run, "guest_yields")
    elapsed_ms = integer(run, "elapsed_ms")
    if guest_yields <= 0 or elapsed_ms <= 0:
        fail("formal TLS run did not record bounded cooperative execution")

    passes = [line for line in lines if "POCKET_NET_FORMAL_TLS_NEGATIVE_PASS" in line]
    if len(passes) != 1:
        fail("board evidence must contain exactly one negative-pass record")
    passed = fields(passes[0])
    if (
        passed.get("mode") != mode
        or passed.get("error_code") != error_code
        or passed.get("shutdown") != "1"
        or passed.get("poison") != "0x00000000"
    ):
        fail("board did not report the selected certificate rejection")

    if board == "s3":
        results = [
            line
            for line in lines
            if "POCKET_NET_FORMAL_TLS_RESULT" in line
            and "POCKET_NET_FORMAL_TLS_RUN" not in line
        ]
        if len(results) != 1:
            fail("S3 evidence must contain exactly one result record")
        result = fields(results[0])
        if (
            result.get("mode") != mode
            or result.get("pass") != "1"
            or result.get("error_code") != error_code
            or result.get("requests") != "0/40"
            or result.get("shutdown") != "1"
            or result.get("poison") != "0x00000000"
            or result.get("leases_balanced") != "1"
            or result.get("queued_leases") != "0"
            or result.get("taken_leases") != "0"
        ):
            fail("S3 result has poison, live leases, or unexpected HTTP work")
    else:
        resources = [
            line for line in lines if "POCKET_NET_FORMAL_TLS_RESOURCE" in line
        ]
        if len(resources) != 1:
            fail("P4 evidence must contain exactly one resource record")
        resource = fields(resources[0])
        if (
            resource.get("active") != "0"
            or resource.get("pending") != "0"
            or resource.get("queued") != "0"
            or resource.get("taken") != "0"
            or resource.get("leases_taken") != "0"
            or resource.get("leases_released") != "0"
            or resource.get("leases_cleaned") != "0"
            or resource.get("poison") != "0x00000000"
            or resource.get("shutdown") != "1"
            or passed.get("leases") != "0/0"
        ):
            fail("P4 result has poison, live leases, or active operations")

    return guest_yields, elapsed_ms


def analyze(
    *,
    board: str,
    profile: str,
    board_log: Path,
    tls_events_path: Path,
    dns_events_path: Path,
    board_ipv4: str,
    peer_ipv4: str,
) -> CertificateRejectSummary:
    board_ipv4 = canonical_ipv4(board_ipv4, "--board-ipv4")
    peer_ipv4 = canonical_ipv4(peer_ipv4, "--peer-ipv4")
    mode, error_code, certificate_sha = PROFILES[profile]
    lines = board_log.read_text(errors="replace").splitlines()
    guest_yields, elapsed_ms = validate_board_log(
        lines, board, peer_ipv4, mode, error_code
    )

    tls_events = load_events(tls_events_path)
    dns_events = load_events(dns_events_path)
    tls_ready = exactly_one(tls_events, "peer_ready", "TLS evidence")
    tls_stop = exactly_one(tls_events, "peer_stop", "TLS evidence")
    if (
        tls_ready.get("transport") != "tls"
        or tls_ready.get("port") != 8443
        or tls_ready.get("tls_min_version") != "1.2"
        or tls_ready.get("tls_max_version") != "1.2"
        or tls_ready.get("tls_certificate_der_sha256") != certificate_sha
        or tls_ready.get("observe_tls_close_notify") is not True
        or not isinstance(tls_ready.get("socket_timeout_ms"), int)
        or int(tls_ready["socket_timeout_ms"]) <= 30_000
        or tls_stop.get("reason") != "keyboard_interrupt"
    ):
        fail("peer readiness is not the exact certificate rejection profile")

    dns_ready = exactly_one(dns_events, "dns_ready", "DNS evidence")
    dns_stop = exactly_one(dns_events, "dns_stop", "DNS evidence")
    if (
        dns_ready.get("authoritative_name") != "pocketjs.test"
        or dns_ready.get("authoritative_ipv4") != peer_ipv4
        or dns_ready.get("port") != 53
        or dns_ready.get("interface") != "en1"
        or dns_ready.get("recursion_available") is not False
        or dns_ready.get("transports") != ["udp", "tcp"]
        or dns_stop.get("reason") != "keyboard_interrupt"
    ):
        fail("DNS readiness is not the exact controlled authoritative profile")

    queries = [event for event in dns_events if event.get("event") == "dns_query"]
    if len(queries) != 1:
        fail("DNS evidence must contain exactly one query from the selected board")
    answer = queries[0]
    if (
        answer.get("outcome") != "answer"
        or answer.get("peer_ipv4") != board_ipv4
        or answer.get("query_name") != "pocketjs.test"
        or answer.get("query_type") != 1
        or answer.get("query_class") != 1
        or answer.get("answers") != 1
        or answer.get("rcode") != 0
        or answer.get("recursion_available") is not False
    ):
        fail("DNS answer is not confined to the selected board and hostname")

    hello = exactly_one(tls_events, "tls_client_hello", "TLS evidence")
    handshake_error = exactly_one(tls_events, "tls_handshake_error", "TLS evidence")
    if (
        hello.get("peer_ipv4") != board_ipv4
        or hello.get("server_name") != "pocketjs.test"
        or handshake_error.get("peer_ipv4") != board_ipv4
        or handshake_error.get("error") != "SSLError"
    ):
        fail("TLS handshake evidence has the wrong board identity or SNI")

    forbidden_events = {"connection_open", "request", "response", "connection_close"}
    if any(event.get("event") in forbidden_events for event in tls_events):
        fail("certificate rejection reached an opened TLS connection or HTTP request")

    tls_ready_ns = monotonic_ns(tls_ready, "peer_ready")
    dns_ready_ns = monotonic_ns(dns_ready, "dns_ready")
    answer_ns = monotonic_ns(answer, "dns_query")
    hello_ns = monotonic_ns(hello, "tls_client_hello")
    handshake_ns = monotonic_ns(handshake_error, "tls_handshake_error")
    tls_stop_ns = monotonic_ns(tls_stop, "peer_stop")
    dns_stop_ns = monotonic_ns(dns_stop, "dns_stop")
    if not (
        dns_ready_ns < answer_ns < dns_stop_ns
        and tls_ready_ns < hello_ns < handshake_ns < tls_stop_ns
        and answer_ns < hello_ns
    ):
        fail("DNS and TLS evidence is stale, incomplete, or out of order")

    return CertificateRejectSummary(
        board=board,
        board_ipv4=board_ipv4,
        profile=profile,
        certificate_der_sha256=certificate_sha,
        dns_answers=1,
        tls_client_hellos=1,
        tls_handshake_errors=1,
        guest_yields=guest_yields,
        elapsed_ms=elapsed_ms,
        error_code=error_code,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate PocketJS ESP Phase 1B certificate rejection"
    )
    parser.add_argument("--board", choices=("s3", "p4"), required=True)
    parser.add_argument("--profile", choices=tuple(PROFILES), required=True)
    parser.add_argument("--board-log", type=Path, required=True)
    parser.add_argument("--tls-events", type=Path, required=True)
    parser.add_argument("--dns-events", type=Path, required=True)
    parser.add_argument("--board-ipv4", required=True)
    parser.add_argument("--peer-ipv4", required=True)
    args = parser.parse_args()
    try:
        summary = analyze(
            board=args.board,
            profile=args.profile,
            board_log=args.board_log,
            tls_events_path=args.tls_events,
            dns_events_path=args.dns_events,
            board_ipv4=args.board_ipv4,
            peer_ipv4=args.peer_ipv4,
        )
    except (OSError, CertificateRejectValidationError) as error:
        parser.exit(1, f"phase1b certificate rejection failed: {error}\n")
    print(json.dumps(asdict(summary), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
