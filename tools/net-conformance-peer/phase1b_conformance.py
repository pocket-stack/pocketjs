#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable


ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
KEY_VALUE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)")
EXPECTED_PLAN = "sha256:fe3014e4d3628eb60aaeedd414432eb8c9a5932e904b258a9d05a17c7f6abcce"
EXPECTED_FACTORY = "sha256:f71e8e98407f49d71589df91acaab864c8b1f759eb4d2b2ffb26edfd8b3ce3e6"
EXPECTED_CA = "sha256:318ae57f0fb82d12cf86431571fb6ec3556ecb74f530a5be6f741a482b5447af"
EXPECTED_PROVIDER = "pocketjs.net.esp-idf.esp-tls.v1.experimental"
EXPECTED_ORIGIN = "https://pocketjs.test:8443"
EXPECTED_GUEST_OPERATIONS = 40
EXPECTED_WIRE_REQUESTS = 44
EXPECTED_CONNECTIONS = 25
EXPECTED_LEASES = 26
GRACEFUL_CONNECTIONS = frozenset((1, 2, 3, 13, 14, 15, 25))
CONNECTION_LENGTHS = (5, 2, 3, 1, 1, 1, 1, 1, 1, 1, 1, 3, 6, 2, 3, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1)


class ConformanceValidationError(ValueError):
    pass


@dataclass(frozen=True)
class RequestExpectation:
    method: str
    path: str
    query_names: tuple[str, ...] = ()
    body_bytes: int = 0

    @property
    def header_names(self) -> tuple[str, ...]:
        if self.method == "POST":
            return ("accept-encoding", "host", "transfer-encoding")
        return ("accept-encoding", "host")


@dataclass(frozen=True)
class ConformanceSummary:
    board: str
    board_ipv4: str
    guest_operations: int
    wire_requests: int
    tls_connections: int
    close_notify_connections: int
    forced_close_connections: int
    dns_answers: int
    maximum_requests_per_connection: int
    leases: int
    guest_yields: int
    elapsed_ms: int


BASE_REQUESTS = (
    RequestExpectation("HEAD", "/health"),
    RequestExpectation("GET", "/chunked", ("fragment_ms",)),
    RequestExpectation("GET", "/status/404"),
    RequestExpectation("GET", "/status/503"),
    RequestExpectation("GET", "/redirect", ("status", "to")),
    RequestExpectation("GET", "/health"),
    RequestExpectation("GET", "/redirect", ("status", "to")),
    RequestExpectation("GET", "/chunked", ("fragment_ms",)),
    RequestExpectation("GET", "/redirect", ("status", "to")),
    RequestExpectation("GET", "/redirect", ("status", "to")),
    RequestExpectation("GET", "/malformed/te-cl"),
    RequestExpectation("GET", "/malformed/duplicate-content-length"),
    RequestExpectation("GET", "/malformed/obs-fold"),
    RequestExpectation("GET", "/malformed/te-duplicate"),
    RequestExpectation("GET", "/malformed/te-combined"),
    RequestExpectation("GET", "/malformed/te-unknown"),
    RequestExpectation("GET", "/malformed/trailer-forbidden"),
    RequestExpectation("GET", "/malformed/chunk-size"),
    RequestExpectation("POST", "/echo", body_bytes=7),
    RequestExpectation("POST", "/echo", body_bytes=10),
    RequestExpectation("GET", "/retry-once", ("token",)),
    RequestExpectation("GET", "/attempts", ("token",)),
)
EXPECTED_REQUESTS = BASE_REQUESTS + BASE_REQUESTS


def fail(message: str) -> None:
    raise ConformanceValidationError(message)


def fields(line: str) -> dict[str, str]:
    return dict(KEY_VALUE.findall(ANSI_ESCAPE.sub("", line)))


def integer(values: dict[str, str], name: str) -> int:
    value = values.get(name)
    if value is None:
        fail(f"board log is missing {name}")
    try:
        return int(value, 0)
    except ValueError as error:
        raise ConformanceValidationError(f"invalid integer {name}={value}") from error


def exact_line(lines: Iterable[str], marker: str) -> str:
    matches = [line for line in lines if marker in line]
    if len(matches) != 1:
        fail(f"board evidence must contain exactly one {marker} record")
    return matches[0]


def expect_fields(values: dict[str, str], expected: dict[str, str], label: str) -> None:
    mismatches = [
        f"{name}={values.get(name)!r}"
        for name, value in expected.items()
        if values.get(name) != value
    ]
    if mismatches:
        fail(f"{label} has unexpected fields: {', '.join(mismatches)}")


def parse_leases(value: str | None, label: str) -> int:
    if value is None:
        fail(f"{label} is missing leases")
    pieces = value.split("/", 1)
    if len(pieces) != 2:
        fail(f"{label} has malformed leases={value}")
    try:
        taken, released = (int(piece) for piece in pieces)
    except ValueError as error:
        raise ConformanceValidationError(f"{label} has malformed leases={value}") from error
    if taken != EXPECTED_LEASES or released != EXPECTED_LEASES:
        fail(f"{label} has unbalanced or unexpected leases={value}")
    return taken


def validate_board_log(lines: list[str], board: str, board_ipv4: str, peer_ipv4: str) -> tuple[int, int, int]:
    crash_markers = (
        "task_wdt",
        "Guru Meditation",
        "assert failed",
        "abort() was called",
        "POCKET_NET_FORMAL_TLS_FAIL",
    )
    if any(marker in line for marker in crash_markers for line in lines):
        fail("board log contains a crash, watchdog, assertion, or formal failure")

    run = fields(exact_line(lines, "POCKET_NET_FORMAL_TLS_RUN"))
    expect_fields(
        run,
        {
            "status": "ESP_OK",
            "rounds": "20/20",
            "requests": "40/40",
            "frame_calls": "0",
            "shutdown": "1",
            "poison": "0x00000000",
            "core_poison": "0x00000000",
            "poisoned_cores": "0",
            "core_cause": "0",
        },
        "formal run",
    )
    guest_yields = integer(run, "guest_yields")
    elapsed_ms = integer(run, "elapsed_ms")
    if guest_yields <= 0 or elapsed_ms <= 0:
        fail("formal run did not yield cooperatively or report elapsed time")

    if board == "s3":
        contract = fields(exact_line(lines, "POCKET_NET_TLS_CONTRACT"))
        expect_fields(
            contract,
            {
                "valid": "1",
                "https_explicit_opt_in": "1",
                "exact_host_tls_profile": "1",
                "distinct_tls_errors": "1",
                "expected_distinct_tls_errors": "1",
                "public": "0",
                "provider": EXPECTED_PROVIDER,
            },
            "S3 TLS contract",
        )
        boot = fields(exact_line(lines, "POCKET_NET_FORMAL_TLS_BOOT"))
        expect_fields(
            boot,
            {
                "origin": EXPECTED_ORIGIN,
                "peer_ipv4": peer_ipv4,
                "plan_hash": EXPECTED_PLAN,
                "factory_sha256": EXPECTED_FACTORY,
                "ca_der_sha256": EXPECTED_CA,
                "tls_provider": EXPECTED_PROVIDER,
                "public_capability": "0",
                "frame_calls": "0",
            },
            "S3 boot",
        )
        start = fields(exact_line(lines, "POCKET_NET_FORMAL_TLS_START"))
        expect_fields(
            start,
            {
                "origin": EXPECTED_ORIGIN,
                "peer_ipv4": peer_ipv4,
                "rounds": "20",
                "mode": "success",
                "clock_trusted": "1",
            },
            "S3 start",
        )
        result = fields(exact_line(lines, "POCKET_NET_FORMAL_TLS_RESULT"))
        expect_fields(
            result,
            {
                "mode": "success",
                "pass": "1",
                "esp_err": "ESP_OK",
                "rounds": "20/20",
                "requests": "40/40",
                "frame_calls": "0",
                "shutdown": "1",
                "poison": "0x00000000",
                "leases_balanced": "1",
                "queued_leases": "0",
                "taken_leases": "0",
                "runtime_requests": "40",
            },
            "S3 result",
        )
        taken = integer(result, "leases_taken")
        released = integer(result, "leases_released")
        if taken != EXPECTED_LEASES or released != EXPECTED_LEASES:
            fail("S3 result has unbalanced or unexpected body leases")
        got_ip = fields(exact_line(lines, "POCKET_NET_WIFI_GOT_IP"))
        if got_ip.get("ip") != board_ipv4:
            fail("S3 board IP does not match the selected evidence")
        dns = fields(exact_line(lines, "POCKET_NET_DNS_READY"))
        expect_fields(
            dns,
            {
                "hostname": "pocketjs.test",
                "main": peer_ipv4,
                "backup": peer_ipv4,
                "fallback": peer_ipv4,
                "readback": "exact",
            },
            "S3 DNS snapshot",
        )
        return taken, guest_yields, elapsed_ms

    exact_line(lines, "boot: chip revision: v1.3")
    exact_line(lines, "Card init success, TRANSPORT_RX_ACTIVE")
    boot = fields(exact_line(lines, "POCKET_NET_FORMAL_TLS_BOOT"))
    expect_fields(
        boot,
        {
            "board": "tab5-esp32p4",
            "origin": EXPECTED_ORIGIN,
            "peer_ipv4": peer_ipv4,
            "dns_server": peer_ipv4,
            "rounds": "20",
            "requests": "40",
            "test_mode": "success",
            "public_capability": "0",
            "distinct_tls_errors": "1",
            "plan": EXPECTED_PLAN,
            "factory": EXPECTED_FACTORY,
            "ca": EXPECTED_CA,
            "tls_provider": EXPECTED_PROVIDER,
        },
        "P4 boot",
    )
    resource = fields(exact_line(lines, "POCKET_NET_FORMAL_TLS_RESOURCE"))
    expect_fields(
        resource,
        {
            "run_result": "ESP_OK",
            "runtime_slots": "1/1",
            "active": "0",
            "pending": "0",
            "queued": "0",
            "taken": "0",
            "requests_started": "40",
            "leases_taken": str(EXPECTED_LEASES),
            "leases_released": str(EXPECTED_LEASES),
            "poison": "0x00000000",
            "guest_psram_only": "1",
            "shutdown": "1",
        },
        "P4 resource result",
    )
    if integer(resource, "owner_stack_low_water_bytes") <= 0:
        fail("P4 owner task exhausted its stack")
    success = fields(exact_line(lines, "POCKET_NET_FORMAL_TLS_PASS"))
    expect_fields(
        success,
        {
            "board": "tab5-esp32p4",
            "rounds": "20",
            "requests": "40",
            "frame_calls": "0",
            "plan": EXPECTED_PLAN,
            "factory": EXPECTED_FACTORY,
            "ca": EXPECTED_CA,
            "tls_provider": EXPECTED_PROVIDER,
            "shutdown": "1",
            "poison": "0x00000000",
        },
        "P4 pass",
    )
    leases = parse_leases(success.get("leases"), "P4 pass")
    connected = fields(exact_line(lines, "POCKET_NET_WIFI_CONNECTED"))
    if connected.get("ip") != board_ipv4 or connected.get("dns") != peer_ipv4:
        fail("P4 board IP or DNS server does not match the selected evidence")
    power = fields(exact_line(lines, "POCKET_NET_TAB5_C6_POWER"))
    before_dir = integer(power, "before_dir")
    before_out = integer(power, "before_out")
    before_high_z = integer(power, "before_high_z")
    after_dir = integer(power, "after_dir")
    after_out = integer(power, "after_out")
    after_high_z = integer(power, "after_high_z")
    if (
        ((before_dir ^ after_dir) & ~1) != 0
        or ((before_out ^ after_out) & ~1) != 0
        or ((before_high_z ^ after_high_z) & ~1) != 0
        or (after_dir & 1) != 1
        or (after_out & 1) != 1
        or (after_high_z & 1) != 0
    ):
        fail("P4 C6 power expander RMW/readback invariant failed")
    return leases, guest_yields, elapsed_ms


def load_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    previous_ns = -1
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise ConformanceValidationError(f"{path}:{line_number}: invalid NDJSON") from error
        if not isinstance(event, dict):
            fail(f"{path}:{line_number}: event must be an object")
        timestamp = event.get("monotonic_ns")
        if not isinstance(timestamp, int) or timestamp <= previous_ns:
            fail(f"{path}:{line_number}: event clock is missing or out of order")
        previous_ns = timestamp
        events.append(event)
    return events


def one_event(events: list[dict[str, Any]], event_name: str, label: str) -> dict[str, Any]:
    matches = [event for event in events if event.get("event") == event_name]
    if len(matches) != 1:
        fail(f"{label} must contain exactly one {event_name} event")
    return matches[0]


def validate_dns(events: list[dict[str, Any]], board_ipv4: str, peer_ipv4: str) -> list[dict[str, Any]]:
    if {event.get("event") for event in events} - {"dns_ready", "dns_query", "dns_stop"}:
        fail("DNS evidence contains an unexpected event")
    ready = one_event(events, "dns_ready", "DNS evidence")
    stop = one_event(events, "dns_stop", "DNS evidence")
    if (
        ready.get("authoritative_name") != "pocketjs.test"
        or ready.get("authoritative_ipv4") != peer_ipv4
        or ready.get("port") != 53
        or ready.get("interface") != "en1"
        or ready.get("recursion_available") is not False
        or ready.get("transports") != ["udp", "tcp"]
        or stop.get("reason") != "keyboard_interrupt"
    ):
        fail("DNS evidence is not the exact controlled authoritative profile")
    queries = [event for event in events if event.get("event") == "dns_query"]
    if not queries:
        fail("DNS evidence contains no authoritative answer")
    if any(
        event.get("peer_ipv4") != board_ipv4
        or event.get("query_name") != "pocketjs.test"
        or event.get("query_type") != 1
        or event.get("query_class") != 1
        or event.get("outcome") != "answer"
        or event.get("answers") != 1
        or event.get("rcode") != 0
        or event.get("recursion_available") is not False
        for event in queries
    ):
        fail("DNS evidence is not confined to the selected board and hostname")
    return queries


def expected_connection_ids() -> list[int]:
    result: list[int] = []
    for connection_id, length in enumerate(CONNECTION_LENGTHS, 1):
        result.extend([connection_id] * length)
    return result


def validate_wire(events: list[dict[str, Any]], board_ipv4: str) -> tuple[int, int, int]:
    allowed = {
        "peer_ready",
        "tls_client_hello",
        "connection_open",
        "request",
        "connection_close",
        "peer_stop",
    }
    if {event.get("event") for event in events} - allowed:
        fail("TLS evidence contains an unexpected or failed handshake event")
    ready = one_event(events, "peer_ready", "TLS evidence")
    stop = one_event(events, "peer_stop", "TLS evidence")
    if (
        ready.get("transport") != "tls"
        or ready.get("tls_min_version") != "1.2"
        or ready.get("tls_max_version") != "1.2"
        or ready.get("observe_tls_close_notify") is not True
        or not isinstance(ready.get("socket_timeout_ms"), int)
        or int(ready["socket_timeout_ms"]) <= 30_000
        or stop.get("reason") != "keyboard_interrupt"
    ):
        fail("TLS readiness is not the exact TLS 1.2 close-notify profile")

    hellos = [event for event in events if event.get("event") == "tls_client_hello"]
    opens = [event for event in events if event.get("event") == "connection_open"]
    requests = [event for event in events if event.get("event") == "request"]
    closes = [event for event in events if event.get("event") == "connection_close"]
    if len(hellos) != EXPECTED_CONNECTIONS or len(opens) != EXPECTED_CONNECTIONS or len(closes) != EXPECTED_CONNECTIONS:
        fail("TLS connection lifecycle count does not match the conformance artifact")
    if len(requests) != EXPECTED_WIRE_REQUESTS:
        fail(f"wire request count is {len(requests)}; expected {EXPECTED_WIRE_REQUESTS}")
    if any(
        event.get("peer_ipv4") != board_ipv4 or event.get("server_name") != "pocketjs.test"
        for event in hellos
    ):
        fail("ClientHello evidence has the wrong board or SNI")
    if any(
        event.get("peer_ipv4") != board_ipv4
        or event.get("tls_server_name") != "pocketjs.test"
        or event.get("tls_version") != "TLSv1.2"
        or not isinstance(event.get("tls_cipher"), str)
        or not event.get("tls_cipher")
        for event in opens
    ):
        fail("opened connection is not exact TLS 1.2 with pocketjs.test SNI")
    if [event.get("connection_id") for event in opens] != list(range(1, EXPECTED_CONNECTIONS + 1)):
        fail("TLS connection identifiers are missing, reused, or out of order")

    connection_ids = expected_connection_ids()
    next_index = [0] * (EXPECTED_CONNECTIONS + 1)
    for request_id, (event, expected, connection_id) in enumerate(
        zip(requests, EXPECTED_REQUESTS, connection_ids, strict=True), 1
    ):
        next_index[connection_id] += 1
        if (
            event.get("request_id") != request_id
            or event.get("connection_id") != connection_id
            or event.get("connection_request_index") != next_index[connection_id]
            or event.get("method") != expected.method
            or event.get("path") != expected.path
            or event.get("query_names") != list(expected.query_names)
            or event.get("body_bytes") != expected.body_bytes
            or event.get("header_names") != list(expected.header_names)
        ):
            fail(f"wire request {request_id} does not match the exact conformance sequence")

    close_notify = 0
    for connection_id, (event, expected_requests) in enumerate(zip(closes, CONNECTION_LENGTHS, strict=True), 1):
        graceful = connection_id in GRACEFUL_CONNECTIONS
        if (
            event.get("connection_id") != connection_id
            or event.get("requests") != expected_requests
            or event.get("tls_close_notify_observed") is not graceful
            or event.get("tls_close_state") != ("close_notify" if graceful else "not_observed")
        ):
            fail(f"connection {connection_id} close/reuse semantics do not match the matrix")
        close_notify += int(graceful)
    return len(requests), len(opens), close_notify


def analyze(
    *,
    board: str,
    board_log: Path,
    tls_events_path: Path,
    dns_events_path: Path,
    board_ipv4: str,
    peer_ipv4: str,
) -> ConformanceSummary:
    lines = board_log.read_text(errors="replace").splitlines()
    leases, guest_yields, elapsed_ms = validate_board_log(lines, board, board_ipv4, peer_ipv4)
    tls_events = load_events(tls_events_path)
    dns_events = load_events(dns_events_path)
    dns_queries = validate_dns(dns_events, board_ipv4, peer_ipv4)
    wire_requests, connections, close_notify = validate_wire(tls_events, board_ipv4)
    first_dns = dns_queries[0]["monotonic_ns"]
    first_hello = next(event["monotonic_ns"] for event in tls_events if event.get("event") == "tls_client_hello")
    last_close = next(event["monotonic_ns"] for event in reversed(tls_events) if event.get("event") == "connection_close")
    if not (
        dns_events[0]["monotonic_ns"] < first_dns < first_hello
        and last_close < tls_events[-1]["monotonic_ns"]
        and last_close < dns_events[-1]["monotonic_ns"]
    ):
        fail("DNS, TLS, and stop evidence is stale, incomplete, or out of order")
    return ConformanceSummary(
        board=board,
        board_ipv4=board_ipv4,
        guest_operations=EXPECTED_GUEST_OPERATIONS,
        wire_requests=wire_requests,
        tls_connections=connections,
        close_notify_connections=close_notify,
        forced_close_connections=connections - close_notify,
        dns_answers=len(dns_queries),
        maximum_requests_per_connection=max(CONNECTION_LENGTHS),
        leases=leases,
        guest_yields=guest_yields,
        elapsed_ms=elapsed_ms,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate one PocketJS ESP Phase 1B TLS/HTTP conformance run"
    )
    parser.add_argument("--board", choices=("s3", "p4"), required=True)
    parser.add_argument("--board-log", type=Path, required=True)
    parser.add_argument("--tls-events", type=Path, required=True)
    parser.add_argument("--dns-events", type=Path, required=True)
    parser.add_argument("--board-ipv4", required=True)
    parser.add_argument("--peer-ipv4", required=True)
    args = parser.parse_args()
    try:
        summary = analyze(
            board=args.board,
            board_log=args.board_log,
            tls_events_path=args.tls_events,
            dns_events_path=args.dns_events,
            board_ipv4=args.board_ipv4,
            peer_ipv4=args.peer_ipv4,
        )
    except (OSError, ConformanceValidationError) as error:
        parser.exit(1, f"phase1b conformance failed: {error}\n")
    print(json.dumps(asdict(summary), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
