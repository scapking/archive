import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated as RNAnimated, Pressable, View } from 'react-native';

/**
 * 重叠若隐若现双卡（archive 首页）：卡宽 = 容器−PEEK，后卡右移 PEEK 露出
 * 一条可点区域（缩放 + 降透明）。点前卡 → onPressCard(id, true) 直接打开内容；
 * 点后卡（露出的那条）→ 交换前后（spring）。两张卡固定身份：日记 / 行程。
 *
 * 几何铁律：前卡 right=PEEK 留出露条，后卡 translateX=PEEK 对齐右缘——
 * 露条必须真实可点（前卡 zIndex 高但不覆盖该区域）。两卡高度由槽位
 * top/bottom 0 恒等（前卡即基准，露条几何不随内容高度变化）。
 *
 * 结构铁律：**zIndex 用 React state 驱动（静态 style），禁止写进动画值**；
 * 动画底层 = **RN 内置 Animated（native driver）**——reanimated 在 Fabric 上
 * 驱动样式会使同视图触摸概率性失效（Expo Go 实测，见 BouncyPressable 注释）。
 *
 * 静态 key 收口（P0 审计）：槽位几何（absolute inset）与 zIndex 全部挂在普通
 * wrapper View 上（zIndex 仍由 state 派生，铁律不变）；AnimatedSlot 的 style
 * 只留 `flex: 1` + transform/opacity（native driver 白名单键，flex/opacity/
 * transform 均在 NativeAnimatedAllowlist 的常驻区，position/width 等布局键
 * 只在 shared animated backend 旗标下可用——不可回填）。flex: 1 是唯一保留
 * 的静态布局键，把 wrapper 的定尺寸主轴直接分给槽位；卡体 Pressable 同样用
 * flex: 1 填充（不用 h-full 百分比）——整条「wrapper → AnimatedSlot → 卡体」
 * 尺寸链全部走 flex 分配，不依赖任何一层的百分比基准解析，命中区与视觉
 * frame 由同一份 Yoga 布局给出，结构上不可能错位/塌 0。
 *
 * 触摸面纯净（#9 前卡点击失效回归修复，2026-11）：卡体 Pressable **零
 * className**——上一轮加的 `active:opacity-90` 会让 css-interop 在按压体上
 * 注入按压 observable（onPressIn → dispatch → 重渲 + style commit），手势
 * DOWN..UP 窗口内在触摸面上跑 JS 状态机，与父级 native-driven 动画变换叠加
 * 后在 Fabric/Expo Go 上概率性吞点击（与本仓库已两次归档的「UI 线程样式
 * 更新杀触摸」同类：reanimated 驱动样式失效、RN Modal 触摸失效）。deck 卡
 * 是导航关键面，按压反馈让位给触摸可靠性：内层封面自带 BouncyPressable
 * 反馈，卡体不再做按压视觉。同理，插值节点经 useSlotStyle 以 useMemo 固定
 * ——deck 任意重渲不再重建 native 动画图（旧实现每次 render 新建
 * interpolate 节点，重挂载/重编组发生在 AnimatedSlot 上，同为手势窗口内
 * 的原生层扰动源）。
 *
 * 卡内按压体启停（#3 垂直重构新增）：卡片内容可能自带按压体（封面 → 屏级
 * 预览）。后卡的封面右缘落在露条命中区，若保持可按会抢走「点露条换位」——
 * 因此 deck 经 DeckSlotContext 广播本槽位是否在前，卡内按压体在后位时
 * 自行让位（onPress 置空 → 非响应体，触摸穿透到 deck 卡 Pressable）。
 * 「置空即穿透」依赖 BouncyPressable 的 disabled 传导（2026-11 修复：仅置空
 * 回调时 Pressable 仍抢 responder，露条曾是死区；现非交互态显式传导
 * disabled=true，本注释描述的行为才真实成立，见 bouncy-pressable 文件头）。
 */
const PEEK = 76;
const SPRING_FRICTION = 8;

const AnimatedSlot = RNAnimated.createAnimatedComponent(View);

/** 本槽位是否处于前位（false = 后卡：内层按压体应让位给露条换位）。 */
const DeckSlotContext = createContext(false);

/** 卡内组件读取自己在前/后（封面等内层按压体的启停依据）。 */
export function useDeckSlotFront(): boolean {
    return useContext(DeckSlotContext);
}

/**
 * 槽位动效样式（插值节点 useMemo 固定）：0(在前) → 原位/原样，
 * 1(在后) → 右移 PEEK/微缩/降透明。每次 render 新建 interpolate 节点会
 * 触发 native 动画图重编组（手势窗口内的原生层扰动，#9），故节点只建一次、
 * 跨渲染复用；offset 是 useRef 持有的稳定 Value，依赖恒不变。
 */
function useSlotStyle(offset: RNAnimated.Value) {
    return useMemo(
        () => ({
            transform: [
                { translateX: offset.interpolate({ inputRange: [0, 1], outputRange: [0, PEEK] }) },
                { scale: offset.interpolate({ inputRange: [0, 1], outputRange: [1, 0.95] }) },
            ],
            opacity: offset.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
        }),
        [offset],
    );
}

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
    const aOffset = useRef(new RNAnimated.Value(0)).current; // 0=在前，1=在后
    const bOffset = useRef(new RNAnimated.Value(1)).current;
    // 前后关系（zIndex 与 isFront 判定）走 state：与动画值解耦
    const [aFront, setAFront] = useState(true);

    const swap = () => {
        const next = !aFront;
        setAFront(next);
        RNAnimated.parallel([
            RNAnimated.spring(aOffset, { toValue: next ? 0 : 1, friction: SPRING_FRICTION, useNativeDriver: true }),
            RNAnimated.spring(bOffset, { toValue: next ? 1 : 0, friction: SPRING_FRICTION, useNativeDriver: true }),
        ]).start();
    };

    useEffect(() => {
        aOffset.setValue(0);
        bOffset.setValue(1);
        setAFront(true);
    }, [aOffset, bOffset]);

    const aStyle = useSlotStyle(aOffset);
    const bStyle = useSlotStyle(bOffset);

    // 卡槽：left 0 / right PEEK；后卡 translateX(PEEK) 后右缘对齐容器，露条可点
    const slot = useMemo(
        () => ({ position: 'absolute' as const, top: 0, bottom: 0, left: 0, right: PEEK }),
        [],
    );

    return (
        <View className="relative" style={{ height, paddingRight: 0 }}>
            {/* 卡槽三层：普通 wrapper（静态几何 + state 驱动 zIndex）→ AnimatedSlot
                （flex:1 撑满 + transform/opacity 动画）→ 卡 Pressable（flex:1 填充，
                零 className——触摸面纯净铁律见文件头）。静态 key 收口依据见文件头注 */}
            <View style={[slot, { zIndex: aFront ? 1 : 2 }]}>
                <AnimatedSlot style={[{ flex: 1 }, bStyle]}>
                    <Pressable
                        onPress={() => {
                            if (aFront) swap();
                            else onPressCard(b.id, true);
                        }}
                        // 无按压视觉（触摸面纯净，#9）；命中区 = 槽位 frame 经
                        // translateX 变换后的实际可视区，露条恒在其中
                        style={{ flex: 1 }}
                        accessibilityLabel="行程卡"
                    >
                        <DeckSlotContext.Provider value={!aFront}>{b.node}</DeckSlotContext.Provider>
                    </Pressable>
                </AnimatedSlot>
            </View>
            <View style={[slot, { zIndex: aFront ? 2 : 1 }]}>
                <AnimatedSlot style={[{ flex: 1 }, aStyle]}>
                    <Pressable
                        onPress={() => {
                            if (aFront) onPressCard(a.id, true);
                            else swap();
                        }}
                        style={{ flex: 1 }}
                        accessibilityLabel="日记卡"
                    >
                        <DeckSlotContext.Provider value={aFront}>{a.node}</DeckSlotContext.Provider>
                    </Pressable>
                </AnimatedSlot>
            </View>
        </View>
    );
}
