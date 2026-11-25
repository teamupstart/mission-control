import AVFoundation
import XCTest
@testable import VoiceListener

final class SpokenCancelTests: XCTestCase {
    // Opt-in loopback probe driven by test/voice-native-cancel.test.ts.
    func testRecordedCancel() async throws {
        guard let path = ProcessInfo.processInfo.environment["MISSION_CANCEL_TEST_WAV"] else {
            throw XCTSkip("Requires the isolated daemon and a 16 kHz mono Cancel recording")
        }
        let daemon = Daemon()
        let recognizer = try await Recognizer(directory: daemon.directory)
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: buffer)
        let pcm = Array(UnsafeBufferPointer(start: buffer.floatChannelData![0], count: Int(buffer.frameLength)))
        let hello = Hello(modelLoaded: true, primingAvailable: false, microphone: "granted")
        let welcome = try await daemon.request("voice/listener/hello", body: JSONEncoder().encode(hello))
        try daemon.applyCaptureChallenge(welcome.http.value(forHTTPHeaderField: "x-voice-capture-lock"))
        let poll = try await daemon.directive(revision: nil, microphonePaused: true)
        let directive = try JSONDecoder().decode(Directive.self, from: poll.data)
        let boosting = try await recognizer.prime(directive.roster)
        func hostNs() -> Int64 { Int64(AVAudioTime.seconds(forHostTime: mach_absolute_time()) * 1e9) }
        let start = hostNs()
        let addressed = Utterance(text: "Will check the build", words: [], capturedAt: Int64(Date().timeIntervalSince1970 * 1000))
        _ = try await daemon.postUtterance(revision: directive.revision, capture: (start/1000, start/1000, start/1_000_000 + 1),
                                            body: JSONEncoder().encode(addressed))
        try await Task.sleep(for: .milliseconds(850))
        let segmenter = try SpeechSegmenter()
        let speech = pcm + Array(repeating: Float.zero, count: 16_000 * 6)
        for offset in stride(from: 0, to: speech.count, by: 320) {
            try await Task.sleep(for: .milliseconds(20))
            let frame = Array(speech[offset..<min(offset + 320, speech.count)])
            let segments = segmenter.consume(frame, endNs: hostNs()) { onset in
                daemon.startSpeech(onset, revision: directive.revision)
            }
            for segment in segments {
                let segmented = hostNs()
                let result = try await recognizer.transcribe(segment, boosting: boosting)
                let words = try XCTUnwrap(result)
                let reply = try await daemon.postUtterance(revision: directive.revision,
                    capture: (segment.startedAtHostUs, segment.speechStartHostUs, segment.endedAt),
                    body: JSONEncoder().encode(words))
                XCTAssertTrue(try JSONDecoder().decode(Daemon.Acknowledgement.self, from: reply.data).accepted)
                print("onset=\((segment.speechStartHostUs-start/1000)/1000)ms segmented=\((segmented-start)/1_000_000)ms routed=\((hostNs()-start)/1_000_000)ms transcript=\(words.text)")
                return
            }
        }
        XCTFail("Recording produced no segment")
    }
}
