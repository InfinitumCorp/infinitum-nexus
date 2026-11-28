import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import CumulusKit

final class JWKSTests: XCTestCase {
    private let modulus = "0pWMfLbGPMlInM0wC96OrsLCQGbKNV7vjKKkVpcyNe88UuJ7miotYKWFvfcrcb52heMrkOEBi8HGoKXXEf2B9VWMthUqNM0rejwt8XuF6zKXJMoJmewaOXlcUZ-PDkmCeukcSDP3tvNlYrSOqHBLmSAJrhwmugY7Uf1EdyccC7stOZqL8fr7z2qnphcz-fCImsEnxDs3x6p-4-LeIsulWaEaVVEYTe8nEHhTe5Kt_F_D0e_lOKdtbdutru4PB68Pqfulab2WUib2_d9Cy4b3OfZl9-7QzbaErnH5xYtzomXtiad2MeQ3y81JGiik-zsQr7ax2ezWaBO8ifaGWA2qsw"
    private let exponent = "AQAB"
    private let token = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2V5IiwidHlwIjoiSldUIn0.eyJpc3MiOiJodHRwczovL2lkLmN1bXVsdXNjbG91ZC5hcHAvcmVhbG1zL2N1bXVsdXMiLCJzdWIiOiJjaWRfN2YxYzJlNjQtMGQzYi00YzU1LTlhNTEtMmE2YTRiMWQ5ZTAxIiwiYXVkIjoiY3VtdWx1cy1hcHBsZSIsImV4cCI6MTcwMDAwMzYwMCwiaWF0IjoxNzAwMDAwMDAwLCJub25jZSI6Im5vbmNlLTEiLCJlbWFpbCI6ImFsZXhAY3VtdWx1c2Nsb3VkLmFwcCJ9.hGs_HJpbgeu9qNTYjgBEmMWT7gRmRbgiGTandfcm9uyqACMR2ym4qf876wgf-YIWrGGDpyaZaLp3RV3u8MjC6yHxIXM5Fvzv5wFbzsk6SREHd_JrmWtc7BE4AZ0Z6d5-VXqgGLQr2Vf7IQ1t9m99MMN8xvqF9fylfMnzr3NVFOiRTJ5J9ilav2diCFdLjtIL07FPDUZyoDvBoHHxhF-AZsSCiAEaMrcrFzpl69d3g2jvzSxK2iR6U5IskCZZQYWAQMBbTB6kdjL24fmAhjgBn4j3QQwtYvl2EruASqjZXUG6hp7ihaLGYfUKrhnfDPzQRLiHQaSL9m-80RpwB8Id5w"
    private let ecX = "wNXbC1hchHlwORWo3HcnRFCOTyeU5_-6oOHPeoX9PJY"
    private let ecY = "QGEFkkSU4-DTDwtlF8DbKRyvGgfryrfp9tcReGYc104"
    private let esToken = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImNpZC1lcyIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2lkLmN1bXVsdXNjbG91ZC5hcHAvcmVhbG1zL2N1bXVsdXMiLCJzdWIiOiJjaWRfN2YxYzJlNjQtMGQzYi00YzU1LTlhNTEtMmE2YTRiMWQ5ZTAxIiwiYXVkIjoiY3VtdWx1cy1hcHBsZSIsImV4cCI6MTcwMDAwMzYwMCwiaWF0IjoxNzAwMDAwMDAwLCJub25jZSI6Im5vbmNlLTEiLCJlbWFpbCI6ImFsZXhAY3VtdWx1c2Nsb3VkLmFwcCJ9.MKzBcbOoy4jmPnlbjxud8RNlRgAEuMaiCnEKq9bQuMLDJt-g7yHH-6Lh6sp6WphBqYYHpr0mz0eghwmHZjXY-g"

    func testMontgomerySmallExponent() {
        let result = Montgomery.exponentiate(base: [7], exponent: [5], modulus: [13], width: 1)
        XCTAssertEqual(result, [11])
    }

    func testRS256AcceptsTheMatchingKeyAndRejectsTampering() throws {
        let keys = try makeJWKS(kid: "test-key")
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let claims = try OIDC.validateIDToken(idToken: token, configuration: .production, nonce: "nonce-1", jwks: keys, now: now)
        XCTAssertEqual(claims.subject, "cid_7f1c2e64-0d3b-4c55-9a51-2a6a4b1d9e01")
        XCTAssertEqual(claims.email, "alex@cumuluscloud.app")
        XCTAssertEqual(claims.audience, ["cumulus-apple"])

        var flipped = token
        let last = flipped.removeLast()
        flipped.append(last == "A" ? "B" : "A")
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: flipped, jwks: keys))

        let other = try makeJWKS(kid: "other-key")
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: token, jwks: other))

        let none = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4In0."
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: none, jwks: keys))
    }

    func testES256FromCumulusIDIsVerified() throws {
        let keys = try JWKS.parse(makeECJWKSData(kid: "cid-es"))
        XCTAssertEqual(keys.keys.first?.kty, "EC")
        guard ES256.isAvailable else {
            // Linux runner: no CryptoKit, so ES256 must fail closed rather than pass.
            XCTAssertThrowsError(try OIDC.verifySignature(idToken: esToken, jwks: keys))
            return
        }
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let claims = try OIDC.validateIDToken(idToken: esToken, configuration: .production, nonce: "nonce-1", jwks: keys, now: now)
        XCTAssertEqual(claims.subject, "cid_7f1c2e64-0d3b-4c55-9a51-2a6a4b1d9e01")
        XCTAssertEqual(claims.issuer, "https://id.cumuluscloud.app/realms/cumulus")

        var flipped = esToken
        let last = flipped.removeLast()
        flipped.append(last == "A" ? "B" : "A")
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: flipped, jwks: keys))
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: esToken, jwks: try JWKS.parse(makeECJWKSData(kid: "other"))))
        // An RSA key must never verify an ES256 token, and the reverse.
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: esToken, jwks: try makeJWKS(kid: "cid-es")))
        XCTAssertThrowsError(try OIDC.verifySignature(idToken: token, jwks: try JWKS.parse(makeECJWKSData(kid: "test-key"))))
    }

    func testExchangeVerifiesTheIDTokenBeforeStoringIt() async throws {
        let transport = ScriptedTransport()
        transport.handler = { request in
            if request.url?.absoluteString.hasSuffix("/protocol/openid-connect/certs") == true {
                XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
                return (200, try self.makeJWKSData(kid: "test-key"))
            }
            XCTAssertEqual(request.url?.absoluteString, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/token")
            XCTAssertFalse(String(data: request.httpBody ?? Data(), encoding: .utf8)?.contains("client_secret") ?? false)
            let body = #"{"access_token":"access","id_token":"\#(self.token)","token_type":"Bearer","expires_in":3600}"#
            return (200, Data(body.utf8))
        }
        let store = MemoryTokenStore()
        let api = CumulusAPI(configuration: .production, http: HTTPClient(transport: transport), tokens: store)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let signedIn = try await api.exchange(code: "code", verifier: String(repeating: "d", count: 43), nonce: "nonce-1", now: now)
        XCTAssertEqual(signedIn.claims.subject, "cid_7f1c2e64-0d3b-4c55-9a51-2a6a4b1d9e01")
        XCTAssertEqual(try store.load()?.accessToken, "access")
    }

    func testExchangeDoesNotStoreABadSignature() async throws {
        let transport = ScriptedTransport()
        transport.handler = { request in
            if request.url?.absoluteString.hasSuffix("/protocol/openid-connect/certs") == true {
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

    private func makeECJWKSData(kid: String) -> Data {
        let json = """
        {"keys":[{"kty":"EC","crv":"P-256","kid":"\(kid)","alg":"ES256","use":"sig","x":"\(ecX)","y":"\(ecY)"}]}
        """
        return Data(json.utf8)
    }

    private func makeJWKSData(kid: String) throws -> Data {
        let json = """
        {"keys":[{"kty":"RSA","kid":"\(kid)","alg":"RS256","use":"sig","n":"\(modulus)","e":"\(exponent)"}]}
        """
        return Data(json.utf8)
    }
}
