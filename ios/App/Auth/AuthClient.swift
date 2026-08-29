import Foundation

/// A decoded `{ error, message, … }` body. Every 4xx/5xx the Worker returns is
/// this shape, so the code that decides what the user sees reads `code` rather
/// than re-deriving intent from a bare status number.
struct APIErrorBody: Decodable, Equatable {
    /// The Worker's machine-readable code: `duplicate_of_other`, `cap_reached`,
    /// `title_required`, `rate_limited`, …
    let error: String?
    /// Human copy the Worker chose to send (`rate_limited` has one).
    let message: String?
    /// `duplicate_of_other`: the twin's id, present ONLY when it is viewable.
    /// Absent means someone else's PRIVATE twin — a different dialog state, so
    /// the distinction has to survive decoding.
    let of: String?
    let cap: Int?
    let count: Int?
}

/// Transport failures.
///
/// `api` carries the status AND the decoded body: the save dialog has eleven
/// states and several are told apart only by the body (`duplicate_of_other`
/// with vs. without `of`), so collapsing a response to `badResponse(409)` — as
/// this did before 1.2 — makes those states unreachable and every known code
/// render the same generic "Couldn't save".
enum AuthError: Error, Equatable {
    case api(status: Int, body: APIErrorBody?)
    case decoding
    case network

    var status: Int? {
        if case let .api(status, _) = self { return status }
        return nil
    }

    /// The Worker's `error` code, when there was one.
    var code: String? {
        if case let .api(_, body) = self { return body?.error }
        return nil
    }

    var body: APIErrorBody? {
        if case let .api(_, body) = self { return body }
        return nil
    }
}

/// Authenticated API calls (Bearer + CSRF). Separate from the widget's
/// `APIClient` so the memory-constrained widget extension never links this.
struct AuthClient {
    /// What this client announces to the Worker. `v2` unlocks the strict title
    /// rule (`validateTitle`) — a client that has a title field and does not
    /// announce it silently gets the legacy "Untitled" fallback instead of the
    /// `title_required` 400 the dialog is built to show.
    static let clientCaps = "v2"

    var baseURL: URL = Config.baseURL
    var session: URLSession = .shared

    func url(_ path: String) -> URL { baseURL.appendingPathComponent(path) }

    /// A URL with a real query string.
    ///
    /// NOT `url(path + "?v=2")`: `appendingPathComponent` percent-encodes the
    /// `?` into `%3F`, yielding `…/vector%3Fv=2` — one path segment. The Worker
    /// then sees no `v` param at all, so the request behaves exactly as it did
    /// before while the source reads as though the parameter were being sent.
    func url(_ path: String, query: [URLQueryItem]) -> URL {
        var comps = URLComponents(url: url(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { comps.queryItems = query }
        return comps.url!
    }

    /// Attach Bearer + CSRF to a mutating request. Native always sends both; the
    /// server skips the CSRF check for Bearer but honors it when present.
    func authorized(_ req: inout URLRequest, token: String, csrf: String?) {
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let csrf { req.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
    }

    /// Announce v2 capability. Sent on POST/PATCH — the only routes that branch
    /// on it (`hasV2Caps` in the Worker gates the strict title rule).
    func announceCaps(_ req: inout URLRequest) {
        req.setValue(Self.clientCaps, forHTTPHeaderField: "X-Client-Caps")
    }

    func send(_ req: URLRequest) async throws -> Data {
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw AuthError.network
        }
        guard let http = resp as? HTTPURLResponse else { throw AuthError.network }
        guard (200..<300).contains(http.statusCode) else {
            throw AuthError.api(status: http.statusCode, body: Self.errorBody(data))
        }
        return data
    }

    /// Best-effort decode of an error payload. A body that is not the expected
    /// shape (an edge HTML error page, say) yields `nil` rather than throwing,
    /// so the status is never lost to a decoding failure.
    static func errorBody(_ data: Data) -> APIErrorBody? {
        try? JSONDecoder().decode(APIErrorBody.self, from: data)
    }

    // MARK: Endpoints

    /// Validate a stored token and fetch the current user.
    ///
    /// Returns the whole response, not just the user: since 1.2 `/api/me` also
    /// carries `plus` (the layer cap and the public-post count), and the save
    /// dialog and the layers panel both read it.
    func me(token: String) async throws -> MeResponse {
        var req = URLRequest(url: url("api/me"))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        authorized(&req, token: token, csrf: nil)
        let data = try await send(req)
        return try decode(MeResponse.self, data)
    }

    /// Exchange an Apple identity token for a session.
    func signInWithApple(identityToken: String, rawNonce: String, name: String?, email: String?) async throws -> AppleAuthResponse {
        var body: [String: String] = ["identityToken": identityToken, "rawNonce": rawNonce]
        if let name, !name.isEmpty { body["name"] = name }
        if let email, !email.isEmpty { body["email"] = email }

        var req = URLRequest(url: url("api/auth/apple"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        announceCaps(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data = try await send(req)
        return try decode(AppleAuthResponse.self, data)
    }

    func logout(token: String, csrf: String) async throws {
        var req = URLRequest(url: url("api/auth/logout"))
        req.httpMethod = "POST"
        authorized(&req, token: token, csrf: csrf)
        _ = try await send(req)
    }

    func deleteAccount(token: String, csrf: String) async throws {
        var req = URLRequest(url: url("api/me"))
        req.httpMethod = "DELETE"
        authorized(&req, token: token, csrf: csrf)
        _ = try await send(req)
    }

    func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw AuthError.decoding }
    }
}
