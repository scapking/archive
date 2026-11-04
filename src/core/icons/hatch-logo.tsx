import { useEffect } from 'react';
import { View } from 'react-native';
import { Path, Svg } from 'react-native-svg';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withRepeat,
    withSequence,
    withTiming,
} from 'react-native-reanimated';
import { GradientCycle } from './gradient-cycle';

/**
 * Hatch 启动 Logo：蛋形渐变（GradientCycle 宿主分层，UI 线程流动变色）
 * + 手绘裂纹/高光覆盖层 + 呼吸缩放（reanimated，宿主 View）。
 */
export function HatchLogo({ size = 96, animated = true }: { size?: number; animated?: boolean }) {
    const scale = useSharedValue(1);

    useEffect(() => {
        if (!animated) return;
        scale.value = withRepeat(
            withSequence(
                withTiming(1.045, { duration: 1300 }),
                withTiming(1, { duration: 1300 }),
            ),
            -1,
        );
    }, [animated, scale]);

    const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

    const eggWidth = size * 0.72;

    return (
        <Animated.View style={style}>
            <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
                {/* 蛋形容器：上端全圆 + 下端缓收 → 蛋形剪裁，内部是流动的 6 色渐变 */}
                <View
                    style={{
                        width: eggWidth,
                        height: size,
                        overflow: 'hidden',
                        borderTopLeftRadius: eggWidth / 2,
                        borderTopRightRadius: eggWidth / 2,
                        borderBottomLeftRadius: size * 0.3,
                        borderBottomRightRadius: size * 0.3,
                    }}
                >
                    <GradientCycle
                        width={eggWidth}
                        height={size}
                        durationPerColor={1100}
                        style={{ position: 'absolute', top: 0, left: 0 }}
                    />
                </View>
                {/* 裂纹与高光：宿主 <Svg> 覆盖层（静态内容） */}
                <Svg
                    viewBox="0 0 48 48"
                    width={size}
                    height={size}
                    style={{ position: 'absolute', top: 0, left: 0 }}
                >
                    <Path
                        d="M9 25 L15 21 L19 27 L24 20 L29 27 L33 21 L39 25"
                        fill="none"
                        stroke="#0a0a0a"
                        strokeWidth={2.4}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    />
                    <Path
                        d="M17 12 C18.5 10 21 9 23 9"
                        fill="none"
                        stroke="#ffffff"
                        strokeOpacity={0.7}
                        strokeWidth={1.6}
                        strokeLinecap="round"
                    />
                </Svg>
            </View>
        </Animated.View>
    );
}
