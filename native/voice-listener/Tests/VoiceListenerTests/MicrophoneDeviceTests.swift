import AVFoundation
import CoreAudio
import XCTest
@testable import VoiceListener

private final class InterruptedEngine: AVAudioEngine, @unchecked Sendable {
    override func start() throws {
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: self)
    }
}

final class MicrophoneDeviceTests: XCTestCase {
    private let internalMic = Device(object: 11, id: "internal-uid", name: "Microphone", builtIn: true, bluetooth: false)
    private let usbMic = Device(object: 22, id: "usb-uid", name: "Microphone", builtIn: false, bluetooth: false)

    @MainActor func testConfigurationStopDuringStartReachesTheListener() async throws {
        let engine = InterruptedEngine()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
        XCTAssertTrue(engine.inputNode.setManualRenderingInputPCMFormat(format) { _ in nil })
        let stopped = expectation(description: "configuration change posted inside engine.start()")
        let input = try Microphone(selection: "system-default", devices: [], engine: engine) { mic in
            XCTAssertFalse(mic.isRunning)
            stopped.fulfill()
        }
        defer { input.stop() }
        await fulfillment(of: [stopped], timeout: 2)
    }

    func testHelloDeviceMetadataFitsUTF16LimitsAndPreservesUID() throws {
        let uid = "USB-" + String(repeating: "🎙", count: 126)
        let name = String(repeating: "a", count: 255) + "🎙"
        let device = try XCTUnwrap(Device.input(object: 1, id: uid, name: name, transport: nil))
        XCTAssertEqual(device.id, uid)
        XCTAssertEqual(device.name, String(name.prefix(255)))
        XCTAssertNil(Device.input(object: 2, id: "", name: "Mic", transport: nil))
        XCTAssertNil(Device.input(object: 3, id: uid + "x", name: "Mic", transport: nil))
        XCTAssertEqual(Device.input(object: 4, id: "usable", name: "", transport: nil)?.name, "usable")
    }

    func testBuiltInPreferenceAppliesTheBuiltInObjectID() throws {
        var applied: [AudioDeviceID] = []
        try Microphone.selectInput("built-in", from: [usbMic, internalMic]) { applied.append($0) }
        XCTAssertEqual(applied, [internalMic.object])
    }

    func testExplicitUIDAppliesTheRequestedObjectID() throws {
        var applied: [AudioDeviceID] = []
        try Microphone.selectInput(usbMic.id, from: [internalMic, usbMic]) { applied.append($0) }
        XCTAssertEqual(applied, [usbMic.object])
    }

    func testBuiltInPreferenceKeepsSystemDefaultWhenOnlyUSBIsAvailable() throws {
        try Microphone.selectInput("built-in", from: [usbMic]) { _ in
            XCTFail("Fallback should leave the system's current input in place")
        }
    }

    func testSystemDefaultKeepsCurrentInputEvenWithABuiltInDevice() throws {
        try Microphone.selectInput("system-default", from: [internalMic, usbMic]) { _ in
            XCTFail("System default should leave the current input in place")
        }
    }

    func testUnavailableExplicitUIDFailsMicrophoneInitialization() {
        XCTAssertThrowsError(try Microphone(selection: "disconnected-uid", devices: [internalMic, usbMic])) { error in
            XCTAssertEqual(error as? CaptureError, .device)
        }
    }
}
