import { useCallback, useEffect, useMemo, useRef } from 'react';
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
 * 录音覆盖层（条件渲染，禁 RN Modal）：**卡片式浮层**（#8，与拍摄卡同一套
 * 容器/圆角/间距语言）——深色 scrim 压暗日记画布 + 居中录音卡（卡头（录音
 * 标识 + 右上关闭钮）+ 大计时器（30px 阶、tabular-nums）+ 动态声纹条 +
 * 停止（落库）/ 取消（丢弃））。
 *
 * 声纹条：RN Animated 弹簧条列（铁律：交互动画只用 RN Animated）。SDK58 的
 * recorder.getStatus().metering 在 isMeteringEnabled 时提供真实 dB——有则真数据，
 * 没有则平滑伪动效（web 部分浏览器不回 metering）。条列动画只动 transform
 * （scaleY，native driver），不动高度（免逐帧布局）。
 *
 * 生命周期：挂载即 prepareToRecordAsync + record；停止钮以 isRecording 门控
 * （prepare 完成前禁用——Android MediaRecorder 未 start 即 stop 会产出无效
 * 文件，不可落库）；卸载兜底 stop（防泄漏）。
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

export function RecordingOverlay({
    onComplete,
    onCancel,
    onError,
}: {
    /** 停止并保留：带回录音 uri 与时长（上游走 pending 占位入库流）。 */
    onComplete: (result: RecordingResult) => void;
    /** 停止并丢弃。 */
    onCancel: () => void;
    /** 准备/启动失败（权限后置失败、设备占用等），文案上浮 store.error。 */
    onError: (message: string) => void;
}) {
    const palette = usePalette();
    // HIGH_QUALITY 预设（.m4a）+ 打开 metering（声纹条真数据）；文件落 cache
    // 目录（SDK 随机文件名，录音生命周期随系统缓存清理）
    const recorder = useAudioRecorder({
        ...RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
    });
    // 轮询间隔 120ms：计时器跳动与声纹刷新共用一个源（避免双定时器漂移）
    const state = useAudioRecorderState(recorder, 120);

    const startedRef = useRef(false);
    const finishedRef = useRef(false);
    // 条列动画值：scaleY 0.08..1（native driver）
    const bars = useMemo(
        () => Array.from({ length: BAR_COUNT }, () => new Animated.Value(0.08)),
        [],
    );
    // 最新电平镜像（metering 轮询节流到动画层，条列统一向目标逼近）
    const levelRef = useRef(0.12);

    // 启动录音（一次性；prepare 失败上浮错误并关闭）
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
                    onError(
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

    // 卸载兜底：录到一半被卸载（返回键/外层关闭）必须停录，防麦克风持续占用。
    // 属性读取/stop() 全体 try 包裹：卸载清理与 useAudioRecorder 的
    // useReleasingSharedObject release 存在微任务时序竞态，recorder 已 release
    // 时读属性/调方法会同步抛（released SharedObject）——兜底失败无需上浮，
    // release 链路本身会回收 MediaRecorder（sharedObjectDidRelease → reset）
    useEffect(() => {
        return () => {
            try {
                if (startedRef.current && !finishedRef.current && recorder.isRecording) {
                    void recorder.stop().catch(() => {
                        // 卸载路径无需上浮：SharedObject 随组件释放
                    });
                }
            } catch {
                // recorder 已 release：MediaRecorder 已随 release 回收，无需兜底
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recorder.id]);

    // 电平 → 条列动画：轮询节拍驱动（durationMillis 每 120ms 必变 → 条列持续呼吸；
    // 仅挂 metering 会在静音/无 metering 的 web 上冻结），真数据优先、伪动效兜底
    useEffect(() => {
        levelRef.current = normalizeMetering(state.metering);
        const now = Date.now() / 1000;
        bars.forEach((bar, i) => {
            const { envelope, phase } = BAR_JITTER[i];
            // 真数据（有 metering）：电平 × 包络 × 相位微差；伪动效：正弦平滑呼吸
            const target = Math.min(
                1,
                Math.max(0.08, levelRef.current * envelope * (0.75 + 0.25 * Math.sin(now * 5 + phase))),
            );
            Animated.timing(bar, {
                toValue: target,
                duration: 110,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
            }).start();
        });
    }, [bars, state.durationMillis, state.metering]);

    const handleStop = useCallback(() => {
        if (finishedRef.current) return;
        // 未真正开录（prepare 未完成 / record 未执行）不进落库流：Android 的
        // MediaRecorder 未 start 时 stop() 会抛——native 捕获后 recorder.uri 仍
        // 指向一个无效（0 字节/无容器头）文件，照常落库即坏块。停止钮未就绪态
        // 已禁用（isRecording 门控），这里是双保险（闭包内 isRecording 最多
        // 滞后一个 120ms 轮询拍，窗口一致）
        if (!state.isRecording) return;
        finishedRef.current = true;
        void (async () => {
            try {
                // stop() resolve 值按平台分流（JS 类型标注 Promise<void>，运行时：
                // Android = 最终 status Bundle{ durationMillis, url }——以停止时刻
                // 为准，胜过 120ms 轮询的 state 快照（末拍最多差 120ms+50ms 阈值）；
                // web/iOS resolve undefined，走 state/recorder.uri 兜底）
                const stopStatus = (await recorder.stop()) as
                    | { durationMillis?: number; url?: string }
                    | undefined;
                if (
                    stopStatus != null &&
                    typeof stopStatus === 'object' &&
                    stopStatus.url == null
                ) {
                    // Android 停止失败路径（MediaRecorder.stop 抛错时 Bundle 不带
                    // url，但 recorder.uri 仍指向无效文件——不可落库）
                    onError('录音停止失败，请重试。');
                    return;
                }
                const uri = stopStatus?.url ?? recorder.uri ?? state.url;
                if (!uri) {
                    onError('录音未生成文件，请重试。');
                    return;
                }
                const finalDurationMs =
                    stopStatus?.durationMillis != null && stopStatus.durationMillis > 0
                        ? stopStatus.durationMillis
                        : state.durationMillis;
                onComplete({ uri, durationMs: Math.round(finalDurationMs) });
            } catch (error) {
                onError(
                    `录音停止失败：${error instanceof Error ? error.message : String(error)}`,
                );
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recorder.id, state.isRecording, state.durationMillis, state.url]);

    const handleCancel = useCallback(() => {
        if (finishedRef.current) return;
        finishedRef.current = true;
        void (async () => {
            try {
                await recorder.stop();
            } catch {
                // 丢弃路径：停止失败不阻塞关闭
            }
            // cache 目录临时文件随系统清理（取消录音不进库，无需显式删除）
            onCancel();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recorder.id]);

    // Android 返回键 = 取消丢弃（替代 Modal onRequestClose 语义）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            handleCancel();
            return true;
        });
        return () => sub.remove();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handleCancel]);

    const elapsedSec = state.durationMillis / 1000;

    return (
        <View className="absolute inset-0 z-50 bg-ink-scrim dark:bg-inkd-scrim">
            {/* scrim 不接管点击（录音误触丢弃代价高），出口 = 取消钮/卡头关闭钮/返回键 */}
            <View className="flex-1 items-center justify-center px-6">
                {/* 录音卡（深底卡，与拍摄卡同容器语言：rounded-card + 集中控制行）。
                    卡头（#8 打磨轮）：录音标识 + 右上关闭钮（关闭语言统一，
                    CloseButton onDark 变体——深底卡恒近黑，与主题无关） */}
                <View className="w-full max-w-[400px] rounded-card bg-[#0B0D0F] p-5">
                    <View className="flex-row items-center justify-between">
                        <View className="flex-row items-center gap-2">
                            <AudioLinesIcon size={16} strokeWidth={1.9} color="#FFFFFFB3" />
                            <Text className="text-[12px] text-white/70">录音中</Text>
                        </View>
                        {/* 44 视觉盒（组件内不传 hitSlop）：左邻标识组为非按压体，
                            卡头右缘即卡内边距，无相邻命中元素，无重叠核算项 */}
                        <CloseButton onDark onPress={handleCancel} label="取消录音" />
                    </View>

                    {/* 大计时器（30px 阶，tabular-nums 房规） */}
                    <Text
                        className="mt-6 text-center text-[30px] font-semibold text-white"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {formatAudioTime(elapsedSec)}
                    </Text>

                    {/* 声纹条列：底部对齐的 scaleY 弹簧条，中心高两侧低。
                        静态 key 收口（P0 审计）：Animated 壳 style 只留 transform（scaleY，
                        native driver 白名单键）；width/height/borderRadius/backgroundColor
                        全部下沉到壳内非动画 View——壳按内容收缩包裹出与旧版相同的
                        3×56 盒（items-end 对齐、中心缩放语义不变）。NativeAnimatedValidation
                        只校验动画键本身，静态布局键留在 Animated style 上是未来 RN 收紧
                        校验时的隐患，防患收掉 */}
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

                    {/* 操作区：取消 / 停止。两钮视觉盒均 ≥44 且相距 24dp ≥ 2×0（不传 hitSlop），
                        命中区不重叠。停止钮以 isRecording 门控（准备阶段禁用，视觉 40% 降透明）：
                        prepare 完成前「停止」会得到一个无效录音文件（Android MediaRecorder 未
                        start 即 stop 抛错）——禁用期触摸穿透到不接管点击的 scrim，无副作用 */}
                    <View className="mt-8 flex-row items-center justify-center" style={{ gap: 24 }}>
                        <BouncyPressable onPress={handleCancel} scaleTo={0.9}>
                            <View
                                className="h-11 items-center justify-center rounded-control px-6"
                                style={{ backgroundColor: '#FFFFFF1A' }}
                                accessibilityRole="button"
                                accessibilityLabel="取消录音"
                            >
                                <Text className="text-[14px] font-medium text-white">取消</Text>
                            </View>
                        </BouncyPressable>
                        <BouncyPressable
                            onPress={handleStop}
                            scaleTo={0.9}
                            disabled={!state.isRecording}
                        >
                            <View
                                className={`h-11 items-center justify-center rounded-control px-6 ${
                                    state.isRecording ? '' : 'opacity-40'
                                }`}
                                style={{ backgroundColor: palette.primaryBtn }}
                                accessibilityRole="button"
                                accessibilityLabel="停止录音"
                                accessibilityState={{ disabled: !state.isRecording }}
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

/** 录音平台支持探测（web 走 MediaRecorder，浏览器不支持时返回 false → 录音钮隐藏）。 */
export function isRecordingSupported(): boolean {
    if (Platform.OS !== 'web') return true;
    const w = globalThis as { MediaRecorder?: unknown };
    return typeof w.MediaRecorder === 'function';
}
