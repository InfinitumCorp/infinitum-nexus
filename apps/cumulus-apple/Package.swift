// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CumulusKit",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "CumulusKit", targets: ["CumulusKit"]),
    ],
    targets: [
        .target(name: "CumulusKit"),
        .testTarget(name: "CumulusKitTests", dependencies: ["CumulusKit"]),
    ]
)
