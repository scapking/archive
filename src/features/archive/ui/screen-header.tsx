import { Text, View } from 'react-native';
import { BouncyPressable, LucideBack } from '@/core/icons';
import type { ReactNode } from 'react';
import { usePalette } from './theme';
import { safeBack } from './safe-back';

/**
 * 屏头（app-screens：无 hero）：屏题 20px（字号阶第二档），副行放「发现」而非口号。
 * 返回键走 BouncyPressable（按压即反馈），箭头色走 palette。
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
    const palette = usePalette();
    return (
        <View className="px-6 pb-3 pt-2">
            <View className="h-11 flex-row items-center justify-between">
                <View className="min-w-0 flex-1 flex-row items-center">
                    {back ? (
                        // 返回钮：负 margin 会把按压盒推进父容器 padding 区（native 命中死区），
                        // 改为图标盒贴内容边对齐（视觉与原 -ml-2 等效）。纯图标小钮（36px 盒
                        // < 44）：按 bouncy-pressable 新规显式 hitSlop 10 → 等效命中 56px ≥ 44；
                        // 右邻标题为非 pressable、四周无相邻命中元素，10 不产生重叠
                        <BouncyPressable onPress={safeBack} scaleTo={0.9} hitSlop={10}>
                            <View className="h-9 w-9 items-center justify-start">
                                <LucideBack size={22} color={palette.muted} />
                            </View>
                        </BouncyPressable>
                    ) : null}
                    <Text
                        numberOfLines={1}
                        className="flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
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
