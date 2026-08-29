import XCTest
import StoreKit
import StoreKitTest
@testable import Kaleidoscope

/// StoreKit, driven for real against the committed `Kaleidoscope.storekit`.
///
/// Everything here needs a purchase to have actually happened, which is what
/// `SKTestSession` gives us without an Apple ID. The point is not that the code
/// runs — it is that each assertion would come out DIFFERENTLY if the mechanism
/// under it were removed:
///
///   - the posted body is decoded back out and its JWS payload parsed, so
///     sending the unwrapped `Transaction` instead cannot pass;
///   - `appAccountToken` is read out of the signed payload, so dropping the
///     purchase option cannot pass;
///   - the entitlement direction is tested BOTH ways with a live control on
///     `Transaction.currentEntitlements`, so gating the UI on StoreKit instead
///     of `/api/me` cannot pass.
///
/// ⚠️ `SKTestSession` fails with `SKInternalErrorDomain Code=3` when more than
/// one simulator matching the destination NAME is booted, and `xcodebuild` can
/// still exit 0. Run with an explicit `-destination "id=<UDID>"` and read the
/// `Executed N tests` line, not the exit code.
@MainActor
final class PlusStoreKitTests: XCTestCase {
    private var session: SKTestSession!

    override func setUpWithError() throws {
        try super.setUpWithError()

        // Control, and it is load-bearing: `SKTestSession(configurationFileNamed:)`
        // is the natural spelling, but "it did not throw" is NOT evidence that the
        // configuration loaded — so this proves the initializer throws on a name
        // that cannot resolve, and then the session is built from an explicit URL
        // out of THIS bundle. A session constructed over nothing reports every
        // operation as `SKInternalErrorDomain Code=3` and hands back zero
        // products, which reads as a broken simulator rather than a missing file.
        XCTAssertThrowsError(try SKTestSession(configurationFileNamed: "NoSuchConfiguration"),
                             "the initializer does not throw on a bad name — this control proves nothing")
        let url = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "Kaleidoscope", withExtension: "storekit"),
            "Kaleidoscope.storekit is not in the test bundle (project.yml resource entry)")

        // 🔴 The shipped configuration really does declare the product — checked
        // against the FILE, not against StoreKit. This is what makes the skip
        // below safe: with the file proven correct, "StoreKit handed back
        // nothing" can only be the runtime, never a product that was renamed,
        // removed, or misspelled. Those come out as these two failures instead.
        let config = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let declared = ((config?["products"] as? [[String: Any]]) ?? [])
            .compactMap { $0["productID"] as? String }
        XCTAssertEqual(declared, ["dev.ponderance.kaleidoscope.plus"],
                       "Kaleidoscope.storekit does not declare exactly the shipping product")
        XCTAssertEqual(PlusStore.productID, "dev.ponderance.kaleidoscope.plus")

        session = try SKTestSession(contentsOf: url)
        session.resetToDefaultState()
        session.clearTransactions()
        session.disableDialogs = true
        session.askToBuyEnabled = false

        try skipIfStoreKitTestingIsInoperative()
    }

    /// ⚠️ **StoreKit Testing is inoperative on the iOS 26.5 simulator runtime**
    /// (Xcode 26.6, Apple silicon). Every `SKTestSession` call fails
    /// `SKInternalErrorDomain Code=3`, `Product.products(for:)` returns an empty
    /// array, and `SKTestSession.allTransactions()` / `AppStore.sync()` do not
    /// return at all — a suite that pushed on past this point HUNG rather than
    /// failed, which is why the check is here and not in the test bodies.
    ///
    /// Established, not assumed. The SAME binary and the SAME `.storekit` file
    /// pass on an iOS 18.3 runtime (70/70, no skips), and each of these was ruled
    /// out first, on two different iOS 26.5 simulators including a freshly
    /// created one:
    ///   - the file not being in the test bundle — `Bundle.url` resolves it, and
    ///     the initializer is proven above to throw on a name that does not;
    ///   - the scheme's StoreKit configuration — identical failure with the
    ///     reference on the Run action, on the Test action, and absent entirely;
    ///   - more than one booted simulator of the destination name (the documented
    ///     Code=3 hazard) — identical failure with exactly one booted.
    ///
    /// The skip is gated on the product list being EMPTY, with the file already
    /// asserted to declare that product. A mutation to `PlusStore` cannot reach
    /// it: nothing here calls `loadProduct`, and a wrong `PlusStore.productID`
    /// fails the equality assertion in `setUp` before this runs.
    private func skipIfStoreKitTestingIsInoperative() throws {
        guard try awaitProducts().isEmpty else { return }
        throw XCTSkip("""
            StoreKit Testing is inoperative on this simulator runtime \
            (\(ProcessInfo.processInfo.operatingSystemVersionString)): the .storekit file declares \
            dev.ponderance.kaleidoscope.plus and SKTestSession loaded it, yet Product.products \
            returned nothing and every SKTestSession call logs SKInternalErrorDomain Code=3. \
            The same binary passes 70/70 on an iOS 18.3 runtime, so this is the RUNTIME, not the \
            code — run this bundle against an iOS 18.x destination to exercise it.
            """)
    }

    /// `Product.products` from a synchronous `setUp`.
    private func awaitProducts() throws -> [Product] {
        var out: [Product] = []
        let done = expectation(description: "products")
        Task {
            out = (try? await Product.products(for: [PlusStore.productID])) ?? []
            done.fulfill()
        }
        wait(for: [done], timeout: 30)
        return out
    }

    override func tearDown() {
        session = nil
        super.tearDown()
    }

    // MARK: the product, and where the price comes from

    func testTheProductIsTheNonConsumableWeShipAndCarriesItsOwnPrice() async throws {
        let store = PlusStore()
        await store.loadProduct()
        let product = try XCTUnwrap(store.product, "no product — is Kaleidoscope.storekit in the test bundle?")

        XCTAssertEqual(product.id, PlusStore.productID)
        XCTAssertEqual(product.id, "dev.ponderance.kaleidoscope.plus")
        XCTAssertEqual(product.type, .nonConsumable)
        // Family Sharing OFF (PLAN §1): a shared non-consumable would grant Plus
        // to five accounts the server never issued an entitlement to.
        XCTAssertFalse(product.isFamilyShareable)
        XCTAssertFalse(store.loadFailed)

        // 🔴 The price on the button is this string and nothing else.
        XCTAssertFalse(product.displayPrice.isEmpty)
        XCTAssertEqual(PlusCopy.unlockLabel(product.displayPrice), "Unlock for \(product.displayPrice)")
        XCTAssertTrue(PlusCopy.priceFootnote(product.displayPrice).contains(product.displayPrice))
    }

    // MARK: 🔴 what actually goes on the wire

    func testTheReportPostsTheSignedRepresentation() async throws {
        let userId = UUID().uuidString.lowercased() // server ids are lowercase UUIDs
        let result = try await buy(appAccountToken: XCTUnwrap(UUID(uuidString: userId)))

        let req = try BillingClient().appleRequest(
            for: result,
            session: BillingSession(userId: userId, token: "tok", csrf: "csrf"))

        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/billing/apple")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(req.value(forHTTPHeaderField: "X-CSRF-Token"), "csrf")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let body = try XCTUnwrap(req.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        // The Worker reads `body.jws` and nothing else; anything else in here is
        // ignored, so "we posted something" is not the assertion.
        XCTAssertEqual(Array(json.keys), ["jws"])
        let jws = try XCTUnwrap(json["jws"] as? String)

        // 🔴 The mutation this kills: unwrap the `Transaction` first and encode
        // THAT as JSON. `jwsRepresentation` is on `VerificationResult`, not on
        // `Transaction`, so the natural "fix" posts an unsigned object — which
        // is not three dot-separated base64url segments and has no header.
        let parts = jws.split(separator: ".")
        XCTAssertEqual(parts.count, 3, "not a JWS: \(jws.prefix(120))")

        // The header must carry the x5c chain, because the chain is the ONLY
        // thing the Worker authenticates with. Without it there is nothing for
        // `verifyAppleJws` to walk to Apple's root and every purchase is a 401.
        let header = try XCTUnwrap(decodeSegment(parts[0]))
        XCTAssertNotNil(header["alg"] as? String)
        let x5c = try XCTUnwrap(header["x5c"] as? [String], "no x5c chain in the JWS header")
        XCTAssertGreaterThanOrEqual(x5c.count, 1)
    }

    func testTheSignedPayloadCarriesEverythingTheWorkerDecidesOn() async throws {
        let userId = UUID().uuidString.lowercased()
        let result = try await buy(appAccountToken: XCTUnwrap(UUID(uuidString: userId)))
        let payload = try postedPayload(for: result, userId: userId)

        // Every field `checkTransaction` reads. A missing one is not a rejection
        // the user can act on — it is the server unable to decide at all.
        XCTAssertEqual(payload["bundleId"] as? String, "dev.ponderance.kaleidoscope")
        XCTAssertEqual(payload["productId"] as? String, PlusStore.productID)
        XCTAssertEqual(payload["inAppOwnershipType"] as? String, "PURCHASED")
        XCTAssertNotNil(payload["originalTransactionId"] as? String)
        XCTAssertNil(payload["revocationDate"], "a fresh purchase must not be revoked")

        // 🔴 `appAccountToken`, compared CASE-INSENSITIVELY on purpose.
        //
        // Swift's `UUID.uuidString` is UPPERCASE; a server id from
        // `crypto.randomUUID()` is lowercase. T02d found this by review and
        // widened the server compare — every real purchase would otherwise have
        // been rejected `wrong_account`. Asserting exact equality here would go
        // red and tempt the next reader to "fix" the client by re-casing, which
        // puts the bug straight back.
        let token = try XCTUnwrap(payload["appAccountToken"] as? String,
                                  "no appAccountToken — the purchase option was dropped")
        XCTAssertEqual(token.lowercased(), userId.lowercased())
        XCTAssertNotEqual(token.lowercased(), UUID().uuidString.lowercased(), "control")
    }

    /// 🔴 The one check that stands between a TestFlight build and free Plus.
    ///
    /// The Worker requires `environment === "Production"` unless the caller is an
    /// admin or `PLUS_ALLOW_SANDBOX=true`, and T02d proved that half with seven
    /// mutations. The client's half is that the field is present and TRUTHFUL, so
    /// the server has something to decide on: here the transaction is a local
    /// StoreKit-test one and the payload says so, in the same field a real
    /// Sandbox transaction would say `Sandbox` and a real purchase `Production`.
    func testTheEnvironmentTheWorkerGatesOnIsPresentAndNotProduction() async throws {
        let userId = UUID().uuidString.lowercased()
        let result = try await buy(appAccountToken: XCTUnwrap(UUID(uuidString: userId)))
        let payload = try postedPayload(for: result, userId: userId)

        let environment = try XCTUnwrap(payload["environment"] as? String,
                                        "no environment field — the sandbox gate is undecidable")
        // Not `Production`, because nothing bought on this machine ever is. If
        // this ever reads "Production" from a test session, the field has stopped
        // meaning what the Worker thinks it means and the gate is open.
        XCTAssertNotEqual(environment, "Production", "a locally-bought transaction claimed Production")
        XCTAssertEqual(environment, "Xcode", "StoreKit Testing changed its environment string")
    }

    // MARK: 🔴 entitlement UI comes from /api/me — tested in both directions

    func testAServerEntitlementUnlocksTheUIWithNoStoreKitEntitlementAtAll() async throws {
        // The control that makes this non-vacuous: StoreKit really has nothing.
        // This is a cold launch, and it is also every user who bought Plus on the
        // other platform — for them StoreKit will NEVER have anything.
        let owned = await ourEntitlementCount()
        XCTAssertEqual(owned, 0, "control failed: this session already holds a purchase")

        let store = PlusStore()
        let input = store.sheetInput(plus: plusState(active: true), signedIn: true)
        XCTAssertTrue(input.owned)
        XCTAssertEqual(resolvePlusSheet(input), .purchased)
    }

    func testAStoreKitEntitlementDoesNotByItselfUnlockTheUI() async throws {
        _ = try await buy(appAccountToken: UUID())
        // Control: StoreKit DOES hold the entitlement at this moment…
        let owned = await ourEntitlementCount()
        XCTAssertEqual(owned, 1, "control failed: the purchase did not register with StoreKit")

        // …and `/api/me` says no, because the server was never told (or refused).
        // 🔴 This is the mutation kill: point `sheetInput` at
        // `Transaction.currentEntitlements` and this goes `.purchased`.
        let store = PlusStore()
        await store.loadProduct()
        let input = store.sheetInput(plus: plusState(active: false), signedIn: true)
        XCTAssertFalse(input.owned)
        XCTAssertEqual(resolvePlusSheet(input), .before)
    }

    // MARK: purchase preconditions — nothing is ever bought without an account

    func testPurchaseWithoutASessionAsksForSignInAndBuysNothing() async throws {
        let store = PlusStore()
        store.start(.none) // `.none` has no session
        await store.purchase()

        XCTAssertEqual(store.outcome, .signIn)
        // The assertion that matters: not "we showed a message" but "no money
        // moved". A purchase with no `appAccountToken` is one the server must
        // refuse, which is the paid-and-not-granted direction.
        let owned = await ourEntitlementCount()
        XCTAssertEqual(owned, 0, "a purchase went through with no session")
    }

    func testAnAccountIdThatIsNotAUUIDRefusesToPurchase() async throws {
        let store = PlusStore()
        store.start(BillingEnvironment(
            session: { BillingSession(userId: "not-a-uuid", token: "t", csrf: "c") },
            refreshEntitlement: {},
            owned: { false }))
        await store.purchase()

        XCTAssertEqual(store.outcome, .error(PlusCopy.accountUnusable))
        let owned = await ourEntitlementCount()
        XCTAssertEqual(owned, 0, "bought without a token the server could bind")
    }

    func testTheTransactionListenerIsStartedExactlyOnce() {
        // `start` is called from a `.task`, and a `.task` re-runs on appearance.
        // Two listeners means two `finish()` calls racing on one transaction.
        let store = PlusStore()
        store.start(.none)
        store.start(.none)
        store.start(.none)
        XCTAssertEqual(store.listenersStarted, 1)
    }

    // MARK: 🔴 purchase → report → what happens to the transaction

    func testAGrantedPurchaseFinishesTheTransactionAndSaysSoOnce() async throws {
        var refreshes = 0
        let store = PlusStore(client: stubbedClient(status: 200, body: #"{"ok":true,"plus":true}"#))
        store.start(BillingEnvironment(
            session: { BillingSession(userId: UUID().uuidString.lowercased(), token: "t", csrf: "c") },
            refreshEntitlement: { refreshes += 1 },
            owned: { true }))
        await store.loadProduct()

        await store.purchase()

        XCTAssertEqual(store.outcome, .purchased)
        XCTAssertFalse(store.busy)
        // `/api/me` is re-read, or the layer cap stays at 3 for someone who just
        // paid for eight.
        XCTAssertEqual(refreshes, 1)
        let unfinished = await ourUnfinishedCount()
        XCTAssertEqual(unfinished, 0, "a granted transaction was left unfinished")
    }

    func testAPurchaseTheServerCannotRECORDIsLeftUNFINISHEDSoItRetries() async throws {
        // 🔴 The paid-but-not-granted direction, and the reason `mayFinish`
        // exists. Apple has the money; our Worker answered 500. Finishing here
        // would take the transaction off `Transaction.updates` forever and the
        // only recovery left would be the user finding "Restore" by hand.
        let store = PlusStore(client: stubbedClient(status: 500, body: #"{"error":"boom"}"#))
        store.start(BillingEnvironment(
            session: { BillingSession(userId: UUID().uuidString.lowercased(), token: "t", csrf: "c") },
            refreshEntitlement: {},
            owned: { false }))
        await store.loadProduct()

        await store.purchase()

        XCTAssertEqual(store.outcome, .error(PlusCopy.grantPending))
        let unfinished = await ourUnfinishedCount()
        XCTAssertEqual(unfinished, 1, "the transaction was finished despite a retryable failure")
    }

    func testAPurchaseBoundToAnotherAccountGetsItsOwnStateAndIsFinished() async throws {
        let store = PlusStore(client: stubbedClient(status: 409, body: #"{"error":"bound_elsewhere"}"#))
        store.start(BillingEnvironment(
            session: { BillingSession(userId: UUID().uuidString.lowercased(), token: "t", csrf: "c") },
            refreshEntitlement: {},
            owned: { false }))
        await store.loadProduct()

        await store.purchase()

        // Its own state, with "Switch account" on it — not the generic error,
        // which would tell this user to keep retrying an account that can never
        // work.
        XCTAssertEqual(store.outcome, .boundElsewhere)
        XCTAssertEqual(resolvePlusSheet(store.sheetInput(plus: plusState(active: false), signedIn: true)),
                       .boundElsewhere)
        let unfinished = await ourUnfinishedCount()
        XCTAssertEqual(unfinished, 0, "a permanently refused transaction was left to re-deliver forever")
    }

    // MARK: restore

    func testRestoreReportsWhatStoreKitHoldsAndThenBelievesTheServer() async throws {
        // A purchase StoreKit knows about and the server does not — the shape a
        // report that failed last launch leaves behind.
        _ = try await buy(appAccountToken: UUID())
        let held = await ourEntitlementCount()
        XCTAssertEqual(held, 1, "control")

        var refreshes = 0
        var serverSaysOwned = false
        let store = PlusStore(client: stubbedClient(status: 200, body: #"{"ok":true,"plus":true}"#))
        store.start(BillingEnvironment(
            session: { BillingSession(userId: UUID().uuidString.lowercased(), token: "t", csrf: "c") },
            refreshEntitlement: { refreshes += 1; serverSaysOwned = true },
            owned: { serverSaysOwned }))

        await store.restore()

        XCTAssertEqual(store.outcome, .purchased)
        XCTAssertGreaterThanOrEqual(refreshes, 1, "restore never re-read /api/me")
    }

    func testRestoreWithNothingAnywhereSaysSoRatherThanClaimingSuccess() async throws {
        let held = await ourEntitlementCount()
        XCTAssertEqual(held, 0, "control")

        let store = PlusStore(client: stubbedClient(status: 200, body: #"{"ok":true}"#))
        store.start(BillingEnvironment(
            session: { BillingSession(userId: UUID().uuidString.lowercased(), token: "t", csrf: "c") },
            refreshEntitlement: {},
            owned: { false }))

        await store.restore()

        XCTAssertEqual(store.outcome, .restoreNone)
    }

    func testRestoreWithoutASessionAsksForSignIn() async throws {
        let store = PlusStore()
        store.start(.none)
        await store.restore()
        XCTAssertEqual(store.outcome, .signIn)
    }

    // MARK: helpers

    /// Buy the product the way the app does — through `Product.purchase` with an
    /// `appAccountToken`, not `SKTestSession.buyProduct`, which cannot set one.
    private func buy(appAccountToken: UUID) async throws -> VerificationResult<Transaction> {
        let products = try await Product.products(for: [PlusStore.productID])
        let product = try XCTUnwrap(products.first, "no product in the test configuration")
        let result = try await product.purchase(options: [.appAccountToken(appAccountToken)])
        guard case .success(let verification) = result else {
            XCTFail("purchase did not succeed: \(result)")
            throw CocoaError(.featureUnsupported)
        }
        return verification
    }

    /// The decoded payload of the JWS the app would actually POST — i.e. read
    /// back out of `URLRequest.httpBody`, not off the `Transaction`.
    private func postedPayload(for result: VerificationResult<Transaction>, userId: String) throws -> [String: Any] {
        let req = try BillingClient().appleRequest(
            for: result, session: BillingSession(userId: userId, token: "t", csrf: "c"))
        let body = try XCTUnwrap(req.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let jws = try XCTUnwrap(json["jws"] as? String)
        let parts = jws.split(separator: ".")
        // XCTFail, never XCTSkip: a skip is what a mutation would want, and a
        // skipped test reports green.
        guard parts.count == 3 else {
            XCTFail("posted body is not a JWS: \(jws.prefix(120))")
            throw CocoaError(.featureUnsupported)
        }
        return try XCTUnwrap(decodeSegment(parts[1]))
    }

    private func decodeSegment(_ segment: Substring) -> [String: Any]? {
        var s = String(segment).replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let data = Data(base64Encoded: s) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private func ourEntitlementCount() async -> Int {
        var n = 0
        for await result in Transaction.currentEntitlements where productID(of: result) == PlusStore.productID {
            _ = result
            n += 1
        }
        return n
    }

    private func ourUnfinishedCount() async -> Int {
        var n = 0
        for await result in Transaction.unfinished where productID(of: result) == PlusStore.productID {
            _ = result
            n += 1
        }
        return n
    }

    private nonisolated func productID(of result: VerificationResult<Transaction>) -> String {
        switch result {
        case .verified(let t): return t.productID
        case .unverified(let t, _): return t.productID
        }
    }

    private func plusState(active: Bool) -> PlusState {
        PlusState(active: active, sources: active ? ["apple"] : [],
                  publicCount: 3, publicCap: 10, layerCap: active ? 8 : 3, enabled: true)
    }

    /// A `BillingClient` whose `URLSession` answers from a stub, so the whole
    /// purchase → report → finish path runs with a real StoreKit transaction and
    /// a chosen server answer.
    private func stubbedClient(status: Int, body: String) -> BillingClient {
        BillingStubProtocol.status = status
        BillingStubProtocol.body = Data(body.utf8)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [BillingStubProtocol.self]
        var auth = AuthClient()
        auth.session = URLSession(configuration: config)
        return BillingClient(auth: auth)
    }
}

/// Answers every request with a canned status + body.
final class BillingStubProtocol: URLProtocol {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var body = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
