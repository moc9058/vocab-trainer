import AppIntents
import UIKit

@available(iOS 16.0, *)
enum ReadingImageSource: String, AppEnum {
    case sharedImage, screenshot
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Image source"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .sharedImage: "Shared image", .screenshot: "Screenshot shortcut"
    ]
}
@available(iOS 16.0, *)
enum ReadingTextSource: String, AppEnum {
    case sharedText, copiedText
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Text source"
    static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .sharedText: "Shared text", .copiedText: "Copied text"
    ]
}

@available(iOS 16.0, *)
struct ReadScreenImageIntent: AppIntent {
    static var title: LocalizedStringResource = "Read an image"
    static var description = IntentDescription("Open an image in Vocab Trainer to select Chinese text and study it.")
    static var openAppWhenRun: Bool = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    @available(iOS 27.0, *)
    static var allowedExecutionTargets: IntentExecutionTargets { .main }
    @Parameter(title: "Image") var image: IntentFile
    @Parameter(title: "Image source", default: .sharedImage) var inputSource: ReadingImageSource
    @MainActor
    func perform() async throws -> some IntentResult {
        guard UIApplication.shared.isProtectedDataAvailable else { throw CaptureFailure.locked }
        let url = image.fileURL
        let scoped = url?.startAccessingSecurityScopedResource() ?? false
        defer { if scoped { url?.stopAccessingSecurityScopedResource() } }
        // Check on-disk size before materializing an untrusted file.
        if let url, let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 20 * 1024 * 1024 { throw CaptureFailure.invalid }
        _ = try await CaptureInbox.shared.receiveImage(image.data, method: inputSource == .screenshot ? "screenshot-shortcut" : "shared-image")
        NotificationCenter.default.post(name: .captureReceived, object: nil)
        return .result()
    }
}

@available(iOS 16.0, *)
struct ReadSelectedTextIntent: AppIntent {
    static var title: LocalizedStringResource = "Read selected text"
    static var description = IntentDescription("Open shared Chinese text in Vocab Trainer. Review the text before analysis.")
    static var openAppWhenRun: Bool = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    @available(iOS 27.0, *)
    static var allowedExecutionTargets: IntentExecutionTargets { .main }
    @Parameter(title: "Text") var text: String
    @Parameter(title: "Text source", default: .sharedText) var inputSource: ReadingTextSource
    @MainActor
    func perform() async throws -> some IntentResult {
        guard UIApplication.shared.isProtectedDataAvailable else { throw CaptureFailure.locked }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            _ = try await CaptureInbox.shared.requestInput()
        } else if let url = URL(string: trimmed), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil,
                  trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil {
            _ = try await CaptureInbox.shared.requestInput(sourceUrl: url.scheme == "https" && url.user == nil && url.password == nil ? trimmed : nil)
        } else {
            _ = try await CaptureInbox.shared.receiveText(text, method: inputSource == .copiedText ? "paste" : "shared-text")
        }
        NotificationCenter.default.post(name: .captureReceived, object: nil)
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenReadingInputIntent: AppIntent {
    static var title: LocalizedStringResource = "Open reading input"
    static var description = IntentDescription("Open text input when no selected text was received. Copy or share the passage, or use a screenshot.")
    static var openAppWhenRun: Bool = true
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    @available(iOS 27.0, *)
    static var allowedExecutionTargets: IntentExecutionTargets { .main }
    @Parameter(title: "Source URL") var sourceURL: String?
    @MainActor
    func perform() async throws -> some IntentResult {
        guard UIApplication.shared.isProtectedDataAvailable else { throw CaptureFailure.locked }
        _ = try await CaptureInbox.shared.requestInput(sourceUrl: sourceURL)
        NotificationCenter.default.post(name: .captureReceived, object: nil)
        return .result()
    }
}

extension Notification.Name {
    static let captureReceived = Notification.Name("VocabTrainer.captureReceived")
}
