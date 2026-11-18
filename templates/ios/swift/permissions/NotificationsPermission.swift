import UserNotifications

struct NotificationsPermission: ShellPermission {
    let name = "notifications"

    func check(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: done("granted")
            case .denied: done("denied")
            case .notDetermined: done("prompt")
            @unknown default: done("prompt")
            }
        }
    }

    func request(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            done(granted ? "granted" : "denied")
        }
    }
}
