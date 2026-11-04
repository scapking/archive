import { Text, View } from 'react-native';
import { BouncyPressable } from '@/core/icons';

/** 实心主按钮：modal 内的提交动作（创建行程 / 保存碎片）。 */
export function PrimaryButton({
    label,
    onPress,
    disabled = false,
}: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
}) {
    return (
        <BouncyPressable onPress={disabled ? undefined : onPress} scaleTo={0.97}>
            <View
                className="h-12 items-center justify-center rounded-lg bg-hatch-accent"
                style={{ opacity: disabled ? 0.5 : 1 }}
            >
                <Text className="text-[15px] font-semibold text-hatch-base">{label}</Text>
            </View>
        </BouncyPressable>
    );
}
