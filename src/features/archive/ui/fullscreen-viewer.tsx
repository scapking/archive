import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Animated,
    BackHandler,
    Image,
    PanResponder,
    Platform,
    Text,
    View,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';
import { VideoView, useVideoPlayer } from 'expo-video';
import { CloseButton } from './close-button';
import { ViewerPortal } from './viewer-portal';
import { useFileUrlState } from './use-file-url';

/**
 * 全屏媒体查看器本体（由 app/viewer.tsx 的 transparentModal 路由屏承载，禁
 * Modal——Fabric 触摸失效坑，范式同 archive-screen chooser）：图片 = 纯黑底 +
 * PanResponder 双指缩放（RN Animated 驱动，铁律：交互动画只用 RN Animated）+
 * 双击 1x↔2.5x + 下滑关闭；视频 = 纯黑底 + 自有 VideoView（native controls
 * 全开）。缩放态不触发下滑关闭。
 *
 * 覆盖整窗的机制：主容器 = /viewer 路由屏（root Stack transparentModal），
 * 本身就是 (tabs) 之上的窗口级容器，inset-0 即整窗——tab 屏内覆盖层盖不住
 * tabBar 条带的根因在路由层消除。FullscreenLayer 仍保留窗口级包装：
 * - iOS：react-native-screens FullWindowOverlay（窗口级容器，任何场景容器的
 *   clipsToBounds/stacking 都裁剪不到它）；
 * - web：ViewerPortal（react-dom portal）挂 body——DOM overflow:auto 真裁剪，
 *   portal 让覆盖层脱离路由场景容器（转场 transform/滚动视口），与 iOS 同为
 *   窗口级容器语义（.web/.native 分文件，react-dom 不进 native bundle）；
 * - Android：原位透传，路由屏内 inset-0 即整窗。
 * 旧的 useFullscreenAnchor/measureInWindow 负偏移定位随「屏内条件渲染覆盖层」
 * 架构一并移除（深层组件测量锚点只为把原位层挪回窗口原点，路由屏无需测量）。
 */

/** 双击缩放档位。 */
const DOUBLE_TAP_SCALE = 2.5;
/** 缩放上下限。 */
const MIN_SCALE = 1;
const MAX_SCALE = 5;
/** 下滑关闭：位移阈值（px）。 */
const DISMISS_DISTANCE = 120;
/** 双击判定窗口（ms）。 */
const DOUBLE_TAP_WINDOW = 280;

/**
 * 全屏层包装（窗口级容器语义）：iOS 走 FullWindowOverlay（children 直接铺满
 * 窗口）；web portal 到 body；Android 原位透传（路由屏内 inset-0 即整窗）。
 * 挂在 /viewer 路由屏内使用——路由屏本身已是窗口级容器，这层包装在 iOS/web
 * 上把黑底进一步抬出任何场景容器的裁剪与 stacking 语境（无害冗余）。
 */
export function FullscreenLayer({ children }: { children: React.ReactNode }) {
    if (Platform.OS === 'ios') {
        return <FullWindowOverlay>{children}</FullWindowOverlay>;
    }
    // web：DOM overflow:auto 会裁剪后代——内联渲染时覆盖层可能被裁进滚动
    // 视口/转场容器（黑底缺顶底、关闭钮落裁剪区点不到），portal 到 body 才
    // 与 iOS FullWindowOverlay 同为「窗口级容器」语义；
    // Android：透传，inset-0 原位渲染成立。
    return <ViewerPortal>{children}</ViewerPortal>;
}

/** 覆盖层定位样式：路由屏（窗口级容器）内 inset-0 即整窗，无需任何测量。 */
function viewerOverlayStyle(): StyleProp<ViewStyle> {
    return { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 50 };
}

/** 关闭钮（右上角；与手势层分离的兄弟节点，命中不受 PanResponder 干扰）。
    关闭语言统一（#8 打磨轮）：走 ui/close-button 的 onDark 变体（白 10% 圆底），
    与拍摄/录音卡同一深底浮层语言。 */
function ViewerCloseButton({ onClose }: { onClose: () => void }) {
    const insets = useSafeAreaInsets();
    return (
        <View className="absolute right-4 z-10" style={{ top: insets.top + 8 }}>
            {/* 44px 视觉盒 ≥44：不传 hitSlop（0）；屏隅无相邻命中元素 */}
            <CloseButton onDark onPress={onClose} label="关闭" />
        </View>
    );
}

/** 全屏视频：native controls 全开（时间码/进度/播放全套），关闭钮叠加右上。 */
export function FullscreenVideoViewer({
    fileKey,
    onClose,
}: {
    fileKey: string;
    onClose: () => void;
}) {
    const { status, uri } = useFileUrlState(fileKey);
    // source 直传 uri（可能为 null，VideoSource 合法值；禁空串——web <video src="">
    // 整页重下载告警坑，勿回潮）
    const player = useVideoPlayer(uri, (p) => {
        p.loop = false;
        p.play();
    });
    // Android 返回键关闭（替代 Modal onRequestClose 语义，范式同 archive-screen chooser）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);
    return (
        <FullscreenLayer>
            <View className="bg-black" style={viewerOverlayStyle()}>
                {status === 'ready' && uri ? (
                    <VideoView
                        player={player}
                        contentFit="contain"
                        style={{ flex: 1 }}
                        showsTimecodes
                        allowsPictureInPicture={false}
                    />
                ) : status === 'missing' ? (
                    <View className="flex-1 items-center justify-center px-6">
                        <Text className="text-[14px] text-white/70">视频无法播放</Text>
                    </View>
                ) : (
                    // 解析中：黑底 spinner（黑底上用白弱化文字，语义色 spinner 在纯黑底对比不足）
                    <View className="flex-1 items-center justify-center gap-3">
                        <ActivityIndicator color="#FFFFFF" />
                        <Text className="text-[12px] text-white/50">加载中…</Text>
                    </View>
                )}
                <ViewerCloseButton onClose={onClose} />
            </View>
        </FullscreenLayer>
    );
}

/** 全屏图片：手势容器（双指缩放 / 双击 / 下滑关闭），纯黑底。 */
export function FullscreenImageViewer({
    fileKey,
    onClose,
}: {
    fileKey: string;
    onClose: () => void;
}) {
    const { status, uri } = useFileUrlState(fileKey);
    const [entered, setEntered] = useState(false);
    // 覆盖层进场淡入（一次性 timing；非用户触发动画从简）
    const fade = useRef(new Animated.Value(0)).current;
    // 缩放/平移动画值 + 数值镜像（TS 不摸 Animated 私有 _value，镜像放 ref）
    const scaleAnim = useRef(new Animated.Value(1)).current;
    const translate = useRef({
        x: new Animated.Value(0),
        y: new Animated.Value(0),
    }).current;
    const metrics = useRef({ scale: 1, tx: 0, ty: 0 }).current;
    // 手势过程量：捏合起点距离/比例、双击计时、位移采样（算速度）
    const pinch = useRef({ active: false, startDist: 0, startScale: 1 }).current;
    const lastTapAt = useRef(0);
    const lastMove = useRef({ y: 0, t: 0 });

    useEffect(() => {
        Animated.timing(fade, {
            toValue: 1,
            duration: 160,
            useNativeDriver: true,
        }).start(() => setEntered(true));
    }, [fade]);

    // Android 返回键关闭（缩放态先复位缩放再关，防一指划出黑屏）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    const panResponder = useMemo(
        () =>
            PanResponder.create({
                onStartShouldSetPanResponder: () => true,
                onMoveShouldSetPanResponder: (_evt, gesture) =>
                    gesture.dy > 2 || gesture.dx > 2 || gesture.vx > 0 || pinch.active,
                onPanResponderGrant: (evt) => {
                    if (evt.nativeEvent.touches.length >= 2) return;
                    // 双击判定：仅 1x 档响应（缩放态单击留给拖拽复位）
                    const now = Date.now();
                    if (now - lastTapAt.current < DOUBLE_TAP_WINDOW && metrics.scale === 1) {
                        lastTapAt.current = 0;
                        const target = DOUBLE_TAP_SCALE;
                        metrics.scale = target;
                        metrics.tx = 0;
                        metrics.ty = 0;
                        Animated.parallel([
                            Animated.spring(scaleAnim, {
                                toValue: target,
                                friction: 8,
                                useNativeDriver: true,
                            }),
                            Animated.spring(translate.x, { toValue: 0, friction: 8, useNativeDriver: true }),
                            Animated.spring(translate.y, { toValue: 0, friction: 8, useNativeDriver: true }),
                        ]).start();
                        return;
                    }
                    lastTapAt.current = now;
                },
                onPanResponderMove: (evt, gesture) => {
                    const touches = evt.nativeEvent.touches;
                    if (touches.length >= 2) {
                        // 双指捏合：两触点间距比值驱动缩放（起点比例在首帧捏合记录）
                        const [a, b] = [touches[0], touches[1]];
                        const dist = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
                        if (!pinch.active) {
                            pinch.active = true;
                            pinch.startDist = Math.max(dist, 1);
                            pinch.startScale = metrics.scale;
                            return;
                        }
                        const next = Math.min(
                            MAX_SCALE,
                            Math.max(MIN_SCALE, (pinch.startScale * dist) / pinch.startDist),
                        );
                        metrics.scale = next;
                        scaleAnim.setValue(next);
                        return;
                    }
                    if (pinch.active) return;
                    if (metrics.scale > 1) {
                        // 缩放态单指：自由平移（复位的收束交给 release）
                        metrics.tx = gesture.dx;
                        metrics.ty = gesture.dy;
                        translate.x.setValue(gesture.dx);
                        translate.y.setValue(gesture.dy);
                        return;
                    }
                    // 1x 单指：仅下滑跟随（向上拖不动，防误关）；轻微阻尼防硬拽
                    if (gesture.dy > 0) {
                        metrics.ty = gesture.dy * 0.9;
                        translate.y.setValue(metrics.ty);
                    }
                    lastMove.current = { y: gesture.dy, t: Date.now() };
                },
                onPanResponderRelease: (_evt, gesture) => {
                    const wasPinch = pinch.active;
                    pinch.active = false;
                    if (wasPinch) {
                        // 捏合结束：低于 1x 弹回 1x；缩放态保持（供继续拖看细节）
                        if (metrics.scale <= MIN_SCALE + 0.01) {
                            metrics.scale = 1;
                            Animated.spring(scaleAnim, { toValue: 1, friction: 8, useNativeDriver: true }).start();
                        }
                        return;
                    }
                    const dt = Math.max(Date.now() - lastMove.current.t, 1);
                    const velocity = (gesture.dy - lastMove.current.y) / dt; // px/ms
                    if (metrics.scale === 1) {
                        // 下滑关闭：距离或速度任一达标（flick 也算，防距离党挫败）
                        if (metrics.ty >= DISMISS_DISTANCE || velocity > 0.55) {
                            onClose();
                            return;
                        }
                        // 未达阈值回弹
                        metrics.tx = 0;
                        metrics.ty = 0;
                        Animated.parallel([
                            Animated.spring(translate.x, { toValue: 0, friction: 8, useNativeDriver: true }),
                            Animated.spring(translate.y, { toValue: 0, friction: 8, useNativeDriver: true }),
                        ]).start();
                        return;
                    }
                    // 缩放态松手：位移收束回中心附近（简化口径：直接回 0）
                    metrics.tx = 0;
                    metrics.ty = 0;
                    Animated.parallel([
                        Animated.spring(translate.x, { toValue: 0, friction: 9, useNativeDriver: true }),
                        Animated.spring(translate.y, { toValue: 0, friction: 9, useNativeDriver: true }),
                    ]).start();
                },
                onPanResponderTerminate: () => {
                    // 手势被系统打断（来电/通知）：全部复位，不留半程状态
                    pinch.active = false;
                    metrics.scale = 1;
                    metrics.tx = 0;
                    metrics.ty = 0;
                    Animated.parallel([
                        Animated.spring(scaleAnim, { toValue: 1, friction: 8, useNativeDriver: true }),
                        Animated.spring(translate.x, { toValue: 0, friction: 8, useNativeDriver: true }),
                        Animated.spring(translate.y, { toValue: 0, friction: 8, useNativeDriver: true }),
                    ]).start();
                },
            }),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [onClose],
    );

    return (
        <FullscreenLayer>
            <View className="bg-black" style={viewerOverlayStyle()}>
                {/* 静态 key 收口说明（P0 审计）：这两层 Animated 壳 style 里的 flex: 1
                    是**结构性必要**的静态布局键，不能像 deck/recorder 一样外移——
                    native-driver Animated 节点无法自定尺寸（width/height/position 都
                    不在白名单），而本壳处在「定尺寸黑底（inset-0）→ 百分比/flex 内容」
                    的填充链中间，flex: 1 是撑满父级的最小静态键；去掉即整链塌 0
                    （图片/加载态全部消失）。NativeAnimatedValidation 只校验动画键
                    （AnimatedStyle.__getNativeConfig 只遍历 nodeKeys），静态键不入
                    校验集——DEV.md #14 的 ERROR 是「width 作为动画插值键」，非静态
                    flex。除 flex 外壳上无任何其他布局键，已是白名单内的最小形态。 */}
                <Animated.View
                    style={{ flex: 1, opacity: fade }}
                    {...(entered ? panResponder.panHandlers : {})}
                >
                    {status === 'ready' && uri ? (
                        <Animated.View
                            // flex 用内联 style：Animated.View 绕过 nativewind interop 包装，
                            // className（flex-1）在 web 会被 RN-web 丢弃 → flex 塌 0 → 图片黑屏
                            style={{
                                flex: 1,
                                transform: [
                                    { scale: scaleAnim },
                                    { translateX: translate.x },
                                    { translateY: translate.y },
                                ],
                            }}
                        >
                            {/* 普通 Image（非 Animated）：本层 style 只有静态 flex，无任何
                                动画值——Animated 壳在此无意义，降级减少 Animated 节点面；
                                尺寸用内联 flex：className（h-full/w-full）在 web 被 RN-web
                                丢弃 → 尺寸壳塌 0 → 图片黑屏（同 Animated.View 坑） */}
                            <Image
                                source={{ uri }}
                                style={{ flex: 1 }}
                                resizeMode="contain"
                            />
                        </Animated.View>
                    ) : status === 'missing' ? (
                        <View className="flex-1 items-center justify-center px-6">
                            <Text className="text-[14px] text-white/70">图片无法显示</Text>
                        </View>
                    ) : (
                        <View className="flex-1 items-center justify-center">
                            <Text className="text-[12px] text-white/50">加载中…</Text>
                        </View>
                    )}
                </Animated.View>
                {/* 关闭钮在手势层之上：缩放态时点它仍可退出，兜底出口 */}
                {status === 'ready' ? <ViewerCloseButton onClose={onClose} /> : null}
            </View>
        </FullscreenLayer>
    );
}
