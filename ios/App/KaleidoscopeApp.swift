import SwiftUI

@main
struct KaleidoscopeApp: App {
    @State private var deepLinkId: String?

    var body: some Scene {
        WindowGroup {
            RootView(focusId: $deepLinkId)
                .onOpenURL { url in
                    // Widget tap arrives as kaleidoscopewidget://p/<id>
                    guard url.scheme == Config.urlScheme, url.host == "p" else { return }
                    let id = url.pathComponents.last { !$0.isEmpty && $0 != "/" }
                    deepLinkId = id
                }
        }
    }
}
