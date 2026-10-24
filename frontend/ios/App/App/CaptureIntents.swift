import AppIntents
import UIKit

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
    @MainActor
    func perform() async throws -> some IntentResult {
        guard UIApplication.shared.isProtectedDataAvailable else { throw CaptureFailure.locked }
        let url = image.fileURL
        let scoped = url?.startAccessingSecurityScopedResource() ?? false
        defer { if scoped { url?.stopAccessingSecurityScopedResource() } }
        // Check on-disk size before materializing an untrusted file.
        if let url, let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 20 * 1024 * 1024 { throw CaptureFailure.invalid }
        _ = try await CaptureInbox.shared.receiveImage(image.data, method: "shared-image")
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
    @MainActor
    func perform() async throws -> some IntentResult {
        guard UIApplication.shared.isProtectedDataAvailable else { throw CaptureFailure.locked }
        _ = try await CaptureInbox.shared.receiveText(text)
        NotificationCenter.default.post(name: .captureReceived, object: nil)
        return .result()
    }
}

extension Notification.Name {
    static let captureReceived = Notification.Name("VocabTrainer.captureReceived")
}
