import AuthenticationServices
import CumulusKit
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

final class KeychainTokenStore: TokenStore {
    private let service = "app.cumuluscloud.suite"
    private let account = "oidc"

    func load() throws -> TokenSet? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw CumulusError.oidc("The keychain could not be read.")
        }
        return try JSONDecoder().decode(TokenSet.self, from: data)
    }

    func save(_ tokens: TokenSet) throws {
        let data = try JSONEncoder().encode(tokens)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let values: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let existing = SecItemCopyMatching(query as CFDictionary, nil)
        let status: OSStatus
        if existing == errSecSuccess {
            status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        } else {
            var insert = query
            values.forEach { insert[$0.key] = $0.value }
            status = SecItemAdd(insert as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw CumulusError.oidc("The keychain could not be updated.")
        }
    }

    func clear() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum BrowserSignIn {
    @MainActor
    static func start(url: URL, scheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { callback, error in
                Anchor.shared.session = nil
                if let callback {
                    continuation.resume(returning: callback)
                } else {
                    let message = (error as NSError?)?.localizedDescription ?? "Sign-in was cancelled."
                    continuation.resume(throwing: CumulusError.oidc(message))
                }
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = Anchor.shared
            Anchor.shared.session = session
            if !session.start() {
                Anchor.shared.session = nil
                continuation.resume(throwing: CumulusError.oidc("The browser sign-in could not start."))
            }
        }
    }
}

private final class Anchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = Anchor()
    var session: ASWebAuthenticationSession?

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        if let window = NSApplication.shared.windows.first(where: { $0.isVisible }) ?? NSApplication.shared.windows.first {
            return window
        }
        return NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        #else
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        return scene?.keyWindow ?? scene?.windows.first ?? UIWindow()
        #endif
    }
}

enum CumulusConfigLoader {
    static func load() -> CumulusConfiguration {
        let environment = ProcessInfo.processInfo.environment
        if environment.keys.contains(where: { $0.hasPrefix("CUMULUS_") }),
           let parsed = try? CumulusConfiguration.load(environment: environment) {
            return parsed
        }
        if let url = Bundle.main.url(forResource: "CumulusConfiguration", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let parsed = try? CumulusConfiguration.load(data: data) {
            return parsed
        }
        return .production
    }
}
