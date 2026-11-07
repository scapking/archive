import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Linking,
    Platform,
    Text,
    View,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { BouncyPressable, LucideCamera, LucideImage } from '@/core/icons';
import { SwitchCameraIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { camera } from '@/core/camera';

/**
 * 拍摄覆盖层（条件渲染，禁 RN Modal）：**卡片式浮层**（#1/#10）——屏中取景卡
 * （3:4 圆角卡 + 内嵌 CameraView）+ 卡下模式切换与快门/翻转/关闭控制行，
 * 深色 scrim 压暗日记画布，与录音卡同一套容器/圆角/间距语言（#8）。
 *
 * 视频录制**无时长上限**（#10 明确不可以有上限）：删除 5 分钟 maxDuration 与
 * 自动停录逻辑，计只数不设限（停止完全由用户手势触发；文件大小由系统存储
 * 与相机码率自然约束）。权限拒绝态：引导文案 + 跳系统设置（iOS app-settings:；
 * Android 无对应 scheme，catch 后仅提示）+ 相册导入兜底入口。
 *
 * 关闭语言统一（#8 打磨轮）：取景卡控制行关闭钮与权限卡右上关闭统一走
 * CloseButton（onDark 变体，白 10% 圆底），与录音卡 / 全屏查看器同一深底
 * 浮层语言；权限卡卡头化（标题 + 右上关闭），旧底部取消文字钮退役。
 *
 * web 能力边界（SDK58 实测 build 产物）：CameraView 走 getUserMedia 可取景、
 * takePictureAsync 返回 data-uri 可入库；recordAsync 无 web 实现——视频模式
 * 仅 native 显示（isVideoCaptureSupported 探测）。
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

export function CameraCaptureOverlay({
    initialMode = 'photo',
    onClose,
    onCapture,
    onLibraryFallback,
}: {
    /** 打开时的默认模式（+ 选择器行语义：拍照 / 拍视频）。 */
    initialMode?: 'photo' | 'video';
    onClose: () => void;
    /** 拍得素材（上游走 pending 占位入库流；宽高未知传 null）。 */
    onCapture: (capture: CameraCapture) => void;
    /** 相册导入兜底（权限拒绝态入口；上游切换到 picker 流）。 */
    onLibraryFallback: () => void;
}) {
    const [permission, setPermission] = useState<'checking' | 'granted' | 'denied'>('checking');
    const [mode, setMode] = useState<'photo' | 'video'>(initialMode);
    const [facing, setFacing] = useState<'back' | 'front'>('back');
    const [capturing, setCapturing] = useState(false);
    const [recording, setRecording] = useState(false);
    const [recordSeconds, setRecordSeconds] = useState(0);
    const [micDenied, setMicDenied] = useState(false);
    // 系统设置跳转失败提示（Android 无 app-settings: scheme 时）
    const [settingsHint, setSettingsHint] = useState(false);
    const cameraRef = useRef<CameraView>(null);
    // recordAsync 的 promise 在 stopRecording() 时才 resolve——pending 存 ref，
    // 卸载/关闭时兜底 stop，promise then 里的 onCapture 因组件已卸载由外层守卫
    const recordingRef = useRef(false);

    // 权限预检（进覆盖层即查/请求；拒绝进引导态，不给黑屏取景器）
    useEffect(() => {
        let active = true;
        void (async () => {
            const current = await camera.getPermissionAsync();
            if (current.granted) {
                if (active) setPermission('granted');
                return;
            }
            const requested = await camera.requestPermissionAsync();
            if (active) setPermission(requested.granted ? 'granted' : 'denied');
        })();
        return () => {
            active = false;
        };
    }, []);

    // 关闭/卸载兜底停录：防离开覆盖层后摄像头还在录
    useEffect(() => {
        return () => {
            if (recordingRef.current) {
                recordingRef.current = false;
                cameraRef.current?.stopRecording();
            }
        };
    }, []);

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
        if (capturing || recording) return;
        setCapturing(true);
        try {
            const picture = await cameraRef.current?.takePictureAsync({
                quality: 1,
                exif: false,
            });
            if (picture?.uri) {
                onCapture({
                    kind: 'image',
                    uri: picture.uri,
                    width: picture.width ?? null,
                    height: picture.height ?? null,
                });
            }
        } finally {
            setCapturing(false);
        }
    }, [capturing, recording, onCapture]);

    const toggleRecording = useCallback(async () => {
        // 录制中再按快门 = 停止。必须先于 capturing 守卫（#6 根因）：recordAsync
        // await 期间 capturing 恒为 true（它同时锁「启动中」与「录制中」两态），
        // 先查 capturing 会把停止路径整段吞掉——录制态快门只剩无效点击，用户
        // 只能靠关闭（X）经卸载守卫停录
        if (recording) {
            recordingRef.current = false;
            cameraRef.current?.stopRecording();
            return;
        }
        // 启动中（麦克风权限弹窗等）：忽略连点
        if (capturing) return;
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
            recordingRef.current = true;
            setRecording(true);
            // 不传 maxDuration（#10 无上限）：resolve 只发生在手动停止
            const result = await cameraRef.current?.recordAsync();
            recordingRef.current = false;
            setRecording(false);
            // 手动停止 resolve 回 uri；取消关闭路径由卸载守卫兜底
            if (result?.uri) {
                onCapture({ kind: 'video', uri: result.uri, width: null, height: null });
            }
        } finally {
            setCapturing(false);
        }
    }, [capturing, recording, onCapture]);

    const onShutterPress = useCallback(() => {
        if (permission !== 'granted') return;
        if (mode === 'photo') void capturePhoto();
        else void toggleRecording();
    }, [permission, mode, capturePhoto, toggleRecording]);

    if (permission === 'checking') {
        return (
            <View className="absolute inset-0 z-50 items-center justify-center bg-ink-scrim px-6 dark:bg-inkd-scrim">
                {/* 状态卡（与取景卡同容器语言） */}
                <View className="w-full max-w-[400px] items-center justify-center gap-3 rounded-card bg-black py-16">
                    <ActivityIndicator color="#FFFFFF" />
                    <Text className="text-[12px] text-white/60">正在打开相机…</Text>
                </View>
            </View>
        );
    }

    if (permission === 'denied') {
        return (
            <View className="absolute inset-0 z-50 items-center justify-center bg-ink-scrim px-6 dark:bg-inkd-scrim">
                {/* 权限引导卡（#8 打磨轮：与拍摄/录音卡同一卡头语言——标题行 +
                    右上关闭钮；旧底部「取消」文字钮退役，关闭入口统一卡头 X */}
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
        );
    }

    return (
        <View className="absolute inset-0 z-50 bg-ink-scrim dark:bg-inkd-scrim">
            {/* scrim 不接管点击（拍摄误触关闭代价高），出口只有关闭钮 */}
            <View className="flex-1 items-center justify-center px-6">
                {/* 取景卡：3:4 圆角卡，CameraView 铺满取景区（P0：CameraView 不支持
                    children——WARN "The <CameraView> component does not support
                    children"）。指示层改为 CameraView 的**兄弟节点绝对定位覆盖**：
                    relative 容器包住铺满的 CameraView，指示层 absolute 叠在其上
                    （RN 兄弟序后者在上；web 侧 absolute 锚点依赖 relative 父级） */}
                <View className="w-full max-w-[400px]" style={{ aspectRatio: 3 / 4 }}>
                    <View className="relative flex-1 overflow-hidden rounded-card bg-black">
                        {/* CameraView 只作取景层：零 children，铺满卡片 */}
                        <CameraView
                            ref={cameraRef}
                            style={{ flex: 1 }}
                            facing={facing}
                            // expo-camera CameraMode 词表为 'picture' | 'video'；覆盖层内部
                            // 语义叫 photo，传参处映射
                            mode={mode === 'photo' ? 'picture' : 'video'}
                            flash="off"
                        />
                        {/* 覆盖指示层（纯信息展示，pointerEvents none 不拦取景区触摸） */}
                        {/* 录制指示：红点 + 计时（tabular-nums 房规）；卡内左上 */}
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
                                    {String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:
                                    {String(recordSeconds % 60).padStart(2, '0')}
                                </Text>
                            </View>
                        ) : null}
                        {micDenied ? (
                            <View
                                className="absolute inset-x-3 bottom-3 z-10 items-center"
                                pointerEvents="none"
                            >
                                <Text className="rounded-full bg-black/45 px-3 py-1.5 text-[12px] text-white/80">
                                    需要麦克风权限才能录视频
                                </Text>
                            </View>
                        ) : null}
                    </View>
                </View>

                {/* 模式切换：拍照 / 视频（web 无 recordAsync，视频档隐藏）。
                    命中核算（hitSlop 4 的硬约束，间距须 ≥ 2×hitSlop=8px）：
                    - 纵向：chip 视觉 h-9(36) + 上下各 4 → 命中 44 凑规范；与上方
                      取景卡间距 mt-4(16)（取景卡非按压体）、下方控制行 mt-5(20)，
                      均大于 4，无跨行重叠项；
                    - 横向：两 chip 间距 = 容器 gap-2（8px，spacing 基数 4×2，无
                      自定义覆盖）= 2×hitSlop，命中盒在间隙中线相接、不重叠
                      （重叠带按绘制序右侧获胜会造成「点 A 触发 B」，见
                      bouncy-pressable 文件头核算规则）——实测布局若后续收窄到
                      <8px，必须先把 hitSlop 降到间距/2 或加大 gap。 */}
                {isVideoCaptureSupported() ? (
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

                {/* 控制行：关闭 / 快门 / 翻转。快门视觉 64px 圆 ≥44；关闭与翻转
                    44px 盒（CloseButton 统一组件 + 同语言翻转钮），三者中心距均
                    远超 2×hitSlop(0)，核算通过。触感底统一白 10%（与录音卡/
                    全屏查看器同一深底浮层语言，替代旧的 bg-black/35） */}
                <View className="mt-5 w-full max-w-[400px] flex-row items-center justify-between px-8">
                    <CloseButton onDark onPress={onClose} label="关闭相机" />

                    {/* 快门大圆钮：拍照=白圆点；视频录制态=红方块停止 + 外环转红
                        （录制态一眼可辨，不靠文字）。#6 修复：onShutterPress 恒非空
                        （BouncyPressable 不会因 undefined 穿透 disabled），录制态失效
                        根因在 toggleRecording 的 capturing 守卫顺序（见其注）。排查
                        备查：② CameraView 与快门分属取景卡/控制行两块，兄弟覆盖不
                        成立（卡内指示层均 pointerEvents="none"）；③ stopRecording →
                        recordAsync resolve → onCapture 链路完好（卸载兜底走同一链） */}
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

                    <BouncyPressable
                        onPress={() => {
                            if (!recording) setFacing((f) => (f === 'back' ? 'front' : 'back'));
                        }}
                        scaleTo={0.9}
                    >
                        <View className="h-11 w-11 items-center justify-center rounded-full bg-white/10">
                            <SwitchCameraIcon size={20} color="#FFFFFF" strokeWidth={1.9} />
                        </View>
                    </BouncyPressable>
                </View>
            </View>
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
