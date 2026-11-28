import XCTest
@testable import CumulusKit

final class CryptoTests: XCTestCase {
    func testSHA256Vectors() {
        XCTAssertEqual(SHA256.hex(Data()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(SHA256.hex(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        let longer = Data("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8)
        XCTAssertEqual(SHA256.hex(longer), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    }

    func testBase64URLRoundTrip() {
        let data = Data([0xfb, 0xff, 0x00, 0x3e])
        let encoded = Base64URL.encode(data)
        XCTAssertFalse(encoded.contains("+"))
        XCTAssertFalse(encoded.contains("/"))
        XCTAssertFalse(encoded.contains("="))
        XCTAssertEqual(Base64URL.decode(encoded), data)
    }

    func testPKCEChallengeIsS256() throws {
        let pkce = try PKCE(verifier: String(repeating: "a", count: 43))
        XCTAssertEqual(pkce.challenge, Base64URL.encode(SHA256.hash(Data(pkce.verifier.utf8))))
        let generated = try PKCE.generate()
        XCTAssertGreaterThanOrEqual(generated.verifier.count, 43)
        XCTAssertLessThanOrEqual(generated.verifier.count, 128)
        XCTAssertNotEqual(generated.verifier, generated.challenge)
    }

    func testPKCERejectsShortVerifier() {
        XCTAssertThrowsError(try PKCE(verifier: "short"))
    }

    func testConstantTimeEqual() {
        XCTAssertTrue(ConstantTime.equal("state-value", "state-value"))
        XCTAssertFalse(ConstantTime.equal("state-value", "state-valuE"))
        XCTAssertFalse(ConstantTime.equal("short", "longer"))
        XCTAssertTrue(ConstantTime.equal(Data(), Data()))
    }
}
