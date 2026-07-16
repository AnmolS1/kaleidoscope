import SwiftUI

@main
struct KaleidoscopeApp: App {
    @State private var deepLinkId: String?
    @StateObject private var auth = AuthModel()
    // Studio + router live at app scope so gallery/artwork screens can load a
    // remix into the studio and jump to the Draw tab.
    @StateObject private var studio = StudioModel()
    @StateObject private var router = AppRouter()

    var body: some Scene {
        WindowGroup {
            RootView(focusId: $deepLinkId)
                .environmentObject(auth)
                .environmentObject(studio)
                .environmentObject(router)
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
