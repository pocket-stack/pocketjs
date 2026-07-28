"""Build the PocketJS guest, Rust runtime, and flash-resident asset arrays."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

Import("env")  # type: ignore[name-defined]  # PlatformIO/SCons injects this.

PROJECT = Path(env.subst("$PROJECT_DIR")).resolve()  # type: ignore[name-defined]
ROOT = PROJECT.parent.parent
APP = ROOT / "apps" / "symbian-pocket"
BUILD = PROJECT / "build"
ASSETS = BUILD / "assets"
FONTS = BUILD / "fonts"
GENERATED = PROJECT / "firmware" / "generated_assets.cpp"
RUST = PROJECT / "rust-core"
RUST_LIB = RUST / "target" / "xtensa-esp32-none-elf" / "release" / "libpocketjs_esp32_core.a"
QUICKJS = PROJECT / "vendor" / "libquickjs-sys" / "embed" / "quickjs"


def newest(paths: list[Path]) -> float:
    files: list[Path] = []
    for path in paths:
        files.extend(path.rglob("*") if path.is_dir() else [path])
    return max((path.stat().st_mtime for path in files if path.is_file()), default=0.0)


def run(command: list[str], cwd: Path, process_env: dict[str, str] | None = None) -> None:
    print("[symbian-pocket] " + " ".join(command))
    subprocess.run(command, cwd=cwd, env=process_env, check=True)


def fonttools_python() -> list[str]:
    candidates = [
        [os.environ["POCKETJS_PYTHON"]] if os.environ.get("POCKETJS_PYTHON") else [],
        [str(Path(os.environ.get("SystemDrive", "C:") + os.sep) / "Python312" / "python.exe")],
        ["py", "-3.12"],
        [sys.executable],
    ]
    for candidate in candidates:
        if not candidate:
            continue
        try:
            subprocess.run(
                candidate + ["-c", "import fontTools"],
                cwd=ROOT,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=True,
            )
            return candidate
        except (OSError, subprocess.CalledProcessError):
            pass
    raise RuntimeError("fontTools is required to build the Chinese font subset")


def prepare_font() -> Path:
    FONTS.mkdir(parents=True, exist_ok=True)
    glyph_file = FONTS / "glyphs.txt"
    output = FONTS / "SimHei-SymbianPocket.ttf"
    source_candidates = [
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "simhei.ttf",
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "msyh.ttc",
        ROOT / "assets" / "fonts" / "NotoSansSC-VF.ttf",
    ]
    source = next((path for path in source_candidates if path.exists()), None)
    if source is None:
        raise RuntimeError("No Chinese-capable build font was found")

    app_sources = sorted(APP.glob("*.ts*"))
    characters = set("".join(path.read_text(encoding="utf-8") for path in app_sources))
    characters.update(chr(value) for value in range(32, 127))
    glyph_file.write_text("".join(sorted(characters)), encoding="utf-8")

    if not output.exists() or newest(app_sources + [source]) > output.stat().st_mtime:
        run(
            [
                *fonttools_python(),
                "-m",
                "fontTools.subset",
                str(source),
                f"--text-file={glyph_file}",
                f"--output-file={output}",
                "--layout-features=*",
                "--no-hinting",
                "--desubroutinize",
                "--glyph-names",
            ],
            ROOT,
        )
    return output


def build_guest(font: Path) -> tuple[Path, Path]:
    ASSETS.mkdir(parents=True, exist_ok=True)
    js = ASSETS / "symbian-pocket-main.js"
    pak = ASSETS / "symbian-pocket-main.pak"
    sources = list(APP.glob("*.ts*")) + [APP / "pocket.json", APP / "pocket.config.ts", font]
    if not js.exists() or not pak.exists() or newest(sources) > min(js.stat().st_mtime, pak.stat().st_mtime):
        bun = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun.exe")
        run(
            [
                bun,
                "tools/build.ts",
                "symbian-pocket-main",
                f"--font-regular={font}",
                f"--font-bold={font}",
                f"--outdir={ASSETS}",
            ],
            ROOT,
        )
    return js, pak


def build_host_qjsc() -> Path:
    executable = BUILD / ("qjsc-host.exe" if os.name == "nt" else "qjsc-host")
    config = BUILD / "qjsc-config.h"
    version = (QUICKJS / "VERSION").read_text(encoding="utf-8").strip()
    expected_config = f'#define CONFIG_VERSION "{version}"\n'
    if not config.exists() or config.read_text(encoding="ascii") != expected_config:
        config.write_text(expected_config, encoding="ascii", newline="\n")

    sources = [
        QUICKJS / "qjsc.c",
        QUICKJS / "quickjs.c",
        QUICKJS / "dtoa.c",
        QUICKJS / "libregexp.c",
        QUICKJS / "libunicode.c",
        QUICKJS / "cutils.c",
        QUICKJS / "quickjs-libc.c",
    ]
    if not executable.exists() or newest(sources + [config]) > executable.stat().st_mtime:
        compiler = shutil.which("gcc") or shutil.which("cc")
        if not compiler:
            raise RuntimeError("A host C compiler is required to build qjsc")
        libraries = ["-lm", "-lws2_32"] if os.name == "nt" else ["-lm", "-ldl", "-lpthread"]
        run(
            [
                compiler,
                "-O1",
                "-fwrapv",
                "-D_GNU_SOURCE",
                "-include",
                str(config),
                "-I",
                str(QUICKJS),
                "-o",
                str(executable),
                *(str(path) for path in sources),
                *libraries,
            ],
            ROOT,
        )
    return executable


def build_bytecode(js: Path) -> Path:
    qjsc = build_host_qjsc()
    generated_c = ASSETS / "symbian-pocket-main.qbc.c"
    bytecode = ASSETS / "symbian-pocket-main.qbc"
    if (
        not bytecode.exists()
        or not generated_c.exists()
        or newest([js, qjsc]) > min(bytecode.stat().st_mtime, generated_c.stat().st_mtime)
    ):
        run(
            [
                str(qjsc),
                "-c",
                "-s",
                "-N",
                "symbian_pocket_bytecode",
                "-o",
                str(generated_c),
                str(js),
            ],
            ROOT,
        )
        source = generated_c.read_text(encoding="utf-8")
        size_match = re.search(r"symbian_pocket_bytecode_size\s*=\s*(\d+)", source)
        array_match = re.search(
            r"symbian_pocket_bytecode\[[^\]]+\]\s*=\s*\{(.*?)\};",
            source,
            re.DOTALL,
        )
        if not size_match or not array_match:
            raise RuntimeError("qjsc produced an unrecognized bytecode C array")
        payload = bytes(
            int(value, 16)
            for value in re.findall(r"0x([0-9a-fA-F]{2})", array_match.group(1))
        )
        expected = int(size_match.group(1))
        if len(payload) != expected:
            raise RuntimeError(f"qjsc bytecode length mismatch: {len(payload)} != {expected}")
        bytecode.write_bytes(payload)
    return bytecode


def emit_array(name: str, payload: bytes, *, zero_terminated: bool = False) -> str:
    stored = payload + (b"\0" if zero_terminated else b"")
    rows = []
    for offset in range(0, len(stored), 16):
        rows.append("    " + ", ".join(f"0x{value:02x}" for value in stored[offset : offset + 16]) + ",")
    return (
        f"extern const std::uint8_t {name}[] PROGMEM = {{\n"
        + "\n".join(rows)
        + f"\n}};\nextern const std::size_t {name}_len = {len(payload)};\n"
    )


def generate_assets(bytecode: Path, pak: Path) -> None:
    payload = (
        "// Generated by scripts/prebuild.py. Do not edit.\n"
        "#include <Arduino.h>\n#include <cstddef>\n#include <cstdint>\n\n"
        + emit_array("symbian_pocket_qbc", bytecode.read_bytes())
        + "\n"
        + emit_array("symbian_pocket_pak", pak.read_bytes())
    )
    previous = GENERATED.read_text(encoding="utf-8") if GENERATED.exists() else ""
    if payload != previous:
        GENERATED.write_text(payload, encoding="utf-8", newline="\n")


def build_rust() -> None:
    rust_inputs = [RUST / "src", RUST / "Cargo.toml", RUST / "Cargo.lock", PROJECT / "vendor" / "libquickjs-sys", ROOT / "engine" / "core"]
    if RUST_LIB.exists() and newest(rust_inputs) <= RUST_LIB.stat().st_mtime:
        return
    # PlatformIO's Arduino-ESP32 2.x package still ships Xtensa GCC 8.4.
    # That compiler miscompiles current QuickJS even at modest optimisation
    # levels. Prefer an installed Espressif GCC 13/14 for the Rust/C archive;
    # its objects remain ABI-compatible with PlatformIO's final linker.
    candidates = [
        Path(os.environ["ESP_XTENSA_TOOLCHAIN"]) if os.environ.get("ESP_XTENSA_TOOLCHAIN") else None,
        Path.home() / ".espressif" / "tools" / "xtensa-esp-elf" /
        "esp-13.2.0_20240305" / "xtensa-esp-elf" / "bin",
        Path("C:/Espressif/tools/xtensa-esp-elf/esp-14.2.0_20241119/xtensa-esp-elf/bin"),
        Path.home() / ".rustup" / "toolchains" / "esp" / "xtensa-esp-elf" / "bin",
        Path.home() / ".platformio" / "packages" / "toolchain-xtensa-esp32" / "bin",
    ]
    toolchain = next(
        path for path in candidates
        if path is not None and (path / "xtensa-esp32-elf-gcc.exe").exists()
    )
    process_env = os.environ.copy()
    process_env["PATH"] = str(toolchain) + os.pathsep + process_env.get("PATH", "")
    process_env["CC"] = "xtensa-esp32-elf-gcc"
    process_env["AR"] = "xtensa-esp32-elf-ar"
    process_env["RANLIB"] = "xtensa-esp32-elf-ranlib"
    run(
        [
            "cargo",
            "+esp",
            "-Z",
            "next-lockfile-bump",
            "-Z",
            "build-std=core,alloc",
            "build",
            "--release",
            "--target",
            "xtensa-esp32-none-elf",
            "--locked",
        ],
        RUST,
        process_env,
    )


font_path = prepare_font()
guest_js, guest_pak = build_guest(font_path)
guest_bytecode = build_bytecode(guest_js)
generate_assets(guest_bytecode, guest_pak)
build_rust()

env.Append(LIBPATH=[str(RUST_LIB.parent)], LIBS=["pocketjs_esp32_core"])  # type: ignore[name-defined]
print(
    f"[symbian-pocket] guest={guest_bytecode.stat().st_size}+{guest_pak.stat().st_size} "
    f"rust={RUST_LIB.stat().st_size}"
)
