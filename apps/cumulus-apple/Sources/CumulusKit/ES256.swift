import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

/// ECDSA P-256 with SHA-256 (JWS `ES256`), the algorithm Cumulus://ID signs ID tokens with.
/// The JWS signature is the raw 64-byte `r || s`. Uses CryptoKit, which every Apple platform
/// this app ships on has. Where CryptoKit is missing (the Linux unit-test runner) it fails closed.
enum ES256 {
    static var isAvailable: Bool {
        #if canImport(CryptoKit)
        return true
        #else
        return false
        #endif
    }

    static func verify(message: Data, signature: Data, x: Data, y: Data) -> Bool {
        guard signature.count == 64, x.count == 32, y.count == 32 else { return false }
        #if canImport(CryptoKit)
        guard let key = try? P256.Signing.PublicKey(rawRepresentation: x + y),
              let parsed = try? P256.Signing.ECDSASignature(rawRepresentation: signature) else {
            return false
        }
        return key.isValidSignature(parsed, for: message)
        #else
        return false
        #endif
    }
}
