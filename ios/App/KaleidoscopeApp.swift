import SwiftUI

@main
struct KaleidoscopeApp: App {
    @State private var deepLinkId: String?
    @StateObject private var auth = AuthModel()
    // Studio + router live at app scope so gallery/artwork screens can load a
    // remix into the studio and jump to the Draw tab.
    @StateObject private var studio = StudioModel()
    @StateObject private var router = AppRouter()
    /// StoreKit. App-scoped because the `Transaction.updates` listener has to
    /// outlive every screen: a purchase can finish while the app is anywhere,
    /// or not at all until the next launch.
    @StateObject private var plus = PlusStore()

    var body: some Scene {
        WindowGroup {
            RootView(focusId: $deepLinkId)
                .environmentObject(auth)
                .environmentObject(studio)
                .environmentObject(router)
                .environmentObject(plus)
                // Start the transaction listener at launch, before any paywall
                // exists. `start` is idempotent and this `.task` is tied to the
                // WindowGroup's content APPEARANCE, not its identity — it re-runs
                // on scene changes, and two listeners would race two `finish()`
                // calls on one transaction.
                //
                // Deliberately NOT gated on `plus.enabled`: the flag hides the
                // paywall, but a purchase that already happened (Ask to Buy
                // approved later, a report that failed last launch) must still be
                // reported the moment the app can report it.
                .task {
                    plus.start(auth.billingEnvironment)
                    await plus.loadProduct()
                }
                .onAppear {
                    // Test hook: KALEIDO_ARTWORK=<id> deep-links to a piece on launch.
                    if let id = ProcessInfo.processInfo.environment["KALEIDO_ARTWORK"] {
                        router.tab = AppRouter.galleryTab
                        deepLinkId = id
                    }
                }
                .onOpenURL { url in
                    // Widget tap arrives as kaleidoscopewidget://p/<id>. (The Google
                    // auth callback uses ASWebAuthenticationSession, which captures
                    // its kaleidoscope:// redirect directly — not via onOpenURL.)
                    guard url.scheme == Config.urlScheme, url.host == "p" else { return }
                    let id = url.pathComponents.last { !$0.isEmpty && $0 != "/" }
                    router.tab = AppRouter.galleryTab // the piece opens in the Gallery tab
                    deepLinkId = id
                }
        }
    }
}
