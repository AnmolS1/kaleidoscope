import SwiftUI

/// The app is a native drawing studio first: draw kaleidoscope mandalas, browse
/// the public gallery, and sign in (in "You") to save + remix.
struct RootView: View {
    @Binding var focusId: String?
    @EnvironmentObject var auth: AuthModel
    @EnvironmentObject var studio: StudioModel
    @EnvironmentObject var router: AppRouter

    var body: some View {
        TabView(selection: $router.tab) {
            StudioTab(model: studio)
                .tabItem { Label("Draw", systemImage: "paintbrush.pointed") }
                .tag(AppRouter.drawTab)
            GalleryView(focusId: $focusId)
                .tabItem { Label("Gallery", systemImage: "sparkles") }
                .tag(AppRouter.galleryTab)
            YouView()
                .tabItem { Label("You", systemImage: "person.crop.circle") }
                .tag(AppRouter.youTab)
        }
        .tint(Blueprint.crane)
    }
}

/// Hosts the studio. Save presents ONE sheet whether or not the user is signed
/// in: signed-out is a state of the save sheet (DESIGN.md §4), so signing in
/// re-renders it in place with the title and visibility the user had already
/// chosen. Presenting an auth sheet first, as this did before 1.2, dismissed the
/// save sheet and dropped the draft.
struct StudioTab: View {
    @ObservedObject var model: StudioModel
    @EnvironmentObject var auth: AuthModel
    @EnvironmentObject var router: AppRouter
    @State private var showSave = false
    @State private var savedPiece: SavedPiece?

    var body: some View {
        StudioView(model: model, onSave: handleSave)
            .onAppear { if StudioModel.demoRequested && model.isEmpty { model.loadDemo() } }
            // The layer cap is server policy (3 free / 8 Plus), so the studio is
            // told it rather than deriving it. Set from RootView so StudioModel
            // itself needs no knowledge of the session.
            .task(id: auth.layerCap) { model.setLayerCap(auth.layerCap) }
            .sheet(isPresented: $showSave) {
                SaveSheet(
                    // v2, not `currentDrawing()`: the v1 projection flattens
                    // every layer into one under the top layer's symmetry and
                    // drops per-layer opacity and smoothing. The saved IMAGE
                    // still looks right, which is exactly why the loss went
                    // unnoticed — the piece is only wrong when reopened.
                    drawing: model.currentDrawingV2(),
                    remixOf: model.remixSourceId
                ) { id in
                    savedPiece = SavedPiece(id: id)
                    router.markSaved() // refresh the public gallery
                }
                .environmentObject(auth)
            }
            .sheet(item: $savedPiece) { piece in
                NavigationStack {
                    ArtworkView(id: piece.id)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) { Button("Done") { savedPiece = nil } }
                        }
                }
            }
    }

    private func handleSave() { showSave = true }
}

struct SavedPiece: Identifiable {
    let id: String
}

/// About. Deliberately carries NO link to the web app.
///
/// Guideline 3.1.1 forbids buttons or calls to action directing customers to a
/// purchasing mechanism other than in-app purchase. This screen used to offer
/// "Draw your own online" pointing at `Config.webURL`; that was harmless while
/// the web had nothing to sell, and stops being harmless the moment Plus ships
/// there, because the same product is then buyable through Lemon Squeezy one tap
/// from an App Store build. It would have become a rejection at the worst
/// possible time — a review cycle after the paywall lands, not before it.
///
/// Nothing is lost by removing it: since 1.2 the app draws natively in the Draw
/// tab, so the button pointed at a worse version of a feature already onboard.
///
/// If it is ever wanted back, the compliant shape is to show it only when the
/// server positively reports Plus as DISABLED on the web, failing closed on nil
/// — not to link unconditionally.
struct AboutView: View {
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    RosetteMark(lineWidth: 3)
                        .frame(width: 72, height: 72)
                        .padding(.top, 8)
                    Text("Kaleidoscope")
                        .font(.largeTitle.bold())
                        .foregroundStyle(Blueprint.graphite)
                    Text("A random public mandala from the Kaleidoscope community, on your home screen. No account, no tracking — it simply shows public artwork and rotates on a schedule you pick.")
                        .foregroundStyle(Blueprint.graphite.opacity(0.8))
                    Spacer()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .background(Blueprint.graph.ignoresSafeArea())
            .navigationTitle("About")
        }
    }
}
