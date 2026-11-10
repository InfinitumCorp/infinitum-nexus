import XCTest

final class CumulusUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSignedOutShowsCumulusIDSignIn() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["sign-in-button"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["product-id"].exists)
        XCTAssertTrue(app.buttons["product-mail"].exists)
        XCTAssertTrue(app.buttons["product-cloud"].exists)
        app.buttons["product-download"].tap()
        XCTAssertTrue(app.staticTexts["on every device."].waitForExistence(timeout: 5) || app.otherElements["download-hero"].exists)
    }

    func testPreviewMailboxDriveAndExchange() {
        let app = XCUIApplication()
        app.launchArguments = ["-CumulusPreview"]
        app.launch()
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["VYRAL London — hold the forecast"].exists)
        app.buttons["compose"].tap()
        XCTAssertTrue(app.otherElements["composer"].waitForExistence(timeout: 3) || app.buttons["send"].exists)

        app.buttons["product-cloud"].tap()
        XCTAssertTrue(app.buttons["my-drive"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["ODIN briefing"].exists || app.buttons["ODIN briefing"].exists)
        app.buttons["exchange"].tap()
        XCTAssertTrue(app.staticTexts["Your data, your share"].waitForExistence(timeout: 5))

        app.buttons["product-id"].tap()
        XCTAssertTrue(app.staticTexts["alex@cumuluscloud.app"].waitForExistence(timeout: 5))
    }
}
