import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * 触觉反馈接口（expo-haptics，glossary §3 已登记）。
 *
 * 三端口径：native（iOS Taptic / Android Vibrator）真实触感；web 无振动
 * 硬件语义，全部 API 恒 no-op（不抛错）——调用方无需平台分支。
 *
 * **尽力而为语义（error-handling R3 ②）**：触感是操作反馈的增强层，任何
 * 失败（引擎未就绪/系统限制）只 console.warn 留痕，绝不抛出——触感失败
 * 不允许打断调用方正在执行的业务动作（点按/保存/收笔）。API 因此全部为
 * 同步 fire-and-forget 形态（内部消化 rejection），调用方直接调用不 await。
 */

export type HapticsImpactStyle = 'light' | 'medium' | 'heavy';

/** fire-and-forget 收口：触感失败留痕不抛（见文件头尽力而为语义）。 */
function run(action: () => Promise<void>, label: string): void {
    action().catch((error: unknown) => {
        console.warn(`[haptics] ${label} 失败（降级无触感）：`, error);
    });
}

const IMPACT_STYLES: Record<HapticsImpactStyle, Haptics.ImpactFeedbackStyle> = {
    light: Haptics.ImpactFeedbackStyle.Light,
    medium: Haptics.ImpactFeedbackStyle.Medium,
    heavy: Haptics.ImpactFeedbackStyle.Heavy,
};

export const haptics = {
    /** 按压触感（点按/长按触发/勾选翻转等瞬时反馈；默认轻档）。 */
    impact(style: HapticsImpactStyle = 'light'): void {
        if (Platform.OS === 'web') return;
        run(() => Haptics.impactAsync(IMPACT_STYLES[style]), 'impact');
    },
    /** 状态切换触感（分段/开关选择，比 impact 更轻的 tick）。 */
    selection(): void {
        if (Platform.OS === 'web') return;
        run(() => Haptics.selectionAsync(), 'selection');
    },
    /** 成功通知触感（完成收笔/关闭行程/导出完成等终态确认）。 */
    success(): void {
        if (Platform.OS === 'web') return;
        run(
            () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
            'success',
        );
    },
};
