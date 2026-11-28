import Foundation

/// RFC 7636 PKCE. The verifier stays on device. The challenge is S256.
public struct PKCE: Equatable, Sendable {
    public let verifier: String
    public let challenge: String

    public init(verifier: String) throws {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        guard verifier.count >= 43, verifier.count <= 128,
              verifier.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            throw CumulusError.pkce("The code verifier must be 43 to 128 unreserved characters.")
        }
        self.verifier = verifier
        let digest = SHA256.hash(Data(verifier.utf8))
        self.challenge = Base64URL.encode(digest)
    }

    public static func generate() throws -> PKCE {
        try PKCE(verifier: Base64URL.encode(SecureRandom.bytes(32)))
    }
}
