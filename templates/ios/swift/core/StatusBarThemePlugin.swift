import Capacitor
import UIKit

/// 与 Android 的 StatusBarTheme 同一接口：Web 在主题变化时调用 setTheme({ color: '#RRGGBB', darkIcons })，
/// 原生把安全区画布和状态栏文字颜色跟上。上一次的颜色存下来，冷启动时先用它铺底，避免白闪。
@objc(StatusBarThemePlugin)
final class StatusBarThemePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "StatusBarThemePlugin"
    let jsName = "StatusBarTheme"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setTheme", returnType: CAPPluginReturnPromise),
    ]
    private static let preference = "appshell.statusBarTheme"

    static func parse(hex: String) -> UIColor? {
        let value = hex.trimmingCharacters(in: .whitespaces)
        guard value.count == 7, value.hasPrefix("#"), let rgb = UInt32(value.dropFirst(), radix: 16) else { return nil }
        return UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                       blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }

    static func launchColor() -> UIColor? {
        guard let saved = UserDefaults.standard.dictionary(forKey: Self.preference),
              let hex = saved["color"] as? String else { return nil }
        return Self.parse(hex: hex)
    }

    @objc func setTheme(_ call: CAPPluginCall) {
        guard let hex = call.getString("color"), let color = Self.parse(hex: hex) else {
            call.reject("color must be #RRGGBB")
            return
        }
        guard let darkIcons = call.getBool("darkIcons") else {
            call.reject("darkIcons is required")
            return
        }
        DispatchQueue.main.async {
            guard let browser = self.bridge?.viewController as? CAPBridgeViewController else {
                call.reject("bridge view controller unavailable")
                return
            }
            browser.parent?.view.backgroundColor = color
            browser.view.backgroundColor = color
            browser.webView?.backgroundColor = color
            browser.webView?.scrollView.backgroundColor = color
            browser.setStatusBarStyle(darkIcons ? .darkContent : .lightContent)
            browser.parent?.setNeedsStatusBarAppearanceUpdate()
            UserDefaults.standard.set(["color": hex, "darkIcons": darkIcons], forKey: Self.preference)
            call.resolve()
        }
    }
}
