import XCTest
@testable import Kaleidoscope

/// Answers like `/api/artworks/:id/image` does: a `/private/` path is 200 only
/// WITH a bearer token (404 without — `canView`), a `/public/` path is 200 to
/// anyone. Both carry the worker's real year-long `Cache-Control` and let the
/// cache store them, which `StubProtocol` deliberately does not — a stub that
/// refuses caching would make every "the network was hit again" assertion pass
/// against the defect.
final class ArtworkCacheStub: URLProtocol {
    static var requests: [URLRequest] = []
    static let privateBytes = Data("PRIVATE-DRAWING".utf8)
    static let publicBytes = Data("PUBLIC-DRAWING".utf8)

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // The URL loading system looks the request up in the session's cache
        // (per its cache policy) and hands any hit to the protocol; the built-in
        // HTTP protocol then answers from it without touching the network. A
        // custom protocol has to do the same, or this harness could never
        // observe a cache hit at all.
        if let cached = cachedResponse {
            client?.urlProtocol(self, didReceive: cached.response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: cached.data)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        Self.requests.append(request)
        let url = request.url!
        let authed = request.value(forHTTPHeaderField: "Authorization") != nil
        let status: Int
        let body: Data
        var headers: [String: String] = [:]
        if url.path.hasPrefix("/private/") {
            status = authed ? 200 : 404
            body = authed ? Self.privateBytes : Data("not found".utf8)
            if authed { headers["Cache-Control"] = "private, max-age=31536000, immutable" }
        } else {
            status = 200
            body = Self.publicBytes
            headers["Cache-Control"] = "public, max-age=31536000, immutable"
        }
        let http = HTTPURLResponse(url: url, statusCode: status,
                                   httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .allowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A private piece must never be answered from cache to a different session —
/// or to no session. `URLCache` keys by URL alone, and the image URL carries no
/// per-user component, so a cache shared across sessions hands one user's
/// private drawing to whoever asks next, with no `canView` in the way.
final class ArtworkImageCacheTests: XCTestCase {
    private let privateURL = URL(string: "https://kaleido.test/private/art1/image")!
    private let publicURL = URL(string: "https://kaleido.test/public/art2/image")!

    override func setUp() {
        ArtworkCacheStub.requests = []
    }

    /// Fresh in-memory caches per test, large enough that nothing is skipped
    /// for size (URLCache refuses entries over ~5% of capacity).
    private func makeLoader() -> ArtworkImageLoader {
        ArtworkImageLoader(
            protocolClasses: [ArtworkCacheStub.self],
            anonymousCache: URLCache(memoryCapacity: 10_000_000, diskCapacity: 0)
        )
    }

    /// The authenticated lane stores synchronously before `data(for:)` returns,
    /// and `testSameSessionReusesItsOwnPrivateImage` proves it does store — so
    /// the private-lane misses below are misses by design, not by timing.
    /// The anonymous lane is a URLCache, which stores asynchronously; wait until the entry is really there, so
    /// a second load that misses is a miss by design and not by timing.
    private func waitUntilCached(_ url: URL, in cache: URLCache,
                                 file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<100 {
            if cache.cachedResponse(for: URLRequest(url: url)) != nil { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTFail("response was never cached — the test would prove nothing", file: file, line: line)
    }

    func testPrivateImageIsNotServedFromCacheAfterSignOut() async throws {
        let loader = makeLoader()
        let first = try await loader.data(for: privateURL, token: "token-A")
        XCTAssertEqual(first, ArtworkCacheStub.privateBytes)

        loader.purgeAuthenticated() // what AuthModel.clearLocal does on sign-out

        var leaked: Data?
        do { leaked = try await loader.data(for: privateURL, token: nil) } catch {}
        XCTAssertNil(leaked, "a signed-out load returned the private bytes")
        XCTAssertEqual(ArtworkCacheStub.requests.count, 2,
                       "the signed-out load never reached the server, so nothing checked canView")
        XCTAssertNil(ArtworkCacheStub.requests.last?.value(forHTTPHeaderField: "Authorization"))
    }

    /// Even if no purge runs at all (a path that forgets the hook), a tokenless
    /// load must not read what an authed load cached.
    func testTokenlessLoadNeverReadsTheAuthenticatedCache() async throws {
        let loader = makeLoader()
        _ = try await loader.data(for: privateURL, token: "token-A")

        var leaked: Data?
        do { leaked = try await loader.data(for: privateURL, token: nil) } catch {}
        XCTAssertNil(leaked)
        XCTAssertEqual(ArtworkCacheStub.requests.count, 2)
    }

    /// Switching accounts: the second user's request must go to the server with
    /// THEIR token, not be answered by the first user's cached copy.
    func testAccountSwitchDoesNotReuseAnotherSessionsPrivateImage() async throws {
        let loader = makeLoader()
        _ = try await loader.data(for: privateURL, token: "token-A")

        _ = try await loader.data(for: privateURL, token: "token-B")
        XCTAssertEqual(ArtworkCacheStub.requests.count, 2,
                       "user B was served user A's cached private image")
        XCTAssertEqual(ArtworkCacheStub.requests.last?.value(forHTTPHeaderField: "Authorization"),
                       "Bearer token-B")
    }

    /// Control: caching still WORKS. Without this, "the network was hit twice"
    /// above could just mean nothing is ever cached in this harness.
    func testPublicImageIsServedFromCacheOnTheSecondLoad() async throws {
        let loader = makeLoader()
        _ = try await loader.data(for: publicURL, token: nil)
        try await waitUntilCached(publicURL, in: loader.anonymousCache)
        let second = try await loader.data(for: publicURL, token: nil)
        XCTAssertEqual(second, ArtworkCacheStub.publicBytes)
        XCTAssertEqual(ArtworkCacheStub.requests.count, 1)
    }

    /// Control for the signed-in lane: the same session re-viewing its own
    /// private piece is still a cache hit — the fix is not "never cache".
    func testSameSessionReusesItsOwnPrivateImage() async throws {
        let loader = makeLoader()
        _ = try await loader.data(for: privateURL, token: "token-A")
        let second = try await loader.data(for: privateURL, token: "token-A")
        XCTAssertEqual(second, ArtworkCacheStub.privateBytes)
        XCTAssertEqual(ArtworkCacheStub.requests.count, 1)
    }
}
