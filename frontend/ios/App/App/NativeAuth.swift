// Local native bridge: credentials stay in Keychain, OAuth runs in the OS session.
import Capacitor
import UIKit
import AuthenticationServices
import CryptoKit
import Security
import WebKit

class VocabBridgeViewController: CAPBridgeViewController {
    override func viewDidLoad() {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--vocab-local-smoke") {
            guard let file = Bundle.main.url(forResource: "ios-build", withExtension: "json", subdirectory: "public"),
                  let bytes = try? Data(contentsOf: file),
                  let data = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
                  data["mode"] as? String == "ios-local", data["apiOrigin"] as? String == "http://localhost:3000" else {
                fatalError("Native smoke tests require ios:sync:local and the synthetic localhost server")
            }
        }
        #endif
        super.viewDidLoad()
    }
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NativeAuthPlugin())
    }
}

@objc(NativeAuthPlugin)
public class NativeAuthPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "NativeAuthPlugin"
    public let jsName = "NativeAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "token", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]
    private var session: ASWebAuthenticationSession?
    private var loginPending = false
    private let productionOrigin = "https://vocab-trainer-frontend-839843597381.asia-northeast1.run.app"
    private func origin(_ call: CAPPluginCall) throws -> String {
        guard let raw = call.getString("apiOrigin"), let url = URL(string: raw),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw AuthFailure.invalid }
        if raw == productionOrigin { return raw }
        #if DEBUG
        if let host = url.host, ["http", "https"].contains(url.scheme ?? ""),
           host == "localhost" || host == "127.0.0.1" || host.hasPrefix("192.168.") || host.hasPrefix("10.") || host.hasPrefix("172.") {
            return raw.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        #endif
        throw AuthFailure.invalid
    }
    private enum AuthFailure: Error { case invalid, network, keychain }
    private func bytes() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw AuthFailure.invalid }
        return base64(Data(bytes))
    }
    private func base64(_ value: Data) -> String {
        value.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private func query(_ origin: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "VocabTrainer.MobileSession",
         kSecAttrAccount as String: origin, kSecAttrSynchronizable as String: false]
    }
    @objc func token(_ call: CAPPluginCall) {
        do {
            var q = query(try origin(call)); q[kSecReturnData as String] = true
            var result: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &result)
            #if DEBUG
            if status != errSecSuccess && status != errSecItemNotFound { NSLog("Vocab Trainer: secure session read failed (%d)", status) }
            #endif
            if status == errSecItemNotFound { call.resolve(["token": NSNull()]); return }
            guard status == errSecSuccess, let data = result as? Data, let token = String(data: data, encoding: .utf8) else { throw AuthFailure.keychain }
            call.resolve(["token": token])
        } catch { call.reject("Cannot read secure session") }
    }
    @objc func clear(_ call: CAPPluginCall) {
        do {
            let status = SecItemDelete(query(try origin(call)) as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw AuthFailure.keychain }
            call.resolve()
        } catch { call.reject("Cannot clear secure session") }
    }
    private func save(_ token: String, origin: String) throws {
        let q = query(origin)
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8), kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(q.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw AuthFailure.keychain }
        } else if status != errSecSuccess { throw AuthFailure.keychain }
    }
    private func post(_ origin: String, _ path: String, _ body: [String: String]) async throws -> [String: Any] {
        guard let url = URL(string: origin + path) else { throw AuthFailure.invalid }
        var req = URLRequest(url: url); req.httpMethod = "POST"; req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        // Refuse redirects rather than send an OAuth verifier to another host.
        let client = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        defer { client.finishTasksAndInvalidate() }
        let (data, response) = try await client.data(for: req)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AuthFailure.network }
        return json
    }
    @objc func login(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard !self.loginPending else { call.reject("Sign-in already in progress"); return }
            self.loginPending = true
            Task { @MainActor in
                do {
                    let origin = try self.origin(call), verifier = try self.bytes(), state = try self.bytes()
                    let challenge = self.base64(Data(SHA256.hash(data: Data(verifier.utf8))))
                    let start = try await self.post(origin, "/api/auth/mobile/start", ["challenge": challenge, "state": state])
                    guard let id = start["id"] as? String, let raw = start["authorizationUrl"] as? String,
                          let url = URL(string: raw), url.scheme == "https", url.host == "accounts.google.com",
                          url.path == "/o/oauth2/v2/auth", let scheme = start["callbackScheme"] as? String,
                          scheme.hasPrefix("com.googleusercontent.apps."), !scheme.contains("/") else { throw AuthFailure.invalid }
                    let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
                        Task { @MainActor in
                            guard let self else { return }
                            defer { self.session = nil; self.loginPending = false }
                            do {
                                guard error == nil, let callback, callback.scheme == scheme, callback.host == nil,
                                      callback.path == "/oauthredirect", callback.fragment == nil,
                                      let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false) else { throw AuthFailure.invalid }
                                let states = parts.queryItems?.filter { $0.name == "state" } ?? []
                                let codes = parts.queryItems?.filter { $0.name == "code" } ?? []
                                guard states.count == 1, states[0].value == state, codes.count == 1,
                                      let code = codes[0].value, !code.isEmpty else { throw AuthFailure.invalid }
                                let result = try await self.post(origin, "/api/auth/mobile/exchange", ["id": id, "code": code, "verifier": verifier])
                                guard let token = result["token"] as? String, token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw AuthFailure.invalid }
                                try self.save(token, origin: origin)
                                call.resolve()
                            } catch { call.reject("Sign-in was cancelled or failed. Check iOS OAuth configuration and try again.") }
                        }
                    }
                    auth.presentationContextProvider = self
                    self.session = auth
                    guard auth.start() else { throw AuthFailure.invalid }
                } catch { self.loginPending = false; self.session = nil; call.reject("Cannot start sign-in. Check server mobile authentication configuration.") }
            }
        }
    }
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
private class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
