#!/usr/bin/env python3
"""Repair an ARM ELF object converted to WinCE COFF by BFD objcopy.

This is intentionally narrow. The PocketJS WM6 core is first linked into one
ARMv4T ELF relocatable object and has all .ARM.exidx sections removed. At that
point rustc currently emits only:

    R_ARM_ABS32   (2)  -> ARM_32 (1)
    R_ARM_CALL   (28)  -> ARM_26 (3)
    R_ARM_JUMP24 (29)  -> ARM_26 (3)

The CeGCC BFD objcopy can copy all sections from ELF to COFF, but its generic
format converter preserves the ELF relocation numbers *and* the ELF symbol
indices. The latter do not identify the corresponding COFF symbols. ELF ARM
branches also carry a -8 instruction addend for the architecture's PC bias,
while WinCE ARM_26 expects a zero immediate and applies that bias itself. This
tool uses the source ELF relocation tables as the authority, appends exact
COFF symbols for their targets, normalizes branch addends, rewrites every
relocation, and rejects unexpected input instead of silently producing a
corrupt object.
"""

from __future__ import annotations

import argparse
import struct
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


COFF_HEADER_SIZE = 20
COFF_SECTION_SIZE = 40
COFF_RELOCATION_SIZE = 10
COFF_SYMBOL_SIZE = 18
IMAGE_FILE_MACHINE_ARM = 0x01C0
IMAGE_FILE_MACHINE_THUMB = 0x01C2
IMAGE_SCN_LNK_NRELOC_OVFL = 0x01000000
IMAGE_SYM_CLASS_EXTERNAL = 2
IMAGE_SYM_CLASS_STATIC = 3
IMAGE_REL_ARM_BRANCH24 = 3

ELF_HEADER_SIZE = 52
ELF_SECTION_SIZE = 40
ELF_SYMBOL_SIZE = 16
ELF_RELOCATION_SIZE = 8
EM_ARM = 40
ET_REL = 1
SHT_SYMTAB = 2
SHT_REL = 9
SHN_UNDEF = 0
SHN_ABS = 0xFFF1

ELF_TO_WINCE_RELOCATION = {
    2: 1,   # R_ARM_ABS32 -> ARM_32
    28: IMAGE_REL_ARM_BRANCH24,  # R_ARM_CALL -> ARM_26
    29: IMAGE_REL_ARM_BRANCH24,  # R_ARM_JUMP24 -> ARM_26
}


class CoffError(RuntimeError):
    pass


@dataclass(frozen=True)
class ElfSection:
    index: int
    name: str
    kind: int
    offset: int
    size: int
    link: int
    info: int
    entry_size: int


@dataclass(frozen=True)
class ElfSymbol:
    index: int
    name: str
    value: int
    section_index: int


@dataclass(frozen=True)
class CoffSection:
    index: int
    name: str
    header: int
    data_offset: int
    data_size: int
    relocation_offset: int
    relocation_count: int


def read_u16(data: bytes | bytearray, offset: int) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def read_u32(data: bytes | bytearray, offset: int) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def checked_range(
    data: bytes | bytearray,
    offset: int,
    size: int,
    label: str,
) -> None:
    if offset < 0 or size < 0 or offset + size > len(data):
        raise CoffError(
            f"{label} lies outside the COFF object "
            f"(offset={offset}, size={size}, file={len(data)})"
        )


def read_elf_string(data: bytes, table: ElfSection, offset: int, label: str) -> str:
    if offset < 0 or offset >= table.size:
        raise CoffError(f"{label} has invalid ELF string-table offset {offset}")
    start = table.offset + offset
    end = data.find(b"\0", start, table.offset + table.size)
    if end < 0:
        raise CoffError(f"{label} is not NUL-terminated")
    try:
        return data[start:end].decode("ascii")
    except UnicodeDecodeError as error:
        raise CoffError(f"{label} is not ASCII") from error


def parse_elf(data: bytes) -> tuple[list[ElfSection], list[ElfSymbol]]:
    checked_range(data, 0, ELF_HEADER_SIZE, "ELF header")
    if data[:6] != b"\x7fELF\x01\x01":
        raise CoffError("expected a little-endian ELF32 input object")
    elf_type, machine = struct.unpack_from("<HH", data, 16)
    if elf_type != ET_REL or machine != EM_ARM:
        raise CoffError(
            f"expected an ARM relocatable ELF object, got type={elf_type}, "
            f"machine={machine}"
        )

    section_table = read_u32(data, 32)
    section_size = read_u16(data, 46)
    section_count = read_u16(data, 48)
    section_names_index = read_u16(data, 50)
    if section_size != ELF_SECTION_SIZE:
        raise CoffError(f"unsupported ELF section-header size {section_size}")
    if section_count == 0 or section_names_index >= section_count:
        raise CoffError("extended ELF section numbering is not supported")
    checked_range(
        data,
        section_table,
        section_count * section_size,
        "ELF section table",
    )

    raw_sections: list[tuple[int, ...]] = []
    for index in range(section_count):
        raw_sections.append(
            struct.unpack_from(
                "<IIIIIIIIII",
                data,
                section_table + index * section_size,
            )
        )

    section_name_header = raw_sections[section_names_index]
    section_name_table = ElfSection(
        section_names_index,
        "",
        section_name_header[1],
        section_name_header[4],
        section_name_header[5],
        section_name_header[6],
        section_name_header[7],
        section_name_header[9],
    )
    checked_range(
        data,
        section_name_table.offset,
        section_name_table.size,
        "ELF section-name table",
    )

    sections: list[ElfSection] = []
    for index, header in enumerate(raw_sections):
        name = read_elf_string(
            data,
            section_name_table,
            header[0],
            f"ELF section {index}",
        )
        section = ElfSection(
            index,
            name,
            header[1],
            header[4],
            header[5],
            header[6],
            header[7],
            header[9],
        )
        if section.kind != 8:  # SHT_NOBITS has no file payload.
            checked_range(
                data,
                section.offset,
                section.size,
                f"ELF section {index} ({name})",
            )
        sections.append(section)

    symbol_tables = [section for section in sections if section.kind == SHT_SYMTAB]
    if len(symbol_tables) != 1:
        raise CoffError(
            f"expected exactly one ELF symbol table, found {len(symbol_tables)}"
        )
    symbol_table = symbol_tables[0]
    if symbol_table.entry_size != ELF_SYMBOL_SIZE:
        raise CoffError(
            f"unsupported ELF symbol size {symbol_table.entry_size}"
        )
    if symbol_table.link >= len(sections):
        raise CoffError("ELF symbol table has an invalid string-table link")
    string_table = sections[symbol_table.link]
    if symbol_table.size % ELF_SYMBOL_SIZE:
        raise CoffError("ELF symbol table has a partial final record")

    symbols: list[ElfSymbol] = []
    for index in range(symbol_table.size // ELF_SYMBOL_SIZE):
        record = symbol_table.offset + index * ELF_SYMBOL_SIZE
        name_offset, value, _size = struct.unpack_from("<III", data, record)
        section_index = read_u16(data, record + 14)
        name = (
            read_elf_string(data, string_table, name_offset, f"ELF symbol {index}")
            if name_offset
            else ""
        )
        symbols.append(ElfSymbol(index, name, value, section_index))
    return sections, symbols


def read_c_string(data: bytearray, offset: int, limit: int, label: str) -> str:
    if offset < 0 or offset >= limit:
        raise CoffError(f"{label} has invalid string-table offset {offset}")
    end = data.find(b"\0", offset, limit)
    if end < 0:
        # GNU BFD permits the final COFF string to end exactly at EOF.
        end = limit
    return data[offset:end].decode("ascii")


def symbol_name(
    data: bytearray,
    record: int,
    string_table: int,
    string_table_end: int,
) -> str:
    raw = data[record : record + 8]
    if raw[:4] == b"\0\0\0\0":
        offset = struct.unpack_from("<I", raw, 4)[0]
        return read_c_string(
            data,
            string_table + offset,
            string_table_end,
            "COFF symbol",
        )
    return bytes(raw).split(b"\0", 1)[0].decode("ascii")


def section_name(
    data: bytearray,
    header: int,
    string_table: int,
    string_table_end: int,
) -> str:
    raw = bytes(data[header : header + 8]).split(b"\0", 1)[0]
    if raw.startswith(b"/"):
        try:
            offset = int(raw[1:].decode("ascii"), 10)
        except ValueError as error:
            raise CoffError(f"invalid long COFF section name {raw!r}") from error
        return read_c_string(
            data,
            string_table + offset,
            string_table_end,
            "COFF section",
        )
    return raw.decode("ascii")


def parse_coff_sections(data: bytearray) -> list[CoffSection]:
    checked_range(data, 0, COFF_HEADER_SIZE, "COFF header")
    machine, section_count = struct.unpack_from("<HH", data, 0)
    optional_header_size = read_u16(data, 16)
    if machine not in (IMAGE_FILE_MACHINE_ARM, IMAGE_FILE_MACHINE_THUMB):
        raise CoffError(f"expected ARM WinCE COFF machine, got 0x{machine:04x}")
    if optional_header_size != 0:
        raise CoffError(
            "expected a relocatable COFF object without an optional header"
        )

    section_table = COFF_HEADER_SIZE
    checked_range(
        data,
        section_table,
        section_count * COFF_SECTION_SIZE,
        "COFF section table",
    )
    symbol_table = read_u32(data, 8)
    symbol_count = read_u32(data, 12)
    string_table = symbol_table + symbol_count * COFF_SYMBOL_SIZE
    checked_range(data, string_table, 4, "COFF string table")
    string_table_size = read_u32(data, string_table)
    if string_table_size < 4:
        raise CoffError(f"invalid COFF string-table size {string_table_size}")
    checked_range(data, string_table, string_table_size, "COFF string table")
    string_table_end = string_table + string_table_size

    sections: list[CoffSection] = []
    for index in range(section_count):
        header = section_table + index * COFF_SECTION_SIZE
        data_size = read_u32(data, header + 16)
        data_offset = read_u32(data, header + 20)
        relocation_offset = read_u32(data, header + 24)
        relocation_count = read_u16(data, header + 32)
        characteristics = read_u32(data, header + 36)
        if characteristics & IMAGE_SCN_LNK_NRELOC_OVFL:
            raise CoffError(
                f"section {index + 1} uses unsupported relocation overflow"
            )
        if relocation_count:
            checked_range(
                data,
                data_offset,
                data_size,
                f"contents for section {index + 1}",
            )
            checked_range(
                data,
                relocation_offset,
                relocation_count * COFF_RELOCATION_SIZE,
                f"relocations for section {index + 1}",
            )
        sections.append(
            CoffSection(
                index + 1,
                section_name(data, header, string_table, string_table_end),
                header,
                data_offset,
                data_size,
                relocation_offset,
                relocation_count,
            )
        )
    return sections


def append_coff_symbols(
    data: bytearray,
    symbols: list[tuple[str, int, int, int]],
) -> tuple[bytearray, list[int]]:
    if not symbols:
        return data, []

    symbol_table = read_u32(data, 8)
    symbol_count = read_u32(data, 12)
    string_table = symbol_table + symbol_count * COFF_SYMBOL_SIZE
    checked_range(
        data,
        symbol_table,
        symbol_count * COFF_SYMBOL_SIZE,
        "COFF symbol table",
    )
    checked_range(data, string_table, 4, "COFF string table")
    string_table_size = read_u32(data, string_table)
    checked_range(data, string_table, string_table_size, "COFF string table")
    string_table_end = string_table + string_table_size

    strings = bytearray(data[string_table:string_table_end])
    if len(strings) < 4:
        raise CoffError("invalid COFF string table")
    if strings[-1] != 0:
        strings.append(0)

    string_offsets: dict[str, int] = {}
    cursor = 4
    while cursor < len(strings):
        end = strings.find(b"\0", cursor)
        if end < 0:
            end = len(strings)
        if end > cursor:
            string_offsets[bytes(strings[cursor:end]).decode("ascii")] = cursor
        cursor = end + 1

    records = bytearray()
    indices: list[int] = []
    for name, value, section, storage_class in symbols:
        try:
            encoded = name.encode("ascii")
        except UnicodeEncodeError as error:
            raise CoffError(f"COFF symbol {name!r} is not ASCII") from error
        if not encoded:
            raise CoffError("cannot append an unnamed COFF symbol")
        if len(encoded) <= 8:
            name_field = encoded.ljust(8, b"\0")
        else:
            offset = string_offsets.get(name)
            if offset is None:
                offset = len(strings)
                strings.extend(encoded)
                strings.append(0)
                string_offsets[name] = offset
            name_field = b"\0\0\0\0" + struct.pack("<I", offset)
        indices.append(symbol_count + len(records) // COFF_SYMBOL_SIZE)
        records.extend(name_field)
        records.extend(
            struct.pack(
                "<IhHBB",
                value,
                section,
                0,
                storage_class,
                0,
            )
        )

    struct.pack_into("<I", strings, 0, len(strings))
    struct.pack_into("<I", data, 12, symbol_count + len(symbols))
    rebuilt = (
        data[:string_table]
        + records
        + strings
        + data[string_table_end:]
    )
    return rebuilt, indices


def remap_relocations(
    elf_data: bytes,
    coff_data: bytearray,
) -> tuple[bytearray, Counter[tuple[int, int]], int, int]:
    elf_sections, elf_symbols = parse_elf(elf_data)
    coff_sections = parse_coff_sections(coff_data)

    coff_by_name: dict[str, CoffSection] = {}
    for section in coff_sections:
        if section.name in coff_by_name:
            raise CoffError(f"duplicate COFF section name {section.name!r}")
        coff_by_name[section.name] = section

    pending: list[tuple[int, int, int]] = []
    normalized_branches = 0
    matched_coff_sections: set[int] = set()
    for relocation_section in elf_sections:
        if relocation_section.kind != SHT_REL:
            continue
        if relocation_section.entry_size != ELF_RELOCATION_SIZE:
            raise CoffError(
                f"unsupported relocation size in {relocation_section.name!r}: "
                f"{relocation_section.entry_size}"
            )
        if relocation_section.info >= len(elf_sections):
            raise CoffError(
                f"{relocation_section.name!r} has an invalid target section"
            )
        target = elf_sections[relocation_section.info]
        coff_section = coff_by_name.get(target.name)
        if coff_section is None:
            # The conversion intentionally removes unwind tables and may omit
            # other sections that have no representation in the final object.
            continue
        if relocation_section.size % ELF_RELOCATION_SIZE:
            raise CoffError(
                f"{relocation_section.name!r} has a partial relocation record"
            )
        elf_count = relocation_section.size // ELF_RELOCATION_SIZE
        if elf_count != coff_section.relocation_count:
            raise CoffError(
                f"relocation count differs for {target.name!r}: "
                f"ELF={elf_count}, COFF={coff_section.relocation_count}"
            )
        matched_coff_sections.add(coff_section.index)

        for index in range(elf_count):
            elf_record = (
                relocation_section.offset + index * ELF_RELOCATION_SIZE
            )
            relocation_address, relocation_info = struct.unpack_from(
                "<II",
                elf_data,
                elf_record,
            )
            elf_symbol_index = relocation_info >> 8
            input_type = relocation_info & 0xFF
            if elf_symbol_index >= len(elf_symbols):
                raise CoffError(
                    f"{relocation_section.name!r} references invalid ELF "
                    f"symbol {elf_symbol_index}"
                )
            try:
                ELF_TO_WINCE_RELOCATION[input_type]
            except KeyError as error:
                raise CoffError(
                    f"unsupported ARM ELF relocation {input_type} in "
                    f"{target.name!r}, relocation {index}"
                ) from error

            coff_record = (
                coff_section.relocation_offset + index * COFF_RELOCATION_SIZE
            )
            coff_address = read_u32(coff_data, coff_record)
            copied_type = read_u16(coff_data, coff_record + 8)
            if coff_address != relocation_address or copied_type != input_type:
                raise CoffError(
                    f"ELF/COFF relocation order differs in {target.name!r} "
                    f"at index {index}: ELF=(0x{relocation_address:x}, "
                    f"{input_type}), COFF=(0x{coff_address:x}, {copied_type})"
                )
            if input_type in (28, 29):
                if relocation_address > coff_section.data_size - 4:
                    raise CoffError(
                        f"ARM branch relocation at 0x{relocation_address:x} "
                        f"lies outside {target.name!r}"
                    )
                instruction_offset = (
                    coff_section.data_offset + relocation_address
                )
                instruction = read_u32(coff_data, instruction_offset)
                if instruction & 0x0E000000 != 0x0A000000:
                    raise CoffError(
                        f"ARM branch relocation at 0x{relocation_address:x} "
                        f"in {target.name!r} targets non-branch instruction "
                        f"0x{instruction:08x}"
                    )
                # ELF REL stores A=-8 in imm24 so S+A-P compensates for the
                # ARM PC value (P+8). WinCE ARM_26 performs that compensation
                # itself and follows CeGCC's convention of imm24=0.
                struct.pack_into(
                    "<I",
                    coff_data,
                    instruction_offset,
                    instruction & 0xFF000000,
                )
                normalized_branches += 1
            pending.append((coff_record, input_type, elf_symbol_index))

    unmatched = [
        section.name
        for section in coff_sections
        if section.relocation_count and section.index not in matched_coff_sections
    ]
    if unmatched:
        preview = ", ".join(repr(name) for name in unmatched[:3])
        raise CoffError(
            f"{len(unmatched)} COFF sections with relocations have no matching "
            f"ELF relocation section: {preview}"
        )
    if not pending:
        raise CoffError("the COFF object contains no relocations to translate")

    referenced = sorted({symbol_index for _, _, symbol_index in pending})
    additions: list[tuple[str, int, int, int]] = []
    for symbol_index in referenced:
        symbol = elf_symbols[symbol_index]
        if symbol.section_index == SHN_UNDEF:
            if not symbol.name:
                raise CoffError(
                    f"relocation references unnamed undefined ELF symbol "
                    f"{symbol_index}"
                )
            additions.append(
                (
                    symbol.name,
                    symbol.value,
                    0,
                    IMAGE_SYM_CLASS_EXTERNAL,
                )
            )
        elif symbol.section_index == SHN_ABS:
            additions.append(
                (
                    f"e{symbol_index:07x}",
                    symbol.value,
                    -1,
                    IMAGE_SYM_CLASS_STATIC,
                )
            )
        elif symbol.section_index < len(elf_sections):
            elf_section = elf_sections[symbol.section_index]
            coff_section = coff_by_name.get(elf_section.name)
            if coff_section is None:
                raise CoffError(
                    f"ELF symbol {symbol_index} targets omitted section "
                    f"{elf_section.name!r}"
                )
            additions.append(
                (
                    f"e{symbol_index:07x}",
                    symbol.value,
                    coff_section.index,
                    IMAGE_SYM_CLASS_STATIC,
                )
            )
        else:
            raise CoffError(
                f"ELF symbol {symbol_index} uses unsupported section index "
                f"0x{symbol.section_index:04x}"
            )

    coff_data, coff_symbol_indices = append_coff_symbols(coff_data, additions)
    symbol_mapping = dict(zip(referenced, coff_symbol_indices, strict=True))
    patched: Counter[tuple[int, int]] = Counter()
    for coff_record, input_type, elf_symbol_index in pending:
        output_type = ELF_TO_WINCE_RELOCATION[input_type]
        struct.pack_into(
            "<IH",
            coff_data,
            coff_record + 4,
            symbol_mapping[elf_symbol_index],
            output_type,
        )
        patched[(input_type, output_type)] += 1
    verified_branches = verify_wince_branch_addends(coff_data)
    if verified_branches != normalized_branches:
        raise CoffError(
            "normalized/verified ARM branch count differs: "
            f"{normalized_branches}/{verified_branches}"
        )
    return coff_data, patched, len(additions), normalized_branches


def verify_wince_branch_addends(data: bytearray) -> int:
    """Reject an ARM_26 relocation whose instruction still carries an addend."""
    verified = 0
    for section in parse_coff_sections(data):
        for index in range(section.relocation_count):
            record = (
                section.relocation_offset + index * COFF_RELOCATION_SIZE
            )
            if read_u16(data, record + 8) != IMAGE_REL_ARM_BRANCH24:
                continue
            address = read_u32(data, record)
            if address > section.data_size - 4:
                raise CoffError(
                    f"ARM_26 relocation at 0x{address:x} lies outside "
                    f"{section.name!r}"
                )
            instruction = read_u32(data, section.data_offset + address)
            if instruction & 0x0E000000 != 0x0A000000:
                raise CoffError(
                    f"ARM_26 relocation at 0x{address:x} in "
                    f"{section.name!r} references non-branch instruction "
                    f"0x{instruction:08x}"
                )
            if instruction & 0x00FFFFFF:
                raise CoffError(
                    f"ARM_26 relocation at 0x{address:x} in "
                    f"{section.name!r} retains non-zero instruction addend "
                    f"0x{instruction & 0x00FFFFFF:06x}"
                )
            verified += 1
    return verified


def restore_ui_exports(data: bytearray) -> tuple[bytearray, list[str]]:
    section_count = read_u16(data, 2)
    symbol_table = read_u32(data, 8)
    symbol_count = read_u32(data, 12)
    optional_header_size = read_u16(data, 16)
    section_table = COFF_HEADER_SIZE + optional_header_size
    string_table = symbol_table + symbol_count * COFF_SYMBOL_SIZE

    checked_range(
        data,
        symbol_table,
        symbol_count * COFF_SYMBOL_SIZE,
        "COFF symbol table",
    )
    checked_range(data, string_table, 4, "COFF string table")
    string_table_size = read_u32(data, string_table)
    if string_table_size < 4:
        raise CoffError(f"invalid COFF string-table size {string_table_size}")
    checked_range(data, string_table, string_table_size, "COFF string table")
    string_table_end = string_table + string_table_size

    existing_symbols: set[str] = set()
    symbol_index = 0
    while symbol_index < symbol_count:
        record = symbol_table + symbol_index * COFF_SYMBOL_SIZE
        if data[record + 16] == IMAGE_SYM_CLASS_EXTERNAL:
            existing_symbols.add(
                symbol_name(data, record, string_table, string_table_end)
            )
        auxiliary_count = data[record + 17]
        symbol_index += 1 + auxiliary_count
    if symbol_index != symbol_count:
        raise CoffError("COFF auxiliary symbol records exceed the symbol table")

    ui_sections: dict[str, int] = {}
    for section_index in range(section_count):
        header = section_table + section_index * COFF_SECTION_SIZE
        name = section_name(data, header, string_table, string_table_end)
        if name.startswith(".text.ui_"):
            ui_sections[name.removeprefix(".text.")] = section_index + 1

    missing = sorted(set(ui_sections) - existing_symbols)
    if not missing:
        return data, []

    strings = bytearray(data[string_table:string_table_end])
    string_offsets: dict[str, int] = {}
    cursor = 4
    while cursor < len(strings):
        end = strings.find(b"\0", cursor)
        if end < 0:
            end = len(strings)
        string_offsets[bytes(strings[cursor:end]).decode("ascii")] = cursor
        cursor = end + 1
    if strings[-1] != 0:
        strings.append(0)

    added_symbols = bytearray()
    for name in missing:
        encoded = name.encode("ascii")
        if len(encoded) <= 8:
            name_field = encoded.ljust(8, b"\0")
        else:
            offset = string_offsets.get(name)
            if offset is None:
                offset = len(strings)
                strings.extend(encoded)
                strings.append(0)
                string_offsets[name] = offset
            name_field = b"\0\0\0\0" + struct.pack("<I", offset)
        added_symbols.extend(name_field)
        added_symbols.extend(
            struct.pack(
                "<IhHBB",
                0,
                ui_sections[name],
                0,
                IMAGE_SYM_CLASS_EXTERNAL,
                0,
            )
        )

    struct.pack_into("<I", strings, 0, len(strings))
    new_symbol_count = symbol_count + len(missing)
    struct.pack_into("<I", data, 12, new_symbol_count)
    rebuilt = (
        data[:string_table]
        + added_symbols
        + strings
        + data[string_table_end:]
    )
    return rebuilt, missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("elf_input", type=Path)
    parser.add_argument("coff_input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    elf_data = args.elf_input.read_bytes()
    data = bytearray(args.coff_input.read_bytes())
    data, patched, mapped_symbols, normalized_branches = remap_relocations(
        elf_data, data
    )
    data, restored = restore_ui_exports(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(data)

    summary = ", ".join(
        f"{source}->{target}: {count}"
        for (source, target), count in sorted(patched.items())
    )
    print(f"patched {sum(patched.values())} ARM relocations ({summary})")
    print(
        f"normalized and verified {normalized_branches} "
        "WinCE ARM_26 branch addends"
    )
    print(f"mapped {mapped_symbols} ELF relocation symbols")
    print(f"restored {len(restored)} PocketJS C ABI exports")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
