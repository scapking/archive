import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Animated,
    BackHandler,
    Easing,
    Platform,
    Text,
    View,
} from 'react-native';
import { useAudioRecorder, useAudioRecorderState, RecordingPresets } from 'expo-audio';
import { BouncyPressable } from '@/core/icons';
import { AudioLinesIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { formatAudioTime } from './audio-player';
import { usePalette } from './theme';

/**
 * 录音域（控制器上收 + 视图层，后台继续模型）：
 *
 * - **AudioRecordingSession（控制器，挂屏层）**：recorder 实例 / 计时轮询 /
 *   声纹电平 / 会话生命周期全部归它——覆盖层只是它的视图。会话挂载即
 *   prepare + record；**关闭覆盖层（X / 返回键）= 仅收起视图，录音继续**
 *   （「后台继续」模型：只有停止钮是真停止，收起后由屏层悬浮计时 chip 承接），
 *   重新点 chip 无缝回到进行中状态（计时/metering/录制态都不经历重启动）。
 * - **RecordingOverlay（视图）**：卡片式浮层（#8，与拍摄卡同一套容器语言），
 *   纯 props 驱动（elapsedSec/metering/isRecording），自身零录音状态——
 *   停止 = 真停止落库；取消 = 丢弃（仅覆盖层内提供）。
 * - **RecordingChip（视图）**：收起态的屏层悬浮计时胶囊（h-9 36dp 圆角胶囊，
 *   hitSlop 4 凑 44 命中），「● 录音中 0:32」，点按重开覆盖层。
 * - **离开屏契约（屏层经 onRegisterLeave 登记）**：stopForLeave 停录并把结果
 *   交 onLeavePersist 落库（不丢素材）；卸载兜底走同一链（屏层未拦截的退出
 *   路径，如 iOS 侧滑），此时 recorder 可能已随 hook release——stop/uri 读取
 *   全体 try 包裹并以最后一次轮询快照兜底（与旧「卸载兜底 stop」同源口径，
 *   兜底失败可能产出未封口的音频文件，属极端退出路径的已知取舍，见报告）。
 *
 * 声纹条：RN Animated 弹簧条列（铁律：交互动画只用 RN Animated，transform
 * /opacity + native driver）。SDK58 的 recorder.getStatus().metering 在
 * isMeteringEnabled 时提供真实 dB——有则真数据，没有则平滑伪动效（web 部分
 * 浏览器不回 metering）。条列动画只动 transform（scaleY），不动高度。
 * 计时/电平的轮询节拍（120ms）在控制器内，视图只随 props 重渲。
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

/** 停录结果（成功带产物；失败带可上浮文案——旧版「停止失败/未生成文件」双文案保留）。 */
export type RecordingStopOutcome =
    | { ok: true; result: RecordingResult }
    | { ok: false; message: string };

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
    // 电平 → 条列动画：props（控制器 120ms 轮询）节拍驱动（durationSec 每 120ms
    // 必变 → 条列持续呼吸；仅挂 metering 会在静音/无 metering 的 web 上冻结），
    // 真数据优先、伪动效兜底
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
 * 关闭语言语义更新（后台继续模型）：卡头 X 与 Android 返回键 = **收起并继续
 * 后台录音**（不再丢弃/停止）；真停止 = 停止钮，丢弃 = 取消钮（仅覆盖层内）。
 */
export function RecordingOverlay({
    elapsedSec,
    metering,
    isRecording,
    onClose,
    onStop,
    onCancel,
}: {
    /** 已录秒数（控制器 120ms 轮询快照）。 */
    elapsedSec: number;
    /** 当前电平 dB（可能 undefined：web 无 metering → 伪动效兜底）。 */
    metering: number | undefined;
    /** 是否已真正开录（停止钮门控：prepare 未完成禁用——Android 未 start 即
     *  stop 会产出无效文件，不可落库）。 */
    isRecording: boolean;
    /** 收起覆盖层（录音继续后台执行，屏层 chip 承接）。 */
    onClose: () => void;
    /** 真停止并落库。 */
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

                    {/* 声纹条列（静态 key 收口口径见 VoiceBars：Animated 壳 style 只留
                        transform，静态布局键下沉壳内非动画 View） */}
                    <VoiceBars elapsedSec={elapsedSec} metering={metering} />

                    {/* 操作区：取消 / 停止。两钮视觉盒均 ≥44 且相距 24dp ≥ 2×0（不传 hitSlop），
                        命中区不重叠。停止钮以 isRecording 门控（准备阶段禁用，视觉 40% 降透明）：
                        prepare 完成前「停止」会得到一个无效录音文件（Android MediaRecorder 未
                        start 即 stop 抛错）——禁用期触摸穿透到不接管点击的 scrim，无副作用 */}
                    <View className="mt-8 flex-row items-center justify-center" style={{ gap: 24 }}>
                        <BouncyPressable onPress={onCancel} scaleTo={0.9}>
                            <View
                                className="h-11 items-center justify-center rounded-control px-6"
                                style={{ backgroundColor: '#FFFFFF1A' }}
                                accessibilityRole="button"
                                accessibilityLabel="取消录音"
                            >
                                <Text className="text-[14px] font-medium text-white">取消</Text>
                            </View>
                        </BouncyPressable>
                        <BouncyPressable onPress={onStop} scaleTo={0.9} disabled={!isRecording}>
                            <View
                                className={`h-11 items-center justify-center rounded-control px-6 ${
                                    isRecording ? '' : 'opacity-40'
                                }`}
                                style={{ backgroundColor: palette.primaryBtn }}
                                accessibilityRole="button"
                                accessibilityLabel="停止录音"
                                accessibilityState={{ disabled: !isRecording }}
                            >
                                {/* 纯文字钮（用户口径：录音 UI 不留图标）；px-6 与取消钮
                                    同宽口径，两字几何稳定 */}
                                <Text className="text-[14px] font-semibold" style={{ color: palette.onPrimaryBtn }}>
                                    停止
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
 * 后台录音悬浮计时 chip（收起态承接面）：h-9（36dp）圆角胶囊「● 录音中 0:32」，
 * 挂载 180ms 淡入 + 8dp 上浮（opacity/translateY，native driver 白名单键）；
 * 点按重开录音覆盖层（计时/声纹/录制态无缝恢复——状态一直在控制器里）。
 * 视觉 36 + hitSlop 4 = 44 命中口径；左隅悬挂（right 隅归 + FAB 与拍摄小窗）。
 */
export function RecordingChip({
    elapsedSec,
    bottomInset,
    onPress,
}: {
    elapsedSec: number;
    /** 悬挂基线（insets.bottom + 偏移，屏层传入）。 */
    bottomInset: number;
    onPress: () => void;
}) {
    const palette = usePalette();
    const appear = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        Animated.timing(appear, {
            toValue: 1,
            duration: 180,
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
                    accessibilityLabel="录音进行中，点按回到录音界面"
                >
                    <View
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: palette.negative }}
                    />
                    <Text
                        className="text-[13px] font-medium"
                        style={{ color: palette.onPrimaryBtn, fontVariant: ['tabular-nums'] }}
                    >
                        {`录音中 ${formatAudioTime(elapsedSec)}`}
                    </Text>
                </View>
            </BouncyPressable>
        </Animated.View>
    );
}

/**
 * 录音会话控制器（屏层挂载，后台继续模型的宿主）：持有 recorder 实例与
 * 120ms 轮询状态，会话挂载即开录；渲染 RecordingOverlay（开）或
 * RecordingChip（收起）。停止 = onFinish（屏层走异步上传流）；取消 = 丢弃；
 * 收起 = 视图切换、录制继续。离开屏（返回/收笔）经 stopForLeave 停录并把
 * 产物交 onLeavePersist 落库（不丢素材）。
 *
 * 竞态防线（沿用旧覆盖层口径 + 控制器化后的新边界）：
 * - prepare 未完成（isRecording false）时停止钮禁用 + handleStop 双保险——
 *   Android MediaRecorder 未 start 即 stop 会产出无效文件；
 * - stop/uri 读取全体 try 包裹：离开屏路径中组件可能在 stop 在途时被卸载，
 *   recorder 随 useReleasingSharedObject release 后再访问会同步抛（released
 *   SharedObject）——此时以最后一次轮询快照（stateRef）兜底取 uri/时长；
 * - 回调全部走 ref 镜像：stopForLeave 的异步链在卸载后继续执行时读到的是
 *   最新回调，且不触碰任何 React 树状态（落库在 store/db 层自洽）。
 */
export function AudioRecordingSession({
    onFinish,
    onDiscard,
    onError,
    onLeavePersist,
    onRegisterLeave,
    chipBottomInset,
}: {
    /** 真停止（用户按停止钮）：产物交屏层走 pending 占位上传流。 */
    onFinish: (result: RecordingResult) => void;
    /** 用户取消：丢弃（cache 临时文件随系统清理）。 */
    onDiscard: () => void;
    /** 启动/停止失败（权限后置失败、设备占用等），文案上浮 store.error。 */
    onError: (message: string) => void;
    /** 离开屏落库（屏层提供：DB 级追加媒体块 + 落库，不依赖已卸载的 UI 状态）。 */
    onLeavePersist: (result: RecordingResult) => Promise<void>;
    /** 向屏层登记 stopForLeave（返回/收笔入口调用；卸载时登记 null）。 */
    onRegisterLeave: (stop: (() => Promise<void>) | null) => void;
    /** 收起态 chip 的悬挂基线。 */
    chipBottomInset: number;
}) {
    // HIGH_QUALITY 预设（.m4a）+ 打开 metering（声纹条真数据）；文件落 cache
    // 目录（SDK 随机文件名，录音生命周期随系统缓存清理）
    const recorder = useAudioRecorder({
        ...RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
    });
    // 轮询间隔 120ms：计时器跳动与声纹刷新共用一个源（避免双定时器漂移）
    const state = useAudioRecorderState(recorder, 120);
    // 收起态（后台继续模型的核心开关）：false = 覆盖层收起、录音继续
    const [overlayOpen, setOverlayOpen] = useState(true);

    const startedRef = useRef(false);
    const finishedRef = useRef(false);
    // 轮询状态快照（stop/uri 的兜底数据源：卸载后 recorder 访问可能抛）
    const stateRef = useRef(state);
    stateRef.current = state;
    // 回调 ref 镜像（异步链跨卸载存活时读最新闭包）
    const onFinishRef = useRef(onFinish);
    onFinishRef.current = onFinish;
    const onDiscardRef = useRef(onDiscard);
    onDiscardRef.current = onDiscard;
    const onErrorRef = useRef(onError);
    onErrorRef.current = onError;
    const onLeavePersistRef = useRef(onLeavePersist);
    onLeavePersistRef.current = onLeavePersist;

    // 启动录音（一次性；prepare 失败上浮错误并结束会话——finished 落位防
    // 卸载兜底再对已失败的会话补停）
    useEffect(() => {
        let active = true;
        void (async () => {
            try {
                await recorder.prepareToRecordAsync();
                if (!active) return;
                startedRef.current = true;
                recorder.record();
            } catch (error) {
                if (active) {
                    finishedRef.current = true;
                    onErrorRef.current(
                        `录音启动失败：${error instanceof Error ? error.message : String(error)}`,
                    );
                }
            }
        })();
        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recorder.id]);

    /** 停录并取产物（失败带文案；不触碰 React 状态，纯数据通道）。 */
    const stopCapture = useCallback(async (): Promise<RecordingStopOutcome> => {
        let stopStatus: { durationMillis?: number; url?: string } | undefined;
        try {
            // stop() resolve 值按平台分流（JS 类型标注 Promise<void>，运行时：
            // Android = 最终 status Bundle{ durationMillis, url }——以停止时刻
            // 为准，胜过 120ms 轮询的 state 快照（末拍最多差 120ms+50ms 阈值）；
            // web/iOS resolve undefined，走快照兜底）。recorder 已 release 的
            // 卸载竞态会在此抛——catch 后走快照兜底
            stopStatus = (await recorder.stop()) as
                | { durationMillis?: number; url?: string }
                | undefined;
        } catch {
            stopStatus = undefined;
        }
        if (
            stopStatus != null &&
            typeof stopStatus === 'object' &&
            stopStatus.url == null
        ) {
            // Android 停止失败路径（MediaRecorder.stop 抛错时 Bundle 不带
            // url，但 recorder.uri 仍指向无效文件——不可落库）
            return { ok: false, message: '录音停止失败，请重试。' };
        }
        let uri: string | null = null;
        try {
            uri = stopStatus?.url ?? recorder.uri ?? null;
        } catch {
            uri = null; // released SharedObject：读属性抛，走快照
        }
        uri = uri ?? stateRef.current.url ?? null;
        if (!uri) return { ok: false, message: '录音未生成文件，请重试。' };
        const finalDurationMs =
            stopStatus?.durationMillis != null && stopStatus.durationMillis > 0
                ? stopStatus.durationMillis
                : stateRef.current.durationMillis;
        return { ok: true, result: { uri, durationMs: Math.round(finalDurationMs) } };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- recorder 实例稳定（hook 契约），快照走 stateRef
    }, [recorder.id]);

    /** 停止钮（真停止 → 落库）：仅真正开录后有效（无效文件防线，见组件注）。 */
    const handleStop = useCallback(() => {
        if (finishedRef.current) return;
        if (!stateRef.current.isRecording) return;
        finishedRef.current = true;
        void (async () => {
            const outcome = await stopCapture();
            if (!outcome.ok) {
                onErrorRef.current(outcome.message);
                return;
            }
            onFinishRef.current(outcome.result);
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stopCapture]);

    /** 取消钮（丢弃）：cache 临时文件随系统清理，不进库。 */
    const handleCancel = useCallback(() => {
        if (finishedRef.current) return;
        finishedRef.current = true;
        void (async () => {
            try {
                await recorder.stop();
            } catch {
                // 丢弃路径：停止失败不阻塞关闭
            }
            onDiscardRef.current();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recorder.id]);

    /**
     * 离开屏停录（屏层返回/收笔入口调用；收笔路径会 await 本 promise——
     * 产物落库完成后屏层再保存 blocks，媒体引用不会漏）。finished 落位后
     * 卸载兜底不再重复停录。
     */
    const stopForLeave = useCallback(async (): Promise<void> => {
        if (finishedRef.current) return;
        finishedRef.current = true;
        const outcome = await stopCapture();
        if (!outcome.ok) {
            onErrorRef.current(outcome.message);
            return;
        }
        await onLeavePersistRef.current(outcome.result);
    }, [stopCapture]);

    // 向屏层登记离开入口（返回/收笔的拦截点）；卸载摘除
    useEffect(() => {
        onRegisterLeave(stopForLeave);
        return () => onRegisterLeave(null);
    }, [stopForLeave, onRegisterLeave]);

    // 卸载兜底：屏层未拦截的退出路径（如 iOS 侧滑返回）——停录并落库，不丢
    // 素材。此时 recorder 可能已随 hook release（hook 声明在前、清理先于本
    // effect）：stop/uri 全 try 包裹 + 轮询快照兜底（口径见组件注；此路径的
    // 文件可能未正常封口，属极端退出的已知取舍）
    useEffect(() => {
        return () => {
            if (finishedRef.current) return;
            finishedRef.current = true;
            void (async () => {
                const outcome = await stopCapture();
                if (!outcome.ok) {
                    onErrorRef.current(outcome.message);
                    return;
                }
                await onLeavePersistRef.current(outcome.result);
            })();
        };
    }, [stopCapture]);

    const elapsedSec = state.durationMillis / 1000;

    // 开录前的短暂准备窗（spinner，与旧口径一致——没这条会闪一帧空 chip）
    if (!state.isRecording && !overlayOpen) return null;

    return (
        <>
            {overlayOpen ? (
                <RecordingOverlay
                    elapsedSec={elapsedSec}
                    metering={state.metering}
                    isRecording={state.isRecording}
                    onClose={() => setOverlayOpen(false)}
                    onStop={handleStop}
                    onCancel={handleCancel}
                />
            ) : (
                <RecordingChip
                    elapsedSec={elapsedSec}
                    bottomInset={chipBottomInset}
                    onPress={() => setOverlayOpen(true)}
                />
            )}
        </>
    );
}

/** 录音平台支持探测（web 走 MediaRecorder，浏览器不支持时返回 false → 录音钮隐藏）。 */
export function isRecordingSupported(): boolean {
    if (Platform.OS !== 'web') return true;
    const w = globalThis as { MediaRecorder?: unknown };
    return typeof w.MediaRecorder === 'function';
}
