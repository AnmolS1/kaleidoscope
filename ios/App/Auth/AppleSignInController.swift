import AuthenticationServices
import CryptoKit
import UIKit

/// The Apple credential we forward to the server.
struct AppleCredential {
    let identityToken: String
    let rawNonce: String
    let name: String?
    let email: String?
}

/// Finds the active foreground window to anchor system auth sheets.
@MainActor
func keyWindowAnchor() -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.first(where: { $0.activationState == .foregroundActive })?.keyWindow
        ?? scenes.first?.windows.first
    return window ?? ASPresentationAnchor()
}

/// Lowercase hex of SHA-256(input) — the digest set as the request nonce (Apple
/// echoes it in the token, and the server checks `nonce == SHA256(rawNonce)`).
func sha256Hex(_ input: String) -> String {
    SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// Drives a single Sign in with Apple request and returns the credential. The
/// caller must retain this for the request's lifetime (the controller holds its
/// delegate weakly).
@MainActor
final class AppleSignInController: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {

    private let rawNonce: String
    private var continuation: CheckedContinuation<AppleCredential, Error>?
    private var controller: ASAuthorizationController?

    init(rawNonce: String) {
        self.rawNonce = rawNonce
    }

    func start() async throws -> AppleCredential {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let provider = ASAuthorizationAppleIDProvider()
            let request = provider.createRequest()
            request.requestedScopes = [.fullName, .email]
            request.nonce = sha256Hex(rawNonce)
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8)
        else {
            // Not an HTTP failure at all — Apple handed back a credential we
            // cannot read. It was `.badResponse(0)` before 1.2, which is a
            // status code that never existed.
            continuation?.resume(throwing: AuthError.decoding)
            continuation = nil
            return
        }
        // Apple only provides fullName/email on the FIRST authorization.
        let name = credential.fullName.flatMap { formatter -> String? in
            let f = PersonNameComponentsFormatter()
            let s = f.string(from: formatter)
            return s.isEmpty ? nil : s
        }
        continuation?.resume(returning: AppleCredential(
            identityToken: identityToken,
            rawNonce: rawNonce,
            name: name,
            email: credential.email
        ))
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        keyWindowAnchor()
    }
}
