import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { BouncyPressable, LucidePlus } from '@/core/icons';
import { useAccentGradient } from './theme';

/**
 * 主行动浮钮：屏上唯一的实心渐变（品牌蓝），app-screens 纪律下的那一处强调。
 */
export function ComposeFab({
    onPress,
    accessibilityLabel,
}: {
    onPress: () => void;
    accessibilityLabel: string;
}) {
    const insets = useSafeAreaInsets();
    const [from, to] = useAccentGradient();
    return (
        <View className="absolute right-6" style={{ bottom: insets.bottom + 24 }} pointerEvents="box-none">
            <BouncyPressable onPress={onPress} scaleTo={0.88}>
                <LinearGradient
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    colors={[from, to]}
                    className="h-14 w-14 items-center justify-center rounded-full"
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                >
                    <LucidePlus size={24} color="#FFFFFF" strokeWidth={2.2} />
                </LinearGradient>
            </BouncyPressable>
        </View>
    );
}
