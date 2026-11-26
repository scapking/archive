import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import {
    Animated,
    Dimensions,
    Easing,
    Keyboard,
    Platform,
    Pressable,
    ScrollView,
    TextInput,
    View,
    type KeyboardEvent,
    type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PAPER_FLOAT_SHADOW } from './paper-shadow';

/**
 * 居中卡浮层原语（v0.5.0，用户真机反馈「输入法弹出来后，会覆盖卡片」的正解）。
 *
 * 根因（v0.5.0 计划文档定性）：Expo SDK 58 默认 edge-to-edge，Android adjustResize
 * 失效，KeyboardAvoidingView 的 behavior 拿不到 resize 后的布局 → 键盘直接盖卡。
 * 修复不赌系统行为：**事件驱动**——Keyboard.addListener 直读 keyboard 高度
 * （Android keyboardDidShow/keyboardDidHide + iOS 加挂 keyboardWillShow 提前一拍；
 * web 端 no-op，浏览器自管），居中卡按实测几何抬到键盘上方。
 *
 * 避让几何（全程读**实测值**，不依赖 Dimensions 的 E2E 口径）：
 * - 屏高 = scrim 容器 onLayout 实测（初值 Dimensions 兜底，首帧即有合理布局）；
 * - 卡高 = 卡体 onLayout 实测；占位高 occupied = max(键盘高, 底部安全区)
 *   （Android 键盘事件高度已含导航栏区，两者取大不重复计账）；
 * - 抬升 lift = max(0, 卡高/2 + occupied + 气口 − 屏高/2)，另 clamp 上界「卡顶
 *   不出屏顶气口」——卡体心在屏心，下缘需退过「屏高/2 − occupied」的半屏余量，
 *   多出的部分即位移（resize 老环境双扣时由上界钳住）；
 * - 卡体 maxHeight = 屏高 − occupied − 上下气口×2：内容超限走内部 ScrollView，
 *   主钮走 footer 槽（卡底钉死，键盘弹起不被滚动吞掉）。
 *
 * scrollIntoView 二次保险（Android/iOS 都挂）：keyboardDidShow 落定后与字段
 * focus 一帧后，各调一次 scrollResponderScrollNativeHandleToKeyboard 把当前
 * 聚焦输入滚进键盘上沿可见区——覆盖「键盘已弹起、焦点换到更靠下字段」这种
 * 不再触发键盘事件的场景。
 *
 * 动画红线：位移走 Animated.timing + useNativeDriver: true（transform 白名单内），
 * 零新依赖；maxHeight/lift 均为受控 style，不用 JS 线程逐帧驱动布局。
 *
 * 卡体拦截：卡体（View）显式 onStartShouldSetResponder 认领触摸（旧 0.4.9 弹层
 * 卡体无认领，点卡空白处会冒泡到 scrim 误关——本原语一并补上）。
 *
 * v0.5.2 滚轮手势重建：新增 `scroll` 开关（默认 true，既有宿主零改动）。
 * 含自绘滚轮的快速态传 scroll={false} 关掉外层 ScrollView——同轴嵌套滚动是
 * 滚轮手势被吞的主根因之一（外层 ScrollView 与滚轮争抢纵向手势，三端表现
 * 各不相同）；无输入框、内容不超限时外层滚动本无必要。滚轮手势走 RNGH 独立
 * 域（宿主自包 GestureHandlerRootView），不经外层 ScrollView；卡体 responder
 * 认领保留（防误关），其在 RNW 上对滚轮 preventDefault 的干扰由「关外层滚动
 * + 滚轮段 activeOffsetY 阈值认领」双重消解（真机/浏览器验收清单在册）。
 */

/** 上下最小气口（卡缘与键盘顶/屏缘的呼吸距离，也是 scrollIntoView 的追加余量）。 */
const SHEET_AIR_GAP = 16;

/** 卡体最小高兜底（极矮可用空间的病态窗口下仍保表单可读，宁可让键盘吃掉一部分）。 */
const SHEET_MIN_CARD_HEIGHT = 200;

/**
 * 软键盘高度（受控值，px）。native：keyboardDidShow/keyboardDidHide 直读
 * event.endCoordinates.height（Android 事件口径：did 系列是唯一可靠源，will
 * 系列 Android 不派发——见 RN Keyboard 文档注）；iOS 加挂 keyboardWillShow
 * 让避让提前一拍启动；web no-op 恒 0（浏览器视口自缩，无需 JS 让位）。
 */
export function useKeyboardHeight(): number {
    const [height, setHeight] = useState(0);
    useEffect(() => {
        if (Platform.OS === 'web') return undefined;
        const readHeight = (event: KeyboardEvent): void => {
            const raw = event.endCoordinates.height;
            setHeight(Number.isFinite(raw) ? Math.max(0, raw) : 0);
        };
        const subscriptions = [
            Keyboard.addListener('keyboardDidShow', readHeight),
            Keyboard.addListener('keyboardDidHide', () => setHeight(0)),
            // iOS-only：will 事件让抬升与键盘动画同步起步（Android 无派发，不挂）
            ...(Platform.OS === 'ios'
                ? [Keyboard.addListener('keyboardWillShow', readHeight), Keyboard.addListener('keyboardWillHide', () => setHeight(0))]
                : []),
        ];
        return () => subscriptions.forEach((sub) => sub.remove());
    }, []);
    return height;
}

/** 层内键盘保险 API（context 注入，宿主字段 focus 时取用）。 */
interface SheetKeyboardApi {
    /** 把当前聚焦输入滚进「键盘上沿以上」的可见区（非 native no-op）。 */
    scrollActiveFieldIntoView(): void;
}

const SheetKeyboardContext = createContext<SheetKeyboardApi | null>(null);

/**
 * 宿主输入字段 onFocus 用的保险钩子：焦点落定一帧后（native focusedInput
 * 登记可能晚于事件）把该字段滚进可见区。不在 CenteredSheet 内使用时静默
 * no-op（钩子形态通用，字段组件零侵入）。
 */
export function useSheetFieldFocusGuard(): () => void {
    const api = useContext(SheetKeyboardContext);
    return useCallback(() => {
        if (!api) return;
        requestAnimationFrame(() => api.scrollActiveFieldIntoView());
    }, [api]);
}

export interface CenteredSheetProps {
    /** scrim 点按关闭（Android 返回键由各宿主自理——关闭语义宿主差异大）。 */
    onClose(): void;
    /** scrim 的无障碍标签（「关闭xxx」）。 */
    scrimAccessibilityLabel: string;
    /** 卡体的无障碍标签（「xxx面板」）。 */
    sheetAccessibilityLabel: string;
    /** 卡体宽度上限 px（表单卡 384=max-w-sm 同档；日历卡给宽保住 ≥44 格宽）。 */
    maxWidth?: number;
    /** 卡底钉死区（主按钮等「恒在键盘上方」的内容），渲染在 ScrollView 之外。 */
    footer?: ReactNode;
    /**
     * 卡体内容是否走内滚 ScrollView（默认 true）。含自绘滚轮的页面传 false
     * 根除同轴嵌套滚动对滚轮手势的吞抢（v0.5.2；见文件头注）。
     */
    scroll?: boolean;
    children: ReactNode;
}

/**
 * 屏幕居中卡浮层（scrim justify-center + 键盘避让抬升 + 内滚卡体 + footer 钉底）。
 * 视觉档位：PAPER_FLOAT 投影 + rounded-card + base 纸面（弹窗族同语言——
 * ActionMenuCard / 闹钟卡；卡上字段井走 raised 档）。
 */
export function CenteredSheet({
    onClose,
    scrimAccessibilityLabel,
    sheetAccessibilityLabel,
    maxWidth = 384,
    footer = null,
    scroll = true,
    children,
}: CenteredSheetProps) {
    const insets = useSafeAreaInsets();
    const keyboardHeight = useKeyboardHeight();
    const scrollRef = useRef<ScrollViewInstance>(null);

    // 实测几何：容器高（onLayout，Dimensions 仅作首帧初值）与卡高（onLayout）
    const [containerHeight, setContainerHeight] = useState(() => Dimensions.get('window').height);
    const [cardHeight, setCardHeight] = useState(0);

    // 下缘占位：键盘已弹起时键盘高度即占位（含导航栏区）；未弹起时底部安全区
    const occupied = Math.max(keyboardHeight, insets.bottom);
    // 抬升：卡下缘（屏心 + 卡高/2）退到键盘上沿 - 气口 以上。上界 clamp
    // 「卡顶不出屏顶气口」：maxHeight 生效时该式恒不触发（代数上是 no-op），
    // 只兜 onLayout 落后一帧的瞬态与老环境（非 E2E 真 resize：容器高与键盘
    // 高度双扣、raw lift 会过冲）两个病态面。
    const lift = Math.min(
        Math.max(0, cardHeight / 2 + occupied + SHEET_AIR_GAP - containerHeight / 2),
        Math.max(0, containerHeight / 2 - cardHeight / 2 - SHEET_AIR_GAP),
    );
    // 卡体上限：可用空间（屏高 - 占位）再扣上下气口；内容超限走内部滚动
    const maxCardHeight = Math.max(SHEET_MIN_CARD_HEIGHT, containerHeight - occupied - SHEET_AIR_GAP * 2);

    // 位移走 Animated + native driver（transform 白名单；受控 style 零新依赖）
    const liftAnim = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        Animated.timing(liftAnim, {
            toValue: lift,
            duration: lift > 0 ? 180 : 240,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        }).start();
    }, [lift, liftAnim]);

    const scrollActiveFieldIntoView = useCallback(() => {
        // web：RNW 无原生 focusedInput 登记面，浏览器对 focus 自带滚动，no-op
        if (Platform.OS === 'web') return;
        const scrollView = scrollRef.current;
        if (!scrollView) return;
        const focused = TextInput.State.currentlyFocusedInput();
        if (!focused) return;
        // RN 官方滚动应答（KAV 内部同源机制）：把节点滚到键盘上沿之上 + 气口
        scrollView.scrollResponderScrollNativeHandleToKeyboard(focused, SHEET_AIR_GAP, true);
    }, []);

    const api = useMemo<SheetKeyboardApi>(
        () => ({ scrollActiveFieldIntoView }),
        [scrollActiveFieldIntoView],
    );

    // 键盘弹起落定后二次保险（覆盖 autoFocus 字段：focus 早于键盘动画结束，
    // 焦点钩子那一次测不准，这里在 Did 事件后补一刀）
    useEffect(() => {
        if (Platform.OS === 'web' || keyboardHeight <= 0) return undefined;
        const timer = setTimeout(scrollActiveFieldIntoView, 120);
        return () => clearTimeout(timer);
    }, [keyboardHeight, scrollActiveFieldIntoView]);

    return (
        <View
            className="absolute inset-0 z-50"
            onLayout={(event) => setContainerHeight(event.nativeEvent.layout.height)}
        >
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-4 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel={scrimAccessibilityLabel}
            >
                {/* 宽度定档（v0.5.1 看图验收返工）：Animated.View 此前无宽度
                    声明，在 scrim items-center 下按内容固有宽收缩——滚轮列取代
                    宽输入框后卡宽塌到 ~200px，「直接创建」折行、动作行挤压。
                    抬到全宽 + 内部水平居中，卡体 w-full+maxWidth 才按档展开 */}
                <Animated.View
                    style={{
                        width: '100%',
                        alignItems: 'center',
                        transform: [{ translateY: Animated.multiply(liftAnim, -1) }],
                    }}
                >
                    {/* 卡体：View + 显式认领 responder——点卡空白不冒泡关层
                        （0.4.9 弹层用无 onPress 的 Pressable，父层 onPress 照样
                        吃掉卡内空白点按，误关缺陷在此根治；不用 Pressable 是
                        因其 getEventHandlers 会覆盖自定义 responder prop）；
                        maxHeight 让位键盘，超限内滚 */}
                    <View
                        className="w-full overflow-hidden rounded-card bg-ink-base dark:bg-inkd-base"
                        style={[PAPER_FLOAT_SHADOW, { maxWidth, maxHeight: maxCardHeight }]}
                        onStartShouldSetResponder={() => true}
                        onLayout={(event) => setCardHeight(event.nativeEvent.layout.height)}
                        accessibilityLabel={sheetAccessibilityLabel}
                    >
                        <SheetKeyboardContext.Provider value={api}>
                            {/* flex 列：ScrollView flexGrow+flexShrink 吃掉卡内余量，
                                footer 钉卡底（恒在键盘上方，不随内容滚走） */}
                            {/* 卡内边距 = 设计契约基线 p-4（16）：v0.5.1 逐处核
                                （原 20 与 settings/事件卡内 p-4 不齐）；footer 同
                                宽，卡头内容与钉底动作行左右缘对齐；底部呼吸留给
                                宿主内容自带（date-picker 尾块自垫先例，原语不越权） */}
                            {scroll ? (
                                <ScrollView
                                    ref={scrollRef}
                                    style={{ flexGrow: 1, flexShrink: 1 }}
                                    contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 16 }}
                                    keyboardShouldPersistTaps="handled"
                                >
                                    {children}
                                </ScrollView>
                            ) : (
                                // 滚轮快速态：无输入框、无内滚——外层 ScrollView 与
                                // 滚轮同轴嵌套正是手势吞失根因，此处直接静态铺排
                                <View
                                    style={{
                                        flexGrow: 1,
                                        flexShrink: 1,
                                        paddingHorizontal: 16,
                                        paddingTop: 16,
                                    }}
                                >
                                    {children}
                                </View>
                            )}
                            {footer ? (
                                <View className="px-4 pb-4 pt-3">{footer}</View>
                            ) : null}
                        </SheetKeyboardContext.Provider>
                    </View>
                </Animated.View>
            </Pressable>
        </View>
    );
}
