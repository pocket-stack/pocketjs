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
REQUESTS_PER_RUN = 40


class SoakValidationError(ValueError):
    pass


@dataclass(frozen=True)
class ResourceSample:
    internal_before: int
    internal_after: int
    internal_minimum: int
    psram_before: int
    psram_after: int
    psram_minimum: int


@dataclass(frozen=True)
class SoakSummary:
    board_ipv4: str
    runs: int
    requests: int
    duration_seconds: float
    internal_peak_bytes: int
    psram_peak_bytes: int
    steady_internal_drift_bytes: int
    steady_psram_drift_bytes: int
    tls_connections: int
    close_notify_connections: int
    minimum_guest_yields: int


def fail(message: str) -> None:
    raise SoakValidationError(message)


def fields(line: str) -> dict[str, str]:
    return dict(KEY_VALUE.findall(ANSI_ESCAPE.sub("", line)))


def integer(values: dict[str, str], name: str) -> int:
    value = values.get(name)
    if value is None:
        fail(f"board log is missing {name}")
    try:
        return int(value, 0)
    except ValueError as error:
        raise SoakValidationError(f"invalid integer {name}={value}") from error


def load_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError as error:
            raise SoakValidationError(
                f"{path}:{line_number}: invalid NDJSON"
            ) from error
        if not isinstance(event, dict):
            fail(f"{path}:{line_number}: event must be an object")
        events.append(event)
    return events


def parse_s3_resources(lines: Iterable[str]) -> list[ResourceSample]:
    before: dict[str, str] | None = None
    samples: list[ResourceSample] = []
    for line in lines:
        if "POCKET_NET_RESOURCE phase=formal_before" in line:
            if before is not None:
                fail("S3 resource log has two formal_before records")
            before = fields(line)
        elif "POCKET_NET_RESOURCE phase=formal_after" in line:
            if before is None:
                fail("S3 formal_after has no matching formal_before")
            after = fields(line)
            samples.append(
                ResourceSample(
                    internal_before=integer(before, "internal_free"),
                    internal_after=integer(after, "internal_free"),
                    internal_minimum=integer(after, "internal_min"),
                    psram_before=integer(before, "psram_free"),
                    psram_after=integer(after, "psram_free"),
                    psram_minimum=integer(after, "psram_min"),
                )
            )
            before = None
    if before is not None:
        fail("S3 final formal_before has no matching formal_after")
    return samples


def parse_p4_resources(lines: Iterable[str]) -> list[ResourceSample]:
    samples: list[ResourceSample] = []
    for line in lines:
        if "POCKET_NET_FORMAL_TLS_RESOURCE" not in line:
            continue
        values = fields(line)
        samples.append(
            ResourceSample(
                internal_before=integer(values, "internal_before"),
                internal_after=integer(values, "internal_after"),
                internal_minimum=integer(values, "internal_min"),
                psram_before=integer(values, "psram_before"),
                psram_after=integer(values, "psram_after"),
                psram_minimum=integer(values, "psram_min"),
            )
        )
    return samples


def successful_run_lines(lines: Iterable[str], board: str) -> list[str]:
    if board == "s3":
        result = [
            line
            for line in lines
            if "POCKET_NET_FORMAL_TLS_RESULT" in line
            and "mode=success" in line
            and "pass=1" in line
        ]
        for line in result:
            values = fields(line)
            if (
                values.get("rounds") != "20/20"
                or values.get("requests") != "40/40"
                or values.get("shutdown") != "1"
                or values.get("poison") != "0x00000000"
                or values.get("leases_balanced") != "1"
            ):
                fail(f"invalid S3 success record: {line.strip()}")
        return result

    result = [line for line in lines if "POCKET_NET_FORMAL_TLS_PASS" in line]
    for line in result:
        values = fields(line)
        if (
            values.get("rounds") != "20"
            or values.get("requests") != "40"
            or values.get("shutdown") != "1"
            or values.get("poison") != "0x00000000"
            or values.get("leases") != "40/40"
        ):
            fail(f"invalid P4 success record: {line.strip()}")
    return result


def validate_connection_requests(
    requests: list[dict[str, Any]], connection_id: object
) -> None:
    connection_requests = [
        event for event in requests if event.get("connection_id") == connection_id
    ]
    if len(connection_requests) != REQUESTS_PER_RUN:
        fail(f"connection {connection_id} carried {len(connection_requests)} requests")
    for expected_index, event in enumerate(connection_requests, 1):
        expected_health = expected_index % 2 == 1
        expected_headers = (
            ["accept-encoding", "host"]
            if expected_health
            else ["accept-encoding", "host", "transfer-encoding"]
        )
        if (
            event.get("connection_request_index") != expected_index
            or event.get("method") != ("GET" if expected_health else "POST")
            or event.get("path") != ("/health" if expected_health else "/echo")
            or event.get("body_bytes") != (0 if expected_health else 12)
            or event.get("query_names") != []
            or event.get("header_names") != expected_headers
        ):
            fail(
                f"connection {connection_id} request {expected_index} "
                "does not match the exact health/streamed-echo sequence"
            )


def analyze(
    *,
    board: str,
    board_log: Path,
    tls_events_path: Path,
    dns_events_path: Path,
    board_ipv4: str,
    peer_ipv4: str,
    minimum_duration_seconds: float,
    minimum_runs: int,
    max_internal_peak_bytes: int,
    max_psram_peak_bytes: int,
    max_internal_drift_bytes: int,
    max_psram_drift_bytes: int,
) -> SoakSummary:
    lines = board_log.read_text(errors="replace").splitlines()
    if any("task_wdt" in line for line in lines):
        fail("board log contains a task watchdog report")
    if any("POCKET_NET_FORMAL_TLS_FAIL" in line for line in lines):
        fail("board log contains POCKET_NET_FORMAL_TLS_FAIL")
    successes = successful_run_lines(lines, board)
    if len(successes) < minimum_runs:
        fail(f"only {len(successes)} successful runs; need {minimum_runs}")
    guest_yields = [integer(fields(line), "guest_yields") for line in successes]
    if any(value == 0 for value in guest_yields):
        fail("a successful run did not cooperatively yield the Guest owner task")

    resources = (
        parse_s3_resources(lines) if board == "s3" else parse_p4_resources(lines)
    )
    if len(resources) != len(successes):
        fail(
            f"resource samples ({len(resources)}) do not match successful runs "
            f"({len(successes)})"
        )

    tls_events = load_events(tls_events_path)
    dns_events = load_events(dns_events_path)
    ready = [event for event in tls_events if event.get("event") == "peer_ready"]
    if len(ready) != 1 or not isinstance(ready[0].get("socket_timeout_ms"), int):
        fail("TLS evidence must contain one peer timeout snapshot")
    if int(ready[0]["socket_timeout_ms"]) <= 30_000:
        fail("peer socket timeout must exceed the 30-second client deadline")
    if (
        ready[0].get("transport") != "tls"
        or ready[0].get("tls_min_version") != "1.2"
        or ready[0].get("tls_max_version") != "1.2"
        or ready[0].get("observe_tls_close_notify") is not True
    ):
        fail("peer readiness is not the exact TLS 1.2 close-notify profile")
    dns_ready = [event for event in dns_events if event.get("event") == "dns_ready"]
    if (
        len(dns_ready) != 1
        or dns_ready[0].get("authoritative_name") != "pocketjs.test"
        or dns_ready[0].get("authoritative_ipv4") != peer_ipv4
        or dns_ready[0].get("port") != 53
        or dns_ready[0].get("interface") != "en1"
        or dns_ready[0].get("recursion_available") is not False
        or dns_ready[0].get("transports") != ["udp", "tcp"]
    ):
        fail("DNS readiness is not the exact controlled authoritative profile")
    answers = [
        event
        for event in dns_events
        if event.get("event") == "dns_query" and event.get("outcome") == "answer"
    ]
    if not answers:
        fail("no authoritative DNS answer was recorded")
    if any(
        event.get("peer_ipv4") != board_ipv4
        or event.get("query_name") != "pocketjs.test"
        or event.get("query_type") != 1
        or event.get("query_class") != 1
        or event.get("answers") != 1
        or event.get("rcode") != 0
        or event.get("recursion_available") is not False
        for event in answers
    ):
        fail("DNS evidence is not confined to the selected board and hostname")

    hellos = [event for event in tls_events if event.get("event") == "tls_client_hello"]
    opens = [event for event in tls_events if event.get("event") == "connection_open"]
    requests = [event for event in tls_events if event.get("event") == "request"]
    closes = [event for event in tls_events if event.get("event") == "connection_close"]
    handshake_errors = [
        event for event in tls_events if event.get("event") == "tls_handshake_error"
    ]
    runs = len(successes)
    if handshake_errors:
        fail("positive soak contains a TLS handshake error")
    if len(hellos) != runs or len(opens) != runs or len(closes) != runs:
        fail(
            "successful runs and TLS connection lifecycle counts differ: "
            f"runs={runs} hellos={len(hellos)} opens={len(opens)} closes={len(closes)}"
        )
    if len(requests) != runs * REQUESTS_PER_RUN:
        fail(f"received {len(requests)} requests; expected {runs * REQUESTS_PER_RUN}")
    if any(
        event.get("peer_ipv4") != board_ipv4
        or event.get("server_name") != "pocketjs.test"
        for event in hellos
    ):
        fail("ClientHello evidence has the wrong peer or SNI")
    if any(
        event.get("peer_ipv4") != board_ipv4
        or event.get("tls_server_name") != "pocketjs.test"
        or event.get("tls_version") != "TLSv1.2"
        for event in opens
    ):
        fail("opened connection is not exact TLS 1.2 with pocketjs.test SNI")
    if any(
        event.get("tls_close_state") != "close_notify"
        or event.get("tls_close_notify_observed") is not True
        or event.get("requests") != REQUESTS_PER_RUN
        for event in closes
    ):
        fail("connection did not end with close_notify after 40 requests")

    connection_ids = {event.get("connection_id") for event in opens}
    if None in connection_ids or len(connection_ids) != runs:
        fail("connection identifiers are missing or reused")
    for connection_id in connection_ids:
        validate_connection_requests(requests, connection_id)

    first_ns = min(int(event["monotonic_ns"]) for event in hellos)
    last_ns = max(int(event["monotonic_ns"]) for event in closes)
    duration_seconds = (last_ns - first_ns) / 1_000_000_000
    if duration_seconds < minimum_duration_seconds:
        fail(
            f"wire duration {duration_seconds:.3f}s is below "
            f"{minimum_duration_seconds:.3f}s"
        )

    initial = resources[0]
    internal_peak = initial.internal_before - min(
        sample.internal_minimum for sample in resources
    )
    psram_peak = initial.psram_before - min(sample.psram_minimum for sample in resources)
    if internal_peak < 0 or internal_peak > max_internal_peak_bytes:
        fail(f"internal peak {internal_peak} exceeds {max_internal_peak_bytes}")
    if psram_peak < 0 or psram_peak > max_psram_peak_bytes:
        fail(f"PSRAM peak {psram_peak} exceeds {max_psram_peak_bytes}")

    steady_internal = resources[0].internal_after
    steady_psram = resources[0].psram_after
    internal_drift = (
        max(0, steady_internal - min(sample.internal_after for sample in resources[1:]))
        if len(resources) > 1
        else 0
    )
    psram_drift = (
        max(0, steady_psram - min(sample.psram_after for sample in resources[1:]))
        if len(resources) > 1
        else 0
    )
    if internal_drift > max_internal_drift_bytes:
        fail(f"steady internal drift {internal_drift} exceeds {max_internal_drift_bytes}")
    if psram_drift > max_psram_drift_bytes:
        fail(f"steady PSRAM drift {psram_drift} exceeds {max_psram_drift_bytes}")

    return SoakSummary(
        board_ipv4=board_ipv4,
        runs=runs,
        requests=len(requests),
        duration_seconds=duration_seconds,
        internal_peak_bytes=internal_peak,
        psram_peak_bytes=psram_peak,
        steady_internal_drift_bytes=internal_drift,
        steady_psram_drift_bytes=psram_drift,
        tls_connections=len(opens),
        close_notify_connections=len(closes),
        minimum_guest_yields=min(guest_yields),
    )


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return parsed


def nonnegative_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be nonnegative")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate the PocketJS ESP Phase 1B repeated-handshake soak"
    )
    parser.add_argument("--board", choices=("s3", "p4"), required=True)
    parser.add_argument("--board-log", type=Path, required=True)
    parser.add_argument("--tls-events", type=Path, required=True)
    parser.add_argument("--dns-events", type=Path, required=True)
    parser.add_argument("--board-ipv4", required=True)
    parser.add_argument("--peer-ipv4", required=True)
    parser.add_argument("--minimum-duration-seconds", type=float, default=900.0)
    parser.add_argument("--minimum-runs", type=positive_integer, default=2)
    parser.add_argument("--max-internal-peak-bytes", type=positive_integer, default=65536)
    parser.add_argument("--max-psram-peak-bytes", type=positive_integer, default=4194304)
    parser.add_argument("--max-internal-drift-bytes", type=nonnegative_integer, default=16384)
    parser.add_argument("--max-psram-drift-bytes", type=nonnegative_integer, default=4096)
    args = parser.parse_args()
    if args.minimum_duration_seconds <= 0:
        parser.error("--minimum-duration-seconds must be positive")
    try:
        summary = analyze(
            board=args.board,
            board_log=args.board_log,
            tls_events_path=args.tls_events,
            dns_events_path=args.dns_events,
            board_ipv4=args.board_ipv4,
            peer_ipv4=args.peer_ipv4,
            minimum_duration_seconds=args.minimum_duration_seconds,
            minimum_runs=args.minimum_runs,
            max_internal_peak_bytes=args.max_internal_peak_bytes,
            max_psram_peak_bytes=args.max_psram_peak_bytes,
            max_internal_drift_bytes=args.max_internal_drift_bytes,
            max_psram_drift_bytes=args.max_psram_drift_bytes,
        )
    except (OSError, SoakValidationError) as error:
        parser.exit(1, f"phase1b soak failed: {error}\n")
    print(json.dumps(asdict(summary), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
