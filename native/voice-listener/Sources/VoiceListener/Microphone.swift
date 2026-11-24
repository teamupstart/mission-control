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
    // Capture and release boundaries use milliseconds since the monotonic host-clock origin.
    var startedAtHostMs: Int64 { startNs / 1_000_000 }
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
    private let held: Bool
    private var overflowPrefix: Segment?

    init(held: Bool = false) { self.held = held }

    mutating func interrupt() {
        self = SpeechGate(held: held)
        discarding = true
    }

    // Key-up is an explicit end of speech. Silence alone or a discarded prefix
    // cannot become a command, even when the operator releases the key.
    mutating func finish(tail: [Float], at release: Int64) -> Segment? {
        defer { self = SpeechGate(held: held) }
        // The callback that filled the buffer may already contain audio recorded
        // after key-up. Only an explicit release inside this prefix can recover it.
        if let prefix = overflowPrefix,
           release <= (prefix.startNs + Int64(prefix.samples.count) * Segment.sampleNs) / 1_000_000 {
            return prefix.through(release)
        }
        guard !discarding, !samples.isEmpty else { return nil }
        let segment = Segment(samples: samples + tail, startNs: startNs).through(release)
        guard let segment, segment.samples.count <= Self.maxSegmentSamples else { return nil }
        return segment
    }

    mutating func feed(_ frame: [Float], active: Bool, endNs: Int64) -> Segment? {
        guard !frame.isEmpty else { return nil }
        if let prefix = overflowPrefix, endNs > prefix.startNs + Int64(Self.maxSegmentSamples) * Segment.sampleNs + 2_000_000_000 {
            overflowPrefix = nil
        }
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
        if held && !discarding {
            samples.append(contentsOf: frame.prefix(Self.maxSegmentSamples - samples.count))
            overflowPrefix = Segment(samples: samples, startNs: startNs)
        }
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
    private var gate: SpeechGate

    init(held: Bool = false) throws {
        gate = SpeechGate(held: held)
        guard let detector = fvad_new() else { throw CaptureError.format }
        guard fvad_set_sample_rate(detector, 16_000) == 0, fvad_set_mode(detector, 2) == 0 else {
            fvad_free(detector)
            throw CaptureError.format
        }
        self.detector = detector
    }

    deinit { fvad_free(detector) }

    func interrupt() {
        pending.removeAll()
        gate.interrupt()
    }

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

// Owned by one tap. Destroying the capture drops the converter's filter history
// as well as any speech that has not reached the end-of-segment threshold.
final class InputSegmenter {
    private let mono: AVAudioFormat
    private let converter: AVAudioConverter
    private let segmenter: SpeechSegmenter
    private var anchor: AVAudioTime?
    private var nextSample: AVAudioFramePosition?
    private var nextHostSeconds: TimeInterval?
    private var converterDelay: TimeInterval = 0
    private(set) var deliveredThrough: Int64?

    func finish(at release: Int64) -> Segment? { segmenter.finish(at: release) }

    private func interrupt() {
        converter.reset()
        converterDelay = 0
        segmenter.interrupt()
        anchor = nil
        nextSample = nil
        nextHostSeconds = nil
        deliveredThrough = nil
    }

    init(source: AVAudioFormat, held: Bool = false) throws {
        guard source.sampleRate > 0, source.channelCount > 0,
              let mono = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
              let converter = AVAudioConverter(from: source, to: mono) else { throw CaptureError.format }
        self.mono = mono
        self.converter = converter
        // In a hold, key-up can arrive after this tap. Real-time (unprimed) SRC
        // emits its filter latency at the start instead of reading future input
        // into earlier output. A late release can then safely trim the mono PCM.
        if held { converter.primeMethod = .none }
        segmenter = try SpeechSegmenter(held: held)
    }

    private func prefix(_ buffer: AVAudioPCMBuffer, frames: AVAudioFrameCount) -> AVAudioPCMBuffer? {
        guard let prefix = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: frames) else { return nil }
        prefix.frameLength = frames
        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        for (i, plane) in UnsafeMutableAudioBufferListPointer(prefix.mutableAudioBufferList).enumerated() {
            guard let dest = plane.mData, let src = source[i].mData else { return nil }
            dest.copyMemory(from: src, byteCount: Int(plane.mDataByteSize))
        }
        return prefix
    }

    func consume(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime, cutoff: Int64? = nil) -> [Segment] {
        if let cutoff, let deliveredThrough, deliveredThrough >= cutoff { return [] }
        let rate = buffer.format.sampleRate
        let hostSeconds = when.isHostTimeValid ? AVAudioTime.seconds(forHostTime: when.hostTime) : nil
        // Detect discontinuity before extrapolating. A reset position cannot use
        // the old anchor, even if the first callback after reset has no host time.
        if when.isSampleTimeValid, let nextSample {
            if when.sampleTime != nextSample { interrupt() }
        } else if let nextHostSeconds {
            guard let hostSeconds else { interrupt(); return [] }
            if abs(nextHostSeconds - hostSeconds) > 0.5 / rate { interrupt() }
        }
        // Anchor each contiguous run once. The device's frame positions date
        // its audio even if an individual callback reports a jittered host time.
        if when.isSampleTimeValid, when.isHostTimeValid, anchor == nil || nextSample != when.sampleTime { anchor = when }
        let time: AVAudioTime?
        if when.isSampleTimeValid, let anchor {
            time = AVAudioTime(sampleTime: when.sampleTime, atRate: rate).extrapolateTime(fromAnchor: anchor)
        } else {
            time = when.isHostTimeValid ? when : nil
        }
        guard let time, time.isHostTimeValid else { interrupt(); return [] }
        nextSample = when.isSampleTimeValid ? when.sampleTime + Int64(buffer.frameLength) : nil
        nextHostSeconds = (hostSeconds ?? AVAudioTime.seconds(forHostTime: time.hostTime)) + Double(buffer.frameLength) / rate

        let inputStart = Int64((AVAudioTime.seconds(forHostTime: time.hostTime) * 1e9).rounded())
        let inputDuration = Double(buffer.frameLength) / rate
        let inputEnd = inputStart + Int64((inputDuration * 1e9).rounded())
        let atRelease = cutoff.map { $0 <= inputEnd / 1_000_000 } ?? false
        var input: AVAudioPCMBuffer? = buffer
        if atRelease, let cutoff {
            // Compare in the device's sample domain before the resampling filter
            // sees the boundary. Only complete input frames belong to the hold.
            let durationNs = cutoff <= inputStart / 1_000_000 ? 0 : cutoff * 1_000_000 - inputStart
            let frames = min(buffer.frameLength, AVAudioFrameCount(Double(durationNs) * rate / 1e9))
            if frames == 0 {
                input = nil
            } else if frames < buffer.frameLength {
                guard let clipped = prefix(buffer, frames: frames) else { interrupt(); return [] }
                input = clipped
            }
        }
        let pendingDuration = atRelease ? max(0, converterDelay) : 0
        let capacity = AVAudioFrameCount(ceil((inputDuration + pendingDuration) * mono.sampleRate)) + 1
        guard let converted = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: capacity) else { interrupt(); return [] }
        var supplied = false
        let status = converter.convert(to: converted, error: nil) { _, state in
            guard !supplied, let input else {
                state.pointee = atRelease ? .endOfStream : .noDataNow
                return nil
            }
            supplied = true
            state.pointee = .haveData
            return input
        }
        guard status != .error, let channel = converted.floatChannelData?[0] else { interrupt(); return [] }
        // The tap timestamp names the first input frame. Some input can remain
        // buffered in the resampler across callbacks; date the emitted PCM itself.
        let outputDuration = Double(converted.frameLength) / mono.sampleRate
        let startNs = inputStart - Int64((converterDelay * 1e9).rounded())
        let endNs = startNs + Int64(converted.frameLength) * Segment.sampleNs
        converterDelay += Double(input?.frameLength ?? 0) / rate - outputDuration
        deliveredThrough = atRelease ? cutoff : endNs / 1_000_000
        var count = Int(converted.frameLength)
        if let cutoff {
            count = Segment.completeSamples(count, startingAt: startNs, through: cutoff)
        }
        let samples = Array(UnsafeBufferPointer(start: channel, count: count))
        return segmenter.consume(samples, endNs: startNs + Int64(count) * Segment.sampleNs)
    }
}

// The tap owns this FIFO while the key is down. Inference and a slow daemon never
// block its producer. Record when the first excess sample ends so the release
// timestamp can settle overflow without ever storing more than the limit.
struct HeldSpeech {
    private let limit: Int
    private var sampleCount = 0
    private var segments: [Segment] = []
    private var firstExcessEndNs: Int64?

    init(limit: Int = 120 * 16_000) { self.limit = limit }

    mutating func append(_ segment: Segment) {
        guard firstExcessEndNs == nil else { return }
        let room = limit - sampleCount
        if segment.samples.count > room {
            firstExcessEndNs = segment.startNs + Int64(room + 1) * Segment.sampleNs
            if room > 0 { segments.append(Segment(samples: Array(segment.samples.prefix(room)), startNs: segment.startNs)) }
        } else {
            sampleCount += segment.samples.count
            segments.append(segment)
        }
    }

    func finish(at release: Int64) -> [Segment]? {
        if let end = firstExcessEndNs, release >= (end + 999_999) / 1_000_000 { return nil }
        return segments.compactMap { $0.through(release) }
    }
}

final class Microphone {
    private let engine: AVAudioEngine
    var isRunning: Bool { engine.isRunning }
    private var configurationObserver: NSObjectProtocol?
    private let tapLock = NSLock()
    private var segmenter: InputSegmenter?
    private var heldSpeech: HeldSpeech?
    private let onQueueFull: () -> Void
    private var queueFullReported = false
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

    init(selection: String, held: Bool = false, devices: [Device] = Device.inputs(), engine: AVAudioEngine = AVAudioEngine(),
         onQueueFull: @escaping () -> Void = {
             DispatchQueue.global(qos: .utility).async {
                 fputs("Voice listener queue full. New speech dropped while earlier phrases await delivery.\n", stderr)
             }
         },
         onStopped: @escaping @MainActor (Microphone) -> Void = { _ in }) throws {
        self.engine = engine
        self.onQueueFull = onQueueFull
        heldSpeech = held ? HeldSpeech() : nil
        (segments, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingOldest(2))
        try Self.selectInput(selection, from: devices) { device in
            var object = device
            guard let unit = engine.inputNode.audioUnit,
                  AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                                       0, &object, UInt32(MemoryLayout.size(ofValue: object))) == noErr else { throw CaptureError.device }
        }
        let input = engine.inputNode
        let source = input.outputFormat(forBus: 0)
        guard !input.isVoiceProcessingEnabled else { throw CaptureError.format }
        segmenter = try InputSegmenter(source: source, held: held)
        input.installTap(onBus: 0, bufferSize: 1024, format: source) { [weak self] buffer, when in
            guard let self else { return }
            self.consume(buffer, at: when)
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

    func consume(_ buffer: AVAudioPCMBuffer, at when: AVAudioTime) {
        let finish = tapLock.withLock { () -> (@MainActor () -> Void)? in
            guard let segmenter else { return nil }
            for segment in segmenter.consume(buffer, at: when, cutoff: cutoff) {
                if heldSpeech != nil {
                    heldSpeech?.append(segment)
                } else if case .dropped = continuation.yield(segment) {
                    if !queueFullReported { onQueueFull() }
                    queueFullReported = true
                } else {
                    queueFullReported = false
                }
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

    @discardableResult func stop(releasedAt: Int64? = nil) -> [Segment] {
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
            defer { heldSpeech = nil; segmenter = nil; continuation.finish() }
            guard let releasedAt else { return [] }
            // The timeout closes a stalled input before its final callback.
            // Only a tap that covered key-up can certify unfinished speech.
            var final: Segment?
            if let segmenter, let end = segmenter.deliveredThrough, end >= releasedAt {
                final = segmenter.finish(at: releasedAt)
            }
            if heldSpeech == nil { return final.map { [$0] } ?? [] }
            if let final { heldSpeech?.append(final) }
            if let captured = heldSpeech?.finish(at: releasedAt) { return captured }
            fputs("Voice listener discarded a push-to-talk hold exceeding the audio buffer limit.\n", stderr)
            return []
        }
    }
}
