#!/usr/bin/env python3
"""Generate disposable PKI profiles for the independent PocketJS TLS peer."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path


DEFAULT_DNS_NAMES = ("pocketjs.test", "localhost")
DEFAULT_IP_ADDRESSES = ("127.0.0.1", "::1")
PRIVATE_KEY_NAMES = (
    "ca.key.pem",
    "server.key.pem",
    "wrong-host.key.pem",
    "expired-server.key.pem",
    "not-yet-valid-server.key.pem",
    "untrusted-ca.key.pem",
    "untrusted-server.key.pem",
)
OUTPUT_NAMES = (
    "ca.cert.pem",
    *PRIVATE_KEY_NAMES,
    "server.cert.pem",
    "wrong-host.cert.pem",
    "expired-server.cert.pem",
    "not-yet-valid-server.cert.pem",
    "untrusted-ca.cert.pem",
    "untrusted-server.cert.pem",
    "bad-signature-server.cert.pem",
)
DNS_NAME_PATTERN = re.compile(
    r"(?=.{1,253}\Z)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\Z"
)


class OpenSSLError(RuntimeError):
    pass


def run_openssl(
    executable: str,
    *arguments: str | Path,
    expected_success: bool = True,
) -> subprocess.CompletedProcess[str]:
    command = [executable, *(str(argument) for argument in arguments)]
    try:
        result = subprocess.run(
            command,
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as error:
        raise OpenSSLError(f"OpenSSL executable not found: {executable}") from error
    if (result.returncode == 0) != expected_success:
        detail = result.stderr.strip() or result.stdout.strip() or "no diagnostic"
        expectation = "succeed" if expected_success else "fail"
        raise OpenSSLError(
            f"OpenSSL command was expected to {expectation}: {detail}"
        )
    return result


def validated_dns_names(values: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    names = tuple(dict.fromkeys(values))
    if not names:
        raise ValueError("at least one DNS SAN is required")
    for name in names:
        if not DNS_NAME_PATTERN.fullmatch(name):
            raise ValueError(f"invalid DNS SAN: {name!r}")
    return names


def validated_ip_addresses(values: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    addresses = tuple(dict.fromkeys(str(ipaddress.ip_address(value)) for value in values))
    if not addresses:
        raise ValueError("at least one IP SAN is required")
    return addresses


def server_extensions(dns_names: tuple[str, ...], ip_addresses: tuple[str, ...]) -> str:
    sans = [*(f"DNS:{name}" for name in dns_names), *(f"IP:{ip}" for ip in ip_addresses)]
    return "\n".join(
        (
            "[server]",
            "basicConstraints=critical,CA:FALSE",
            "keyUsage=critical,digitalSignature,keyEncipherment",
            "extendedKeyUsage=serverAuth",
            f"subjectAltName={','.join(sans)}",
            "subjectKeyIdentifier=hash",
            "authorityKeyIdentifier=keyid,issuer",
            "",
        )
    )


def generate_ca(
    executable: str,
    directory: Path,
    prefix: str,
    common_name: str,
) -> tuple[Path, Path]:
    key_path = directory / f"{prefix}.key.pem"
    cert_path = directory / f"{prefix}.cert.pem"
    run_openssl(
        executable,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "3650",
        "-subj",
        f"/CN={common_name}",
        "-addext",
        "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
        "-addext",
        "subjectKeyIdentifier=hash",
        "-keyout",
        key_path,
        "-out",
        cert_path,
    )
    return cert_path, key_path


def generate_server(
    executable: str,
    directory: Path,
    prefix: str,
    common_name: str,
    ca_cert: Path,
    ca_key: Path,
    serial: str,
    dns_names: tuple[str, ...],
    ip_addresses: tuple[str, ...],
    not_before: str | None = None,
    not_after: str | None = None,
) -> tuple[Path, Path]:
    key_path = directory / f"{prefix}.key.pem"
    request_path = directory / f"{prefix}.csr.pem"
    cert_path = directory / f"{prefix}.cert.pem"
    extensions_path = directory / f"{prefix}.extensions.cnf"
    extensions_path.write_text(
        server_extensions(dns_names, ip_addresses), encoding="utf-8"
    )
    if (not_before is None) != (not_after is None):
        raise ValueError("not_before and not_after must be provided together")
    run_openssl(
        executable,
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-subj",
        f"/CN={common_name}",
        "-keyout",
        key_path,
        "-out",
        request_path,
    )
    if not_before is None or not_after is None:
        run_openssl(
            executable,
            "x509",
            "-req",
            "-in",
            request_path,
            "-CA",
            ca_cert,
            "-CAkey",
            ca_key,
            "-set_serial",
            serial,
            "-days",
            "825",
            "-sha256",
            "-extfile",
            extensions_path,
            "-extensions",
            "server",
            "-out",
            cert_path,
        )
    else:
        database = directory / f"{prefix}.ca-database"
        new_certificates = database / "certificates"
        new_certificates.mkdir(parents=True)
        (database / "index.txt").write_text("", encoding="ascii")
        (database / "serial").write_text(
            f"{serial.removeprefix('0x').upper()}\n", encoding="ascii"
        )
        ca_config = database / "ca.cnf"
        ca_config.write_text(
            "\n".join(
                (
                    "[ca]",
                    "default_ca=local_ca",
                    "[local_ca]",
                    f'database="{database / "index.txt"}"',
                    f'new_certs_dir="{new_certificates}"',
                    f'certificate="{ca_cert}"',
                    f'private_key="{ca_key}"',
                    f'serial="{database / "serial"}"',
                    "default_md=sha256",
                    "default_days=825",
                    "email_in_dn=no",
                    "unique_subject=no",
                    "policy=server_policy",
                    "x509_extensions=server",
                    "[server_policy]",
                    "commonName=supplied",
                    server_extensions(dns_names, ip_addresses),
                )
            ),
            encoding="utf-8",
        )
        run_openssl(
            executable,
            "ca",
            "-batch",
            "-notext",
            "-config",
            ca_config,
            "-in",
            request_path,
            "-startdate",
            not_before,
            "-enddate",
            not_after,
            "-out",
            cert_path,
        )
    return cert_path, key_path


def generate_pki(
    output: Path,
    *,
    dns_names: tuple[str, ...] = DEFAULT_DNS_NAMES,
    ip_addresses: tuple[str, ...] = DEFAULT_IP_ADDRESSES,
    force: bool = False,
    openssl: str = "openssl",
) -> dict[str, Path]:
    dns_names = validated_dns_names(dns_names)
    ip_addresses = validated_ip_addresses(ip_addresses)
    output = output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    existing = [output / name for name in OUTPUT_NAMES if (output / name).exists()]
    if existing and not force:
        raise FileExistsError(
            f"generated PKI already exists at {output}; pass --force to replace it"
        )

    with tempfile.TemporaryDirectory(prefix=".pki-staging-", dir=output) as temporary:
        staging = Path(temporary)
        ca_cert, ca_key = generate_ca(
            openssl, staging, "ca", "PocketJS Local Test CA"
        )
        server_cert, server_key = generate_server(
            openssl,
            staging,
            "server",
            dns_names[0],
            ca_cert,
            ca_key,
            "0x1001",
            dns_names,
            ip_addresses,
        )
        wrong_host_cert, wrong_host_key = generate_server(
            openssl,
            staging,
            "wrong-host",
            "wrong-host.invalid",
            ca_cert,
            ca_key,
            "0x1002",
            ("wrong-host.invalid",),
            ip_addresses=(),
        )
        expired_server_cert, expired_server_key = generate_server(
            openssl,
            staging,
            "expired-server",
            dns_names[0],
            ca_cert,
            ca_key,
            "0x1003",
            dns_names,
            ip_addresses,
            not_before="20200101000000Z",
            not_after="20200102000000Z",
        )
        not_yet_valid_server_cert, not_yet_valid_server_key = generate_server(
            openssl,
            staging,
            "not-yet-valid-server",
            dns_names[0],
            ca_cert,
            ca_key,
            "0x1004",
            dns_names,
            ip_addresses,
            not_before="20500101000000Z",
            not_after="20500102000000Z",
        )
        untrusted_ca_cert, untrusted_ca_key = generate_ca(
            openssl, staging, "untrusted-ca", "PocketJS Untrusted Test CA"
        )
        untrusted_server_cert, untrusted_server_key = generate_server(
            openssl,
            staging,
            "untrusted-server",
            dns_names[0],
            untrusted_ca_cert,
            untrusted_ca_key,
            "0x2001",
            dns_names,
            ip_addresses,
        )
        bad_signature_cert = staging / "bad-signature-server.cert.pem"
        run_openssl(
            openssl,
            "x509",
            "-in",
            server_cert,
            "-badsig",
            "-out",
            bad_signature_cert,
        )

        run_openssl(openssl, "verify", "-CAfile", ca_cert, server_cert)
        run_openssl(openssl, "verify", "-CAfile", ca_cert, wrong_host_cert)
        for time_invalid_cert in (expired_server_cert, not_yet_valid_server_cert):
            run_openssl(
                openssl,
                "verify",
                "-no_check_time",
                "-CAfile",
                ca_cert,
                time_invalid_cert,
            )
            run_openssl(
                openssl,
                "verify",
                "-CAfile",
                ca_cert,
                time_invalid_cert,
                expected_success=False,
            )
        run_openssl(
            openssl,
            "verify",
            "-CAfile",
            untrusted_ca_cert,
            untrusted_server_cert,
        )
        run_openssl(
            openssl,
            "verify",
            "-CAfile",
            ca_cert,
            bad_signature_cert,
            expected_success=False,
        )

        generated = {
            "ca_cert": ca_cert,
            "ca_key": ca_key,
            "server_cert": server_cert,
            "server_key": server_key,
            "wrong_host_cert": wrong_host_cert,
            "wrong_host_key": wrong_host_key,
            "expired_server_cert": expired_server_cert,
            "expired_server_key": expired_server_key,
            "not_yet_valid_server_cert": not_yet_valid_server_cert,
            "not_yet_valid_server_key": not_yet_valid_server_key,
            "untrusted_ca_cert": untrusted_ca_cert,
            "untrusted_ca_key": untrusted_ca_key,
            "untrusted_server_cert": untrusted_server_cert,
            "untrusted_server_key": untrusted_server_key,
            "bad_signature_server_cert": bad_signature_cert,
        }
        result: dict[str, Path] = {}
        for name, source in generated.items():
            destination = output / source.name
            os.replace(source, destination)
            result[name] = destination

    for name in PRIVATE_KEY_NAMES:
        (output / name).chmod(0o600)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).with_name(".pki"),
        help="output directory (default: peer tool .pki directory)",
    )
    parser.add_argument(
        "--san-dns",
        action="append",
        dest="extra_dns_names",
        default=[],
        help="additional DNS subjectAltName; may be repeated",
    )
    parser.add_argument(
        "--san-ip",
        action="append",
        dest="extra_ip_addresses",
        default=[],
        help="additional IPv4/IPv6 subjectAltName; may be repeated",
    )
    parser.add_argument("--openssl", default="openssl", help="OpenSSL executable")
    parser.add_argument("--force", action="store_true", help="replace generated profiles")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = generate_pki(
            args.output,
            dns_names=(*DEFAULT_DNS_NAMES, *args.extra_dns_names),
            ip_addresses=(*DEFAULT_IP_ADDRESSES, *args.extra_ip_addresses),
            force=args.force,
            openssl=args.openssl,
        )
    except (FileExistsError, OpenSSLError, ValueError) as error:
        print(
            json.dumps(
                {
                    "event": "pki_error",
                    "error": type(error).__name__,
                    "message": str(error),
                },
                sort_keys=True,
                separators=(",", ":"),
            ),
        )
        return 1

    print(
        json.dumps(
            {
                "event": "pki_ready",
                "output": str(args.output.expanduser().resolve()),
                "ca_cert": str(result["ca_cert"]),
                "profiles": {
                    "valid": {
                        "cert": str(result["server_cert"]),
                        "key": str(result["server_key"]),
                    },
                    "wrong_hostname": {
                        "cert": str(result["wrong_host_cert"]),
                        "key": str(result["wrong_host_key"]),
                    },
                    "untrusted": {
                        "cert": str(result["untrusted_server_cert"]),
                        "key": str(result["untrusted_server_key"]),
                    },
                    "bad_signature": {
                        "cert": str(result["bad_signature_server_cert"]),
                        "key": str(result["server_key"]),
                    },
                    "expired": {
                        "cert": str(result["expired_server_cert"]),
                        "key": str(result["expired_server_key"]),
                    },
                    "not_yet_valid": {
                        "cert": str(result["not_yet_valid_server_cert"]),
                        "key": str(result["not_yet_valid_server_key"]),
                    },
                },
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
