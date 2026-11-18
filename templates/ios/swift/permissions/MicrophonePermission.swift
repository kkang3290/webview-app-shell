import AVFAudio

/// 麦克风权限：iOS 17 起用 AVAudioApplication，更早的系统用 AVAudioSession（ios.deploymentTarget 最低 15.0）。
struct MicrophonePermission: ShellPermission {
    let name = "microphone"

    func check(_ done: @escaping (String) -> Void) {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: done("granted")
            case .denied: done("denied")
            case .undetermined: done("prompt")
            @unknown default: done("prompt")
            }
        } else {
            switch AVAudioSession.sharedInstance().recordPermission {
            case .granted: done("granted")
            case .denied: done("denied")
            case .undetermined: done("prompt")
            @unknown default: done("prompt")
            }
        }
    }

    func request(_ done: @escaping (String) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { done($0 ? "granted" : "denied") }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { done($0 ? "granted" : "denied") }
        }
    }
}
