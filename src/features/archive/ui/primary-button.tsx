import { Text, View } from 'react-native';
import { BouncyPressable } from '@/core/icons';
import { usePalette } from './theme';

/**
 * 实心主按钮（系统极简）：近黑/反白 primary-btn，不用渐变（app-screens 房规：
 * 主按钮不用强调色，蓝只上数据）。modal 内的提交动作。
 */
export function PrimaryButton({
    label,
    onPress,
    disabled = false,
}: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
}) {
    const palette = usePalette();
    return (
        <BouncyPressable onPress={disabled ? undefined : onPress} scaleTo={0.98}>
            <View
                className="h-[52px] items-center justify-center rounded-control"
                style={{ backgroundColor: palette.primaryBtn, opacity: disabled ? 0.4 : 1 }}
                accessibilityRole="button"
                accessibilityLabel={label}
            >
                <Text
                    className="text-[16px] font-semibold"
                    style={{ color: palette.onPrimaryBtn }}
                >
                    {label}
                </Text>
            </View>
        </BouncyPressable>
    );
}
