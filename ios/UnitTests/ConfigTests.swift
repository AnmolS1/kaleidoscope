import XCTest
@testable import Kaleidoscope

/// REVIEW.md minor mI6 — the ATS exception ships in Release, so the claim that
/// nothing in a Release build talks cleartext needs a test and not a comment.
///
/// `NSAllowsLocalNetworking` permits HTTP to loopback, `.local` and link-local
/// addresses. That is harmless exactly as long as no shipped code path points at
/// one. These assertions are what make that true rather than believed: the
/// endpoints are compile-time constants, and the only override is inside a
/// `#if DEBUG` whose string literal cannot survive into a Release binary.
final class ConfigTests: XCTestCase {

    func testShippedEndpointsAreHTTPS() {
        XCTAssertEqual(Config.webURL.scheme, "https")
        // In a Release build this is unconditionally the constant. In a DEBUG
        // test run it is the constant too, unless someone has set the override
        // in the scheme — which is why the next test pins the override's shape
        // rather than this one pinning its absence.
        #if !DEBUG
            XCTAssertEqual(Config.baseURL.scheme, "https")
        #endif
    }

    func testTheLocalOverrideIsReadFromTheEnvironmentAndNotFromSource() {
        // The point of the override existing at all: local iteration used to
        // require editing Config.swift, an uncommitted change that can be
        // committed by accident and cannot be seen in a review of the diff.
        #if DEBUG
            let set = ProcessInfo.processInfo.environment["KALEIDO_BASE_URL"]
            if let set, let expected = URL(string: set) {
                XCTAssertEqual(Config.baseURL, expected)
            } else {
                XCTAssertEqual(Config.baseURL.scheme, "https")
            }
        #endif
    }

    func testTheWidgetAndAppAgreeOnTheHost() {
        // The widget carries its own copy of the ATS exception because
        // extensions do not inherit the host's. It reads the same Config, so
        // there is exactly one host to reason about.
        XCTAssertEqual(Config.webURL.host, "kaleidoscope.ponderance.dev")
    }
}
