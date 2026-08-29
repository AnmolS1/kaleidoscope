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

    /// The Plus/cap block from `/api/me`. Nil until the first successful call
    /// (and while signed out), which is why every reader treats nil as "unknown"
    /// and falls back to the free defaults rather than to zero.
    @Published private(set) var plus: PlusState?

    /// How many layers the studio may hold. `FREE_LAYER_CAP` (3) until the
    /// server says otherwise — erring low is safe because `canAddLayer` is a
    /// gate, not a display.
    var layerCap: Int { plus?.layerCap ?? 3 }

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
        plus = nil
        Keychain.delete(Self.account)
    }

    /// Re-check a restored token; drop it if the server rejects it. Network
    /// errors are tolerated (stay signed in offline).
    func validate() async {
        guard let stored = session else { return }
        do {
            let me = try await client.me(token: stored.token)
            guard let user = me.user else {
                clearLocal() // token no longer valid
                plus = nil
                return
            }
            persist(StoredSession(token: stored.token, csrf: stored.csrf, user: user))
            plus = me.plus
        } catch {
            // A 401 means the token is dead and the session must go; anything
            // else (offline, a 500) must NOT sign the user out. The decision is
            // `shouldSignOut` rather than a `catch` pattern because a pattern
            // that stops matching — which is exactly what happened when
            // `.badResponse(401)` was replaced by `.api(status:body:)` — fails
            // SILENTLY into the tolerant branch, and a dead session then lives
            // forever. A function can be tested; a pattern that never fires
            // looks identical to one that never had a reason to.
            if Self.shouldSignOut(on: error) {
                clearLocal()
                plus = nil
            }
        }
    }

    /// Does this failure mean the stored token is gone for good?
    static func shouldSignOut(on error: Error) -> Bool {
        (error as? AuthError)?.status == 401
    }

    /// Re-read `/api/me` for the cap/Plus state alone (after a save, or after
    /// the visibility of a piece changes). Never clears the session: this is a
    /// refresh, and a failed refresh must leave the last known state standing.
    func refreshPlus() async {
        guard let stored = session else { return }
        if let me = try? await client.me(token: stored.token), let p = me.plus { plus = p }
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
            // The Apple exchange returns no `plus`, and the save dialog re-renders
            // the moment this returns — without this the freshly signed-in user
            // would see the free layer cap and no cap note.
            await refreshPlus()
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
            let me = try await client.me(token: token)
            guard let user = me.user else { throw AuthError.decoding }
            persist(StoredSession(token: token, csrf: csrf, user: user))
            plus = me.plus
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
