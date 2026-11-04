import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

/**
 * 重叠若隐若现双卡（archive 首页）：卡宽 = 容器−PEEK，后卡右移 PEEK 露出
 * 一条可点区域（缩放 + 降透明）。点前卡 → onPressCard(id, true) 直接打开内容；
 * 点后卡（露出的那条）→ 交换前后（spring，UI 线程）。两张卡固定身份：日记 / 行程。
 *
 * 几何铁律：前卡 right=PEEK 留出露条，后卡 translateX=PEEK 对齐右缘——
 * 露条必须真实可点（前卡 zIndex 高但不覆盖该区域）。
 */
const PEEK = 76;
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
    const aOffset = useSharedValue(0); // 0=在前，1=在后
    const bOffset = useSharedValue(1);

    const swap = () => {
        const aNowFront = aOffset.value > 0.5;
        aOffset.value = withSpring(aNowFront ? 0 : 1, SPRING);
        bOffset.value = withSpring(aNowFront ? 1 : 0, SPRING);
    };

    useEffect(() => {
        aOffset.value = 0;
        bOffset.value = 1;
    }, [aOffset, bOffset]);

    const aStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: aOffset.value * PEEK }, { scale: 1 - aOffset.value * 0.05 }],
        opacity: 1 - aOffset.value * 0.55,
        zIndex: aOffset.value < 0.5 ? 2 : 1,
    }));
    const bStyle = useAnimatedStyle(() => ({
        transform: [{ translateX: bOffset.value * PEEK }, { scale: 1 - bOffset.value * 0.05 }],
        opacity: 1 - bOffset.value * 0.55,
        zIndex: bOffset.value < 0.5 ? 2 : 1,
    }));

    // 卡槽：left 0 / right PEEK；后卡 translateX(PEEK) 后右缘对齐容器，露条可点
    const slot = { position: 'absolute' as const, top: 0, bottom: 0, left: 0, right: PEEK };

    return (
        <View className="relative" style={{ height, paddingRight: 0 }}>
            <Animated.View style={[slot, bStyle]}>
                <Pressable
                    onPress={() => {
                        const isFront = bOffset.value < 0.5;
                        if (isFront) onPressCard(b.id, true);
                        else swap();
                    }}
                    className="h-full w-full"
                    accessibilityLabel="行程卡"
                >
                    {b.node}
                </Pressable>
            </Animated.View>
            <Animated.View style={[slot, aStyle]}>
                <Pressable
                    onPress={() => {
                        const isFront = aOffset.value < 0.5;
                        if (isFront) onPressCard(a.id, true);
                        else swap();
                    }}
                    className="h-full w-full"
                    accessibilityLabel="日记卡"
                >
                    {a.node}
                </Pressable>
            </Animated.View>
        </View>
    );
}
