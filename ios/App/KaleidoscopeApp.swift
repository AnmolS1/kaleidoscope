import SwiftUI

@main
struct KaleidoscopeApp: App {
    @State private var deepLinkId: String?
    @StateObject private var auth = AuthModel()

    var body: some Scene {
        WindowGroup {
            RootView(focusId: $deepLinkId)
                .environmentObject(auth)
                .onOpenURL { url in
                    // Widget tap arrives as kaleidoscopewidget://p/<id>. (The Google
                    // auth callback uses ASWebAuthenticationSession, which captures
                    // its kaleidoscope:// redirect directly — not via onOpenURL.)
                    guard url.scheme == Config.urlScheme, url.host == "p" else { return }
                    let id = url.pathComponents.last { !$0.isEmpty && $0 != "/" }
                    deepLinkId = id
                }
        }
    }
}
