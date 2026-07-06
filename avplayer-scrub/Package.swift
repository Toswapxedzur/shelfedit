// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AVPlayerScrub",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AVPlayerScrub", targets: ["AVPlayerScrub"]),
    ],
    targets: [
        .executableTarget(
            name: "AVPlayerScrub",
            path: "Sources"
        ),
    ]
)
