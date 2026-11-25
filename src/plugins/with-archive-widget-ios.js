/**
 * Config plugin（v0.4.4 用户指令 #7/#11）：给 iOS 工程注入 WidgetKit 扩展
 * target（ArchiveWidget）。`expo prebuild --clean` 每次从零生成 ios/，本插件
 * 在 prebuild 阶段：
 *
 * 1. withDangerousMod —— 落扩展源文件（Swift widget + Info.plist + App Group
 *    entitlements）到 ios/ArchiveWidget/；
 * 2. withXcodeProject —— xcode 库 addTarget('app_extension')（自动建 product、
 *    嵌入 CopyFiles phase、PBXTargetDependency）+ 补 Sources/Frameworks/
 *    Resources 三个 build phase（addTarget 不建，addSourceFile 需要先有
 *    Sources phase 才能挂 build file）+ Swift/部署版本等 build settings；
 * 3. withEntitlementsPlist —— 主 app 加同一个 App Group。
 *
 * 无签名 CI 构建（CODE_SIGNING_ALLOWED=NO）下 entitlements 只是元数据；
 * 扩展不装 pod（WidgetKit/SwiftUI 系统框架，auto-link）。
 */
const { withXcodeProject, withEntitlementsPlist, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const TARGET_NAME = 'ArchiveWidget';
const APP_GROUP = 'group.com.anonymous.archive.shared';

const WIDGET_SWIFT = `import WidgetKit
import SwiftUI

private let appGroupId = "${APP_GROUP}"
private let snapshotKey = "snapshot"

private struct SnapshotItem: Identifiable {
    let id: UUID
    let time: String
    let title: String
    let phase: String
    /// 阶段机 key（pending/ongoing/done/wrap/terminal）——堆叠视觉分档用
    let status: String
    /// 到点时刻 epoch 秒（0 = 未知）——时间派生档就地重推导 + 定点时间线
    let dueAt: Double
}

/// 完成窗口（JS trip-item-logic DONE_WINDOW_MS / Android provider 同值镜像）：
/// pending→ongoing（dueAt）与 ongoing→done（dueAt+窗口）是纯时间派生档，
/// 渲染侧按条目时刻重推导；done/wrap/terminal 为 DB 持久态保留推送值。
private let doneWindowSeconds = 30 * 60.0

private func effectiveStatus(_ item: SnapshotItem, at date: Date) -> String {
    if item.status != "pending" && item.status != "ongoing" { return item.status }
    guard item.dueAt > 0 else { return item.status }
    let t = date.timeIntervalSince1970
    if t < item.dueAt { return "pending" }
    if t < item.dueAt + doneWindowSeconds { return "ongoing" }
    return "done"
}

private func phaseLabel(_ status: String, fallback: String) -> String {
    switch status {
    case "pending": return "待进行"
    case "ongoing": return "进行中"
    case "done": return "完成"
    default: return fallback
    }
}

private struct Snapshot {
    let tripId: String
    let tripTitle: String
    let items: [SnapshotItem]
}

/// 与主 app 的共享快照（archive-widget 模块写入 App Group UserDefaults）。
private func loadSnapshot() -> Snapshot? {
    guard let defaults = UserDefaults(suiteName: appGroupId),
          let raw = defaults.string(forKey: snapshotKey),
          let data = raw.data(using: .utf8),
          let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return nil }
    let tripId = root["tripId"] as? String ?? ""
    guard !tripId.isEmpty else { return nil }
    let tripTitle = root["tripTitle"] as? String ?? "行程"
    let rawItems = root["items"] as? [[String: Any]] ?? []
    let items = rawItems.prefix(4).map { dict in
        SnapshotItem(
            id: UUID(),
            time: dict["time"] as? String ?? "",
            title: dict["title"] as? String ?? "",
            phase: dict["phase"] as? String ?? "",
            status: dict["status"] as? String ?? "pending",
            dueAt: (dict["dueAt"] as? NSNumber)?.doubleValue ?? 0
        )
    }
    return Snapshot(tripId: tripId, tripTitle: tripTitle, items: items)
}

private struct Entry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
}

private struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry {
        Entry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) {
        completion(Entry(date: Date(), snapshot: loadSnapshot()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        let snapshot = loadSnapshot()
        let now = Date()
        // 定点条目（v0.4.7）：时间派生档切换点 dueAt / dueAt+窗口（24h 内、
        // ≤8 条），行样式按条目时刻重推导——无需等待 push 即翻「进行中/完成」；
        // 主 app 每次 push 仍经 WidgetCenter.reloadTimelines 即时刷新，
        // 无切换点时回退 30min 周期档（WidgetKit 刷新预算由系统调度，如实边界）。
        var times: [Date] = [now]
        if let snapshot {
            let nowT = now.timeIntervalSince1970
            let horizon = nowT + 24 * 3600
            for item in snapshot.items where item.status == "pending" || item.status == "ongoing" {
                guard item.dueAt > 0 else { continue }
                for t in [item.dueAt, item.dueAt + doneWindowSeconds] where t > nowT && t < horizon {
                    times.append(Date(timeIntervalSince1970: t))
                }
            }
        }
        times = Array(Set(times.map { $0.timeIntervalSince1970 })).sorted()
        if times.count > 8 { times = Array(times.prefix(8)) }
        let entries = times.map { Entry(date: $0, snapshot: snapshot) }
        let next = times.count > 1
            ? times[times.count - 1].addingTimeInterval(60)
            : Calendar.current.date(byAdding: .minute, value: 30, to: now) ?? now.addingTimeInterval(1800)
        completion(Timeline(entries: entries, policy: .after(next)))
    }
}

/// 行分档样式（v0.4.7 堆叠视觉层次，语义与 Android provider 一致）：
/// ongoing = 强调（蓝色时间 + 加重字重）；pending = 常规；done/wrap = 弱化；
/// terminal = 最弱。status/phase 按条目时刻经 effectiveStatus 就地重推导。
private struct ItemRow: View {
    let item: SnapshotItem
    let date: Date

    var body: some View {
        let status = effectiveStatus(item, at: date)
        HStack(spacing: 8) {
            Text(item.time)
                .font(status == "ongoing"
                      ? .system(size: 12, weight: .semibold).monospacedDigit()
                      : .system(size: 12).monospacedDigit())
                .foregroundStyle(status == "ongoing"
                                 ? Color.blue
                                 : status == "pending"
                                   ? Color.secondary
                                   : Color.secondary.opacity(0.7))
            Text(item.title)
                .font(.system(size: status == "ongoing" ? 14 : 13,
                              weight: status == "ongoing" ? .semibold : .regular))
                .foregroundStyle(status == "terminal" || status == "done" || status == "wrap"
                                 ? Color.secondary
                                 : Color.primary)
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(phaseLabel(status, fallback: item.phase))
                .font(.system(size: 10))
                .foregroundStyle(status == "ongoing" ? Color.blue : Color.secondary)
                .lineLimit(1)
        }
        .opacity(status == "terminal" ? 0.55 : 1.0)
    }
}

private struct ArchiveWidgetEntryView: View {
    var entry: Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let snapshot = entry.snapshot {
                Text(snapshot.tripTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                ForEach(snapshot.items) { item in
                    ItemRow(item: item, date: entry.date)
                }
                if snapshot.items.isEmpty {
                    Text("今天没有安排")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("行程")
                    .font(.system(size: 13, weight: .semibold))
                Text("打开 Archive，行程会出现在这里")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(12)
        .widgetURL(entry.snapshot.flatMap { URL(string: "archive://trip/\\($0.tripId)") })
    }
}

private struct ArchiveTripWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ArchiveTripWidget", provider: Provider()) { entry in
            ArchiveWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("行程")
        .description("自动显示最新行程的任务列表")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct ArchiveWidgetBundle: WidgetBundle {
    var body: some Widget {
        ArchiveTripWidget()
    }
}
`;

const WIDGET_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>Archive Widget</string>
    <key>CFBundleExecutable</key>
    <string>\$(EXECUTABLE_NAME)</string>
    <key>CFBundleIdentifier</key>
    <string>\$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>\$(PRODUCT_NAME)</string>
    <key>CFBundlePackageType</key>
    <string>XPC!</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>NSExtension</key>
    <dict>
        <key>NSExtensionPointIdentifier</key>
        <string>com.apple.widgetkit-extension</string>
    </dict>
</dict>
</plist>
`;

const WIDGET_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array>
        <string>${APP_GROUP}</string>
    </array>
</dict>
</plist>
`;

/** 步 1：落扩展源文件（幂等：prebuild --clean 每次重建 ios/）。 */
const withWidgetFiles = (config) =>
    withDangerousMod(config, [
        'ios',
        (cfg) => {
            const dir = path.join(cfg.modRequest.platformProjectRoot, TARGET_NAME);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, `${TARGET_NAME}.swift`), WIDGET_SWIFT);
            fs.writeFileSync(path.join(dir, `${TARGET_NAME}-Info.plist`), WIDGET_INFO_PLIST);
            fs.writeFileSync(path.join(dir, `${TARGET_NAME}.entitlements`), WIDGET_ENTITLEMENTS);
            return cfg;
        },
    ]);

/** 步 2：xcode 工程 target 注入。 */
const withWidgetTarget = (config) =>
    withXcodeProject(config, (cfg) => {
        const proj = cfg.modResults;
        // 幂等：已存在同名 target 直接跳过（prebuild --clean 下恒走新建）
        const sections = proj.pbxNativeTargetSection() ?? {};
        const existing = Object.values(sections).some(
            (t) => t && typeof t === 'object' && t.name === `"${TARGET_NAME}"`,
        );
        if (existing) return cfg;

        const bundleId = `${cfg.ios?.bundleIdentifier ?? 'com.anonymous.archive'}.${TARGET_NAME}`;
        const target = proj.addTarget(TARGET_NAME, 'app_extension', TARGET_NAME, bundleId);

        // addTarget 不建 Sources/Frameworks/Resources phase（只建嵌入 CopyFiles），
        // addSourceFile 需要 Sources phase 才能挂 build file
        proj.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
        proj.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
        proj.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
        proj.addSourceFile(
            path.posix.join(TARGET_NAME, `${TARGET_NAME}.swift`),
            { target: target.uuid },
        );

        // build settings：Swift 版本 / 部署目标 / entitlements（INFOPLIST_FILE 与
        // PRODUCT_BUNDLE_IDENTIFIER 已由 addTarget 按子目录约定落好）
        const configList = proj.pbxXCConfigurationList()?.[target.pbxNativeTarget.buildConfigurationList];
        const overrides = {
            SWIFT_VERSION: '"5.0"',
            IPHONEOS_DEPLOYMENT_TARGET: '"16.4"',
            TARGETED_DEVICE_FAMILY: '"1,2"',
            CODE_SIGN_ENTITLEMENTS: `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`,
            CURRENT_PROJECT_VERSION: '"1"',
            MARKETING_VERSION: '"1.0"',
        };
        // configList.buildConfigurations 是 {value, comment} 引用数组——直接往
        // 引用对象上挂 buildSettings 会静默写到死对象（第二轮门禁 SWIFT_VERSION
        // 为空实测），必须经 value 解引用到 XCBuildConfiguration 段里的真身
        const configs = proj.pbxXCBuildConfigurationSection();
        for (const ref of configList?.buildConfigurations ?? []) {
            const buildConfig = configs?.[ref.value];
            if (buildConfig) {
                buildConfig.buildSettings = { ...buildConfig.buildSettings, ...overrides };
            }
        }
        return cfg;
    });

/** 步 3：主 app 挂同一个 App Group（扩展读取快照的前提）。 */
const withAppGroup = (config) =>
    withEntitlementsPlist(config, (cfg) => {
        const groups = cfg.modResults['com.apple.security.application-groups'] ?? [];
        if (!groups.includes(APP_GROUP)) groups.push(APP_GROUP);
        cfg.modResults['com.apple.security.application-groups'] = groups;
        return cfg;
    });

module.exports = (config) => withAppGroup(withWidgetTarget(withWidgetFiles(config)));