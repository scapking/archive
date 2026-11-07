import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated as RNAnimated, PanResponder, Pressable, View } from 'react-native';
import type { PanResponderGestureState } from 'react-native';

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
 *
 * 水平拖拽换位（2026-11）：deck 容器挂 PanResponder，方向锁认领（|dx|>10 且
 * |dx|>1.5|dy| 才接管——纵向语义（长按重命名、误触抖动）不受伤）：
 * - 跟手：前卡 translateX 1:1 跟 dx（超过 PEEK 橡皮筋阻尼 0.3），后卡反向
 *   0.12 倍小跟手（露条宽度随拖拽联动，深度视差）；PanResponder 在 grant 时
 *   把 dx 重置为认领点起累计，卡片从认领点静止开始跟手（认领零跳变），
 *   提交阈值的 |dx| 即卡片实际跟手位移（触点起全程 ≈ +10~15px 认领距离）。
 * - 提交：松手 |dx|>60 → 复用既有 swap()（zIndex state 翻转 + 双卡 offset
 *   spring 到对方槽位），拖拽位移值 spring 归零与 swap 并行——前卡已拖近
 *   PEEK（提交阈值 60 ≈ 露条宽），松手后只做小幅"靠岸"，对卡扫入前位是主运动。
 * - 接管口径：手势只认领 **拖拽值**（stopAnimation 后由 setValue 接管，残量
 *   丢弃——残量重挂到新角色上会放大跳变）；offset 弹簧从不被手势 stop，
 *   恒向当前 state 目标收敛，快速连滑由「spring 替换语义 + 拖拽值收口」串行化，
 *   提交动画中途再拖立即可用。
 * - 点按吞噬：认领即抢占 responder（capture 声明），内层 Pressable 收到
 *   terminate 后 abort 点按——拖拽窗口内不会误触导航/换位；纯点按（无
 *   10px 水平位移）从不认领，点前卡导航 / 点露条换位 / 点后卡穿透不变。
 * - 动画铁律：拖拽只动 translateX（RN Animated native driver），zIndex 仍
 *   state 驱动；卡体 Pressable 零 className 不变。空态/单卡态不挂 deck
 *   （屏侧 noContent 走 EmptyState），滑动语义天然不存在。
 */
const PEEK = 76;
const SPRING_FRICTION = 8;

// 拖拽换位参数：认领阈值/方向锁比例、提交阈值、橡皮筋阻尼、后卡反向跟手系数
const PAN_CLAIM_DX = 10;
const PAN_CLAIM_RATIO = 1.5;
const PAN_COMMIT_DX = 60;
const PAN_RUBBER_RESIST = 0.3;
const PAN_BACK_FOLLOW = 0.12;

/** 超过 PEEK 的拖拽量按 0.3 倍阻尼（橡皮筋），其余 1:1 跟手。 */
function rubberBand(dx: number): number {
    const abs = Math.abs(dx);
    if (abs <= PEEK) return dx;
    return Math.sign(dx) * (PEEK + (abs - PEEK) * PAN_RUBBER_RESIST);
}

const AnimatedSlot = RNAnimated.createAnimatedComponent(View);

/** 本槽位是否处于前位（false = 后卡：内层按压体应让位给露条换位）。 */
const DeckSlotContext = createContext(false);

/** 卡内组件读取自己在前/后（封面等内层按压体的启停依据）。 */
export function useDeckSlotFront(): boolean {
    return useContext(DeckSlotContext);
}

/**
 * 槽位动效样式（插值节点 useMemo 固定）：0(在前) → 原位/原样，
 * 1(在后) → 右移 PEEK/微缩/降透明；dragX 追加一条 translateX（水平拖拽
 * 跟手通道，静止时恒 0，不改变槽位几何）。每次 render 新建 interpolate
 * 节点会触发 native 动画图重编组（手势窗口内的原生层扰动，#9），故节点
 * 只建一次、跨渲染复用；offset/dragX 均为 useRef 持有的稳定 Value，
 * 依赖恒不变（角色映射在 JS 手势层做，样式不依赖 aFront，重渲不重建）。
 */
function useSlotStyle(offset: RNAnimated.Value, dragX: RNAnimated.Value) {
    return useMemo(
        () => ({
            transform: [
                { translateX: offset.interpolate({ inputRange: [0, 1], outputRange: [0, PEEK] }) },
                { translateX: dragX },
                { scale: offset.interpolate({ inputRange: [0, 1], outputRange: [1, 0.95] }) },
            ],
            opacity: offset.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
        }),
        [offset, dragX],
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
    // 拖拽跟手值（按卡身份各一条，静止恒 0）：前卡 1:1 跟 dx、后卡反向 0.12 倍。
    // 角色映射在 JS 手势层按 aFrontRef 分派，样式不依赖前后 state（重渲不重建）
    const aDragX = useRef(new RNAnimated.Value(0)).current;
    const bDragX = useRef(new RNAnimated.Value(0)).current;
    // 前后关系（zIndex 与 isFront 判定）走 state：与动画值解耦；ref 镜像供
    // 一次性创建的 PanResponder 闭包读取（防陈旧闭包读错角色）
    const [aFront, setAFront] = useState(true);
    const aFrontRef = useRef(true);

    const swap = () => {
        const next = !aFrontRef.current;
        aFrontRef.current = next;
        setAFront(next);
        RNAnimated.parallel([
            RNAnimated.spring(aOffset, { toValue: next ? 0 : 1, friction: SPRING_FRICTION, useNativeDriver: true }),
            RNAnimated.spring(bOffset, { toValue: next ? 1 : 0, friction: SPRING_FRICTION, useNativeDriver: true }),
        ]).start();
    };

    useEffect(() => {
        aOffset.setValue(0);
        bOffset.setValue(1);
        aDragX.setValue(0);
        bDragX.setValue(0);
        aFrontRef.current = true;
        setAFront(true);
    }, [aOffset, bOffset, aDragX, bDragX]);

    // 手势图只建一次（同 useSlotStyle 口径）：闭包仅引用 ref/稳定 Value 与
    // 读取 ref 的 swap，不捕获任何随渲染变化的值
    const panResponder = useMemo(() => {
        // 角色分派：[前卡拖拽值, 后卡拖拽值]
        const dragPair = (): [RNAnimated.Value, RNAnimated.Value] =>
            aFrontRef.current ? [aDragX, bDragX] : [bDragX, aDragX];
        let claimed = false;
        // 方向锁认领（capture/bubble 双挂，capture 先行）：此阶段 gestureState.dx
        // 是触点起的全程累计（grant 时才重置），阈值即「触点起 |dx|>10」
        const claim = (g: PanResponderGestureState): boolean => {
            if (claimed) return true;
            const dx = Math.abs(g.dx);
            if (dx > PAN_CLAIM_DX && dx > Math.abs(g.dy) * PAN_CLAIM_RATIO) {
                claimed = true;
                return true;
            }
            return false;
        };
        // 认领接管：PanResponder 在 grant 时把 dx 重置为认领点起累计，卡片
        // 从认领点静止开始跟手（认领瞬间零跳变）。只接管拖拽值（stopAnimation
        // 后 setValue(0)，残量丢弃——残量重挂到翻转后的角色上会放大跳变）；
        // offset 弹簧不受手势干预，恒向当前 state 目标收敛
        const takeOver = () => {
            const [front, back] = dragPair();
            front.stopAnimation(() => front.setValue(0));
            back.stopAnimation(() => back.setValue(0));
        };
        // 跟手：前卡 1:1（超 PEEK 橡皮筋 0.3），后卡反向 0.12 倍（露条联动）
        const follow = (dx: number) => {
            const [front, back] = dragPair();
            const displaced = rubberBand(dx);
            front.setValue(displaced);
            back.setValue(-PAN_BACK_FOLLOW * displaced);
        };
        // 收口：拖拽值 spring 归零；提交时复用既有 swap（zIndex 翻转 + 双卡
        // offset spring 到对方槽位）。release 的 g.dx 是认领点起累计
        const settle = (committed: boolean) => {
            claimed = false;
            if (committed) swap();
            RNAnimated.parallel([
                RNAnimated.spring(aDragX, { toValue: 0, friction: SPRING_FRICTION, useNativeDriver: true }),
                RNAnimated.spring(bDragX, { toValue: 0, friction: SPRING_FRICTION, useNativeDriver: true }),
            ]).start();
        };
        return PanResponder.create({
            // 方向锁：认领 |dx|>10 且 |dx|>1.5|dy|（capture 声明——内层
            // Pressable 被 terminate 即 abort 未完成点按，拖拽吞点按）；
            // 纯点按从不认领：panHandlers 的 start 声明在无 Pan start 回调时
            // 恒 false，点前卡导航 / 点露条换位 / 点后卡穿透全部原样。
            onMoveShouldSetPanResponder: (_e, g) => claim(g),
            onMoveShouldSetPanResponderCapture: (_e, g) => claim(g),
            onPanResponderGrant: () => takeOver(),
            onPanResponderMove: (_e, g) => follow(g.dx),
            onPanResponderRelease: (_e, g) => settle(Math.abs(g.dx) > PAN_COMMIT_DX),
            onPanResponderTerminate: () => settle(false),
            // 认领被现任 responder 拒绝（如长按重命名保持中）：没有 grant/
            // release 链，claimed 旗标必须就地复位，否则下次手势会绕过方向锁
            onPanResponderReject: () => {
                claimed = false;
            },
            // 已认领的拖拽不让位给普通竞争者；系统强夺由 terminate 兜底归位
            onPanResponderTerminationRequest: () => false,
        });
    }, [aDragX, bDragX, aOffset, bOffset]);

    const aStyle = useSlotStyle(aOffset, aDragX);
    const bStyle = useSlotStyle(bOffset, bDragX);

    // 卡槽：left 0 / right PEEK；后卡 translateX(PEEK) 后右缘对齐容器，露条可点
    const slot = useMemo(
        () => ({ position: 'absolute' as const, top: 0, bottom: 0, left: 0, right: PEEK }),
        [],
    );

    return (
        // PanResponder 挂容器（水平拖拽换位，方向锁见文件头）：纯点按不认领，
        // 内层卡体 Pressable 的全部点按语义不受影响
        <View className="relative" style={{ height, paddingRight: 0 }} {...panResponder.panHandlers}>
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
