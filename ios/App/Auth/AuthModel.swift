import AuthenticationServices
import Foundation
import UIKit

/// Retained provider for the Google web-auth sheet's presentation anchor.
final class WebAuthPresentationProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { keyWindowAnchor() }
    }
}

/// Session + sign-in orchestration. Holds the current session (persisted in the
/// Keychain), drives Sign in with Apple and Google (web), sign-out, and account
/// deletion.
@MainActor
final class AuthModel: ObservableObject {
    @Published private(set) var session: StoredSession?
    @Published var isBusy = false
    @Published var errorMessage: String?

    private let client = AuthClient()
    private static let account = "session"

    // Retained for the duration of an in-flight system auth request.
    private var appleController: AppleSignInController?
    private var webSession: ASWebAuthenticationSession?
    private var webProvider: WebAuthPresentationProvider?

    var isSignedIn: Bool { session != nil }
    var user: AuthUser? { session?.user }

    init() {
        restore()
    }

    // MARK: Persistence

    private func restore() {
        if let data = Keychain.get(Self.account),
           let stored = try? JSONDecoder().decode(StoredSession.self, from: data) {
            session = stored
            Task { await validate() }
        }
    }

    private func persist(_ stored: StoredSession) {
        session = stored
        if let data = try? JSONEncoder().encode(stored) {
            Keychain.set(data, for: Self.account)
        }
    }

    private func clearLocal() {
        session = nil
        Keychain.delete(Self.account)
    }

    /// Re-check a restored token; drop it if the server rejects it. Network
    /// errors are tolerated (stay signed in offline).
    func validate() async {
        guard let stored = session else { return }
        do {
            if let user = try await client.me(token: stored.token) {
                persist(StoredSession(token: stored.token, csrf: stored.csrf, user: user))
            } else {
                clearLocal() // token no longer valid
            }
        } catch AuthError.badResponse(401) {
            clearLocal()
        } catch {
            // keep the session on transient/network errors
        }
    }

    // MARK: Sign in with Apple

    func signInWithApple() async {
        errorMessage = nil
        isBusy = true
        defer { isBusy = false; appleController = nil }
        do {
            let rawNonce = Self.randomNonce()
            let controller = AppleSignInController(rawNonce: rawNonce)
            appleController = controller
            let credential = try await controller.start()
            let resp = try await client.signInWithApple(
                identityToken: credential.identityToken,
                rawNonce: credential.rawNonce,
                name: credential.name,
                email: credential.email
            )
            persist(StoredSession(token: resp.token, csrf: resp.csrf, user: resp.user))
        } catch let error as ASAuthorizationError where error.code == .canceled {
            // user dismissed — not an error
        } catch {
            errorMessage = "Sign in with Apple didn't complete. Please try again."
        }
    }

    // MARK: Continue with Google (web)

    func signInWithGoogle() async {
        errorMessage = nil
        isBusy = true
        defer { isBusy = false; webSession = nil; webProvider = nil }
        do {
            var comps = URLComponents(url: Config.baseURL.appendingPathComponent("api/auth/login"),
                                      resolvingAgainstBaseURL: false)!
            comps.queryItems = [
                URLQueryItem(name: "client", value: "ios"),
                URLQueryItem(name: "returnTo", value: "/"),
            ]
            let callback = try await runWebAuth(url: comps.url!)
            guard let (token, csrf) = Self.parseCallback(callback) else {
                throw AuthError.decoding
            }
            // Fetch the user for this fresh session.
            let user = try await client.me(token: token)
            guard let user else { throw AuthError.decoding }
            persist(StoredSession(token: token, csrf: csrf, user: user))
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            // user closed the sheet — not an error
        } catch {
            errorMessage = "Google sign-in didn't complete. Please try again."
        }
    }

    private func runWebAuth(url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let provider = WebAuthPresentationProvider()
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "kaleidoscope") { callbackURL, error in
                if let callbackURL {
                    continuation.resume(returning: callbackURL)
                } else {
                    continuation.resume(throwing: error ?? AuthError.network)
                }
            }
            session.presentationContextProvider = provider
            self.webProvider = provider
            self.webSession = session
            session.start()
        }
    }

    /// Parse `kaleidoscope://auth-callback#token=…&csrf=…` (fragment, not query).
    static func parseCallback(_ url: URL) -> (token: String, csrf: String)? {
        guard let fragment = url.fragment else { return nil }
        var comps = URLComponents()
        comps.query = fragment
        let items = comps.queryItems ?? []
        guard let token = items.first(where: { $0.name == "token" })?.value,
              let csrf = items.first(where: { $0.name == "csrf" })?.value,
              !token.isEmpty, !csrf.isEmpty
        else { return nil }
        return (token, csrf)
    }

    // MARK: Sign out / delete

    func signOut() async {
        if let stored = session {
            try? await client.logout(token: stored.token, csrf: stored.csrf)
        }
        clearLocal()
    }

    func deleteAccount() async -> Bool {
        guard let stored = session else { return true }
        isBusy = true
        defer { isBusy = false }
        do {
            try await client.deleteAccount(token: stored.token, csrf: stored.csrf)
            clearLocal()
            return true
        } catch {
            errorMessage = "Couldn't delete your account. Please try again."
            return false
        }
    }

    private static func randomNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
