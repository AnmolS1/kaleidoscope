import SwiftUI
import UIKit

extension Color {
    /// "#RRGGBB" for this color (alpha dropped) — the form the vector model and
    /// the color palette use.
    var hexRGB: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
        func channel(_ v: CGFloat) -> Int { max(0, min(255, Int((v * 255).rounded()))) }
        return String(format: "#%02X%02X%02X", channel(r), channel(g), channel(b))
    }
}
