function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varint(value) {
  const bytes = [];
  let n = value >>> 0;
  while (n > 127) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}

function key(field, wire) {
  return varint((field << 3) | wire);
}

function bytesField(field, payload) {
  const body = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload);
  return concat([key(field, 2), varint(body.length), body]);
}

function varintField(field, value) {
  return concat([key(field, 0), varint(value)]);
}

function cidr(ip, prefix) {
  return concat([bytesField(1, ip), varintField(2, prefix)]);
}

function geoip(code, ranges, reverse = false) {
  const parts = [bytesField(1, code)];
  for (const range of ranges) parts.push(bytesField(2, cidr(range.ip, range.prefix)));
  if (reverse) parts.push(varintField(3, 1));
  return bytesField(1, concat(parts));
}

function domain(kind, value) {
  return bytesField(2, concat([varintField(1, kind), bytesField(2, value)]));
}

function geosite(code, domains) {
  const parts = [bytesField(1, code), ...domains.map((item) => domain(item.kind, item.value))];
  return bytesField(1, concat(parts));
}

export function sampleGeoIP() {
  return concat([
    geoip("ZZ", [{ ip: Uint8Array.from([203, 0, 113, 0]), prefix: 24 }]),
    geoip("QQ", [{ ip: Uint8Array.from([198, 51, 100, 8]), prefix: 32 }], true),
  ]);
}

export function sampleGeoSite() {
  return concat([
    geosite("category-ads", [
      { kind: 2, value: "tracker.example" },
      { kind: 0, value: "not-a-host" },
      { kind: 1, value: ".*" },
    ]),
    geosite("direct", [
      { kind: 2, value: "direct.example" },
      { kind: 3, value: "Hidden.Onion" },
      { kind: 2, value: "also.onion." },
    ]),
  ]);
}
