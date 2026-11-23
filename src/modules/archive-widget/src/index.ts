import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * archive-widget 原生模块的 TS 面（Android only）：AppWidgetProvider 渲染
 * RemoteViews，数据由 JS 推 JSON 字符串（快照形态见 core/widget）。iOS/web
 * 模块不存在 → requireOptionalNativeModule 返回 null，调用方按 no-op 降级。
 */
export interface ArchiveWidgetNativeModule {
    /** 覆写 widget 数据快照并触发全部已放置 widget 重渲。 */
    push(snapshotJson: string): Promise<void>;
}

export default requireOptionalNativeModule<ArchiveWidgetNativeModule>('ArchiveWidget');