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

struct AboutView: View {
    @Environment(\.openURL) private var openURL

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
                    Button {
                        openURL(Config.webURL)
                    } label: {
                        Label("Draw your own online", systemImage: "safari")
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(Blueprint.crease)
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
