import CoreAudio
import XCTest
@testable import VoiceListener

final class MicrophoneDeviceTests: XCTestCase {
    private let internalMic = Device(object: 11, id: "internal-uid", name: "Microphone", builtIn: true, bluetooth: false)
    private let usbMic = Device(object: 22, id: "usb-uid", name: "Microphone", builtIn: false, bluetooth: false)

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
