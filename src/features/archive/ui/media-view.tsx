import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Keyboard, Platform, Pressable, Text, View } from 'react-native';
import type { GestureResponderEvent } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { BouncyPressable, LucideImage, LucidePlay, LucideVideo } from '@/core/icons';
import { AudioLinesIcon } from './editor-icons';
import { AudioBlock } from './audio-player';
import { requestViewer } from '../viewer-request';
import { useFileUrlState, type FileUrlState } from './use-file-url';
import { useVideoNaturalSize } from './use-video-natural-size';
import { usePalette, useMediaAlignPref, type MediaAlign } from './theme';
import type { JournalMediaRow } from '../db';

/**
 * 媒体块渲染规格（编辑器画布 / 封面 / 缩略图统一口径）：
 *
 * - 圆角走半径体系：媒体卡片 rounded-card（16）、缩略图 rounded-thumb（8）；
 * - 无描边（#13 收敛）：白底照片自带边界 + raised 占位底 tone 分层，不靠线框；
 * - 占位底一律 bg-ink-raised：加载中不是裸黑块/裸白块，深浅两主题都成立；
 * - 媒体自适应画幅（v10 终版口径，卡即图）：容器比例恒等于媒体自然比例
 *   （picker 落库宽高），**宽度 = min(列宽, MEDIA_MAX_HEIGHT × 比例)、高 =
 *   宽 ÷ 比例**（width ≤ cap×r ⟹ height ≤ cap 恒成立，纯 yoga 式约束无
 *   JS 量测）——横版满列宽；竖版高触上限后宽度收窄并水平居中（alignSelf
 *   center），完整显示零裁切零留边；缺元数据回退 4:3（FALLBACK_IMAGE_RATIO，
 *   手机列下即满列宽，桌面宽列同样受上限公式约束）。渲染仍用 cover：同比例
 *   盒内 cover = 精确满铺的等价实现（亚像素舍入差下 contain 会露 ≤1px 垫边、
 *   cover 只裁 ≤1px）。视频比例随元数据自适应（#7），缺元数据（录像入库不落
 *   宽高）先按 16:9 + contain 渲染防跳变，native 上由 use-video-natural-size
 *   探测轨道尺寸，探测到即切实际比例（web 探测不可行，维持 16:9 + contain
 *   回退）；外部传 height 的封面场景（TripCoverVideo）保持固定高 + cover 原
 *   行为；缩略图（MediaThumb）独立定尺寸——两者均不进自适应模型；
 *
 * 全屏查看：图片/视频块与缩略图点击 → requestViewer()（viewer-request 中立层，
 * 请求 + 导航 /viewer 一步收口）→ root Stack 的 transparentModal 路由屏渲染
 * fullscreen-viewer（禁 RN Modal）。路由屏是 (tabs) 之上的窗口级容器——tabBar
 * 条带盖不住的根因（tab 屏 screens 容器裁剪 + tabBar 后绘）就此消除；组件可能
 * 深埋在 ScrollView/FlatList 里也无需任何锚点测量（旧 useFullscreenAnchor/
 * measureInWindow 负偏移机制已随屏内覆盖层架构一并移除）。打开前统一收键盘
 * （Keyboard.dismiss）：iOS 键盘浮于窗口层之上、路由屏盖不住，Android
 * adjustResize 收起过程窗口几何漂移（#17/#18 同口径）。
 *
 * 块操作入口（#9 平台差异，DEV.md）：传入 onBlockAction 时——
 * - native / web 触屏：长按媒体卡弹出操作卡（Pressable onLongPress）；
 * - web 桌面（pointer: fine 探测）：单击仍即时全屏，**双击**（两次按压
 *   < 320ms）弹操作卡——首次按压挂起全屏 320ms 做双击消歧，超时放行；
 * 不传则行为与旧版一致（点击即全屏，无长按层），缩略图/封面零改动。
 */

/** 媒体高度上限（dp）：**单张媒体**（图/视频）自适应画幅的高度封顶——
    竖版高触上限后宽度收窄居中、完整显示不裁切（公式见文件头 v10 口径）。
    堆叠组的卡高上限独立（editor.tsx DECK_MAX_HEIGHT = 460）：堆叠卡宽 =
    列宽 66%（单张 = 满列宽），同上限下竖版堆卡偏矮，按「堆叠容器不够长」
    反馈单独放宽、语义分轨互不牵连。 */
export const MEDIA_MAX_HEIGHT = 420;

/** 媒体行缺宽高元数据时的图片兜底比例（4:3，卡片相机常用画幅）。editor 的
    deck 组高推导与 MediaImage 同源取用（导入消费）。 */
export const FALLBACK_IMAGE_RATIO = 4 / 3;

/** 视频块缺宽高元数据时的兜底比例（16:9，手机横录常用画幅）；有元数据走
    媒体自适应比例（#7）。 */
const VIDEO_RATIO = 16 / 9;

/** 双击判定窗口（ms，web 桌面端块操作入口）。 */
const DOUBLE_PRESS_WINDOW = 320;

/**
 * 单张媒体卡水平对齐映射（2026-11-11 反馈②「单张和堆叠都改成靠左边不再居中」
 * 的单张落点）：自适应画幅收窄（竖版触高上限后宽度收窄）时卡的内容流位置按
 * useMediaAlignPref 对齐偏好落位——left 靠左贴内容列左缘（默认，与正文同列
 * 线）/ center 居中（v10 原构图，保留为可选档）/ right 靠右。横版满列宽时
 * alignSelf 无可见效果（宽度已撑满列）。inline style 表达（不走 className 条
 * 件三元，css-interop 铁律无涉）；只改内容流位置，卡体样式（圆角/底色/尺寸）
 * 零变化。deck 堆叠的同源消费在 editor.tsx MediaDeckStack（cardLeft 锚点）。
 */
const MEDIA_ALIGN_SELF: Record<MediaAlign, 'flex-start' | 'center' | 'flex-end'> = {
    left: 'flex-start',
    center: 'center',
    right: 'flex-end',
};

/** web 分流标记：视频控制层 web 专属（native 保持 VideoView 原生控件不动）。 */
const WEB = Platform.OS === 'web';

/**
 * web 端 timeUpdate 事件间隔（秒）。expo-video web 的 timeUpdateEventInterval
 * 默认 0（VideoPlayer.web.js `_timeUpdateEventInterval = 0`，interval 永不启动
 * → timeUpdate 永不上抛，与 native 默认 0.5s 不同）——控制层进度条的唯一驱动
 * 源，必须在 player 创建时显式开档。native 不进此分支，保持上游默认。
 */
const WEB_TIME_UPDATE_INTERVAL = 0.5;

/** 秒 → m:ss / h:mm:ss（控制层时间文本；数字定宽由 tabular-nums 承担）。 */
function formatVideoClock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const pad = (value: number) => String(value).padStart(2, '0');
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secondsInMinute = total % 60;
    return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(secondsInMinute)}`
        : `${minutes}:${pad(secondsInMinute)}`;
}

/**
 * web 端视频控制层（MediaVideo 内联卡底部渐变条，native 不渲染）。
 *
 * 取径（读 expo-video web 实现的结论）：web VideoView 渲染 `<video
 * controls={nativeControls ?? true}>`——nativeControls 映射为浏览器原生控件
 * 属性；内联封面态为保住 #2b 手势链（pointerEvents="none" 包装 + 外层卡面
 * Pressability）显式关了它，浏览器控件条也接管不了 RN 的手势协商。故 web 在
 * 内联卡上自绘极简控制：播放/暂停钮 + 自绘进度条 + tabular-nums 时间文本。
 *
 * 进度条不引 slider 依赖：轨道 View onLayout 实测宽度，responder 链
 * （Grant/Move 逐拍换算 locationX → 比率 seek，Release/Terminate 收口），
 * 点击与拖动共用同一条链；seek 落在 MediaVideo 的 handleWebScrub
 * （player.currentTime = 比率 × 时长）。
 *
 * 命中边界：本层渲染在 pointerEvents="none" 的 VideoView 包装之外（兄弟层），
 * 容器自身 onStartShouldSetResponder 认领触摸——落在条内空白（渐变衬/时间
 * 文本）的按压不会漏进外层卡面的全屏手势；播放钮/轨道是更深的候选，各自
 * 正常认领。
 */
function WebVideoControlBar({
    playing,
    time,
    duration,
    scrubRatio,
    onScrub,
    onScrubEnd,
    onTogglePlay,
}: {
    playing: boolean;
    time: number;
    duration: number;
    /** 拖动中的缩放点比率（null = 非拖动态，跟随 player 汇报的位置）。 */
    scrubRatio: number | null;
    onScrub: (ratio: number) => void;
    onScrubEnd: () => void;
    onTogglePlay: () => void;
}) {
    const trackWidth = useRef(0);
    const seekable = duration > 0;
    // 拖动态缩放点优先：拖动 seek 到下一次 timeUpdate 之间有间隙，thumb 不能回跳
    const ratio = scrubRatio ?? (seekable ? Math.min(1, Math.max(0, time / duration)) : 0);
    const seekFromEvent = (event: GestureResponderEvent) => {
        if (!seekable || trackWidth.current <= 0) return;
        onScrub(event.nativeEvent.locationX / trackWidth.current);
    };
    return (
        <View
            // 条内空白认领触摸（见命中边界注）：不吃行为，只阻断外层全屏手势
            onStartShouldSetResponder={() => true}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
        >
            <LinearGradient
                colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.62)']}
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    paddingHorizontal: 12,
                    paddingTop: 24,
                    paddingBottom: 6,
                }}
            >
                <Pressable
                    onPress={onTogglePlay}
                    // 视觉 30px 钮 + 5 双向外扩凑近 44 目标；与轨道间距 gap 10
                    // ≥ 2×hitSlop（相邻命中区不重叠，core/icons BouncyPressable 头注口径）
                    hitSlop={5}
                    accessibilityLabel={playing ? '暂停' : '播放'}
                    style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}
                >
                    {playing ? (
                        // 暂停字形自绘双竖条（core/icons 无 Pause 导出，所有权边界内不新增依赖）
                        <View style={{ flexDirection: 'row', gap: 3 }}>
                            <View style={{ width: 3, height: 14, borderRadius: 1.5, backgroundColor: '#FFFFFF' }} />
                            <View style={{ width: 3, height: 14, borderRadius: 1.5, backgroundColor: '#FFFFFF' }} />
                        </View>
                    ) : (
                        <LucidePlay size={16} color="#FFFFFF" strokeWidth={2.2} />
                    )}
                </Pressable>
                <View
                    onLayout={(event) => {
                        trackWidth.current = event.nativeEvent.layout.width;
                    }}
                    onStartShouldSetResponder={() => seekable}
                    onMoveShouldSetResponder={() => seekable}
                    onResponderGrant={seekFromEvent}
                    onResponderMove={seekFromEvent}
                    onResponderRelease={onScrubEnd}
                    onResponderTerminate={onScrubEnd}
                    style={{ flex: 1, height: 28, justifyContent: 'center' }}
                >
                    <View
                        style={{
                            height: 3,
                            borderRadius: 1.5,
                            backgroundColor: 'rgba(255,255,255,0.32)',
                            overflow: 'hidden',
                        }}
                    >
                        <View
                            style={{
                                width: `${ratio * 100}%`,
                                height: '100%',
                                backgroundColor: '#FFFFFF',
                            }}
                        />
                    </View>
                    <View
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: `${ratio * 100}%`,
                            top: 0,
                            bottom: 0,
                            marginLeft: -5,
                            justifyContent: 'center',
                        }}
                    >
                        <View
                            style={{
                                width: 10,
                                height: 10,
                                borderRadius: 5,
                                backgroundColor: '#FFFFFF',
                            }}
                        />
                    </View>
                </View>
                <Text
                    numberOfLines={1}
                    style={{
                        color: 'rgba(255,255,255,0.85)',
                        fontSize: 11,
                        fontVariant: ['tabular-nums'],
                    }}
                >
                    {formatVideoClock(time)} / {formatVideoClock(duration)}
                </Text>
            </LinearGradient>
        </View>
    );
}

/* ------------------------------------------------------------------ */
/* 视频缩略图（deck 露边层真封面，2026-11-08）                           */
/* ------------------------------------------------------------------ */

/**
 * 视频缩略图 key 推导（媒体 key 追加 `.thumb.jpg` 后缀）。
 * **key 约定镜像**：事实源在 features/archive/store.ts 的 videoThumbKeyFor
 * （ui 层禁 import store——v5 去环纪律，此处不能反查），两侧的
 * `${fileKey}.thumb.jpg` 格式串必须锁步修改（store 侧有对向镜像注释）。
 */
export function videoThumbKeyFor(fileKey: string): string {
    return `${fileKey}.thumb.jpg`;
}

/**
 * 视频缩略图三态（deck 露边层封面消费口）：thumbKey 复用 useFileUrlState 的
 * 会话缓存/revision 复验/三态语义——loading（解析中/尚未生成）、ready（真
 * 封面可渲染）、missing（未生成/生成失败/文件缺失 → 调用方回退占位卡）。
 * 缩略图由 store 侧在视频 attach 成功后生成（ensureVideoThumbnail），存量旧
 * 视频由屏层惰性回填；本 hook 只读不触发生成（生成编排不进 ui 层）。
 */
export function useVideoThumbState(fileKey: string | null): FileUrlState {
    return useFileUrlState(fileKey == null ? null : videoThumbKeyFor(fileKey));
}

/** web 桌面端（精确指针）才启用双击语义；web 触屏与 native 走长按。 */
export function prefersDoubleClickActions(): boolean {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
    const matcher = (window as Window).matchMedia;
    return typeof matcher === 'function' && matcher('(pointer: fine)').matches;
}

/** 加载 / 失败共用的占位容器内衬（居中图标 + 12px 角注文案）。 */
function MediaStatusHint({ icon, label }: { icon: React.ReactNode; label: string }) {
    return (
        <View className="flex-1 items-center justify-center gap-1.5 px-4">
            {icon}
            <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">{label}</Text>
        </View>
    );
}

/**
 * 块操作手势解析（媒体卡 / 首页笔记卡共用）：native/web 触屏 → 长按；web 桌面
 * → 双击消歧。返回接进 BouncyPressable / Pressable 的 onPress / onLongPress
 * 与卸载清理。
 */
export function useBlockActionGestures({
    enabled,
    onBlockAction,
    onSinglePress,
}: {
    enabled: boolean;
    onBlockAction?: () => void;
    /** 单击语义（放行全屏/导航；双击消歧窗口内挂起）。 */
    onSinglePress: () => void;
}) {
    const lastPressAt = useRef(0);
    const singlePressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const doubleClick = enabled && onBlockAction != null && prefersDoubleClickActions();

    useEffect(() => {
        return () => {
            if (singlePressTimer.current != null) clearTimeout(singlePressTimer.current);
        };
    }, []);

    const handlePress = () => {
        if (!doubleClick) {
            onSinglePress();
            return;
        }
        const now = Date.now();
        if (now - lastPressAt.current < DOUBLE_PRESS_WINDOW) {
            // 第二击：取消挂起的全屏，弹操作卡
            lastPressAt.current = 0;
            if (singlePressTimer.current != null) {
                clearTimeout(singlePressTimer.current);
                singlePressTimer.current = null;
            }
            onBlockAction?.();
            return;
        }
        // 首击：挂起全屏，等双击判定窗口收口
        lastPressAt.current = now;
        if (singlePressTimer.current != null) clearTimeout(singlePressTimer.current);
        singlePressTimer.current = setTimeout(() => {
            singlePressTimer.current = null;
            onSinglePress();
        }, DOUBLE_PRESS_WINDOW);
    };

    return {
        onPress: handlePress,
        // 双击语义生效时不再挂长按（避免桌面鼠标按住 500ms 触发第二套入口）
        onLongPress: onBlockAction != null && !doubleClick ? onBlockAction : undefined,
    };
}

/**
 * 图片块渲染：落盘 key → blob/file URI，自然比例 + 高度封顶。
 * 整块可点（BouncyPressable 按压反馈）→ requestViewer 进 /viewer 全屏路由；
 * 无任何常驻角部 chrome（#4：单击整卡即全屏入口，角标冗余且与相邻卡重叠）。
 */
export function MediaImage({
    media,
    onBlockAction,
}: {
    media: JournalMediaRow;
    /** 长按/双击 → 块操作卡（编辑器场景传入；缩略图等场景不传）。 */
    onBlockAction?: () => void;
}) {
    const { status, uri } = useFileUrlState(media.file_key);
    const palette = usePalette();
    // 水平对齐偏好（hook 直读自生效，调用方零改动；默认 left 靠左，见
    // MEDIA_ALIGN_SELF 注）
    const [mediaAlign] = useMediaAlignPref();
    // 自然比例：picker 落库的宽高优先，缺元数据回退 4:3（v10 自适应画幅）。
    // 约束模型 = maxWidth(420×r) + maxHeight(420) 双上限 + aspectRatio：
    // 竖版 height = 列宽/r 超 420 时，width 被 maxWidth = 420×r 压窄、height
    // 同时被 maxHeight 钳在 420——终盒比例恒等于 r（yoga 实测源码口径：
    // aspectRatio 先由定宽派生高，constrainMaxSizeForMode 再对宽/高**独立**
    // 钳 max，两分支组合的终盒 ratio 数学上恒 = r；web CSS aspect-ratio 以
    // 钳定后的 used width 派生高，同结果）。「maxHeight 钳高但定宽不回缩」
    // 的旧 cover 裁切问题就此消除（旧式 aspectRatio + maxHeight 组合在竖版
    // 上产生 390×420 裁切盒）。
    // alignSelf：收窄后的内容流位置按对齐偏好落位（默认靠左）；横版
    // maxWidth ≥ 420×1.33 = 560 > 手机列宽，恒满列宽不受影响。
    const ratio =
        media.width && media.height ? media.width / media.height : FALLBACK_IMAGE_RATIO;
    const ready = status === 'ready' && uri != null;
    const openViewer = () => {
        // 键盘态开全屏：先收键盘（iOS 键盘浮于窗口层、路由屏盖不住；#17/#18 同口径）
        Keyboard.dismiss();
        requestViewer({
            kind: 'image',
            fileKey: media.file_key,
            width: media.width,
            height: media.height,
        });
    };
    const gestures = useBlockActionGestures({
        enabled: ready,
        onBlockAction,
        onSinglePress: openViewer,
    });
    return (
        <BouncyPressable
            onPress={ready ? gestures.onPress : undefined}
            onLongPress={ready ? gestures.onLongPress : undefined}
            scaleTo={0.985}
        >
            <View
                className="w-full overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
                style={{
                    aspectRatio: ratio,
                    maxWidth: MEDIA_MAX_HEIGHT * ratio,
                    maxHeight: MEDIA_MAX_HEIGHT,
                    alignSelf: MEDIA_ALIGN_SELF[mediaAlign],
                }}
            >
                {status === 'ready' && uri ? (
                    <Image source={{ uri }} className="h-full w-full" resizeMode="cover" />
                ) : status === 'missing' ? (
                    <MediaStatusHint
                        icon={<LucideImage size={20} strokeWidth={1.9} color={palette.muted} />}
                        label="图片无法显示"
                    />
                ) : null}
            </View>
        </BouncyPressable>
    );
}

/**
 * 视频块渲染：封面态（paused 首帧 + 中央播放钮）→ 单击进 /viewer 全屏播放
 * （全屏内 VideoView native controls 全开）、长按/双击 → 块操作卡（与图片块
 * 同语义，手势链见 useBlockActionGestures）。内联不再承载交互播放器——
 * 编辑器画布里点视频 = 看视频，不打断书写心流（Day One 同口径）。
 *
 * #2b 手势修复（真机长按失效根因）：expo-video 的 VideoView 原生层吞触摸——
 * Android 端 VideoView.kt onTouchEvent 无条件 return true 消费整段手势流
 * （nativeControls=false 只是把事件手动 re-dispatch 回 JS 的兜底，Pressable
 * 依赖的 responder 协商链仍被饿死）；iOS 端内嵌 AVPlayerViewController 的
 * 视图自带手势层，controls 关闭也不放行。修复 = 封面态给 VideoView 包一层
 * core RN View（pointerEvents="none"）：core 语义三端铁定跳过该子树，触摸
 * 落回外层卡面 → 与图片块完全同一条 Pressability 链（单击全屏/长按操作卡）。
 * 备选方案（封面改 ImagePoster、VideoView 仅全屏挂载）被否：schema 无缩略图
 * 列，逐卡生成首帧图（VideoThumbnail）要在列表虚拟化里背异步 IO + 缓存生命
 * 周期，且丢掉 paused 首帧这一既有视觉语言。全屏查看器的 VideoView 不包
 * none（native controls 需要接收触摸）。
 *
 * web 控制层（2026-11-19，仅 web 分支，native 行为零变化）：expo-video web 的
 * VideoView nativeControls 映射为 HTML5 `<video controls>` 属性（见
 * WebVideoControlBar 注），内联封面态为保 #2b 手势链显式关闭——web 端内联卡
 * 底部追加自绘控制层（播放/暂停 + 进度条 + 时间文本），支持不进全屏直接内联
 * 播放；全屏链路照旧（点击卡面仍进 /viewer，内联播放中先暂停防双层同响）。
 * 进度驱动 = timeUpdate 监听 + web 端显式开档 timeUpdateEventInterval（web
 * 默认 0 永不上抛）；钮态以 playingChange 事件流为准（web player.playing 在
 * replaceAsync 换源时被无条件置 true，是脏值）。
 */
export function MediaVideo({
    media,
    height,
    onBlockAction,
}: {
    media: JournalMediaRow;
    height?: number;
    /** 长按/双击 → 块操作卡（编辑器场景传入；封面场景不传）。 */
    onBlockAction?: () => void;
}) {
    const { status, uri } = useFileUrlState(media.file_key);
    const palette = usePalette();
    // 水平对齐偏好（与 MediaImage 同源；仅自适应画幅分支消费——外部传 height
    // 的封面场景保持满宽 cover 原行为，见 TripCoverVideo）
    const [mediaAlign] = useMediaAlignPref();
    // source 直传 uri（可能为 null，VideoSource 合法值）：文件未解析/缺失时是空
    // player 而非空串——空串会让 web 的 <video src=""> 触发整页重下载告警（已修坑，勿回潮）
    const player = useVideoPlayer(uri, (p) => {
        p.loop = false;
        p.muted = false;
        // web 端 timeUpdate 默认间隔 0（永不上抛，见 WEB_TIME_UPDATE_INTERVAL 注）
        // ——控制层进度条的唯一驱动源，显式开档；native 保持上游默认 0.5s 不动
        if (WEB) p.timeUpdateEventInterval = WEB_TIME_UPDATE_INTERVAL;
    });
    // ---- web 控制层状态（native 不进以下 effect/渲染分支，行为零变化）----
    // 钮态以 playingChange 事件为准而非 player.playing：web 端 replaceAsync 换源
    // 时无条件置 player.playing = true（VideoPlayer.web.js replace()，play() 被
    // 自动播放策略拒绝也照置）——player.playing 在 web 是脏值，事件流才是真态
    const [playing, setPlaying] = useState(false);
    const [progress, setProgress] = useState({ time: 0, duration: 0 });
    const [scrubRatio, setScrubRatio] = useState<number | null>(null);
    // 拖动态标记（timeUpdate 监听读 ref 免重挂订阅；state 只服务渲染）
    const scrubbingRef = useRef(false);
    useEffect(() => {
        if (!WEB) return;
        const subscriptions = [
            player.addListener('playingChange', (event) => setPlaying(event.isPlaying)),
            // 播放自然收尾（ended）兜底：个别浏览器 ended 前不发 pause，钮态别卡「播放中」
            player.addListener('playToEnd', () => setPlaying(false)),
            // web 端换源时 expo 的 replace() 无条件 video.play()（VideoPlayer.web.js
            // replace）：无手势上下文被自动播放策略拒绝、有历史交互时静默成功出声
            // ——后者破坏「封面态 = paused 首帧」的 native 对齐语义（画布里视频
            // 突然出声）。sourceChange（onloadstart）时显式 pause，内联播放只由
            // 控制层按钮发起
            player.addListener('sourceChange', () => player.pause()),
            player.addListener('statusChange', (event) => {
                // 元数据就绪即取时长（未按播放也先显示总时长）；NaN/0 守卫
                if (event.status !== 'readyToPlay') return;
                const duration = player.duration;
                if (Number.isFinite(duration) && duration > 0) {
                    setProgress((prev) => (prev.duration === duration ? prev : { ...prev, duration }));
                }
            }),
            player.addListener('timeUpdate', (event) => {
                // 拖动态不覆盖缩放点（thumb 位置由 scrubRatio 表达）
                if (scrubbingRef.current) return;
                const duration = player.duration;
                const nextDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
                setProgress((prev) =>
                    prev.time === event.currentTime && prev.duration === nextDuration
                        ? prev
                        : { time: event.currentTime, duration: nextDuration },
                );
            }),
        ];
        return () => {
            for (const subscription of subscriptions) subscription.remove();
        };
    }, [player]);
    // 卡片比例随媒体元数据自适应（#7，v10 与 MediaImage 同一自适应画幅）：
    // maxWidth 先钳宽 + aspectRatio 派生高（公式见 MediaImage 注）——横版满
    // 列宽零信箱条；竖版高触 420 上限后宽度收窄居中，cover 在同比例盒内 =
    // 精确满铺不裁切（中央构图完整呈现）。缺元数据（录像入库不落宽高、行程
    // 封面占位行）两段式：探测期间维持 16:9 + contain 现比例渲染（防跳变）；
    // native 上探测到 player 轨道尺寸（use-video-natural-size，纯 JS player
    // 不渲染画面）后切实际比例——竖版视频容器随画幅收窄，不再左右信箱空白；
    // web 无轨道数据（探测 hook 内部禁用）恒走 16:9 + contain 回退。
    // 封面等外部传 height 的场景：固定高度 + cover（原行为，不进自适应模型）。
    const mediaWidth = media.width;
    const mediaHeight = media.height;
    const hasDimensions =
        mediaWidth != null && mediaHeight != null && mediaWidth > 0 && mediaHeight > 0;
    const fixedHeight = height != null;
    const ready = status === 'ready' && uri != null;
    // 探测关断条件（hook 参数传 null = 零开销）：有元数据（相册选入）行为
    // 不变无需探测；外部传 height 的封面/预览场景比例不参与容器布局；
    // 文件未解析（!ready）时无 URI 可探。
    const naturalSize = useVideoNaturalSize(
        ready && !hasDimensions && !fixedHeight ? uri : null,
    );
    const probeRatio =
        naturalSize != null &&
        naturalSize.width > 0 &&
        naturalSize.height > 0
            ? naturalSize.width / naturalSize.height
            : null;
    const ratio = hasDimensions ? mediaWidth / mediaHeight : probeRatio ?? VIDEO_RATIO;
    const openViewer = () => {
        // 键盘态开全屏：先收键盘（同 MediaImage，#17/#18 修复项）
        Keyboard.dismiss();
        // web 内联播放进行中先暂停内联 player：全屏 viewer 自建独立 player 从头
        // 播（portal 覆盖层不卸载本卡），不停内联会双层同响
        if (WEB) player.pause();
        requestViewer({
            kind: 'video',
            fileKey: media.file_key,
            width: media.width,
            height: media.height,
        });
    };
    // 控制层播放/暂停：以事件流真态取反（web player.playing 是脏值，见上注）。
    // play() 在 SDK 58 声明为 void（web 内部 video.play() 的 promise 由 expo 自管，
    // 被自动播放策略拒绝时表现为视频保持暂停，钮态由 playingChange 事件纠正）
    const toggleWebPlayback = () => {
        if (playing) {
            player.pause();
        } else {
            player.play();
        }
    };
    // 进度条点击/拖动 seek：逐拍换算比率 → player.currentTime（与原生控件
    // seek 同通道），拖动点同步进 scrubRatio 供 thumb 跟手
    const handleWebScrub = (ratio: number) => {
        if (progress.duration <= 0) return;
        const clamped = Math.min(Math.max(ratio, 0), 1);
        scrubbingRef.current = true;
        setScrubRatio(clamped);
        player.currentTime = clamped * progress.duration;
    };
    const handleWebScrubEnd = () => {
        scrubbingRef.current = false;
        setScrubRatio(null);
    };
    const gestures = useBlockActionGestures({
        enabled: ready,
        onBlockAction,
        onSinglePress: openViewer,
    });
    return (
        <BouncyPressable
            onPress={ready ? gestures.onPress : undefined}
            onLongPress={ready ? gestures.onLongPress : undefined}
            scaleTo={0.985}
        >
            <View
                className="w-full overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
                style={
                    fixedHeight
                        ? { height }
                        : {
                              // v10 自适应画幅（与 MediaImage 同式，见其注）：
                              // maxWidth/maxHeight 双上限 + aspectRatio，竖版
                              // 收窄后内容流位置按对齐偏好落位（默认靠左）、
                              // 终盒比例恒等于媒体比例
                              aspectRatio: ratio,
                              maxWidth: MEDIA_MAX_HEIGHT * ratio,
                              maxHeight: MEDIA_MAX_HEIGHT,
                              alignSelf: MEDIA_ALIGN_SELF[mediaAlign],
                          }
                }
            >
                {status === 'ready' && uri ? (
                    <>
                        {/* 封面帧：paused 首帧；nativeControls=false。触摸层 = core RN
                            View 包装（pointerEvents="none"，#2b 见组件注）：core View 的
                            none 语义三端铁定（iOS hitTest 跳过、Android onInterceptTouchEvent
                            拦截子树 + 根端 findTargetForTouch 跳过、web pointer-events:none），
                            不赌 expo 生成视图对 ViewProps.pointerEvents 的 Fabric 落地——
                            触摸纯走外层 BouncyPressable，与图片块同一条 Pressability 链 */}
                        <View className="flex-1" pointerEvents="none">
                            <VideoView
                                player={player}
                                nativeControls={false}
                                contentFit={
                                    fixedHeight || hasDimensions || probeRatio != null
                                        ? 'cover'
                                        : 'contain'
                                }
                                style={{ flex: 1, backgroundColor: palette.raised }}
                                allowsPictureInPicture={false}
                            />
                        </View>
                        {/* 中央播放钮口径：黑透圆底 + 白播放三角（不参与命中，
                            整块按压统一进全屏）。web 内联播放进行中隐藏——控制层
                            已表意，播放中仍盖三角是误导；native 恒显（原行为不动） */}
                        {!(WEB && playing) && (
                            <View className="pointer-events-none absolute inset-0 items-center justify-center">
                                <View className="h-12 w-12 items-center justify-center rounded-full bg-black/40">
                                    <LucidePlay size={20} color="#FFFFFF" strokeWidth={2.2} />
                                </View>
                            </View>
                        )}
                        {/* web 专属控制层（native 保持原生控件）：底部渐变条 =
                            播放/暂停钮 + 自绘进度条 + tabular-nums 时间文本，
                            命中边界见 WebVideoControlBar 注 */}
                        {WEB ? (
                            <WebVideoControlBar
                                playing={playing}
                                time={progress.time}
                                duration={progress.duration}
                                scrubRatio={scrubRatio}
                                onScrub={handleWebScrub}
                                onScrubEnd={handleWebScrubEnd}
                                onTogglePlay={toggleWebPlayback}
                            />
                        ) : null}
                    </>
                ) : status === 'missing' ? (
                    <MediaStatusHint
                        icon={<LucideVideo size={20} strokeWidth={1.9} color={palette.muted} />}
                        label="视频无法播放"
                    />
                ) : (
                    // 解析中：raised 底 + spinner，非裸黑块
                    <View className="flex-1 items-center justify-center">
                        <ActivityIndicator color={palette.spinner} />
                    </View>
                )}
            </View>
        </BouncyPressable>
    );
}

/**
 * 媒体块统一入口（编辑器画布用：无 height → 图片自然比例 / 视频元数据比例 /
 * 音频卡片）。
 * durationMs 仅音频块消费（块级时长元数据，落库时随块 JSON 写入）。
 * onBlockAction：块操作入口（长按/双击语义见文件头注），透传各媒体组件。
 */
export function MediaBlock({
    media,
    durationMs,
    onBlockAction,
}: {
    media: JournalMediaRow;
    durationMs?: number;
    onBlockAction?: () => void;
}) {
    if (media.kind === 'video') return <MediaVideo media={media} onBlockAction={onBlockAction} />;
    if (media.kind === 'audio')
        return <AudioBlock media={media} durationMs={durationMs} onBlockAction={onBlockAction} />;
    return <MediaImage media={media} onBlockAction={onBlockAction} />;
}

/**
 * 行程封面视频（详情页顶部 / 表单预览共用）：内部构造预览媒体行，
 * 真实行以 DB 为准——两处屏文件不再各写一份 previewVideoRow。
 * 点击 → 全屏查看（与本轮媒体块口径一致，宿主屏零改动）。
 */
export function TripCoverVideo({
    fileKey,
    height = 200,
    onCoverAction,
}: {
    fileKey: string;
    height?: number;
    /** 长按封面 → 封面管理动作（行程详情「更换/移除封面视频」入口，2026-11-19）；
     *  不传 = 长按无动作（表单预览场景）。 */
    onCoverAction?: () => void;
}) {
    const media: JournalMediaRow = {
        id: 'trip-cover',
        journal_id: 'trip-cover',
        file_key: fileKey,
        kind: 'video',
        width: null,
        height: null,
        created_at: 0,
        deleted_at: null,
    };
    return <MediaVideo media={media} height={height} onBlockAction={onCoverAction} />;
}

/**
 * 缩略图（卡片内小图）：rounded-thumb（8，半径体系缩略图档）。
 * 图片 = 实图；视频 = 播放钮口径占位（不建 player，缩略图不背播放器开销）。
 * 点击 → requestViewer 进 /viewer 全屏路由（trip-detail 日记行等共用，组件内部消化）。
 */
export function MediaThumb({ media, size = 64 }: { media: JournalMediaRow; size?: number }) {
    const { status, uri } = useFileUrlState(media.file_key);
    const palette = usePalette();
    const ready = status === 'ready' && uri != null;
    const openViewer = () => {
        // 音频无全屏态（占位标识，不响应）；图片/视频进路由查看器
        if (media.kind !== 'image' && media.kind !== 'video') return;
        Keyboard.dismiss();
        requestViewer({
            kind: media.kind,
            fileKey: media.file_key,
            width: media.width,
            height: media.height,
        });
    };
    return (
        <BouncyPressable onPress={ready ? openViewer : undefined} scaleTo={0.94}>
            <View
                className="overflow-hidden rounded-thumb bg-ink-raised dark:bg-inkd-raised"
                style={{ width: size, height: size }}
            >
                {uri && media.kind === 'image' ? (
                    <Image source={{ uri }} className="h-full w-full" resizeMode="cover" />
                ) : media.kind === 'video' ? (
                    // 视频缩略图：播放钮口径（不是空白方块，点击进全屏即看）
                    <View className="h-full w-full items-center justify-center">
                        {ready ? (
                            <View className="h-6 w-6 items-center justify-center rounded-full bg-black/40">
                                <LucidePlay size={11} color="#FFFFFF" strokeWidth={2.4} />
                            </View>
                        ) : status === 'missing' ? (
                            <LucideVideo size={16} strokeWidth={1.9} color={palette.muted} />
                        ) : null}
                    </View>
                ) : media.kind === 'audio' ? (
                    // 音频缩略图：声纹图标占位（音频无全屏态，仅占位标识）
                    <View className="h-full w-full items-center justify-center">
                        <AudioLinesIcon size={16} strokeWidth={1.9} color={palette.secondary} />
                    </View>
                ) : null}
            </View>
        </BouncyPressable>
    );
}
