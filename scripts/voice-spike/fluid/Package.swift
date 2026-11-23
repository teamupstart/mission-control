// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "VoiceSpike", platforms: [.macOS(.v14)], dependencies: [
    .package(path: "../../../.tmp/voice-spike/FluidAudio-eb280cede001a9a35f2187d4a117537777eca756", traits: [])
], targets: [.executableTarget(name: "Probe", dependencies: [.product(name: "FluidAudio", package: "FluidAudio-eb280cede001a9a35f2187d4a117537777eca756")])])
