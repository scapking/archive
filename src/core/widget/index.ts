import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * 桌面 widget 门面（v0.4.4，用户指令 #7）：
 *
 * - Android = 真 AppWidget（archive-widget 本地模块，RemoteViews 静态行）；
 * - iOS = WidgetKit 扩展（App Group 快照，见 targets/archive-widget；本门面
 *   在 iOS 上经 AsyncStorage App Group 回退通道推送，无扩展构建时 no-op）；
 * - web = no-op。
 *
 * 数据契约（用户裁决）：**自动选最新行程 + 其行程项列表**——快照由 store 层
 * 编排（pickWidgetSnapshot），widget 自身无固定文案工具语义；到点/换行程由
 * 显式 push 覆盖，30min 周期重渲兜底。
 *
 * 契约：绝不 throw（best-effort 增强口径，同 core/alarm）——模块缺失/推送
 * 失败 console.warn 留痕，调用方照常。
 */

export interface WidgetSnapshotItem {
    time: string;
    title: string;
    phase: string;
}

export interface WidgetSnapshot {
    tripId: string;
    tripTitle: string;
    items: WidgetSnapshotItem[];
}

type ArchiveWidgetNative = { push(snapshotJson: string): Promise<void> };

const native = Platform.OS === 'android'
    ? requireOptionalNativeModule<ArchiveWidgetNative>('ArchiveWidget')
    : null;

export const widget = {
    /** 平台是否具备 widget 推送能力。 */
    isSupported(): boolean {
        return native != null;
    },

    /** 推送快照并触发重渲：模块缺失/失败静默（warn 留痕）。 */
    async push(snapshot: WidgetSnapshot): Promise<void> {
        if (native == null) return;
        try {
            await native.push(JSON.stringify(snapshot));
        } catch (error) {
            console.warn('[archive-widget] 快照推送失败（不阻塞调用方）:', error);
        }
    },
};