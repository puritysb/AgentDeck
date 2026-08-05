#if os(macOS)
// DaemonPttVoice.swift — host push-to-talk for deck surfaces
//
// A Stream Deck / D200H key contributes only a button; the host contributes
// the microphone, the on-device recognizer and the speakers. Begin/end are
// explicit client commands bound to a target session — no wake word and no
// VAD auto-stop, which is why this is a sibling of DaemonVoiceAssistant
// rather than a mode of it: the assistant's silence-driven state machine
// would cut a held key short while the user pauses to think.
//
// Everything here is first-party framework API (AVFoundation + Speech), so
// the App Store build carries the feature — this is the Swift-daemon parity
// for the Node daemon's `voice` command (bridge/src/daemon-server.ts
// handleHostVoicePtt). All state is @MainActor: AVFoundation callbacks and
// the daemon's @DaemonActor callers both hop here explicitly.

import Foundation
import AVFoundation
import Speech

/**
 Receives tap buffers from AVFAudio's realtime thread and writes them to disk.

 Declared at file scope and deliberately NOT actor-isolated. A closure written
 inside an isolated method inherits that isolation *statically*, and when Swift
 has to hand it to a non-isolated API it compiles an executor assertion into the
 closure's entry. AVFAudio invokes an installTap block on its own realtime queue
 (`RealtimeMessenger.mServiceQueue`), so that assertion fired the instant
 recording started and took the whole app down with SIGTRAP in
 `dispatch_assert_queue`. Hopping to the actor *inside* the block does not help —
 the check runs before the first statement. Same family as the
 `@convention(c)` rule in CLAUDE.md: a callback that a foreign thread invokes
 must be built where no isolation can attach to it.
 */
private final class PttFileSink: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var failure: String?

    init(file: AVAudioFile) { self.file = file }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard let file else { return }
        do {
            try file.write(from: buffer)
        } catch {
            // Keep the first failure only: a broken file fails every buffer, and
            // 4096-frame buffers would flood the log at ~12 Hz.
            if failure == nil { failure = error.localizedDescription }
        }
    }

    /// Stop accepting buffers and release the file so it finalizes on disk.
    func close() -> String? {
        lock.lock(); defer { lock.unlock() }
        file = nil
        return failure
    }
}

/**
 Loudest sample in a captured buffer, 0…1.

 A silent capture and a failed recognizer are indistinguishable in the log
 otherwise — both end as "No speech detected" — so the level is worth one line
 before the file is deleted. Handles the two layouts an input node hands over:
 float32 (the usual) and int16.
 */
private func pttPeakAmplitude(_ buffer: AVAudioPCMBuffer) -> Float {
    let frames = Int(buffer.frameLength)
    guard frames > 0 else { return 0 }
    let channels = Int(buffer.format.channelCount)
    var peak: Float = 0
    if let float = buffer.floatChannelData {
        for ch in 0..<channels {
            let data = float[ch]
            for i in 0..<frames { peak = max(peak, abs(data[i])) }
        }
    } else if let int16 = buffer.int16ChannelData {
        for ch in 0..<channels {
            let data = int16[ch]
            for i in 0..<frames { peak = max(peak, abs(Float(data[i]) / 32768)) }
        }
    }
    return peak
}

/// Average level of a captured buffer, 0…1. Peak alone cannot tell a single
/// click apart from someone talking; RMS moving with the peak is what says the
/// buffer really holds speech.
private func pttRMSAmplitude(_ buffer: AVAudioPCMBuffer) -> Float {
    let frames = Int(buffer.frameLength)
    guard frames > 0 else { return 0 }
    let channels = Int(buffer.format.channelCount)
    var sum: Double = 0
    var counted = 0
    if let float = buffer.floatChannelData {
        for ch in 0..<channels {
            let data = float[ch]
            for i in 0..<frames { sum += Double(data[i] * data[i]) }
            counted += frames
        }
    } else if let int16 = buffer.int16ChannelData {
        for ch in 0..<channels {
            let data = int16[ch]
            for i in 0..<frames {
                let v = Double(data[i]) / 32768
                sum += v * v
            }
            counted += frames
        }
    }
    return counted > 0 ? Float((sum / Double(counted)).squareRoot()) : 0
}

/**
 Delete leftover captures matching `prefix` in the temp directory.

 `end()`/`cancel()` remove the file they created, but neither runs when the
 process dies mid-capture — a crash, a force-quit, a signal shutdown that times
 out — and dictation audio then sits in the container until the OS decides to
 clear its tmp, which is not a promise. Two such files were found after this
 path crashed. Call this where nothing of that prefix can be in flight: one
 capture at a time per owner, so at the start of a capture the only files left
 are dead ones.
 */
func sweepStaleVoiceCaptures(prefix: String) {
    let dir = FileManager.default.temporaryDirectory
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
    var removed = 0
    for name in names where name.hasPrefix(prefix) {
        if (try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))) != nil {
            removed += 1
        }
    }
    if removed > 0 {
        DaemonLogger.shared.debug("Voice", "Swept \(removed) stale capture(s) matching \(prefix)*")
    }
}

/// Installs the capture tap from a non-isolated context — see `PttFileSink` for
/// why this cannot be written inline inside `begin()`.
private func installPttTap(
    on input: AVAudioInputNode,
    format: AVAudioFormat,
    sink: PttFileSink
) {
    input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in
        sink.append(buffer)
    }
}

@MainActor
final class DaemonPttVoice {
    private var engine: AVAudioEngine?
    private var sink: PttFileSink?
    private var url: URL?
    private var maxTimer: Task<Void, Never>?
    private let synthesizer = AVSpeechSynthesizer()
    /// One PTT hold tops out well below this; the cap only bounds a lost
    /// key-up (client crash mid-hold).
    private let maxDuration: TimeInterval = 30

    var isRecording: Bool { engine != nil }

    /// Fired when maxDuration elapses with the key still held — the owner
    /// runs the same path as an explicit stop so the utterance is not lost.
    var onAutoStop: (() -> Void)?

    /// Start capturing. Returns nil on success, or a short stable error code
    /// ("mic_unauthorized" / "no_input" / "record_failed") the daemon can put
    /// on a voice_state error event.
    func begin() -> String? {
        guard engine == nil else { return "busy" }
        // Nothing of ours can be in flight here, so anything left is a corpse
        // from a crash or a force-quit — see sweepStaleVoiceCaptures.
        sweepStaleVoiceCaptures(prefix: "agentdeck-ptt-")
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
            return "mic_unauthorized"
        default:
            return "mic_unauthorized"
        }
        if SFSpeechRecognizer.authorizationStatus() == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { _ in }
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return "no_input" }

        // Record at the input's native format — SFSpeechURLRecognitionRequest
        // reads any PCM rate, so there is no reason to resample here (and a
        // file whose processing format differs from the tap's would make
        // every write throw).
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-ptt-\(UUID().uuidString).caf")
        let sink: PttFileSink
        do {
            sink = PttFileSink(file: try AVAudioFile(forWriting: url, settings: format.settings))
        } catch {
            DaemonLogger.shared.error("PTT: audio file create failed: \(error)")
            return "record_failed"
        }
        self.url = url
        self.sink = sink

        installPttTap(on: input, format: format, sink: sink)

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            cleanupFile()
            DaemonLogger.shared.error("PTT: engine start failed: \(error)")
            return "record_failed"
        }
        self.engine = engine

        maxTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            guard let self, self.isRecording else { return }
            self.onAutoStop?()
        }
        _ = maxDuration // documented cap; the sleep above is its one use site
        DaemonLogger.shared.debug("Voice", "PTT recording started")
        return nil
    }

    /// Stop and transcribe. Returns the recognized text, or nil when the
    /// capture was empty / unrecognizable (caller reports "no_speech").
    func end(preferredLocales: [Locale]) async -> String? {
        stopEngine()
        guard let url else { return nil }
        defer { cleanupFile() }
        let size = ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int) ?? 0
        guard size > 4096 else {
            DaemonLogger.shared.debug("Voice", "PTT capture too small (\(size)B)")
            return nil
        }
        logCaptureLevel(url)
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            DaemonLogger.shared.debug("Voice", "PTT: speech recognition not authorized")
            return nil
        }
        return await VoiceSpeechTranscriber.transcribe(url: url, preferredLocales: preferredLocales)
    }

    func cancel() {
        stopEngine()
        cleanupFile()
        DaemonLogger.shared.debug("Voice", "PTT recording cancelled")
    }

    /// Speak a session's reply through the host speakers. Unlike the voice
    /// assistant's `speak`, this has no state-machine guard — the arming in
    /// DaemonServer already decided this reply is wanted.
    func speakReply(_ text: String) {
        guard !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Locale.current.identifier)
            ?? AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    /// One line saying how much audio, at what level, actually reached the file.
    /// Cheap, and it is the difference between "your mic is muted" and "the
    /// recognizer could not make it out" — which the SFSpeech error alone hides.
    private func logCaptureLevel(_ url: URL) {
        guard let probe = try? AVAudioFile(forReading: url) else {
            DaemonLogger.shared.debug("Voice", "PTT capture unreadable for level probe")
            return
        }
        let rate = probe.processingFormat.sampleRate
        let seconds = rate > 0 ? Double(probe.length) / rate : 0
        let frames = AVAudioFrameCount(min(probe.length, Int64(rate * 30)))
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: probe.processingFormat, frameCapacity: frames),
              (try? probe.read(into: buffer)) != nil else {
            DaemonLogger.shared.debug("Voice", "PTT capture \(String(format: "%.1f", seconds))s — level unavailable")
            return
        }
        let peak = pttPeakAmplitude(buffer)
        let fmt = probe.processingFormat
        DaemonLogger.shared.debug(
            "Voice",
            "PTT capture \(String(format: "%.1f", seconds))s peak=\(String(format: "%.4f", peak))"
                + " rms=\(String(format: "%.4f", pttRMSAmplitude(buffer)))"
                + " fmt=\(Int(fmt.sampleRate))Hz/\(fmt.channelCount)ch/"
                + (fmt.commonFormat == .pcmFormatFloat32 ? "f32" : "\(fmt.commonFormat.rawValue)")
                + (peak < 0.01 ? " — effectively silent" : ""))
    }

    private func stopEngine() {
        maxTimer?.cancel()
        maxTimer = nil
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
        // Closing after the tap is removed guarantees no buffer is in flight,
        // and surfaces a write failure that was invisible on the audio thread.
        if let failure = sink?.close() {
            DaemonLogger.shared.debug("Voice", "PTT buffer write failed: \(failure)")
        }
        sink = nil
    }

    private func cleanupFile() {
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
        _ = sink?.close()
        sink = nil
    }
}
#endif
