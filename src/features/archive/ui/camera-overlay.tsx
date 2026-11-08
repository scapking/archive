import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    BackHandler,
    Linking,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView } from 'expo-camera';
import { BouncyPressable, LucideCamera, LucideImage, LucideTrash } from '@/core/icons';
import { SwitchCameraIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { camera } from '@/core/camera';

/**
 * 拍摄域（控制器化 + 悬浮小窗，后台继续模型）：
 *
 * **CameraView 卸载即停是原生约束**——因此拍摄会话把「关闭覆盖层」重新定义为
 * **最小化**：录制中按 X（或返回键）= 全屏取景卡收起为右下悬浮小窗
 * （96×144dp 圆角小窗，CameraView 保持挂载在小窗内继续录制），点小窗重开
 * 全屏覆盖层，小窗带停止钮（真停止 → 落库）与长按丢弃；只有快门停止/小窗
 * 停止才落库，取消（覆盖层内取消钮 / 小窗长按）= 丢弃。
 *
 * 实现关键：**相机帧节点恒挂载**——全屏卡 ↔ 悬浮小窗只切换宿主/帧的 style
 * （同一 React 节点换布局，CameraView 不重挂不重开），全屏态独有的模式切换
 * 行与控制行在收起态整段卸载（不影响相机帧身份）。scrim 仅全屏态渲染；收起
 * 态宿主 pointerEvents box-none→auto，画布编辑零阻塞（后台并行模型）。
 *
 * 权限流与旧口径一致（checking/unavailable/denied 三态卡，权限拒绝引导 +
 * 相册兜底）；视频录制无时长上限（#10）；web 能力边界不变（recordAsync 无
 * web 实现，视频档隐藏）。
 *
 * 离开屏契约（onRegisterLeave 登记）：stopForLeave 在屏层卸载 CameraView
 * 之前同步发起 stopRecording，并等待 recordAsync resolve（5s 超时护栏）后交
 * onLeavePersist 落库（不丢素材）；卸载兜底路径（屏层未拦截的退出，如 iOS
 * 侧滑）尝试停录并让产物走 onLeavePersist——CameraView 已随卸载释放时产物
 * 无法追回（文件留 cache 由系统清理），属极端退出路径的已知取舍，见报告。
 */

export interface CameraCapture {
    kind: 'image' | 'video';
    uri: string;
    width: number | null;
    height: number | null;
}

export function isVideoCaptureSupported(): boolean {
    return Platform.OS !== 'web';
}

/** 悬浮小窗几何（dp）：96×144 圆角小窗右下悬挂（+ FAB 上方 12dp）。 */
const PIP_WIDTH = 96;
const PIP_HEIGHT = 144;
const PIP_RADIUS = 12;
/** 小窗录制态描边（录制红，一眼可辨）。 */
const PIP_RECORDING_BORDER = '#DC4A5E';
/** 小窗相对 + FAB（bottom + 24 + 56）的抬升。 */
const PIP_BOTTOM_OFFSET = 92;
/** 停录 promise 的收尾护栏（ms）：stopRecording 后 recordAsync 未 resolve 的
 *  极端时序下放弃等待（产物无法追回，不让离开屏无限挂起）。 */
const STOP_RESOLVE_TIMEOUT_MS = 5000;

export function CameraCaptureOverlay({
    initialMode = 'photo',
    onFinish,
    onClose,
    onDiscard,
    onLeavePersist,
    onRegisterLeave,
    onLibraryFallback,
}: {
    /** 打开时的默认模式（+ 选择器行语义：拍照 / 拍视频）。 */
    initialMode?: 'photo' | 'video';
    /** 快门产物（拍照即完成；视频 = 手动停止后完成）——屏层走异步上传流。 */
    onFinish: (capture: CameraCapture) => void;
    /** 关闭会话（未录制时的 X/返回键；无落库义务）。 */
    onClose: () => void;
    /** 取消录像：停录并丢弃（覆盖层内取消钮 / 小窗长按）。 */
    onDiscard: () => void;
    /** 离开屏落库（屏层提供：DB 级追加媒体块 + 落库，不依赖已卸载的 UI 状态）。 */
    onLeavePersist: (capture: CameraCapture) => Promise<void>;
    /** 向屏层登记 stopForLeave（返回/收笔入口调用；卸载时登记 null）。 */
    onRegisterLeave: (stop: (() => Promise<void>) | null) => void;
    /** 相册导入兜底（权限拒绝态入口；屏层关闭会话并切换到 picker 流）。 */
    onLibraryFallback: () => void;
}) {
    const insets = useSafeAreaInsets();
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
    // 收起态（后台继续模型）：false = 全屏取景卡，true = 右下悬浮小窗
    const [minimized, setMinimized] = useState(false);
    // 快门失败提示（拍照/录像 promise 被打断）：可见可重试，不是「按了没反应」
    const [shutterError, setShutterError] = useState<string | null>(null);
    // 系统设置跳转失败提示（Android 无 app-settings: scheme 时）
    const [settingsHint, setSettingsHint] = useState(false);
    const cameraRef = useRef<CameraView>(null);
    // recordAsync 的 promise 在 stopRecording() 时才 resolve——pending 存 ref，
    // 停止/取消/离开三条收尾链路共用
    const recordingRef = useRef(false);
    const recordPromiseRef = useRef<Promise<{ uri: string } | undefined> | null>(null);
    // 快门互斥 ref（「启动中」+「录制中」两态的锁）：capturePhoto/beginRecording
    // 的守卫读 ref 不读 state（deps 收口为 [] 的稳定回调，state 会陈旧）；
    // capturing state 仅服务未来 UI 态
    const capturingRef = useRef(false);
    // 收尾路标：discard = 停录后丢弃；leaving = 离开屏（产物走 onLeavePersist）；
    // ended = 会话已终结（防重复收尾）
    const discardRef = useRef(false);
    const leavingRef = useRef(false);
    const endedRef = useRef(false);
    // 回调 ref 镜像（异步链跨卸载存活时读最新闭包）
    const onFinishRef = useRef(onFinish);
    onFinishRef.current = onFinish;
    const onDiscardRef = useRef(onDiscard);
    onDiscardRef.current = onDiscard;
    const onLeavePersistRef = useRef(onLeavePersist);
    onLeavePersistRef.current = onLeavePersist;

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

    const openSystemSettings = () => {
        // iOS: app-settings: 直达本 app 设置页；Android 无对应 scheme，
        // openURL 会 reject——catch 后改提示手动路径
        void Linking.openURL('app-settings:').catch(() => {
            setSettingsHint(true);
        });
    };

    const capturePhoto = useCallback(async () => {
        if (capturingRef.current || recordingRef.current) return;
        capturingRef.current = true;
        setCapturing(true);
        try {
            const picture = await cameraRef.current?.takePictureAsync({
                quality: 1,
                exif: false,
            });
            if (picture?.uri) {
                endedRef.current = true;
                onFinishRef.current({
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
     * resolve 后按路标分派：leaving = onLeavePersist（离开屏）/
     * discard = onDiscard（取消）/ 其余 = onFinish（真停止落库）。
     */
    const beginRecording = useCallback(async () => {
        if (capturingRef.current || recordingRef.current) return;
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
            // 不传 maxDuration（#10 无上限）：resolve 只发生在手动停止
            const recordPromise = cameraRef.current?.recordAsync() ?? Promise.resolve(undefined);
            recordPromiseRef.current = recordPromise;
            const result = await recordPromise;
            recordPromiseRef.current = null;
            recordingRef.current = false;
            setRecording(false);
            if (leavingRef.current) {
                // 离开屏路径：产物交 DB 级落库（不进 UI 回调——会话已在收尾）
                if (result?.uri) {
                    endedRef.current = true;
                    await onLeavePersistRef.current({
                        kind: 'video',
                        uri: result.uri,
                        width: null,
                        height: null,
                    });
                }
                return;
            }
            if (discardRef.current) {
                onDiscardRef.current();
                return;
            }
            if (result?.uri) {
                endedRef.current = true;
                onFinishRef.current({ kind: 'video', uri: result.uri, width: null, height: null });
            } else {
                // resolve 空产物（取景器被系统停掉等）：可见可重试
                setShutterError('录制失败，请重试。');
            }
        } catch {
            // 中断场景：录像 promise 被打断（recordAsync reject，如相机被系统回收）
            // ——不复位 recording 会让界面永久停在「录制中」红块且 stopRecording
            // 永远等不到 resolve；finally 只复位 capturing，录制态必须在 catch 归零。
            // 收尾路标优先：取消/离开路径的 reject 不当失败提示
            recordingRef.current = false;
            setRecording(false);
            if (discardRef.current) onDiscardRef.current();
            else if (!leavingRef.current) setShutterError('录制失败，请重试。');
        } finally {
            capturingRef.current = false;
            setCapturing(false);
        }
    }, []);

    const onShutterPress = useCallback(() => {
        if (permission !== 'granted' || leavingRef.current || endedRef.current) return;
        setShutterError(null); // 重试即清上次失败提示
        if (mode === 'photo') {
            void capturePhoto();
            return;
        }
        if (recordingRef.current) {
            // 录制中再按快门 = 真停止（resolve → onFinish 落库）。必须先于
            // capturing 守卫（#6 根因，见旧注）：recordAsync await 期间
            // capturing 恒为 true，先查会把停止路径整段吞掉
            recordingRef.current = false;
            cameraRef.current?.stopRecording();
            return;
        }
        void beginRecording();
    }, [permission, mode, capturePhoto, beginRecording]);

    /** 小窗/控制行的停止（真停止 → 落库）：与快门停止同一收尾链。 */
    const stopRecording = useCallback(() => {
        if (!recordingRef.current) return;
        recordingRef.current = false;
        cameraRef.current?.stopRecording();
    }, []);

    /** 取消录像（覆盖层内取消钮 / 小窗长按）：停录并丢弃。 */
    const cancelRecording = useCallback(() => {
        if (!recordingRef.current) return;
        discardRef.current = true;
        recordingRef.current = false;
        cameraRef.current?.stopRecording();
    }, []);

    /**
     * 离开屏停录（屏层返回/收笔入口调用；收笔路径 await 本 promise）：在
     * 屏层卸载 CameraView **之前**同步发起 stopRecording（卸载即停是原生
     * 约束，停录必须在位），再等 recordAsync resolve（5s 护栏）落库。
     */
    const stopForLeave = useCallback(async (): Promise<void> => {
        if (endedRef.current) return;
        if (!recordingRef.current) {
            endedRef.current = true;
            return;
        }
        leavingRef.current = true;
        recordingRef.current = false;
        cameraRef.current?.stopRecording();
        const pending = recordPromiseRef.current ?? Promise.resolve(undefined);
        const result = await Promise.race([
            pending,
            new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), STOP_RESOLVE_TIMEOUT_MS)),
        ]);
        endedRef.current = true;
        if (result?.uri) {
            await onLeavePersistRef.current({
                kind: 'video',
                uri: result.uri,
                width: null,
                height: null,
            });
        }
    }, []);

    // 向屏层登记离开入口（返回/收笔的拦截点）；卸载摘除
    useEffect(() => {
        onRegisterLeave(stopForLeave);
        return () => onRegisterLeave(null);
    }, [stopForLeave, onRegisterLeave]);

    // 卸载兜底：屏层未拦截的退出路径（如 iOS 侧滑返回）——标记 leaving 让
    // recordAsync 的 resolve 走 onLeavePersist（异步落库），并尽力停录；
    // CameraView 已随卸载释放时产物无法追回（见文件头注，已知取舍）
    useEffect(() => {
        return () => {
            if (endedRef.current || !recordingRef.current) return;
            recordingRef.current = false;
            leavingRef.current = true;
            try {
                cameraRef.current?.stopRecording();
            } catch {
                // 相机已随卸载释放：产物无法追回（cache 文件由系统清理）
            }
        };
    }, []);

    // Android 返回键（仅全屏态接管）：录制中 = 收起（后台继续）；未录制 =
    // 关闭会话。收起态不注册（回落屏层 handler：离开屏 = 停录落库）
    useEffect(() => {
        if (minimized || permission !== 'granted') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (recordingRef.current) {
                setMinimized(true);
                return true;
            }
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [minimized, permission, onClose]);

    const pipHostStyle = useMemo(
        () => ({
            position: 'absolute' as const,
            right: 24,
            bottom: insets.bottom + PIP_BOTTOM_OFFSET,
            width: PIP_WIDTH,
            height: PIP_HEIGHT,
        }),
        [insets.bottom],
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
    // 小窗 = 撑满 96×144 宿主 + 录制红描边
    const frameStyle = minimized
        ? {
              flex: 1 as const,
              borderRadius: PIP_RADIUS,
              borderWidth: 2,
              borderColor: PIP_RECORDING_BORDER,
          }
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
                代价高），出口只有关闭钮；收起态整层卸载，画布交互零阻塞 */}
            {!minimized ? (
                <View className="absolute inset-0 bg-ink-scrim dark:bg-inkd-scrim" />
            ) : null}

            {/* 相机宿主（恒挂载）：CameraView 卸载即停是原生约束——全屏取景卡 ↔
                右下悬浮小窗只切宿主 style（同一 React 节点换布局），取景卡内
                CameraView 不重挂不重开。全屏态 host = 居中列（flex-1）+ box-none
                （卡外触摸落 scrim）；小窗态 host = 96×144 绝对定位 + auto（小窗
                即命中面），画布其余区域零阻塞 */}
            {permission === 'granted' ? (
                <View
                    style={minimized ? pipHostStyle : fullHostStyle}
                    pointerEvents={minimized ? 'auto' : 'box-none'}
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
                            全屏/小窗两态共用 */}
                        {recording ? (
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
                        {minimized ? (
                            <>
                                {/* 小窗交互面（z-10，压住取景层——小窗不需要相机手势）：
                                    点按 = 重开全屏覆盖层（计时/录制态无缝恢复）；长按 =
                                    停录并丢弃。触摸面零 className（房规）：inline style */}
                                <Pressable
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        right: 0,
                                        bottom: 0,
                                        zIndex: 10,
                                    }}
                                    onPress={() => setMinimized(false)}
                                    onLongPress={cancelRecording}
                                    accessibilityRole="button"
                                    accessibilityLabel="正在录制，点按回到拍摄界面，长按取消录制"
                                />
                                {/* 小窗停止钮（z-20，真停止 → 落库）：32 视觉盒 +
                                    hitSlop 6 → 44 命中；red 方块停止语言与快门录制态一致 */}
                                <View
                                    className="absolute inset-x-0 bottom-0 z-20 items-center pb-1.5"
                                    pointerEvents="box-none"
                                >
                                    <BouncyPressable onPress={stopRecording} hitSlop={6} scaleTo={0.88}>
                                        <View
                                            className="h-8 w-8 items-center justify-center rounded-full bg-black/55"
                                            accessibilityRole="button"
                                            accessibilityLabel="停止录制"
                                        >
                                            <View className="h-3.5 w-3.5 rounded-[3px] bg-[#DC4A5E]" />
                                        </View>
                                    </BouncyPressable>
                                </View>
                            </>
                        ) : micDenied || shutterError ? (
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
                                disabled={recording}
                                onPress={() => setMode('photo')}
                            />
                            <ModeChip
                                label="视频"
                                active={mode === 'video'}
                                disabled={recording}
                                onPress={() => setMode('video')}
                            />
                        </View>
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
                                onPress={recording ? () => setMinimized(true) : onClose}
                                label={recording ? '收起并继续录制' : '关闭相机'}
                            />

                            {/* 快门大圆钮：拍照=白圆点；视频录制态=红方块停止 + 外环转红
                                （录制态一眼可辨，不靠文字）。#6 修复：onShutterPress 恒非空，
                                录制态失效根因在 capturing 守卫顺序（见其注） */}
                            <BouncyPressable onPress={onShutterPress} scaleTo={0.92}>
                                <View
                                    className="h-16 w-16 items-center justify-center rounded-full"
                                    style={{ borderWidth: 3, borderColor: recording ? '#DC4A5E80' : '#FFFFFF66' }}
                                    accessibilityRole="button"
                                    accessibilityLabel={mode === 'photo' ? '拍照' : recording ? '停止录制' : '开始录制'}
                                >
                                    {recording ? (
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
                                <BouncyPressable onPress={cancelRecording} scaleTo={0.9}>
                                    <View
                                        className="h-11 w-11 items-center justify-center rounded-full bg-white/10"
                                        accessibilityRole="button"
                                        accessibilityLabel="取消录制并丢弃"
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
                                <CloseButton onDark onPress={onClose} label="关闭相机" />
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
                                <CloseButton onDark onPress={onClose} label="关闭相机" />
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
