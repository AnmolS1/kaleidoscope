import SwiftUI

// The colour popover (DESIGN.md §2 rail anatomy): the palette row, the spectrum
// brush, and a custom picker.
//
// The palette hexes and the spoken names are the ones already shipped — VoiceOver
// says "teal", never "hash 2 E 5 E 8 C". Keeping the same strings is deliberate:
// the accessibility suite asserts on them, and moving a control is not a reason
// to rename it.

enum StudioPalette {
    static let colors = ["#E84A27", "#2E5E8C", "#D9A521", "#1B2A33",
                         "#3FA34D", "#8E44AD", "#EAEAEA"]
}

struct ColorPopover: View {
    @ObservedObject var model: StudioModel
    @Binding var customColor: Color

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Nine 44pt targets do not fit a 260pt card, so the palette WRAPS. It used
    /// to be a single `HStack`, which at accessibility text sizes overflowed the
    /// fixed width and clipped a swatch off each end — crane orange and teal, the
    /// two most-used colours, simply were not on screen. A grid also keeps every
    /// target at 44pt instead of squeezing them.
    private var columns: [GridItem] {
        [GridItem(.adaptive(minimum: 44, maximum: 52), spacing: 4)]
    }

    private var cardWidth: CGFloat { dynamicTypeSize.isAccessibilitySize ? 320 : 260 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Color").font(Blueprint.display(.subheadline))
                Spacer(minLength: 8)
                Text(model.useSpectrum ? "SPECTRUM" : Blueprint.colorName(forHex: model.color).uppercased())
                    .font(Blueprint.mono(.caption2))
                    .foregroundStyle(Blueprint.graphite.opacity(0.7))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
            .accessibilityHidden(true)

            LazyVGrid(columns: columns, alignment: .leading, spacing: 4) {
                SwatchGridItems(model: model, customColor: $customColor)
            }

            Hairline()

            Toggle(isOn: $model.useSpectrum) {
                Text("Spectrum")
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .tint(Blueprint.creaseButton)
            .accessibilityLabel("Rainbow spectrum brush")
            .accessibilityHint("Cycles through colors as you draw")
        }
        .padding(14)
        .frame(width: cardWidth)
        .accessibilityIdentifier("color-popover")
    }
}

/// The swatch strip. Shared by the popover's grid and the phone's scrolling
/// strip, so the two can never drift apart on which colours exist or what they
/// are called.
struct SwatchGridItems: View {
    @ObservedObject var model: StudioModel
    @Binding var customColor: Color
    var swatchSize: CGFloat = 26

    var body: some View {
        ForEach(StudioPalette.colors, id: \.self) { hex in
            Swatch(hex: hex, size: swatchSize,
                   isSelected: !model.useSpectrum
                       && model.color.caseInsensitiveCompare(hex) == .orderedSame) {
                model.color = hex
                model.useSpectrum = false
            }
        }
        SpectrumSwatch(size: swatchSize, isSelected: model.useSpectrum) {
            model.useSpectrum = true
        }
        ColorPicker("", selection: $customColor, supportsOpacity: false)
            .labelsHidden()
            .frame(width: swatchSize + 4, height: swatchSize + 4)
            .frame(minWidth: 44, minHeight: 44)
            .onChange(of: customColor) { _, newValue in
                model.color = newValue.hexRGB
                model.useSpectrum = false
            }
            .accessibilityLabel("Custom color picker")
    }
}

/// The phone strip's horizontal run of the same swatches.
struct SwatchRow: View {
    @ObservedObject var model: StudioModel
    @Binding var customColor: Color
    var swatchSize: CGFloat = 26

    var body: some View {
        HStack(spacing: 8) {
            SwatchGridItems(model: model, customColor: $customColor, swatchSize: swatchSize)
        }
    }
}

private struct Swatch: View {
    let hex: String
    let size: CGFloat
    let isSelected: Bool
    let action: () -> Void

    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(Color(hex: hex))
                .frame(width: size, height: size)
                .overlay(Circle().stroke(Blueprint.creaseLineBold, lineWidth: 1))
                .overlay {
                    if isSelected {
                        ZStack {
                            Circle().stroke(Blueprint.crane, lineWidth: 3).padding(-3)
                            // Differentiate Without Color: the ring is a crane
                            // glow, which is exactly the colour cue that setting
                            // removes — so add a shape.
                            if differentiateWithoutColor {
                                Image(systemName: "checkmark")
                                    .font(.system(size: size * 0.45, weight: .bold))
                                    .foregroundStyle(.white)
                                    .shadow(radius: 1)
                            }
                        }
                    }
                }
                // Keep the visual small but the target ≥44pt (DESIGN.md §2).
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Blueprint.colorName(forHex: hex))
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint("Sets the brush color")
    }
}

private struct SpectrumSwatch: View {
    let size: CGFloat
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(AngularGradient(colors: [.red, .yellow, .green, .cyan, .blue, .purple, .red],
                                      center: .center))
                .frame(width: size, height: size)
                .overlay(Circle().stroke(Blueprint.creaseLineBold, lineWidth: 1))
                .overlay {
                    if isSelected { Circle().stroke(Blueprint.crane, lineWidth: 3).padding(-3) }
                }
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Rainbow spectrum brush")
        .accessibilityHint("Cycles through colors as you draw")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}
