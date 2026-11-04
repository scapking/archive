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
            <View className="mb-4 h-12 w-12 items-center justify-center opacity-60">{icon}</View>
            <Text className="text-[15px] font-medium text-hatch-text">{title}</Text>
            <Text className="mt-1.5 text-center text-[13px] leading-5 text-hatch-muted">{hint}</Text>
            {actionLabel && onAction ? (
                <BouncyPressable onPress={onAction} scaleTo={0.96}>
                    <View className="mt-6 h-11 items-center justify-center rounded-lg border border-hatch-border bg-hatch-surface px-6 active:bg-hatch-raised">
                        <Text className="text-[14px] font-medium text-hatch-text">{actionLabel}</Text>
                    </View>
                </BouncyPressable>
            ) : null}
        </View>
    );
}
