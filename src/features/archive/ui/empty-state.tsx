import { Text, View } from 'react-native';
import { BouncyPressable } from '@/core/icons';
import type { ReactNode } from 'react';
import { PAPER_CARD_SHADOW } from './paper-shadow';

/**
 * 空态即邀请（frontend-design：空屏是指引，不是情绪）：
 * 一行"是什么"，一行"怎么做"，一个动作。
 *
 * v0.4.9 令5 质感对齐：题升 16 semibold 卡题档、hint 走 secondary（muted 只
 * 留单点 meta，连续引导句在 base 上对比不足）、动作钮去描边改 surface 纸钮 +
 * PAPER_CARD 轻影——纵深靠影不靠线（settings 卡片语言，描边方钮退役）。
 * 同步锚点：journal-edit 收笔失败屏的同语言空态副本，改此必同改。
 */
export function EmptyState({
    icon,
    title,
    hint,
    actionLabel,
    onAction,
}: {
    icon: ReactNode;
    title: string;
    /** 可选的第二行指引（「怎么做」）；不传则不渲染该行。 */
    hint?: string;
    actionLabel?: string;
    onAction?: () => void;
}) {
    return (
        <View className="flex-1 items-center justify-center px-10">
            <View className="mb-4 h-12 w-12 items-center justify-center opacity-70">{icon}</View>
            <Text className="text-[16px] font-semibold text-ink-text dark:text-inkd-text">{title}</Text>
            {hint ? (
                <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                    {hint}
                </Text>
            ) : null}
            {actionLabel && onAction ? (
                // 间距放 Pressable 外层包裹（margin 不计入命中区）：Pressable 框
                // == 按钮视觉盒（44px 高），避免按钮上方 24px 空隙被算进命中区
                <View className="mt-6">
                    <BouncyPressable onPress={onAction} scaleTo={0.96}>
                        {/* 圆角归 control 档（与其余次级按钮一致）；按压反馈由外层
                            BouncyPressable 弹跳承担，内层 View 不用 active:（css-interop
                            会把 View 升级成 Pressable 首帧后 remount，同 MenuRow 口径）；
                            v0.4.9 令5：描边退场，surface 纸钮 + PAPER_CARD 轻影 */}
                        <View
                            className="h-11 items-center justify-center rounded-control bg-ink-surface px-6 dark:bg-inkd-surface"
                            style={PAPER_CARD_SHADOW}
                        >
                            <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                {actionLabel}
                            </Text>
                        </View>
                    </BouncyPressable>
                </View>
            ) : null}
        </View>
    );
}
