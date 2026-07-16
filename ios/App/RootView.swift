import SwiftUI

/// The app is a native drawing studio first: draw kaleidoscope mandalas, browse
/// the public gallery, add the widget, and (soon) sign in to save + remix.
struct RootView: View {
    @Binding var focusId: String?
    /// The studio state lives here so the in-progress drawing survives tab
    /// switches and is reachable for remix (loading a gallery piece into it).
    @StateObject private var studio = StudioModel()

    var body: some View {
        TabView {
            StudioTab(model: studio)
                .tabItem { Label("Draw", systemImage: "paintbrush.pointed") }
            ShuffleViewer(focusId: $focusId)
                .tabItem { Label("Gallery", systemImage: "sparkles") }
            AddWidgetHelp()
                .tabItem { Label("Widget", systemImage: "rectangle.3.group") }
            AboutView()
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .tint(Blueprint.crane)
    }
}

/// Hosts the studio and (until the save flow is wired) surfaces a notice when
/// Save is tapped.
struct StudioTab: View {
    @ObservedObject var model: StudioModel
    @State private var showSaveNotice = false

    var body: some View {
        StudioView(model: model, onSave: { showSaveNotice = true })
            .onAppear { if StudioModel.demoRequested && model.isEmpty { model.loadDemo() } }
            .alert("Saving is coming", isPresented: $showSaveNotice) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Sign in to save your piece to the gallery — arriving in the next update. Drawing and PNG export are free right now.")
            }
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
