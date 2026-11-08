import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Animated,
    BackHandler,
    Easing,
    Linking,
    Platform,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { CameraView } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BouncyPressable, LucideCamera, LucideImage, LucideTrash } from '@/core/icons';
import { SwitchCameraIcon } from './editor-icons';
import { CloseButton } from './close-button';
import { RecordingDot, useOverlayEntrance, useReduceMotionRef } from './recorder-overlay';
import { usePalette } from './theme';
import { camera } from '@/core/camera';

/**
 * 拍摄域（全局会话化控制器，跨页面后台录制 + 隐形保活槽）：
 *
 * ══ 设计决策书（与录音卡同一套「采集仪器」语言，决策全文见
 * recorder-overlay 头注）══ 本卡落地要点：
 * - **全屏取景页（系统相机布局，2026-11 全屏化）**：取景器 inset-0 边到边
 *   铺满——取景器即页面，无卡片框、无深底衬卡、无圆角取景框；控件悬浮在
 *   取景器上（半透明触感底 white/10 系，onDark 语言恒定），上下安全区
 *   insets 收口在控件悬浮层（取景器自身贴边）。布局：
 *   · 顶部 = 关闭（左）/ 翻转（右）/ 录制红点+计时（顶部居中，系统相机
 *     REC 位；录制中 X 语义 = 收起后台继续，归属提示列在计时下方）；
 *   · 底部 = 模式切换行（快门上方，系统相机「照片 | 视频」位）→ 快门
 *     72dp 居中下缘 → 左位相册兜底（录制中让位取消丢弃）/ 右位非按压
 *     配平块（44 = 快门真居中的对称配重）。
 *   web 仅拍照（recordAsync 无 web 实现，视频档隐藏，模式行整行不渲染）。
 * - **色彩只上数据**（app-screens 首条）：唯一彩色 = negative 红（REC 呼吸
 *   点 / 录制态快门停录块，palette.negative token 收口）；chrome 全灰阶
 *   （白 alpha 阶 / 反白 active 模式 chip——onDark 恒定，与主题无关）。
 * - **动效（RN Animated transform/opacity + native driver，铁律）**：
 *   ① 进场 = 层淡入 + 取景页上浮（translateY 16→0，240ms ease-out；全窗
 *   层禁 scale 防边缘露缝——全屏化后 scale 分量按此铁律摘除，动效挂取景
 *   页容器）；② 退场 = 进场逆放（停止 stopPending 相位驱动 160ms）；
 *   ③ **最小化收起 = 整机淡出下沉 180ms 后再切隐形保活槽几何**（chromeGone
 *   视图内相位：退场期间 host 仍保持全屏几何、触摸已整体释放，动效落地才
 *   收进 1×1 保活槽——CameraView 节点恒不重挂，只换宿主 style）；重开 =
 *   几何回全屏 + 进场重放（无缝恢复的承接）。录音卡因控制器挂载契约
 *   （!overlayOpen → null）即时卸载，收起语义由 chip 进场承接（见其注）；
 *   拍摄卡视图可自持相位，故这里做完整的退场动效。
 *   ④ REC 红点呼吸（RecordingDot，reduceMotion → 静态常亮）；
 *   ⑤ 快门白闪反馈（拍照态，opacity 0→0.9→0，60+220ms——capture 完成的
 *   状态指示，偶发档标准动画；chrome 悬浮层 z 序压过白闪层，闪的只是
 *   取景器、控件保持可辨）。
 *
 * **CameraView 卸载即停是原生约束**——因此拍摄会话的 CameraView 常驻根层级
 * （由 recording-session.RecordingSessionHost 挂载本组件），「关闭覆盖层」
 * 语义 = **最小化**：录制中按 X（或返回键）= 全屏取景页收起为**隐形保活槽**
 * （1×1dp + opacity 0 + pointerEvents none，absolute 挂根层级边缘——原生
 * 录制管线与预览可见性解耦，录制继续），点悬浮 chip（全局会话宿主渲染）
 * 重开全屏覆盖层；只有停止（快门再按 / 完成收笔编排停止）才落库，取消
 * （覆盖层内取消钮）= 丢弃；stop/cancel 后会话终结、CameraView 随之卸载。
 *
 * 实现关键：**相机帧节点恒挂载**——全屏取景页 ↔ 隐形保活槽只切换宿主
 * style（同一 React 节点换布局，CameraView 不重挂不重开）；几何切换收口
 * 在宿主一处（取景帧/控制台恒 flex-1 随宿主伸缩），全屏态独有的悬浮
 * chrome（顶栏/录制指示/底部集群）在收起态整段卸载（不影响相机帧身份）。
 * 全屏态不再渲染独立 scrim——取景器即页面，帧 bg-black 即暖机底色；保活
 * 槽态整层零阻塞（后台并行模型）。
 *
 * 权限流与旧口径一致（checking/unavailable/denied 三态，权限拒绝引导 +
 * 相册兜底——兜底经全局编排 requestCaptureLibraryFallback 在根层级拉起
 * 相册，产物仍归属发起笔记），三态同步全屏化（黑底整页，无衬卡）；
 * 视频录制无时长上限（#10）。
 *
 * 停止链路（会话级，**不依赖覆盖层挂载状态**）：停止编排（等待/护栏/落库
 * 后台化）全在 recording-session（会话级停止桥 + 停录 5s/落库 30s 双护栏）
 * ——本组件经 registerHardware 只登记 ref 绑定的原生停录/取消句柄（隐形
 * 保活槽态的 CameraView 同样可达，悬浮 chrome 整段卸载后停止照常工作），
 * 并经 onProduct（拍照/快门停录/外部停录/系统收尾统一回流口）/
 * onRecordFailed（recordAsync reject 回执）把事实交回会话层分派；快门停止/
 * 取消钮只是调用编排（onStopRequest/onCancelRequest），不持有停止等待逻辑。
 * 停止/取消的 UI 反馈 = 整页 ~160ms 淡出关闭（RN Animated opacity，
 * stopPending 相位投影驱动）——无 spinner 停留（关窗即返回，落库后台自动
 * 完成，结果由横幅反馈）；CameraView 必须存活到产物回流，卸载时机由会话
 * 层收尾协调。
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
    /** 停止/取消在途（全局会话 stopping 相位投影）：整页 ~160ms 淡出关闭 +
     *  触摸整体释放，快门/取消/重录/模式切换经 stopPendingRef 逻辑闸住——
     *  无 spinner/禁用态编排（关窗即反馈；护栏兜底下窗口有界）。 */
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
    /** 相册导入兜底（底部左位入口 + 权限拒绝态出口；全局编排收场会话 +
     *  相册选取仍归 owner）。 */
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
    const palette = usePalette();
    const insets = useSafeAreaInsets();
    // 进场/退场共用单一驱动值（useOverlayEntrance 头注，与录音卡同款）：
    // 挂载即进场（层淡入 + 取景页上浮 240ms）；停止/取消（stopPending
    // 相位投影）与最小化收起都走「进场逆放」（淡出+下沉）。CameraView 存活
    // 到产物回流，卸载时机由会话层收尾协调（淡出只是视觉，不提前卸载）；
    // 「减弱动态」降级为时长 0（单帧瞬时）
    const reduceMotionRef = useReduceMotionRef();
    const { appear, run } = useOverlayEntrance(reduceMotionRef);
    // 进场只由下方 minimized effect 统一驱动（挂载即 minimized=false 分支 →
    // 进场重放；与重开同一条路径，避免两 effect 同帧对同值各起一个 timing）
    useEffect(() => {
        if (!stopPending) return;
        run(0, 160);
    }, [stopPending, run]);
    // 最小化收起的视图内相位（chromeGone）：minimized 翻真 → 整机淡出下沉
    // （appear 1→0，180ms）→ 动效落地才置 chromeGone（宿主几何切 1×1 保活
    // 槽 + 全屏态 chrome 整段卸载）——退场期间宿主保持全屏几何、触摸经宿主
    // pointerEvents none 整体释放（退场窗口内悬浮控件全死，无幽灵点按）；
    // 重开（minimized 翻假）→ 先回全屏几何再重放进场（几何切换与动效同帧，
    // 无「先见 1×1 闪跳」）。CameraView 节点恒不重挂（同一 React 节点只换
    // 宿主 style），录制管线与退场动效完全解耦
    const [chromeGone, setChromeGone] = useState(minimized);
    useEffect(() => {
        if (minimized) {
            // 动画自然完成才收几何（被打断=用户快速重开，finished=false 不收）
            run(0, 180, (finished) => {
                if (finished) setChromeGone(true);
            });
            return;
        }
        // 挂载与重开共用本分支：先回全屏几何，再重放进场（层淡入 + 取景页
        // 上浮 240ms，与录音卡同拍）
        setChromeGone(false);
        run(1, 240);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- appear/run/reduceMotionRef 均为稳定引用
    }, [minimized]);
    // 快门白闪（拍照态 capture 完成的状态指示）：capturing 翻真时 opacity
    // 0→0.9→0（60+220ms），transform/opacity 白名单键；视频录制启动不走
    // 此反馈（mode==='photo' 门控）；层恒挂载（opacity 0 常驻）保帧内节点
    // 身份稳定
    const flash = useRef(new Animated.Value(0)).current;
    const flashAnimRef = useRef<Animated.CompositeAnimation | null>(null);
    useEffect(() => {
        if (!capturing || mode !== 'photo') return;
        // 上一次白闪在途（极速连拍窗口）先停再重置，避免旧 sequence 与新
        // 起点逐帧打架；capturing 归零不打断——白闪自然淡出完成视觉闭环
        flashAnimRef.current?.stop();
        flash.setValue(0);
        flashAnimRef.current = Animated.sequence([
            Animated.timing(flash, {
                toValue: 0.9,
                duration: 60,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
            }),
            Animated.timing(flash, {
                toValue: 0,
                duration: 220,
                easing: Easing.out(Easing.quad),
                useNativeDriver: true,
            }),
        ]);
        flashAnimRef.current.start();
    }, [capturing, mode, flash]);
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

    /** 取消录像（底部左位取消钮）：经全局编排停录并丢弃（会话级，护栏兜底）。 */
    const cancelRecording = useCallback(() => {
        if (!recordingRef.current || stopPendingRef.current) return;
        onCancelRequestRef.current();
    }, []);

    // 硬件句柄登记（会话级停止桥的原生调用端；卸载（会话终结）时摘除）：
    // 句柄只绑 ref——隐形保活槽态的 CameraView 同样可达，停止链路不依赖覆盖
    // 层 chrome（悬浮控件可整段卸载，最小化后停止照常工作）
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
    // 不可见、零命中——原生录制管线继续采集（耗电代价见文件头注/报告）。
    // 宿主几何按 chromeGone（退场动效落地）切换，不直接挂 minimized——退场
    // 期间保持全屏几何让整机淡出下沉可见（设计决策书③）
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
    // 全屏宿主（inset-0 全屏取景）：几何不再带留白/圆角——取景器即页面，
    // 安全区 insets 收口下沉到顶部栏/底部集群两处悬浮层
    const fullHostStyle = useMemo(() => ({ flex: 1 as const }), []);
    // 取景页容器（动效挂它，不挂全窗层——全窗层 scale 会露边缘缝，故进场
    // 只有上浮无微缩）：全屏 = 撑满全屏宿主；保活槽 = 撑满 1×1 宿主
    const consoleStyle = useMemo(() => ({ flex: 1 as const }), []);

    const recordClock = `${String(Math.floor(recordSeconds / 60)).padStart(2, '0')}:${String(
        recordSeconds % 60,
    ).padStart(2, '0')}`;

    return (
        <Animated.View
            pointerEvents={stopPending ? 'none' : 'box-none'}
            style={[StyleSheet.absoluteFill, { opacity: appear }]}
        >
            {/* 相机宿主（恒挂载）：CameraView 卸载即停是原生约束——全屏取景页 ↔
                隐形保活槽只切宿主 style（同一 React 节点换布局），CameraView
                不重挂不重开。几何切换挂 chromeGone（退场动效落地，见头注③）：
                退场期间 host 保持全屏几何但 pointerEvents none（悬浮控件整体
                死区，无幽灵点按）；保活槽态 host = 1×1 绝对定位 + none（不可
                见、零命中、零布局挤占），画布与其余页面交互完全自由 */}
            {permission === 'granted' ? (
                <View
                    style={chromeGone ? keepAliveHostStyle : fullHostStyle}
                    pointerEvents={minimized || chromeGone ? 'none' : 'box-none'}
                >
                    {/* 取景页容器（动效容器，设计决策书①③）：进场 = 上浮（appear
                        0→1），最小化/停止退场 = 进场逆放（下沉）+ 层淡入淡出；
                        box-none 不认领空域触摸 */}
                    <Animated.View
                        style={[
                            consoleStyle,
                            {
                                transform: [
                                    {
                                        translateY: appear.interpolate({
                                            inputRange: [0, 1],
                                            outputRange: [16, 0],
                                        }),
                                    },
                                ],
                            },
                        ]}
                        pointerEvents="box-none"
                    >
                        {/* 取景帧（恒 flex-1 随宿主伸缩，几何切换收口在宿主）：
                            overflow-hidden 负责白闪裁剪，bg-black 即暖机底色 */}
                        <View className="relative flex-1 overflow-hidden bg-black">
                            {/* CameraView 只作取景层：零 children，铺满帧（P0：CameraView
                                不支持 children——WARN 见旧注；指示/控件层 = 兄弟节点
                                绝对覆盖） */}
                            <CameraView
                                ref={cameraRef}
                                style={{ flex: 1 }}
                                facing={facing}
                                // expo-camera CameraMode 词表为 'picture' | 'video'；覆盖层内部
                                // 语义叫 photo，传参处映射
                                mode={mode === 'photo' ? 'picture' : 'video'}
                                flash="off"
                            />
                            {/* 快门白闪（拍照反馈，恒挂载 opacity 0 保帧内节点身份） */}
                            <Animated.View
                                className="absolute inset-0 z-20 bg-white"
                                pointerEvents="none"
                                style={{ opacity: flash }}
                            />

                            {/* 全屏态悬浮 chrome（保活槽态整段卸载，不影响相机帧节点
                                身份；最小化退场期间保持挂载、随整机淡出下沉）。z-30
                                压过白闪层（闪的只是取景器，控件不被淹没） */}
                            {!chromeGone ? (
                                <>
                                    {/* 顶部栏（系统相机位）：关闭（左）/ 翻转（右）。
                                        两钮 44 视觉盒 ≥44 不传 hitSlop；左右分列两端，
                                        中段为录制指示留空，无命中重叠核算项。录制中
                                        X 语义 = 收起（后台继续录制）；翻转禁用（录制
                                        态镜头锁定，禁用态 opacity-30 + a11y disabled） */}
                                    <View
                                        className="absolute inset-x-0 top-0 z-30 flex-row items-center justify-between px-4"
                                        style={{ paddingTop: insets.top + 8 }}
                                        pointerEvents="box-none"
                                    >
                                        <CloseButton
                                            onDark
                                            onPress={recording ? onMinimize : onClosed}
                                            label={recording ? '收起并继续录制' : '关闭相机'}
                                        />
                                        <BouncyPressable
                                            onPress={() => {
                                                setFacing((f) => (f === 'back' ? 'front' : 'back'));
                                            }}
                                            disabled={recording || stopPending}
                                            scaleTo={0.9}
                                        >
                                            {/* 条件类恒等：disabled 淡出档成对给出 */}
                                            <View
                                                className={`h-11 w-11 items-center justify-center rounded-full bg-white/10 ${
                                                    recording || stopPending ? 'opacity-30' : ''
                                                }`}
                                                accessibilityRole="button"
                                                accessibilityLabel="翻转镜头"
                                                accessibilityState={{ disabled: recording || stopPending }}
                                            >
                                                <SwitchCameraIcon size={20} color="#FFFFFF" strokeWidth={1.9} />
                                            </View>
                                        </BouncyPressable>
                                    </View>

                                    {/* 录制指示（顶部居中，系统相机 REC 位）：呼吸红点
                                        （三卡同款唯一数据色）+ 计时（tabular-nums 房规）
                                        + 归属提示（#归属铁律可视化：停止产物固定落回
                                        发起笔记）。整层 pointerEvents none；提示行
                                        px-16 让开两侧 60px 按钮带，numberOfLines=1 */}
                                    {recording ? (
                                        <View
                                            className="absolute inset-x-0 z-30 items-center"
                                            // 与顶栏按钮行同基线再下沉 7dp（~30px pill 在
                                            // 44px 行内垂直居中）
                                            style={{ top: insets.top + 15 }}
                                            pointerEvents="none"
                                        >
                                            <View className="flex-row items-center gap-2 rounded-full bg-black/45 px-3 py-1.5">
                                                <RecordingDot color={palette.negative} size={8} />
                                                <Text
                                                    className="text-[12px] font-medium text-white"
                                                    style={{ fontVariant: ['tabular-nums'] }}
                                                >
                                                    {recordClock}
                                                </Text>
                                            </View>
                                            {ownerHint ? (
                                                <Text
                                                    numberOfLines={1}
                                                    className="px-16 pt-2 text-center text-[12px] text-white/60"
                                                >
                                                    {`停止后保存到「${ownerHint}」`}
                                                </Text>
                                            ) : null}
                                        </View>
                                    ) : null}

                                    {/* 底部集群（系统相机位）：提示槽 → 模式行 → 快门行。
                                        安全区 insets 收口（home indicator 之上 20dp） */}
                                    <View
                                        className="absolute inset-x-0 bottom-0 z-30 items-center"
                                        style={{ paddingBottom: insets.bottom + 20 }}
                                        pointerEvents="box-none"
                                    >
                                        {/* 提示槽单例（同一位置不叠两层）：麦克风引导优先，
                                            其次快门失败。pointerEvents none 不挡快门 */}
                                        {micDenied || shutterError ? (
                                            <View className="mb-4 items-center" pointerEvents="none">
                                                <Text className="rounded-full bg-black/45 px-3 py-1.5 text-[12px] text-white/80">
                                                    {micDenied ? '需要麦克风权限才能录视频' : shutterError}
                                                </Text>
                                            </View>
                                        ) : null}

                                        {/* 模式切换行（快门上方，系统相机「照片 | 视频」位；
                                            web 无视频档整行隐藏）。命中核算（hitSlop 4 硬约束，
                                            间距 ≥ 2×hitSlop=8px）：两 chip 间距 = 容器 gap-2（8px）
                                            = 2×hitSlop，命中盒在间隙中线相接、不重叠（重叠带
                                            按绘制序右侧获胜会造成「点 A 触发 B」，见
                                            bouncy-pressable 文件头核算规则） */}
                                        {isVideoCaptureSupported() ? (
                                            <View
                                                className="mb-5 flex-row items-center justify-center gap-2"
                                                pointerEvents="box-none"
                                            >
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

                                        {/* 快门行：左位（录制中 = 取消丢弃 / 取景态 = 相册
                                            兜底）+ 快门 72dp 居中 + 右位 44 非按压配平块。
                                            左右槽等宽（44/44）+ justify-between → 快门真
                                            居中；快门 72 ≥44 不传 hitSlop，与两侧 44 槽
                                            间距由行宽兜出（≥8px），无命中重叠核算项 */}
                                        <View
                                            className="w-full flex-row items-center justify-between px-8"
                                            pointerEvents="box-none"
                                        >
                                            {recording ? (
                                                <BouncyPressable
                                                    onPress={cancelRecording}
                                                    scaleTo={0.9}
                                                    disabled={stopPending}
                                                >
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
                                                // 相册兜底（系统相机左下位语义）：经全局编排
                                                // 收场会话 + 拉起相册，产物仍归发起笔记
                                                <BouncyPressable onPress={onLibraryFallback} scaleTo={0.9}>
                                                    <View
                                                        className="h-11 w-11 items-center justify-center rounded-full bg-white/10"
                                                        accessibilityRole="button"
                                                        accessibilityLabel="从相册导入"
                                                    >
                                                        <LucideImage size={20} color="#FFFFFF" strokeWidth={1.9} />
                                                    </View>
                                                </BouncyPressable>
                                            )}

                                            {/* 快门大圆钮 72dp：拍照=白圆点；视频录制态=红方块
                                                停止 + 外环转红（录制态一眼可辨，不靠文字）；停止
                                                在途无 spinner——整页淡出关闭即反馈（关窗即返回）。
                                                #6 修复：onShutterPress 恒非空，录制态失效根因在
                                                capturing 守卫顺序（见其注） */}
                                            <BouncyPressable onPress={onShutterPress} scaleTo={0.92} disabled={stopPending}>
                                                <View
                                                    className="h-[72px] w-[72px] items-center justify-center rounded-full"
                                                    style={{
                                                        borderWidth: 3,
                                                        borderColor: recording
                                                            ? `${palette.negative}80`
                                                            : '#FFFFFF66',
                                                    }}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={
                                                        mode === 'photo' ? '拍照' : recording ? '停止录制' : '开始录制'
                                                    }
                                                    accessibilityState={{ disabled: stopPending }}
                                                >
                                                    {recording ? (
                                                        <View
                                                            className="h-6 w-6 rounded-[4px]"
                                                            style={{ backgroundColor: palette.negative }}
                                                        />
                                                    ) : (
                                                        <View
                                                            className="h-[54px] w-[54px] rounded-full"
                                                            style={{
                                                                backgroundColor:
                                                                    mode === 'photo' ? '#FFFFFF' : palette.negative,
                                                            }}
                                                        />
                                                    )}
                                                </View>
                                            </BouncyPressable>

                                            {/* 右位配平块（44 非按压体，与左位等宽 → 快门居中） */}
                                            <View className="h-11 w-11" />
                                        </View>
                                    </View>
                                </>
                            ) : null}
                        </View>
                    </Animated.View>
                </View>
            ) : !chromeGone ? (
                // 权限/失败态（收起态不可达：minimize 仅发生在已授权录制中）——
                // 同步全屏化：黑底整页（无衬卡），内容三段式（页头/居中主体/底部动作）
                permission === 'checking' ? (
                    <View className="absolute inset-0 z-50 items-center justify-center bg-black px-6">
                        <ActivityIndicator color="#FFFFFF" />
                        <Text className="mt-3 text-[12px] text-white/60">正在打开相机…</Text>
                    </View>
                ) : permission === 'unavailable' ? (
                    <CameraNoticeScreen title="相机启动失败" onClose={onClosed}>
                        <LucideCamera size={36} color="#FFFFFF66" strokeWidth={1.5} />
                        <Text className="text-center text-[13px] leading-5 text-white/60">
                            相机没能打开，可以重试，或先从相册导入。
                        </Text>
                        {/* 两钮 h-11 视觉盒 ≥44，纵向 gap-2.5(10px) 为不可点间隙，
                            不传 hitSlop；自愈口径：重试重走权限预检，不是死黑屏 */}
                        <View className="mt-4 w-full gap-2.5">
                            <BouncyPressable
                                onPress={() => {
                                    setPermission('checking');
                                    void checkPermission();
                                }}
                                scaleTo={0.96}
                            >
                                <View
                                    className="h-11 items-center justify-center rounded-control bg-white"
                                    accessibilityRole="button"
                                    accessibilityLabel="重试打开相机"
                                >
                                    <Text className="text-[14px] font-semibold text-black">重试</Text>
                                </View>
                            </BouncyPressable>
                            <BouncyPressable onPress={onLibraryFallback} scaleTo={0.96}>
                                <View
                                    className="h-11 items-center justify-center rounded-control border border-white/30"
                                    accessibilityRole="button"
                                    accessibilityLabel="从相册导入"
                                >
                                    <View className="flex-row items-center gap-1.5">
                                        <LucideImage size={15} color="#FFFFFFB3" strokeWidth={1.9} />
                                        <Text className="text-[14px] font-medium text-white">
                                            从相册导入
                                        </Text>
                                    </View>
                                </View>
                            </BouncyPressable>
                        </View>
                    </CameraNoticeScreen>
                ) : (
                    <CameraNoticeScreen title="没有相机权限" onClose={onClosed}>
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
                        {/* 底部双出口沿用旧口径：设置跳转 + 相册兜底（h-11 ≥44，
                            gap-2.5 为不可点间隙，不传 hitSlop） */}
                        <View className="mt-4 w-full gap-2.5">
                            <BouncyPressable onPress={openSystemSettings} scaleTo={0.96}>
                                <View
                                    className="h-11 items-center justify-center rounded-control bg-white"
                                    accessibilityRole="button"
                                    accessibilityLabel="打开系统设置"
                                >
                                    <Text className="text-[14px] font-semibold text-black">
                                        打开系统设置
                                    </Text>
                                </View>
                            </BouncyPressable>
                            <BouncyPressable onPress={onLibraryFallback} scaleTo={0.96}>
                                <View
                                    className="h-11 items-center justify-center rounded-control border border-white/30"
                                    accessibilityRole="button"
                                    accessibilityLabel="从相册导入"
                                >
                                    <View className="flex-row items-center gap-1.5">
                                        <LucideImage size={15} color="#FFFFFFB3" strokeWidth={1.9} />
                                        <Text className="text-[14px] font-medium text-white">
                                            从相册导入
                                        </Text>
                                    </View>
                                </View>
                            </BouncyPressable>
                        </View>
                    </CameraNoticeScreen>
                )
            ) : null}
        </Animated.View>
    );
}

/**
 * 权限/失败态全屏页壳（unavailable/denied 共用三段式）：黑底整页——页头
 * （题 + 右上关闭钮，#8 卡头语言全屏页同样适用）/ 居中主体（icon + 引导
 * 文案 + 动作钮组，children 直传）/ 底部安全区收口。主体 flex-1 垂直居中，
 * 动作组随内容排布（in-flow，不被绝对定位层遮挡）。安全区 insets 收口
 * （页头让开状态栏、底部让开手势条）。
 */
function CameraNoticeScreen({
    title,
    onClose,
    children,
}: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
}) {
    const insets = useSafeAreaInsets();
    return (
        <View
            className="absolute inset-0 z-50 bg-black px-6"
            style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}
        >
            {/* 页头：-mx-2 抵消页容器 px-6 的一半，标题/关闭钮落回屏内 16px
                档（与取景页顶栏 px-4 对齐）；44 视觉盒左邻标题非按压体，右缘
                即屏内边距，无重叠核算项 */}
            <View className="-mx-2 flex-row items-center justify-between">
                <Text className="text-[15px] font-semibold text-white">{title}</Text>
                <CloseButton onDark onPress={onClose} label="关闭相机" />
            </View>
            <View className="flex-1 items-center justify-center gap-3">
                {children}
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
