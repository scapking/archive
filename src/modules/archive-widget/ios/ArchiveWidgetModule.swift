import ExpoModulesCore
import Foundation

/// iOS 侧 widget 数据桥：把 JS 推来的快照 JSON 写进共享 App Group
/// UserDefaults——WidgetKit 扩展（targets 由 with-archive-widget-ios 插件注入）
/// 从同一 suite 读取。Android 走 Kotlin 模块，两端同名同 API。
public class ArchiveWidgetModule: Module {
  static let appGroupId = "group.com.anonymous.archive.shared"
  static let snapshotKey = "snapshot"

  public func definition() -> ModuleDefinition {
    Name("ArchiveWidget")

    AsyncFunction("push") { (snapshotJson: String, promise: Promise) in
      guard let defaults = UserDefaults(suiteName: ArchiveWidgetModule.appGroupId) else {
        promise.reject("ERR_APP_GROUP", "App Group \(ArchiveWidgetModule.appGroupId) unavailable")
        return
      }
      defaults.set(snapshotJson, forKey: ArchiveWidgetModule.snapshotKey)
      promise.resolve(nil)
    }
  }
}