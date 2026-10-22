import XCTest
final class NativeSmokeTests: XCTestCase {
    func testBundledAppLoadsEmulatorAndResumes() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--vocab-local-smoke"]
        app.launch()
        let english = app.buttons.containing(NSPredicate(format: "label CONTAINS 'English'")).firstMatch
        XCTAssertTrue(english.waitForExistence(timeout: 20), "Start ios:smoke with local assets before running this test")
        english.tap()
        XCTAssertTrue(app.buttons["Word Quiz"].waitForExistence(timeout: 10))
        let home = XCTAttachment(screenshot: app.screenshot()); home.name = "Native emulator dashboard"; home.lifetime = .keepAlways; add(home)
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.buttons["Word Quiz"].waitForExistence(timeout: 20))
    }
    func testAnswerSyncAndResume() throws {
        let app = XCUIApplication(); app.launchArguments = ["--vocab-local-smoke"]; app.launch()
        let english = app.buttons.containing(NSPredicate(format: "label CONTAINS 'English'")).firstMatch
        XCTAssertTrue(english.waitForExistence(timeout: 20)); english.tap()
        app.buttons["Word Quiz"].tap()
        let start = app.buttons["Start Word Quiz"]
        XCTAssertTrue(start.waitForExistence(timeout: 10)); start.tap()
        let reveal = app.buttons["Show Answer"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 15)); reveal.tap()
        let correct = app.buttons["Correct"]
        XCTAssertTrue(correct.waitForExistence(timeout: 10)); correct.tap()
        XCTAssertTrue(reveal.waitForExistence(timeout: 15))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(reveal.waitForExistence(timeout: 20))
    }
    func testKeyboardAndStreamingTranslation() throws {
        let app = XCUIApplication(); app.launchArguments = ["--vocab-local-smoke"]; app.launch()
        let english = app.buttons.containing(NSPredicate(format: "label CONTAINS 'English'")).firstMatch
        XCTAssertTrue(english.waitForExistence(timeout: 20)); english.tap()
        app.swipeUp()
        let start = app.buttons["Start Translation"]
        XCTAssertTrue(start.waitForExistence(timeout: 10)); start.tap()
        let input = app.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10)); input.tap(); input.typeText("Hello world.")
        app.swipeUp()
        let translate = app.buttons["Translate / Analyze"]
        XCTAssertTrue(translate.waitForExistence(timeout: 10)); translate.tap()
        XCTAssertTrue(app.staticTexts["Translating..."].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["こんにちは。"].firstMatch.waitForExistence(timeout: 20))
        let result = XCTAttachment(screenshot: app.screenshot()); result.name = "Native streamed translation"; result.lifetime = .keepAlways; add(result)
    }
}
