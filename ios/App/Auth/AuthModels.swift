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

/// The Plus/cap block on `/api/me` (Worker `PlusState`).
///
/// The client never derives cap policy itself: `layerCap` is the number the
/// layers UI enforces and `publicCount`/`publicCap` is what the save dialog
/// shows. `publicCap` is genuinely nullable — it is null while the cap is not
/// enforced, and null is "no cap", NOT zero.
struct PlusState: Codable, Equatable {
    let active: Bool
    let sources: [String]
    let publicCount: Int
    let publicCap: Int?
    let layerCap: Int
    let enabled: Bool

    /// The public wall is full. Three conditions, all required.
    ///
    /// `enabled` matters because `/api/me` degrades to `enabled: false,
    /// publicCap: null, publicCount: 0` when `CAP_EPOCH` is malformed — reading
    /// a nil `publicCap` as 0 would put every user at the cap during a config
    /// typo, which is the opposite of the degrade's intent.
    var capReached: Bool {
        guard enabled, let cap = publicCap else { return false }
        return publicCount >= cap
    }
}

/// `GET /api/me` → `{ user, csrf, turnstileSiteKey, plus }`.
struct MeResponse: Codable {
    let user: AuthUser?
    let csrf: String?
    /// Present since 1.2. Null for a signed-out caller.
    let plus: PlusState?
}
