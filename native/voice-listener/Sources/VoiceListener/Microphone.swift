import AVFoundation
import CoreAudio

func permission() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "granted"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-determined"
    @unknown default: return "unknown"
    }
}

struct Device: Encodable {
    let object: AudioDeviceID
    let id: String
    let name: String
    let builtIn: Bool
    let bluetooth: Bool
    enum CodingKeys: String, CodingKey { case id, name, builtIn, bluetooth }

    static func inputs() -> [Device] {
        numbers(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices).compactMap { object in
            guard !numbers(object, kAudioDevicePropertyStreams, kAudioDevicePropertyScopeInput).isEmpty,
                  let id = label(object, kAudioDevicePropertyDeviceUID) else { return nil }
            let transport = numbers(object, kAudioDevicePropertyTransportType).first
            return input(object: object, id: id, name: label(object, kAudioObjectPropertyName), transport: transport)
        }
    }

    static func input(object: AudioDeviceID, id: String, name: String?, transport: UInt32?) -> Device? {
        // The daemon's device string limits count UTF-16 code units. UIDs must round-trip exactly.
        guard !id.isEmpty, id.utf16.count <= 256 else { return nil }
        var length = 0
        let displayName = (name ?? "").unicodeScalars.prefix { scalar in
            length += scalar.utf16.count
            return length <= 256
        }
        return Device(object: object, id: id, name: displayName.isEmpty ? id : String(displayName),
                      builtIn: transport == kAudioDeviceTransportTypeBuiltIn,
                      bluetooth: transport == kAudioDeviceTransportTypeBluetooth || transport == kAudioDeviceTransportTypeBluetoothLE)
    }

    private static func numbers(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [UInt32] {
        var key = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &key, 0, nil, &size) == noErr, size > 0 else { return [] }
        var values = Array(repeating: UInt32(0), count: Int(size) / 4)
        let status = values.withUnsafeMutableBytes { AudioObjectGetPropertyData(object, &key, 0, nil, &size, $0.baseAddress!) }
        return status == noErr ? Array(values.prefix(Int(size) / 4)) : []
    }

    private static func label(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var key = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout.size(ofValue: value))
        guard AudioObjectGetPropertyData(object, &key, 0, nil, &size, &value) == noErr else { return nil }
        return value?.takeRetainedValue() as String?
    }
}

struct Segment {
    let samples: [Float]
    let capturedAt: Int64
}

// Energy VAD over mono 16 kHz PCM. Keep a short onset lead-in, allow pauses
// within a phrase, and bound memory if a device supplies continuous loud input.
struct SpeechGate {
    private var lead: [Float] = []
    private var samples: [Float] = []
    private var quiet = 0
    private var start: Int64 = 0

    mutating func feed(_ frame: [Float], now: Int64) -> Segment? {
        guard !frame.isEmpty else { return nil }
        let active = frame.reduce(0) { $0 + $1 * $1 } > Float(frame.count) * 0.000016
        if samples.isEmpty {
            if !active {
                lead = Array((lead + frame).suffix(2400))
                return nil
            }
            start = now - Int64((lead.count + frame.count) / 16)
            samples = lead
            lead.removeAll()
        }
        samples.append(contentsOf: frame)
        quiet = active ? 0 : quiet + frame.count
        guard quiet >= 12_800 || samples.count >= 16_000 * 30 else { return nil }
        defer { samples.removeAll(); quiet = 0 }
        return Segment(samples: samples, capturedAt: start)
    }
}

// Owned by one tap. Destroying the capture drops the converter's filter history
// as well as any speech that has not reached the end-of-segment threshold.
final class InputSegmenter {
    private let mono: AVAudioFormat
    private let converter: AVAudioConverter
    private var gate = SpeechGate()

    init(source: AVAudioFormat) throws {
        guard source.sampleRate > 0, source.channelCount > 0,
              let mono = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
              let converter = AVAudioConverter(from: source, to: mono) else { throw CaptureError.format }
        self.mono = mono
        self.converter = converter
    }

    func consume(_ buffer: AVAudioPCMBuffer, now: Int64) -> Segment? {
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * mono.sampleRate / buffer.format.sampleRate)) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { return nil }
        var supplied = false
        let status = converter.convert(to: converted, error: nil) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true
            state.pointee = .haveData
            return buffer
        }
        guard status != .error, let channel = converted.floatChannelData?[0] else { return nil }
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
        return gate.feed(samples, now: now)
    }
}

final class Microphone {
    private let engine = AVAudioEngine()
    var isRunning: Bool { engine.isRunning }
    private var configurationObserver: NSObjectProtocol?
    private let continuation: AsyncStream<Segment>.Continuation
    let segments: AsyncStream<Segment>

    // The system default is selected by leaving the audio unit's current device alone.
    static func selectInput(_ selection: String, from devices: [Device], setCurrentDevice: (AudioDeviceID) throws -> Void) throws {
        let device = selection == "built-in" ? devices.first(where: { $0.builtIn }) : devices.first(where: { $0.id == selection })
        if let device {
            try setCurrentDevice(device.object)
        } else if selection != "built-in" && selection != "system-default" {
            throw CaptureError.device
        }
    }

    init(selection: String, devices: [Device] = Device.inputs(),
         onStopped: @escaping @MainActor (Microphone) -> Void = { _ in }) throws {
        (segments, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(2))
        try Self.selectInput(selection, from: devices) { device in
            var object = device
            guard let unit = engine.inputNode.audioUnit,
                  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                                       0, &object, UInt32(MemoryLayout.size(ofValue: object))) == noErr else { throw CaptureError.device }
        }
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard !input.isVoiceProcessingEnabled else { throw CaptureError.format }
        let segmenter = try InputSegmenter(source: source)
        input.installTap(onBus: 0, bufferSize: 1024, format: source) { [continuation] buffer, _ in
            if let segment = segmenter.consume(buffer, now: Int64(Date().timeIntervalSince1970 * 1000)) {
                continuation.yield(segment)
            }
        }
        do { try engine.start() }
        catch { stop(); throw error }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
                                                                      object: engine, queue: nil) { [weak self] _ in
            Task { @MainActor in
                if let self, !self.isRunning { onStopped(self) }
            }
        }
    }

    func stop() {
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        continuation.finish()
    }
}
