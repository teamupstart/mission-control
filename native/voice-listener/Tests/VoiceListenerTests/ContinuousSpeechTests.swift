import AVFoundation
import XCTest
@testable import VoiceListener

final class ContinuousSpeechTests: XCTestCase {
    private func recording(_ path: String) throws -> [Float] {
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        XCTAssertEqual(file.processingFormat.sampleRate, 16_000)
        let input = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: input)
        return Array(UnsafeBufferPointer(start: input.floatChannelData![0], count: Int(input.frameLength)))
    }

    /// Drives the production listener loop with a file in place of the physical input.
    /// The browser spec observes the confirmation and the receiving session independently.
    @MainActor func testContinuousDesktopCapture() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["MISSION_LONG_VOICE_WAV"] else { throw XCTSkip("Requires the long-message desktop spec") }
        let source = try recording(path)
        let count = source.count
        guard count > 0 else { XCTFail("macOS speech synthesis produced no audio"); return }
        let pendingMessage = try env["MISSION_LONG_VOICE_PENDING_WAV"].map(recording)
        // Normalize the fixture duration across system voice revisions.
        let sampleCount = (pendingMessage == nil ? 60 : 62) * 16_000
        let pcm = (0..<sampleCount).map { index -> Float in
            let position = Double(index * count) / Double(sampleCount)
            let left = Int(position)
            return source[left] + Float(position - Double(left)) * (source[min(left + 1, count - 1)] - source[left])
        }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        // The recognizer uses the installed desktop CPU configuration. The isolated
        // daemon uses the local listener transport and its normal capture lock.
        var transport = env
        transport.removeValue(forKey: "MISSION_VOICE_LISTENER_INSTANCE")
        let daemon = Daemon(environment: transport)
        let pushToTalk = env["MISSION_LONG_VOICE_HELD"] == "1"
        func hostUs() -> Int64 { Int64(AVAudioTime.seconds(forHostTime: mach_absolute_time()) * 1_000_000) }
        let pressedAt = hostUs()
        func reportKey(down: Bool) async throws {
            let now = hostUs()
            let report: [String: Any] = ["reportedAtHostUs": now, "callActive": true, "pushToTalk": down,
                down ? "pushToTalkPressedAtHostUs" : "pushToTalkReleasedAtHostUs": down ? pressedAt : now]
            _ = try await daemon.request("voice/shell-report", body: JSONSerialization.data(withJSONObject: report))
        }
        if pushToTalk { try await reportKey(down: true) }
        var feed: Task<Void, Error>?
        let listener = Listener(daemon: daemon, microphonePermission: { "granted" }) {
            _, held, delay, limit, start, drop, stop in
            XCTAssertEqual(held, pushToTalk)
            XCTAssertEqual(limit, .oneMinute)
            let engine = TapFixtureEngine()
            try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 1024)
            XCTAssertTrue(engine.inputNode.setManualRenderingInputPCMFormat(format) { _ in nil })
            engine.connect(engine.inputNode, to: engine.mainMixerNode, format: format)
            let mic = try Microphone(selection: "system-default", held: held, endOfSpeechMs: delay, limit: limit,
                                     devices: [], engine: engine, onSpeechStart: start,
                                     onSegmentDropped: drop, onStopped: stop)
            guard feed == nil else { return mic }
            feed = Task {
                let clock = ContinuousClock.now
                let origin = AVAudioTime.seconds(forHostTime: mach_absolute_time())
                var position = 0
                func play(_ audio: [Float]) async throws {
                    for offset in stride(from: 0, to: audio.count, by: 1024) {
                        if held, offset < pcm.count, offset % (1024 * 64) == 0 { try await reportKey(down: true) }
                        if held, offset >= pcm.count, offset - 1024 < pcm.count { try await reportKey(down: false) }
                        let count = min(1024, audio.count - offset)
                        try await Task.sleep(until: clock + .microseconds((position + count) * 1_000_000 / 16_000), clock: .continuous)
                        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)))
                        buffer.frameLength = buffer.frameCapacity
                        audio.withUnsafeBufferPointer { source in
                            buffer.floatChannelData![0].update(from: source.baseAddress! + offset, count: count)
                        }
                        mic.consume(buffer, at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: origin + Double(position) / 16_000),
                                                            sampleTime: Int64(position), atRate: 16_000))
                        position += count
                    }
                }
                if let pendingMessage {
                    struct History: Decodable {
                        struct Entry: Decodable { let matchedName: String?; let outcome: String }
                        let entries: [Entry]
                    }
                    try await play(pendingMessage)
                    let quiet = Array(repeating: Float.zero, count: 4096)
                    var polling = true
                    let confirmation = Task {
                        defer { polling = false }
                        let deadline = ContinuousClock.now + .seconds(30)
                        while ContinuousClock.now < deadline {
                            let response = try await daemon.request("api/voice/heard")
                            let history = try JSONDecoder().decode(History.self, from: response.data)
                            if history.entries.contains(where: { $0.matchedName == "Steve" && $0.outcome == "pending" }) { return }
                            try await Task.sleep(for: .milliseconds(150))
                        }
                        throw URLError(.timedOut)
                    }
                    defer { confirmation.cancel() }
                    while polling { try await play(quiet) }
                    try await confirmation.value
                }
                try await play(pcm + Array(repeating: 0, count: (delay + 100) * 16))
            }
            return mic
        }
        var failure: Error?
        let run = Task {
            do { try await listener.run() } catch { failure = error }
        }
        defer { feed?.cancel(); run.cancel(); listener.close() }
        let startupDeadline = ContinuousClock.now + .seconds(35)
        while feed == nil {
            if let failure { throw failure }
            guard ContinuousClock.now < startupDeadline else { XCTFail("Microphone did not open"); return }
            try await Task.sleep(for: .milliseconds(100))
        }
        let directive = try JSONDecoder().decode(Directive.self, from: await daemon.directive(revision: nil, microphonePaused: false).data)
        let revision = directive.captureRevision ?? directive.revision
        try await feed?.value
        let deadline = ContinuousClock.now + .seconds(40)
        while daemon.pendingOnset(revision: revision) != nil {
            if let failure { throw failure }
            guard ContinuousClock.now < deadline else { XCTFail("Recognition did not complete"); return }
            try await Task.sleep(for: .milliseconds(100))
        }
        await daemon.drainSpeechFinishes()
        print("Desktop CPU capture: \(pcm.count) samples at 16 kHz, \(Double(pcm.count) / 16_000) seconds, held=\(pushToTalk)")
    }
}
