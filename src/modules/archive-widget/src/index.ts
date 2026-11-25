import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * archive-widget 原生模块的 TS 面（Android + iOS 双端同名 'HomeWidget'）：
 * Android = AppWidgetProvider 渲染 RemoteViews（行 = 时间/标题/阶段三段，
 * status 分档着色，v0.4.7）；iOS = 写共享 App Group 快照 + WidgetCenter
 * 即时重载（WidgetKit 扩展由 with-archive-widget-ios 插件注入）。数据由
 * JS 推 JSON 字符串，快照形态见 core/widget（整形纯函数
 * features/archive/widget-snapshot.ts）。web 模块不存在 →
 * requireOptionalNativeModule 返回 null，调用方按 no-op 降级。
 * 注：本包 TS 面仅类型/文档用——运行时收口在 core/widget 门面（H5 纯净约束）。
 */
export interface ArchiveWidgetNativeModule {
    /** 覆写 widget 数据快照并触发全部已放置 widget 重渲。 */
    push(snapshotJson: string): Promise<void>;
}

export default requireOptionalNativeModule<ArchiveWidgetNativeModule>('ArchiveWidget');