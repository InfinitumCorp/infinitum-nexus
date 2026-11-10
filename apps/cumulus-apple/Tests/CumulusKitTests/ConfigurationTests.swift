import XCTest
@testable import CumulusKit

final class ConfigurationTests: XCTestCase {
    func testProductionHosts() {
        let configuration = CumulusConfiguration.production
        XCTAssertEqual(configuration.idOrigin.host, "id.cumuluscloud.app")
        XCTAssertEqual(configuration.mailAPI.host, "mail.cumuluscloud.app")
        XCTAssertEqual(configuration.cloudAPI.host, "cloud.cumuluscloud.app")
        XCTAssertEqual(configuration.downloadPage.host, "cumuluscloud.app")
        XCTAssertFalse(configuration.usesCognito)
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
            cloudAPI: URL(string: "https://cloud.cumuluscloud.app")!,
            exchangeAPI: URL(string: "https://cloud.cumuluscloud.app")!,
            downloadPage: URL(string: "https://cumuluscloud.app")!
        ))
    }

    func testEnvironmentOverrides() throws {
        let configuration = try CumulusConfiguration.load(environment: [
            "CUMULUS_MAIL_API": "https://mail.example.test",
            "CUMULUS_COGNITO_DOMAIN": "auth.example.test",
            "CUMULUS_COGNITO_REGION": "us-east-1",
            "CUMULUS_COGNITO_USER_POOL_ID": "us-east-1_pool",
        ])
        XCTAssertEqual(configuration.mailAPI.host, "mail.example.test")
        XCTAssertEqual(configuration.cloudAPI.host, "cloud.cumuluscloud.app")
        XCTAssertTrue(configuration.usesCognito)
    }

    func testJSONFile() throws {
        let json = """
        {"idOrigin":"https://id.cumuluscloud.app","issuer":"https://id.cumuluscloud.app/realms/cumulus","clientID":"cumulus-apple","redirectURI":"cumulus://oauth/callback","scopes":["openid","email"],"mailAPI":"https://mail.cumuluscloud.app","cloudAPI":"https://cloud.cumuluscloud.app","exchangeAPI":"https://cloud.cumuluscloud.app","downloadPage":"https://cumuluscloud.app"}
        """
        let configuration = try CumulusConfiguration.load(data: Data(json.utf8))
        XCTAssertEqual(configuration.scopes, ["openid", "email"])
    }

    func testPartialCognitoIsRejected() {
        XCTAssertThrowsError(try CumulusConfiguration.load(environment: ["CUMULUS_COGNITO_DOMAIN": "auth.example.test"]))
    }
}
