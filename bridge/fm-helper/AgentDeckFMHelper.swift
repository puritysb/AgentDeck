import Foundation
import AVFoundation
import Speech
#if canImport(FoundationModels)
import FoundationModels
#endif

struct HelperRequest: Decodable {
    let id: Int
    let type: String?
    let prompt: String?
    let instructions: String?
    let temperature: Double?
    /// `transcribe`: absolute path to a WAV file the daemon already wrote.
    let wav: String?
    /// BCP-47 locale hint, e.g. "ko-KR". Falls back to the current locale then en-US.
    let locale: String?
    /// `speak`: text to synthesize, with optional voice/rate overrides.
    let text: String?
    let voice: String?
    let rate: Double?
    /// `record`: hard cap on capture length; the reply arrives at stop or here.
    let maxMs: Int?
}

@main
struct AgentDeckFMHelper {
    static func main() async {
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                await handle(line)
            }
        } catch {
            write(["id": -1, "error": "stdin_error", "reason": String(describing: error)])
        }
    }

    private static func handle(_ line: String) async {
        guard let data = line.data(using: .utf8),
              let request = try? JSONDecoder().decode(HelperRequest.self, from: data) else {
            write(["id": -1, "error": "bad_request", "reason": "invalid JSON line"])
            return
        }

        if request.type == "health" {
            write(healthResponse(id: request.id))
            return
        }

        if request.type == "transcribe" {
            dispatchLongWork { await handleTranscribe(request) }
            return
        }

        if request.type == "speak" {
            dispatchLongWork { await handleSpeak(request) }
            return
        }

        if request.type == "synthesize" {
            dispatchLongWork { await handleSynthesize(request) }
            return
        }

        if request.type == "record" {
            // Recording spans an unknown PTT hold, and the stop arrives as a
            // later stdin line — so this must not block the read loop.
            Task.detached { await handleRecord(request) }
            return
        }

        if request.type == "record_stop" || request.type == "record_cancel" {
            let stopped = activeRecording.finish(
                cancelled: request.type == "record_cancel", reason: "stopped")
            write(["id": request.id, "stopped": stopped])
            return
        }

        dispatchLongWork { await handleGenerate(request) }
    }

    /// Long work must never run on the stdin read loop.
    ///
    /// Measured 2026-08-08 on a D200H: one in-flight `generate` kept the loop
    /// busy for 25 s, so the `record_stop` queued behind it was not even READ
    /// until it finished. The push-to-talk capture ran to its 30 s cap and
    /// transcribed 30 s of mostly silence, which reached the user as "voice
    /// does nothing". `record` was already detached for exactly this reason;
    /// every other slow request needed the same treatment.
    ///
    /// The work stays serialized, in read order, exactly as it was when the
    /// loop ran it — only the READING of the next line is freed, which is all a
    /// control line like `record_stop` needs.
    private static func dispatchLongWork(_ body: @escaping @Sendable () async -> Void) {
        workChain.enqueue(body)
    }

    private static func handleGenerate(_ request: HelperRequest) async {
        guard let prompt = request.prompt, !prompt.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing prompt"])
            return
        }

#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                write([
                    "id": request.id,
                    "error": "unavailable",
                    "reason": unavailableReason(),
                ])
                return
            }

            do {
                let session = LanguageModelSession(
                    instructions: request.instructions ?? "You are an exacting code evaluator. Reply with strict JSON only."
                )
                let options = GenerationOptions(temperature: request.temperature ?? 0)
                let response = try await session.respond(to: prompt, options: options)
                write(["id": request.id, "text": response.content])
            } catch {
                write(["id": request.id, "error": "session_error", "reason": String(describing: error)])
            }
        } else {
            write(["id": request.id, "error": "unavailable", "reason": "macOS 26 or later required"])
        }
#else
        write(["id": request.id, "error": "unavailable", "reason": "FoundationModels framework not present"])
#endif
    }

    // MARK: - Speech to text

    /// On-device transcription of a WAV the daemon already captured (from the
    /// host mic or streamed off a board). `requiresOnDeviceRecognition` keeps
    /// audio local — the captured speech routinely contains project and code
    /// names that must not reach Apple's servers. Mirrors the Swift daemon's
    /// `VoiceSpeechTranscriber` so both daemons transcribe identically.
    private static func handleTranscribe(_ request: HelperRequest) async {
        guard let path = request.wav, !path.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing wav path"])
            return
        }
        guard FileManager.default.fileExists(atPath: path) else {
            write(["id": request.id, "error": "bad_request", "reason": "wav not found: \(path)"])
            return
        }

        let status = await ensureSpeechAuthorization()
        guard status == .authorized else {
            write([
                "id": request.id,
                "error": "unauthorized",
                "reason": "speech recognition not authorized (\(status.rawValue)) — grant it in System Settings › Privacy & Security › Speech Recognition",
            ])
            return
        }

        var locales: [Locale] = []
        if let tag = request.locale, !tag.isEmpty { locales.append(Locale(identifier: tag)) }
        locales.append(Locale.current)
        locales.append(Locale(identifier: "en-US"))

        guard let recognizer = locales.lazy.compactMap({ SFSpeechRecognizer(locale: $0) }).first(where: { $0.isAvailable }) else {
            write([
                "id": request.id,
                "error": "unavailable",
                "reason": "no available on-device recognizer — the dictation model may still be downloading",
            ])
            return
        }

        let speechRequest = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
        speechRequest.shouldReportPartialResults = false
        speechRequest.requiresOnDeviceRecognition = true
        speechRequest.taskHint = .dictation

        let result: [String: Any] = await withCheckedContinuation { continuation in
            let box = ResumeOnce(continuation)
            _ = recognizer.recognitionTask(with: speechRequest) { result, error in
                if let error {
                    box.resume(["id": request.id, "error": "speech_error", "reason": String(describing: error)])
                    return
                }
                guard let result, result.isFinal else { return }
                let text = result.bestTranscription.formattedString
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                box.resume(["id": request.id, "text": text])
            }
        }
        write(result)
    }

    private static func ensureSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            let box = ResumeOnce(continuation)
            SFSpeechRecognizer.requestAuthorization { box.resume($0) }
        }
    }

    // MARK: - Microphone capture

    private static let activeRecording = RecordingBox()

    /// Capture the host microphone into a 16 kHz mono PCM16 WAV. This is the
    /// piece that retired the old Stream Deck Voice dial: capture used to mean
    /// borrowing iTerm2's mic grant via AppleScript plus Homebrew `sox`. Here
    /// the daemon's own bundled helper records, so the TCC grant belongs to
    /// this process tree and there is nothing to install.
    ///
    /// The reply is deferred: it is written when `record_stop`/`record_cancel`
    /// arrives on stdin or `maxMs` elapses, whichever comes first.
    private static func handleRecord(_ request: HelperRequest) async {
        guard let outPath = request.wav, !outPath.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing wav output path"])
            return
        }
        // Reserve before the slow setup below, so a stop arriving mid-setup has
        // somewhere to land (see RecordingBox.pendingStop).
        guard activeRecording.reserve(requestId: request.id) else {
            write(["id": request.id, "error": "busy", "reason": "a recording is already in progress"])
            return
        }
        let granted = await ensureMicAuthorization()
        guard granted else {
            activeRecording.release()
            write([
                "id": request.id,
                "error": "unauthorized",
                "reason": "microphone access not granted — grant it in System Settings › Privacy & Security › Microphone",
            ])
            return
        }
        let sampleRate = 16000.0
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                            sampleRate: sampleRate,
                                            channels: 1,
                                            interleaved: true) else {
            activeRecording.release()
            write(["id": request.id, "error": "record_failed", "reason": "output format unavailable"])
            return
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, inFormat.channelCount > 0 else {
            activeRecording.release()
            write(["id": request.id, "error": "record_failed", "reason": "no audio input device"])
            return
        }
        let sink = PCMSink()
        if let stopped = activeRecording.begin(engine: engine, sink: sink) {
            // The stop beat the setup. Answer it as the capture it was meant
            // for instead of starting an engine nobody is waiting on.
            if stopped.cancelled {
                write(["id": request.id, "cancelled": true])
            } else {
                write(["id": request.id, "error": "record_failed", "reason": "stopped before capture started"])
            }
            return
        }
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { buffer, _ in
            sink.append(buffer, to: outFormat)
        }
        do {
            try engine.start()
        } catch {
            activeRecording.clear()
            input.removeTap(onBus: 0)
            write(["id": request.id, "error": "record_failed", "reason": String(describing: error)])
            return
        }

        let maxMs = max(1000, min(request.maxMs ?? 30_000, 120_000))
        let outcome = await activeRecording.wait(maxMs: maxMs)
        engine.stop()
        input.removeTap(onBus: 0)

        if outcome.cancelled {
            write(["id": request.id, "cancelled": true])
            return
        }
        if let failure = sink.failure {
            write(["id": request.id, "error": "record_failed", "reason": failure])
            return
        }
        let pcm = sink.pcm
        guard pcm.count >= 2 else {
            write(["id": request.id, "error": "record_failed", "reason": "no audio captured"])
            return
        }
        do {
            try wavData(pcm: pcm, sampleRate: Int(sampleRate)).write(to: URL(fileURLWithPath: outPath))
        } catch {
            write(["id": request.id, "error": "record_failed", "reason": String(describing: error)])
            return
        }
        write([
            "id": request.id,
            "wav": outPath,
            "sampleRate": Int(sampleRate),
            "samples": pcm.count / 2,
            "durationMs": Int(Double(pcm.count / 2) / sampleRate * 1000.0),
            "stopReason": outcome.reason,
        ])
    }

    private static func ensureMicAuthorization() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                let box = ResumeOnce(continuation)
                AVCaptureDevice.requestAccess(for: .audio) { box.resume($0) }
            }
        default: return false
        }
    }

    // MARK: - Text to speech

    /// Speak a reply through the host's audio output. Kept in the same helper
    /// so the voice round trip needs exactly one bundled binary.
    private static func handleSpeak(_ request: HelperRequest) async {
        guard let text = request.text, !text.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing text"])
            return
        }
        let utterance = AVSpeechUtterance(string: text)
        if let voiceId = request.voice, let v = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = v
        } else if let tag = request.locale, let v = AVSpeechSynthesisVoice(language: tag) {
            utterance.voice = v
        }
        if let rate = request.rate { utterance.rate = Float(rate) }

        let synthesizer = AVSpeechSynthesizer()
        let delegate = SpeakDelegate()
        synthesizer.delegate = delegate
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            delegate.onFinish = ResumeOnce(continuation)
            synthesizer.speak(utterance)
        }
        write(["id": request.id, "spoken": true])
    }

    /// Synthesize to a WAV file instead of the host's speakers, so the daemon
    /// can stream the audio somewhere else — a battery-powered board holding
    /// the only speaker the user is near. Fixed at 16 kHz mono PCM16: that is
    /// what the boards' I2S amplifiers are configured for and what keeps a
    /// spoken reply inside a WiFi budget an ESP32 can actually drain.
    private static func handleSynthesize(_ request: HelperRequest) async {
        guard let text = request.text, !text.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing text"])
            return
        }
        guard let outPath = request.wav, !outPath.isEmpty else {
            write(["id": request.id, "error": "bad_request", "reason": "missing wav output path"])
            return
        }
        let sampleRate = 16000.0
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                            sampleRate: sampleRate,
                                            channels: 1,
                                            interleaved: true) else {
            write(["id": request.id, "error": "synthesis_failed", "reason": "output format unavailable"])
            return
        }

        let utterance = AVSpeechUtterance(string: text)
        if let voiceId = request.voice, let v = AVSpeechSynthesisVoice(identifier: voiceId) {
            utterance.voice = v
        } else if let tag = request.locale, let v = AVSpeechSynthesisVoice(language: tag) {
            utterance.voice = v
        }
        if let rate = request.rate { utterance.rate = Float(rate) }

        // The write callback is not documented to run on any particular queue,
        // and it appends to shared state, so the accumulator owns a lock.
        let sink = PCMSink()
        let synthesizer = AVSpeechSynthesizer()
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let done = ResumeOnce(continuation)
            synthesizer.write(utterance) { buffer in
                guard let input = buffer as? AVAudioPCMBuffer else { return }
                // A zero-length buffer is the documented end-of-synthesis
                // signal; without it this call never completes.
                if input.frameLength == 0 {
                    done.resume(())
                    return
                }
                sink.append(input, to: outFormat)
            }
        }

        if let failure = sink.failure {
            write(["id": request.id, "error": "synthesis_failed", "reason": failure])
            return
        }
        let pcm = sink.pcm
        guard !pcm.isEmpty else {
            write(["id": request.id, "error": "synthesis_failed", "reason": "no audio produced"])
            return
        }
        do {
            try wavData(pcm: pcm, sampleRate: Int(sampleRate)).write(to: URL(fileURLWithPath: outPath))
        } catch {
            write(["id": request.id, "error": "synthesis_failed", "reason": String(describing: error)])
            return
        }
        write([
            "id": request.id,
            "wav": outPath,
            "sampleRate": Int(sampleRate),
            "samples": pcm.count / 2,
            "durationMs": Int(Double(pcm.count / 2) / sampleRate * 1000.0),
        ])
    }

    /// Canonical 44-byte RIFF header + samples. Kept here rather than shelling
    /// out so the helper stays the single bundled binary.
    private static func wavData(pcm: Data, sampleRate: Int) -> Data {
        var out = Data()
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { out.append(contentsOf: $0) } }
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { out.append(contentsOf: $0) } }
        out.append(contentsOf: Array("RIFF".utf8)); u32(36 + pcm.count)
        out.append(contentsOf: Array("WAVE".utf8))
        out.append(contentsOf: Array("fmt ".utf8)); u32(16)
        u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
        out.append(contentsOf: Array("data".utf8)); u32(pcm.count)
        out.append(pcm)
        return out
    }

    private static func healthResponse(id: Int) -> [String: Any] {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability {
                return ["id": id, "status": "ready"]
            }
            return ["id": id, "status": "unavailable", "reason": unavailableReason()]
        }
        return ["id": id, "status": "unavailable", "reason": "macOS 26 or later required"]
#else
        return ["id": id, "status": "unavailable", "reason": "FoundationModels framework not present"]
#endif
    }

    private static func unavailableReason() -> String {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return "available"
            case .unavailable(let reason):
                return "unavailable: \(reason)"
            @unknown default:
                return "unavailable: unknown state"
            }
        }
        return "macOS 26 or later required"
#else
        return "FoundationModels framework not present"
#endif
    }

    /// stdout is shared by the serial request loop and the detached record
    /// task; the lock keeps two replies from interleaving inside one line.
    private static let writeLock = NSLock()

    /// See `dispatchLongWork`.
    private static let workChain = WorkChain()

    private static func write(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else {
            return
        }
        writeLock.lock()
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
        writeLock.unlock()
    }
}

/// Serializes the helper's slow requests (LLM generation, speech recognition,
/// TTS) off the stdin read loop, while the loop stays free to read control
/// lines such as `record_stop`.
///
/// A chain rather than an actor: actor executors guarantee mutual exclusion but
/// NOT FIFO, and `Task.detached` does not even preserve the order in which the
/// tasks were created — so two queued `speak` requests could have been voiced
/// out of order. Linking each unit of work to its predecessor's completion
/// keeps the read order the loop used to provide. The enqueue itself is O(1)
/// and happens on the read loop, which is the only mutator.
private final class WorkChain: @unchecked Sendable {
    private let lock = NSLock()
    private var tail: Task<Void, Never> = Task {}

    func enqueue(_ body: @escaping @Sendable () async -> Void) {
        lock.lock(); defer { lock.unlock() }
        let previous = tail
        tail = Task { await previous.value; await body() }
    }
}

/// State for the single in-flight microphone capture. One at a time by design:
/// the daemon models push-to-talk, and two overlapping engine taps on the same
/// input device produce garbage anyway.
private final class RecordingBox: @unchecked Sendable {
    struct Outcome { let cancelled: Bool; let reason: String }

    private let lock = NSLock()
    private var requestId: Int?
    private var engine: AVAudioEngine?
    private var sink: PCMSink?
    private var continuation: ResumeOnce<Outcome>?
    /// Bumped per recording so a stale max-duration timer from a finished
    /// capture cannot terminate the one that started after it.
    private var generation = 0
    /// A stop that arrived while the capture was still being set up.
    ///
    /// `handleRecord` reserves the slot, then spends real time on mic
    /// authorization, format negotiation and engine construction before the
    /// tap is live. Hold-to-talk routinely beats that: a short hold puts
    /// `record_stop` on stdin while `requestId` was set but no continuation
    /// exists yet. Without this latch the stop was dropped, the capture ran to
    /// its 30s cap, and 30s of room noise was transcribed and injected into
    /// the user's session — worst of all for the sub-250ms tap, whose whole
    /// meaning is "never mind".
    private var pendingStop: Outcome?

    /// Claim the slot before the slow setup. Returns false when a capture is
    /// already in flight.
    func reserve(requestId: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard self.requestId == nil else { return false }
        self.requestId = requestId
        self.pendingStop = nil
        generation += 1
        return true
    }

    /// Arm the reserved slot with the live engine. Returns the stop that
    /// arrived during setup, if any — the caller must then not start at all.
    func begin(engine: AVAudioEngine, sink: PCMSink) -> Outcome? {
        lock.lock(); defer { lock.unlock() }
        if let stop = pendingStop {
            pendingStop = nil
            requestId = nil
            return stop
        }
        self.engine = engine
        self.sink = sink
        return nil
    }

    func wait(maxMs: Int) async -> Outcome {
        let gen = currentGeneration()
        let outcome: Outcome = await withCheckedContinuation { cont in
            arm(ResumeOnce(cont))
            DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(maxMs)) { [weak self] in
                guard let self, self.isLive(generation: gen) else { return }
                _ = self.finish(cancelled: false, reason: "max_duration")
            }
        }
        return outcome
    }

    private func currentGeneration() -> Int {
        lock.lock(); defer { lock.unlock() }
        return generation
    }

    private func arm(_ box: ResumeOnce<Outcome>) {
        lock.lock(); defer { lock.unlock() }
        continuation = box
    }

    private func isLive(generation gen: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return generation == gen && requestId != nil
    }

    /// Returns false when no recording is active — the stop raced a max-length
    /// finish or arrived with nothing running.
    func finish(cancelled: Bool, reason: String) -> Bool {
        lock.lock()
        let cont = continuation
        let active = requestId != nil
        let outcome = Outcome(cancelled: cancelled, reason: cancelled ? "cancelled" : reason)
        if active && cont == nil {
            // Reserved but not yet armed: latch the stop for `begin` rather
            // than dropping it on the floor. Keep the reservation so the
            // in-flight setup still owns the slot.
            pendingStop = outcome
            lock.unlock()
            return true
        }
        continuation = nil
        requestId = nil
        engine = nil
        sink = nil
        lock.unlock()
        guard active, let cont else { return false }
        cont.resume(outcome)
        return true
    }

    /// Drop a reservation whose setup failed before the engine existed.
    func release() {
        lock.lock(); defer { lock.unlock() }
        requestId = nil
        pendingStop = nil
    }

    func clear() {
        _ = finish(cancelled: true, reason: "cleared")
    }
}

/// One-shot continuation guard: speech and synthesis callbacks can fire more
/// than once, and resuming a continuation twice traps.
private final class ResumeOnce<T>: @unchecked Sendable {
    private var continuation: CheckedContinuation<T, Never>?
    private let lock = NSLock()

    init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    func resume(_ value: T) {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume(returning: value)
    }
}

/// Accumulates synthesized audio, resampling each delivered buffer to the
/// target format. The converter is built from the first buffer because the
/// synthesizer picks its own rate and sample type per voice.
private final class PCMSink: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data()
    private var converter: AVAudioConverter?
    private var error: String?

    var pcm: Data {
        lock.lock(); defer { lock.unlock() }
        return buffer
    }

    var failure: String? {
        lock.lock(); defer { lock.unlock() }
        return error
    }

    func append(_ input: AVAudioPCMBuffer, to outFormat: AVAudioFormat) {
        lock.lock(); defer { lock.unlock() }
        if error != nil { return }
        if converter == nil {
            converter = AVAudioConverter(from: input.format, to: outFormat)
            if converter == nil {
                error = "no converter from \(input.format) to \(outFormat)"
                return
            }
        }
        guard let converter else { return }
        // Round up, and leave slack: the converter may emit slightly more than
        // the naive ratio when it flushes filter state.
        let ratio = outFormat.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else {
            error = "output buffer allocation failed"
            return
        }
        var supplied = false
        var convertError: NSError?
        let status = converter.convert(to: output, error: &convertError) { _, outStatus in
            if supplied {
                outStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            outStatus.pointee = .haveData
            return input
        }
        if status == .error {
            error = convertError?.localizedDescription ?? "conversion failed"
            return
        }
        guard let channel = output.int16ChannelData, output.frameLength > 0 else { return }
        let count = Int(output.frameLength)
        channel[0].withMemoryRebound(to: UInt8.self, capacity: count * 2) { raw in
            buffer.append(raw, count: count * 2)
        }
    }
}

private final class SpeakDelegate: NSObject, AVSpeechSynthesizerDelegate {
    var onFinish: ResumeOnce<Void>?

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        onFinish?.resume(())
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        onFinish?.resume(())
    }
}
