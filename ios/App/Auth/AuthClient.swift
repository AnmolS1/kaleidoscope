import Foundation

enum AuthError: Error { case badResponse(Int), decoding, network }

/// Authenticated API calls (Bearer + CSRF). Separate from the widget's
/// `APIClient` so the memory-constrained widget extension never links this.
struct AuthClient {
    var baseURL: URL = Config.baseURL
    var session: URLSession = .shared

    func url(_ path: String) -> URL { baseURL.appendingPathComponent(path) }

    /// Attach Bearer + CSRF to a mutating request. Native always sends both; the
    /// server skips the CSRF check for Bearer but honors it when present.
    func authorized(_ req: inout URLRequest, token: String, csrf: String?) {
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let csrf { req.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token") }
    }

    func send(_ req: URLRequest) async throws -> Data {
        let (data, resp): (Data, URLResponse)
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw AuthError.network
        }
        guard let http = resp as? HTTPURLResponse else { throw AuthError.network }
        guard (200..<300).contains(http.statusCode) else { throw AuthError.badResponse(http.statusCode) }
        return data
    }

    // MARK: Endpoints

    /// Validate a stored token and fetch the current user.
    func me(token: String) async throws -> AuthUser? {
        var req = URLRequest(url: url("api/me"))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        authorized(&req, token: token, csrf: nil)
        let data = try await send(req)
        return try decode(MeResponse.self, data).user
    }

    /// Exchange an Apple identity token for a session.
    func signInWithApple(identityToken: String, rawNonce: String, name: String?, email: String?) async throws -> AppleAuthResponse {
        var body: [String: String] = ["identityToken": identityToken, "rawNonce": rawNonce]
        if let name, !name.isEmpty { body["name"] = name }
        if let email, !email.isEmpty { body["email"] = email }

        var req = URLRequest(url: url("api/auth/apple"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
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
