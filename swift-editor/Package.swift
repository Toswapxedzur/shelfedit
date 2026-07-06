// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "ShelfEditSwift",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ShelfEditSwift", targets: ["ShelfEditSwift"]),
    ],
    targets: [
        .executableTarget(
            name: "ShelfEditSwift",
            path: "Sources"
        ),
    ]
)
