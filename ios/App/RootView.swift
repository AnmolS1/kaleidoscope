import SwiftUI

/// The app is a native drawing studio first: draw kaleidoscope mandalas, browse
/// the public gallery, and sign in (in "You") to save + remix.
struct RootView: View {
    @Binding var focusId: String?
    @EnvironmentObject var auth: AuthModel
    /// The studio state lives here so the in-progress drawing survives tab
    /// switches and is reachable for remix (loading a gallery piece into it).
    @StateObject private var studio = StudioModel()
    /// Test hook: KALEIDO_TAB=draw|gallery|you selects the initial tab.
    @State private var selection = Self.initialTab

    var body: some View {
        TabView(selection: $selection) {
            StudioTab(model: studio)
                .tabItem { Label("Draw", systemImage: "paintbrush.pointed") }
                .tag(0)
            ShuffleViewer(focusId: $focusId)
                .tabItem { Label("Gallery", systemImage: "sparkles") }
                .tag(1)
            YouView()
                .tabItem { Label("You", systemImage: "person.crop.circle") }
                .tag(2)
        }
        .tint(Blueprint.crane)
    }

    private static var initialTab: Int {
        switch ProcessInfo.processInfo.environment["KALEIDO_TAB"] {
        case "gallery": return 1
        case "you": return 2
        default: return 0
        }
    }
}

/// Hosts the studio. Save requires sign-in — tapping it presents the auth sheet
/// when signed out; the real save flow is wired in the save-flow phase.
struct StudioTab: View {
    @ObservedObject var model: StudioModel
    @EnvironmentObject var auth: AuthModel
    @State private var showAuth = false
    @State private var showSaveNotice = false

    var body: some View {
        StudioView(model: model, onSave: handleSave)
            .onAppear { if StudioModel.demoRequested && model.isEmpty { model.loadDemo() } }
            .sheet(isPresented: $showAuth) {
                AuthSheet(reason: "Sign in to save your piece to the gallery.")
                    .environmentObject(auth)
            }
            .alert("Saving is coming", isPresented: $showSaveNotice) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("The save flow lands in the next update. Drawing and PNG export are free right now.")
            }
    }

    private func handleSave() {
        if auth.isSignedIn { showSaveNotice = true } else { showAuth = true }
    }
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
