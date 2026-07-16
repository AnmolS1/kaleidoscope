import SwiftUI
import KaleidoEngine

/// App-level navigation state. Lets any screen (e.g. a gallery piece's Remix
/// button) switch to the Draw tab and load a drawing into the shared studio.
@MainActor
final class AppRouter: ObservableObject {
    static let drawTab = 0
    static let galleryTab = 1
    static let youTab = 2

    @Published var tab: Int

    /// Bumped whenever a piece is saved. The public gallery watches this and
    /// reloads, so a newly-saved public piece shows without relaunching the app.
    @Published private(set) var gallerySaveToken = 0

    func markSaved() { gallerySaveToken += 1 }

    init() {
        switch ProcessInfo.processInfo.environment["KALEIDO_TAB"] {
        case "gallery": tab = Self.galleryTab
        case "you": tab = Self.youTab
        default: tab = Self.drawTab
        }
    }

    /// Load a piece into the studio and jump to Draw (remix). Records the source
    /// so a subsequent save links `remixOf`.
    func remix(_ drawing: Drawing, sourceId: String, into studio: StudioModel) {
        studio.load(drawing)
        studio.remixSourceId = sourceId
        tab = Self.drawTab
    }
}
