/**
 * Deterministic zip (no extra fields) and ustar archives.
 * Entry names are sorted by raw bytes. Timestamps come from SOURCE_DATE_EPOCH.
 * Host uid, gid, and the current clock are not recorded.
 *
 *   node scripts/archive.js pack --base DIR --out FILE --format zip|tar --epoch SECONDS [-- REL...]
 *   node scripts/archive.js manifest --dir DIR --out FILE [--exclude GLOB]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, constants, deflateRawSync } from "node:zlib";
import { NODE_VERSION } from "./toolchain.js";

const ZIP_UTF8_FLAG = 0;
const DOS_EPOCH_MIN = Date.UTC(1980, 0, 1) / 1000;
const DOS_EPOCH_MAX = Date.UTC(2107, 11, 31, 23, 59, 58) / 1000;

export function assertNodeToolchain() {
  if (process.versions.node !== NODE_VERSION) {
    throw new Error(`VEIL reproducible builds require Node ${NODE_VERSION} (running ${process.versions.node})`);
  }
}

export function parseEpoch(value) {
  const epoch = typeof value === "number" ? value : Number(value);
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    throw new Error("SOURCE_DATE_EPOCH must be a non-negative integer");
  }
  if (!Number.isInteger(epoch) || epoch < DOS_EPOCH_MIN || epoch > DOS_EPOCH_MAX) {
    throw new Error(`SOURCE_DATE_EPOCH ${value} is outside the ZIP DOS range 1980-01-01 through 2107-12-31`);
  }
  return epoch;
}

export function resolveSourceDateEpoch(cwd) {
  if (process.env.SOURCE_DATE_EPOCH) return parseEpoch(process.env.SOURCE_DATE_EPOCH);
  return parseEpoch(git(cwd, ["log", "-1", "--format=%ct"]));
}

export function gitHead(cwd) {
  return git(cwd, ["rev-parse", "HEAD"]);
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || "").trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

export function compareNames(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export function dosDateTime(epoch) {
  const date = new Date(parseEpoch(epoch) * 1000);
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { dosTime, dosDate };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertPortableName(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
    throw new Error(`archive path is not portable: ${name}`);
  }
}

export function collectEntries(base, rels = []) {
  const entries = new Map();
  const roots = rels.length ? rels : [""];
  for (const rel of roots) walk(base, normalizeRel(rel));
  return [...entries.values()].sort((a, b) => compareNames(a.name, b.name));

  function walk(root, rel) {
    const abs = rel ? join(root, rel) : root;
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) throw new Error(`refusing to archive symlink ${rel || abs} -> ${readlinkSync(abs)}`);
    if (stat.isDirectory()) {
      if (rel) {
        const name = `${rel}/`;
        assertPortableName(name.slice(0, -1));
        entries.set(name, { name, directory: true, mode: 0o755 });
      }
      for (const child of readdirSync(abs)) walk(root, rel ? `${rel}/${child}` : child);
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported file type: ${rel || abs}`);
    assertPortableName(rel);
    const executable = (stat.mode & 0o111) !== 0;
    entries.set(rel, {
      name: rel,
      directory: false,
      mode: executable ? 0o755 : 0o644,
      data: readFileSync(abs),
    });
  }
}

function normalizeRel(rel) {
  const cleaned = rel.split("/").filter((part) => part && part !== ".").join("/");
  if (rel.split("/").includes("..")) throw new Error(`archive path is not portable: ${rel}`);
  return cleaned;
}

function compress(data) {
  if (data.length === 0) return { method: 0, payload: data, crc: 0 };
  return {
    method: 8,
    payload: deflateRawSync(data, { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY }),
    crc: crc32(data) >>> 0,
  };
}

function externalAttr(entry) {
  const mode = entry.directory ? 0o040755 : entry.mode === 0o755 ? 0o100755 : 0o100644;
  const dos = entry.directory ? 0x10 : 0x00;
  return ((mode << 16) | dos) >>> 0;
}

export function writeZip(entries, epoch) {
  const { dosTime, dosDate } = dosDateTime(epoch);
  const prepared = entries.map((entry) => {
    assertPortableName(entry.directory ? entry.name.slice(0, -1) : entry.name);
    const data = entry.directory ? Buffer.alloc(0) : entry.data;
    const compressed = entry.directory ? { method: 0, payload: data, crc: 0 } : compress(data);
    return { ...entry, size: data.length, ...compressed };
  });
  const chunks = [];
  let offset = 0;
  const locals = [];
  for (const entry of prepared) {
    const name = Buffer.from(entry.name, "utf8");
    if (name.length > 0xffff) throw new Error(`zip name too long: ${entry.name}`);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(entry.crc >>> 0, 14);
    header.writeUInt32LE(entry.payload.length, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    name.copy(header, 30);
    locals.push({ entry, offset });
    chunks.push(header, entry.payload);
    offset += header.length + entry.payload.length;
  }
  const centralStart = offset;
  if (prepared.length > 0xffff) throw new Error("zip has too many entries");
  for (const { entry, offset: localOffset } of locals) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(entry.crc >>> 0, 16);
    header.writeUInt32LE(entry.payload.length, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(externalAttr(entry), 38);
    header.writeUInt32LE(localOffset, 42);
    name.copy(header, 46);
    chunks.push(header);
    offset += header.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(prepared.length, 8);
  eocd.writeUInt16LE(prepared.length, 10);
  eocd.writeUInt32LE(offset - centralStart, 12);
  eocd.writeUInt32LE(centralStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

function splitUstar(name) {
  const length = Buffer.byteLength(name);
  if (length <= 100) return { name, prefix: "" };
  if (length > 256) throw new Error(`tar path too long: ${name}`);
  for (let index = name.length - 1; index >= 0; index -= 1) {
    if (name[index] !== "/") continue;
    const prefix = name.slice(0, index);
    const rest = name.slice(index + 1);
    if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155 && rest.length > 0) {
      return { name: rest, prefix };
    }
  }
  throw new Error(`tar path cannot be split into ustar fields: ${name}`);
}

function writeOctal(buffer, offset, value, width) {
  const digits = value.toString(8).padStart(width - 1, "0");
  if (digits.length > width - 1) throw new Error(`tar field cannot hold ${value}`);
  buffer.write(digits, offset, "ascii");
  buffer[offset + width - 1] = 0;
}

function tarHeader(name, size, epoch, mode, type) {
  const parts = splitUstar(name);
  const header = Buffer.alloc(512, 0);
  header.write(parts.name, 0, "utf8");
  writeOctal(header, 100, mode, 8);
  writeOctal(header, 108, 0, 8);
  writeOctal(header, 116, 0, 8);
  writeOctal(header, 124, size, 12);
  writeOctal(header, 136, epoch, 12);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.write("ustar", 257, "ascii");
  header[262] = 0;
  header.write("00", 263, "ascii");
  if (parts.prefix) header.write(parts.prefix, 345, "utf8");
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0");
  header.write(checksum, 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

export function writeTar(entries, epoch) {
  parseEpoch(epoch);
  const chunks = [];
  for (const entry of entries) {
    const data = entry.directory ? Buffer.alloc(0) : entry.data;
    const mode = entry.directory ? 0o755 : entry.mode === 0o755 ? 0o755 : 0o644;
    const type = entry.directory ? "5" : "0";
    chunks.push(tarHeader(entry.name, data.length, epoch, mode, type));
    if (data.length) {
      chunks.push(data);
      const padding = (512 - (data.length % 512)) % 512;
      if (padding) chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function readZip(buffer) {
  if (buffer.length < 22) throw new Error("zip is too small");
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip is missing its central directory");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buffer.readUInt16LE(cursor + 10);
    const dosTime = buffer.readUInt16LE(cursor + 12);
    const dosDate = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const external = buffer.readUInt32LE(cursor + 38);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    entries.push({ name, method, dosTime, dosDate, crc, compSize, size, extraLength, commentLength, external });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readOctal(buffer, offset, width) {
  const text = buffer.toString("ascii", offset, offset + width).replace(/\0.*/, "").trim();
  if (!text) return 0;
  return Number.parseInt(text, 8);
}

function cString(buffer, offset, width) {
  const end = buffer.indexOf(0, offset);
  const stop = end < 0 || end > offset + width ? offset + width : end;
  return buffer.toString("utf8", offset, stop);
}

export function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    const prefix = cString(header, 345, 155);
    const shortName = cString(header, 0, 100);
    const name = prefix ? `${prefix}/${shortName}` : shortName;
    const size = readOctal(header, 124, 12);
    const mtime = readOctal(header, 136, 12);
    const mode = readOctal(header, 100, 8);
    const type = String.fromCharCode(header[156]);
    const data = buffer.subarray(offset, offset + size);
    entries.push({ name, size, mtime, mode, type, data });
    offset += size;
    offset += (512 - (size % 512)) % 512;
  }
  return entries;
}

export function packDirectory(base, epoch, format, rels = []) {
  const entries = collectEntries(base, rels);
  if (format === "zip") return writeZip(entries, epoch);
  if (format === "tar") return writeTar(entries, epoch);
  throw new Error(`unknown archive format ${format}`);
}

function excluded(rel, patterns) {
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) return rel.endsWith(pattern.slice(1));
    if (pattern.endsWith("/")) return rel === pattern.slice(0, -1) || rel.startsWith(pattern);
    return rel === pattern;
  });
}

export function listFiles(dir, patterns = []) {
  const files = [];
  function walk(abs, rel) {
    for (const name of readdirSync(abs).sort(compareNames)) {
      const child = rel ? `${rel}/${name}` : name;
      if (excluded(child, patterns)) continue;
      const stat = lstatSync(join(abs, name));
      if (stat.isSymbolicLink()) throw new Error(`refusing to hash symlink ${child}`);
      if (stat.isDirectory()) walk(join(abs, name), child);
      else if (stat.isFile()) files.push(child);
      else throw new Error(`unsupported file type: ${child}`);
    }
  }
  walk(dir, "");
  return files.sort(compareNames);
}

export function manifestText(dir, files) {
  const lines = files.map((file) => `${sha256(readFileSync(join(dir, file)))}  ${file}`);
  return `${lines.join("\n")}\n`;
}

export function writeSha256Manifest(dir, outName = "SHA256SUMS", patterns = []) {
  const excludes = [...patterns, outName];
  const text = manifestText(dir, listFiles(dir, excludes));
  writeFileSync(join(dir, outName), text);
  return text;
}

function parseArgs(argv) {
  const args = { _: [], exclude: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--exclude") {
      args.exclude.push(argv[++index]);
      continue;
    }
    if (arg.startsWith("--")) {
      const value = argv[++index];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      args[arg.slice(2)] = value;
      continue;
    }
    args._.push(arg);
  }
  return args;
}

function main() {
  assertNodeToolchain();
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "pack") {
    const epoch = parseEpoch(args.epoch ?? process.env.SOURCE_DATE_EPOCH);
    const bytes = packDirectory(resolve(args.base), epoch, args.format, args._);
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), bytes);
    return;
  }
  if (command === "manifest") {
    const dir = resolve(args.dir);
    const out = resolve(args.out ?? join(dir, "SHA256SUMS"));
    const patterns = [...args.exclude];
    if (out.startsWith(dir + sep)) patterns.push(relative(dir, out));
    writeSha256Manifest(dir, relative(dir, out), patterns);
    return;
  }
  throw new Error("usage: archive.js pack|manifest");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
