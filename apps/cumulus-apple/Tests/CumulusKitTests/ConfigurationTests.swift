import XCTest
@testable import CumulusKit

final class ConfigurationTests: XCTestCase {
    func testProductionHosts() {
        let configuration = CumulusConfiguration.production
        XCTAssertEqual(configuration.idOrigin.host, "id.cumuluscloud.app")
        XCTAssertEqual(configuration.mailAPI.host, "mail.cumuluscloud.app")
        XCTAssertEqual(configuration.cloudAPI.host, "drive.cumuluscloud.app")
        XCTAssertEqual(configuration.downloadPage.host, "cumuluscloud.app")
        XCTAssertEqual(configuration.clientID, "cumulus-apple")
        XCTAssertEqual(configuration.expectedIssuer, "https://id.cumuluscloud.app/realms/cumulus")
        XCTAssertEqual(configuration.redirectURI.absoluteString, "cumulus://oauth/callback")
        XCTAssertEqual(configuration.authorizationEndpoint.absoluteString, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/auth")
        XCTAssertEqual(configuration.tokenEndpoint.absoluteString, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/token")
        XCTAssertEqual(configuration.jwksURL.absoluteString, "https://id.cumuluscloud.app/realms/cumulus/protocol/openid-connect/certs")
        let text = [
            configuration.idOrigin, configuration.issuer, configuration.mailAPI,
            configuration.cloudAPI, configuration.exchangeAPI, configuration.downloadPage, configuration.redirectURI,
        ].map(\.absoluteString).joined(separator: " ")
        XCTAssertFalse(text.contains("infinitumcorporation.ai"))
        XCTAssertEqual(CumulusBrand.mail.text, "Cumulus://Mail™")
        XCTAssertEqual(CumulusBrand.id.text, "Cumulus://ID™")
        XCTAssertEqual(CumulusBrand.cloud.text, "Cumulus://Cloud™")
        XCTAssertTrue(CumulusBrand.corporation.hasSuffix("®"))
        XCTAssertEqual(CumulusBrand.ink.hex, "#111820")
        XCTAssertEqual(CumulusBrand.accent.hex, "#2454DD")
        XCTAssertEqual(CumulusBrand.paper.hex, "#FFFFFF")
    }

    func testRejectsForbiddenHost() {
        XCTAssertThrowsError(try CumulusConfiguration(
            idOrigin: URL(string: "https://infinitumcorporation.ai")!,
            issuer: URL(string: "https://id.cumuluscloud.app/realms/cumulus")!,
            clientID: "cumulus-apple",
            redirectURI: URL(string: "cumulus://oauth/callback")!,
            scopes: ["openid"],
            mailAPI: URL(string: "https://mail.cumuluscloud.app")!,
            cloudAPI: URL(string: "https://drive.cumuluscloud.app")!,
            exchangeAPI: URL(string: "https://drive.cumuluscloud.app")!,
            downloadPage: URL(string: "https://cumuluscloud.app")!
        ))
    }

    func testEnvironmentOverrides() throws {
        let configuration = try CumulusConfiguration.load(environment: [
            "CUMULUS_MAIL_API": "https://mail.example.test",
            "CUMULUS_COGNITO_DOMAIN": "auth.example.test",
        ])
        XCTAssertEqual(configuration.mailAPI.host, "mail.example.test")
        XCTAssertEqual(configuration.cloudAPI.host, "drive.cumuluscloud.app")
        XCTAssertEqual(configuration.issuer, CumulusConfiguration.production.issuer, "COGNITO variables are ignored")
        XCTAssertEqual(configuration.clientID, "cumulus-apple")
    }

    func testJSONFile() throws {
        let json = """
        {"idOrigin":"https://id.cumuluscloud.app","issuer":"https://id.cumuluscloud.app/realms/cumulus","clientID":"cumulus-apple","redirectURI":"cumulus://oauth/callback","scopes":["openid","email"],"mailAPI":"https://mail.cumuluscloud.app","cloudAPI":"https://drive.cumuluscloud.app","exchangeAPI":"https://drive.cumuluscloud.app","downloadPage":"https://cumuluscloud.app"}
        """
        let configuration = try CumulusConfiguration.load(data: Data(json.utf8))
        XCTAssertEqual(configuration.scopes, ["openid", "email"])
    }

    func testCognitoIssuerIsRejected() {
        XCTAssertThrowsError(try CumulusConfiguration(
            idOrigin: URL(string: "https://id.cumuluscloud.app")!,
            issuer: URL(string: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_fRlMO7dna")!,
            clientID: "cumulus-apple",
            redirectURI: URL(string: "cumulus://oauth/callback")!,
            scopes: ["openid"],
            mailAPI: URL(string: "https://mail.cumuluscloud.app")!,
            cloudAPI: URL(string: "https://drive.cumuluscloud.app")!,
            exchangeAPI: URL(string: "https://drive.cumuluscloud.app")!,
            downloadPage: URL(string: "https://cumuluscloud.app")!
        ))
        let old = """
        {"idOrigin":"https://id.cumuluscloud.app","issuer":"https://id.cumuluscloud.app/realms/cumulus","clientID":"cumulus-apple","redirectURI":"cumulus://oauth/callback","mailAPI":"https://mail.cumuluscloud.app","cloudAPI":"https://drive.cumuluscloud.app","exchangeAPI":"https://drive.cumuluscloud.app","downloadPage":"https://cumuluscloud.app","cognitoDomain":"cumulus-id.auth.us-east-1.amazoncognito.com"}
        """
        XCTAssertEqual(try CumulusConfiguration.load(data: Data(old.utf8)).authorizationEndpoint.host, "id.cumuluscloud.app")
    }

    func testBundledConfigurationMatchesProduction() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("App/Resources/CumulusConfiguration.json")
        let data = try Data(contentsOf: file)
        let loaded = try CumulusConfiguration.load(data: data)
        XCTAssertEqual(loaded, .production)
    }
}
