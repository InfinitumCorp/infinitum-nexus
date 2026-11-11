import XCTest
@testable import CumulusKit

final class OIDCTests: XCTestCase {
    func testProductionAuthorizationURL() throws {
        let request = try OIDC.authorizationRequest(configuration: .production, pkce: try PKCE(verifier: String(repeating: "b", count: 50)))
        let parts = URLComponents(url: request.url, resolvingAgainstBaseURL: false)
        XCTAssertEqual(parts?.scheme, "https")
        XCTAssertEqual(parts?.host, "cumulus-id.auth.us-east-1.amazoncognito.com")
        XCTAssertEqual(parts?.path, "/oauth2/authorize")
        let query = Dictionary(uniqueKeysWithValues: (parts?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["client_id"], "60bejetr2agt2l6n5gk3v9tmd2")
        XCTAssertEqual(query["response_type"], "code")
        XCTAssertEqual(query["code_challenge_method"], "S256")
        XCTAssertEqual(query["redirect_uri"], "cumulus://oauth/callback")
        XCTAssertEqual(query["code_challenge"], request.verifier.isEmpty ? "" : Base64URL.encode(SHA256.hash(Data(request.verifier.utf8))))
        XCTAssertFalse(query["state"]!.isEmpty)
        XCTAssertFalse(query["nonce"]!.isEmpty)
        XCTAssertFalse(request.url.absoluteString.contains("client_secret"))
    }

    func testCognitoAuthorizationURL() throws {
        let configuration = try CumulusConfiguration(
            idOrigin: URL(string: "https://id.cumuluscloud.app")!,
            issuer: URL(string: "https://id.cumuluscloud.app/realms/cumulus")!,
            clientID: "cumulus-apple",
            redirectURI: URL(string: "cumulus://oauth/callback")!,
            scopes: ["openid", "email", "profile"],
            mailAPI: URL(string: "https://mail.cumuluscloud.app")!,
            cloudAPI: URL(string: "https://cloud.cumuluscloud.app")!,
            exchangeAPI: URL(string: "https://cloud.cumuluscloud.app")!,
            downloadPage: URL(string: "https://cumuluscloud.app")!,
            cognitoDomain: "cumulus-id.auth.us-east-1.amazoncognito.com",
            cognitoRegion: "us-east-1",
            cognitoUserPoolID: "us-east-1_example"
        )
        XCTAssertTrue(configuration.usesCognito)
        XCTAssertEqual(configuration.authorizationEndpoint.absoluteString, "https://cumulus-id.auth.us-east-1.amazoncognito.com/oauth2/authorize")
        XCTAssertEqual(configuration.tokenEndpoint.path, "/oauth2/token")
        XCTAssertEqual(configuration.expectedIssuer, "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example")
        let request = try OIDC.authorizationRequest(configuration: configuration, pkce: try PKCE.generate())
        XCTAssertEqual(request.url.host, "cumulus-id.auth.us-east-1.amazoncognito.com")
    }

    func testTokenFormHasNoSecret() throws {
        let form = OIDC.tokenForm(configuration: .production, code: "abc", verifier: String(repeating: "c", count: 43))
        XCTAssertTrue(form.contains("grant_type=authorization_code"))
        XCTAssertTrue(form.contains("code_verifier="))
        XCTAssertFalse(form.contains("client_secret"))
    }

    func testCallbackChecksState() throws {
        let url = URL(string: "cumulus://oauth/callback?code=one-time&state=expected")!
        XCTAssertEqual(try OIDC.parseCallback(url, expectedState: "expected"), "one-time")
        XCTAssertThrowsError(try OIDC.parseCallback(url, expectedState: "other"))
        let cancelled = URL(string: "cumulus://oauth/callback?error=access_denied&error_description=Sign-in%20was%20cancelled.&state=expected")!
        XCTAssertThrowsError(try OIDC.parseCallback(cancelled, expectedState: "expected"))
    }

    func testTokenResponse() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let json = #"{"access_token":"access","refresh_token":"refresh","id_token":"id","token_type":"Bearer","expires_in":3600,"scope":"openid"}"#
        let tokens = try OIDC.parseTokenResponse(Data(json.utf8), now: now)
        XCTAssertEqual(tokens.accessToken, "access")
        XCTAssertEqual(tokens.refreshToken, "refresh")
        XCTAssertEqual(tokens.expiresAt, now.addingTimeInterval(3600))
        let error = #"{"error":"invalid_grant","error_description":"Code expired."}"#
        XCTAssertThrowsError(try OIDC.parseTokenResponse(Data(error.utf8)))
    }

    func testClaimChecks() throws {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let token = jwt(alg: "RS256", payload: [
            "iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna",
            "sub": "cid:alex",
            "aud": "60bejetr2agt2l6n5gk3v9tmd2",
            "exp": 1_700_000_600,
            "iat": 1_700_000_000,
            "nonce": "nonce-1",
            "email": "alex@cumuluscloud.app",
            "name": "Alex Reid",
            "token_use": "id",
        ])
        let claims = try OIDC.checkClaims(idToken: token, configuration: .production, nonce: "nonce-1", now: now)
        XCTAssertEqual(claims.subject, "cid:alex")
        XCTAssertEqual(claims.email, "alex@cumuluscloud.app")
        XCTAssertThrowsError(try OIDC.checkClaims(idToken: token, configuration: .production, nonce: "other", now: now))
        let none = jwt(alg: "none", payload: ["iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna", "sub": "x", "aud": "60bejetr2agt2l6n5gk3v9tmd2", "exp": 1_700_000_600, "token_use": "id"])
        XCTAssertThrowsError(try OIDC.checkClaims(idToken: none, configuration: .production, nonce: nil, now: now))
        let expired = jwt(alg: "RS256", payload: ["iss": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna", "sub": "x", "aud": "60bejetr2agt2l6n5gk3v9tmd2", "exp": 1_600_000_000, "token_use": "id"])
        XCTAssertThrowsError(try OIDC.checkClaims(idToken: expired, configuration: .production, nonce: nil, now: now))
    }

    func testMemoryTokenStore() throws {
        let store = MemoryTokenStore()
        XCTAssertNil(try store.load())
        try store.save(TokenSet(accessToken: "a", refreshToken: "r"))
        XCTAssertEqual(try store.load()?.accessToken, "a")
        try store.clear()
        XCTAssertNil(try store.load())
    }

    private func jwt(alg: String, payload: [String: Any]) -> String {
        func part(_ object: [String: Any]) -> String {
            let data = try! JSONSerialization.data(withJSONObject: object)
            return Base64URL.encode(data)
        }
        return part(["alg": alg, "typ": "JWT"]) + "." + part(payload) + ".signature"
    }
}
