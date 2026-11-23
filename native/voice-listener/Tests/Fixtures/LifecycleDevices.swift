// Compiled alongside the production Listener.swift for the subprocess lifecycle
// tests. The parent drives its real long poll and receives its real HTTP posts.
import Foundation

private func observe(_ event: String) {
    FileHandle.standardOutput.write(Data((event + "\n").utf8))
}

func permission() -> String { "granted" }

struct Device: Encodable {
    static func inputs() -> [Device] { [] }
}

final class Segment {
    let label: String
    init(_ label: String) { self.label = label }
    deinit { observe("released " + label) }
}

@MainActor final class Microphone {
    static var openings = 0
    let opening: Int
    let segments: AsyncStream<Segment>
    private let source: AsyncStream<Segment>.Continuation

    init(selection: String) throws {
        Self.openings += 1
        opening = Self.openings
        (segments, source) = AsyncStream.makeStream()
        observe("opened \(opening)")
        if selection == "two-segments" {
            source.yield(Segment("undecodable"))
            source.yield(Segment("next"))
        } else if selection == "two-utterances" {
            source.yield(Segment("first"))
            source.yield(Segment("second"))
        } else if opening == 1 {
            source.yield(Segment("in-flight"))
            source.yield(Segment("buffered"))
        } else {
            source.yield(Segment("fresh"))
            Recognizer.pendingDecode?.resume()
            Recognizer.pendingDecode = nil
        }
    }

    func stop() {
        observe("stopped \(opening)")
        source.finish()
    }

    deinit { observe("released microphone \(opening)") }
}

struct FixtureUtterance: Encodable { let text: String }

@MainActor struct Recognizer {
    static var pendingDecode: CheckedContinuation<Void, Never>?
    let ctc: Bool? = nil

    init(directory: URL) async throws {}
    func prime(_ roster: [String]) async throws -> Bool? {
        let names = try JSONEncoder().encode(roster)
        observe("prime " + String(decoding: names, as: UTF8.self))
        return nil
    }

    func transcribe(_ segment: Segment, boosting: Bool?) async throws -> FixtureUtterance? {
        observe("decode " + segment.label)
        if segment.label == "undecodable" { throw CocoaError(.coderReadCorrupt) }
        if segment.label == "in-flight" {
            // Model inference can complete after its task is cancelled. Return
            // the old result only once the second capture is already active.
            await withCheckedContinuation { Self.pendingDecode = $0 }
        }
        return FixtureUtterance(text: segment.label)
    }
}
