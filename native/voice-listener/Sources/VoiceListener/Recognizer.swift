import FluidAudio
import Foundation

struct TimedWord: Encodable {
    var text: String
    let startMs: Double
    let endMs: Double
}

struct Utterance: Encodable {
    let id = UUID().uuidString
    let backend = "fluidaudio"
    let text: String
    let words: [TimedWord]
    let capturedAt: Int64
}

struct Recognizer {
    let asr: AsrManager
    let ctc: CtcModels?

    init(directory: URL) async throws {
        // Vocabulary rescoring can emit transcript fragments at debug level.
        AppLogger.minimumLevel = .fault
        AppLogger.mirrorsToConsole = false
        asr = AsrManager()
        let models = try AsrModels.loadLocal(from: directory.appending(path: "parakeet-tdt-0.6b-v2-coreml"), version: .v2)
        try await asr.loadModels(models)
        let ctcDirectory = directory.appending(path: "parakeet-ctc-110m-coreml")
        // The CTC loader alone also succeeds on a partial install missing the
        // tokenizer. A roster cannot be primed from that directory.
        if (try? await CtcTokenizer.load(from: ctcDirectory)) != nil {
            ctc = try? await CtcModels.loadDirect(from: ctcDirectory)
        } else {
            ctc = nil
        }
    }

    func prime(_ roster: [String]) async throws -> VocabularyBoostingSession? {
        guard let ctc, !roster.isEmpty else { return nil }
        let terms = roster.map { CustomVocabularyTerm(text: $0) }
        return try await VocabularyBoostingSession(vocabulary: CustomVocabularyContext(terms: terms), ctcModels: ctc)
    }

    static func applyCorrection(_ name: String, to words: inout [TimedWord], in range: Range<Int>) {
        let spelling = name.split(whereSeparator: { $0.isWhitespace })
        guard !spelling.isEmpty else { return }
        if spelling.count == range.count {
            for (index, part) in zip(range, spelling) { words[index].text = String(part) }
            return
        }

        // CTC supplies only the corrected spelling. Estimate interior boundaries
        // evenly while retaining the exact decoder endpoints for the whole name.
        var start = words[range.lowerBound].startMs
        let end = words[range.upperBound - 1].endMs
        let duration = (end - start) / Double(spelling.count)
        let corrected = spelling.enumerated().map { index, part in
            let next = index == spelling.count - 1 ? end : min(end, start + duration)
            let word = TimedWord(text: String(part), startMs: start, endMs: next)
            start = next
            return word
        }
        words.replaceSubrange(range, with: corrected)
    }

    func transcribe(_ segment: Segment, boosting: VocabularyBoostingSession?) async throws -> Utterance? {
        var decoder = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(segment.samples, decoderState: &decoder)
        try Task.checkCancellation()
        let tokens = result.tokenTimings ?? []
        let boosted = await boosting?.rescore(text: result.text, tokenTimings: tokens, audioSamples: segment.samples)
        let text = (boosted?.text ?? result.text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        var words = buildWordTimings(from: tokens).map {
            TimedWord(text: $0.word, startMs: $0.startTime * 1000, endMs: $0.endTime * 1000)
        }
        // Each roster term can replace several decoder words. Consume spans from the
        // end so indices still refer to the original decoder output.
        for replacement in (boosted?.replacements ?? []).sorted(by: {
            ($0.wordRange?.lowerBound ?? -1) > ($1.wordRange?.lowerBound ?? -1)
        }) {
            guard replacement.shouldReplace, let range = replacement.wordRange, !range.isEmpty,
                  range.lowerBound >= 0, range.upperBound <= words.count, let name = replacement.replacementWord else { continue }
            Self.applyCorrection(name, to: &words, in: range)
        }
        return Utterance(text: text, words: words, capturedAt: segment.capturedAt)
    }
}
