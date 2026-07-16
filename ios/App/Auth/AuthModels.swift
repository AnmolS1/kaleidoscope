import Foundation

/// The public user shape returned by the API (`SessionUser`).
struct AuthUser: Codable, Equatable, Identifiable {
    let id: String
    let name: String?
    let avatar: String?
    let role: String
    let flagged: Bool
}

/// Everything needed to make authenticated calls, persisted in the Keychain.
struct StoredSession: Codable, Equatable {
    var token: String
    var csrf: String
    var user: AuthUser
}

/// `POST /api/auth/apple` → `{ token, csrf, user }`.
struct AppleAuthResponse: Codable {
    let token: String
    let csrf: String
    let user: AuthUser
}

/// `GET /api/me` → `{ user, csrf }`.
struct MeResponse: Codable {
    let user: AuthUser?
    let csrf: String?
}
