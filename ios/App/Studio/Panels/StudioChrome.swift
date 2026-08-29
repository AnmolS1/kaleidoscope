import SwiftUI

// The blueprint-instrument chrome primitives (DESIGN.md §1, §3): the translucent
// surface the rail and badges sit on, the card popovers hang off, the chip, the
// rail icon button, the readout capsule and the toast.
//
// They live in one file because they share exactly one decision — how a surface
// is drawn — and splitting that across five files is how two of them end up with
// different corner radii.

// MARK: - Surfaces

/// The chrome surface: `--color-graph-card` at 88% over a blur. Under Reduce
/// Transparency it becomes fully opaque, because the whole point of that setting
/// is that a user cannot read text over moving art.
struct ChromeSurface: View {
    var cornerRadius: CGFloat = Blueprint.rMd
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        ZStack {
            if reduceTransparency {
                shape.fill(Blueprint.graphCard)
            } else {
                shape.fill(Blueprint.graphCard.opacity(0.88))
                    .background(shape.fill(.ultraThinMaterial))
            }
            shape.stroke(Blueprint.creaseLineBold, lineWidth: 1)
        }
    }
}

/// A panel / popover card: opaque surface, bold hairline border, card shadow.
struct CardSurface: View {
    var cornerRadius: CGFloat = Blueprint.rMd

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        shape.fill(Blueprint.graphCard)
            .overlay(shape.stroke(Blueprint.creaseLineBold, lineWidth: 1))
            .shadow(color: Blueprint.cardShadowNear.color,
                    radius: Blueprint.cardShadowNear.radius, y: Blueprint.cardShadowNear.y)
            .shadow(color: Blueprint.cardShadowFar.color,
                    radius: Blueprint.cardShadowFar.radius, y: Blueprint.cardShadowFar.y)
    }
}

extension View {
    func chromeBackground(cornerRadius: CGFloat = Blueprint.rMd) -> some View {
        background(ChromeSurface(cornerRadius: cornerRadius))
    }

    func cardBackground(cornerRadius: CGFloat = Blueprint.rMd) -> some View {
        background(CardSurface(cornerRadius: cornerRadius))
    }

    /// A 1pt divider in the hairline token.
    func hairlineDivider() -> some View {
        overlay(alignment: .bottom) { Blueprint.creaseLine.frame(height: 1) }
    }
}

/// A hairline rule, used inside panels and down the rail.
struct Hairline: View {
    var body: some View { Blueprint.creaseLine.frame(height: 1) }
}

// MARK: - Icon button

/// A rail / dock tool button. Active state is exactly `studio.css`'s
/// `.icon-btn.is-active`: crane at 16% fill, 35% border, `crane-strong` glyph.
///
/// `differentiateWithoutColor` adds a filled dot under an active button, because
/// "16% crane fill vs no fill" is a colour-only distinction and that is precisely
/// what the setting exists to remove.
struct IconButton: View {
    let systemImage: String
    let label: String
    var hint: String?
    var isActive: Bool = false
    var isEnabled: Bool = true
    var size: CGFloat = 44
    /// Optional mono caption under the glyph (the rail's `12 · D`).
    var caption: String?
    /// Optional crease-blue count badge (the rail's layer count).
    var badge: String?
    let action: () -> Void

    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Image(systemName: systemImage)
                    .font(.system(size: size * 0.4, weight: .regular))
                    .symbolRenderingMode(.monochrome)
                // The rail caption is dropped at accessibility sizes rather than
                // scaled: `9 · D` in a 44pt-wide button becomes `9 · …`, which
                // tells a reader nothing. The value is not lost — the button's
                // `accessibilityValue` says "9 segments, mirrored" in full, and
                // the top readout still spells it out.
                if let caption, !dynamicTypeSize.isAccessibilitySize {
                    Text(caption)
                        .font(Blueprint.mono(.caption2))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        // Pinned to graphite rather than inheriting the active
                        // crane tint. `craneStrong` on the 16% crane fill is
                        // 4.25:1 in dark — a fail for 10pt text, and this caption
                        // is a READOUT (`9 · D`), not part of the active-state
                        // indication. graphite @0.8 clears it at 6.45 / 7.57.
                        .foregroundStyle(Blueprint.graphite.opacity(0.8))
                }
                if isActive && differentiateWithoutColor {
                    Circle().frame(width: 3, height: 3)
                }
            }
            .foregroundStyle(isActive ? Blueprint.craneStrong : Blueprint.graphite.opacity(0.72))
            .frame(width: size, height: caption == nil ? size : size + 10)
            .background {
                let shape = RoundedRectangle(cornerRadius: Blueprint.rSm, style: .continuous)
                if isActive {
                    shape.fill(Blueprint.crane.opacity(0.16))
                        .overlay(shape.stroke(Blueprint.crane.opacity(0.35), lineWidth: 1))
                }
            }
            .overlay(alignment: .topTrailing) {
                if let badge { CountBadge(text: badge).offset(x: -4, y: 4) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.35)
        .accessibilityLabel(label)
        .accessibilityHint(hint ?? "")
        .accessibilityAddTraits(isActive ? [.isButton, .isSelected] : .isButton)
    }
}

/// The crease-blue count badge on the Layers button.
struct CountBadge: View {
    let text: String

    var body: some View {
        Text(text)
            // Fixed size, not a text style. The badge is a graphical count in a
            // 14pt disc pinned to a 44pt button's corner; scaling it to
            // accessibility sizes bursts the disc and covers the glyph it is
            // annotating. The count is spoken in full by the button's
            // `accessibilityValue`, so nothing is lost by not scaling it.
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundStyle(.white)
            .padding(.horizontal, 3)
            .frame(minWidth: 14, minHeight: 14)
            .background(Capsule().fill(Blueprint.creaseButton))
            .accessibilityHidden(true) // the button's own label carries the count
    }
}

// MARK: - Chip

/// The design's `.chip`: a bordered pill used for values, popover titles and the
/// panel footer actions.
struct Chip<Content: View>: View {
    var isActive: Bool = false
    var isEnabled: Bool = true
    @ViewBuilder var content: Content

    var body: some View {
        content
            .font(.footnote)
            .foregroundStyle(isActive ? Blueprint.craneStrong : Blueprint.graphite.opacity(0.85))
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
            .background {
                let shape = RoundedRectangle(cornerRadius: Blueprint.rSm, style: .continuous)
                shape.fill(isActive ? Blueprint.crane.opacity(0.12) : Blueprint.inset)
                    .overlay(shape.stroke(isActive ? Blueprint.crane.opacity(0.35)
                                                   : Blueprint.creaseLineBold, lineWidth: 1))
            }
            .opacity(isEnabled ? 1 : 0.45)
    }
}

// MARK: - Readout capsule

/// The top-left mono readout. Its VoiceOver label is the SPOKEN form — a screen
/// reader announcing "L 2 dot 12 dot D" would be reading punctuation aloud, not
/// telling anyone what the canvas is set to.
struct ReadoutCapsule: View {
    let text: String
    let spoken: String
    let height: CGFloat

    var body: some View {
        Text(text)
            .font(Blueprint.mono(.caption))
            .foregroundStyle(Blueprint.graphite.opacity(0.85))
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .padding(.horizontal, 12)
            .frame(minHeight: height)
            .chromeBackground(cornerRadius: Blueprint.rSm)
            .accessibilityElement()
            .accessibilityLabel("Canvas state")
            .accessibilityValue(spoken)
    }
}

// MARK: - Toast

/// A studio nudge (DESIGN.md §3). One at a time, bottom-leading, dismissed by the
/// next stroke or after 6s — the timer lives with the caller, because "the next
/// stroke" is a document event this view cannot see.
struct StudioToast: View {
    let systemImage: String
    let message: String
    var actionTitle: String?
    var action: (() -> Void)?
    var onDismiss: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(Blueprint.craneStrong)
                .accessibilityHidden(true)
            Text(message)
                .font(.footnote)
                .foregroundStyle(Blueprint.graphite)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(action: action) {
                    Chip { Text(actionTitle).lineLimit(2) }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: 420, alignment: .leading)
        .cardBackground()
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isSummaryElement)
        .onAppear { UIAccessibility.post(notification: .announcement, argument: message) }
        .onTapGesture { onDismiss?() }
    }
}

// MARK: - Primary / ghost actions

/// The top-right Save. `craneButton` fill with a pinned white label: the tint is
/// not allowed to pick its own label colour, which is how the studio's contrast
/// numbers stay checkable (see ios/ACCESSIBILITY_CONTRAST.md).
struct PrimaryAction: View {
    let title: String
    let systemImage: String
    var height: CGFloat = 36
    var compact: Bool = false
    var isEnabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                if !compact { Text(title).font(.subheadline.weight(.medium)) }
            }
            .foregroundStyle(.white)
            .padding(.horizontal, compact ? 10 : 14)
            .frame(minHeight: height)
            .background(RoundedRectangle(cornerRadius: Blueprint.rSm, style: .continuous)
                .fill(Blueprint.craneButton))
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.45)
        .accessibilityLabel(title)
    }
}

/// A ghost action on the chrome surface (Download, gallery, help).
struct GhostAction: View {
    let title: String
    let systemImage: String
    var height: CGFloat = 36
    var compact: Bool = false
    var isEnabled: Bool = true
    var accessibilityLabelText: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                if !compact { Text(title).font(.subheadline.weight(.medium)) }
            }
            .foregroundStyle(Blueprint.graphite.opacity(0.85))
            .padding(.horizontal, compact ? 10 : 14)
            .frame(minHeight: height)
            .chromeBackground(cornerRadius: Blueprint.rSm)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.35)
        .accessibilityLabel(accessibilityLabelText ?? title)
    }
}
