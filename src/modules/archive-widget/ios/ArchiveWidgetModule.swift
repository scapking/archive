import ExpoModulesCore
import Foundation
import WidgetKit

/// iOS 侧 widget 数据桥：把 JS 推来的快照 JSON 写进共享 App Group
/// UserDefaults——WidgetKit 扩展（targets 由 with-archive-widget-ios 插件注入）
/// 从同一 suite 读取，并立刻经 WidgetCenter 请求重载时间线（v0.4.7：行程数据
/// 变化即时刷桌面卡，30min 时间线只是节流兜底——系统仍可能对高频 reload 延后
/// 执行，这是 WidgetKit 的预算机制边界，报告已披露）。
/// Android 走 Kotlin 模块，两端同名同 API。
public class ArchiveWidgetModule: Module {
  static let appGroupId = "group.com.anonymous.archive.shared"
  static let snapshotKey = "snapshot"
  /// 与插件注入的扩展 StaticConfiguration(kind:) 一致
  static let widgetKind = "ArchiveTripWidget"

  public func definition() -> ModuleDefinition {
    Name("HomeWidget")

    OnCreate {
      // 主 app 侧预建共享容器读取面（冷启时扩展可能尚未写入）
      _ = UserDefaults(suiteName: ArchiveWidgetModule.appGroupId)
    }

    AsyncFunction("push") { (snapshotJson: String, promise: Promise) in
      guard let defaults = UserDefaults(suiteName: ArchiveWidgetModule.appGroupId) else {
        promise.reject("ERR_APP_GROUP", "App Group \(ArchiveWidgetModule.appGroupId) unavailable")
        return
      }
      defaults.set(snapshotJson, forKey: ArchiveWidgetModule.snapshotKey)
      // 即时刷新桌面卡（WidgetCenter 可在主 app 调用；预算限流由系统负责）
      WidgetCenter.shared.reloadTimelines(ofKind: ArchiveWidgetModule.widgetKind)
      promise.resolve(nil)
    }
  }
}