import AVFoundation
import CoreAudio
import Clibfvad

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
    static let sampleNs: Int64 = 62_500 // one mono PCM sample at 16 kHz
    let samples: [Float]
    let startNs: Int64
    var capturedAt: Int64 { startNs / 1_000_000 }
    var endedAt: Int64 { (startNs + Int64(samples.count) * Self.sampleNs + 999_999) / 1_000_000 }

    static func completeSamples(_ count: Int, startingAt startNs: Int64, through releaseMs: Int64) -> Int {
        guard releaseMs > startNs / 1_000_000 else { return 0 }
        if releaseMs >= (startNs + Int64(count) * sampleNs + 999_999) / 1_000_000 { return count }
        return Int((releaseMs * 1_000_000 - startNs) / sampleNs)
    }

    func through(_ release: Int64) -> Segment? {
        let count = Self.completeSamples(samples.count, startingAt: startNs, through: release)
        guard count > 0 else { return nil }
        if count == samples.count { return self }
        return Segment(samples: Array(samples.prefix(count)), startNs: startNs)
    }
}

// Keep an onset lead-in and bound the audio retained between speech boundaries.
struct SpeechGate {
    private static let silenceSamples = 12_800
    private static let maxSegmentSamples = 16_000 * 30
    private var lead: [Float] = []
    private var samples: [Float] = []
    private var quiet = 0
    private var startNs: Int64 = 0
    private var discarding = false

    // Key-up is an explicit end of speech. Silence alone or a discarded prefix
    // cannot become a command, even when the operator releases the key.
    mutating func finish(tail: [Float], at release: Int64) -> Segment? {
        defer { self = SpeechGate() }
        guard !discarding, !samples.isEmpty else { return nil }
        let segment = Segment(samples: samples + tail, startNs: startNs).through(release)
        guard let segment, segment.samples.count <= Self.maxSegmentSamples else { return nil }
        return segment
    }

    mutating func feed(_ frame: [Float], active: Bool, endNs: Int64) -> Segment? {
        guard !frame.isEmpty else { return nil }
        if samples.isEmpty && !discarding {
            if !active {
                lead = Array((lead + frame).suffix(2400))
                return nil
            }
            startNs = endNs - Int64(lead.count + frame.count) * Segment.sampleNs
            samples = lead
            lead.removeAll()
        }
        // A quiet frame may straddle both the silence boundary and the buffer limit.
        let count = active ? frame.count : min(frame.count, Self.silenceSamples - quiet)
        quiet = active ? 0 : quiet + count
        let ended = quiet == Self.silenceSamples
        if ended { quiet = 0 }

        if !discarding && count <= Self.maxSegmentSamples - samples.count {
            samples.append(contentsOf: frame.prefix(count))
            if ended {
                defer { samples.removeAll() }
                return Segment(samples: samples, startNs: startNs)
            }
            if samples.count < Self.maxSegmentSamples { return nil }
        }
        // Drop the entire unfinished instruction. Its tail must never start another segment.
        samples.removeAll()
        discarding = !ended
        return nil
    }
}

// WebRTC classifies 20 ms of mono PCM at a time. Keep the original samples for
// Parakeet, including any partial frame left at the end of a converter callback.
final class SpeechSegmenter {
    private static let frameLength = 320
    private let detector: OpaquePointer
    private var pending: [Float] = []
    private var gate = SpeechGate()

    init() throws {
        guard let detector = fvad_new() else { throw CaptureError.format }
        guard fvad_set_sample_rate(detector, 16_000) == 0, fvad_set_mode(detector, 2) == 0 else {
            fvad_free(detector)
            throw CaptureError.format
        }
        self.detector = detector
    }

    deinit { fvad_free(detector) }

    func finish(at release: Int64) -> Segment? {
        defer { pending.removeAll() }
        return gate.finish(tail: pending, at: release)
    }

    func consume(_ samples: [Float], endNs: Int64) -> [Segment] {
        var result: [Segment] = []
        var offset = 0
        while offset < samples.count {
            let count = min(Self.frameLength - pending.count, samples.count - offset)
            pending.append(contentsOf: samples[offset..<(offset + count)])
            offset += count
            guard pending.count == Self.frameLength else { break }
            let pcm = pending.map { sample in
                sample.isFinite ? Int16(max(-1, min(1, sample)) * Float(Int16.max)) : 0
            }
            // Feed every frame to the classifier so it learns the room noise. Its
            // internal hangover can mark digital silence as speech; start counting
            // our own 800 ms boundary immediately when the signal is already quiet.
            let voiced = fvad_process(detector, pcm, pcm.count) == 1
            let active = voiced && pending.reduce(0) { $0 + $1 * $1 } > Float(pending.count) * 0.000016
            let frameEnd = endNs - Int64(samples.count - offset) * Segment.sampleNs
            if let segment = gate.feed(pending, active: active, endNs: frameEnd) { result.append(segment) }
            pending.removeAll(keepingCapacity: true)
        }
        return result
    }
}

// AVAudioTime and mach_absolute_time use the same host clock. Pair it with Unix
// time to express recorded samples on the daemon's key-release clock.
struct CaptureClock {
    let hostTime: UInt64
    let unixTime: TimeInterval

    init(hostTime: UInt64 = mach_absolute_time(), unixTime: TimeInterval = Date().timeIntervalSince1970) {
        self.hostTime = hostTime
        self.unixTime = unixTime
    }

    func unixNanoseconds(at time: UInt64) -> Int64 {
        let offset = AVAudioTime.seconds(forHostTime: time) - AVAudioTime.seconds(forHostTime: hostTime)
        return Int64((unixTime * 1e9).rounded()) + Int64((offset * 1e9).rounded())
    }
}

// Owned by one tap. Destroying the capture drops the converter's filter history
// as well as any speech that has not reached the end-of-segment threshold.
final class InputSegmenter {
    private let mono: AVAudioFormat
    private let converter: AVAudioConverter
    private let segmenter: SpeechSegmenter
    private var anchor: AVAudioTime?
    private var converterDelay: TimeInterval = 0
    private(set) var deliveredThrough: Int64?

    func finish(at release: Int64) -> Segment? { segmenter.finish(at: release) }

    init(source: AVAudioFormat) throws {
        guard source.sampleRate > 0, source.channelCount > 0,
              let mono = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
              let converter = AVAudioConverter(from: source, to: mono) else { throw CaptureError.format }
        self.mono = mono
        self.converter = converter
        segmenter = try SpeechSegmenter()
    }

    func consume(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime, clock: CaptureClock = CaptureClock(), cutoff: Int64? = nil) -> [Segment] {
        if when.isHostTimeValid && when.isSampleTimeValid { anchor = when }
        let time = when.isHostTimeValid ? when : anchor.flatMap { when.extrapolateTime(fromAnchor: $0) }
        guard let time, time.isHostTimeValid else { return [] }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * mono.sampleRate / buffer.format.sampleRate)) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { return [] }
        var supplied = false
        let status = converter.convert(to: converted, error: nil) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true
            state.pointee = .haveData
            return buffer
        }
        guard status != .error, let channel = converted.floatChannelData?[0] else { return [] }
        // The tap timestamp names the first input frame. Some input can remain
        // buffered in the resampler across callbacks; date the emitted PCM itself.
        let outputDuration = Double(converted.frameLength) / mono.sampleRate
        let startNs = clock.unixNanoseconds(at: time.hostTime) - Int64((converterDelay * 1e9).rounded())
        let endNs = startNs + Int64(converted.frameLength) * Segment.sampleNs
        converterDelay += Double(buffer.frameLength) / buffer.format.sampleRate - outputDuration
        deliveredThrough = endNs / 1_000_000
        var count = Int(converted.frameLength)
        if let cutoff {
            count = Segment.completeSamples(count, startingAt: startNs, through: cutoff)
        }
        let samples = Array(UnsafeBufferPointer(start: channel, count: count))
        return segmenter.consume(samples, endNs: startNs + Int64(count) * Segment.sampleNs)
    }
}

final class Microphone {
    private let engine: AVAudioEngine
    var isRunning: Bool { engine.isRunning }
    private var configurationObserver: NSObjectProtocol?
    private let tapLock = NSLock()
    private var segmenter: InputSegmenter?
    private var cutoff: Int64?
    private var onBoundary: (@MainActor () -> Void)?
    private var releaseTimeout: Task<Void, Never>?
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

    init(selection: String, devices: [Device] = Device.inputs(), engine: AVAudioEngine = AVAudioEngine(),
         onStopped: @escaping @MainActor (Microphone) -> Void = { _ in }) throws {
        self.engine = engine
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
        segmenter = try InputSegmenter(source: source)
        input.installTap(onBus: 0, bufferSize: 1024, format: source) { [weak self] buffer, when in
            self?.consume(buffer, at: when)
        }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
                                                                      object: engine, queue: nil) { [weak self] _ in
            Task { @MainActor in
                if let self, !self.isRunning { onStopped(self) }
            }
        }
        do { try engine.start() }
        catch { stop(); throw error }
    }

    func consume(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime, clock: CaptureClock = CaptureClock()) {
        let finish = tapLock.withLock { () -> (@MainActor () -> Void)? in
            guard let segmenter else { return nil }
            for segment in segmenter.consume(buffer, at: when, clock: clock, cutoff: cutoff) {
                continuation.yield(segment)
            }
            guard let cutoff, let end = segmenter.deliveredThrough, end >= cutoff else { return nil }
            defer { onBoundary = nil }
            return onBoundary
        }
        if let finish { Task { @MainActor in finish() } }
    }

    @MainActor func whenCaptured(through release: Int64, finish: @escaping @MainActor () -> Void) {
        let ready = tapLock.withLock {
            cutoff = release
            if let end = segmenter?.deliveredThrough, end >= release { return true }
            onBoundary = finish
            return false
        }
        if ready { finish(); return }
        // A disconnected or stalled input must still close. Normal capture ends
        // on the callback containing key-up; only samples through key-up are used.
        releaseTimeout = Task {
            try? await Task.sleep(for: .milliseconds(250))
            if !Task.isCancelled { finish() }
        }
    }

    @discardableResult func stop(releasedAt: Int64? = nil) -> Segment? {
        releaseTimeout?.cancel()
        releaseTimeout = nil
        if let configurationObserver {
            NotificationCenter.default.removeObserver(configurationObserver)
            self.configurationObserver = nil
        }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        return tapLock.withLock {
            onBoundary = nil
            let final = releasedAt.flatMap { segmenter?.finish(at: $0) }
            segmenter = nil
            continuation.finish()
            return final
        }
    }
}
