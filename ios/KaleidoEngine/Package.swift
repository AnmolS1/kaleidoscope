// swift-tools-version:5.9
import PackageDescription

// KaleidoEngine is the native port of the web drawing engine
// (src/client/engine). It is pure-Swift (Foundation only) so it can be unit
// tested headlessly with `swift test` AND embedded in the iOS app target for the
// Core Graphics renderer (Phase 3). The vector serializer here must reproduce
// the web `serialize` output byte-for-byte — see the golden-file tests.
let package = Package(
    name: "KaleidoEngine",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "KaleidoEngine", targets: ["KaleidoEngine"]),
    ],
    targets: [
        .target(name: "KaleidoEngine"),
        .testTarget(
            name: "KaleidoEngineTests",
            dependencies: ["KaleidoEngine"],
            resources: [.copy("Fixtures")]
        ),
    ]
)
