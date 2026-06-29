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
