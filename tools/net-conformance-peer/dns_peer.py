#!/usr/bin/env python3
"""Bounded authoritative DNS fixture for PocketJS LAN TLS tests."""

from __future__ import annotations

import argparse
import errno
import ipaddress
import json
import os
import socket
import stat
import struct
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Callable


DNS_HEADER_BYTES = 12
MAX_DNS_MESSAGE_BYTES = 1232
MAX_TCP_BACKLOG = 8
MAX_TTL_SECONDS = (1 << 31) - 1
MAX_SOCKET_TIMEOUT_MS = 10_000
TYPE_A = 1
TYPE_OPT = 41
CLASS_IN = 1
RCODE_NOERROR = 0
RCODE_FORMERR = 1
RCODE_NXDOMAIN = 3
RCODE_NOTIMP = 4
RCODE_REFUSED = 5
RCODE_BADVERS = 16
FLAG_QR = 0x8000
FLAG_OPCODE = 0x7800
FLAG_AA = 0x0400
FLAG_TC = 0x0200
FLAG_RD = 0x0100
FLAG_RA = 0x0080
FLAG_RESERVED_Z = 0x0040
EDNS_DO = 0x8000
DARWIN_IP_BOUND_IF = 25
CONTROLLED_SOURCE_SUPERNETS = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
    ipaddress.IPv4Network("127.0.0.0/8"),
)


class DnsParseError(Exception):
    def __init__(self, reason: str, *, respond: bool = True) -> None:
        super().__init__(reason)
        self.reason = reason
        self.respond = respond


@dataclass(frozen=True)
class EdnsRequest:
    udp_payload_bytes: int
    version: int
    dnssec_ok: bool
    option_count: int


@dataclass(frozen=True)
class DnsQuery:
    transaction_id: int
    flags: int
    opcode: int
    name: str
    query_type: int
    query_class: int
    question_wire: bytes
    edns: EdnsRequest | None

    @property
    def recursion_desired(self) -> bool:
        return bool(self.flags & FLAG_RD)


@dataclass(frozen=True)
class DnsDecision:
    outcome: str
    rcode: int
    authoritative: bool
    include_answer: bool = False


class EventSink:
    def __init__(self, path: Path | None, quiet: bool) -> None:
        self._lock = threading.Lock()
        self._quiet = quiet
        self._file: BinaryIO | None = (
            open_private_event_file(path) if path is not None else None
        )

    def emit(self, event: str, **fields: object) -> None:
        record = {
            "event": event,
            "monotonic_ns": time.monotonic_ns(),
            **fields,
        }
        encoded = (
            json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        ).encode()
        with self._lock:
            if not self._quiet:
                sys.stdout.buffer.write(encoded)
                sys.stdout.buffer.flush()
            if self._file is not None:
                self._file.write(encoded)
                self._file.flush()

    def close(self) -> None:
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None


def open_private_event_file(path: Path) -> BinaryIO:
    no_follow = getattr(os, "O_NOFOLLOW", None)
    if no_follow is None:
        raise OSError(
            errno.ENOTSUP,
            "secure event files require O_NOFOLLOW on this platform",
        )
    flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | no_follow
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError(errno.EINVAL, "DNS event path is not a regular file")
        if hasattr(os, "geteuid") and metadata.st_uid != os.geteuid():
            raise PermissionError("DNS event file is not owned by the current user")
        if stat.S_IMODE(metadata.st_mode) & 0o077:
            raise PermissionError("DNS event file grants group or other permissions")
        return os.fdopen(descriptor, "ab")
    except BaseException:
        os.close(descriptor)
        raise


def canonical_dns_name(value: str) -> str:
    name = value.rstrip(".").lower()
    if not name:
        raise ValueError("DNS name must not be the root name")
    try:
        encoded = name.encode("ascii")
    except UnicodeEncodeError as error:
        raise ValueError("DNS name must already be an ASCII A-label") from error
    if len(encoded) > 253:
        raise ValueError("DNS name exceeds 253 bytes")
    for label in encoded.split(b"."):
        validate_hostname_label(label)
    return name


def validate_hostname_label(label: bytes) -> None:
    if not 1 <= len(label) <= 63:
        raise ValueError("DNS labels must contain 1 to 63 bytes")
    if not is_ascii_alphanumeric(label[0]) or not is_ascii_alphanumeric(label[-1]):
        raise ValueError("DNS hostname labels must start and end with alphanumeric bytes")
    if any(not is_ascii_alphanumeric(byte) and byte != ord("-") for byte in label):
        raise ValueError("DNS hostname labels may contain only ASCII letters, digits, and '-'")


def is_ascii_alphanumeric(value: int) -> bool:
    return ord("0") <= value <= ord("9") or ord("A") <= value <= ord("Z") or ord(
        "a"
    ) <= value <= ord("z")


def parse_qname(message: bytes, offset: int) -> tuple[str, int]:
    labels: list[bytes] = []
    wire_bytes = 1
    while True:
        if offset >= len(message):
            raise DnsParseError("truncated_qname")
        label_length = message[offset]
        offset += 1
        if label_length == 0:
            break
        if label_length & 0xC0:
            raise DnsParseError("compressed_qname_not_allowed")
        if label_length > 63 or offset + label_length > len(message):
            raise DnsParseError("invalid_qname_label")
        label = message[offset : offset + label_length]
        try:
            validate_hostname_label(label)
        except ValueError as error:
            raise DnsParseError("invalid_hostname_label") from error
        labels.append(label.lower())
        offset += label_length
        wire_bytes += label_length + 1
        if wire_bytes > 255:
            raise DnsParseError("qname_too_long")
    return b".".join(labels).decode("ascii"), offset


def parse_edns(message: bytes, offset: int) -> tuple[EdnsRequest, int]:
    if offset >= len(message) or message[offset] != 0:
        raise DnsParseError("edns_owner_must_be_root")
    offset += 1
    if offset + 10 > len(message):
        raise DnsParseError("truncated_edns_record")
    record_type, udp_payload, ttl, data_length = struct.unpack_from(
        "!HHIH", message, offset
    )
    offset += 10
    if record_type != TYPE_OPT:
        raise DnsParseError("additional_record_must_be_opt")
    if ttl >> 24:
        raise DnsParseError("edns_query_extended_rcode_must_be_zero")
    version = (ttl >> 16) & 0xFF
    edns_flags = ttl & 0xFFFF
    if edns_flags & ~EDNS_DO:
        raise DnsParseError("edns_reserved_flags_nonzero")
    end = offset + data_length
    if end > len(message):
        raise DnsParseError("truncated_edns_options")
    option_count = 0
    while offset < end:
        if offset + 4 > end:
            raise DnsParseError("truncated_edns_option_header")
        _, option_length = struct.unpack_from("!HH", message, offset)
        offset += 4
        if offset + option_length > end:
            raise DnsParseError("truncated_edns_option_data")
        offset += option_length
        option_count += 1
    return (
        EdnsRequest(
            udp_payload_bytes=max(512, min(udp_payload, MAX_DNS_MESSAGE_BYTES)),
            version=version,
            dnssec_ok=bool(edns_flags & EDNS_DO),
            option_count=option_count,
        ),
        offset,
    )


def parse_query(message: bytes) -> DnsQuery:
    if len(message) < DNS_HEADER_BYTES:
        raise DnsParseError("message_too_short", respond=False)
    transaction_id, flags, question_count, answer_count, authority_count, additional_count = (
        struct.unpack_from("!HHHHHH", message)
    )
    if flags & FLAG_QR:
        raise DnsParseError("response_message_not_accepted", respond=False)
    if flags & FLAG_TC:
        raise DnsParseError("truncated_query_not_accepted")
    if flags & FLAG_RESERVED_Z:
        raise DnsParseError("reserved_header_flag_nonzero")
    if flags & 0x000F:
        raise DnsParseError("query_rcode_must_be_zero")
    if question_count != 1:
        raise DnsParseError("exactly_one_question_required")
    if answer_count or authority_count or additional_count > 1:
        raise DnsParseError("unexpected_query_sections")

    offset = DNS_HEADER_BYTES
    name, offset = parse_qname(message, offset)
    if offset + 4 > len(message):
        raise DnsParseError("truncated_question")
    query_type, query_class = struct.unpack_from("!HH", message, offset)
    offset += 4
    question_wire = message[DNS_HEADER_BYTES:offset]

    edns = None
    if additional_count:
        edns, offset = parse_edns(message, offset)
    if offset != len(message):
        raise DnsParseError("trailing_query_bytes")

    return DnsQuery(
        transaction_id=transaction_id,
        flags=flags,
        opcode=(flags & FLAG_OPCODE) >> 11,
        name=name,
        query_type=query_type,
        query_class=query_class,
        question_wire=question_wire,
        edns=edns,
    )


def decide_query(query: DnsQuery, authoritative_name: str) -> DnsDecision:
    if query.opcode != 0:
        return DnsDecision("not_implemented", RCODE_NOTIMP, False)
    if query.edns is not None and query.edns.version != 0:
        return DnsDecision("bad_edns_version", RCODE_BADVERS, False)
    if query.query_class != CLASS_IN:
        return DnsDecision("refused_class", RCODE_REFUSED, False)
    if query.name == authoritative_name:
        if query.query_type == TYPE_A:
            return DnsDecision("answer", RCODE_NOERROR, True, True)
        return DnsDecision("refused_type", RCODE_REFUSED, False)
    if query.name.endswith(f".{authoritative_name}"):
        return DnsDecision("nxdomain", RCODE_NXDOMAIN, True)
    return DnsDecision("refused_name", RCODE_REFUSED, False)


def build_response(
    query: DnsQuery,
    decision: DnsDecision,
    address: ipaddress.IPv4Address,
    ttl_seconds: int,
) -> bytes:
    response_flags = FLAG_QR | (query.flags & (FLAG_OPCODE | FLAG_RD))
    if decision.authoritative:
        response_flags |= FLAG_AA
    response_flags |= decision.rcode & 0xF
    include_edns = query.edns is not None
    header = struct.pack(
        "!HHHHHH",
        query.transaction_id,
        response_flags,
        1,
        1 if decision.include_answer else 0,
        0,
        1 if include_edns else 0,
    )
    answer = b""
    if decision.include_answer:
        answer = struct.pack(
            "!HHHIH4s",
            0xC00C,
            TYPE_A,
            CLASS_IN,
            ttl_seconds,
            4,
            address.packed,
        )
    opt = b""
    if query.edns is not None:
        extended_rcode = decision.rcode >> 4
        opt_ttl = extended_rcode << 24
        opt = struct.pack(
            "!BHHIH",
            0,
            TYPE_OPT,
            query.edns.udp_payload_bytes,
            opt_ttl,
            0,
        )
    response = header + query.question_wire + answer + opt
    if len(response) > MAX_DNS_MESSAGE_BYTES:
        raise RuntimeError("bounded DNS response exceeded the hard message limit")
    return response


def build_format_error(message: bytes) -> bytes | None:
    if len(message) < DNS_HEADER_BYTES:
        return None
    transaction_id, flags = struct.unpack_from("!HH", message)
    if flags & FLAG_QR:
        return None
    response_flags = FLAG_QR | (flags & (FLAG_OPCODE | FLAG_RD)) | RCODE_FORMERR
    return struct.pack("!HHHHHH", transaction_id, response_flags, 0, 0, 0, 0)


def parse_allow_cidr(value: str) -> ipaddress.IPv4Network:
    try:
        network = ipaddress.ip_network(value, strict=False)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error
    if not isinstance(network, ipaddress.IPv4Network):
        raise argparse.ArgumentTypeError("only IPv4 allow CIDRs are supported")
    try:
        validate_controlled_source_network(network)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from error
    return network


def validate_controlled_source_network(network: ipaddress.IPv4Network) -> None:
    if not isinstance(network, ipaddress.IPv4Network):
        raise ValueError("only IPv4 source CIDRs are supported")
    if not any(network.subnet_of(supernet) for supernet in CONTROLLED_SOURCE_SUPERNETS):
        raise ValueError(
            f"source CIDR {network} is outside RFC1918 and loopback ranges"
        )


def parse_bind_host(value: str) -> str:
    try:
        return str(ipaddress.IPv4Address(value))
    except ipaddress.AddressValueError as error:
        raise argparse.ArgumentTypeError(
            "bind host must be an IPv4 address literal"
        ) from error


def apply_interface_constraint(sock: socket.socket, interface: str | None) -> str:
    if interface is None:
        return "none"
    interface_index = socket.if_nametoindex(interface)
    if sys.platform == "darwin":
        sock.setsockopt(socket.IPPROTO_IP, DARWIN_IP_BOUND_IF, interface_index)
        return "darwin-ip-bound-if"
    bind_to_device = getattr(socket, "SO_BINDTODEVICE", None)
    if bind_to_device is not None:
        sock.setsockopt(socket.SOL_SOCKET, bind_to_device, interface.encode() + b"\0")
        return "so-bind-to-device"
    raise OSError(
        errno.ENOTSUP,
        f"interface binding is unsupported on {sys.platform}; refusing to start",
    )


def make_socket(
    socket_type: int,
    bind_host: str,
    port: int,
    interface: str | None,
) -> tuple[socket.socket, str]:
    sock = socket.socket(socket.AF_INET, socket_type)
    try:
        if socket_type == socket.SOCK_STREAM:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        interface_mode = apply_interface_constraint(sock, interface)
        sock.bind((bind_host, port))
        return sock, interface_mode
    except BaseException:
        sock.close()
        raise


class DnsPeerServer:
    def __init__(
        self,
        address: tuple[str, int],
        *,
        authoritative_name: str,
        authoritative_address: ipaddress.IPv4Address,
        ttl_seconds: int,
        allowed_networks: tuple[ipaddress.IPv4Network, ...],
        interface: str | None,
        socket_timeout_ms: int,
        events: EventSink,
    ) -> None:
        if not allowed_networks:
            raise ValueError("at least one source allow CIDR is required")
        for network in allowed_networks:
            validate_controlled_source_network(network)
        if not 1 <= ttl_seconds <= MAX_TTL_SECONDS:
            raise ValueError(f"DNS TTL must be between 1 and {MAX_TTL_SECONDS}")
        if not 1 <= socket_timeout_ms <= MAX_SOCKET_TIMEOUT_MS:
            raise ValueError(
                f"DNS socket timeout must be between 1 and {MAX_SOCKET_TIMEOUT_MS} ms"
            )
        self.authoritative_name = canonical_dns_name(authoritative_name)
        self.authoritative_address = authoritative_address
        self.ttl_seconds = ttl_seconds
        self.allowed_networks = allowed_networks
        self.interface = interface
        self.socket_timeout = socket_timeout_ms / 1000
        self.events = events
        self._stop = threading.Event()
        self._close_lock = threading.Lock()
        self._failure_lock = threading.Lock()
        self._active_tcp_lock = threading.Lock()
        self._closed = False
        self._fatal_error: tuple[str, str] | None = None
        self._active_tcp: socket.socket | None = None

        bind_address = ipaddress.IPv4Address(address[0])
        bind_host = str(bind_address)
        requested_port = address[1]
        if sys.platform == "darwin" and bind_address.is_unspecified and not interface:
            raise ValueError(
                "a Darwin wildcard bind requires --interface; use --interface en1 "
                "for the controlled Wi-Fi fixture"
            )
        self._tcp, interface_mode = make_socket(
            socket.SOCK_STREAM, bind_host, requested_port, interface
        )
        try:
            self._tcp.listen(MAX_TCP_BACKLOG)
            actual_port = int(self._tcp.getsockname()[1])
            self._udp, udp_interface_mode = make_socket(
                socket.SOCK_DGRAM, bind_host, actual_port, interface
            )
        except BaseException:
            self._tcp.close()
            raise
        if interface_mode != udp_interface_mode:
            self._tcp.close()
            self._udp.close()
            raise RuntimeError("UDP and TCP interface constraints differ")
        self.interface_mode = interface_mode
        self.server_address = (str(self._tcp.getsockname()[0]), actual_port)
        self._tcp.settimeout(0.1)
        self._udp.settimeout(0.1)

    def source_allowed(self, source_ipv4: str) -> bool:
        address = ipaddress.IPv4Address(source_ipv4)
        return any(address in network for network in self.allowed_networks)

    def serve_forever(self) -> None:
        self.events.emit(
            "dns_ready",
            bind_host=self.server_address[0],
            port=self.server_address[1],
            interface=self.interface,
            interface_mode=self.interface_mode,
            allow_cidrs=[str(network) for network in self.allowed_networks],
            authoritative_name=self.authoritative_name,
            authoritative_ipv4=str(self.authoritative_address),
            max_message_bytes=MAX_DNS_MESSAGE_BYTES,
            recursion_available=False,
            transports=["udp", "tcp"],
        )
        workers = (
            threading.Thread(
                target=self._run_worker,
                args=("udp", self._udp_loop),
                name="dns-peer-udp",
                daemon=True,
            ),
            threading.Thread(
                target=self._run_worker,
                args=("tcp", self._tcp_loop),
                name="dns-peer-tcp",
                daemon=True,
            ),
        )
        started_workers: list[threading.Thread] = []
        try:
            for worker in workers:
                try:
                    worker.start()
                except BaseException:
                    if worker.ident is not None:
                        started_workers.append(worker)
                    raise
                else:
                    started_workers.append(worker)
            self._stop.wait()
        finally:
            self._stop.set()
            self.server_close()
            for worker in started_workers:
                worker.join(timeout=2)
            alive_workers = [
                worker.name for worker in started_workers if worker.is_alive()
            ]
            if alive_workers:
                raise RuntimeError(
                    f"DNS workers did not stop: {','.join(alive_workers)}"
                )
        if self._fatal_error is not None:
            transport, error_name = self._fatal_error
            raise RuntimeError(f"DNS {transport} worker failed with {error_name}")

    def shutdown(self) -> None:
        self._stop.set()
        self.server_close()

    def server_close(self) -> None:
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            self._tcp.close()
            self._udp.close()

            with self._active_tcp_lock:
                active_tcp = self._active_tcp
            if active_tcp is not None:
                try:
                    active_tcp.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                active_tcp.close()

    def _run_worker(self, transport: str, worker: Callable[[], None]) -> None:
        try:
            worker()
        except BaseException as error:
            if self._stop.is_set():
                return
            self.record_fatal_error(transport, error)

    def record_fatal_error(self, transport: str, error: BaseException) -> None:
        error_name = type(error).__name__
        with self._failure_lock:
            if self._fatal_error is None:
                self._fatal_error = (transport, error_name)
        self._stop.set()
        try:
            self.events.emit(
                "dns_internal_error",
                transport=transport,
                error=error_name,
            )
        except BaseException:
            pass

    def _udp_loop(self) -> None:
        while not self._stop.is_set():
            try:
                message, source = self._udp.recvfrom(MAX_DNS_MESSAGE_BYTES + 1)
            except socket.timeout:
                continue
            except OSError as error:
                if self._stop.is_set():
                    return
                raise error
            response = self._handle_message(message, source[0], "udp")
            if response is not None:
                try:
                    self._udp.sendto(response, source)
                except OSError as error:
                    self.events.emit(
                        "dns_send_error",
                        transport="udp",
                        peer_ipv4=source[0],
                        error=type(error).__name__,
                    )

    def _tcp_loop(self) -> None:
        while not self._stop.is_set():
            try:
                connection, source = self._tcp.accept()
            except socket.timeout:
                continue
            except OSError as error:
                if self._stop.is_set():
                    return
                raise error
            with self._active_tcp_lock:
                if self._stop.is_set():
                    connection.close()
                    return
                self._active_tcp = connection
            try:
                with connection:
                    if not self.source_allowed(source[0]):
                        self.events.emit(
                            "dns_drop",
                            transport="tcp",
                            peer_ipv4=source[0],
                            reason="source_not_allowed",
                        )
                        continue
                    try:
                        deadline = time.monotonic() + self.socket_timeout
                        length_bytes = receive_exact(
                            connection, 2, deadline, self._stop
                        )
                        message_length = struct.unpack("!H", length_bytes)[0]
                        if not DNS_HEADER_BYTES <= message_length <= MAX_DNS_MESSAGE_BYTES:
                            self.events.emit(
                                "dns_drop",
                                transport="tcp",
                                peer_ipv4=source[0],
                                reason="invalid_message_length",
                                message_bytes=message_length,
                            )
                            continue
                        message = receive_exact(
                            connection, message_length, deadline, self._stop
                        )
                    except InterruptedError:
                        return
                    except (ConnectionError, socket.timeout):
                        self.events.emit(
                            "dns_drop",
                            transport="tcp",
                            peer_ipv4=source[0],
                            reason="incomplete_message",
                        )
                        continue
                    response = self._handle_message(message, source[0], "tcp")
                    if response is not None:
                        try:
                            connection.sendall(
                                struct.pack("!H", len(response)) + response
                            )
                        except OSError as error:
                            self.events.emit(
                                "dns_send_error",
                                transport="tcp",
                                peer_ipv4=source[0],
                                error=type(error).__name__,
                            )
            finally:
                with self._active_tcp_lock:
                    if self._active_tcp is connection:
                        self._active_tcp = None

    def _handle_message(
        self, message: bytes, source_ipv4: str, transport: str
    ) -> bytes | None:
        if not self.source_allowed(source_ipv4):
            self.events.emit(
                "dns_drop",
                transport=transport,
                peer_ipv4=source_ipv4,
                reason="source_not_allowed",
                message_bytes=len(message),
            )
            return None
        if len(message) > MAX_DNS_MESSAGE_BYTES:
            self.events.emit(
                "dns_drop",
                transport=transport,
                peer_ipv4=source_ipv4,
                reason="message_too_large",
                message_bytes=len(message),
            )
            return None
        try:
            query = parse_query(message)
        except DnsParseError as error:
            response = build_format_error(message) if error.respond else None
            self.events.emit(
                "dns_query",
                transport=transport,
                peer_ipv4=source_ipv4,
                message_bytes=len(message),
                outcome="format_error" if response is not None else "dropped",
                reason=error.reason,
                rcode=RCODE_FORMERR if response is not None else None,
            )
            return response

        decision = decide_query(query, self.authoritative_name)
        response = build_response(
            query,
            decision,
            self.authoritative_address,
            self.ttl_seconds,
        )
        self.events.emit(
            "dns_query",
            transport=transport,
            peer_ipv4=source_ipv4,
            message_bytes=len(message),
            query_name=query.name,
            query_type=query.query_type,
            query_class=query.query_class,
            recursion_desired=query.recursion_desired,
            recursion_available=False,
            edns_version=query.edns.version if query.edns is not None else None,
            edns_option_count=(
                query.edns.option_count if query.edns is not None else None
            ),
            outcome=decision.outcome,
            rcode=decision.rcode,
            answers=1 if decision.include_answer else 0,
        )
        return response


def receive_exact(
    connection: socket.socket,
    byte_count: int,
    deadline: float,
    stop: threading.Event,
) -> bytes:
    received = bytearray()
    while len(received) < byte_count:
        if stop.is_set():
            raise InterruptedError("DNS server is stopping")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise socket.timeout("DNS TCP frame deadline expired")
        connection.settimeout(min(0.1, remaining))
        try:
            chunk = connection.recv(byte_count - len(received))
        except socket.timeout:
            continue
        if not chunk:
            raise ConnectionError("DNS TCP connection closed before its framed message")
        received.extend(chunk)
    return bytes(received)


def positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def ttl_integer(value: str) -> int:
    parsed = positive_integer(value)
    if parsed > MAX_TTL_SECONDS:
        raise argparse.ArgumentTypeError(f"must not exceed {MAX_TTL_SECONDS}")
    return parsed


def socket_timeout_integer(value: str) -> int:
    parsed = positive_integer(value)
    if parsed > MAX_SOCKET_TIMEOUT_MS:
        raise argparse.ArgumentTypeError(f"must not exceed {MAX_SOCKET_TIMEOUT_MS}")
    return parsed


def nonnegative_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return parsed


def run_server(args: argparse.Namespace) -> int:
    authoritative_address = ipaddress.IPv4Address(args.address)
    event_path = Path(args.events).expanduser() if args.events else None
    events = EventSink(event_path, args.quiet_events)
    try:
        server = DnsPeerServer(
            (args.host, args.port),
            authoritative_name=args.name,
            authoritative_address=authoritative_address,
            ttl_seconds=args.ttl,
            allowed_networks=tuple(args.allow_cidr),
            interface=args.interface,
            socket_timeout_ms=args.socket_timeout_ms,
            events=events,
        )
    except BaseException:
        events.close()
        raise
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        events.emit("dns_stop", reason="keyboard_interrupt")
    finally:
        server.shutdown()
        events.close()
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="run the controlled authoritative DNS peer")
    serve.add_argument("--host", type=parse_bind_host, default="0.0.0.0")
    serve.add_argument("--port", type=nonnegative_integer, default=53)
    serve.add_argument("--interface", help="restrict packets to this network interface")
    serve.add_argument(
        "--allow-cidr",
        action="append",
        required=True,
        type=parse_allow_cidr,
        help="allowed IPv4 source CIDR; repeat for another controlled subnet",
    )
    serve.add_argument("--name", default="pocketjs.test")
    serve.add_argument("--address", default="172.16.10.126")
    serve.add_argument("--ttl", type=ttl_integer, default=30)
    serve.add_argument(
        "--socket-timeout-ms", type=socket_timeout_integer, default=1000
    )
    serve.add_argument(
        "--events", help="append bounded-metadata NDJSON events to this path"
    )
    serve.add_argument("--quiet-events", action="store_true")
    serve.set_defaults(entrypoint=run_server)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.entrypoint(args)
    except (OSError, RuntimeError, ValueError) as error:
        print(
            json.dumps(
                {
                    "event": "dns_error",
                    "error": type(error).__name__,
                    "message": str(error),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
            file=sys.stderr,
            flush=True,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
