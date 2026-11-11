import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Authorization-code + PKCE request for Cumulus://ID.
/// The live issuer is Amazon Cognito. A Keycloak realm is used only when the
/// Cognito fields are absent. This client never sends a client secret.
public struct OIDCAuthorization: Equatable, Sendable {
    public let url: URL
    public let verifier: String
    public let state: String
    public let nonce: String
    public let configuration: CumulusConfiguration
}

public struct TokenSet: Codable, Equatable, Sendable {
    public var accessToken: String
    public var refreshToken: String?
    public var idToken: String?
    public var tokenType: String
    public var expiresAt: Date?
    public var scope: String?

    public init(accessToken: String, refreshToken: String? = nil, idToken: String? = nil, tokenType: String = "Bearer", expiresAt: Date? = nil, scope: String? = nil) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.idToken = idToken
        self.tokenType = tokenType
        self.expiresAt = expiresAt
        self.scope = scope
    }

    public func isExpired(at date: Date, skew seconds: TimeInterval = 60) -> Bool {
        guard let expiresAt else { return false }
        return expiresAt.addingTimeInterval(-seconds) <= date
    }
}

public struct IDTokenClaims: Equatable, Sendable {
    public var issuer: String
    public var subject: String
    public var audience: [String]
    public var expiresAt: Date
    public var nonce: String?
    public var email: String?
    public var name: String?
    public var preferredUsername: String?

    public init(issuer: String, subject: String, audience: [String], expiresAt: Date, nonce: String?, email: String?, name: String?, preferredUsername: String?) {
        self.issuer = issuer
        self.subject = subject
        self.audience = audience
        self.expiresAt = expiresAt
        self.nonce = nonce
        self.email = email
        self.name = name
        self.preferredUsername = preferredUsername
    }
}

public enum OIDC {
    public static func authorizationRequest(configuration: CumulusConfiguration, pkce: PKCE? = nil) throws -> OIDCAuthorization {
        let pkce = try pkce ?? PKCE.generate()
        let state = Base64URL.encode(SecureRandom.bytes(32))
        let nonce = Base64URL.encode(SecureRandom.bytes(32))
        guard var components = URLComponents(url: configuration.authorizationEndpoint, resolvingAgainstBaseURL: false) else {
            throw CumulusError.oidc("The authorization endpoint is not a URL.")
        }
        components.queryItems = [
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.redirectURI.absoluteString),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: configuration.scopes.joined(separator: " ")),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let url = components.url else {
            throw CumulusError.oidc("The authorization URL could not be built.")
        }
        return OIDCAuthorization(url: url, verifier: pkce.verifier, state: state, nonce: nonce, configuration: configuration)
    }

    public static func parseCallback(_ url: URL, expectedState: String) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func item(_ name: String) -> String? {
            items.first { $0.name == name }?.value
        }
        if let error = item("error"), !error.isEmpty {
            let description = item("error_description") ?? "Sign-in was cancelled."
            throw CumulusError.oidc(description)
        }
        guard let state = item("state"), ConstantTime.equal(state, expectedState) else {
            throw CumulusError.oidc("The sign-in response did not match this device.")
        }
        guard let code = item("code"), !code.isEmpty else {
            throw CumulusError.oidc("The sign-in response did not include a code.")
        }
        return code
    }

    /// Form body for the token endpoint. Public client: code_verifier, no client_secret.
    public static func tokenForm(configuration: CumulusConfiguration, code: String, verifier: String) -> String {
        form([
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", configuration.redirectURI.absoluteString),
            ("client_id", configuration.clientID),
            ("code_verifier", verifier),
        ])
    }

    public static func refreshForm(configuration: CumulusConfiguration, refreshToken: String) -> String {
        form([
            ("grant_type", "refresh_token"),
            ("refresh_token", refreshToken),
            ("client_id", configuration.clientID),
        ])
    }

    public static func tokenRequest(configuration: CumulusConfiguration, code: String, verifier: String) -> URLRequest {
        var request = URLRequest(url: configuration.tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(tokenForm(configuration: configuration, code: code, verifier: verifier).utf8)
        return request
    }

    public static func refreshRequest(configuration: CumulusConfiguration, refreshToken: String) -> URLRequest {
        var request = URLRequest(url: configuration.tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(refreshForm(configuration: configuration, refreshToken: refreshToken).utf8)
        return request
    }

    public static func parseTokenResponse(_ data: Data, now: Date = Date()) throws -> TokenSet {
        let object = try jsonObject(data)
        if let error = object["error"] as? String {
            let description = object["error_description"] as? String ?? error
            throw CumulusError.oidc(description)
        }
        guard let access = object["access_token"] as? String, !access.isEmpty else {
            throw CumulusError.oidc("The token response did not include an access token.")
        }
        let expiresAt: Date?
        if let seconds = object["expires_in"] as? Int {
            expiresAt = now.addingTimeInterval(TimeInterval(seconds))
        } else if let seconds = object["expires_in"] as? Double {
            expiresAt = now.addingTimeInterval(seconds)
        } else {
            expiresAt = nil
        }
        return TokenSet(
            accessToken: access,
            refreshToken: object["refresh_token"] as? String,
            idToken: object["id_token"] as? String,
            tokenType: (object["token_type"] as? String) ?? "Bearer",
            expiresAt: expiresAt,
            scope: object["scope"] as? String
        )
    }

    /// Verifies the RS256 signature against `jwks`, then checks the claims.
    public static func validateIDToken(
        idToken: String,
        configuration: CumulusConfiguration,
        nonce: String?,
        jwks: JWKS,
        now: Date = Date(),
        clockSkew seconds: TimeInterval = 60
    ) throws -> IDTokenClaims {
        try verifySignature(idToken: idToken, jwks: jwks)
        return try checkClaims(idToken: idToken, configuration: configuration, nonce: nonce, now: now, clockSkew: seconds)
    }

    /// RS256 only. `alg: none` and any other algorithm are rejected. The key id
    /// must match a key in the JWKS.
    public static func verifySignature(idToken: String, jwks: JWKS) throws {
        let parts = idToken.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { throw CumulusError.oidc("The ID token is malformed.") }
        guard let headerData = Base64URL.decode(String(parts[0])),
              let header = try JSONSerialization.jsonObject(with: headerData) as? [String: Any] else {
            throw CumulusError.oidc("The ID token could not be read.")
        }
        guard (header["alg"] as? String) == "RS256" else {
            throw CumulusError.oidc("The ID token algorithm is not allowed.")
        }
        let key = try jwks.rsaSigningKey(kid: header["kid"] as? String)
        guard let signature = Base64URL.decode(String(parts[2])), !signature.isEmpty else {
            throw CumulusError.oidc("The ID token signature could not be read.")
        }
        let message = Data((String(parts[0]) + "." + String(parts[1])).utf8)
        guard RS256.verify(message: message, signature: signature, modulus: key.modulus, exponent: key.exponent) else {
            throw CumulusError.oidc("The ID token signature was not valid.")
        }
    }

    /// Checks the ID token claims. `alg: none` is rejected. Call `validateIDToken`
    /// to check the signature as well.
    public static func checkClaims(
        idToken: String,
        configuration: CumulusConfiguration,
        nonce: String?,
        now: Date = Date(),
        clockSkew seconds: TimeInterval = 60
    ) throws -> IDTokenClaims {
        let parts = idToken.split(separator: ".")
        guard parts.count == 3 else { throw CumulusError.oidc("The ID token is malformed.") }
        guard let headerData = Base64URL.decode(String(parts[0])),
              let payloadData = Base64URL.decode(String(parts[1])),
              let header = try JSONSerialization.jsonObject(with: headerData) as? [String: Any],
              let payload = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any] else {
            throw CumulusError.oidc("The ID token could not be read.")
        }
        let algorithm = header["alg"] as? String ?? ""
        let allowed: Set<String> = ["RS256", "ES256", "EdDSA"]
        if algorithm.isEmpty || algorithm.lowercased() == "none" || !allowed.contains(algorithm) {
            throw CumulusError.oidc("The ID token algorithm is not allowed.")
        }
        guard let issuer = payload["iss"] as? String, !issuer.isEmpty else {
            throw CumulusError.oidc("The ID token has no issuer.")
        }
        let expected = configuration.expectedIssuer.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/")) != expected {
            throw CumulusError.oidc("The ID token issuer was not accepted.")
        }
        let audience: [String]
        if let one = payload["aud"] as? String {
            audience = [one]
        } else if let many = payload["aud"] as? [String] {
            audience = many
        } else {
            audience = []
        }
        guard audience.contains(configuration.clientID) else {
            throw CumulusError.oidc("The ID token was not issued for this app.")
        }
        guard let subject = payload["sub"] as? String, !subject.isEmpty else {
            throw CumulusError.oidc("The ID token has no subject.")
        }
        let exp = number(payload["exp"])
        guard let exp else { throw CumulusError.oidc("The ID token has no expiry.") }
        if Date(timeIntervalSince1970: exp).addingTimeInterval(seconds) < now {
            throw CumulusError.oidc("The ID token has expired.")
        }
        if let nbf = number(payload["nbf"]), Date(timeIntervalSince1970: nbf).addingTimeInterval(-seconds) > now {
            throw CumulusError.oidc("The ID token is not valid yet.")
        }
        let tokenNonce = payload["nonce"] as? String
        if let nonce {
            guard let tokenNonce, ConstantTime.equal(tokenNonce, nonce) else {
                throw CumulusError.oidc("The ID token nonce did not match.")
            }
        }
        if configuration.usesCognito, (payload["token_use"] as? String) != "id" {
            throw CumulusError.oidc("Cognito did not return an ID token.")
        }
        return IDTokenClaims(
            issuer: issuer,
            subject: subject,
            audience: audience,
            expiresAt: Date(timeIntervalSince1970: exp),
            nonce: tokenNonce,
            email: payload["email"] as? String,
            name: payload["name"] as? String,
            preferredUsername: payload["preferred_username"] as? String
        )
    }

    private static func form(_ pairs: [(String, String)]) -> String {
        pairs.map { key, value in
            encode(key) + "=" + encode(value)
        }.joined(separator: "&")
    }

    private static func encode(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private static func jsonObject(_ data: Data) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CumulusError.decode("The response was not a JSON object.")
        }
        return object
    }

    private static func number(_ value: Any?) -> TimeInterval? {
        if let int = value as? Int { return TimeInterval(int) }
        if let double = value as? Double { return double }
        if let number = value as? NSNumber { return number.doubleValue }
        return nil
    }
}
