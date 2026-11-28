/**
 * Zero-dependency reader for v2ray GeoIPList and GeoSiteList.
 * geoip.dat is CC-BY-SA-4.0 and geosite.dat (dlc.dat) is MIT.
 * Neither file is stored in this repository.
 */

const text = new TextDecoder();

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length && shift <= 28) {
    const byte = buf[i];
    i += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value >>> 0, i];
    shift += 7;
  }
  throw new Error("truncated protobuf varint");
}

export function protobufFields(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const fields = [];
  let i = 0;
  while (i < bytes.length) {
    const [tag, next] = readVarint(bytes, i);
    i = next;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) throw new Error("protobuf field number is missing");
    if (wire === 0) {
      const [value, after] = readVarint(bytes, i);
      i = after;
      fields.push({ field, wire, value });
    } else if (wire === 2) {
      const [len, after] = readVarint(bytes, i);
      i = after;
      if (i + len > bytes.length) throw new Error("truncated protobuf bytes");
      fields.push({ field, wire, value: bytes.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      throw new Error("unsupported protobuf wire type");
    }
    if (i > bytes.length) throw new Error("truncated protobuf field");
  }
  return fields;
}

function asString(value) {
  return text.decode(value);
}

export function decodeGeoIPList(buf) {
  const entries = [];
  for (const field of protobufFields(buf)) {
    if (field.field !== 1 || field.wire !== 2) continue;
    let code = "";
    const cidrs = [];
    let reverse = false;
    for (const inner of protobufFields(field.value)) {
      if (inner.field === 1 && inner.wire === 2) code = asString(inner.value);
      else if (inner.field === 2 && inner.wire === 2) cidrs.push(decodeCidr(inner.value));
      else if (inner.field === 3 && inner.wire === 0) reverse = inner.value !== 0;
    }
    entries.push({ code, cidrs: cidrs.filter(Boolean), reverse });
  }
  return entries;
}

function decodeCidr(buf) {
  let ip = new Uint8Array();
  let prefix = 0;
  let sawPrefix = false;
  for (const field of protobufFields(buf)) {
    if (field.field === 1 && field.wire === 2) ip = field.value;
    else if (field.field === 2 && field.wire === 0) {
      prefix = field.value;
      sawPrefix = true;
    }
  }
  if (ip.length !== 4 && ip.length !== 16) return null;
  if (!sawPrefix) prefix = ip.length * 8;
  if (prefix < 0 || prefix > ip.length * 8) return null;
  return { ip, prefix };
}

const DOMAIN_KIND = ["plain", "regex", "domain", "full"];

export function decodeGeoSiteList(buf) {
  const entries = [];
  for (const field of protobufFields(buf)) {
    if (field.field !== 1 || field.wire !== 2) continue;
    let code = "";
    const domains = [];
    for (const inner of protobufFields(field.value)) {
      if (inner.field === 1 && inner.wire === 2) code = asString(inner.value);
      else if (inner.field === 2 && inner.wire === 2) {
        let kind = "plain";
        let value = "";
        for (const domain of protobufFields(inner.value)) {
          if (domain.field === 1 && domain.wire === 0) kind = DOMAIN_KIND[domain.value] ?? "plain";
          else if (domain.field === 2 && domain.wire === 2) value = asString(domain.value);
        }
        if (value) domains.push({ kind, value });
      }
    }
    entries.push({ code, domains });
  }
  return entries;
}

export function parseIP(input) {
  if (typeof input !== "string" || !input) return null;
  let textIP = input.trim();
  if (textIP.startsWith("[") && textIP.endsWith("]")) textIP = textIP.slice(1, -1);
  const zone = textIP.indexOf("%");
  if (zone >= 0) textIP = textIP.slice(0, zone);
  if (textIP.includes(":")) return parseIPv6(textIP);
  return parseIPv4(textIP);
}

function parseIPv4(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIPv6(value) {
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const expand = (part) => {
    if (part === "") return [];
    return part.split(":").map((group) => {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      return Number.parseInt(group, 16);
    });
  };
  const head = expand(halves[0]);
  if (head.some((group) => group == null)) return null;
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (tail.some((group) => group == null)) return null;
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(missing).fill(0), ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((group, index) => {
    out[index * 2] = group >> 8;
    out[index * 2 + 1] = group & 0xff;
  });
  return out;
}

export function cidrContains(cidr, ip) {
  if (!cidr || !ip || cidr.ip.length !== ip.length) return false;
  const full = Math.floor(cidr.prefix / 8);
  for (let i = 0; i < full; i += 1) if (cidr.ip[i] !== ip[i]) return false;
  const rest = cidr.prefix % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (cidr.ip[full] & mask) === (ip[full] & mask);
}

export function countryForIP(entries, ip) {
  const bytes = typeof ip === "string" ? parseIP(ip) : ip;
  if (!bytes) return null;
  for (const entry of entries) {
    if (entry.reverse) continue;
    if (entry.cidrs.some((cidr) => cidrContains(cidr, bytes))) return entry.code;
  }
  return null;
}

const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function hostsInCategories(entries, categories, { rejectOnion = false } = {}) {
  const wanted = new Set((categories ?? []).map((category) => String(category).toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return [];
  const hosts = [];
  for (const entry of entries) {
    if (!wanted.has(String(entry.code).toLowerCase())) continue;
    for (const domain of entry.domains) {
      if (domain.kind !== "domain" && domain.kind !== "full") continue;
      const value = String(domain.value).trim().toLowerCase().replace(/\.$/, "");
      if (!value || !HOST.test(value)) continue;
      if (rejectOnion && (value === "onion" || value.endsWith(".onion"))) continue;
      hosts.push(value);
    }
  }
  return [...new Set(hosts)].sort();
}

export function isOnionHost(host) {
  const value = String(host ?? "").trim().toLowerCase().replace(/\.$/, "");
  return value === "onion" || value.endsWith(".onion");
}
