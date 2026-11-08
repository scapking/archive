import { useEffect, useMemo, useRef } from 'react';
import {
    AccessibilityInfo,
    Animated,
    BackHandler,
    Easing,
    Platform,
    Text,
    View,
} from 'react-native';
import { BouncyPressable } from '@/core/icons';
import { AudioLinesIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { formatAudioTime } from './audio-player';
import { usePalette } from './theme';

/**
 * 录音域视图层（纯视图，控制器已上收全局会话）：
 *
 * - 控制器（recorder 实例 / 计时轮询 / 声纹电平 / 会话生命周期）在
 *   features/archive/recording-session.tsx（根层级挂载，跨页面后台录制 +
 *   归属铁律的宿主）——本文件只保留两个纯 props 驱动的视图：
 * - **RecordingOverlay（展开态视图）**：卡片式浮层（#8，与拍摄卡同一套容器
 *   语言），自身零录音状态——停止 = 真停止落库（全局编排 → 归属 owner 笔记）；
 *   取消 = 丢弃（仅覆盖层内提供）；X / 返回键 = 收起并继续后台录音。
 * - **RecordingChip（收起态视图）**：根层级悬浮计时胶囊（h-9 36dp 圆角胶囊，
 *   hitSlop 4 凑 44 命中），「● 录音中 0:32」，点按重开覆盖层（计时/声纹/
 *   录制态无缝恢复——状态一直在全局会话层）。
 *
 * 声纹条：RN Animated 弹簧条列（铁律：交互动画只用 RN Animated，transform
 * /opacity + native driver）。SDK58 的 recorder.getStatus().metering 在
 * isMeteringEnabled 时提供真实 dB——有则真数据，没有则平滑伪动效（web 部分
 * 浏览器不回 metering）。条列动画只动 transform（scaleY），不动高度。
 * 计时/电平的轮询节拍（120ms）在全局控制器内，视图只随 props 重渲。
 */

/** 声纹条列数与几何（奇数条中轴对称，视觉重心居中）。 */
const BAR_COUNT = 25;
const BAR_WIDTH = 3;
const BAR_MAX_HEIGHT = 56;
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
        <View className="mt-6 h-16 items-center justify-end">
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
 * 录音覆盖层（纯视图，条件渲染，禁 RN Modal）：深色 scrim + 居中录音卡。
 * 关闭语言语义（后台继续模型）：卡头 X 与 Android 返回键 = **收起并继续
 * 后台录音**；真停止 = 停止钮，丢弃 = 取消钮（仅覆盖层内）。
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
    /** 停止/保存链路在途（全局会话 stopping 相位投影）：停止钮给「停止中…」
     *  在途反馈、停止/取消钮禁用——双护栏兜底下必有界，不静默吞点按。 */
    stopping?: boolean;
    /** 归属提示（owner 笔记展示名；归属铁律的可视化——跨页面停止时用户能
     *  看到产物去向）。null = 不展示。 */
    ownerHint?: string | null;
    /** 收起覆盖层（录音继续后台执行，chip 承接）。 */
    onClose: () => void;
    /** 真停止并落库（全局编排 → 归属 ownerJournalId）。 */
    onStop: () => void;
    /** 停止并丢弃（仅覆盖层内入口）。 */
    onCancel: () => void;
}) {
    const palette = usePalette();
    // Android 返回键 = 收起（后台继续模型：返回不再等于丢弃——丢弃代价高，
    // 出口收敛到覆盖层内的取消钮）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    return (
        <View className="absolute inset-0 z-50 bg-ink-scrim dark:bg-inkd-scrim">
            {/* scrim 不接管点击（录音误触丢弃代价高），出口 = 收起钮/取消钮/返回键 */}
            <View className="flex-1 items-center justify-center px-6">
                {/* 录音卡（深底卡，与拍摄卡同容器语言：rounded-card + 集中控制行）。
                    卡头（#8 打磨轮）：录音标识 + 右上收起钮（关闭语言统一，
                    CloseButton onDark 变体——深底卡恒近黑，与主题无关） */}
                <View className="w-full max-w-[400px] rounded-card bg-[#0B0D0F] p-5">
                    <View className="flex-row items-center justify-between">
                        <View className="flex-row items-center gap-2">
                            <AudioLinesIcon size={16} strokeWidth={1.9} color="#FFFFFFB3" />
                            <Text className="text-[12px] text-white/70">录音中</Text>
                        </View>
                        {/* 44 视觉盒（组件内不传 hitSlop）：左邻标识组为非按压体，
                            卡头右缘即卡内边距，无相邻命中元素，无重叠核算项 */}
                        <CloseButton onDark onPress={onClose} label="收起并继续录音" />
                    </View>

                    {/* 大计时器（30px 阶，tabular-nums 房规） */}
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

                    {/* 声纹条列（静态 key 收口口径见 VoiceBars：Animated 壳 style 只留
                        transform，静态布局键下沉壳内非动画 View） */}
                    <VoiceBars elapsedSec={elapsedSec} metering={metering} />

                    {/* 操作区：取消 / 停止。两钮视觉盒均 ≥44 且相距 24dp ≥ 2×0（不传 hitSlop），
                        命中区不重叠。停止钮以 isRecording/stopping 门控（准备阶段禁用——
                        prepare 完成前「停止」会得到一个无效录音文件（Android MediaRecorder
                        未 start 即 stop 抛错）；停止在途禁用 + 「停止中…」在途反馈，护栏
                        兜底下窗口有界）——禁用期触摸穿透到不接管点击的 scrim，无副作用 */}
                    <View className="mt-8 flex-row items-center justify-center" style={{ gap: 24 }}>
                        <BouncyPressable onPress={onCancel} scaleTo={0.9} disabled={stopping}>
                            <View
                                className={`h-11 items-center justify-center rounded-control px-6 ${
                                    stopping ? 'opacity-40' : ''
                                }`}
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
                                    isRecording && !stopping ? '' : 'opacity-40'
                                }`}
                                style={{ backgroundColor: palette.primaryBtn }}
                                accessibilityRole="button"
                                accessibilityLabel="停止录音"
                                accessibilityState={{ disabled: !isRecording || stopping, busy: stopping }}
                            >
                                {/* 纯文字钮（用户口径：录音 UI 不留图标）；px-6 与取消钮
                                    同宽口径，两字几何稳定 */}
                                <Text className="text-[14px] font-semibold" style={{ color: palette.onPrimaryBtn }}>
                                    {stopping ? '停止中…' : '停止'}
                                </Text>
                            </View>
                        </BouncyPressable>
                    </View>
                </View>
            </View>
        </View>
    );
}

/**
 * 后台录音/录像悬浮计时 chip（收起态承接面，根层级渲染）：h-9（36dp）圆角
 * 胶囊「● 录音中 0:32」，挂载 180ms 淡入 + 8dp 上浮（opacity/translateY，
 * native driver 白名单键）；点按重开覆盖层（计时/声纹/录制态无缝恢复——
 * 状态一直在全局会话层）。视觉 36 + hitSlop 4 = 44 命中口径；左隅悬挂
 * （right 隅归 + FAB 与拍摄小窗）。
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
    // 系统「减弱动态」降级（editor.tsx MediaDeckStack 同口径惯例）：跳过上浮
    // 位移、淡入退化为瞬时出现（时长 0）——chip 是常驻导航级元素，位移编排
    // 对前庭敏感用户是纯噪声；订阅随卸载摘除
    const reduceMotionRef = useRef(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled?.().then((enabled) => {
            if (!cancelled) reduceMotionRef.current = !!enabled;
        }).catch(() => undefined);
        const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled) => {
            reduceMotionRef.current = !!enabled;
        });
        return () => {
            cancelled = true;
            subscription?.remove();
        };
    }, []);
    useEffect(() => {
        Animated.timing(appear, {
            toValue: 1,
            // 减弱动态：时长 0 单帧瞬时到位（opacity/translateY 不产生可见动画）
            duration: reduceMotionRef.current ? 0 : 180,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        }).start();
    }, [appear]);
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
                    <View
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: palette.negative }}
                    />
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
