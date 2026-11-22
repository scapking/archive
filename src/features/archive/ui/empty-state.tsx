import { Text, View } from 'react-native';
import { BouncyPressable } from '@/core/icons';
import type { ReactNode } from 'react';

/**
 * 空态即邀请（frontend-design：空屏是指引，不是情绪）：
 * 一行"是什么"，一行"怎么做"，一个动作。
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
            <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">{title}</Text>
            {hint ? (
                <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
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
                            会把 View 升级成 Pressable 首帧后 remount，同 MenuRow 口径） */}
                        <View className="h-11 items-center justify-center rounded-control border border-ink-border bg-ink-surface px-6 dark:border-inkd-border dark:bg-inkd-surface">
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
