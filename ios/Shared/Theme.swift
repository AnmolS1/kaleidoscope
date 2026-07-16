import SwiftUI

// MARK: - Hex colors with light/dark variants (ported from src/client/styles/tokens.css)

extension UIColor {
    convenience init(hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        let r = CGFloat((v >> 16) & 0xff) / 255
        let g = CGFloat((v >> 8) & 0xff) / 255
        let b = CGFloat(v & 0xff) / 255
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}

extension Color {
    init(hex: String) { self = Color(UIColor(hex: hex)) }

    init(light: String, dark: String) {
        self = Color(UIColor { trait in
            UIColor(hex: trait.userInterfaceStyle == .dark ? dark : light)
        })
    }
}

/// The Kaleidoscope "blueprint / origami workshop" palette.
enum Blueprint {
    static let graph = Color(light: "#EEF0EC", dark: "#13202A")
    static let graphite = Color(light: "#1B2A33", dark: "#E9ECE7")
    static let crease = Color(light: "#2E5E8C", dark: "#82A9CE")
    static let crane = Color(light: "#E84A27", dark: "#F5613C")
    static let sax = Color(hex: "#D9A521")

    /// Accessible sax variant for *text* on the graph background. Plain sax
    /// (#D9A521) only reaches ~1.96:1 on the light theme — a WCAG fail for the
    /// small AI-name chip captions in SaveSheet. This darkened gold clears 4.5:1
    /// in light while staying the familiar sax in dark (already ~7.4:1). See
    /// ios/ACCESSIBILITY_CONTRAST.md.
    static let saxText = Color(light: "#7A5A0F", dark: "#D9A521")

    /// Solid, opaque surface used in place of `.ultraThinMaterial` when the user
    /// has Reduce Transparency on — a slightly-raised "graph card" tone so the
    /// studio controls panel stays legible without a blur.
    static let card = Color(light: "#E3E6E0", dark: "#1A2A35")

    // MARK: Filled-button + accent-text tokens (WCAG-tuned)
    //
    // Plain `crane` / `crease` are tuned as *tints* (3:1 graphical bar). They are
    // too light to carry a **white label** or to render as **body text** at the
    // 4.5:1 bar in one or both themes (white-on-crane 3.15 dark; crane-as-text
    // 3.37 light; white-on-crease 2.47 dark). These variants fix that. See
    // ios/ACCESSIBILITY_CONTRAST.md.

    /// Fill for prominent crane action buttons (Save, Sign in, Shuffle, Try
    /// again). Dark enough in **both** themes that a pinned white label clears
    /// 4.5:1 (5.36:1) while the fill still separates from the graph background
    /// (4.68:1 light / 3.09:1 dark).
    static let craneButton = Color(hex: "#C23A1C")

    /// Fill for the prominent crease action button (Remix). Plain crease in dark
    /// (#82A9CE) is too light for a white label (2.47:1); this keeps a deeper
    /// blue in both themes so white clears 4.5:1 (6.78:1 light / 5.10:1 dark) and
    /// the fill still separates from the background (5.91:1 / 3.25:1).
    static let creaseButton = Color(light: "#2E5E8C", dark: "#40729E")

    /// `crane` used as *text* (e.g. the bordered Like button's tinted label).
    /// Darkened in light and lightened in dark so it clears 4.5:1 on the graph
    /// background in both themes (5.71:1 light / 5.49:1 dark) — plain crane is
    /// only 3.37:1 as light-theme text.
    static let craneText = Color(light: "#A83618", dark: "#F26B44")

    /// Dark ink for a label sitting on the gold `sax` fill (the selected Glow
    /// toggle). White fails on light gold (~1.6:1); this fixed dark navy clears
    /// 4.5:1 in both themes (7.38:1) since `sax` itself is fixed.
    static let onSax = Color(hex: "#13202A")

    /// Human-readable name for a palette swatch, mirroring the backend's color
    /// vocabulary, so VoiceOver never reads a bare hex string. Falls back to a
    /// spoken hex ("hex E 8 4 A 2 7") for any custom / off-palette color.
    static func colorName(forHex hex: String) -> String {
        switch hex.uppercased() {
        case "#E84A27": return "crane orange"
        case "#2E5E8C": return "teal"
        case "#D9A521": return "sax gold"
        case "#1B2A33": return "graphite"
        case "#3FA34D": return "green"
        case "#8E44AD": return "purple"
        case "#EAEAEA": return "light gray"
        default:
            let digits = hex.uppercased().drop { $0 == "#" }
            return "hex " + digits.map { String($0) }.joined(separator: " ")
        }
    }
}

// MARK: - Rotating-rosette mark (static version of public/favicon.svg)

/// The Kaleidoscope rosette drawn in code (6 crane rays at 60°, a sax inner ring, a crease
/// outer ring) so it stays crisp at any widget size without a rasterized asset.
struct RosetteMark: View {
    var lineWidth: CGFloat = 2

    var body: some View {
        Canvas { ctx, size in
            let s = min(size.width, size.height)
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let scale = s / 64.0 // favicon viewBox is 64×64, rosette radius 22

            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: center.x + x * scale, y: center.y + y * scale)
            }

            // Six crane-colored rays.
            let rays: [(CGFloat, CGFloat)] = [(0, -22), (19, -11), (19, 11), (0, 22), (-19, 11), (-19, -11)]
            var rayPath = Path()
            for (x, y) in rays {
                rayPath.move(to: center)
                rayPath.addLine(to: pt(x, y))
            }
            ctx.stroke(rayPath, with: .color(Blueprint.crane),
                       style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))

            // Sax inner ring (r=10).
            let inner = Path(ellipseIn: CGRect(x: center.x - 10 * scale, y: center.y - 10 * scale,
                                               width: 20 * scale, height: 20 * scale))
            ctx.stroke(inner, with: .color(Blueprint.sax.opacity(0.9)), lineWidth: lineWidth)

            // Crease outer ring (r=22).
            let outer = Path(ellipseIn: CGRect(x: center.x - 22 * scale, y: center.y - 22 * scale,
                                               width: 44 * scale, height: 44 * scale))
            ctx.stroke(outer, with: .color(Blueprint.crease.opacity(0.5)), lineWidth: lineWidth)
        }
    }
}
