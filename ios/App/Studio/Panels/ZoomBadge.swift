import SwiftUI

/// The bottom-right zoom capsule (DESIGN.md §2). It is the *only* zoom UI on
/// regular width — there are no +/− buttons — and tapping it resets the view.
///
/// Always visible, including at 100%. That is what the spec says and what every
/// iPad frame shows; a badge that appears only once you are already lost is not a
/// readout, and its fixed corner is the affordance that teaches people tapping it
/// resets the view. It is disabled at 1× so it does not advertise an action that
/// would do nothing.
struct ZoomBadge: View {
    let scale: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: "plus.magnifyingglass")
                Text(Readout.percent(Double(scale)))
                    .font(Blueprint.mono(.caption))
            }
            .foregroundStyle(Blueprint.graphite.opacity(0.85))
            .padding(.horizontal, 10)
            .frame(minHeight: 28)
            .chromeBackground(cornerRadius: Blueprint.rSm)
        }
        .buttonStyle(.plain)
        .disabled(scale == 1)
        .accessibilityLabel("Zoom")
        .accessibilityValue(Readout.percent(Double(scale)))
        .accessibilityHint("Resets the view to 100 percent")
        .accessibilityIdentifier("zoom-badge")
    }
}
