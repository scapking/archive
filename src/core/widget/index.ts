import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * 桌面 widget 门面（v0.4.4，用户指令 #7）：
 *
 * - Android = 真 AppWidget（本地 widget 模块，RemoteViews 静态行）；
 * - iOS = WidgetKit 扩展（config plugin 注入 target）；本门面经该模块把快照
 *   写进共享 App Group UserDefaults，扩展
 *   30min 时间线从同一 suite 读取；
 * - web = no-op。
 *
 * 数据契约（用户裁决，v0.4.7 强化为「显示行程内容」）：**自动选最新行程 +
 * 当日/未来行程项列表（时间、标题、阶段徽章、status 分档堆叠层次）**——快照
 * 整形收口在调用方业务域（buildWidgetSnapshot 纯函数），store 层编排推送；
 * 数据变化即时刷新：Android push 即 renderAll，iOS push 后
 * WidgetCenter.reloadTimelines（30min 时间线降为系统预算内的兜底档）。
 *
 * 契约：绝不 throw（best-effort 增强口径，同 core/alarm）——模块缺失/推送
 * 失败 console.warn 留痕，调用方照常。
 */

export interface WidgetSnapshotItem {
    /** 显示时间（当日 'HH:mm'，跨日 'MM-DD HH:mm'——整形规则见 features widget-snapshot）。 */
    time: string;
    title: string;
    /** 阶段中文标签（待进行/进行中/完成/收尾/已结束），双端行尾徽章。 */
    phase: string;
    /** 阶段机 key（可选，v0.4.7）：双端按它做堆叠视觉分档（ongoing 高亮/终态弱化）。 */
    status?: 'pending' | 'ongoing' | 'done' | 'wrap' | 'terminal';
    /** 到点时刻 epoch ms（可选，v0.4.7）：双端在 push 间隙按本地时钟重推导
     *  pending→ongoing→done 的时间派生档（DB 持久态 done/wrap/terminal 不重算），
     *  iOS 时间线按下一个档位切换点定点刷新。 */
    dueAt?: number;
}

export interface WidgetSnapshot {
    tripId: string;
    tripTitle: string;
    items: WidgetSnapshotItem[];
}

type HomeWidgetNative = { push(snapshotJson: string): Promise<void> };

// Android/iOS 都有原生模块（iOS = App Group UserDefaults 桥）；web = no-op
const native = Platform.OS === 'web'
    ? null
    : requireOptionalNativeModule<HomeWidgetNative>('HomeWidget');

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
            console.warn('[widget] 快照推送失败（不阻塞调用方）:', error);
        }
    },
};