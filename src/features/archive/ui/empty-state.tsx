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
    hint: string;
    actionLabel?: string;
    onAction?: () => void;
}) {
    return (
        <View className="flex-1 items-center justify-center px-10">
            <View className="mb-4 h-12 w-12 items-center justify-center opacity-70">{icon}</View>
            <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">{title}</Text>
            <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                {hint}
            </Text>
            {actionLabel && onAction ? (
                // 间距放 Pressable 外层包裹（margin 不计入命中区）：Pressable 框
                // == 按钮视觉盒（44px 高），避免按钮上方 24px 空隙被算进命中区
                <View className="mt-6">
                    <BouncyPressable onPress={onAction} scaleTo={0.96}>
                        <View className="h-11 items-center justify-center rounded-lg border border-ink-border bg-ink-surface px-6 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised">
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
