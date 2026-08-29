import XCTest
import KaleidoEngine
@testable import Kaleidoscope

/// The three changes that only work together (HANDOFF, "T13 must do all of it in
/// one go"): request `?v=2`, parse with `deserializeV2`, save from
/// `currentDrawingV2()`. Each has a shape that a naive assertion passes while
/// the bug is still present, so each test below is written against that shape.
final class SaveFlowWiringTests: XCTestCase {
    private let client = AuthClient()

    // MARK: 1 — the vector request really carries `?v=2`

    func testVectorRequestSendsV2AsAQueryParameter() throws {
        let req = client.vectorRequest(id: "abc123", token: nil)
        let url = try XCTUnwrap(req.url)
        let comps = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))

        // Asserted through URLComponents because that is what the Worker's
        // `c.req.query("v")` reads. `appendingPathComponent("…/vector?v=2")`
        // percent-encodes the `?` into `%3F`, producing ONE path segment
        // `vector%3Fv=2` with no query at all — a request that still succeeds,
        // just against the flattening path, so "a request was made" and even a
        // substring check on the raw string can pass while the bug stands.
        XCTAssertEqual(comps.queryItems, [URLQueryItem(name: "v", value: "2")])
        XCTAssertEqual(comps.path.hasSuffix("/api/artworks/abc123/vector"), true, comps.path)
        XCTAssertFalse(url.absoluteString.contains("%3F"), "the `?` was escaped into the path: \(url.absoluteString)")
    }

    func testTheEncodingTrapWouldBeCaught() {
        // The control for the test above: build the URL the buggy way and show
        // this assertion actually fails on it. Without this, a passing test is
        // no evidence the assertion can distinguish the two forms.
        let buggy = Config.baseURL.appendingPathComponent("api/artworks/abc123/vector?v=2")
        let comps = URLComponents(url: buggy, resolvingAgainstBaseURL: false)
        XCTAssertNil(comps?.queryItems, "the trap has stopped reproducing — re-derive the assertion")
        XCTAssertTrue(buggy.absoluteString.contains("%3F"))
    }

    // MARK: 2 — the parse site handles a mixed-symmetry v2 body

    /// Two visible layers with DIFFERENT symmetry: the shape that has no
    /// faithful v1 form, which is why the Worker answers 426 without `?v=2`.
    private func mixedSymmetryJSON() -> String {
        let pts = [StrokePoint(x: -100, y: -100, pressure: 0.5), StrokePoint(x: 100, y: 100, pressure: 0.5)]
        let stroke = Stroke(tool: .solid, color: "#e84a27", size: 12, opacity: 1, po: false, sm: true, pts: pts)
        let d = DrawingV2(bg: .light, layers: [
            Layer(id: "l1", name: "Base", visible: true, opacity: 1, sym: Symmetry(segments: 6, mirror: false), strokes: [stroke]),
            Layer(id: "l2", name: "Bloom", visible: true, opacity: 0.6, sym: Symmetry(segments: 12, mirror: true), strokes: [stroke]),
        ])
        return serialize(d)
    }

    func testTheRemixParseSiteReadsAMixedSymmetryBody() throws {
        // Through `ArtworkView.parseRemix`, which is the call site itself —
        // testing `deserializeV2` directly would pass while the view still
        // called `deserialize`, which is the bug.
        let parsed = try ArtworkView.parseRemix(mixedSymmetryJSON())
        XCTAssertEqual(parsed.layers.count, 2)
        XCTAssertEqual(parsed.layers.map(\.sym.segments), [6, 12])
        XCTAssertEqual(parsed.layers[1].opacity, 0.6, accuracy: 0.0001)
    }

    func testTheV1ParseSiteThrowsOnThatSameBody() {
        // The control. `deserialize` routes through `flattenToV1`, so adding
        // `?v=2` while the parse site still called it would have turned today's
        // 426 into a throw — worse, not better. This asserts the failure mode
        // the migration exists to remove is real.
        XCTAssertThrowsError(try deserialize(mixedSymmetryJSON()))
    }

    func testSaveRequestAnnouncesV2Caps() {
        let blob = Data("png".utf8)
        let p = AuthClient.payload(drawing: layeredDrawing(), renders: (blob, blob, blob),
                                   title: "Dawn Bloom", visibility: "public", size: 1024, remixOf: nil)
        let req = client.saveRequest(p, token: "t", csrf: "c")
        // Omitting this header makes the Worker treat us as a legacy client and
        // silently accept an empty title as "Untitled" — nothing observable
        // fails, the designed title-error state just never appears.
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-Client-Caps"), "v2")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer t")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-CSRF-Token"), "c")
        XCTAssertEqual(req.httpMethod, "POST")
    }

    // MARK: 3 — the save payload is built from the v2 drawing

    private func layeredDrawing() -> DrawingV2 {
        let pts = [StrokePoint(x: -50, y: 0, pressure: 0.4), StrokePoint(x: 50, y: 20, pressure: 0.9)]
        let stroke = Stroke(tool: .solid, color: "#1f6f6b", size: 8, opacity: 0.8, po: true, sm: true, pts: pts)
        return DrawingV2(bg: .light, layers: [
            Layer(id: "l1", name: "One", visible: true, opacity: 1, sym: Symmetry(segments: 6, mirror: false), strokes: [stroke]),
            Layer(id: "l2", name: "Two", visible: true, opacity: 0.5, sym: Symmetry(segments: 12, mirror: true), strokes: [stroke]),
            Layer(id: "l3", name: "Three", visible: true, opacity: 0.25, sym: Symmetry(segments: 6, mirror: false), strokes: [stroke]),
        ])
    }

    func testPayloadPreservesLayersOpacityAndSmoothing() throws {
        let blob = Data("png".utf8)
        let p = AuthClient.payload(
            drawing: layeredDrawing(),
            renders: (image: blob, thumb: blob, og: blob),
            title: "  Dawn Bloom  ",
            visibility: "public",
            size: 1024,
            remixOf: nil
        )

        // Re-parse what would actually be uploaded. Asserting on the payload's
        // Swift value would pass on the v1 bug too, since the flatten happens
        // during serialization — the bytes are the only witness.
        let back = try deserializeV2(p.drawing)
        XCTAssertEqual(back.layers.count, 3, "layers were flattened away")
        XCTAssertEqual(Set(back.layers.map(\.sym.segments)), [6, 12], "per-layer symmetry was collapsed")
        XCTAssertEqual(back.layers.map(\.opacity), [1, 0.5, 0.25], "per-layer opacity was dropped")
        XCTAssertTrue(back.layers[0].strokes[0].sm, "stroke smoothing was stripped")
        XCTAssertTrue(back.layers[0].strokes[0].po, "pressure-opacity was stripped")
        XCTAssertEqual(p.title, "Dawn Bloom")
    }

    func testTheV1ProjectionOfThatDrawingWouldLoseAllOfIt() {
        // The control for the assertions above: `flattenToV1` cannot represent
        // this drawing at all, which is precisely what "iOS saves are lossy"
        // meant. If this ever returns non-nil the test above needs a stronger
        // discriminator than "3 layers".
        XCTAssertNil(flattenToV1(layeredDrawing()))
    }

    func testHashIsComputedOverTheSameBytesThatAreUploaded() throws {
        // The pre-flight only means anything if it hashes what the POST sends;
        // the Worker hashes the uploaded `drawing` field.
        let blob = Data("png".utf8)
        let d = layeredDrawing()
        let p = AuthClient.payload(drawing: d, renders: (blob, blob, blob),
                                   title: "x", visibility: "public", size: 1024, remixOf: nil)
        XCTAssertEqual(try contentHash(p.drawing), try contentHash(serialize(d)))
    }

    func testLayerNamesSurviveARoundTripUnchanged() throws {
        // T10's precondition: `serialize` emits `layer.name` VERBATIM and only
        // `deserializeV2` normalizes, so a name committed from raw user text
        // serializes decomposed and re-parses as NFC — different bytes, and
        // therefore a different content hash from the same picture. Committing
        // through `normalizeLayerName` is what keeps this stable.
        let decomposed = "Cafe\u{0301} bloom"                  // e + combining acute
        let normalized = try XCTUnwrap(normalizeLayerName(decomposed))
        XCTAssertEqual(normalized, "Café bloom")               // NFC
        XCTAssertNotEqual(Array(normalized.utf8), Array(decomposed.utf8))

        let stroke = Stroke(tool: .solid, color: "#000000", size: 4, opacity: 1, po: false, sm: false,
                            pts: [StrokePoint(x: 0, y: 0, pressure: 0.5)])
        let d = DrawingV2(bg: .light, layers: [
            Layer(id: "l1", name: normalized, visible: true, opacity: 1,
                  sym: Symmetry(segments: 6, mirror: false), strokes: [stroke]),
        ])
        XCTAssertEqual(try deserializeV2(serialize(d)).layers[0].name, normalized)
    }
}

/// Regressions around the richer `AuthError`. Both of these are silent: they
/// change nothing visible until a specific server response arrives.
final class AuthErrorWiringTests: XCTestCase {
    @MainActor
    func testOnlyA401SignsTheUserOut() {
        XCTAssertTrue(AuthModel.shouldSignOut(on: AuthError.api(status: 401, body: nil)))
        // The controls: none of these may drop a working session.
        XCTAssertFalse(AuthModel.shouldSignOut(on: AuthError.network))
        XCTAssertFalse(AuthModel.shouldSignOut(on: AuthError.decoding))
        XCTAssertFalse(AuthModel.shouldSignOut(on: AuthError.api(status: 500, body: nil)))
        XCTAssertFalse(AuthModel.shouldSignOut(on: AuthError.api(status: 429, body: nil)))
        XCTAssertFalse(AuthModel.shouldSignOut(on: URLError(.timedOut)))
    }

    func testExpiredTokenIsStillRecognisedAs401() {
        // `AuthModel.validate()` used to catch `AuthError.badResponse(401)` by
        // PATTERN. Replacing that case would have made the pattern stop matching
        // silently, dropping into the tolerant `catch` that keeps the session —
        // so an expired token would never sign the user out. The model now
        // matches on `status`, and this is the fact it depends on.
        XCTAssertEqual(AuthError.api(status: 401, body: nil).status, 401)
        XCTAssertNil(AuthError.network.status)
        XCTAssertNil(AuthError.decoding.status)
    }

    func testSaveResponseDecodesACappedSave() throws {
        // The Worker returns 201 with the piece STORED but unlisted when the
        // public wall is full. Decoding only `{id, url}` reports that as an
        // ordinary success and opens a piece the user believes is public.
        let json = #"{"id":"a1","url":"https://x/p/a1","visibility":"unlisted","capReached":true,"cap":10,"count":10}"#
        let r = try JSONDecoder().decode(SaveResponse.self, from: Data(json.utf8))
        XCTAssertEqual(r.capReached, true)
        XCTAssertEqual(r.cap, 10)
        XCTAssertEqual(r.visibility, "unlisted")

        // And an ordinary 201, which carries none of those keys, still decodes.
        let plain = try JSONDecoder().decode(SaveResponse.self, from: Data(
            #"{"id":"a2","url":"https://x/p/a2","visibility":"public"}"#.utf8))
        XCTAssertNil(plain.capReached)
    }

    func testCapReachedNeedsAllThreeConditions() {
        func plus(enabled: Bool, count: Int, cap: Int?) -> PlusState {
            PlusState(active: false, sources: [], publicCount: count, publicCap: cap, layerCap: 3, enabled: enabled)
        }
        XCTAssertTrue(plus(enabled: true, count: 10, cap: 10).capReached)
        XCTAssertTrue(plus(enabled: true, count: 11, cap: 10).capReached)
        XCTAssertFalse(plus(enabled: true, count: 9, cap: 10).capReached)
        // The degraded `/api/me` (a malformed CAP_EPOCH) answers exactly this.
        // Coalescing a nil cap to 0 would put EVERY user at the cap during a
        // config typo — the opposite of what the degrade is for.
        XCTAssertFalse(plus(enabled: false, count: 0, cap: nil).capReached)
        XCTAssertFalse(plus(enabled: true, count: 0, cap: nil).capReached)
    }

    func testLayeredCopyNeverPrintsZeroFold() {
        // `segments == 0` is the contract signal that the visible layers
        // disagree. It is not zero-fold, and the server already says so.
        XCTAssertEqual(ArtworkMeta.summary(segments: 0, mirror: false, layers: 3), "Layered · 3 layers")
        XCTAssertEqual(ArtworkMeta.summary(segments: 12, mirror: true, layers: 1), "12-fold · mirrored")
        XCTAssertEqual(ArtworkMeta.summary(segments: 6, mirror: false, layers: nil), "6-fold · rotational")
        XCTAssertEqual(ArtworkMeta.headline(author: "Anmol", segments: 0, mirror: false, layers: 3),
                       "A layered kaleidoscope drawing by Anmol · 3 layers")
        XCTAssertFalse(ArtworkMeta.summary(segments: 0, mirror: false, layers: 3).contains("0-fold"))
        // A single-layer piece keeps the fold copy and shows no layer chip.
        XCTAssertNil(ArtworkMeta.layerChip(1))
        XCTAssertNil(ArtworkMeta.layerChip(nil))
        XCTAssertEqual(ArtworkMeta.layerChip(3), "3 layers")
    }

    func testArtworkDetailDecodesLayersAndHash() throws {
        let json = #"""
        {"id":"a","title":"t","visibility":"public","author":{"name":"p","avatar":null},
         "isOwner":false,"segments":0,"mirror":false,"width":1024,"height":1024,
         "palette":["#e84a27"],"remixOf":null,"likes":2,"createdAt":1,"altText":null,
         "layers":3,"contentHash":"deadbeef",
         "urls":{"image":"/i","thumb":"/t","vector":"/v"}}
        """#
        let d = try JSONDecoder().decode(ArtworkDetail.self, from: Data(json.utf8))
        XCTAssertEqual(d.layers, 3)
        XCTAssertEqual(d.contentHash, "deadbeef")

        // A legacy row carries neither; treating a missing hash as "no
        // duplicate" is the mistake the optionality exists to prevent.
        let legacy = #"""
        {"id":"a","title":"t","visibility":"public","author":{"name":null,"avatar":null},
         "isOwner":false,"segments":12,"mirror":true,"width":1024,"height":1024,
         "palette":[],"remixOf":null,"likes":0,"createdAt":1,"altText":null,
         "urls":{"image":"/i","thumb":"/t","vector":"/v"}}
        """#
        let old = try JSONDecoder().decode(ArtworkDetail.self, from: Data(legacy.utf8))
        XCTAssertNil(old.layers)
        XCTAssertNil(old.contentHash)
    }

    func testHashLookupDecodesBothShapes() throws {
        let mine = try JSONDecoder().decode(HashLookup.self, from: Data(#"{"mine":"a1","other":null}"#.utf8))
        XCTAssertEqual(mine.mine, "a1")
        XCTAssertNil(mine.other)
        let other = try JSONDecoder().decode(HashLookup.self, from: Data(
            #"{"mine":null,"other":{"id":"b2","title":"Dawn Bloom","author":"Priya"}}"#.utf8))
        XCTAssertEqual(other.other?.title, "Dawn Bloom")
        XCTAssertEqual(other.other?.author, "Priya")
    }
}
