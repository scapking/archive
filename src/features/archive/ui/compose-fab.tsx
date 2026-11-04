import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BouncyPressable, LucidePlus } from '@/core/icons';

/**
 * 主行动浮钮：屏上唯一的实心 accent（app-screens：12/23 屏连实心主按钮都没有——
 * 本产品写碎片是最高频动作，值得这一个）。
 */
export function ComposeFab({ onPress, accessibilityLabel }: { onPress: () => void; accessibilityLabel: string }) {
    const insets = useSafeAreaInsets();
    return (
        <View
            className="absolute right-6"
            style={{ bottom: insets.bottom + 24 }}
            pointerEvents="box-none"
        >
            <BouncyPressable onPress={onPress} scaleTo={0.88}>
                <View
                    className="h-14 w-14 items-center justify-center rounded-full bg-hatch-accent"
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                >
                    <LucidePlus size={24} color="#080A0A" strokeWidth={2.2} />
                </View>
            </BouncyPressable>
        </View>
    );
}
