import SwiftUI

// The right-edge Size / Opacity sliders (DESIGN.md §2): two vertical 4pt tracks,
// 180pt long, 22pt thumbs, inset 24pt from the right edge.
//
// Built from a track and a `DragGesture` rather than a rotated `Slider`. A
// rotated Slider keeps its ORIGINAL hit rectangle — the visual is vertical and
// the touch target stays horizontal — and it drags VoiceOver's whole rotated
// coordinate space with it. The 24pt inset is not decoration either: at 0pt the
// drag competes with the iPad system edge-swipe and loses.

struct EdgeSliders: View {
    @ObservedObject var model: StudioModel

    var body: some View {
        HStack(spacing: 22) {
            EdgeSlider(title: "SIZE",
                       accessibilityLabel: "Brush size",
                       value: $model.size, range: 2...60,
                       readout: { "\(Int($0.rounded()))" },
                       spoken: { "\(Int($0.rounded())) points" },
                       step: 1)
            EdgeSlider(title: "OPAC",
                       accessibilityLabel: "Opacity",
                       value: $model.opacity, range: 0.1...1,
                       readout: { "\(Int(($0 * 100).rounded()))" },
                       spoken: { "\(Int(($0 * 100).rounded())) percent" },
                       step: 0.05)
        }
    }
}

struct EdgeSlider: View {
    let title: String
    let accessibilityLabel: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let readout: (Double) -> String
    let spoken: (Double) -> String
    /// One `accessibilityAdjustableAction` swipe.
    let step: Double

    private let trackHeight: CGFloat = 180
    private let thumb: CGFloat = 22

    private var fraction: CGFloat {
        CGFloat((value - range.lowerBound) / (range.upperBound - range.lowerBound))
    }

    var body: some View {
        VStack(spacing: 8) {
            Text(title)
                .font(Blueprint.mono(.caption2))
                .foregroundStyle(Blueprint.graphite.opacity(0.7))
                .accessibilityHidden(true)

            ZStack(alignment: .bottom) {
                Capsule().fill(Blueprint.creaseLineBold).frame(width: 4)
                Capsule().fill(Blueprint.crease)
                    .frame(width: 4, height: max(0, trackHeight * fraction))
                Circle()
                    .fill(Blueprint.inset)
                    // DEVIATION from the frame, deliberate. It draws this border
                    // as `rgba(46,94,140,.28)`, which puts a white thumb on the
                    // light graph ground at 1.15:1 with a 1.51:1 outline — a
                    // slider handle you cannot see, and a WCAG 1.4.11 fail at the
                    // 3:1 bar for a UI component. Solid `crease` is the same hue
                    // at 5.91 / 6.72 against the ground and 6.78 / 5.79 against
                    // the thumb's own fill.
                    .overlay(Circle().stroke(Blueprint.crease, lineWidth: 1))
                    .shadow(color: Blueprint.cardShadowNear.color,
                            radius: Blueprint.cardShadowNear.radius, y: Blueprint.cardShadowNear.y)
                    .frame(width: thumb, height: thumb)
                    .offset(y: -(trackHeight * fraction) + thumb / 2)
            }
            .frame(width: 44, height: trackHeight)   // ≥44pt target around a 4pt track
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0).onChanged { g in
                    // y grows downward; the track's zero is at the bottom.
                    let f = 1 - min(1, max(0, g.location.y / trackHeight))
                    value = range.lowerBound + Double(f) * (range.upperBound - range.lowerBound)
                }
            )

            Text(readout(value))
                .font(Blueprint.mono(.caption))
                .foregroundStyle(Blueprint.graphite.opacity(0.72))
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(spoken(value))
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: value = min(range.upperBound, value + step)
            case .decrement: value = max(range.lowerBound, value - step)
            @unknown default: break
            }
        }
    }
}
