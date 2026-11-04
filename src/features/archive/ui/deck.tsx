import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

/**
 * 重叠若隐若现双卡（archive 首页）：前卡居中完整呈现，后卡右侧探出一角
 * （缩放 + 降透明 + 下沉）。点前卡 → onPressCard(id, true) 直接打开内容；
 * 点后卡 → 交换前后（spring，UI 线程）并通知。两张卡固定身份：日记 / 行程。
 */
const SPRING = { duration: 400, dampingRatio: 0.82 };

export function CardDeck({
    a,
    b,
    height = 430,
    onPressCard,
}: {
    a: { id: string; node: React.ReactNode };
    b: { id: string; node: React.ReactNode };
    height?: number;
    /** isFront=true 时点击语义为"打开内容"；false 时由 deck 内部交换前后。 */
    onPressCard(id: string, isFront: boolean): void;
}) {
    // aFront: A 卡是否在前
    const aOffset = useSharedValue(0);
    const bOffset = useSharedValue(1);
    const aFrontRef = { current: true };

    const swap = () => {
        const next = aOffset.value > 0.5;
        aFrontRef.current = next;
        aOffset.value = withSpring(next ? 0 : 1, SPRING);
        bOffset.value = withSpring(next ? 1 : 0, SPRING);
        return next;
    };

    useEffect(() => {
        aOffset.value = 0;
        bOffset.value = 1;
    }, [aOffset, bOffset]);

    const aStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: aOffset.value * 78 },
            { scale: 1 - aOffset.value * 0.07 },
            { translateY: aOffset.value * 14 },
        ],
        opacity: 1 - aOffset.value * 0.6,
        zIndex: aOffset.value < 0.5 ? 2 : 1,
    }));
    const bStyle = useAnimatedStyle(() => ({
        transform: [
            { translateX: bOffset.value * 78 },
            { scale: 1 - bOffset.value * 0.07 },
            { translateY: bOffset.value * 14 },
        ],
        opacity: 1 - bOffset.value * 0.6,
        zIndex: bOffset.value < 0.5 ? 2 : 1,
    }));

    const handleA = () => {
        const isFront = aOffset.value < 0.5;
        if (isFront) onPressCard(a.id, true);
        else {
            swap();
            onPressCard(a.id, false);
        }
    };
    const handleB = () => {
        const isFront = bOffset.value < 0.5;
        if (isFront) onPressCard(b.id, true);
        else {
            swap();
            onPressCard(b.id, false);
        }
    };

    return (
        <View className="relative" style={{ height }}>
            <Animated.View style={[{ position: 'absolute', inset: 0 }, bStyle]}>
                <Pressable onPress={handleB} accessibilityLabel="卡片" className="h-full w-full">
                    {b.node}
                </Pressable>
            </Animated.View>
            <Animated.View style={[{ position: 'absolute', inset: 0 }, aStyle]}>
                <Pressable onPress={handleA} accessibilityLabel="卡片" className="h-full w-full">
                    {a.node}
                </Pressable>
            </Animated.View>
        </View>
    );
}
