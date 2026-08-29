import XCTest
@testable import Kaleidoscope

/// A `URLProtocol` that answers every request from a canned response and keeps
/// what it was asked.
///
/// The body has to be drained from `httpBodyStream`, not read off `httpBody`:
/// `URLSession` converts one into the other before a custom protocol sees the
/// request, so `request.httpBody` here is **nil** for a body the caller
/// definitely set. A test that asserted on `httpBody` would read nil, compare it
/// to nil, and pass whether or not a PATCH body was ever built.
final class StubProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var bodies: [Data] = []
    static var status = 200
    static var responseBody = Data(#"{"ok":true}"#.utf8)

    static func reset(status: Int = 200, body: String = #"{"ok":true}"#) {
        requests = []
        bodies = []
        Self.status = status
        responseBody = Data(body.utf8)
    }

    /// An `AuthClient` whose every request lands in this stub instead of the
    /// network. Ephemeral config + `protocolClasses`, not `registerClass` on
    /// `.shared`, so nothing leaks between tests.
    static func client() -> AuthClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return AuthClient(session: URLSession(configuration: config))
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        Self.bodies.append(Self.drain(request))
        let http = HTTPURLResponse(url: request.url!, statusCode: Self.status,
                                   httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ req: URLRequest) -> Data {
        if let body = req.httpBody { return body }
        guard let stream = req.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        return data
    }
}

/// "Edit title & visibility" on `SaveSelfUnchanged` (DESIGN.md §4).
///
/// The state has two actions and iOS shipped one, so title editing was
/// unreachable anywhere in the app. Every assertion below is written to fail if
/// the action is removed, if the request never leaves, or if the sheet does not
/// reflect what came back — "the button exists" is true in all three of those.
final class SaveEditTests: XCTestCase {
    override func setUp() {
        super.setUp()
        StubProtocol.reset()
    }

    // MARK: 1 — the action is actually offered

    func testTheEditActionIsOffered() {
        let actions = selfUnchangedActions(pieceId: "abc123", twinLoaded: true)
        XCTAssertEqual(actions, [.openIt, .editTitle])
        // The copy is the spec's, verbatim — the frame draws these two labels.
        XCTAssertEqual(actions.map(\.label), ["Open it", "Edit title & visibility"])
    }

    func testEveryActionIsReachable() {
        // Mirrors `testEveryStateIsReachable`: an action that is defined and
        // never returned renders nowhere, and looks exactly like one that works
        // and was never tapped. This asserts the list is onto.
        let offered: [[SelfUnchangedAction]] = [
            selfUnchangedActions(pieceId: nil, twinLoaded: false),
            selfUnchangedActions(pieceId: "a", twinLoaded: false),
            selfUnchangedActions(pieceId: "a", twinLoaded: true),
        ]
        XCTAssertEqual(Set(offered.flatMap { $0 }), Set(SelfUnchangedAction.allCases))
    }

    func testEditIsWithheldUntilThePieceIsLoaded() {
        // Deviation from the frame, which draws both buttons unconditionally.
        // The form is seeded from the piece's stored title and visibility; with
        // no piece the field would open empty, and a confirm would blank the
        // name of something already saved. `Open it` needs only the id, so it
        // survives a failed fetch.
        XCTAssertEqual(selfUnchangedActions(pieceId: "a", twinLoaded: false), [.openIt])
        // And with no id at all there is nothing to act on.
        XCTAssertEqual(selfUnchangedActions(pieceId: nil, twinLoaded: true), [])
    }

    // MARK: 2 — the PATCH really goes out, with the right body

    func testEditIssuesThePatchWithTheRightBody() async throws {
        let sent = try await sendTitlePatch(
            id: "abc123", title: "  Dawn Bloom  ", visibility: .unlisted,
            client: StubProtocol.client(), token: "tok", csrf: "csrf")
        XCTAssertTrue(sent)

        let req = try XCTUnwrap(StubProtocol.requests.first, "no request was issued at all")
        XCTAssertEqual(StubProtocol.requests.count, 1)
        XCTAssertEqual(req.httpMethod, "PATCH")
        XCTAssertEqual(try XCTUnwrap(req.url).path, "/api/artworks/abc123")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-CSRF-Token"), "csrf")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        // Without this header the Worker takes us for a legacy client and runs
        // `cleanTitle` instead of `validateTitle` — an "Untitled" PATCH then
        // SUCCEEDS, and nothing the client can see says so.
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Client-Caps"), "v2")

        let body = try XCTUnwrap(StubProtocol.bodies.first)
        XCTAssertFalse(body.isEmpty, "the body never reached the wire")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        // Exactly these two keys: a PATCH that omitted `title` would leave the
        // rename silently undone while every other assertion here still passes.
        XCTAssertEqual(json, ["title": "Dawn Bloom", "visibility": "unlisted"])
    }

    func testTheWireCarriesTheCharactersTheUserTyped() async throws {
        // `un<ﬁ>tled` folds to "unfitled" under NFKC, so it is a perfectly valid
        // title — already asserted in `testTitleRuleMatchesValidateTitle`. NFKC
        // decides whether a title is REFUSED; it must never decide what is
        // STORED. An implementation that patched the folded form would pass
        // "a valid title is accepted" and quietly rewrite the user's name.
        let ligature = "un\u{FB01}tled"
        let sent = try await sendTitlePatch(
            id: "a", title: ligature, visibility: .public,
            client: StubProtocol.client(), token: "t", csrf: "c")
        XCTAssertTrue(sent)

        let body = try XCTUnwrap(StubProtocol.bodies.first)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
        XCTAssertEqual(json["title"], ligature)
        XCTAssertNotEqual(json["title"], "unfitled", "the title was NFKC-folded on its way out")
    }

    func testARefusedTitlePutsNothingOnTheWire() async throws {
        // Not "the helper returned nil": the fact that matters is that no
        // request is issued. The button is disabled for these, but a disabled
        // button is a different claim from an unsent request, and only one of
        // them survives a future caller.
        for bad in ["", "   ", "Untitled", "  untitled  ",
                    "\u{FF55}\u{FF4E}\u{FF54}\u{FF49}\u{FF54}\u{FF4C}\u{FF45}\u{FF44}",  // fullwidth
                    "unt\u{2170}tled"] {                                                  // U+2170 for i
            StubProtocol.reset()
            let sent = try await sendTitlePatch(
                id: "a", title: bad, visibility: .public,
                client: StubProtocol.client(), token: "t", csrf: "c")
            XCTAssertFalse(sent, "\(bad.debugDescription) was sent")
            XCTAssertEqual(StubProtocol.requests.count, 0, "\(bad.debugDescription) reached the network")
        }
    }

    func testTheStubWouldHaveSeenARequest() async throws {
        // The control for the test above. A stub that silently captured nothing
        // would make every "no request was issued" assertion vacuous.
        StubProtocol.reset()
        _ = try await sendTitlePatch(id: "a", title: "Real Name", visibility: .private,
                                     client: StubProtocol.client(), token: "t", csrf: "c")
        XCTAssertEqual(StubProtocol.requests.count, 1)
    }

    func testTitlePatchTrimsButKeepsTheOriginal() {
        XCTAssertEqual(titlePatch(id: "a", title: "  Dawn Bloom ", visibility: .private),
                       TitlePatch(id: "a", title: "Dawn Bloom", visibility: "private"))
        XCTAssertNil(titlePatch(id: "a", title: " untitled ", visibility: .public))
    }

    func testAnHTTPFailureIsNotReportedAsSuccess() async {
        StubProtocol.reset(status: 500, body: #"{"error":"boom"}"#)
        do {
            _ = try await sendTitlePatch(id: "a", title: "Dawn Bloom", visibility: .public,
                                         client: StubProtocol.client(), token: "t", csrf: "c")
            XCTFail("a 500 was swallowed")
        } catch {
            XCTAssertEqual((error as? AuthError)?.status, 500)
        }
    }

    // MARK: 3 — the sheet reflects what came back

    func testCapReachedShowsTheCapCopyAndMovesTheControl() {
        // The pairing is the point. A 402 that showed the note but left Public
        // selected would still read "your wall is full" next to a control
        // claiming the piece just went public.
        let err = AuthError.api(status: 402, body: AuthClient.errorBody(
            Data(#"{"error":"cap_reached","cap":10,"count":10}"#.utf8)))
        let f = editFailure(err, plusEnabled: true, fallbackCount: 3, fallbackCap: 99)
        XCTAssertEqual(f.visibility, .unlisted)
        XCTAssertFalse(f.titleRejected)
        XCTAssertEqual(f.note, "Public wall is full (10 of 10). Make another piece private to free a slot, or get Kaleidoscope Plus.")
        // Not the generic failure copy — DESIGN.md §4: "never a generic
        // 'Couldn't save' for a known code".
        XCTAssertNotEqual(f.note, saveErrorText(err))
        // The server's numbers win over the cached `plus` state, which is one
        // refresh behind by construction.
        XCTAssertFalse(f.note?.contains("99") ?? true)
    }

    func testCapNoteFallsBackToTheCachedCountsAndStaysReadable() {
        // A 402 whose body is missing or unparseable still has to say something
        // true. And the string is checked at its punctuation seams, the way the
        // save-side cap note is — a garbled sentence compiles and renders.
        for enabled in [false, true] {
            let bare = AuthError.api(status: 402, body: AuthClient.errorBody(
                Data(#"{"error":"cap_reached"}"#.utf8)))
            let f = editFailure(bare, plusEnabled: enabled, fallbackCount: 9, fallbackCap: 10)
            let note = f.note ?? ""
            XCTAssertTrue(note.contains("(9 of 10)"), note)
            XCTAssertTrue(capNoteReadsCleanly(note), note)
            XCTAssertEqual(note.contains("Kaleidoscope Plus"), enabled,
                           "Plus must be named exactly when plus.enabled")
            // Both exits are real because the cap is a CURRENT count.
            XCTAssertTrue(note.contains("Make another piece private"), note)
        }
        // Nothing known at all: still a sentence, never "(nil of nil)".
        let blind = patchCapNote(count: nil, cap: nil, plusEnabled: false)
        XCTAssertEqual(blind, "Public wall is full (? of ?). Make another piece private to free a slot.")
        XCTAssertTrue(capNoteReadsCleanly(blind))
    }

    func testTitleRequiredDecoratesTheFieldRatherThanTheSheet() {
        // The client rule and the Worker's disagreed. Trust the Worker — but
        // this is a field error, not a dialog state, so it carries no note and
        // must not move the visibility control.
        let err = AuthError.api(status: 400, body: AuthClient.errorBody(
            Data(#"{"error":"title_required"}"#.utf8)))
        let f = editFailure(err, plusEnabled: true, fallbackCount: 1, fallbackCap: 10)
        XCTAssertEqual(f, EditFailure(note: nil, titleRejected: true, visibility: nil))
    }

    func testAnUnknownFailureFallsBackWithoutTouchingTheControl() {
        // The control for the two above: if every branch returned the cap
        // pairing, they would both pass.
        let err = AuthError.api(status: 502, body: nil)
        let f = editFailure(err, plusEnabled: true, fallbackCount: 1, fallbackCap: 10)
        XCTAssertNil(f.visibility)
        XCTAssertFalse(f.titleRejected)
        XCTAssertEqual(f.note, "Couldn't reach the gallery. Your drawing is safe here — try again in a moment.")

        // A transport error is not an `AuthError` at all and must still say
        // something rather than crash into the cap branch.
        let dropped = editFailure(URLError(.notConnectedToInternet),
                                  plusEnabled: false, fallbackCount: nil, fallbackCap: nil)
        XCTAssertNil(dropped.visibility)
        XCTAssertEqual(dropped.note, saveErrorText(URLError(.notConnectedToInternet)))
    }

    func testTheTitleErrorCopyIsTheWorkersOwn() {
        // Three literals of this sentence exist in the codebase's history. The
        // sheet shows it on the save form and on the edit form; the Worker
        // returns it a third way as `title_required`. This is what keeps them
        // from drifting apart one edit at a time.
        let err = AuthError.api(status: 400, body: AuthClient.errorBody(
            Data(#"{"error":"title_required"}"#.utf8)))
        XCTAssertEqual(saveTitleErrorMessage, saveErrorText(err))
    }

    // MARK: 4 — the visibility control at the cap

    func testTheEditControlAlwaysContainsThePiecesOwnVisibility() {
        // The failure this rules out is silent by construction: a SwiftUI
        // Picker whose selection names no segment renders with NOTHING
        // selected, and the first tap moves the piece somewhere the user did
        // not choose. The invariant is stronger than any single row.
        for capReached in [false, true] {
            for current in Visibility.allCases {
                let options = editVisibilities(capReached: capReached, current: current)
                XCTAssertTrue(options.contains(current),
                              "capReached=\(capReached) current=\(current) has no segment to select")
            }
        }
    }

    func testAnAlreadyPublicPieceKeepsPublicAtTheCap() {
        // The Worker sends `public → public` down the plain-update path on
        // purpose ("its own row is inside the count"), so re-confirming public
        // on a piece that IS public never 402s and the segment must stay. This
        // is the typical at-cap user of this state: they are here BECAUSE they
        // already posted this piece publicly.
        XCTAssertEqual(editVisibilities(capReached: true, current: .public), Visibility.allCases)
        // The save form's rule, by contrast, does drop it — and so does an edit
        // that would genuinely publish something new.
        XCTAssertEqual(editVisibilities(capReached: true, current: .unlisted), [.unlisted, .private])
        XCTAssertEqual(editVisibilities(capReached: true, current: .private), [.unlisted, .private])
        XCTAssertEqual(editVisibilities(capReached: false, current: .private), Visibility.allCases)
    }
}
