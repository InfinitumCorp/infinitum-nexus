#!/usr/bin/env python3
"""Make a wixl MSI reproducible.

wixl 0.103 stores the clock and a fresh summary revision. Cabinet bytes follow
the input file mtimes. This rewrites only the summary information stream, in
place, to SOURCE_DATE_EPOCH and a fixed package code.
"""

import argparse
import struct
import sys
from pathlib import Path

OLE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")
# MS-CFB regular sector ids stop at 0xFFFFFFFA. Larger values are end, free, or FAT markers.
MAX_REGULAR_SECTOR = 0xFFFFFFFA
VT_LPSTR = 30
VT_FILETIME = 64
UNIX_TO_FILETIME = 11644473600
SUMMARY_NAME = "\x05SummaryInformation"


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("msi")
    parser.add_argument("--epoch", required=True)
    parser.add_argument("--package-code", required=True)
    return parser.parse_args()


def filetime(epoch):
    if not epoch.isdigit():
        raise SystemExit("SOURCE_DATE_EPOCH must be a non-negative integer")
    ticks = (int(epoch) + UNIX_TO_FILETIME) * 10_000_000
    return struct.pack("<Q", ticks)


def normalize_summary(blob, package_code, stamp):
    data = bytearray(blob)
    byte_order, _version, _system = struct.unpack_from("<HHI", data, 0)
    if byte_order != 0xFFFE:
        raise SystemExit("summary information is not a property set")
    sections = struct.unpack_from("<I", data, 24)[0]
    if sections != 1:
        raise SystemExit("expected one summary section")
    section = struct.unpack_from("<I", data, 44)[0]
    _size, count = struct.unpack_from("<II", data, section)
    found = set()
    revision = "{" + package_code.upper() + "}"
    for index in range(count):
        pid, offset = struct.unpack_from("<II", data, section + 8 + index * 8)
        absolute = section + offset
        kind = struct.unpack_from("<I", data, absolute)[0]
        if pid == 9:
            if kind != VT_LPSTR:
                raise SystemExit("summary revision is not a string")
            length = struct.unpack_from("<I", data, absolute + 4)[0]
            encoded = (revision + "\x00").encode("ascii")
            if length != len(encoded):
                raise SystemExit(f"summary revision length {length} does not fit {revision}")
            data[absolute + 8 : absolute + 8 + length] = encoded
            found.add(pid)
        elif pid in (12, 13):
            if kind != VT_FILETIME:
                raise SystemExit("summary timestamp is not a FILETIME")
            data[absolute + 4 : absolute + 12] = stamp
            found.add(pid)
    if found != {9, 12, 13}:
        raise SystemExit("summary information is missing the revision or timestamps")
    return bytes(data)


class CompoundFile:
    def __init__(self, path):
        self.path = Path(path)
        self.data = bytearray(self.path.read_bytes())
        if self.data[:8] != OLE_SIGNATURE:
            raise SystemExit("MSI is not an OLE compound file")
        self.sector_size = 1 << struct.unpack_from("<H", self.data, 0x1E)[0]
        self.mini_size = 1 << struct.unpack_from("<H", self.data, 0x20)[0]
        self.dir_first = struct.unpack_from("<I", self.data, 0x30)[0]
        self.mini_cutoff = struct.unpack_from("<I", self.data, 0x38)[0]
        self.mini_fat_first = struct.unpack_from("<I", self.data, 0x3C)[0]
        self.num_mini_fat = struct.unpack_from("<I", self.data, 0x40)[0]
        self.fat = self._read_fat()

    def sector_offset(self, sector):
        return (sector + 1) * self.sector_size

    def _read_fat(self):
        count = struct.unpack_from("<I", self.data, 0x2C)[0]
        difat = list(struct.unpack_from("<109I", self.data, 0x4C))
        next_sector = struct.unpack_from("<I", self.data, 0x44)[0]
        remaining = struct.unpack_from("<I", self.data, 0x48)[0]
        while next_sector <= MAX_REGULAR_SECTOR and remaining:
            entries = self._sector_ints(next_sector)
            difat.extend(entries[:-1])
            next_sector = entries[-1]
            remaining -= 1
        fat = []
        for sector in [item for item in difat if item <= MAX_REGULAR_SECTOR][:count]:
            fat.extend(self._sector_ints(sector))
        return fat

    def _sector_ints(self, sector):
        offset = self.sector_offset(sector)
        width = self.sector_size // 4
        return list(struct.unpack_from(f"<{width}I", self.data, offset))

    def chain(self, start):
        sectors = []
        sector = start
        while sector <= MAX_REGULAR_SECTOR:
            if sector in sectors:
                raise SystemExit("OLE sector chain looped")
            sectors.append(sector)
            sector = self.fat[sector]
            if len(sectors) > len(self.fat):
                raise SystemExit("OLE sector chain looped")
        return sectors

    def read_chain(self, start, size):
        blob = bytearray()
        for sector in self.chain(start):
            offset = self.sector_offset(sector)
            blob += self.data[offset : offset + self.sector_size]
        return bytes(blob[:size]), bytes(blob)

    def write_chain(self, start, payload, original):
        sectors = self.chain(start)
        if len(payload) > len(original):
            raise SystemExit("OLE stream grew during normalization")
        updated = bytearray(original)
        updated[: len(payload)] = payload
        for index, sector in enumerate(sectors):
            offset = self.sector_offset(sector)
            chunk = updated[index * self.sector_size : (index + 1) * self.sector_size]
            self.data[offset : offset + self.sector_size] = chunk

    def directory(self):
        raw, _full = self.read_chain(self.dir_first, len(self.chain(self.dir_first)) * self.sector_size)
        entries = []
        for offset in range(0, len(raw), 128):
            entry = raw[offset : offset + 128]
            if len(entry) < 128:
                break
            name_len = struct.unpack_from("<H", entry, 64)[0]
            name = entry[: max(name_len - 2, 0)].decode("utf-16le") if name_len >= 2 else ""
            entries.append(
                {
                    "name": name,
                    "type": entry[66],
                    "start": struct.unpack_from("<I", entry, 116)[0],
                    "size": struct.unpack_from("<Q", entry, 120)[0],
                }
            )
        return entries

    def normalize(self, package_code, stamp):
        entries = self.directory()
        root = next(entry for entry in entries if entry["type"] == 5)
        summary = next(entry for entry in entries if entry["name"] == SUMMARY_NAME)
        if summary["size"] >= self.mini_cutoff:
            current, full = self.read_chain(summary["start"], summary["size"])
            self.write_chain(summary["start"], normalize_summary(current, package_code, stamp), full)
        else:
            mini_fat = []
            sector = self.mini_fat_first
            for _ in range(self.num_mini_fat):
                mini_fat.extend(self._sector_ints(sector))
                sector = self.fat[sector] if sector <= MAX_REGULAR_SECTOR else MAX_REGULAR_SECTOR + 1
            mini_raw, mini_full = self.read_chain(root["start"], root["size"])
            mini = bytearray(mini_full)
            mini[: len(mini_raw)] = mini_raw

            def mini_chain(start):
                chain = []
                item = start
                while item <= MAX_REGULAR_SECTOR:
                    if item in chain:
                        raise SystemExit("OLE mini sector chain looped")
                    chain.append(item)
                    item = mini_fat[item]
                return chain

            def read_mini(start, size):
                blob = bytearray()
                for item in mini_chain(start):
                    blob += mini[item * self.mini_size : (item + 1) * self.mini_size]
                return bytes(blob[:size])

            updated = normalize_summary(read_mini(summary["start"], summary["size"]), package_code, stamp)
            cursor = 0
            for item in mini_chain(summary["start"]):
                piece = updated[cursor : cursor + self.mini_size]
                mini[item * self.mini_size : item * self.mini_size + len(piece)] = piece
                cursor += len(piece)
            self.write_chain(root["start"], bytes(mini[: root["size"]]), mini_full)
        self.path.write_bytes(self.data)


def main():
    args = parse_args()
    code = args.package_code.upper()
    if len(code) != 36 or code.count("-") != 4:
        raise SystemExit("package code must be a GUID")
    compound = CompoundFile(args.msi)
    compound.normalize(code, filetime(args.epoch))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
    except StopIteration:
        sys.exit("MSI is missing a root or summary stream")
