import AVFoundation
import CoreAudio
import Foundation

let sampleRate = 24_000.0
let channels: AVAudioChannelCount = 1
let bytesPerFrame = 2
let readSize = 4_800
let startupPrebufferBytes = 72_000 // 1.5 seconds at 24 kHz mono PCM16
let maximumPrebufferBytes = readSize * 24 // 2.4 seconds adaptive ceiling
let ringCapacityBytes = Int(sampleRate) * bytesPerFrame * 20
let commandArguments = CommandLine.arguments
let telephoneEQEnabled = commandArguments.contains("--telephone-eq")
let masterGainDb: Double = {
    guard let flagIndex = commandArguments.firstIndex(of: "--master-gain-db"), flagIndex + 1 < commandArguments.count else { return 0 }
    return Double(commandArguments[flagIndex + 1]) ?? 0
}()
let masterGainLinear = pow(10.0, masterGainDb / 20.0)
let requestedOutputDevice: String? = {
    guard let flagIndex = commandArguments.firstIndex(of: "--output-device"), flagIndex + 1 < commandArguments.count else { return nil }
    return commandArguments[flagIndex + 1]
}()

func playerLog(_ message: String) {
    fputs("PCM player \(Date().timeIntervalSince1970) \(message)\n", stderr)
}

guard let format = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: sampleRate,
    channels: channels,
    interleaved: true
) else {
    fputs("unable to create 24 kHz PCM16 playback format\n", stderr)
    exit(1)
}

final class Biquad {
    private let b0: Double
    private let b1: Double
    private let b2: Double
    private let a1: Double
    private let a2: Double
    private var z1 = 0.0
    private var z2 = 0.0

    init(type: String, frequency: Double, sampleRate: Double, q: Double = 0.7071) {
        let omega = 2.0 * Double.pi * frequency / sampleRate
        let cosine = cos(omega)
        let sine = sin(omega)
        let alpha = sine / (2.0 * q)
        let a0 = 1.0 + alpha
        if type == "highPass" {
            b0 = ((1.0 + cosine) / 2.0) / a0
            b1 = (-(1.0 + cosine)) / a0
            b2 = ((1.0 + cosine) / 2.0) / a0
        } else {
            b0 = ((1.0 - cosine) / 2.0) / a0
            b1 = (1.0 - cosine) / a0
            b2 = ((1.0 - cosine) / 2.0) / a0
        }
        a1 = (-2.0 * cosine) / a0
        a2 = (1.0 - alpha) / a0
    }

    func process(_ input: Double) -> Double {
        let output = b0 * input + z1
        z1 = b1 * input - a1 * output + z2
        z2 = b2 * input - a2 * output
        return output
    }
}

final class TelephoneBandPass {
    private let highPass = Biquad(type: "highPass", frequency: 300, sampleRate: sampleRate)
    private let lowPass = Biquad(type: "lowPass", frequency: 3_400, sampleRate: sampleRate)

    func process(_ data: Data) -> Data {
        var output = Data(count: data.count)
        var clampCount = 0
        for offset in stride(from: 0, to: data.count, by: bytesPerFrame) {
            let input = Double(data.withUnsafeBytes { raw in raw.load(fromByteOffset: offset, as: Int16.self).littleEndian })
            let filtered = lowPass.process(highPass.process(input / 32768.0)) * 32768.0
            let rounded = Int(filtered.rounded())
            let sample = max(-32768, min(32767, rounded))
            if sample != rounded { clampCount += 1 }
            output.withUnsafeMutableBytes { raw in
                raw.storeBytes(of: Int16(sample).littleEndian, toByteOffset: offset, as: Int16.self)
            }
        }
        if clampCount > 0 {
            playerLog("telephone EQ clamp samples=\(clampCount)")
        }
        return output
    }
}

func applyMasterGain(_ data: Data) -> Data {
    guard masterGainDb != 0 else { return data }
    var output = Data(count: data.count)
    var clampCount = 0
    for offset in stride(from: 0, to: data.count, by: bytesPerFrame) {
        let input = Double(data.withUnsafeBytes { raw in raw.load(fromByteOffset: offset, as: Int16.self).littleEndian })
        let scaled = Int((input * masterGainLinear).rounded())
        let sample = max(-32768, min(32767, scaled))
        if sample != scaled { clampCount += 1 }
        output.withUnsafeMutableBytes { raw in
            raw.storeBytes(of: Int16(sample).littleEndian, toByteOffset: offset, as: Int16.self)
        }
    }
    if clampCount > 0 {
        playerLog("master gain clamp samples=\(clampCount) gainDb=\(masterGainDb)")
    }
    return output
}

let telephoneFilter = telephoneEQEnabled ? TelephoneBandPass() : nil
if telephoneEQEnabled {
    playerLog("telephone EQ enabled highPassHz=300 lowPassHz=3400")
}
if masterGainDb != 0 {
    playerLog("master gain enabled gainDb=\(masterGainDb)")
}

final class PCMByteRing {
    private var storage: [UInt8]
    private var readIndex = 0
    private var writeIndex = 0
    private var used = 0
    private let lock = NSLock()
    private var underflowed = false
    private(set) var underrunCount = 0
    private(set) var underrunBytes = 0

    init(capacity: Int) {
        storage = [UInt8](repeating: 0, count: capacity)
    }

    private func checkInvariants(_ stage: String) {
        let capacity = storage.count
        let aligned = readIndex % bytesPerFrame == 0
            && writeIndex % bytesPerFrame == 0
            && used % bytesPerFrame == 0
            && capacity % bytesPerFrame == 0
        let valid = readIndex >= 0 && readIndex < capacity
            && writeIndex >= 0 && writeIndex < capacity
            && used >= 0 && used <= capacity
        if !aligned || !valid {
            playerLog("PCM invariant violation stage=\(stage) readIndex=\(readIndex) writeIndex=\(writeIndex) used=\(used) capacity=\(capacity)")
        }
    }

    var availableBytes: Int {
        lock.lock()
        defer { lock.unlock() }
        return used
    }

    func append(_ data: Data) {
        let filteredData = telephoneFilter?.process(data) ?? data
        let sourceData = applyMasterGain(filteredData)
        if sourceData.count % bytesPerFrame != 0 {
            playerLog("PCM invariant violation stage=FIFO write reason=odd byte length bytes=\(sourceData.count)")
        }
        var offset = 0
        while offset < sourceData.count {
            lock.lock()
            checkInvariants("FIFO write before")
            let free = storage.count - used
            let count = min(sourceData.count - offset, free)
            if count > 0 {
                let capacity = storage.count
                let destinationIndex = writeIndex
                let sourceIndex = offset
                if destinationIndex + count >= capacity {
                    playerLog("FIFO ring wrap direction=write index=\(destinationIndex) bytes=\(count) used=\(used)")
                }
                storage.withUnsafeMutableBytes { destination in
                    sourceData.withUnsafeBytes { source in
                        let destinationBase = destination.baseAddress!.advanced(by: destinationIndex)
                        let sourceBase = source.baseAddress!.advanced(by: sourceIndex)
                        let first = min(count, capacity - destinationIndex)
                        memcpy(destinationBase, sourceBase, first)
                        if first < count {
                            memcpy(destination.baseAddress!, sourceBase.advanced(by: first), count - first)
                        }
                    }
                }
                writeIndex = (writeIndex + count) % storage.count
                used += count
                offset += count
                checkInvariants("FIFO write after")
            }
            lock.unlock()
            if count == 0 {
                usleep(1_000)
            }
        }
    }

    func read(into destination: UnsafeMutableRawPointer, bytes: Int, active: Bool) -> Int {
        lock.lock()
        defer { lock.unlock() }
        if !active {
            // During adaptive rebuffering the audio engine continues asking
            // for frames. Never hand it uninitialized/stale memory.
            memset(destination, 0, bytes)
            return 0
        }
        checkInvariants("FIFO read before")
        if bytes % bytesPerFrame != 0 {
            playerLog("PCM invariant violation stage=FIFO read reason=odd requested byte length bytes=\(bytes)")
        }
        let validBytesBeforeRead = used
        let count = min(bytes, used)
        if count > validBytesBeforeRead {
            playerLog("PCM invariant violation stage=FIFO read reason=read past valid data requested=\(bytes) valid=\(validBytesBeforeRead) count=\(count)")
        }
        if count > 0 {
            if readIndex + count >= storage.count {
                playerLog("FIFO ring wrap direction=read index=\(readIndex) bytes=\(count) used=\(used)")
            }
            storage.withUnsafeBytes { source in
                let sourceBase = source.baseAddress!.advanced(by: readIndex)
                let first = min(count, storage.count - readIndex)
                memcpy(destination, sourceBase, first)
                if first < count {
                    memcpy(destination.advanced(by: first), source.baseAddress!, count - first)
                }
            }
            readIndex = (readIndex + count) % storage.count
            used -= count
            checkInvariants("FIFO read after")
        }
        if count < bytes {
            underrunCount += 1
            underrunBytes += bytes - count
            let firstUnderflow = !underflowed
            underflowed = true
            memset(destination.advanced(by: count), 0, bytes - count)
            if firstUnderflow {
                playerLog("FIFO underrun requestedBytes=\(bytes) validBytes=\(validBytesBeforeRead) suppliedBytes=\(count)")
            }
        }
        return count
    }

    func takeUnderflowed() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let value = underflowed
        underflowed = false
        return value
    }
}

let ring = PCMByteRing(capacity: ringCapacityBytes)
let stateLock = NSLock()
var playbackActive = false
var targetPrebufferBytes = startupPrebufferBytes

func isPlaybackActive() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return playbackActive
}

func setPlaybackActive(_ active: Bool) {
    stateLock.lock()
    playbackActive = active
    stateLock.unlock()
}

let engine = AVAudioEngine()
let source = AVAudioSourceNode { _, _, frameCount, audioBufferList -> OSStatus in
    let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)
    guard let destination = buffers[0].mData else { return noErr }
    let requestedBytes = Int(frameCount) * bytesPerFrame
    let handedBytes = ring.read(into: destination, bytes: requestedBytes, active: isPlaybackActive())
    buffers[0].mDataByteSize = UInt32(requestedBytes)
    let advertisedBytes = Int(buffers[0].mDataByteSize)
    if requestedBytes != Int(frameCount) * bytesPerFrame || advertisedBytes != requestedBytes || handedBytes > requestedBytes {
        playerLog("PCM invariant violation stage=AVFoundation handoff requestedBytes=\(requestedBytes) advertisedBytes=\(advertisedBytes) frames=\(frameCount) handedBytes=\(handedBytes)")
    }
    return noErr
}

func audioDeviceName(_ deviceID: AudioDeviceID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: Unmanaged<CFString>?
    var propertySize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let status = withUnsafeMutablePointer(to: &name) { pointer in
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propertySize, pointer)
    }
    guard status == noErr else { return nil }
    return name?.takeUnretainedValue() as String?
}

func availableAudioDevices() -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize) == noErr else { return [] }
    var devices = [AudioDeviceID](repeating: 0, count: Int(dataSize) / MemoryLayout<AudioDeviceID>.stride)
    guard !devices.isEmpty else { return [] }
    let status = devices.withUnsafeMutableBufferPointer { buffer in
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, buffer.baseAddress!)
    }
    return status == noErr ? devices : []
}

func routeOutput(to requestedName: String) {
    let devices = availableAudioDevices()
    guard let deviceID = devices.first(where: { audioDeviceName($0)?.localizedCaseInsensitiveContains(requestedName) == true }) else {
        playerLog("output device not found requested=\(requestedName)")
        return
    }
    guard let outputUnit = engine.outputNode.audioUnit else {
        playerLog("output device route unavailable requested=\(requestedName)")
        return
    }
    var selectedDevice = deviceID
    let status = AudioUnitSetProperty(
        outputUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &selectedDevice,
        UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    if status == noErr {
        playerLog("output device selected name=\(audioDeviceName(deviceID) ?? requestedName) id=\(deviceID)")
    } else {
        playerLog("output device selection failed requested=\(requestedName) status=\(status)")
    }
}

if let requestedOutputDevice {
    routeOutput(to: requestedOutputDevice)
}

engine.attach(source)
engine.connect(source, to: engine.mainMixerNode, format: format)

if requestedOutputDevice != nil {
    // Make the sample-rate conversion explicit at the hardware boundary.
    // HiFiDSD is normally clocked at 44.1 kHz while Live supplies 24 kHz
    // mono PCM. Leaving this connection implicit lets CoreAudio renegotiate
    // the USB route during playback, which can starve the native FIFO.
    let hardwareFormat = engine.outputNode.outputFormat(forBus: 0)
    playerLog("hardware output format sampleRate=\(hardwareFormat.sampleRate) channels=\(hardwareFormat.channelCount)")
    engine.connect(engine.mainMixerNode, to: engine.outputNode, format: hardwareFormat)
}

do {
    try engine.start()
} catch {
    fputs("AVAudioEngine start failed: \(error)\n", stderr)
    exit(1)
}

var pendingByte: UInt8?
while let data = try? FileHandle.standardInput.read(upToCount: readSize), !data.isEmpty {
    var chunk = data
    if let carry = pendingByte {
        chunk.insert(carry, at: 0)
        pendingByte = nil
    }
    if chunk.count % bytesPerFrame != 0 {
        pendingByte = chunk.removeLast()
    }
    if chunk.isEmpty { continue }
    ring.append(chunk)
    if isPlaybackActive() && ring.takeUnderflowed() {
        targetPrebufferBytes = min(maximumPrebufferBytes, targetPrebufferBytes + readSize * 2)
        setPlaybackActive(false)
        fputs("FIFO underrun; increasing prebuffer to \(targetPrebufferBytes / readSize * 100) ms\n", stderr)
    }
    if !isPlaybackActive() && ring.availableBytes >= targetPrebufferBytes {
        setPlaybackActive(true)
    }
}

if !isPlaybackActive() && ring.availableBytes > 0 {
    setPlaybackActive(true)
}
while ring.availableBytes > 0 {
    usleep(10_000)
}
setPlaybackActive(false)
usleep(200_000)
engine.stop()
fputs("continuous FIFO stats: underruns=\(ring.underrunCount) underrunBytes=\(ring.underrunBytes)\n", stderr)
