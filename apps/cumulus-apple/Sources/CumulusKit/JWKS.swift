import Foundation

/// RSA key from a JWKS document. Cognito publishes these at the user-pool JWKS URL.
public struct JSONWebKey: Equatable, Sendable {
    public var kid: String?
    public var kty: String
    public var alg: String?
    public var use: String?
    public var modulus: Data
    public var exponent: Data

    public init(kid: String?, kty: String, alg: String?, use: String?, modulus: Data, exponent: Data) {
        self.kid = kid
        self.kty = kty
        self.alg = alg
        self.use = use
        self.modulus = modulus
        self.exponent = exponent
    }
}

public struct JWKS: Equatable, Sendable {
    public var keys: [JSONWebKey]

    public init(keys: [JSONWebKey]) {
        self.keys = keys
    }

    public static func parse(_ data: Data) throws -> JWKS {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = object["keys"] as? [[String: Any]] else {
            throw CumulusError.decode("The JWKS document could not be read.")
        }
        var keys: [JSONWebKey] = []
        for item in list {
            let kty = item["kty"] as? String ?? ""
            guard kty == "RSA",
                  let n = item["n"] as? String, let modulus = Base64URL.decode(n),
                  let e = item["e"] as? String, let exponent = Base64URL.decode(e) else {
                continue
            }
            keys.append(JSONWebKey(
                kid: item["kid"] as? String,
                kty: kty,
                alg: item["alg"] as? String,
                use: item["use"] as? String,
                modulus: modulus,
                exponent: exponent
            ))
        }
        if keys.isEmpty { throw CumulusError.oidc("The JWKS document has no RSA keys.") }
        return JWKS(keys: keys)
    }

    func rsaSigningKey(kid: String?) throws -> JSONWebKey {
        let usable = keys.filter { key in
            key.kty == "RSA" && key.use != "enc" && (key.alg == nil || key.alg == "RS256")
        }
        if let kid {
            guard let key = usable.first(where: { $0.kid == kid }) else {
                throw CumulusError.oidc("The ID token signing key was not found.")
            }
            return key
        }
        guard usable.count == 1, let key = usable.first else {
            throw CumulusError.oidc("The ID token signing key was not found.")
        }
        return key
    }
}

enum RS256 {
    /// PKCS#1 v1.5 SHA-256. `modulus` and `signature` are unsigned big-endian.
    static func verify(message: Data, signature: Data, modulus: Data, exponent: Data) -> Bool {
        let k = modulus.count
        guard k >= 64, signature.count == k, !exponent.isEmpty else { return false }
        let hash = [UInt8](SHA256.hash(message))
        let prefix: [UInt8] = [
            0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01,
            0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
        ]
        let info = prefix + hash
        guard k >= info.count + 11 else { return false }
        var encoded = [UInt8](repeating: 0xff, count: k)
        encoded[0] = 0x00
        encoded[1] = 0x01
        let separator = k - info.count - 1
        encoded[separator] = 0x00
        for (offset, byte) in info.enumerated() {
            encoded[separator + 1 + offset] = byte
        }
        guard let decoded = Montgomery.exponentiate(base: [UInt8](signature), exponent: [UInt8](exponent), modulus: [UInt8](modulus), width: k) else {
            return false
        }
        return ConstantTime.equal(Data(decoded), Data(encoded))
    }
}

/// Montgomery exponentiation for an odd modulus. Used only for RS256 verification.
enum Montgomery {
    static func exponentiate(base: [UInt8], exponent: [UInt8], modulus: [UInt8], width: Int) -> [UInt8]? {
        let n = Nat(modulus)
        guard n.limbs[0] & 1 == 1 else { return nil }
        let engine = Engine(modulus: n)
        let one = engine.convert(Nat([1]))
        var result = one
        let value = engine.convert(Nat(base))
        let exp = Nat(exponent)
        let bits = exp.bitLength()
        if bits == 0 { return engine.revert(result).bytes(width: width) }
        for index in stride(from: bits - 1, through: 0, by: -1) {
            result = engine.multiply(result, result)
            if exp.bit(index) { result = engine.multiply(result, value) }
        }
        return engine.revert(result).bytes(width: width)
    }

    private struct Engine {
        let n: Nat
        let k: Int
        let n0inv: UInt64

        init(modulus: Nat) {
            n = modulus
            k = modulus.limbs.count
            n0inv = 0 &- Self.inverse(modulus.limbs[0])
        }

        func convert(_ value: Nat) -> Nat {
            var shifted = value
            for _ in 0..<(k * 64) { shifted = shifted.shiftedLeft1() }
            return shifted.remainder(modulo: n)
        }

        func revert(_ value: Nat) -> Nat {
            multiply(value, Nat([1]))
        }

        func multiply(_ lhs: Nat, _ rhs: Nat) -> Nat {
            var t = [UInt64](repeating: 0, count: k * 2 + 2)
            let a = lhs.padded(k)
            let b = rhs.padded(k)
            let mod = n.padded(k)
            for i in 0..<k {
                var carry: UInt64 = 0
                for j in 0..<k {
                    let (hi, lo) = a[i].multipliedFullWidth(by: b[j])
                    let (s1, c1) = t[i + j].addingReportingOverflow(lo)
                    let (s2, c2) = s1.addingReportingOverflow(carry)
                    t[i + j] = s2
                    carry = hi &+ (c1 ? 1 : 0) &+ (c2 ? 1 : 0)
                }
                var idx = i + k
                var extra = carry
                while extra != 0 {
                    if idx >= t.count { t.append(0) }
                    let (sum, overflow) = t[idx].addingReportingOverflow(extra)
                    t[idx] = sum
                    extra = overflow ? 1 : 0
                    idx += 1
                }
            }
            for i in 0..<k {
                let m = t[i] &* n0inv
                var carry: UInt64 = 0
                for j in 0..<k {
                    let (hi, lo) = m.multipliedFullWidth(by: mod[j])
                    let (s1, c1) = t[i + j].addingReportingOverflow(lo)
                    let (s2, c2) = s1.addingReportingOverflow(carry)
                    t[i + j] = s2
                    carry = hi &+ (c1 ? 1 : 0) &+ (c2 ? 1 : 0)
                }
                var idx = i + k
                var extra = carry
                while extra != 0 {
                    if idx >= t.count { t.append(0) }
                    let (sum, overflow) = t[idx].addingReportingOverflow(extra)
                    t[idx] = sum
                    extra = overflow ? 1 : 0
                    idx += 1
                }
            }
            var result = Nat(limbs: Array(t[k...]))
            var guardrail = 0
            while result.compare(n) >= 0 && guardrail < 4 {
                result = result.subtracting(n)
                guardrail += 1
            }
            result.normalize()
            return result
        }

        private static func inverse(_ a: UInt64) -> UInt64 {
            var x: UInt64 = 1
            for _ in 0..<6 { x = x &* (2 &- a &* x) }
            return x
        }
    }
}

struct Nat {
    var limbs: [UInt64]

    init(_ bytes: [UInt8]) {
        var padded = bytes
        if padded.isEmpty { padded = [0] }
        while padded.count % 8 != 0 { padded.insert(0, at: 0) }
        var limbs: [UInt64] = []
        var index = padded.count
        while index > 0 {
            index -= 8
            var value: UInt64 = 0
            for offset in 0..<8 { value = (value << 8) | UInt64(padded[index + offset]) }
            limbs.append(value)
        }
        self.limbs = limbs
        normalize()
    }

    init(limbs: [UInt64]) {
        self.limbs = limbs.isEmpty ? [0] : limbs
        normalize()
    }

    mutating func normalize() {
        while limbs.count > 1 && limbs.last == 0 { limbs.removeLast() }
        if limbs.isEmpty { limbs = [0] }
    }

    func padded(_ count: Int) -> [UInt64] {
        var copy = limbs
        if copy.count < count { copy.append(contentsOf: repeatElement(0, count: count - copy.count)) }
        return Array(copy.prefix(count))
    }

    func compare(_ other: Nat) -> Int {
        if limbs.count != other.limbs.count { return limbs.count > other.limbs.count ? 1 : -1 }
        for index in stride(from: limbs.count - 1, through: 0, by: -1) {
            if limbs[index] != other.limbs[index] { return limbs[index] > other.limbs[index] ? 1 : -1 }
        }
        return 0
    }

    func bitLength() -> Int {
        guard let last = limbs.last, last != 0 || limbs.count > 1 else { return limbs == [0] ? 0 : 1 }
        if limbs == [0] { return 0 }
        return (limbs.count - 1) * 64 + (64 - last.leadingZeroBitCount)
    }

    func bit(_ index: Int) -> Bool {
        let limb = index / 64
        guard limb < limbs.count else { return false }
        return (limbs[limb] >> UInt64(index % 64)) & 1 == 1
    }

    func shiftedLeft1() -> Nat {
        var out = [UInt64](repeating: 0, count: limbs.count + 1)
        var carry: UInt64 = 0
        for index in 0..<limbs.count {
            out[index] = (limbs[index] << 1) | carry
            carry = limbs[index] >> 63
        }
        out[limbs.count] = carry
        return Nat(limbs: out)
    }

    func adding(_ other: Nat) -> Nat {
        let count = max(limbs.count, other.limbs.count)
        var out = [UInt64](repeating: 0, count: count + 1)
        var carry: UInt64 = 0
        for index in 0..<count {
            let lhs = index < limbs.count ? limbs[index] : 0
            let rhs = index < other.limbs.count ? other.limbs[index] : 0
            let (s1, c1) = lhs.addingReportingOverflow(rhs)
            let (s2, c2) = s1.addingReportingOverflow(carry)
            out[index] = s2
            carry = (c1 ? 1 : 0) + (c2 ? 1 : 0)
        }
        out[count] = carry
        return Nat(limbs: out)
    }

    func subtracting(_ other: Nat) -> Nat {
        var out = limbs
        var borrow: UInt64 = 0
        for index in 0..<limbs.count {
            let rhs = index < other.limbs.count ? other.limbs[index] : 0
            let (s1, b1) = out[index].subtractingReportingOverflow(rhs)
            let (s2, b2) = s1.subtractingReportingOverflow(borrow)
            out[index] = s2
            borrow = (b1 ? 1 : 0) | (b2 ? 1 : 0)
        }
        return Nat(limbs: out)
    }

    func remainder(modulo modulus: Nat) -> Nat {
        var result = Nat(limbs: [0])
        let bits = bitLength()
        guard bits > 0, modulus.compare(Nat(limbs: [0])) != 0 else { return result }
        for index in stride(from: bits - 1, through: 0, by: -1) {
            result = result.shiftedLeft1()
            if bit(index) { result = result.adding(Nat(limbs: [1])) }
            if result.compare(modulus) >= 0 { result = result.subtracting(modulus) }
        }
        return result
    }

    func bytes(width: Int) -> [UInt8]? {
        var out = [UInt8](repeating: 0, count: width)
        for (index, limb) in limbs.enumerated() {
            for byte in 0..<8 {
                let place = index * 8 + byte
                guard place < width else {
                    if (limb >> UInt64(byte * 8)) & 0xff != 0 { return nil }
                    continue
                }
                out[width - 1 - place] = UInt8((limb >> UInt64(byte * 8)) & 0xff)
            }
        }
        return out
    }
}
