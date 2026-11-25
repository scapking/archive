import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BouncyPressable, LucidePlus } from '@/core/icons';
import { usePalette } from './theme';
import { PAPER_CARD_SHADOW } from './paper-shadow';

/**
 * 主行动浮钮（系统极简）：近黑/反白纯色圆钮，与 PrimaryButton 同底色体系；
 * 屏上唯一的实心强调，蓝色不上 chrome。
 * v0.4.9 令5：补 PAPER_CARD 柔影——FAB 恒悬浮于内容之上，是全仓浮钮统一
 * 光影档（events / event-detail / journal-edit 内联同款同改）。
 */
export function ComposeFab({
    onPress,
    accessibilityLabel,
}: {
    onPress: () => void;
    accessibilityLabel: string;
}) {
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    return (
        <View className="absolute right-6" style={{ bottom: insets.bottom + 24 }} pointerEvents="box-none">
            {/* 56px 圆钮视觉 ≥44，按 bouncy-pressable 新规不传 hitSlop（0）：
                命中盒 == 视觉盒，且屏上此隅无相邻命中元素，无需外扩 */}
            <BouncyPressable onPress={onPress} scaleTo={0.88}>
                <View
                    className="h-14 w-14 items-center justify-center rounded-full"
                    style={[{ backgroundColor: palette.primaryBtn }, PAPER_CARD_SHADOW]}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                >
                    <LucidePlus size={24} color={palette.onPrimaryBtn} strokeWidth={2.2} />
                </View>
            </BouncyPressable>
        </View>
    );
}
