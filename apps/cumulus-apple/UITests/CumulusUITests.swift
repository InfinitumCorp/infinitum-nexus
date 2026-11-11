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

    // Each check launches straight into its product (CUMULUS_PRODUCT), because on a small CI
    // display the window's top edge, and with it the product bar, can sit above the screen.
    func testPreviewMailbox() {
        let app = launchPreview("mail")
        XCTAssertTrue(app.buttons["compose"].waitForExistence(timeout: 5))
        XCTAssertTrue(shows(app, "VYRAL London — hold the forecast"))
        app.buttons["compose"].tap()
        // The composer is a group on macOS and an other element on iOS, so match it by identifier alone.
        XCTAssertTrue(app.descendants(matching: .any)["composer"].waitForExistence(timeout: 5)
                      || app.descendants(matching: .any)["send"].exists)
    }

    func testPreviewDriveAndExchange() {
        let app = launchPreview("cloud")
        XCTAssertTrue(app.buttons["my-drive"].waitForExistence(timeout: 5))
        XCTAssertTrue(shows(app, "ODIN briefing"))
        app.buttons["exchange"].tap()
        XCTAssertTrue(shows(app, "Your data, your share"))
    }

    func testPreviewID() {
        let app = launchPreview("id")
        XCTAssertTrue(shows(app, "alex@cumuluscloud.app"))
    }

    private func launchPreview(_ product: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-CumulusPreview"]
        app.launchEnvironment["CUMULUS_PRODUCT"] = product
        app.launch()
        app.activate()
        return app
    }

    override func record(_ issue: XCTIssue) {
        // Print what is actually on screen so a CI failure can be read from the log.
        print("UI-TREE-BEGIN")
        print(XCUIApplication().debugDescription)
        print("UI-TREE-END")
        super.record(issue)
    }

    /// Text inside a row or button is part of that element's label, not its own static text,
    /// so match any element whose label contains it.
    private func shows(_ app: XCUIApplication, _ text: String, timeout: TimeInterval = 5) -> Bool {
        // Search the window only: the whole app includes every menu item and can time out.
        app.windows.firstMatch.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text))
            .firstMatch
            .waitForExistence(timeout: timeout)
    }
}
