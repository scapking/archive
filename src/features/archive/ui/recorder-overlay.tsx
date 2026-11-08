import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    Animated,
    BackHandler,
    Easing,
    Platform,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BouncyPressable } from '@/core/icons';
import { CloseButton } from './close-button';
import { formatAudioTime } from './audio-player';
import { usePalette } from './theme';

/**
 * 录音域视图层（纯视图，控制器已上收全局会话）——「采集仪器卡」设计语言：
 *
 * ══ 设计决策书（三采集统一语言：录音卡 / 拍摄卡 / 拍照卡同容器异内容）══
 * 依据 docs/design-skills（frontend-design + design-taste-frontend/app-screens
 * + design-linear + animate-expo；冲突时仓库规范优先）：
 *
 * 1. **范式：全窗沉浸 + 中央仪器卡**（卡片式新 UI 的观感=独立页面）：
 *    ink-scrim 全窗压暗（token，onDark 恒定）→ max-w 400 仪器卡（rounded-card16
 *    + 白 10% 细边在深场上定义卡缘）→ 卡内白 10% raised 控件。三层 tone step
 *    分层，零阴影零渐变（app-screens「surfaces are flat」× 房规双保险）。
 * 2. **色彩只上数据**（app-screens 首条）：全场唯一彩色 = negative 红点
 *    （录制状态），chrome 一律灰阶（白 alpha 阶 / palette.primaryBtn 反白）。
 * 3. **每卡只有一个主角**（frontend-design「spend boldness in one place」）：
 *    录音卡主角 = 声纹场（真 metering 数据），拍摄卡主角 = 取景器；其余安静。
 * 4. **动效全部 RN Animated transform/opacity + native driver**（animate-expo：
 *    偶发交互=标准动画、按压反馈 <150ms、reduceMotion 随动画一起交付）：
 *    - 进场 = 防跳变（preventing a jarring change）：层淡入 + 卡上浮微缩
 *      （translateY 16→0 / scale 0.97→1，240ms ease-out cubic）；
 *    - 退场 = 进场逆放（淡出+下沉+微缩）：停止/取消由 stopping 相位驱动
 *      （160ms）；录音卡「最小化收起」由控制器挂载契约（!overlayOpen → null）
 *      即时卸载——收起语义由 RecordingChip 的淡入上浮进场承接（跨卡连续性）；
 *    - 红点呼吸 = 状态指示（state indication）：opacity 1↔0.35 @1.6s 循环，
 *      reduceMotion 降级为静态常亮；
 *    - 计时 30px tabular-nums（字号阶房规：数字位一律 tabular-nums）。
 * 5. **copy 主动词、状态诚实**（frontend-design「writing」）：停止/取消/收起
 *    并继续录音；prepare 未完成时状态标注「准备中…」（不把准备态谎报成录音中）。
 *
 * 控制器（recorder 实例 / 计时轮询 / 声纹电平 / 会话生命周期）在
 * features/archive/recording-session.tsx（根层级挂载，跨页面后台录制 + 归属
 * 铁律的宿主）——本文件只保留纯 props 驱动的视图，props 契约不变：
 * - **RecordingOverlay（展开态视图）**：全窗沉浸仪器卡；自身零录音状态——
 *   停止 = 卡片 ~160ms 淡出下沉关闭 + 落库转后台自动完成（横幅反馈，无
 *   spinner 停留）；取消 = 丢弃（仅覆盖层内提供，同样淡出下沉关闭）；
 *   X / 返回键 = 收起并继续后台录音。
 * - **RecordingChip（收起态视图）**：根层级悬浮计时胶囊（h-9 36dp 圆角胶囊，
 *   hitSlop 4 凑 44 命中），「● 录音中 0:32」（呼吸红点），点按重开覆盖层
 *   （计时/声纹/录制态无缝恢复——状态一直在全局会话层）。
 *
 * 声纹条：RN Animated 弹簧条列（铁律：交互动画只用 RN Animated，transform
 * /opacity + native driver）。SDK58 的 recorder.getStatus().metering 在
 * isMeteringEnabled 时提供真实 dB——有则真数据，没有则平滑伪动效（web 部分
 * 浏览器不回 metering）。条列动画只动 transform（scaleY），不动高度。
 * 计时/电平的轮询节拍（120ms）在全局控制器内，视图只随 props 重渲。
 */

/** 系统「减弱动态」探测（ref 形态，动画时长决策用）：true 时淡入/淡出退化
 *  为瞬时（时长 0）。订阅随卸载摘除；API 缺失（老内核）保守按未开启。 */
export function useReduceMotionRef() {
    const reduceMotionRef = useRef(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled
            ?.()
            .then((enabled) => {
                if (!cancelled) reduceMotionRef.current = !!enabled;
            })
            .catch(() => undefined);
        const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled) => {
            reduceMotionRef.current = !!enabled;
        });
        return () => {
            cancelled = true;
            subscription?.remove();
        };
    }, []);
    return reduceMotionRef;
}

/**
 * 系统「减弱动态」探测（state 形态，循环动画的启停门控用）：循环动画（红点
 * 呼吸）在探测结果就绪后才能决定启/停——ref 形态（useReduceMotionRef）只在
 * 调用时刻读一次，管不住 effect 已启动的 loop，故循环类动画一律用本 hook。
 * reduceMotion 语义 =「更少更轻」而非归零（animate-expo）：静态常亮保留状态
 * 表达（颜色仍承载「录制中」），只去掉呼吸位移感。
 */
export function useReduceMotionState(): boolean {
    const [reduced, setReduced] = useState(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled
            ?.()
            .then((enabled) => {
                if (!cancelled) setReduced(!!enabled);
            })
            .catch(() => undefined);
        const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled) => {
            setReduced(!!enabled);
        });
        return () => {
            cancelled = true;
            subscription?.remove();
        };
    }, []);
    return reduced;
}

/**
 * 覆盖层进场/退场驱动（三卡共享）：单一 Animated.Value（0=下沉隐藏位，
 * 1=就位）同时承担两个相位——进场 0→1（淡入+上浮+微缩），退场 1→0（进场
 * 逆放=淡出+下沉）。同值复用天然解决「进场未完即退场」的竞争（run 内先
 * stop 前一动画，后到者接管）。transform/opacity + native driver（铁律）；
 * reduceMotion 降级为时长 0（单帧瞬时到位，不产生可见动画）。
 */
export function useOverlayEntrance(reduceMotionRef: {
    readonly current: boolean;
}): {
    appear: Animated.Value;
    run: (toValue: number, duration: number, onComplete?: (finished: boolean) => void) => void;
} {
    const appear = useRef(new Animated.Value(0)).current;
    const animRef = useRef<Animated.CompositeAnimation | null>(null);
    const run = useCallback(
        (toValue: number, duration: number, onComplete?: (finished: boolean) => void) => {
            // 同值竞争收口：新动画启动前停掉在途动画（后到者接管，无逐帧打架；
            // 被停动画的 onComplete 收 finished=false，调用方据此丢弃收尾动作）
            animRef.current?.stop();
            animRef.current = Animated.timing(appear, {
                toValue,
                duration: reduceMotionRef.current ? 0 : duration,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            });
            animRef.current.start(({ finished }) => onComplete?.(finished));
        },
        [appear, reduceMotionRef],
    );
    // 卸载卫生：在途动画随卸载停止（Animated 值不随组件卸载自动停）
    useEffect(
        () => () => {
            animRef.current?.stop();
        },
        [],
    );
    return { appear, run };
}

/**
 * 录制状态红点（三卡共享的「唯一数据色」）：active = 呼吸（opacity 1↔0.35，
 * 1.6s ease-in-out 循环，state indication）；!active = 静态半亮（prepare 等
 * 非录制态不谎报心跳——data states honest）。reduceMotion 降级为静态常亮。
 */
export function RecordingDot({
    color,
    active = true,
    size = 8,
}: {
    /** 点色（调用点传 palette.negative——状态色只上数据，token 收口）。 */
    color: string;
    /** 是否处于录制态（false = 静态半亮，如 prepare 阶段）。 */
    active?: boolean;
    /** 直径 dp（默认 8 = h-2 w-2 口径）。 */
    size?: number;
}) {
    const reduced = useReduceMotionState();
    const breathe = useRef(new Animated.Value(1)).current;
    useEffect(() => {
        if (!active || reduced) return;
        const loop = Animated.loop(
            Animated.sequence([
                Animated.timing(breathe, {
                    toValue: 0.35,
                    duration: 800,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver: true,
                }),
                Animated.timing(breathe, {
                    toValue: 1,
                    duration: 800,
                    easing: Easing.inOut(Easing.quad),
                    useNativeDriver: true,
                }),
            ]),
        );
        loop.start();
        return () => loop.stop();
    }, [active, reduced, breathe]);
    return (
        <Animated.View style={{ opacity: active ? breathe : 0.45 }}>
            <View
                style={{
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    backgroundColor: color,
                }}
            />
        </Animated.View>
    );
}

/** 声纹条列数与几何（奇数条中轴对称，视觉重心居中）。 */
const BAR_COUNT = 25;
const BAR_WIDTH = 3;
const BAR_MAX_HEIGHT = 64;
const BAR_GAP = 5;

/** metering（dB，通常 -50..0）→ 0..1 电平；缺失/异常回 0.12（可见呼吸但不夸张）。 */
function normalizeMetering(metering: number | undefined): number {
    if (metering == null || !Number.isFinite(metering)) return 0.12;
    return Math.min(Math.max((metering + 50) / 50, 0.08), 1);
}

/** 预生成条列的抖动相位：同电平下每条有稳定差异，避免整排齐刷刷。 */
const BAR_JITTER = Array.from({ length: BAR_COUNT }, (_, i) => {
    // 中心加权包络 + 正弦相位（纯函数可复现，渲染确定性）
    const center = Math.abs(i - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
    return { envelope: 1 - center * 0.55, phase: (i * 2.399) % (Math.PI * 2) };
});

export interface RecordingResult {
    uri: string;
    durationMs: number;
}

/** 声纹条列（视图内部件）：scaleY 弹簧条，随 elapsedSec/metering props 呼吸。 */
function VoiceBars({
    elapsedSec,
    metering,
}: {
    elapsedSec: number;
    metering: number | undefined;
}) {
    // 条列动画值：scaleY 0.08..1（native driver）
    const bars = useMemo(
        () => Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.08)),
        [],
    );
    // 电平 → 条列动画：props（全局控制器 120ms 轮询）节拍驱动（durationSec 每
    // 120ms 必变 → 条列持续呼吸；仅挂 metering 会在静音/无 metering 的 web 上
    // 冻结），真数据优先、伪动效兜底
    useEffect(() => {
        const level = normalizeMetering(metering);
        const now = Date.now() / 1000;
        bars.forEach((bar, i) => {
            const { envelope, phase } = BAR_JITTER[i];
            const target = Math.min(
                1,
                Math.max(0.08, level * envelope * (0.75 + 0.25 * Math.sin(now * 5 + phase))),
            );
            Animated.timing(bar, {
                toValue: target,
                duration: 110,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
            }).start();
        });
    }, [bars, elapsedSec, metering]);
    return (
        <View className="mt-6 h-20 items-center justify-end">
            <View className="flex-row items-end" style={{ gap: BAR_GAP }}>
                {bars.map((bar, i) => (
                    <Animated.View key={i} style={{ transform: [{ scaleY: bar }] }}>
                        <View
                            style={{
                                width: BAR_WIDTH,
                                height: BAR_MAX_HEIGHT,
                                borderRadius: BAR_WIDTH / 2,
                                backgroundColor: '#FFFFFFD9',
                            }}
                        />
                    </Animated.View>
                ))}
            </View>
        </View>
    );
}

/**
 * 录音仪器卡（纯视图，条件渲染，禁 RN Modal）：全窗沉浸（ink-scrim + 安全区
 * padding）+ 中央卡片。关闭语言语义（后台继续模型）：卡头 X 与 Android 返回
 * 键 = **收起并继续后台录音**；真停止 = 停止钮（卡片 ~160ms 淡出下沉关闭，
 * 落库后台自动完成），丢弃 = 取消钮（仅覆盖层内，同样淡出下沉关闭）。
 */
export function RecordingOverlay({
    elapsedSec,
    metering,
    isRecording,
    stopping = false,
    ownerHint,
    onClose,
    onStop,
    onCancel,
}: {
    /** 已录秒数（全局控制器 120ms 轮询快照）。 */
    elapsedSec: number;
    /** 当前电平 dB（可能 undefined：web 无 metering → 伪动效兜底）。 */
    metering: number | undefined;
    /** 是否已真正开录（停止钮门控：prepare 未完成禁用——Android 未 start 即
     *  stop 会产出无效文件，不可落库）。 */
    isRecording: boolean;
    /** 停止/取消在途（全局会话 stopping 相位投影）：整卡 ~160ms 淡出下沉关闭
     *  （RN Animated opacity/transform）+ 交互整体释放——不做 spinner/在途文
     *  案停留（用户口径：关窗即返回，保存后台自动完成），落库结果由横幅反馈。 */
    stopping?: boolean;
    /** 归属提示（owner 笔记展示名；归属铁律的可视化——跨页面停止时用户能
     *  看到产物去向）。null = 不展示。 */
    ownerHint?: string | null;
    /** 收起覆盖层（录音继续后台执行，chip 承接）。 */
    onClose: () => void;
    /** 真停止（全局编排 → 卡片淡出下沉关闭 + 落库后台化 → 归属 ownerJournalId）。 */
    onStop: () => void;
    /** 停止并丢弃（仅覆盖层内入口）。 */
    onCancel: () => void;
}) {
    const palette = usePalette();
    const insets = useSafeAreaInsets();
    // 进场/退场共用单一驱动值（useOverlayEntrance 头注）：挂载即进场（层淡入
    // + 卡上浮微缩 240ms）；stopping 相位 → 进场逆放（淡出+下沉 160ms）。
    // 「减弱动态」两档均退化为时长 0（单帧瞬时，不产生可见动画）
    const reduceMotionRef = useReduceMotionRef();
    const { appear, run } = useOverlayEntrance(reduceMotionRef);
    useEffect(() => {
        run(1, 240);
    }, [run]);
    useEffect(() => {
        if (!stopping) return;
        run(0, 160);
    }, [stopping, run]);
    // Android 返回键 = 收起（后台继续模型：返回不再等于丢弃——丢弃代价高，
    // 出口收敛到覆盖层内的取消钮）；收尾期（stopping）返回被编排层闸掉，
    // 淡出窗口内吞掉即可
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    return (
        <Animated.View
            className="absolute inset-0 z-50 bg-ink-scrim dark:bg-inkd-scrim"
            pointerEvents={stopping ? 'none' : 'auto'}
            style={{ opacity: appear }}
        >
            {/* scrim 不接管点击（录音误触丢弃代价高），出口 = 收起钮/取消钮/返回键；
                上下安全区 padding：仪器卡在刘海/手势条机型上不贴边（insets 收口） */}
            <View
                className="flex-1 items-center justify-center px-6"
                style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}
            >
                {/* 仪器卡（深底卡，与拍摄卡同容器语言：rounded-card16 + 白 10% 细边
                    定义卡缘 + 集中控制行）。进场动效挂卡体（层只管淡入，卡体上浮
                    微缩——全窗层禁 scale，避免边缘露缝） */}
                <Animated.View
                    className="w-full max-w-[400px] rounded-card border border-white/10 bg-[#0B0D0F] p-5"
                    style={{
                        transform: [
                            {
                                translateY: appear.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [16, 0],
                                }),
                            },
                            {
                                scale: appear.interpolate({
                                    inputRange: [0, 1],
                                    outputRange: [0.97, 1],
                                }),
                            },
                        ],
                    }}
                >
                    {/* 卡头：状态红点（唯一数据色）+ 状态文案 + 右上收起钮。
                        prepare 未完成（isRecording false）= 静态半亮点 + 「准备中…」
                        （状态诚实：不把准备期谎报成录音中/心跳） */}
                    <View className="flex-row items-center justify-between">
                        <View className="flex-row items-center gap-2">
                            <RecordingDot color={palette.negative} active={isRecording} />
                            <Text className="text-[12px] text-white/70">
                                {isRecording ? '录音中' : '准备中…'}
                            </Text>
                        </View>
                        {/* 44 视觉盒（组件内不传 hitSlop）：左邻状态组为非按压体，
                            卡头右缘即卡内边距，无相邻命中元素，无重叠核算项 */}
                        <CloseButton onDark onPress={onClose} label="收起并继续录音" />
                    </View>

                    {/* 大计时器（30px 阶，tabular-nums 房规）——卡内 hero 数据 */}
                    <Text
                        className="mt-6 text-center text-[30px] font-semibold text-white"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {formatAudioTime(elapsedSec)}
                    </Text>

                    {/* 归属提示（#归属铁律可视化）：停止产物固定落回发起笔记 */}
                    {ownerHint ? (
                        <Text className="mt-2 text-center text-[12px] text-white/50">
                            {`停止后保存到「${ownerHint}」`}
                        </Text>
                    ) : null}

                    {/* 声纹条列（卡的主角：真 metering 场；静态 key 收口口径见
                        VoiceBars：Animated 壳 style 只留 transform，静态布局键
                        下沉壳内非动画 View） */}
                    <VoiceBars elapsedSec={elapsedSec} metering={metering} />

                    {/* 操作区：取消 / 停止。两钮视觉盒均 ≥44 且相距 24dp ≥ 2×0（不传 hitSlop），
                        命中区不重叠。停止钮以 isRecording 门控（准备阶段禁用——prepare 完成
                        前「停止」会得到一个无效录音文件（Android MediaRecorder 未 start 即
                        stop 抛错）；停止/取消钮保留 stopping 触摸闸（护栏兜底下窗口有界，
                        防淡出窗口内重入），在途反馈 = 整卡淡出下沉关闭本身，无 spinner/
                        文案切换——禁用期触摸穿透到不接管点击的 scrim，无副作用 */}
                    <View className="mt-8 flex-row items-center justify-center" style={{ gap: 24 }}>
                        <BouncyPressable onPress={onCancel} scaleTo={0.9} disabled={stopping}>
                            <View
                                className="h-11 items-center justify-center rounded-control px-6"
                                style={{ backgroundColor: '#FFFFFF1A' }}
                                accessibilityRole="button"
                                accessibilityLabel="取消录音"
                                accessibilityState={{ disabled: stopping }}
                            >
                                <Text className="text-[14px] font-medium text-white">取消</Text>
                            </View>
                        </BouncyPressable>
                        <BouncyPressable onPress={onStop} scaleTo={0.9} disabled={!isRecording || stopping}>
                            <View
                                className={`h-11 items-center justify-center rounded-control px-6 ${
                                    isRecording ? '' : 'opacity-40'
                                }`}
                                style={{ backgroundColor: palette.primaryBtn }}
                                accessibilityRole="button"
                                accessibilityLabel="停止录音"
                                accessibilityState={{ disabled: !isRecording || stopping }}
                            >
                                {/* 纯文字钮（用户口径：录音 UI 不留图标）；px-6 与取消钮
                                    同宽口径，两字几何稳定 */}
                                <Text className="text-[14px] font-semibold" style={{ color: palette.onPrimaryBtn }}>
                                    停止
                                </Text>
                            </View>
                        </BouncyPressable>
                    </View>
                </Animated.View>
            </View>
        </Animated.View>
    );
}

/**
 * 后台录音/录像悬浮计时 chip（收起态承接面，根层级渲染）：h-9（36dp）圆角
 * 胶囊「● 录音中 0:32」（呼吸红点 = 三卡同款唯一数据色），挂载 180ms 淡入 +
 * 8dp 上浮（opacity/translateY，native driver 白名单键）——录音卡收起时本
 * chip 的进场承接「收起」语义（控制器挂载契约下覆盖层即时卸载，跨卡动效
 * 连续性由这里补全）。点按重开覆盖层（计时/声纹/录制态无缝恢复——状态一直
 * 在全局会话层）。视觉 36 + hitSlop 4 = 44 命中口径；左隅悬挂（right 隅归
 * + FAB 与拍摄小窗）。
 */
export function RecordingChip({
    label = '录音中',
    elapsedSec,
    bottomInset,
    onPress,
}: {
    /** 状态文案（录音中 / 录像中，按会话种类）。 */
    label?: string;
    elapsedSec: number;
    /** 悬挂基线（insets.bottom + 偏移，宿主按路由层级传入）。 */
    bottomInset: number;
    onPress: () => void;
}) {
    const palette = usePalette();
    const appear = useRef(new Animated.Value(0)).current;
    // 系统「减弱动态」降级（useReduceMotionRef 同口径）：跳过上浮位移、淡入
    // 退化为瞬时出现（时长 0）——chip 是常驻导航级元素，位移编排对前庭敏感
    // 用户是纯噪声
    const reduceMotionRef = useReduceMotionRef();
    useEffect(() => {
        Animated.timing(appear, {
            toValue: 1,
            // 减弱动态：时长 0 单帧瞬时到位（opacity/translateY 不产生可见动画）
            duration: reduceMotionRef.current ? 0 : 180,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        }).start();
    }, [appear, reduceMotionRef]);
    return (
        <Animated.View
            className="absolute left-6 z-20"
            pointerEvents="box-none"
            style={{
                bottom: bottomInset,
                opacity: appear,
                transform: [
                    { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) },
                ],
            }}
        >
            <BouncyPressable onPress={onPress} hitSlop={4} scaleTo={0.94}>
                <View
                    className="h-9 flex-row items-center gap-2 rounded-full px-4"
                    style={{ backgroundColor: palette.primaryBtn }}
                    accessibilityRole="button"
                    accessibilityLabel={`${label}进行中，点按回到录制界面`}
                >
                    {/* 呼吸红点（三卡同款）：chip 阶段无 prepare 态（recording 相位
                        才渲染），恒 active */}
                    <RecordingDot color={palette.negative} size={8} />
                    <Text
                        className="text-[13px] font-medium"
                        style={{ color: palette.onPrimaryBtn, fontVariant: ['tabular-nums'] }}
                    >
                        {`${label} ${formatAudioTime(elapsedSec)}`}
                    </Text>
                </View>
            </BouncyPressable>
        </Animated.View>
    );
}

/** 录音平台支持探测（web 走 MediaRecorder，浏览器不支持时返回 false → 录音钮隐藏）。 */
export function isRecordingSupported(): boolean {
    if (Platform.OS !== 'web') return true;
    const w = globalThis as { MediaRecorder?: unknown };
    return typeof w.MediaRecorder === 'function';
}
