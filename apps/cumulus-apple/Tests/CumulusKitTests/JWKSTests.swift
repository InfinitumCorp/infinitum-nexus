import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import CumulusKit

final class JWKSTests: XCTestCase {
    private let modulus = "tEsbYj2jFfKj3w0XO5wwEUcsRT_oKw8U1psYNbVR8j1c92LAoFYPogAdx8tNxca0RTb1rymypYItRL1jv5ReHnZh7p09VcAAA_Akr6acXyHTiTxd21Wx7KS73kVK1-Ecb8qncpAzpTHeCaOaz33W0zTJPBW2-8fzAtAaNhprcfPnzqOiVH5GIUj5ExD10-wWMDcjE9sV7y0S3kF881V23WvQZAPko0_WN3aYkEpdqWiezkUhBQfro-wSiZsdw-JtZPnM9DZRKfJf0kxw2avZ8XXfw3qKh_max7Uuzt9GUN0wqHiJn97p6A9Unz6Vs9J-RMmk6FeaZBVM0SFQFxCHnw"
    private let exponent = "AQAB"
    private let token = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5IiwidHlwIjoiSldUIn0.eyJpc3MiOiJodHRwczovL2NvZ25pdG8taWRwLnVzLWVhc3QtMS5hbWF6b25hd3MuY29tL3VzLWVhc3QtMV9mUmxNTzdkbmEiLCJzdWIiOiJ1c2VyLTEiLCJhdWQiOiI2MGJlamV0cjJhZ3QybDZuNWdrM3Y5dG1kMiIsImV4cCI6MTcwMDAwMzYwMCwiaWF0IjoxNzAwMDAwMDAwLCJub25jZSI6Im5vbmNlLTEiLCJlbWFpbCI6ImFsZXhAY3VtdWx1c2Nsb3VkLmFwcCIsInRva2VuX3VzZSI6ImlkIn0.FPkAHc5L7gyqeqrf_AVxAz-2f3aQDhmdbEpZR2GSyyCHf4sOqvlkwJLJsXw8pzPMrvKGkzBQ6cFA-83qDj69Kw4toLL1TMCk_-FF95PE6tQMOmvbMFjbOxyp3uyzaE964N6XuLVfdcp-qnf9LV_cCDlnsD8AHywINGPdomNslmpL0yuodRP0wP32qyIeJhCr9lrpHUrfTYFMtlO-tdHJvcniejaxWDnQMqN2-bvmxMD21dtfjh8EVmweUHzUi2LcxK0zlQiVBbkZfPf826N3vJBgZKsDW9B4gHN2A3PeeoGC1HroeJ-BMMXab9oreGV6c_Bcfj4pvmJvYnhUc9-mOg"

    func testMontgomerySmallExponent() {
        let result = Montgomery.exponentiate(base: [7], exponent: [5], modulus: [13], width: 1)
        XCTAssertEqual(result, [11])
    }

    func testRS256AcceptsTheMatchingKeyAndRejectsTampering() throws {
        let keys = try makeJWKS(kid: "test-key")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let claims = try OIDC.validateIDToken(idToken: token, configuration: .production, nonce: "nonce-1", jwks: keys, now: now)
        XCTAssertEqual(claims.subject, "user-1")
        XCTAssertEqual(claims.email, "alex@cumuluscloud.app")
        XCTAssertEqual(claims.audience, ["60bejetr2agt2l6n5gk3v9tmd2"])

        var flipped = token
        let last = flipped.removeLast()
        flipped.append(last == "A" ? "B" : "A")
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: flipped, jwks: keys))

        let other = try makeJWKS(kid: "other-key")
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: token, jwks: other))

        let none = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4In0."
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: none, jwks: keys))
    }

    func testExchangeVerifiesTheIDTokenBeforeStoringIt() async throws {
        let transport = ScriptedTransport()
        transport.handler = { request in
            if request.url?.absoluteString.hasSuffix("/.well-known/jwks.json") == true {
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return (200, try self.makeJWKSData(kid: "test-key"))
            }
            XCTAssertEqual(request.url?.host, "cumulus-id.auth.us-east-1.amazoncognito.com")
            XCTAssertFalse(String(data: request.httpBody ?? Data(), encoding: .utf8)?.contains("client_secret") ?? false)
            let body = #"{"access_token":"access","id_token":"\#(self.token)","token_type":"Bearer","expires_in":3600}"#
            return (200, Data(body.utf8))
        }
        let store = MemoryTokenStore()
        let api = CumulusAPI(configuration: .production, http: HTTPClient(transport: transport), tokens: store)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let signedIn = try await api.exchange(code: "code", verifier: String(repeating: "d", count: 43), nonce: "nonce-1", now: now)
        XCTAssertEqual(signedIn.claims.subject, "user-1")
        XCTAssertEqual(try store.load()?.accessToken, "access")
    }

    func testExchangeDoesNotStoreABadSignature() async throws {
        let transport = ScriptedTransport()
        transport.handler = { request in
            if request.url?.absoluteString.hasSuffix("jwks.json") == true {
                return (200, try self.makeJWKSData(kid: "test-key"))
            }
            var bad = self.token
            let last = bad.removeLast()
            bad.append(last == "A" ? "B" : "A")
            let body = #"{"access_token":"access","id_token":"\#(bad)","token_type":"Bearer","expires_in":3600}"#
            return (200, Data(body.utf8))
        }
        let store = MemoryTokenStore()
        let api = CumulusAPI(configuration: .production, http: HTTPClient(transport: transport), tokens: store)
        do {
            _ = try await api.exchange(code: "code", verifier: String(repeating: "d", count: 43), nonce: "nonce-1", now: Date(timeIntervalSince1970: 1_700_000_000))
            XCTFail("expected a signature failure")
        } catch is CumulusError {
            XCTAssertNil(try store.load())
        }
    }

    private func makeJWKS(kid: String) throws -> JWKS {
        try JWKS.parse(makeJWKSData(kid: kid))
    }

    private func makeJWKSData(kid: String) throws -> Data {
        let json = """
        {"keys":[{"kty":"RSA","kid":"\(kid)","alg":"RS256","use":"sig","n":"\(modulus)","e":"\(exponent)"}]}
        """
        return Data(json.utf8)
    }
}
