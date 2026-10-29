import XCTest
final class NativeSmokeTests: XCTestCase {
    func testCaptureOCRAutomaticallyStartsAnalysis() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--vocab-local-smoke", "--vocab-capture-smoke"]
        app.launch()
        let parts = app.staticTexts["Meaningful parts"]
        XCTAssertTrue(parts.waitForExistence(timeout: 60), "Vision OCR must start source analysis without selecting a block or tapping Analyze")
        app.buttons["Close full text"].tap()
        let traditional = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS '臺灣的經濟與发展'")).firstMatch
        XCTAssertTrue(traditional.waitForExistence(timeout: 10), "The full recognized image, including traditional Chinese, must reach the reader")
        let detail = XCTAttachment(screenshot: app.screenshot()); detail.name = "Automatic image analysis"; detail.lifetime = .keepAlways; add(detail)
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(traditional.waitForExistence(timeout: 20))
    }

    func testMissingReadingInputAcceptsPasteAndRestoresDraft() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--vocab-local-smoke", "--vocab-reading-input-smoke"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Read from a screen"].waitForExistence(timeout: 30))
        let input = app.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        input.tap(); input.typeText("A draft to restore.")
        // Acknowledge the local save, then simulate an OS termination and reopen.
        sleep(2)
        app.terminate()
        app.launchArguments = ["--vocab-local-smoke", "--vocab-reading-resume-smoke"]
        app.launch()
        XCTAssertTrue(app.staticTexts["Read from a screen"].waitForExistence(timeout: 30))
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertEqual(input.value as? String, "A draft to restore.")
    }

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
        let startNew = app.buttons["Start New"]
        if startNew.waitForExistence(timeout: 3) { startNew.tap() }
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
        let startNew = app.buttons["Start New"]
        if startNew.waitForExistence(timeout: 3) { startNew.tap() }
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
