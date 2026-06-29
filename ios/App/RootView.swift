import SwiftUI

/// The app is more than a widget wrapper: a full random-piece browser, a "add the widget"
/// walkthrough, and a short About. That standalone value is what clears App Review 4.2.
struct RootView: View {
    @Binding var focusId: String?

    var body: some View {
        TabView {
            ShuffleViewer(focusId: $focusId)
                .tabItem { Label("Discover", systemImage: "sparkles") }
            AddWidgetHelp()
                .tabItem { Label("Widget", systemImage: "rectangle.3.group") }
            AboutView()
                .tabItem { Label("About", systemImage: "info.circle") }
        }
        .tint(Blueprint.crane)
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
