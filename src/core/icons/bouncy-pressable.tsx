import { Pressable } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import type { ReactNode } from 'react';
import type { IconProps } from './icon-base';

/**
 * 弹跳按压容器：按下去缩小+变暗、松手回弹（spring）。任何内容都能包——
 * 内置图标、自定义 SVG、任意组件通用（"能动一下"的基础设施）。
 */
export function BouncyPressable({
    onPress,
    scaleTo = 0.82,
    children,
}: {
    onPress?: () => void;
    scaleTo?: number;
    children: ReactNode;
}) {
    const scale = useSharedValue(1);
    const opacity = useSharedValue(1);
    const style = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
        opacity: opacity.value,
    }));

    return (
        <Pressable
            onPress={onPress}
            onPressIn={() => {
                scale.value = withSpring(scaleTo, { damping: 14, stiffness: 320 });
                opacity.value = withSpring(0.6, { damping: 14, stiffness: 320 });
            }}
            onPressOut={() => {
                scale.value = withSpring(1, { damping: 9, stiffness: 220 });
                opacity.value = withSpring(1, { damping: 9, stiffness: 220 });
            }}
        >
            <Animated.View style={style}>{children}</Animated.View>
        </Pressable>
    );
}

export type { IconProps };
