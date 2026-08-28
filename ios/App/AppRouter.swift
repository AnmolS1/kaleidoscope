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
    ///
    /// A remix of a layered piece must arrive with its layers intact, so this is
    /// the v2 entry point. The v1 overload below stays for the caller that still
    /// reads through `deserialize` (T13 migrates it to `?v=2`); it upgrades to
    /// the single-layer v2 shape §2.1 specifies, which is exactly what the
    /// studio would have built for a fresh canvas.
    func remix(_ drawing: DrawingV2, sourceId: String, into studio: StudioModel) {
        studio.load(drawing)
        studio.remixSourceId = sourceId
        tab = Self.drawTab
    }

    func remix(_ drawing: Drawing, sourceId: String, into studio: StudioModel) {
        remix(upgradeToV2(drawing), sourceId: sourceId, into: studio)
    }
}
