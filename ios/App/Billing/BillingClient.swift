import Foundation
import StoreKit

/// What the billing calls need out of the session.
///
/// A plain value rather than an `AuthModel` reference so `PlusStore` can be
/// driven from a test with no keychain, no network and no environment objects.
struct BillingSession: Equatable {
    /// The Kaleidoscope user id. Becomes `appAccountToken` on the purchase and
    /// is what the Worker compares the signed transaction against.
    let userId: String
    let token: String
    let csrf: String
}

/// `POST /api/billing/apple`.
///
/// Built on `AuthClient` rather than beside it: the URL builder, the Bearer +
/// CSRF header pair and the `AuthError` decoding are already correct there, and
/// a second copy of `send` is a second place for the error-body decoding to rot.
struct BillingClient {
    var auth = AuthClient()

    /// The Worker route. `POST /api/billing/apple`, body `{ jws }`.
    static let path = "api/billing/apple"

    /// 🔴 THE trap this whole file exists to get right (HANDOFF, "T14 precondition").
    ///
    /// `jwsRepresentation` is a property of `VerificationResult`, **not** of
    /// `Transaction`. Unwrapping the transaction first and looking for it there
    /// finds nothing, and the obvious next move — encoding the decoded
    /// `Transaction` as JSON — posts an UNSIGNED payload that the server can
    /// only reject. So this function takes the `VerificationResult` itself and
    /// forwards its representation verbatim: no re-encoding, no re-wrapping, no
    /// local verification of a thing the server is going to verify anyway.
    ///
    /// Taking the `VerificationResult` (and not a `String`) is deliberate: it
    /// puts the unwrap inside a function a unit test can drive with a real
    /// StoreKit transaction and then decode the posted body back out of.
    func appleRequest(for result: VerificationResult<Transaction>, session: BillingSession) throws -> URLRequest {
        var req = URLRequest(url: auth.url(Self.path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        auth.authorized(&req, token: session.token, csrf: session.csrf)
        req.httpBody = try JSONSerialization.data(withJSONObject: ["jws": result.jwsRepresentation])
        return req
    }

    /// Report a finished purchase. Throws `AuthError` — `reportVerdict` turns
    /// that into what the sheet says and whether the transaction may be finished.
    func reportApple(_ result: VerificationResult<Transaction>, session: BillingSession) async throws {
        let req = try appleRequest(for: result, session: session)
        _ = try await auth.send(req)
    }
}
