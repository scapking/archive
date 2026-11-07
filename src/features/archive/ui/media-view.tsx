import { useEffect, useRef } from 'react';
import { ActivityIndicator, Image, Keyboard, Platform, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { BouncyPressable, LucideImage, LucidePlay, LucideVideo } from '@/core/icons';
import { AudioLinesIcon } from './editor-icons';
import { AudioBlock } from './audio-player';
import { requestViewer } from '../viewer-request';
import { useFileUrlState } from './use-file-url';
import { useVideoNaturalSize } from './use-video-natural-size';
import { usePalette } from './theme';
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
    // 自然比例：picker 落库的宽高优先，缺元数据回退 4:3（v10 自适应画幅）。
    // 约束模型 = maxWidth(420×r) + maxHeight(420) 双上限 + aspectRatio：
    // 竖版 height = 列宽/r 超 420 时，width 被 maxWidth = 420×r 压窄、height
    // 同时被 maxHeight 钳在 420——终盒比例恒等于 r（yoga 实测源码口径：
    // aspectRatio 先由定宽派生高，constrainMaxSizeForMode 再对宽/高**独立**
    // 钳 max，两分支组合的终盒 ratio 数学上恒 = r；web CSS aspect-ratio 以
    // 钳定后的 used width 派生高，同结果）。「maxHeight 钳高但定宽不回缩」
    // 的旧 cover 裁切问题就此消除（旧式 aspectRatio + maxHeight 组合在竖版
    // 上产生 390×420 裁切盒）。
    // alignSelf center：收窄后水平居中；横版 maxWidth ≥ 420×1.33 = 560 >
    // 手机列宽，恒满列宽不受影响。
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
                    alignSelf: 'center',
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
    // source 直传 uri（可能为 null，VideoSource 合法值）：文件未解析/缺失时是空
    // player 而非空串——空串会让 web 的 <video src=""> 触发整页重下载告警（已修坑，勿回潮）
    const player = useVideoPlayer(uri, (p) => {
        p.loop = false;
        p.muted = false;
    });
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
        requestViewer({
            kind: 'video',
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
                style={
                    fixedHeight
                        ? { height }
                        : {
                              // v10 自适应画幅（与 MediaImage 同式，见其注）：
                              // maxWidth/maxHeight 双上限 + aspectRatio，竖版
                              // 收窄居中、终盒比例恒等于媒体比例
                              aspectRatio: ratio,
                              maxWidth: MEDIA_MAX_HEIGHT * ratio,
                              maxHeight: MEDIA_MAX_HEIGHT,
                              alignSelf: 'center',
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
                            整块按压统一进全屏） */}
                        <View className="pointer-events-none absolute inset-0 items-center justify-center">
                            <View className="h-12 w-12 items-center justify-center rounded-full bg-black/40">
                                <LucidePlay size={20} color="#FFFFFF" strokeWidth={2.2} />
                            </View>
                        </View>
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
export function TripCoverVideo({ fileKey, height = 200 }: { fileKey: string; height?: number }) {
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
    return <MediaVideo media={media} height={height} />;
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
