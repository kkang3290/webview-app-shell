import Photos

/// 只申请「添加到相册」：保存图片不需要读取整个相册。
struct PhotosPermission: ShellPermission {
    let name = "photos"

    private static func state(_ status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized, .limited: "granted"
        case .denied: "denied"
        case .restricted: "unsupported"
        case .notDetermined: "prompt"
        @unknown default: "prompt"
        }
    }

    func check(_ done: @escaping (String) -> Void) {
        done(Self.state(PHPhotoLibrary.authorizationStatus(for: .addOnly)))
    }

    func request(_ done: @escaping (String) -> Void) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { done(Self.state($0)) }
    }
}
