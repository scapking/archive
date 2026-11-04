import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useDerivedValue,
    useSharedValue,
    withRepeat,
    withTiming,
    type SharedValue,
} from 'react-native-reanimated';
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg';

/**
 * 循环变色渐变（宿主分层方案）。
 *
 * ⚠️ 为什么不是"SVG 内部自驱"：SDK 58 的 react-native-svg 不再导出 SMIL
 * （Animate/AnimateTransform），而 reanimated v4 进不了 SVG 内部节点
 * （非宿主组件，会抛 Cannot find host instance——真机踩过）。
 * 因此这里用宿主分层交叉淡化：每层是独立的宿主 <Svg>（静态三色渐变），
 * reanimated 在 **UI 线程**驱动各层 opacity 循环交叉淡化——
 * 视觉即"渐变在流动变色"，无 JS 逐帧，60fps，三端一致。
 */
export const HATCH_PALETTE = ['#34d399', '#22d3ee', '#60a5fa', '#818cf8', '#c084fc', '#f472b6'];

interface GradientLayerProps {
    colors: [string, string, string];
    index: number;
    count: number;
    progress: SharedValue<number>;
    width: number;
    height: number;
}

function GradientLayer({ colors, index, count, progress, width, height }: GradientLayerProps) {
    const opacity = useDerivedValue(() => {
        const slot = (progress.value * count - index) % count;
        return Math.max(0, 1 - slot);
    });
    const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
    const gradientId = `gradient-cycle-${index}`;

    return (
        <Animated.View style={[StyleSheet.absoluteFill, style]}>
            <Svg
                viewBox={`0 0 ${width} ${height}`}
                width="100%"
                height="100%"
                preserveAspectRatio="none"
            >
                <Defs>
                    <LinearGradient id={gradientId} x1={0} y1={0} x2={width} y2={height}>
                        <Stop offset="0%" stopColor={colors[0]} />
                        <Stop offset="55%" stopColor={colors[1]} />
                        <Stop offset="100%" stopColor={colors[2]} />
                    </LinearGradient>
                </Defs>
                <Rect x={0} y={0} width={width} height={height} fill={`url(#${gradientId})`} />
            </Svg>
        </Animated.View>
    );
}

export function GradientCycle({
    colors = HATCH_PALETTE,
    width = 320,
    height = 8,
    durationPerColor = 900,
    borderRadius,
    style,
}: {
    colors?: string[];
    width?: number;
    height?: number;
    /** 每个颜色档位的停留时长（ms） */
    durationPerColor?: number;
    borderRadius?: number;
    style?: object;
}) {
    const count = colors.length;
    const progress = useSharedValue(0);

    useEffect(() => {
        progress.value = withRepeat(
            withTiming(1, { duration: durationPerColor * count, easing: Easing.linear }),
            -1,
            false,
        );
    }, [count, durationPerColor, progress]);

    return (
        <View
            style={[
                { width, height, overflow: 'hidden' },
                borderRadius !== undefined ? { borderRadius } : {},
                style,
            ]}
        >
            {colors.map((color, index) => (
                <GradientLayer
                    key={color}
                    colors={[
                        color,
                        colors[(index + 1) % count],
                        colors[(index + 2) % count],
                    ]}
                    index={index}
                    count={count}
                    progress={progress}
                    width={width}
                    height={height}
                />
            ))}
        </View>
    );
}
