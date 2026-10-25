import Foundation
import UIKit
import ImageIO

struct CaptureBlock: Codable {
    let id: String
    let text: String
    let rects: [CaptureRect]
    let confidence: Float
}
struct CaptureRect: Codable {
    let left: Double
    let top: Double
    let width: Double
    let height: Double
}
struct CaptureOperation: Codable {
    let request: String
    let createdAt: Date
    var sessionId: String?
}
struct CaptureDraft: Codable {
    var text: String
    var selected: [String]
    var sourceLabel: String
    var sourceKind: String
    var sourceUrl: String
    var blockId: String?
    var wordGroupId: String?
    var grammarGroupId: String?
    var groupBNames: [String]
    var descriptionLanguage: String
}
struct ReadingLaunch: Codable {
    let id: String
    let receivedAt: Date
    var sourceUrl: String?
    var acknowledged = false
}
struct LocalCapture: Codable {
    let id: String
    let receivedAt: Date
    let inputKind: String
    let method: String
    var text: String?
    var width: Int?
    var height: Int?
    var blocks: [CaptureBlock]?
    var operations: [String: CaptureOperation] = [:]
    var acknowledged = false
    var draft: CaptureDraft?
}
enum CaptureFailure: LocalizedError {
    case invalid, full, expired, locked, tooLong, chineseUnavailable
    var errorDescription: String? {
        switch self {
        case .invalid: return NSLocalizedString("CAPTURE_INVALID", comment: "")
        case .full: return NSLocalizedString("CAPTURE_FULL", comment: "")
        case .expired: return NSLocalizedString("CAPTURE_EXPIRED", comment: "")
        case .locked: return NSLocalizedString("CAPTURE_LOCKED", comment: "")
        case .tooLong: return NSLocalizedString("CAPTURE_TOO_LONG", comment: "")
        case .chineseUnavailable: return NSLocalizedString("CAPTURE_CHINESE_UNAVAILABLE", comment: "")
        }
    }
}

/// Only transient acquisition data lives here. Saved study data remains in Firestore.
actor CaptureInbox {
    static let shared = CaptureInbox()
    private let files = FileManager.default
    private let lifetime: TimeInterval = 86400
    private func root() throws -> URL {
        var url = files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("CaptureInbox", isDirectory: true)
        try files.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        return url
    }
    private func folder(_ id: String) throws -> URL {
        guard UUID(uuidString: id) != nil else { throw CaptureFailure.invalid }
        return try root().appendingPathComponent(id, isDirectory: true)
    }
    private func write(_ capture: LocalCapture) throws {
        let data = try JSONEncoder().encode(capture)
        let destination = try folder(capture.id).appendingPathComponent("capture.json")
        let previousBytes = (try? destination.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard try diskUsage() - previousBytes + data.count <= 100 * 1024 * 1024 else { throw CaptureFailure.full }
        try data.write(to: destination, options: [.atomic, .completeFileProtection])
    }
    func list() throws -> [LocalCapture] {
        let urls = try files.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil)
        var result: [LocalCapture] = []
        for url in urls {
            if files.fileExists(atPath: url.appendingPathComponent("launch.json").path) { continue }
            let metadata = url.appendingPathComponent("capture.json")
            // A process can die after reserving a folder but before writing metadata.
            guard files.fileExists(atPath: metadata.path) else { try files.removeItem(at: url); continue }
            let data = try Data(contentsOf: metadata)
            guard let capture = try? JSONDecoder().decode(LocalCapture.self, from: data) else { throw CaptureFailure.invalid }
            if Date().timeIntervalSince(capture.receivedAt) >= lifetime { try files.removeItem(at: url) }
            else { result.append(capture) }
        }
        return result.sorted { $0.receivedAt > $1.receivedAt }
    }
    func load(_ id: String) throws -> LocalCapture {
        guard let capture = try list().first(where: { $0.id == id }) else { throw CaptureFailure.expired }
        return capture
    }
    func imageURL(_ id: String) throws -> URL {
        let capture = try load(id)
        guard capture.inputKind == "image" else { throw CaptureFailure.invalid }
        return try folder(id).appendingPathComponent("image.jpg")
    }
    private func diskUsage() throws -> Int {
        let folders = try files.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil)
        return try folders.reduce(0) { total, folder in
            total + (try files.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey])).reduce(0) {
                $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            }
        }
    }
    private func reserve(bytes: Int) throws -> URL {
        let captures = try list()
        let size = try diskUsage()
        guard captures.count + (try launches()).count < 10, size + bytes < 100 * 1024 * 1024 else { throw CaptureFailure.full }
        let url = try folder(UUID().uuidString)
        try files.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        return url
    }
    func receiveText(_ text: String, method: String = "shared-text") throws -> LocalCapture {
        guard ["shared-text", "paste"].contains(method), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CaptureFailure.invalid }
        guard text.utf16.count <= 8000 else { throw CaptureFailure.tooLong }
        let url = try reserve(bytes: text.utf8.count)
        let capture = LocalCapture(id: url.lastPathComponent, receivedAt: Date(), inputKind: "text", method: method, text: text)
        do { try write(capture); return capture } catch { try? files.removeItem(at: url); throw error }
    }
    func receiveImage(_ data: Data, method: String) throws -> LocalCapture {
        guard ["shared-image", "screenshot-shortcut", "image-picker"].contains(method), data.count <= 20 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, Double(width) * Double(height) <= 20_000_000,
              let original = UIImage(data: data) else { throw CaptureFailure.invalid }
        // Render once so OCR and the displayed image have exactly the same orientation.
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let size = CGSize(width: original.size.width * original.scale, height: original.size.height * original.scale)
        let upright = UIGraphicsImageRenderer(size: size, format: format).image { _ in original.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = upright.jpegData(compressionQuality: 0.95) else { throw CaptureFailure.invalid }
        let url = try reserve(bytes: jpeg.count)
        let capture = LocalCapture(id: url.lastPathComponent, receivedAt: Date(), inputKind: "image", method: method, width: Int(size.width), height: Int(size.height))
        do {
            try jpeg.write(to: url.appendingPathComponent("image.jpg"), options: [.atomic, .completeFileProtection])
            try write(capture); return capture
        } catch { try? files.removeItem(at: url); throw error }
    }
    #if DEBUG
    func resumeSmokeDraft() throws {
        guard var capture = try list().first(where: { $0.draft?.text == "A draft to restore." }) else { throw CaptureFailure.invalid }
        capture.acknowledged = false
        try write(capture)
    }
    func receiveSmokeImage(_ data: Data) throws {
        for capture in try list() where files.fileExists(atPath: try folder(capture.id).appendingPathComponent("smoke.marker").path) { try discard(capture.id) }
        let capture = try receiveImage(data, method: "shared-image")
        try Data().write(to: folder(capture.id).appendingPathComponent("smoke.marker"), options: [.atomic, .completeFileProtection])
    }
    #endif
    func saveBlocks(_ id: String, blocks: [CaptureBlock]) throws {
        var capture = try load(id); capture.blocks = blocks; try write(capture)
    }
    func acknowledge(_ id: String) throws {
        var capture = try load(id); capture.acknowledged = true; try write(capture)
    }
    func recordOperation(_ id: String, blockId: String, request: String, sessionId: String?) throws {
        guard request.utf8.count <= 100_000, !blockId.isEmpty, blockId.count <= 4096 else { throw CaptureFailure.invalid }
        var capture = try load(id)
        guard capture.operations[blockId] != nil || capture.operations.count < 100 else { throw CaptureFailure.full }
        if let previous = capture.operations[blockId], previous.request != request { throw CaptureFailure.invalid }
        capture.operations[blockId] = CaptureOperation(request: request, createdAt: capture.operations[blockId]?.createdAt ?? Date(), sessionId: sessionId)
        try write(capture)
    }
    func discard(_ id: String) throws { try files.removeItem(at: folder(id)) }
    func saveDraft(_ id: String, draft: CaptureDraft) throws {
        guard draft.text.utf16.count <= 100_000, draft.selected.count <= 1000,
              draft.sourceLabel.utf16.count <= 100, draft.sourceUrl.utf16.count <= 2048,
              ["post", "comment", "article", "unknown"].contains(draft.sourceKind),
              ["en", "ja", "ko", "zh"].contains(draft.descriptionLanguage),
              draft.groupBNames.count <= 100 else { throw CaptureFailure.invalid }
        var capture = try load(id)
        // A frozen operation owns its request; drafts never modify that request.
        capture.draft = draft
        try write(capture)
    }
    func launches() throws -> [ReadingLaunch] {
        var result: [ReadingLaunch] = []
        for url in try files.contentsOfDirectory(at: root(), includingPropertiesForKeys: nil) {
            let metadata = url.appendingPathComponent("launch.json")
            guard files.fileExists(atPath: metadata.path) else { continue }
            let launch = try JSONDecoder().decode(ReadingLaunch.self, from: Data(contentsOf: metadata))
            if Date().timeIntervalSince(launch.receivedAt) >= lifetime { try files.removeItem(at: url) }
            else { result.append(launch) }
        }
        return result.sorted { $0.receivedAt > $1.receivedAt }
    }
    func requestInput(sourceUrl: String? = nil) throws -> ReadingLaunch {
        if let sourceUrl {
            guard sourceUrl.utf16.count <= 2048, let url = URL(string: sourceUrl),
                  url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { throw CaptureFailure.invalid }
        }
        let url = try reserve(bytes: 4096)
        let launch = ReadingLaunch(id: url.lastPathComponent, receivedAt: Date(), sourceUrl: sourceUrl)
        do {
            try JSONEncoder().encode(launch).write(to: url.appendingPathComponent("launch.json"), options: [.atomic, .completeFileProtection])
            return launch
        } catch { try? files.removeItem(at: url); throw error }
    }
    func acknowledgeLaunch(_ id: String) throws {
        guard var launch = try launches().first(where: { $0.id == id }) else { throw CaptureFailure.expired }
        launch.acknowledged = true
        try JSONEncoder().encode(launch).write(to: folder(id).appendingPathComponent("launch.json"), options: [.atomic, .completeFileProtection])
    }
    func discardAll() throws {
        for capture in try list() { try discard(capture.id) }
        for launch in try launches() { try discard(launch.id) }
    }
}
