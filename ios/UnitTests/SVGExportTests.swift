import XCTest
import UniformTypeIdentifiers
import KaleidoEngine
@testable import Kaleidoscope

/// The Download dialog's "Share SVG…" path (`StudioExport.svgFile`).
///
/// Byte parity of the document itself with the web is KaleidoEngine's
/// `SVGExportGoldenTests`; this pins what the app adds on top: the file holds
/// exactly that document, under the web's download name, as an SVG.
final class SVGExportTests: XCTestCase {

    private let drawing = DrawingV2(bg: .dark, layers: [
        Layer(id: "l1", name: "Ink & <wash>", visible: true, opacity: 1,
              sym: Symmetry(segments: 6, mirror: true),
              strokes: [Stroke(tool: .glow, color: "spectrum", size: 12, opacity: 0.8,
                               pts: [StrokePoint(x: 0.1, y: 0.2, pressure: 0.5),
                                     StrokePoint(x: 0.3, y: -0.1, pressure: 1)])]),
        Layer(id: "l2", name: "Top", visible: true, opacity: 0.5,
              sym: Symmetry(segments: 9, mirror: false),
              strokes: [Stroke(tool: .solid, color: "#E84A27", size: 4, opacity: 1,
                               pts: [StrokePoint(x: -0.2, y: 0.4, pressure: 1)])]),
    ])

    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("svg-export-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    /// `new Date(1760967825123).toISOString().slice(0, 19).replace(/[:T]/g, "-")`
    /// printed by node — the web's `STAMP()` for the same instant.
    func testFilenameMatchesTheWebDownloadName() {
        let date = Date(timeIntervalSince1970: 1_760_967_825.123)
        XCTAssertEqual(StudioExport.svgFilename(at: date), "kaleidoscope-2025-10-20-13-43-45.svg")
    }

    func testFileHoldsExactlyTheEngineDocument() throws {
        let date = Date(timeIntervalSince1970: 1_760_967_825)
        let url = try StudioExport.svgFile(drawing, at: date, directory: scratch)

        XCTAssertEqual(url.lastPathComponent, "kaleidoscope-2025-10-20-13-43-45.svg",
                       "one .svg extension, the web's name")
        XCTAssertEqual(UTType(filenameExtension: url.pathExtension), .svg,
                       "the share sheet must see an SVG, not data")

        let bytes = try Data(contentsOf: url)
        XCTAssertEqual(bytes, Data(exportSVG(drawing).utf8), "file must be the engine's document, unmodified")

        // Well-formed XML — the layer name carries `&` and `<`, which would
        // break the document if escaping were lost on the way to the file.
        let parser = XMLParser(data: bytes)
        XCTAssertTrue(parser.parse(), "exported SVG must parse: \(String(describing: parser.parserError))")

        let text = String(decoding: bytes, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"-500 -500 1000 1000\""))
        XCTAssertTrue(text.contains("<title>Ink &amp; &lt;wash&gt;</title>"))
        // Two visible layers, so neither takes the direct-paint bypass.
        XCTAssertEqual(text.components(separatedBy: "isolation:isolate").count - 1, 2)
        // 6-fold mirror = 12 images for one stroke, 9 images for the other.
        XCTAssertEqual(text.components(separatedBy: "<use ").count - 1, 12 + 9)
    }

    /// The button exports the LAYERED document from the studio, not a v1
    /// flatten — the same trap `ExportUITests` guards for the PNG.
    @MainActor
    func testStudioDocumentExportsEveryLayer() throws {
        let model = StudioModel()
        model.load(drawing)
        let url = try StudioExport.svgFile(model.currentDrawingV2(), directory: scratch)
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertEqual(text, exportSVG(drawing))
        XCTAssertTrue(text.contains("opacity=\"0.5\""), "the half-opacity layer survived")
    }
}
