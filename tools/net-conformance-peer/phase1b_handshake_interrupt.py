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
EXPECTED_PLAN = (
    "sha256:9240cfa29c1678b49b6fed67104a39b2ad32f5dedab372af1c2a0bde3d602654"
)
EXPECTED_FACTORY = (
    "sha256:7290243f0b188d4ddbe0f55c994be320b7d2d5c848baf6dd836f14934a63a6dc"
)
EXPECTED_CERTIFICATE = (
    "9b5980ca2a7dcda57666566c06f55d85c1be5ec52fbcffe26c9976a9b520a786"
)
HANDSHAKE_DELAY_MS = 10_000
PROFILES = {
    "timeout": {
        "mode": "handshake_timeout",
        "error_code": "timed_out",
        "connect_timeout_us": 2_000_000,
        "cancel_after_ms": 0,
        "minimum_elapsed_ms": 1_500,
    },
    "cancel": {
        "mode": "cancel",
        "error_code": "aborted",
        "connect_timeout_us": 0,
        "cancel_after_ms": 500,
        "minimum_elapsed_ms": 350,
    },
}


class HandshakeInterruptValidationError(ValueError):
    pass


@dataclass(frozen=True)
class HandshakeInterruptSummary:
    board: str
    board_ipv4: str
    profile: str
    error_code: str
    elapsed_ms: int
    guest_yields: int
    dns_answers: int
    tls_client_hellos: int
    tls_handshake_errors: int
    handshake_delay_ms: int


def fail(message: str) -> None:
    raise HandshakeInterruptValidationError(message)


def fields(line: str) -> dict[str, str]:
    return dict(KEY_VALUE.findall(ANSI_ESCAPE.sub("", line)))


def integer(values: dict[str, str], name: str) -> int:
    value = values.get(name)
    if value is None:
        fail(f"board log is missing {name}")
    try:
        return int(value, 0)
    except ValueError as error:
        raise HandshakeInterruptValidationError(
            f"invalid integer {name}={value}"
        ) from error


def canonical_ipv4(value: str, option: str) -> str:
    try:
        parsed = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise HandshakeInterruptValidationError(
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
            raise HandshakeInterruptValidationError(
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


def monotonic_ns(event: dict[str, Any], context: str) -> int:
    value = event.get("monotonic_ns")
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        fail(f"{context} has no valid monotonic_ns")
    return value


def validate_board_log(
    lines: list[str],
    board: str,
    peer_ipv4: str,
    profile: dict[str, object],
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
        fail("board boot is not the exact test-only TLS interrupt profile")

    expected_mode = str(profile["mode"])
    expected_error = str(profile["error_code"])
    expected_connect_us = int(profile["connect_timeout_us"])
    expected_cancel_ms = int(profile["cancel_after_ms"])
    if board == "s3":
        if (
            boot.get("plan_hash") != EXPECTED_PLAN
            or boot.get("factory_sha256") != EXPECTED_FACTORY
        ):
            fail("S3 boot is not the exact TLS interruption artifact")
        starts = [line for line in lines if "POCKET_NET_FORMAL_TLS_START" in line]
        contracts = [line for line in lines if "POCKET_NET_TLS_CONTRACT" in line]
        if len(starts) != 1 or len(contracts) != 1:
            fail("S3 evidence is missing its exact start or descriptor snapshot")
        start = fields(starts[0])
        contract = fields(contracts[0])
        if (
            start.get("mode") != expected_mode
            or start.get("origin") != ORIGIN
            or start.get("peer_ipv4") != peer_ipv4
            or integer(start, "connect_timeout_us") != expected_connect_us
            or integer(start, "cancel_after_ms") != expected_cancel_ms
            or contract.get("valid") != "1"
            or contract.get("distinct_tls_errors") != "1"
            or contract.get("public") != "0"
        ):
            fail("S3 start is not the exact delayed-handshake interrupt profile")
    elif (
        boot.get("test_mode") != expected_mode
        or boot.get("distinct_tls_errors") != "1"
        or boot.get("plan") != EXPECTED_PLAN
        or boot.get("factory") != EXPECTED_FACTORY
        or integer(boot, "connect_timeout_us") != expected_connect_us
        or integer(boot, "cancel_after_ms") != expected_cancel_ms
    ):
        fail("P4 boot is not the exact delayed-handshake interrupt profile")

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
        fail("formal TLS run did not interrupt and shut down cleanly")
    guest_yields = integer(run, "guest_yields")
    elapsed_ms = integer(run, "elapsed_ms")
    if (
        guest_yields <= 0
        or elapsed_ms < int(profile["minimum_elapsed_ms"])
        or elapsed_ms >= 30_000
    ):
        fail("formal TLS interruption did not occur inside its bounded window")

    passes = [line for line in lines if "POCKET_NET_FORMAL_TLS_NEGATIVE_PASS" in line]
    if len(passes) != 1:
        fail("board evidence must contain exactly one negative-pass record")
    passed = fields(passes[0])
    if (
        passed.get("mode") != expected_mode
        or passed.get("error_code") != expected_error
        or passed.get("shutdown") != "1"
        or passed.get("poison") != "0x00000000"
    ):
        fail("board did not report the selected handshake interruption")

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
            result.get("mode") != expected_mode
            or result.get("pass") != "1"
            or result.get("error_code") != expected_error
            or result.get("error_operation") != "http.fetch"
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
    profile_name: str,
    board_log: Path,
    tls_events_path: Path,
    dns_events_path: Path,
    board_ipv4: str,
    peer_ipv4: str,
) -> HandshakeInterruptSummary:
    board_ipv4 = canonical_ipv4(board_ipv4, "--board-ipv4")
    peer_ipv4 = canonical_ipv4(peer_ipv4, "--peer-ipv4")
    profile = PROFILES[profile_name]
    lines = board_log.read_text(errors="replace").splitlines()
    guest_yields, elapsed_ms = validate_board_log(
        lines, board, peer_ipv4, profile
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
        or tls_ready.get("tls_certificate_der_sha256") != EXPECTED_CERTIFICATE
        or tls_ready.get("tls_handshake_delay_ms") != HANDSHAKE_DELAY_MS
        or tls_ready.get("observe_tls_close_notify") is not True
        or not isinstance(tls_ready.get("socket_timeout_ms"), int)
        or int(tls_ready["socket_timeout_ms"]) <= HANDSHAKE_DELAY_MS
        or tls_stop.get("reason") != "keyboard_interrupt"
    ):
        fail("peer readiness is not the exact delayed TLS 1.2 profile")

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

    handshake_delay = exactly_one(tls_events, "tls_handshake_delay", "TLS evidence")
    hello = exactly_one(tls_events, "tls_client_hello", "TLS evidence")
    handshake_error = exactly_one(tls_events, "tls_handshake_error", "TLS evidence")
    if (
        handshake_delay.get("peer_ipv4") != board_ipv4
        or handshake_delay.get("delay_ms") != HANDSHAKE_DELAY_MS
        or hello.get("peer_ipv4") != board_ipv4
        or hello.get("server_name") != "pocketjs.test"
        or handshake_error.get("peer_ipv4") != board_ipv4
        or handshake_error.get("error") != "SSLEOFError"
    ):
        fail("TLS handshake evidence has the wrong board identity or SNI")
    forbidden_events = {"connection_open", "request", "response", "connection_close"}
    if any(event.get("event") in forbidden_events for event in tls_events):
        fail("interrupted handshake reached an opened TLS connection or HTTP request")

    tls_ready_ns = monotonic_ns(tls_ready, "peer_ready")
    dns_ready_ns = monotonic_ns(dns_ready, "dns_ready")
    answer_ns = monotonic_ns(answer, "dns_query")
    delay_ns = monotonic_ns(handshake_delay, "tls_handshake_delay")
    hello_ns = monotonic_ns(hello, "tls_client_hello")
    handshake_ns = monotonic_ns(handshake_error, "tls_handshake_error")
    tls_stop_ns = monotonic_ns(tls_stop, "peer_stop")
    dns_stop_ns = monotonic_ns(dns_stop, "dns_stop")
    if not (
        dns_ready_ns < answer_ns < dns_stop_ns
        and tls_ready_ns < delay_ns < hello_ns < handshake_ns < tls_stop_ns
        and answer_ns < delay_ns
        and hello_ns - delay_ns >= HANDSHAKE_DELAY_MS * 1_000_000
    ):
        fail("DNS and delayed-handshake evidence is stale, incomplete, or out of order")

    return HandshakeInterruptSummary(
        board=board,
        board_ipv4=board_ipv4,
        profile=profile_name,
        error_code=str(profile["error_code"]),
        elapsed_ms=elapsed_ms,
        guest_yields=guest_yields,
        dns_answers=1,
        tls_client_hellos=1,
        tls_handshake_errors=1,
        handshake_delay_ms=HANDSHAKE_DELAY_MS,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate PocketJS ESP Phase 1B TLS timeout or cancellation"
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
            profile_name=args.profile,
            board_log=args.board_log,
            tls_events_path=args.tls_events,
            dns_events_path=args.dns_events,
            board_ipv4=args.board_ipv4,
            peer_ipv4=args.peer_ipv4,
        )
    except (OSError, HandshakeInterruptValidationError) as error:
        parser.exit(1, f"phase1b handshake interruption failed: {error}\n")
    print(json.dumps(asdict(summary), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
