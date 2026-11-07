import { View } from 'react-native';
import { BouncyPressable, LucideBack, LucideClose } from '@/core/icons';
import { usePalette } from './theme';

/**
 * 统一关闭/返回钮（DEV.md #8 打磨轮新口径）：全部卡片浮层与全屏层的退出
 * affordance 收敛为**一种设计语言**——44px 圆形触感底 + 线性图标 + BouncyPressable
 * 弹跳反馈。替代此前散落各处的手写圆钮（bg-black/35 / bg-white/10 / 无底箭头），
 * 用户主诉「箭头退出太丑」的落点：退出钮从「无底的裸图标」升级为有触感底的
 * 圆钮，视觉重量与卡片语言（rounded + raised 底）一致。
 *
 * - `icon`：'close'（X，卡头右上关闭）/ 'back'（chevron-left，屏左上返回）；
 * - `onDark`：深底浮层变体（拍摄/录音卡、全屏查看器——底恒为近黑，与主题无关，
 *   沿用 camera-overlay 既有白 10% 口径）；默认 surface 变体走 ink/inkd raised
 *   触感底 + secondary 图标，双主题自动成对；
 * - 命中核算：44px 视觉盒 ≥44 规范，不传 hitSlop（0）——使用位在卡头右缘或
 *   屏隅，相邻元素为标题/正文等非按压体，命中区无重叠核算项；
 * - 深路径注记：本组件未入 ui/index.ts 出口（该文件不在本轮改动权限内），
 *   屏文件按域内深取纪律 `./ui/close-button` 直连（同 editor-icons 先例），
 *   出口扩充时可收口。
 */
export function CloseButton({
    onPress,
    icon = 'close',
    onDark = false,
    label,
}: {
    onPress: () => void;
    /** 'close' = X（关闭浮层）；'back' = chevron-left（返回上一屏）。 */
    icon?: 'close' | 'back';
    /** 深底浮层变体：白 10% 圆底 + 白图标（拍摄/录音卡、全屏查看器）。 */
    onDark?: boolean;
    /** 无障碍标签（默认按图标语义给「关闭」/「返回」）。 */
    label?: string;
}) {
    const palette = usePalette();
    const Icon = icon === 'back' ? LucideBack : LucideClose;
    // 条件三元 className 两侧变量集恒等（铁律）：完整类名成对给出
    const surfaceClass = onDark ? 'bg-white/10' : 'bg-ink-raised dark:bg-inkd-raised';
    const iconColor = onDark ? '#FFFFFF' : palette.secondary;
    return (
        <BouncyPressable onPress={onPress} scaleTo={0.9}>
            <View
                className={`h-11 w-11 items-center justify-center rounded-full ${surfaceClass}`}
                accessibilityRole="button"
                accessibilityLabel={label ?? (icon === 'back' ? '返回' : '关闭')}
            >
                <Icon size={20} color={iconColor} strokeWidth={2} />
            </View>
        </BouncyPressable>
    );
}
