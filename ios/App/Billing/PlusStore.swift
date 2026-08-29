import Foundation
import StoreKit

/// Everything `PlusStore` needs from the rest of the app, as closures.
///
/// The store never sees `AuthModel`. That keeps the StoreKit code drivable from
/// a unit test — which matters, because the only way to exercise a purchase
/// without a real Apple ID is `SKTestSession`, and a test that also had to build
/// a signed-in `AuthModel` could not run at all.
@MainActor
struct BillingEnvironment {
    /// The current session, or nil when signed out.
    var session: () -> BillingSession?
    /// Re-read `/api/me` so the entitlement the server just recorded is visible.
    var refreshEntitlement: () async -> Void
    /// `plus.active` from the last `/api/me`. The ONLY entitlement source.
    var owned: () -> Bool

    static let none = BillingEnvironment(session: { nil }, refreshEntitlement: {}, owned: { false })
}

/// The StoreKit half of Kaleidoscope Plus: the product, the purchase, the
/// restore, and the `Transaction.updates` listener.
///
/// 🔴 It holds no entitlement state and exposes none. `Transaction.currentEntitlements`
/// is read in exactly one place (`restore`, to decide what to REPORT) and never
/// to decide what to SHOW. What the user is entitled to comes from `/api/me`; see
/// `PlusSheetInput.owned(from:)`.
@MainActor
final class PlusStore: ObservableObject {
    static let productID = "dev.ponderance.kaleidoscope.plus"

    /// The StoreKit product. `displayPrice` is the only place a price ever comes
    /// from — App Review 3.1.1 forbids naming the web one, and a literal here
    /// would fail `test/unit/plus-state.test.ts`.
    @Published private(set) var product: Product?
    /// The product load finished and came back with nothing.
    @Published private(set) var loadFailed = false
    @Published private(set) var busy = false
    @Published private(set) var outcome: PlusOutcome?

    /// How many `Transaction.updates` listeners this store has ever created.
    ///
    /// Exposed because "one, forever" is the property that matters and is
    /// otherwise unobservable. `start` is called from a `.task`, and a `.task`
    /// is tied to APPEARANCE, not identity — it re-runs whenever the view comes
    /// back. Two listeners means two `finish()` calls racing on one transaction.
    private(set) var listenersStarted = 0

    private var env: BillingEnvironment = .none
    private var updates: Task<Void, Never>?
    private let client: BillingClient

    /// The client is injectable for one reason: `AuthClient.session` is a plain
    /// `URLSession`, so a test can hand it a `URLProtocol`-stubbed one and drive
    /// a REAL StoreKit purchase (via `SKTestSession`) all the way through
    /// reporting, including the branch where the server refuses and the
    /// transaction must be left unfinished.
    init(client: BillingClient = BillingClient()) {
        self.client = client
    }

    // MARK: launch

    /// Start the `Transaction.updates` listener. Idempotent — safe to call from
    /// a `.task` that re-runs.
    ///
    /// The listener is what catches a purchase that finished outside the app
    /// (Ask to Buy approved later, a purchase made on another device, a report
    /// that failed last launch and was deliberately left unfinished). It runs
    /// regardless of `plus.enabled`: the flag hides the paywall, but a purchase
    /// that already happened must still be recorded.
    func start(_ environment: BillingEnvironment) {
        env = environment
        guard updates == nil else { return }
        listenersStarted += 1
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                await self.deliver(result)
            }
        }
    }

    /// Fetch the product so the button can show a price. Idempotent.
    func loadProduct() async {
        guard product == nil else { return }
        do {
            let found = try await Product.products(for: [Self.productID])
            product = found.first { $0.id == Self.productID }
            loadFailed = product == nil
        } catch {
            loadFailed = true
        }
    }

    // MARK: the sheet's inputs

    /// Everything `resolvePlusSheet` needs, assembled in one place.
    ///
    /// 🔴 `owned` comes from `PlusSheetInput.owned(from:)` — that is, from
    /// `/api/me`. This function has a live StoreKit connection in scope and
    /// still does not ask it, which is the whole design: a user who bought Plus
    /// on the other platform has no StoreKit entitlement at all, and a user on a
    /// cold launch has none yet.
    func sheetInput(plus: PlusState?, signedIn: Bool) -> PlusSheetInput {
        PlusSheetInput(
            signedIn: signedIn,
            owned: PlusSheetInput.owned(from: plus),
            busy: busy,
            outcome: outcome,
            loadFailed: loadFailed
        )
    }

    /// Drop the last result so the sheet goes back to the pitch.
    func clearOutcome() { outcome = nil }

    // MARK: purchase

    func purchase() async {
        guard !busy else { return }
        guard let session = env.session() else {
            outcome = .signIn
            return
        }
        // 🔴 `appAccountToken` is what binds the receipt to the account, and the
        // Worker rejects a transaction whose token is not this user's id. It is a
        // UUID; server ids are `crypto.randomUUID()`, so this always parses — but
        // if it ever did not, buying anyway means Apple takes the money and the
        // grant is refused `wrong_account`. Refuse the purchase instead.
        //
        // Set from the id VERBATIM. `UUID.uuidString` is uppercase and server ids
        // are lowercase; the Worker compares case-insensitively for exactly that
        // reason. Do not "helpfully" re-case either side.
        guard let accountToken = UUID(uuidString: session.userId) else {
            outcome = .error(PlusCopy.accountUnusable)
            return
        }
        await loadProduct()
        guard let product else {
            outcome = .error(PlusCopy.unavailable)
            return
        }

        outcome = nil
        busy = true
        defer { busy = false }

        do {
            let result = try await product.purchase(options: [.appAccountToken(accountToken)])
            switch result {
            case .success(let verification):
                await report(verification, session: session, finalise: true)
            case .userCancelled:
                // Not an error, and not a state — put the sheet back where it was.
                outcome = nil
            case .pending:
                outcome = .error(PlusCopy.pending)
            @unknown default:
                outcome = .error(PlusCopy.purchaseFailed)
            }
        } catch {
            outcome = .error(PlusCopy.purchaseFailed)
        }
    }

    // MARK: restore

    /// Restore. Reachable from the paywall footnote AND from the You tab.
    ///
    /// Three things have to happen, in this order, and none of them alone is a
    /// restore:
    ///   1. `AppStore.sync()` — pull this Apple ID's purchases onto the device.
    ///   2. re-report every current entitlement, so a purchase the server never
    ///      recorded (a report that failed, a fresh device) gets recorded now.
    ///   3. re-read `/api/me` — which is also the ONLY way a purchase made on
    ///      the other platform can turn up, since StoreKit has never heard of it.
    func restore() async {
        guard !busy else { return }
        guard let session = env.session() else {
            outcome = .signIn
            return
        }
        outcome = nil
        busy = true
        defer { busy = false }

        // Throws when the user dismisses the Apple ID prompt, and that must not
        // abandon the restore: a purchase made on this device is already in
        // `currentEntitlements`, and a purchase made elsewhere is only visible
        // through `/api/me`. Neither needs the sync to have succeeded.
        try? await AppStore.sync()

        var rejection: PlusOutcome?
        for await result in Transaction.currentEntitlements {
            guard transaction(in: result).productID == Self.productID else { continue }
            // `finalise: false` — a per-transaction refusal must not be allowed
            // to become the sheet's answer before /api/me has been consulted.
            if let refused = await report(result, session: session, finalise: false) {
                rejection = refused
            }
        }

        await env.refreshEntitlement()
        if env.owned() {
            outcome = .purchased
        } else {
            // A refusal outranks "nothing found": `bound_elsewhere` has an action
            // on it, and "no purchase found" would send that user round forever.
            outcome = rejection ?? .restoreNone
        }
    }

    // MARK: reporting

    /// A transaction that arrived on `Transaction.updates`.
    private func deliver(_ result: VerificationResult<Transaction>) async {
        guard transaction(in: result).productID == Self.productID else { return }
        guard let session = env.session() else { return } // signed out; the next launch retries
        // Silent: this can fire at any moment, including while another sheet is
        // open, so it records the grant and refreshes the entitlement without
        // taking over the UI.
        // `report` refreshes `/api/me` itself when the grant lands, so there is
        // nothing to add here on either branch.
        _ = await report(result, session: session, finalise: false)
    }

    /// Post the signed transaction and act on the answer.
    ///
    /// Returns the refusal, if there was one. When `finalise` is true the result
    /// also becomes the sheet's state.
    @discardableResult
    private func report(
        _ result: VerificationResult<Transaction>,
        session: BillingSession,
        finalise: Bool
    ) async -> PlusOutcome? {
        var failure: AuthError?
        do {
            try await client.reportApple(result, session: session)
        } catch let error as AuthError {
            failure = error
        } catch {
            failure = .network
        }

        let verdict = reportVerdict(for: failure)
        if verdict.mayFinish {
            await transaction(in: result).finish()
        }

        if failure == nil {
            // The entitlement is the server's answer, not this call's — refresh
            // before claiming anything, so the sheet and the layer cap agree.
            await env.refreshEntitlement()
            if finalise { outcome = .purchased }
            return nil
        }
        if finalise { outcome = verdict.outcome }
        return verdict.outcome
    }

    /// The transaction inside a `VerificationResult`, verified or not.
    ///
    /// An unverified transaction is still forwarded: the Worker verifies the x5c
    /// chain to Apple's root itself and is the only verifier that counts. What
    /// this is for is `productID` (to ignore other products) and `finish()`.
    private func transaction(in result: VerificationResult<Transaction>) -> Transaction {
        switch result {
        case .verified(let t): return t
        case .unverified(let t, _): return t
        }
    }
}

extension AuthModel {
    /// The session as billing needs it. Nil when signed out — which is what
    /// makes "purchase requires sign-in" a fact rather than a hope.
    var billingSession: BillingSession? {
        guard let stored = session else { return nil }
        return BillingSession(userId: stored.user.id, token: stored.token, csrf: stored.csrf)
    }

    /// Wiring for `PlusStore.start`.
    var billingEnvironment: BillingEnvironment {
        BillingEnvironment(
            session: { [weak self] in self?.billingSession },
            refreshEntitlement: { [weak self] in
                guard let self else { return }
                await self.refreshPlus()
            },
            owned: { [weak self] in self?.plus?.active ?? false }
        )
    }
}
