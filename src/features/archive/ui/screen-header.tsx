import { Text, View } from 'react-native';
import { BouncyPressable, LucideBack } from '@/core/icons';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';

/**
 * 屏头（app-screens：无 hero——标题 ≤17px，副行放"发现"而非口号）。
 * 返回键走 BouncyPressable（按压即反馈）。
 */
export function ScreenHeader({
    title,
    subtitle,
    right,
    back = true,
}: {
    title: string;
    subtitle?: string;
    right?: ReactNode;
    back?: boolean;
}) {
    const router = useRouter();
    return (
        <View className="px-6 pb-3 pt-2">
            <View className="h-11 flex-row items-center justify-between">
                <View className="min-w-0 flex-1 flex-row items-center">
                    {back ? (
                        <BouncyPressable onPress={() => router.back()} scaleTo={0.9}>
                            <View className="-ml-2 mr-2 h-9 w-9 items-center justify-center">
                                <LucideBack size={22} color="#8B939C" />
                            </View>
                        </BouncyPressable>
                    ) : null}
                    <Text
                        numberOfLines={1}
                        className="flex-1 text-[17px] font-semibold text-ink-text dark:text-inkd-text"
                    >
                        {title}
                    </Text>
                    {right}
                </View>
            </View>
            {subtitle ? (
                <Text className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary">
                    {subtitle}
                </Text>
            ) : null}
        </View>
    );
}
