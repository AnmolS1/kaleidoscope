import SwiftUI

/// A short walkthrough for adding the home-screen widget and picking a refresh interval.
struct AddWidgetHelp: View {
    private let steps: [(String, String)] = [
        ("hand.tap", "Touch and hold an empty spot on your Home Screen until the apps jiggle."),
        ("plus.circle", "Tap the + in the top corner, then search for \u{201C}Kaleidoscope\u{201D}."),
        ("rectangle.3.group", "Pick a size — Small is full-bleed art; Medium and Large add the title, author and a shuffle button."),
        ("slider.horizontal.3", "Touch and hold the placed widget → Edit Widget to choose how often it rotates (5 minutes to once a day)."),
        ("shuffle", "On Medium/Large, tap the shuffle button any time for a brand-new piece right now."),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: step.0)
                                .font(.title2)
                                .foregroundStyle(Blueprint.crane)
                                .frame(width: 34)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Step \(idx + 1)")
                                    .font(.caption.bold())
                                    .foregroundStyle(Blueprint.crease)
                                Text(step.1)
                                    .foregroundStyle(Blueprint.graphite)
                            }
                        }
                    }
                }
                .padding()
            }
            .background(Blueprint.graph.ignoresSafeArea())
            .navigationTitle("Add the Widget")
        }
    }
}
