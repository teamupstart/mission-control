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

    static func applyAddressCorrection(_ name: String, in range: Range<Int>, roster: [String],
                                       text: inout String, words: inout [TimedWord]) {
        guard range.lowerBound == 0, !range.isEmpty, range.upperBound <= words.count else { return }
        // Let the router interpret a standalone Cancel, including its original quotation marks.
        // A roster suggestion for that one word would erase the control before routing.
        guard text.trimmingCharacters(in: .punctuationCharacters.union(.whitespacesAndNewlines)).lowercased() != "cancel" else { return }
        let tokens = text.split(maxSplits: range.count, whereSeparator: { $0.isWhitespace }).prefix(range.count)
        guard tokens.count == range.count, let first = tokens.first, let last = tokens.last,
              let start = first.firstIndex(where: { $0.isLetter || $0.isNumber }),
              let end = last.lastIndex(where: { $0.isLetter || $0.isNumber }), start <= end else { return }
        // Match the timed address against the original text. A comma inside the span ends the address.
        let address = text[start...end]
        guard address.allSatisfy({ $0.isLetter || $0.isNumber || $0.isWhitespace || "'’-".contains($0) }) else { return }
        let source = words[range].map { $0.text.trimmingCharacters(in: .punctuationCharacters).lowercased() }
        guard address.split(whereSeparator: { $0.isWhitespace }).map({ $0.lowercased() }) == source else { return }
        var spelling = name.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !spelling.isEmpty else { return }
        let remainder = text[start...]
        let comma = remainder.firstIndex(of: ",")
        let leading = remainder[..<(comma ?? remainder.endIndex)].split(whereSeparator: { $0.isWhitespace })
        let endsAtComma = comma.map { text[text.index(after: end)..<$0].allSatisfy({ $0.isWhitespace }) } ?? false
        // A comma beyond the proposed name can punctuate the message. A comma within
        // its word count can delimit an address for which CTC matched only a prefix.
        if !endsAtComma && (range.count > 1 || (comma != nil && leading.count <= spelling.count)) { return }
        // The decoder may already identify the recipient, even if CTC proposes
        // replacing only the first word of a longer exact address.
        let hasExactAddress = roster.contains { term in
            let parts = term.split(whereSeparator: { $0.isWhitespace })
            guard !parts.isEmpty, endsAtComma ? leading.count == parts.count : leading.count >= parts.count else { return false }
            let decoded = leading.prefix(parts.count).joined(separator: " ").trimmingCharacters(in: .punctuationCharacters)
            return decoded.lowercased() == parts.joined(separator: " ").trimmingCharacters(in: .punctuationCharacters).lowercased()
        }
        guard !hasExactAddress else { return }

        spelling[0] = String(first[..<start]) + spelling[0]
        spelling[spelling.count - 1] += last[last.index(after: end)...]
        text.replaceSubrange(start...end, with: name)
        if spelling.count == range.count {
            for (index, part) in zip(range, spelling) { words[index].text = part }
            return
        }

        // CTC supplies only the corrected spelling. Estimate interior boundaries
        // evenly while retaining the exact decoder endpoints for the whole name.
        var startMs = words[range.lowerBound].startMs
        let endMs = words[range.upperBound - 1].endMs
        let duration = (endMs - startMs) / Double(spelling.count)
        let corrected = spelling.enumerated().map { index, part in
            let next = index == spelling.count - 1 ? endMs : min(endMs, startMs + duration)
            let word = TimedWord(text: part, startMs: startMs, endMs: next)
            startMs = next
            return word
        }
        words.replaceSubrange(range, with: corrected)
    }

    func transcribe(_ segment: Segment, boosting: VocabularyBoostingSession?,
                    onAddressSuggestion: ((String, Range<Int>) -> Void)? = nil) async throws -> Utterance? {
        var decoder = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(segment.samples, decoderState: &decoder)
        try Task.checkCancellation()
        let tokens = result.tokenTimings ?? []
        let boosted = await boosting?.rescore(text: result.text, tokenTimings: tokens, audioSamples: segment.samples)
        var text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        var words = buildWordTimings(from: tokens).map {
            TimedWord(text: $0.word, startMs: $0.startTime * 1000, endMs: $0.endTime * 1000)
        }
        if let boosting, let address = boosted?.replacements.first(where: { $0.shouldReplace && $0.wordRange?.lowerBound == 0 }),
           let range = address.wordRange, let name = address.replacementWord {
            onAddressSuggestion?(name, range)
            Self.applyAddressCorrection(name, in: range, roster: boosting.vocabulary.terms.map(\.text), text: &text, words: &words)
        }
        return Utterance(text: text, words: words, capturedAt: segment.capturedAt)
    }
}
