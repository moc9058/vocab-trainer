import SafariServices
import Security

/// Extension-private Keychain. No App Group or shared credential entitlement.
/// Nothing in this protocol is logged. Safari routes native messages to this target.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let queue = DispatchQueue(label: "app.vocabtrainer.safari.vault")
    func beginRequest(with context: NSExtensionContext) {
        Self.queue.async {
            let item = context.inputItems.first as? NSExtensionItem
            let profile = item?.userInfo?[SFExtensionProfileKey] as? UUID
            let service = "app.vocabtrainer.safari.vault." + (profile?.uuidString ?? "default")
            let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any] ?? [:]
            var result: [String: Any]
            do { result = ["value": try Self.perform(message, service: service) ?? NSNull()] }
            catch { result = ["error": "Secure storage unavailable"] }
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: result]
            context.completeRequest(returningItems: [response])
        }
    }
    private static func perform(_ m: [String: Any], service: String) throws -> Any? {
        let action = m["action"] as? String ?? ""
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if action == "clear" {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError.failed }
            return nil
        }
        guard let key = m["key"] as? String,
              key == "token" || key == "connection" || (key.hasPrefix("ctx-") && key.count == 47 && key.dropFirst(4).allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })) else { throw VaultError.failed }
        query[kSecAttrAccount as String] = key
        if action == "delete" { SecItemDelete(query as CFDictionary); return nil }
        if action == "read" {
            var readQuery = query
            readQuery[kSecReturnData as String] = true
            var value: CFTypeRef?
            let status = SecItemCopyMatching(readQuery as CFDictionary, &value)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let data = value as? Data,
                  let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw VaultError.failed }
            if let expiry = envelope["expiresAt"] as? Double, expiry <= Date().timeIntervalSince1970 * 1000 {
                SecItemDelete(query as CFDictionary); return nil
            }
            return envelope["value"]
        }
        guard action == "write", let value = m["value"] else { throw VaultError.failed }
        let lifetime = key == "token" ? 30.0 * 86400000 : key == "connection" ? 600000.0 : 86400000.0
        let explicitExpiry = (value as? [String: Any])?["expiresAt"] as? Double
        let expiry = min(explicitExpiry ?? Double.greatestFiniteMagnitude, Date().timeIntervalSince1970 * 1000 + lifetime)
        let data = try JSONSerialization.data(withJSONObject: ["value": value, "expiresAt": expiry], options: [.fragmentsAllowed])
        guard data.count <= 950000 else { throw VaultError.failed }
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw VaultError.failed }
        } else if status != errSecSuccess { throw VaultError.failed }
        // Opportunistic removal: expiry is always checked on read, even between cleanups.
        let all: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                 kSecMatchLimit as String: kSecMatchLimitAll, kSecReturnData as String: true, kSecReturnAttributes as String: true]
        var entries: CFTypeRef?
        if SecItemCopyMatching(all as CFDictionary, &entries) == errSecSuccess, let rows = entries as? [[String: Any]] {
            for row in rows {
                guard let bytes = row[kSecValueData as String] as? Data,
                      let e = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                      let expiresAt = e["expiresAt"] as? Double, expiresAt <= Date().timeIntervalSince1970 * 1000,
                      let account = row[kSecAttrAccount as String] as? String else { continue }
                SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account] as CFDictionary)
            }
        }
        return nil
    }
    private enum VaultError: Error { case failed }
}
