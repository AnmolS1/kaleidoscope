import UIKit
import ImageIO

/// Fetches an image and downsamples it to the widget's point size before decoding, so the
/// timeline keeps a modest memory footprint. iOS decodes WebP natively via ImageIO.
enum ImageLoader {
    static func load(from urlString: String, maxPixel: CGFloat, session: URLSession = .shared) async -> UIImage? {
        guard let url = URL(string: urlString) else { return nil }
        do {
            let (data, _) = try await session.data(from: url)
            return downsample(data: data, maxPixel: maxPixel)
        } catch {
            return nil
        }
    }

    static func downsample(data: Data, maxPixel: CGFloat) -> UIImage? {
        let srcOptions = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let src = CGImageSourceCreateWithData(data as CFData, srcOptions) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }
}
