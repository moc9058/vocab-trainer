import Capacitor
import UIKit
import PhotosUI
import Vision

@objc(NativeCapturePlugin)
public class NativeCapturePlugin: CAPPlugin, CAPBridgedPlugin, PHPickerViewControllerDelegate {
    public let identifier = "NativeCapturePlugin"
    public let jsName = "NativeCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiveText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveDraft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledgeLaunch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acknowledge", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recordOperation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discard", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discardAll", returnType: CAPPluginReturnPromise)
    ]
    private var observer: NSObjectProtocol?
    private var pickerCall: CAPPluginCall?
    public override func load() {
        observer = NotificationCenter.default.addObserver(forName: .captureReceived, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("captureReceived", data: [:])
        }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--vocab-local-smoke") && ProcessInfo.processInfo.arguments.contains("--vocab-capture-smoke") {
            Task { @MainActor in
                let image = UIGraphicsImageRenderer(size: CGSize(width: 1000, height: 1400)).image { ctx in
                    UIColor.white.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: 1000, height: 1400))
                    let style: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 44), .foregroundColor: UIColor.black]
                    ("虽然很忙，但我还是来了。" as NSString).draw(at: CGPoint(x: 40, y: 200), withAttributes: style)
                    ("这个办法确实不错。" as NSString).draw(at: CGPoint(x: 40, y: 700), withAttributes: style)
                    ("臺灣的經濟與发展。" as NSString).draw(at: CGPoint(x: 40, y: 1000), withAttributes: style)
                }
                if let data = image.pngData() {
                    try? await CaptureInbox.shared.receiveSmokeImage(data)
                    self.notifyListeners("captureReceived", data: [:])
                }
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--vocab-local-smoke") && ProcessInfo.processInfo.arguments.contains("--vocab-reading-input-smoke") {
            Task { @MainActor in
                _ = try? await CaptureInbox.shared.requestInput(sourceUrl: "https://example.com/article")
                self.notifyListeners("captureReceived", data: [:])
            }
        }
        if ProcessInfo.processInfo.arguments.contains("--vocab-local-smoke") && ProcessInfo.processInfo.arguments.contains("--vocab-reading-resume-smoke") {
            Task { @MainActor in
                try? await CaptureInbox.shared.resumeSmokeDraft()
                self.notifyListeners("captureReceived", data: [:])
            }
        }
        #endif
    }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    private func json<T: Encodable>(_ capture: T) throws -> [String: Any] {
        let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
        return try JSONSerialization.jsonObject(with: encoder.encode(capture)) as! [String: Any]
    }
    private func run(_ call: CAPPluginCall, work: @escaping () async throws -> [String: Any]) {
        Task { @MainActor in
            guard UIApplication.shared.isProtectedDataAvailable else { call.reject(CaptureFailure.locked.localizedDescription, "CAPTURE_LOCKED"); return }
            do { call.resolve(try await work()) } catch { call.reject(error.localizedDescription, String(describing: error)) }
        }
    }
    @objc func list(_ call: CAPPluginCall) {
        run(call) { [self] in
            let summaries = try await CaptureInbox.shared.list().map { capture -> [String: Any] in
                var value = try json(capture)
                value.removeValue(forKey: "text"); value.removeValue(forKey: "blocks"); value.removeValue(forKey: "draft"); value["operations"] = [:] as [String: Any]
                return value
            }
            return ["captures": summaries, "launches": try await CaptureInbox.shared.launches().map { try json($0) }]
        }
    }
    @objc func load(_ call: CAPPluginCall) {
        run(call) { [self] in
            let id = call.getString("id") ?? ""
            let capture = try await CaptureInbox.shared.load(id)
            var result = try json(capture)
            if capture.inputKind == "image" {
                let url = try await CaptureInbox.shared.imageURL(id)
                result["imageUrl"] = bridge?.portablePath(fromLocalURL: url)?.absoluteString
            }
            return result
        }
    }
    @objc func receiveText(_ call: CAPPluginCall) {
        run(call) { [self] in
            let capture = try await CaptureInbox.shared.receiveText(call.getString("text") ?? "", method: "paste")
            notifyListeners("captureReceived", data: [:])
            return try json(capture)
        }
    }
    @objc func saveDraft(_ call: CAPPluginCall) {
        run(call) {
            guard let object = call.getObject("draft") else { throw CaptureFailure.invalid }
            let draft = try JSONDecoder().decode(CaptureDraft.self, from: JSONSerialization.data(withJSONObject: object))
            try await CaptureInbox.shared.saveDraft(call.getString("id") ?? "", draft: draft)
            return [:]
        }
    }
    @objc func acknowledgeLaunch(_ call: CAPPluginCall) {
        run(call) { try await CaptureInbox.shared.acknowledgeLaunch(call.getString("id") ?? ""); return [:] }
    }
    @objc func acknowledge(_ call: CAPPluginCall) { run(call) { try await CaptureInbox.shared.acknowledge(call.getString("id") ?? ""); return [:] } }
    @objc func discard(_ call: CAPPluginCall) { run(call) { try await CaptureInbox.shared.discard(call.getString("id") ?? ""); return [:] } }
    @objc func discardAll(_ call: CAPPluginCall) { run(call) { try await CaptureInbox.shared.discardAll(); return [:] } }
    @objc func recordOperation(_ call: CAPPluginCall) {
        run(call) {
            try await CaptureInbox.shared.recordOperation(call.getString("id") ?? "", blockId: call.getString("blockId") ?? "", request: call.getString("request") ?? "", sessionId: call.getString("sessionId"))
            return [:]
        }
    }
    @objc func recognize(_ call: CAPPluginCall) {
        run(call) { [self] in
            let id = call.getString("id") ?? ""
            let capture = try await CaptureInbox.shared.load(id)
            if capture.blocks != nil { return try json(capture) }
            let url = try await CaptureInbox.shared.imageURL(id)
            let blocks = try await Task.detached(priority: .userInitiated) {
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                let supported = try request.supportedRecognitionLanguages()
                let chinese = ["zh-Hans", "zh-Hant"].filter { supported.contains($0) }
                guard !chinese.isEmpty else { throw CaptureFailure.chineseUnavailable }
                request.recognitionLanguages = chinese + ["en-US"].filter { supported.contains($0) }
                try VNImageRequestHandler(url: url).perform([request])
                let lines = (request.results ?? []).compactMap { observation -> CaptureBlock? in
                    guard let candidate = observation.topCandidates(1).first, !candidate.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                    let r = observation.boundingBox
                    return CaptureBlock(id: UUID().uuidString, text: candidate.string,
                        rects: [CaptureRect(left: r.minX, top: 1 - r.maxY, width: r.width, height: r.height)], confidence: candidate.confidence)
                }.sorted { $0.rects[0].top == $1.rects[0].top ? $0.rects[0].left < $1.rects[0].left : $0.rects[0].top < $1.rects[0].top }
                var blocks: [CaptureBlock] = []
                for line in lines {
                    // Conservative: joining across a comment gap requires explicit user selection.
                    if let previous = blocks.last, let last = previous.rects.last, let next = line.rects.first,
                       next.top >= last.top + last.height * 0.5,
                       next.top - last.top - last.height < min(last.height, next.height) * 0.6,
                       abs(next.left - last.left) < 0.025, abs(next.width - last.width) < 0.10 {
                        blocks[blocks.count - 1] = CaptureBlock(id: previous.id, text: previous.text + "\n" + line.text, rects: previous.rects + line.rects, confidence: min(previous.confidence, line.confidence))
                    } else { blocks.append(line) }
                }
                return blocks
            }.value
            try await CaptureInbox.shared.saveBlocks(id, blocks: blocks)
            return try json(try await CaptureInbox.shared.load(id))
        }
    }
    @objc func pickImage(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.pickerCall == nil else { call.reject("CAPTURE_BUSY"); return }
            var config = PHPickerConfiguration(); config.filter = .images; config.selectionLimit = 1
            let picker = PHPickerViewController(configuration: config); picker.delegate = self
            self.pickerCall = call
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let call = pickerCall else { return }; pickerCall = nil
        guard let item = results.first else { call.resolve(["cancelled": true]); return }
        item.itemProvider.loadFileRepresentation(forTypeIdentifier: "public.image") { url, _ in
            do {
                guard let url, let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 20 * 1024 * 1024 else { throw CaptureFailure.invalid }
                let data = try Data(contentsOf: url)
                self.run(call) { [self] in
                    let capture = try await CaptureInbox.shared.receiveImage(data, method: "image-picker")
                    notifyListeners("captureReceived", data: [:])
                    return ["id": capture.id]
                }
            } catch { call.reject(error.localizedDescription, String(describing: error)) }
        }
    }
}
