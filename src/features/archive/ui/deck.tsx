import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated as RNAnimated, PanResponder, Pressable, Text, View } from 'react-native';
import type { PanResponderGestureState } from 'react-native';

/**
 * 重叠露条多卡 deck（archive 首页 + /notes、/trips 共用）：**原双卡 deck 的
 * N 卡泛化**（2026-11-19 用户指令「首页保持之前的 ui 但是扩展支持多卡片」）——
 * 卡宽 = 容器−PEEK；前卡全显，背卡按层位右移（每层 STRIDE=24px）在右侧露条
 * 形成堆叠边（层位超出的卡淡出）；点前卡 → onFrontPress（打开内容），点背卡
 * 露条 → 该卡提前到前位（环形），左右拖拽跟手、松手过阈值翻卡。
 *
 * 几何铁律（原 deck 沿用）：前卡 right=PEEK 留出露条；背卡 translateX =
 * depth×STRIDE，右侧三条 24px 堆叠边（不越容器右缘：72 ≤ PEEK）。两卡高度由
 * 槽位 top/bottom 0 恒等，height prop 定 deck 高（首页 430 原样；/notes、/trips
 * 520 长卡——互不影响）。
 *
 * 结构铁律（原 deck 沿用）：**zIndex 用 React state 驱动（静态 style），禁止
 * 写进动画值**；动画底层 = **RN 内置 Animated（native driver）**——reanimated
 * 在 Fabric 上驱动样式会使同视图触摸概率性失效；卡体 Pressable **零
 * className**（触摸面纯净：按压 observable 在触摸面跑 JS 状态机 + native 动画
 * 叠加会概率性吞点击，deck 是导航关键面，按压反馈让位给触摸可靠性）；插值
 * 节点经 useMemo 固定（重渲不重建 native 动画图）；Animated.Value 经 key 惰性
 * 注册表持有（N 卡非 hook）。
 *
 * 页码（2026-11-19 用户指令「卡片容器的一部分」）：页码 = 卡容器的最后一个
 * 子元素（卡底内部居中裸数字，`X / N`），随卡面同底色——不是覆盖层/悬浮物。
 *
 * 手势（原 deck 沿用）：PanResponder 方向锁认领（|dx|>10 且 |dx|>1.5|dy|）——
 * 纵向语义（卡面长按菜单、误触抖动）不受伤；纯点按从不认领（点卡语义全保）；
 * 认领即抢占（capture 声明，内层 Pressable 收到 terminate 即 abort 未完成点
 * 按）；拖拽只动 translateX（跟手值），松手 |dx|>60 提交（左滑下一张 / 右滑
 * 上一张，环形），否则弹回。
 *
 * 手感调优（2026-11-19，用户反馈左右滑动卡顿不丝滑；本环境无法真机验证，
 * 以「结构正确 + 参数合理」交付）：①弹簧 friction 8 → 11（收尾更快，区间
 * 依据见常量注）；②settle 收敛面从 O(N) 收窄到 O(可见层)（grant 已全量归零，
 * 逐卡 spring 纯开销）；③插值输入区间收窄到实际值域 0..2（死段清除）。
 * move 通道「只 setValue 不 stop」的原纪律保持并加注（高频回调里 stopAnimation
 * 打断 native 弹簧图会跳帧）；reanimated 与动画化 zIndex 均不引入（仓库铁律）。
 *
 * **InteractionManager 交互句柄项不适用**（调优清单原第 4 项）：RN 0.88
 * （SDK 58）已把 InteractionManager 从 react-native core 移除（index.js 运行
 * 时 invariant 报错，官方指引改用 requestIdleCallback）——全局交互队列不复
 * 存在，「防全局动画卡顿指标污染」目标随之失效；本 deck 拖拽链路 move 只做
 * setValue（JS 侧零调度、动画全 native），本就不构成 JS 线程长任务，故不加
 * 等价物（为不存在的能力建 polyfill 属过度工程）。
 */

export interface DeckItem {
    /** 稳定 key（动画值注册表 + React key）。 */
    key: string;
    /** 卡面（原 deck 卡样式由调用方组装；卡体 Pressable 由本组件承担）。 */
    node: React.ReactNode;
    /** 点前卡（背卡点按 = 提前到前位，不经此回调）。 */
    onPress?(): void;
    /** 长按前卡（操作菜单入口；整个卡面任何位置长按可达——卡面内部按压体
     *  自带长按语义时内层优先，deck 层是兜底覆盖面）。 */
    onLongPress?(): void;
    /** 前卡无障碍标签（选填）。 */
    accessibilityLabel?: string;
    /** 页码色调（选填）：light = 白（渐变类卡面），缺省 muted（素面卡面）。 */
    pageLabelTone?: 'light' | 'muted';
}

const PEEK = 76;
/**
 * 弹簧摩擦系数（2026-11-19 手感调优）：原 8 偏肉——拖拽松手后的回弹与翻卡
 * 层位动画收敛慢（低 friction = 长时间过冲振荡，观感「拖泥带水」）。在 10~12
 * 试验区间取 11（中位档）：friction 增大 = 弹簧更快静止、过冲更少，跟手拖拽
 * 的收尾更干脆；stiffness 未动（RN spring 默认），避免快到发硬。真机手感无法
 * 在本环境验证，此参数为结构正确下的合理档位，不丝滑可在 10~12 内微调。
 */
const SPRING_FRICTION = 11;
/**
 * 可见层数 = 1（2026-11-19 用户指令「只要两个，左右堆叠，不显示过深的堆叠」）：
 * 前卡全显 + 一张背卡按原双卡几何右移 PEEK（露条 = 原版 76px 宽），更深的卡
 * 一律淡出——回到原版两卡观感。
 */
const VISIBLE_DEPTH = 1;
/** 隐藏层位（超出可见深度的收敛目标：完全淡出）。 */
const DECK_HIDDEN = VISIBLE_DEPTH + 1;
/** 拖拽参数（原 deck 沿用）：认领阈值/方向锁比例、提交阈值、橡皮筋阻尼、背卡视差。 */
const PAN_CLAIM_DX = 10;
const PAN_CLAIM_RATIO = 1.5;
const PAN_COMMIT_DX = 60;
const PAN_RUBBER_START = 80;
const PAN_RUBBER_RESIST = 0.3;
const PAN_BACK_FOLLOW = 0.12;

/** 超过起点的拖拽量按阻尼收敛（橡皮筋），其余 1:1 跟手。 */
function rubberBand(dx: number): number {
    const abs = Math.abs(dx);
    if (abs <= PAN_RUBBER_START) return dx;
    return Math.sign(dx) * (PAN_RUBBER_START + (abs - PAN_RUBBER_START) * PAN_RUBBER_RESIST);
}

const AnimatedSlot = RNAnimated.createAnimatedComponent(View);

/** 每卡动画值注册表条目：depth = 层位（0 = 前卡），dragX = 拖拽跟手通道。 */
interface DeckValues {
    depth: RNAnimated.Value;
    dragX: RNAnimated.Value;
    /** 首轮定位标记：false = 尚未落位（首帧 setValue 不播飞行）。 */
    placed: boolean;
}

export function CardDeck({
    items,
    height = 430,
    emptyState,
}: {
    items: DeckItem[];
    /** deck 高度（首页 430 原样；/notes、/trips 传 520 长卡，互不影响）。 */
    height?: number;
    /** 卡序列为空时的占位（空态是行动邀请，由调用方给方向）。 */
    emptyState?: React.ReactNode;
}) {
    // 前卡下标（环形）；ref 镜像供一次性创建的 PanResponder 闭包读取（原 deck
    // aFrontRef 同款防陈旧闭包）
    const [index, setIndex] = useState(0);
    const indexRef = useRef(0);
    indexRef.current = index;
    const itemsRef = useRef(items);
    itemsRef.current = items;
    // 越界自愈：卡序列收缩后把前卡指针收回首张
    useEffect(() => {
        if (index >= items.length && items.length > 0) setIndex(0);
    }, [index, items.length]);

    // 每卡动画值注册表（key 惰性创建，渲染期幂等；卡卸载后条目留存——会话级小对象）
    const valuesRef = useRef(new Map<string, DeckValues>());
    const getValues = (key: string): DeckValues => {
        let entry = valuesRef.current.get(key);
        if (!entry) {
            entry = {
                depth: new RNAnimated.Value(DECK_HIDDEN),
                dragX: new RNAnimated.Value(0),
                placed: false,
            };
            valuesRef.current.set(key, entry);
        }
        return entry;
    };

    // 层位定位：index 或卡序列变化时每卡 spring 到目标层位（pos = 环形距离：
    // 0 前卡 / 1..VISIBLE_DEPTH 背卡露条 / 超出 = 隐藏）。首帧 setValue 直接
    // 落位（placed 标记），之后 spring（翻卡动画通道）。
    useEffect(() => {
        const animations: RNAnimated.CompositeAnimation[] = [];
        items.forEach((item, i) => {
            const pos = Math.min((i - index + items.length) % items.length, DECK_HIDDEN);
            const entry = getValues(item.key);
            if (!entry.placed) {
                entry.placed = true;
                entry.depth.setValue(pos);
                return;
            }
            animations.push(
                RNAnimated.spring(entry.depth, { toValue: pos, friction: SPRING_FRICTION, useNativeDriver: true }),
            );
        });
        if (animations.length > 0) RNAnimated.parallel(animations).start();
        // items 引用变化（数据重载）与 index 翻转共用同一重定位通道
    }, [index, items]);

    // 认领旗标（PanResponder 各回调间跨调用存活，原 deck 闭包内 let 同语义）
    const claimedFlag = useRef(false);
    const claim = (g: PanResponderGestureState): boolean => {
        if (claimedFlag.current) return true;
        const dx = Math.abs(g.dx);
        if (dx > PAN_CLAIM_DX && dx > Math.abs(g.dy) * PAN_CLAIM_RATIO) {
            claimedFlag.current = true;
            return true;
        }
        return false;
    };
    // 收口：提交翻卡（dir = 0 不翻）+ 本手势动过的卡拖拽值弹回零（层位重定位
    // spring 由 index effect 并行接管，depth 弹簧从不被手势 stop——原 deck 同款）
    const settle = (direction: number) => {
        claimedFlag.current = false;
        if (direction !== 0) {
            const len = itemsRef.current.length;
            if (len > 0) setIndex((indexRef.current + direction + len) % len);
        }
        // 只收敛本手势动过的卡（2026-11-19 调优：原实现遍历注册表逐卡 spring，
        // N 卡泛化后每次松手挂 O(N) 个 native 弹簧——grant 已把全部 dragX stop
        // 并归零，move 只写前卡与可见背卡窗口，其余卡 dragX 恒 0，对其 spring
        // 是纯开销）。收敛面 O(可见层) = 1 前卡 + VISIBLE_DEPTH 背卡
        const i = indexRef.current;
        const movedKeys: string[] = [];
        const front = itemsRef.current[i];
        if (front) movedKeys.push(front.key);
        for (let k = 1; k <= VISIBLE_DEPTH; k++) {
            const back = itemsRef.current[i + k];
            if (back) movedKeys.push(back.key);
        }
        const springs: RNAnimated.CompositeAnimation[] = [];
        for (const key of movedKeys) {
            const entry = valuesRef.current.get(key);
            if (entry) {
                springs.push(RNAnimated.spring(entry.dragX, { toValue: 0, friction: SPRING_FRICTION, useNativeDriver: true }));
            }
        }
        if (springs.length > 0) RNAnimated.parallel(springs).start();
    };

    // 手势图只建一次（闭包只引 ref 与稳定函数；原 deck 同款恒定依赖）
    const panResponder = useMemo(
        () =>
            PanResponder.create({
                onMoveShouldSetPanResponder: (_e, g: PanResponderGestureState) => claim(g),
                onMoveShouldSetPanResponderCapture: (_e, g: PanResponderGestureState) => claim(g),
                onPanResponderGrant: () => {
                    // 认领即接管拖拽通道：停掉在途的 dragX 弹簧并归零（只在 grant
                    // 做，move 通道纪律 = 只 setValue 不 stop——move 高频回调里
                    // stopAnimation 会打断 native 弹簧图造成跳帧）
                    for (const entry of valuesRef.current.values()) {
                        entry.dragX.stopAnimation(() => entry.dragX.setValue(0));
                    }
                },
                onPanResponderMove: (_e, g) => {
                    const i = indexRef.current;
                    const displaced = rubberBand(g.dx);
                    const front = itemsRef.current[i];
                    if (front) valuesRef.current.get(front.key)?.dragX.setValue(displaced);
                    for (let k = 1; k <= VISIBLE_DEPTH; k++) {
                        const back = itemsRef.current[i + k];
                        if (back) valuesRef.current.get(back.key)?.dragX.setValue(-PAN_BACK_FOLLOW * displaced);
                    }
                },
                onPanResponderRelease: (_e, g) => {
                    settle(Math.abs(g.dx) > PAN_COMMIT_DX ? (g.dx < 0 ? 1 : -1) : 0);
                },
                onPanResponderTerminate: () => settle(0),
                onPanResponderReject: () => {
                    // 认领被拒：grant 从未执行，无句柄可清，只复位旗标
                    claimedFlag.current = false;
                },
                // 已认领的拖拽不让位给普通竞争者；系统强夺由 terminate 兜底归位
                onPanResponderTerminationRequest: () => false,
            }),
        [],
    );

    // 背卡露条点按 = 该卡提前到前位（环形前进 k 层）
    const advance = (k: number) => {
        const len = itemsRef.current.length;
        if (len > 0) setIndex((indexRef.current + k) % len);
    };

    if (items.length === 0) {
        return <View className="items-center justify-center" style={{ height }}>{emptyState}</View>;
    }

    return (
        // PanResponder 挂容器：纯点按不认领，内层卡体 Pressable 的全部点按语义不受影响
        <View>
            <View className="relative" style={{ height }} {...panResponder.panHandlers}>
                {/* 卡槽：每卡一层（left 0 / right PEEK + 层位右移），普通 wrapper 承担
                    静态几何 + state 驱动 zIndex；AnimatedSlot 只挂 transform/opacity
                    （native driver 白名单键，原 deck 静态 key 收口铁律不变） */}
                {items.map((item, i) => {
                    const depth = (i - index + items.length) % items.length;
                    const values = getValues(item.key);
                    return (
                        <DeckCardLayer
                            key={item.key}
                            item={item}
                            values={values}
                            depth={depth}
                            total={items.length}
                            pageLabel={`${index + 1} / ${items.length}`}
                            onAdvance={advance}
                        />
                    );
                })}
            </View>
        </View>
    );
}

/**
 * 单卡层：普通 wrapper（静态几何 + state 驱动 zIndex）→ AnimatedSlot（flex:1 +
 * transform/opacity 动画）→ 卡 Pressable（flex:1 填充，零 className——触摸面
 * 纯净铁律）。前卡点按 = item.onPress（打开内容）；背卡点按 = 提前到前位
 * （环形；原 deck「点露条换位」的 N 卡语义）。背卡对触摸透明由 wrapper
 * pointerEvents="none" 承担？——**否**：背卡露条必须可点（提前到前位），故
 * 背卡 Pressable 保持可按（露条命中区 = 层位右移后露出的右缘窄条，与原 deck
 * 露条命中区同机制）；卡内深层内容（封面/文字区按压体）由卡面自理。
 */
function DeckCardLayer({
    item,
    values,
    depth,
    total,
    pageLabel,
    onAdvance,
}: {
    item: DeckItem;
    values: DeckValues;
    depth: number;
    total: number;
    /** 页码文案（前卡消费；全卡同值，仅前卡可见）。 */
    pageLabel: string;
    /** 背卡露条点按：该卡提前到前位（k = 层位）。 */
    onAdvance(k: number): void;
}) {
    // 插值节点 useMemo 固定（原 deck useSlotStyle 同款防重建）：depth 0..2 →
    // 右移 / 原缩放降透明语言（原 deck 背卡 scale 0.95 + opacity 0.45 的分层化）；
    // dragX 追加一条 translateX（跟手通道，静止恒 0）。2026-11-19 调优：输入
    // 区间从原 0..4 收窄到实际值域 0..DECK_HIDDEN(2)——层位定位经 Math.min 收敛
    // 恒不出 2，区间尾巴 3/4 是插值图里的死段；每卡 native 节点数不增不减，
    // 区间收窄只瘦插值表达式（结构上再省节点会牺牲视觉分层，不做）
    const layerStyle = useMemo(
        () => ({
            transform: [
                {
                    // 背卡右移 = PEEK（原双卡几何：露条宽 76px，左右堆叠）；更深
                    // 层位保持 PEEK（不可见，仅作淡出目标）
                    translateX: values.depth.interpolate({
                        inputRange: [0, 1, DECK_HIDDEN],
                        outputRange: [0, PEEK, PEEK],
                    }),
                },
                { translateX: values.dragX },
                {
                    scale: values.depth.interpolate({
                        inputRange: [0, 1, DECK_HIDDEN],
                        outputRange: [1, 0.95, 0.9],
                    }),
                },
            ],
            opacity: values.depth.interpolate({
                inputRange: [0, 1, DECK_HIDDEN],
                outputRange: [1, 0.45, 0],
            }),
        }),
        [values],
    );
    const slot = useMemo(
        () => ({ position: 'absolute' as const, top: 0, bottom: 0, left: 0, right: PEEK }),
        [],
    );

    return (
        <View style={[slot, { zIndex: total - depth }]}>
            <AnimatedSlot style={[{ flex: 1 }, layerStyle]}>
                <Pressable
                    onPress={depth === 0 ? item.onPress : () => onAdvance(depth)}
                    onLongPress={depth === 0 ? item.onLongPress : undefined}
                    style={{ flex: 1 }}
                    accessibilityLabel={depth === 0 ? (item.accessibilityLabel ?? '当前卡片') : '下一张卡片'}
                >
                    {/* 卡容器（deck 统一绘制 surface 圆角壳——调用方卡面不再自带
                        卡壳）+ **页码为卡容器的最后一个子元素**（2026-11-19 用户
                        指令「卡片容器的一部分，不是悬浮窗口」：页码嵌在卡底内部
                        居中，裸数字随卡面同底色，非覆盖层）；pointerEvents none
                        不挡卡面触摸 */}
                    <View className="h-full w-full flex-1 flex-col overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                        {/* 卡面铺满整卡（flex-1 占满壳）——渐变类卡面的颜色自然
                            延伸到卡底，页码叠加其上同属一块渐变（2026-11-20 用户
                            指令「整个容器一致颜色，页码包裹在渐变里」） */}
                        <View className="min-h-0 flex-1">{item.node}</View>
                        {/* 页码 = 卡底内侧居中叠加（非独立行）：色调随卡面
                            pageLabelTone（渐变白 / 素面 muted），pointerEvents
                            none 不挡卡面触摸 */}
                        <View
                            pointerEvents="none"
                            style={{
                                position: 'absolute',
                                bottom: 6,
                                left: 0,
                                right: 0,
                                alignItems: 'center',
                            }}
                        >
                            <Text
                                className={`text-[12px] ${
                                    item.pageLabelTone === 'light'
                                        ? 'text-white/80'
                                        : 'text-ink-muted dark:text-inkd-muted'
                                }`}
                                style={{ fontVariant: ['tabular-nums'] }}
                            >
                                {pageLabel}
                            </Text>
                        </View>
                    </View>
                </Pressable>
            </AnimatedSlot>
        </View>
    );
}
