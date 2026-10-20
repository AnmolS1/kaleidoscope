import Foundation

/// Fetches artwork image bytes for `ArtworkImage` (and the share sheet), with a
/// cache that can never answer one session with another session's private piece.
///
/// 🔴 The defect this replaces: `URLSession.shared` + `.returnCacheDataElseLoad`.
/// `URLCache` keys by URL alone and the image URL carries no per-user
/// component, so once a signed-in owner had viewed a private piece, a later
/// request with NO token (after sign-out) or ANOTHER user's token was answered
/// from the cache — the worker's `canView` never ran. `private` in
/// `Cache-Control` does not help: it forbids SHARED caches, and an app's URL
/// cache is a private one, for the device rather than the person.
///
/// So there are two lanes, chosen by whether a token is sent:
///
/// - **Anonymous** (no token): a disk `URLCache` of its own. Only bytes any
///   signed-out caller may fetch can land here, because the request that filled
///   it carried no credentials. Public gallery images stay cached across
///   launches.
/// - **Authenticated** (a token): the network session stores NOTHING; bytes go
///   in an in-memory store tagged with the token that fetched them. A different
///   token — or none — never reads it, and `AuthModel` purges it on sign-out,
///   account deletion and a rejected session. Memory-only, so a private drawing
///   is not written to disk by this path either.
///
/// Rejected alternatives: not caching authed loads at all (every revisit of My
/// Pieces refetches every thumbnail); one `.ephemeral` session for authed loads
/// (its cache lives as long as the session object, so it still leaks across a
/// sign-out unless rebuilt — the same purge hook, with less control).
final class ArtworkImageLoader: @unchecked Sendable {
    static let shared = ArtworkImageLoader()

    let anonymousCache: URLCache
    private let anonymousSession: URLSession
    private let authenticatedSession: URLSession

    private let lock = NSLock()
    private var authenticatedToken: String?
    private let authenticatedStore = NSCache<NSURL, NSData>()

    init(protocolClasses: [AnyClass]? = nil, anonymousCache: URLCache? = nil) {
        let anonCache = anonymousCache ?? URLCache(
            memoryCapacity: 20 * 1024 * 1024,
            diskCapacity: 150 * 1024 * 1024,
            directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
                .appendingPathComponent("ArtworkImagesPublic", isDirectory: true)
        )
        self.anonymousCache = anonCache

        let anonConfig = URLSessionConfiguration.default
        anonConfig.urlCache = anonCache
        anonConfig.requestCachePolicy = .returnCacheDataElseLoad
        let authConfig = URLSessionConfiguration.default
        authConfig.urlCache = nil
        authConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
        if let protocolClasses {
            anonConfig.protocolClasses = protocolClasses
            authConfig.protocolClasses = protocolClasses
        }
        anonymousSession = URLSession(configuration: anonConfig)
        authenticatedSession = URLSession(configuration: authConfig)
        authenticatedStore.totalCostLimit = 40 * 1024 * 1024
    }

    /// Bytes for `url`, or a throw for anything but a 200 — a 404 body must never
    /// reach a caller that would draw or share it as an image.
    func data(for url: URL, token: String?) async throws -> Data {
        guard let token else {
            var req = URLRequest(url: url)
            req.cachePolicy = .returnCacheDataElseLoad
            return try await fetch(req, on: anonymousSession)
        }
        if let hit = cached(url, token: token) { return hit }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let data = try await fetch(req, on: authenticatedSession)
        store(data, for: url, token: token)
        return data
    }

    /// Drop every authenticated byte. Called whenever the session ends.
    func purgeAuthenticated() {
        lock.lock(); defer { lock.unlock() }
        authenticatedStore.removeAllObjects()
        authenticatedToken = nil
    }

    /// Builds before this fix filled `URLCache.shared` with private pieces,
    /// keyed by URL and readable by any later session. Clear it once.
    static func purgeLegacySharedCacheOnce(defaults: UserDefaults = .standard) {
        let key = "artworkImageCache.legacySharedPurged"
        guard !defaults.bool(forKey: key) else { return }
        URLCache.shared.removeAllCachedResponses()
        defaults.set(true, forKey: key)
    }

    // MARK: -

    private func fetch(_ req: URLRequest, on session: URLSession) async throws -> Data {
        let (data, res) = try await session.data(for: req)
        guard let http = res as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    private func cached(_ url: URL, token: String) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard authenticatedToken == token else { return nil }
        return authenticatedStore.object(forKey: url as NSURL) as Data?
    }

    private func store(_ data: Data, for url: URL, token: String) {
        lock.lock(); defer { lock.unlock() }
        // A new token means a new session: whatever the old one fetched goes,
        // even if no sign-out hook ran in between.
        if authenticatedToken != token {
            authenticatedStore.removeAllObjects()
            authenticatedToken = token
        }
        authenticatedStore.setObject(data as NSData, forKey: url as NSURL, cost: data.count)
    }
}
