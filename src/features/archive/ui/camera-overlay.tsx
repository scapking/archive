import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    BackHandler,
    Linking,
    Platform,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { BouncyPressable, LucideCamera, LucideImage, LucideTrash } from '@/core/icons';
import { SwitchCameraIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { camera } from '@/core/camera';

/**
 * 拍摄域（全局会话化控制器，跨页面后台录制 + 隐形保活槽）：
 *
 * **CameraView 卸载即停是原生约束**——因此拍摄会话的 CameraView 常驻根层级
 * （由 recording-session.RecordingSessionHost 挂载本组件），「关闭覆盖层」
 * 语义 = **最小化**：录制中按 X（或返回键）= 全屏取景卡收起为**隐形保活槽**
 * （1×1dp + opacity 0 + pointerEvents none，absolute 挂根层级边缘——原生
 * 录制管线与预览可见性解耦，录制继续），点悬浮 chip（全局会话宿主渲染）
 * 重开全屏覆盖层；只有停止（快门再按 / 完成收笔编排停止）才落库，取消
 * （覆盖层内取消钮）= 丢弃；stop/cancel 后会话终结、CameraView 随之卸载。
 *
 * 实现关键：**相机帧节点恒挂载**——全屏取景卡 ↔ 隐形保活槽只切换宿主/帧的
 * style（同一 React 节点换布局，CameraView 不重挂不重开），全屏态独有的
 * 模式切换行与控制行在收起态整段卸载（不影响相机帧身份）。scrim 仅全屏态
 * 渲染；收起态整层零阻塞（后台并行模型）。
 *
 * 权限流与旧口径一致（checking/unavailable/denied 三态卡，权限拒绝引导 +
 * 相册兜底——兜底经全局编排 requestCaptureLibraryFallback 在根层级拉起
 * 相册，产物仍归属发起笔记）；视频录制无时长上限（#10）；web 能力边界不变
 * （recordAsync 无 web 实现，视频档隐藏，全局相机会在 web 仅承担拍照）。
 *
 * 停止链路（会话级，**不依赖覆盖层挂载状态**）：停止编排（等待/护栏/落库）
 * 全在 recording-session（会话级停止桥 + 停录 5s/落库 30s 双护栏）——本组件
 * 经 registerHardware 只登记 ref 绑定的原生停录/取消句柄（隐形保活槽态的
 * CameraView 同样可达，控制行/覆盖层卡片整段卸载后停止照常工作），并经
 * onProduct（拍照/快门停录/外部停录/系统收尾统一回流口）/onRecordFailed
 * （recordAsync reject 回执）把事实交回会话层分派；快门停止/取消钮只是
 * 调用编排（onStopRequest/onCancelRequest），不持有停止等待逻辑。
 */

export interface CameraCapture {
    kind: 'image' | 'video';
    uri: string;
    width: number | null;
    height: number | null;
}

/** 全局会话的相机硬件句柄（本组件登记、recording-session 编排层消费）。
 *  句柄只做 ref 绑定的原生调用；等待/护栏/落库在会话层（停止链路头注）。 */
export interface CameraCaptureHardware {
    /** 原生停录句柄：停掉原生录制，返回是否真有录制在停（false = 取景/
     *  未开录态，无产物——调用方按无产物收场）。 */
    stopRecording(): boolean;
    /** 原生取消句柄：标记丢弃并停录（产物回流后被会话层丢弃，不入库）。 */
    cancel(): void;
}

export function isVideoCaptureSupported(): boolean {
    return Platform.OS !== 'web';
}

/** 隐形保活槽几何：1×1dp 贴根层级右下缘（absolute + opacity 0，不挤占布局）。 */
const KEEP_ALIVE_SIZE = 1;

export function CameraCaptureOverlay({
    initialMode = 'photo',
    minimized,
    stopPending,
    ownerHint,
    registerHardware,
    onRecordStart,
    onTick,
    onProduct,
    onRecordFailed,
    onStopRequest,
    onCancelRequest,
    onClosed,
    onMinimize,
    onLibraryFallback,
}: {
    /** 打开时的默认模式（+ 选择器行语义：拍照 / 拍视频）。 */
    initialMode?: 'photo' | 'video';
    /** 收起态（全局会话最小化）：CameraView 收进隐形保活槽，录制继续。 */
    minimized: boolean;
    /** 停止/取消在途（全局会话 stopping 相位投影）：快门/取消/重录/模式切换
     *  全部闸住，快门给在途 spinner——护栏兜底下必有界，不静默吞点按。 */
    stopPending: boolean;
    /** 归属提示（owner 笔记展示名，录制中展示「停止后保存到 X」）。 */
    ownerHint: string | null;
    /** 向全局会话登记硬件句柄（ref 绑定的原生停录/取消句柄；卸载时登记 null）。
     *  停止编排已上收会话层——本组件不持有停止等待逻辑（停止链路头注）。 */
    registerHardware: (handlers: CameraCaptureHardware | null) => void;
    /** 开录回执（快门进入录制态）：全局会话 phase → recording。 */
    onRecordStart: () => void;
    /** 录制秒数上收（1s 节拍）：全局 chip / + 菜单状态行计时。 */
    onTick: (elapsedSec: number) => void;
    /** 产物回流（拍照即完成；视频 = 快门停止/外部停止/系统收尾后 resolve）——
     *  会话层按停止桥/归属落库统一分派（避免双驱动的分派口径在会话层）。 */
    onProduct: (capture: CameraCapture) => void;
    /** 录像链路异常回执（recordAsync reject）：会话层结算停止等待/回收相位。 */
    onRecordFailed: () => void;
    /** 快门停止（录制中再按快门）：经全局编排 stopCaptureSession（会话级停止
     *  桥 + 双护栏），最小化后重开停止同样成立。 */
    onStopRequest: () => void;
    /** 取消录像（覆盖层内取消钮）：经全局编排 cancelCaptureSession（停录丢弃）。 */
    onCancelRequest: () => void;
    /** 未录制时关闭会话（X/返回键；无落库义务）。 */
    onClosed: () => void;
    /** 录制中收起（X/返回键）：CameraView 进隐形保活槽，录制继续。 */
    onMinimize: () => void;
    /** 相册导入兜底（权限拒绝态入口；全局编排收场会话 + 相册选取仍归 owner）。 */
    onLibraryFallback: () => void;
}) {
    // checking / granted / denied 之外补 unavailable：权限查询/弹窗被系统中断
    // （reject）必须落明确失败态——卡在 checking = 永久「正在打开相机…」spinner，
    // 覆盖层整个不可用（任务口径：加载失败落失败态而非永久 spinner）
    const [permission, setPermission] = useState<'checking' | 'granted' | 'denied' | 'unavailable'>('checking');
    const [mode, setMode] = useState<'photo' | 'video'>(initialMode);
    const [facing, setFacing] = useState<'back' | 'front'>('back');
    const [capturing, setCapturing] = useState(false);
    const [recording, setRecording] = useState(false);
    const [recordSeconds, setRecordSeconds] = useState(0);
    const [micDenied, setMicDenied] = useState(false);
    // 快门失败提示（拍照/录像 promise 被打断）：可见可重试，不是「按了没反应」
    const [shutterError, setShutterError] = useState<string | null>(null);
    // 系统设置跳转失败提示（Android 无 app-settings: scheme 时）
    const [settingsHint, setSettingsHint] = useState(false);
    const cameraRef = useRef<CameraView>(null);
    // recordAsync 的 promise 在 stopRecording() 时才 resolve——pending 存 ref，
    // 停止/取消/外部停止共用（也作重录闸：上一段录像 promise 在途时拒绝重开）
    const recordingRef = useRef(false);
    const recordPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
    // 快门互斥 ref（「启动中」+「录制中」两态的锁）：capturePhoto/beginRecording
    // 的守卫读 ref 不读 state（deps 收口为 [] 的稳定回调，state 会陈旧）；
    // capturing state 仅服务未来 UI 态
    const capturingRef = useRef(false);
    // 丢弃路标（取消钮/外部取消）：停录产物不入库，静默——会话由编排层
    // cancelCaptureSession 收场，本组件只保证回流不误入落库通道
    const discardRef = useRef(false);
    // 收尾路标：ended = 会话已出产物/终结（拍照后防重复快门）
    const endedRef = useRef(false);
    // 停止/取消在途镜像（异步链守卫读 ref 不读 props——props 会陈旧）：
    // stopping 相位窗口内拒绝重录/重停/再拍，护栏兜底下窗口有界
    const stopPendingRef = useRef(stopPending);
    stopPendingRef.current = stopPending;
    // 回调 ref 镜像（异步链跨渲染存活时读最新闭包）
    const onProductRef = useRef(onProduct);
    onProductRef.current = onProduct;
    const onRecordFailedRef = useRef(onRecordFailed);
    onRecordFailedRef.current = onRecordFailed;
    const onStopRequestRef = useRef(onStopRequest);
    onStopRequestRef.current = onStopRequest;
    const onCancelRequestRef = useRef(onCancelRequest);
    onCancelRequestRef.current = onCancelRequest;
    const onRecordStartRef = useRef(onRecordStart);
    onRecordStartRef.current = onRecordStart;
    const onTickRef = useRef(onTick);
    onTickRef.current = onTick;

    // 权限预检（进覆盖层即查/请求；拒绝进引导态，不给黑屏取景器）。
    // 可重试：checkPermission 收口，unavailable 态的「重试」钮重新走一遍
    const checkPermission = useCallback(async () => {
        try {
            const current = await camera.getPermissionAsync();
            if (current.granted) {
                setPermission('granted');
                return;
            }
            const requested = await camera.requestPermissionAsync();
            setPermission(requested.granted ? 'granted' : 'denied');
        } catch {
            // 中断场景：权限 API reject（系统回收/环境异常）→ 失败态 + 重试入口
            setPermission('unavailable');
        }
    }, []);

    useEffect(() => {
        void checkPermission();
    }, [checkPermission]);

    // 录制计时（1s 节拍，只数不限——#10 无上限口径）
    useEffect(() => {
        if (!recording) return;
        setRecordSeconds(0);
        const timer = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
        return () => clearInterval(timer);
    }, [recording]);

    // 秒数上收全局会话（chip / + 菜单状态行计时；state 镜像效应避免在
    // setState updater 内做副作用）
    useEffect(() => {
        if (!recording) return;
        onTickRef.current(recordSeconds);
    }, [recording, recordSeconds]);

    const openSystemSettings = () => {
        // iOS: app-settings: 直达本 app 设置页；Android 无对应 scheme，
        // openURL 会 reject——catch 后改提示手动路径
        void Linking.openURL('app-settings:').catch(() => {
            setSettingsHint(true);
        });
    };

    const capturePhoto = useCallback(async () => {
        if (capturingRef.current || recordingRef.current || stopPendingRef.current) return;
        capturingRef.current = true;
        setCapturing(true);
        try {
            const picture = await cameraRef.current?.takePictureAsync({
                quality: 1,
                exif: false,
            });
            if (picture?.uri) {
                endedRef.current = true;
                // 拍照即产物：编排层按会话归属落库（拍照无后台语义，会话随之终结）
                onProductRef.current({
                    kind: 'image',
                    uri: picture.uri,
                    width: picture.width ?? null,
                    height: picture.height ?? null,
                });
            }
        } catch {
            // 中断场景：拍照 promise 被打断（相机被系统回收/占用）必须可见——
            // 只写 finally 会变 unhandled rejection + 「按了快门没反应」
            setShutterError('拍照失败，请重试。');
        } finally {
            capturingRef.current = false;
            setCapturing(false);
        }
    }, []);

    /**
     * 录像主链：麦克风权限 → recordAsync（不传 maxDuration，#10 无上限）→
     * resolve 后产物统一经 onProduct 回流会话层分派（停止在途 = 停止桥结算 /
     * 其余 = 按归属落库；discard 路标 = 取消丢弃，静默）——本组件不做停止
     * 等待与双驱动分派（会话级停止桥，见文件头注）。
     */
    const beginRecording = useCallback(async () => {
        // 守卫链：快门互斥（启动中/录制中）+ 停止在途（stopping 相位窗口拒绝
        // 重录）+ 上一段录像 promise 在途（极端时序下拒绝叠开第二段录制）
        if (capturingRef.current || recordingRef.current || stopPendingRef.current) return;
        if (recordPromiseRef.current) return;
        capturingRef.current = true;
        setCapturing(true);
        try {
            // 录像需麦克风权限：未授则先请求，拒绝停留提示（不静默转拍照）
            const mic = await camera.getMicrophonePermissionAsync();
            let micGranted = mic.granted;
            if (!micGranted) {
                const requested = await camera.requestMicrophonePermissionAsync();
                micGranted = requested.granted;
            }
            if (!micGranted) {
                setMicDenied(true);
                return;
            }
            setMicDenied(false);
            discardRef.current = false;
            recordingRef.current = true;
            setRecording(true);
            onRecordStartRef.current(); // 全局会话 phase → recording（chip/状态行口径）
            // 不传 maxDuration（#10 无上限）：resolve 只发生在手动停止
            const recordPromise = cameraRef.current?.recordAsync() ?? Promise.resolve(undefined);
            recordPromiseRef.current = recordPromise;
            const result = await recordPromise;
            recordPromiseRef.current = null;
            recordingRef.current = false;
            setRecording(false);
            // 取消丢弃：产物不入库且静默（会话已被 cancelCaptureSession 收场）
            if (discardRef.current) return;
            if (result?.uri) {
                endedRef.current = true;
                // 产物统一回流会话层：停止在途 → 停止桥结算；否则按归属落库
                // （拍照/系统收尾同口径，防串会话的 token 分派在会话层）
                onProductRef.current({ kind: 'video', uri: result.uri, width: null, height: null });
            } else {
                // resolve 空产物（取景器被系统停掉等）：可见可重试
                setShutterError('录制失败，请重试。');
            }
        } catch {
            // 中断场景：录像 promise 被打断（recordAsync reject，如相机被系统回收）
            // ——不复位 recording 会让界面永久停在「录制中」红块且 stopRecording
            // 永远等不到 resolve；finally 只复位 capturing，录制态必须在 catch 归零。
            recordingRef.current = false;
            recordPromiseRef.current = null;
            setRecording(false);
            // 取消路径：丢弃语义静默（会话已被 cancelCaptureSession 收场）
            if (discardRef.current) return;
            // 异常回执会话层：停止在途 → 立即结算停止等待（护栏不必空转 5s）；
            // 否则回收 recording 相位（不留僵尸 chip/状态行）。本地给可重试提示
            onRecordFailedRef.current();
            setShutterError('录制失败，请重试。');
        } finally {
            capturingRef.current = false;
            setCapturing(false);
        }
    }, []);

    const onShutterPress = useCallback(() => {
        // 停止/取消在途闸：stopping 相位窗口内拒绝重停/重录/拍照（有界窗口）
        if (permission !== 'granted' || endedRef.current || stopPendingRef.current) return;
        setShutterError(null); // 重试即清上次失败提示
        if (mode === 'photo') {
            void capturePhoto();
            return;
        }
        if (recordingRef.current) {
            // 录制中再按快门 = 真停止：统一走全局编排（会话级停止桥 + 双护栏），
            // 产物经 recordAsync continuation 回流会话层结算——最小化后重开
            // 停止同样成立。必须先于 capturing 守卫（#6 根因，见旧注）：
            // recordAsync await 期间 capturing 恒为 true，先查会把停止路径吞掉
            onStopRequestRef.current();
            return;
        }
        void beginRecording();
    }, [permission, mode, capturePhoto, beginRecording]);

    /** 取消录像（覆盖层内取消钮）：经全局编排停录并丢弃（会话级，护栏兜底）。 */
    const cancelRecording = useCallback(() => {
        if (!recordingRef.current || stopPendingRef.current) return;
        onCancelRequestRef.current();
    }, []);

    // 硬件句柄登记（会话级停止桥的原生调用端；卸载（会话终结）时摘除）：
    // 句柄只绑 ref——隐形保活槽态的 CameraView 同样可达，停止链路不依赖覆盖
    // 层 chrome（控制行/覆盖层卡片可整段卸载，最小化后停止照常工作）
    useEffect(() => {
        registerHardware({
            stopRecording: () => {
                const wasRecording = recordingRef.current;
                recordingRef.current = false;
                if (!wasRecording) return false;
                try {
                    cameraRef.current?.stopRecording();
                } catch {
                    // 相机已被系统回收：无产物可停——会话层护栏兜底收场
                }
                return true;
            },
            cancel: () => {
                if (!recordingRef.current) return;
                discardRef.current = true;
                recordingRef.current = false;
                try {
                    cameraRef.current?.stopRecording();
                } catch {
                    // 相机已释放：丢弃路径无产物可追
                }
            },
        });
        return () => registerHardware(null);
    }, [registerHardware]);

    // Android 返回键（仅全屏态接管）：录制中 = 收起（后台继续）；未录制 =
    // 关闭会话。收起态不注册（回落屏层 handler：导航自由，会话继续后台）
    useEffect(() => {
        if (minimized || permission !== 'granted') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (recordingRef.current) {
                onMinimize();
                return true;
            }
            onClosed();
            return true;
        });
        return () => sub.remove();
    }, [minimized, permission, onMinimize, onClosed]);

    // 隐形保活槽宿主（1×1dp + opacity 0 + pointerEvents none）：不挤占布局、
    // 不可见、零命中——原生录制管线继续采集（耗电代价见文件头注/报告）
    const keepAliveHostStyle = useMemo(
        () => ({
            position: 'absolute' as const,
            right: 0,
            bottom: 0,
            width: KEEP_ALIVE_SIZE,
            height: KEEP_ALIVE_SIZE,
            opacity: 0,
            overflow: 'hidden' as const,
        }),
        [],
    );
    const fullHostStyle = useMemo(
        () => ({
            flex: 1 as const,
            justifyContent: 'center' as const,
            alignItems: 'center' as const,
            paddingHorizontal: 24,
        }),
        [],
    );
    // 相机帧样式（同一节点换布局，见文件头注）：全屏 = max-w 400 + 3:4；
    // 保活槽 = 撑满 1×1 宿主（几何无意义，仅保活）
    const frameStyle = minimized
        ? { flex: 1 as const }
        : {
              width: '100%' as const,
              maxWidth: 400,
              aspectRatio: 3 / 4,
              borderRadius: 16,
          };

    const recordClock = `${String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:${String(
        recordSeconds % 60,
    ).padStart(2, '0')}`;

    return (
        <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
            {/* 全屏 scrim（仅全屏态）：压暗日记画布，不接管点击（拍摄误触关闭
                代价高），出口只有关闭钮；收起态整层卸载，画布/导航零阻塞 */}
            {!minimized ? (
                <View className="absolute inset-0 bg-ink-scrim dark:bg-inkd-scrim" />
            ) : null}

            {/* 相机宿主（恒挂载）：CameraView 卸载即停是原生约束——全屏取景卡 ↔
                隐形保活槽只切宿主 style（同一 React 节点换布局），CameraView
                不重挂不重开。全屏态 host = 居中列（flex-1）+ box-none（卡外
                触摸落 scrim）；保活槽态 host = 1×1 绝对定位 + none（不可见、
                零命中、零布局挤占），画布与其余页面交互完全自由 */}
            {permission === 'granted' ? (
                <View
                    style={minimized ? keepAliveHostStyle : fullHostStyle}
                    pointerEvents={minimized ? 'none' : 'box-none'}
                >
                    <View className="relative overflow-hidden bg-black" style={frameStyle}>
                        {/* CameraView 只作取景层：零 children，铺满帧（P0：CameraView
                            不支持 children——WARN 见旧注；指示层 = 兄弟节点绝对覆盖） */}
                        <CameraView
                            ref={cameraRef}
                            style={{ flex: 1 }}
                            facing={facing}
                            // expo-camera CameraMode 词表为 'picture' | 'video'；覆盖层内部
                            // 语义叫 photo，传参处映射
                            mode={mode === 'photo' ? 'picture' : 'video'}
                            flash="off"
                        />
                        {/* 录制指示：红点 + 计时（tabular-nums 房规）；帧内左上，
                            仅全屏态渲染（保活槽态不可见，无需指示） */}
                        {recording && !minimized ? (
                            <View
                                className="absolute left-3 top-3 z-10 flex-row items-center gap-2 rounded-full bg-black/45 px-3 py-1.5"
                                pointerEvents="none"
                            >
                                <View className="h-2 w-2 rounded-full bg-[#DC4A5E]" />
                                <Text
                                    className="text-[12px] font-medium text-white"
                                    style={{ fontVariant: ['tabular-nums'] }}
                                >
                                    {recordClock}
                                </Text>
                            </View>
                        ) : null}
                        {micDenied || shutterError ? (
                            // 提示槽单例（同一位置不叠两层）：麦克风引导优先，其次快门失败
                            <View
                                className="absolute inset-x-3 bottom-3 z-10 items-center"
                                pointerEvents="none"
                            >
                                <Text className="rounded-full bg-black/45 px-3 py-1.5 text-[12px] text-white/80">
                                    {micDenied ? '需要麦克风权限才能录视频' : shutterError}
                                </Text>
                            </View>
                        ) : null}
                    </View>

                    {/* 全屏态独有 chrome（收起态整段卸载，不影响相机帧节点身份）。
                        模式切换命中核算（hitSlop 4 硬约束，间距 ≥ 2×hitSlop=8px）：
                        两 chip 间距 = 容器 gap-2（8px）= 2×hitSlop，命中盒在间隙中线
                        相接、不重叠（重叠带按绘制序右侧获胜会造成「点 A 触发 B」，
                        见 bouncy-pressable 文件头核算规则） */}
                    {!minimized && isVideoCaptureSupported() ? (
                        <View className="mt-4 flex-row items-center justify-center gap-2" pointerEvents="box-none">
                            <ModeChip
                                label="拍照"
                                active={mode === 'photo'}
                                disabled={recording || stopPending}
                                onPress={() => setMode('photo')}
                            />
                            <ModeChip
                                label="视频"
                                active={mode === 'video'}
                                disabled={recording || stopPending}
                                onPress={() => setMode('video')}
                            />
                        </View>
                    ) : null}

                    {/* 归属提示（录制中，#归属铁律可视化）：停止产物固定落回发起笔记 */}
                    {!minimized && recording && ownerHint ? (
                        <Text className="mt-2 text-center text-[12px] text-white/60">
                            {`停止后保存到「${ownerHint}」`}
                        </Text>
                    ) : null}

                    {/* 控制行（全屏态）：关闭/收起 / 快门 / 翻转或取消。快门视觉 64px
                        圆 ≥44；关闭与右钮 44px 盒（CloseButton 统一组件），三者中心距
                        均远超 2×hitSlop(0)，核算通过。录制中语义切换：X = 收起（后台
                        继续录制）、右钮 = 取消并丢弃（翻转在录制态本就禁用，让位给
                        取消出口） */}
                    {!minimized ? (
                        <View className="mt-5 w-full max-w-[400px] flex-row items-center justify-between px-8">
                            <CloseButton
                                onDark
                                onPress={recording ? onMinimize : onClosed}
                                label={recording ? '收起并继续录制' : '关闭相机'}
                            />

                            {/* 快门大圆钮：拍照=白圆点；视频录制态=红方块停止 + 外环转红
                                （录制态一眼可辨，不靠文字）；停止在途=spinner（stopping
                                相位窗口有界，在途反馈不静默）。#6 修复：onShutterPress 恒
                                非空，录制态失效根因在 capturing 守卫顺序（见其注） */}
                            <BouncyPressable onPress={onShutterPress} scaleTo={0.92} disabled={stopPending}>
                                <View
                                    className="h-16 w-16 items-center justify-center rounded-full"
                                    style={{ borderWidth: 3, borderColor: recording ? '#DC4A5E80' : '#FFFFFF66' }}
                                    accessibilityRole="button"
                                    accessibilityLabel={
                                        mode === 'photo' ? '拍照' : recording ? '停止录制' : '开始录制'
                                    }
                                    accessibilityState={{ busy: stopPending }}
                                >
                                    {stopPending ? (
                                        <ActivityIndicator color="#FFFFFF" />
                                    ) : recording ? (
                                        <View className="h-5 w-5 rounded-[3px] bg-[#DC4A5E]" />
                                    ) : (
                                        <View
                                            className="h-[48px] w-[48px] rounded-full"
                                            style={{ backgroundColor: mode === 'photo' ? '#FFFFFF' : '#DC4A5E' }}
                                        />
                                    )}
                                </View>
                            </BouncyPressable>

                            {recording ? (
                                <BouncyPressable onPress={cancelRecording} scaleTo={0.9} disabled={stopPending}>
                                    <View
                                        className="h-11 w-11 items-center justify-center rounded-full bg-white/10"
                                        accessibilityRole="button"
                                        accessibilityLabel="取消录制并丢弃"
                                        accessibilityState={{ disabled: stopPending }}
                                    >
                                        <LucideTrash size={20} color="#FFFFFF" strokeWidth={1.9} />
                                    </View>
                                </BouncyPressable>
                            ) : (
                                <BouncyPressable
                                    onPress={() => {
                                        setFacing((f) => (f === 'back' ? 'front' : 'back'));
                                    }}
                                    scaleTo={0.9}
                                >
                                    <View className="h-11 w-11 items-center justify-center rounded-full bg-white/10">
                                        <SwitchCameraIcon size={20} color="#FFFFFF" strokeWidth={1.9} />
                                    </View>
                                </BouncyPressable>
                            )}
                        </View>
                    ) : null}
                </View>
            ) : !minimized ? (
                // 权限/失败态卡（收起态不可达：minimize 仅发生在已授权录制中）
                permission === 'checking' ? (
                    <View className="absolute inset-0 z-50 items-center justify-center bg-ink-scrim px-6 dark:bg-inkd-scrim">
                        {/* 状态卡（与取景卡同容器语言） */}
                        <View className="w-full max-w-[400px] items-center justify-center gap-3 rounded-card bg-black py-16">
                            <ActivityIndicator color="#FFFFFF" />
                            <Text className="text-[12px] text-white/60">正在打开相机…</Text>
                        </View>
                    </View>
                ) : permission === 'unavailable' ? (
                    <View className="absolute inset-0 z-50 items-center justify-center bg-ink-scrim px-6 dark:bg-inkd-scrim">
                        {/* 失败态卡（与权限卡同容器语言）：可重试自愈，不是死黑屏 */}
                        <View className="w-full max-w-[400px] rounded-card bg-black p-5">
                            <View className="flex-row items-center justify-between">
                                <Text className="text-[15px] font-semibold text-white">相机启动失败</Text>
                                <CloseButton onDark onPress={onClosed} label="关闭相机" />
                            </View>
                            <View className="items-center gap-3 py-6">
                                <LucideCamera size={36} color="#FFFFFF66" strokeWidth={1.5} />
                                <Text className="text-center text-[13px] leading-5 text-white/60">
                                    相机没能打开，可以重试，或先从相册导入。
                                </Text>
                            </View>
                            <View className="gap-2.5">
                                <BouncyPressable
                                    onPress={() => {
                                        setPermission('checking');
                                        void checkPermission();
                                    }}
                                    scaleTo={0.96}
                                >
                                    <View className="h-11 items-center justify-center rounded-control bg-white">
                                        <Text className="text-[14px] font-semibold text-black">重试</Text>
                                    </View>
                                </BouncyPressable>
                                <BouncyPressable onPress={onLibraryFallback} scaleTo={0.96}>
                                    <View className="h-11 items-center justify-center rounded-control border border-white/30">
                                        <View className="flex-row items-center gap-1.5">
                                            <LucideImage size={15} color="#FFFFFFB3" strokeWidth={1.9} />
                                            <Text className="text-[14px] font-medium text-white">
                                                从相册导入
                                            </Text>
                                        </View>
                                    </View>
                                </BouncyPressable>
                            </View>
                        </View>
                    </View>
                ) : (
                    <View className="absolute inset-0 z-50 items-center justify-center bg-ink-scrim px-6 dark:bg-inkd-scrim">
                        {/* 权限引导卡（#8 打磨轮：与拍摄/录音卡同一卡头语言——标题行 +
                            右上关闭钮；底部设置跳转 + 相册兜底双出口沿用旧口径） */}
                        <View className="w-full max-w-[400px] rounded-card bg-black p-5">
                            <View className="flex-row items-center justify-between">
                                <Text className="text-[15px] font-semibold text-white">没有相机权限</Text>
                                {/* 44 视觉盒：左邻标题非按压体，卡头右缘即卡内边距，无重叠核算项 */}
                                <CloseButton onDark onPress={onClosed} label="关闭相机" />
                            </View>
                            <View className="items-center gap-3 py-6">
                                <LucideCamera size={36} color="#FFFFFF66" strokeWidth={1.5} />
                                <Text className="text-center text-[13px] leading-5 text-white/60">
                                    去系统设置里允许相机，或者从相册选一张。
                                </Text>
                                {micDenied ? (
                                    <Text className="text-center text-[12px] text-white/50">
                                        录像还需要麦克风权限，系统设置里一并打开。
                                    </Text>
                                ) : null}
                                {settingsHint ? (
                                    <Text className="text-center text-[12px] text-white/50">
                                        未能跳转系统设置，请在系统设置 → 应用里手动允许相机。
                                    </Text>
                                ) : null}
                            </View>
                            {/* 两钮均 h-11 视觉盒 ≥44，gap-2.5(10px) 为不可点间隙，不传 hitSlop */}
                            <View className="gap-2.5">
                                <BouncyPressable onPress={openSystemSettings} scaleTo={0.96}>
                                    <View className="h-11 items-center justify-center rounded-control bg-white">
                                        <Text className="text-[14px] font-semibold text-black">
                                            打开系统设置
                                        </Text>
                                    </View>
                                </BouncyPressable>
                                <BouncyPressable onPress={onLibraryFallback} scaleTo={0.96}>
                                    <View className="h-11 items-center justify-center rounded-control border border-white/30">
                                        <View className="flex-row items-center gap-1.5">
                                            <LucideImage size={15} color="#FFFFFFB3" strokeWidth={1.9} />
                                            <Text className="text-[14px] font-medium text-white">
                                                从相册导入
                                            </Text>
                                        </View>
                                    </View>
                                </BouncyPressable>
                            </View>
                        </View>
                    </View>
                )
            ) : null}
        </View>
    );
}

function ModeChip({
    label,
    active,
    disabled,
    onPress,
}: {
    label: string;
    active: boolean;
    disabled: boolean;
    onPress: () => void;
}) {
    return (
        // onPress 恒挂接 + disabled 显式传导（#3 条件置空显式化）：recording 翻转
        // 瞬间条件置空会重配置 Pressability 吞首点；显式 disabled=true 不出按压
        // 反馈、触摸穿透到无按压体的父级，可观察行为与置空一致（行为矩阵见
        // bouncy-pressable 文件头）
        <BouncyPressable onPress={onPress} disabled={disabled} hitSlop={4} scaleTo={0.94}>
            <View
                className="h-9 items-center justify-center rounded-control px-4"
                style={{
                    backgroundColor: active ? '#FFFFFF' : '#FFFFFF1A',
                }}
                accessibilityRole="button"
                accessibilityState={{ disabled }}
            >
                <Text
                    className={`text-[13px] font-medium ${active ? 'text-black' : 'text-white'}`}
                >
                    {label}
                </Text>
            </View>
        </BouncyPressable>
    );
}
