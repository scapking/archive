import { Text } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BouncyPressable } from '@/core/icons';
import { useAccentGradient } from './theme';

/** 实心主按钮：品牌渐变蓝（唯一允许渐变的地方），modal 内的提交动作。 */
export function PrimaryButton({
    label,
    onPress,
    disabled = false,
}: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
}) {
    const [from, to] = useAccentGradient();
    return (
        <BouncyPressable onPress={disabled ? undefined : onPress} scaleTo={0.98}>
            <LinearGradient
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                colors={[from, to]}
                className="h-[52px] items-center justify-center rounded-xl"
                style={{ opacity: disabled ? 0.4 : 1 }}
                accessibilityRole="button"
                accessibilityLabel={label}
            >
                <Text className="text-[16px] font-semibold text-ink-base dark:text-inkd-base">
                    {label}
                </Text>
            </LinearGradient>
        </BouncyPressable>
    );
}
