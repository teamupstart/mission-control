// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "VoiceListener",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "voice-listener", targets: ["VoiceListener"])],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git",
                 revision: "eb280cede001a9a35f2187d4a117537777eca756", traits: []),
        .package(url: "https://github.com/MatsMoll/libfvad-swift.git", revision: "d2afc80a7dfc5a2ec42c16df9eb913ba9fe4fd2f")
    ],
    targets: [
        .executableTarget(name: "VoiceListener", dependencies: [
            .product(name: "FluidAudio", package: "FluidAudio"),
            .product(name: "libfvad", package: "libfvad-swift")
        ]),
        .testTarget(name: "VoiceListenerTests", dependencies: ["VoiceListener"])
    ],
    swiftLanguageModes: [.v5]
)
