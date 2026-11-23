import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, forwardRef } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    Animated,
    Dimensions,
    Easing,
    Image,
    Keyboard,
    PanResponder,
    Platform,
    Pressable,
    Text,
    TextInput,
    View,
    type ScrollViewInstance,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Circle, Svg } from 'react-native-svg';
import {
    BouncyPressable,
    LucideCheck,
    LucideImage,
    LucidePlay,
    LucidePlus,
    LucideVideo,
} from '@/core/icons';
import { AudioLinesIcon, MoreIcon } from './editor-icons';
import { AudioBlock } from './audio-player';
import {
    FIELD_TONE_TEXT,
    INPUT_PLATFORM_PROPS,
    INPUT_TRANSPARENT_STYLE,
    fieldInputHeight,
    readContentHeight,
} from './field-input';
import {
    MediaBlock,
    useBlockActionGestures,
    useVideoThumbState,
} from './media-view';
import { usePalette, useMediaAlignPref } from './theme';
import { useDataRevision } from '../data-revision';
import { useFileUrlState, prewarmFileUrl } from './use-file-url';
// 全屏查看请求汇点（中立层，谁引都不成环，见其文件头）
import { requestViewer } from '../viewer-request';
import type { JournalBlock, JournalMediaRow } from '../db';
// 占位 id 事实源在 db/schema.ts：值导入供本模块 isPending 使用，再导出维持
// ui 域内引用路径不变（禁止 ui 层自定义字面量，v5 收口契约）
import { PENDING_MEDIA_ID } from '../db';

/**
 * 共享连续编辑器（行程日记 / 日常日记通用）——大厂编辑器规格：
 *
 * - 画布无盒子：正文直接落在页面底上（15px/26 行高，字号阶「15 正文」的
 *   journaling 口径），媒体块与正文同列宽、左右边缘严格对齐（无横向出血）；
 * - 画布纵向节奏（叠加根栈 gap 后的净间距，全部 2dp 网格，数值收口在
 *   EDITOR_RHYTHM 常量表——#2/#11「间距体系混乱」的单点事实源）：
 *   段 ↔ 段 = 4dp（续写紧凑）；文本段 ↔ 媒体块 = 16dp；
 *   媒体块 ↔ 媒体块 = 16dp（多图节奏与图文一致）；报头 → 首段 = 24dp
 *   （报头 pb-2 8dp + 画布 pt 16dp 叠加，由屏层消费）；照片堆前后净空同
 *   表值 16dp——堆底计数行收口尾部、行内零空气，堆后不再多出 8~16dp
 *   视觉空隙（节奏调优修复面，几何核算见 DECK_COUNTER_LINE 注）；
 * - 块模型自上而下：文本段（自动增高、可聚焦续写）与行内媒体（图/视频/音频）混排，
 *   媒体插入即显示 pending 占位（上传中不阻塞继续写字）；
 * - 连续同 kind 媒体堆叠（渲染层合并，数据仍是独立块）：连续相邻的**同 kind**
 *   就绪媒体块 ≥2 合并为媒体堆（MediaDeckStack v11，Apple Photos Stacks 式印刷
 *   相纸隐喻）——连续图片 ≥2 = 图片堆，连续视频 ≥2 = 视频堆（新增）；图片视频
 *   混排按 kind 分段（视频打断图片串、图片打断视频串，各自成段成组）；音频不进
 *   自然成组。**自定义合并堆叠（显式 groupId 组）**：媒体块可携带 groupId
 *   （schema.ts 纯 JSON 字段），连续同 groupId 成员（混合 kind 允许，含音频）
 *   渲染为同一堆叠单元，成员由「合并堆叠」多选操作物理重排成连续段（见
 *   journal-logic.mergeStackBlocks）；三槽卡体按成员 kind 分支（图/视频既有
 *   Deck 卡复用口径、音频 = AudioBlock/声纹占位变体），点前卡按 kind 全屏。
 *   中卡 = **固定画幅**（v11 用户裁决「直接固定长度宽度以及最低宽度长度，
 *   固定长度」）：宽 = clamp(列宽 × 66%, 240dp 下限, 列宽 − 2×花瓣外露余量)，高
 *   = DECK_CARD_HEIGHT 420 固定常量（最小高下限概念并入固定值，前卡自然比例
 *   派生整轨撤销），三槽同固定 frame；媒体一律 cover 铺满（精确填满固定盒，
 *   裁切部分放弃——「固定尺寸 + 占满」优先于完整显示）；换张 = 纯索引轮转 +
 *   既有转场动画，组高/三槽 frame 恒定零 reflow（丝滑的根本），单张不成组走
 *   media-view 同源自然比例自适应；上一张/下一张以
 *   「相纸」压在卡底：同 frame 微缩 0.96 + 下移 26 + ±4° 镜像倾斜 + 压暗
 *   0.85，底缘露出倾斜楔形（楔形的斜边 + 圆角 + 真实邻图内容是「另一张
 *   照片」的形状语法——轴向平行直条会被读作边框/chrome，v2/v3/v5 三版
 *   可读性翻车的同源根因；4dp raised 垫边 + 前卡 1px hairline 相框描边
 *   （照片 mat 装裱惯例）保证白底/同色照片在浅色页上的楔缘可辨，表面
 *   分层全靠 tone step，无阴影无渐变；露边层圆角挂卡体本体 rounded-card16
 *   （inline 同值双保险 + 内层媒体同值自挂——Android 旋转位形下不依赖父
 *   裁切，见 DECK_CARD_RADIUS / DeckBackCard 注），随缩放/位移/倾斜保持，
 *   不被容器裁成直角）；
 *   3 张起左右都有，2 张时只有右侧（左相纸空缺）；视频堆卡体差异（堆叠
 *   机制与图片堆完全同一套，见 MediaDeckStack 注）：前卡 = 封面态（paused
 *   首帧 + 中央播放钮，点前卡 = 全屏播放、长按 = 操作卡），**性能红线：
 *   底层露边层绝不挂载视频播放器**——露边层 = 缩略图 Image（2026-11-08：
 *   store.ensureVideoThumbnail 生成的首帧 JPEG，`fileKey.thumb.jpg`；未生成
 *   /失败回退 raised 底 + 中央播放 icon 占位卡），只有前卡挂 player；
 *   中卡横滑换位（PanResponder 方向锁：|dx|>10
 *   且 |dx|>1.5|dy| 才认领——画布纵滚零仲裁；|dx|>60 提交真转场、否则
 *   spring 回弹；左滑 = 下一张 / 右滑 = 上一张，循环），点底缘楔形带
 *   左/右半 = 上一张/下一张（N=2 单区全带宽 = 下一张），点中卡 → 全屏
 *   预览，长按中卡 → 该块操作卡（既有 onBlockAction 链）；拖拽过方向锁
 *   后 responder 仲裁自然取消点按（拖拽期间不误开全屏）。换位 = 相纸真
 *   转场（中卡沿换位方向滑出列缘 + 降透明 timing 220ms ease-out quint，
 *   dir 侧相纸自位形 spring 归中 ~310ms 无过冲——相纸恒在中卡之下，随
 *   出卡让位逐步「揭开」，330ms 统一收口 + 索引轮转三槽内容重指派；滑动
 *   与点楔形两条提交链路共用同一条编排，转场期间 advancing 闩吞并发手势；
 *   系统「减弱动态」开启时退化为 160ms 透明度交叉；transform/opacity，
 *   native driver；详见 MediaDeckStack 注）。分组纯派生（buildRenderUnits），
 *   组内增删/移动自动重算，剩 1 块自动解散回独立渲染（零改动）；
 *   pending 占位（图/视频）不进堆叠；性能口径 = 图片堆任意 N 最多挂载
 *   3 个图片实例（左/中/右三槽，N=2 时左槽不渲染恒 2 个；转场不增实例
 *   ——相纸复用本槽渲染位，内容零切换）；视频堆每堆仅前卡挂 1 个 player
 *   实例（露边层零 player、收口换内容按 media.id 重挂），其余留在 blocks
 *   数据里，换位只是索引轮转（数量无上限）；
 * - 块稳定 id（JournalBlock.id）：React key = id，重排/删除不闪烁；文本块移动
 *   不换实例，焦点与光标位置天然保持；
 * - 块操作（#1/#9 沉浸化）：角落 chip 与聚焦操作条**全部移除**——
 *   · 媒体/音频块：长按（native / web 触屏）或双击（web 桌面，pointer: fine
 *     探测）弹操作卡（上移/下移/删除），由屏层渲染 BlockActionCard；
 *   · 文本块：长按/双击都会与系统文本选择冲突（选词是基础体验，不牺牲），
 *     入口 = **聚焦时块内右上角的微型「⋯」钮**（#4：默认零渲染，聚焦挂载
 *     150ms 淡入，失焦即卸载；位置完全在块边界内，与相邻媒体块角部零重叠），
 *     点它弹同一张操作卡。理由：文本块手势区让给系统选择，操作入口收敛到
 *     一个常驻视觉成本为零的聚焦态浮钮；
 * - 输入口径：TextInput 的平台 props（下划线透明/纵向对齐）、透明化底样式
 *   （paddingVertical 0）、字号行高档位统一从 ui/field-input.tsx 收口取用
 *   （无边框规范：border 零，画布场景底色同页底）；
 * - 失焦即存回调（GitLab 规范：防抖 + blur 双通道）；
 * - 纯受控组件：blocks/media 由屏持有，媒体选取由屏编排（store 落盘后回填）。
 */

/** 插入中占位 id（屏层上传完成回填真实 mediaId）：事实源在 db/schema.ts，
 *  此处 re-export 维持 ui 域内引用路径不变（禁止 ui 层再自定义字面量）。 */
export { PENDING_MEDIA_ID };

/** 正文行高（15px 字号配 26px 行高，≈1.73 journaling 可读口径）——
 *  数值事实源收口在 field-input 的 tone 字表（FIELD_TONE_TEXT.canvas），此处派生。 */
const BODY_LINE_HEIGHT = FIELD_TONE_TEXT.canvas.lineHeight;

/* ------------------------------------------------------------------ */
/* 编辑画布垂直节奏常量表（一处收口——#2/#11「间距体系混乱」修复面）      */
/* ------------------------------------------------------------------ */

/**
 * 画布纵向节奏唯一事实源：所有纵向间距只允许从本表派生，消费点禁止散写
 * magic number。全部 2dp 网格；「净间距」= 相邻块边缘之间的可视空隙（栈 gap
 * 与块 margin 的叠加核算已在派生常量中完成）。
 */
export const EDITOR_RHYTHM = {
    /** 段↔段：BlockEditor 根栈 gap（文本块自身零 margin）。 */
    blockToBlock: 4,
    /** 文本↔媒体：媒体块 margin + 栈 gap 叠加后的净间距。 */
    textToMedia: 16,
    /** 媒体↔媒体：多图节奏与图文一致。 */
    mediaToMedia: 16,
    /** 报头→首段：报头 pb-2(8dp) + 画布 paddingTop(16dp) 叠加（消费点在
     *  journal-edit-screen 的报头容器与画布空白收键层 paddingTop——原
     *  contentContainerStyle 的画布顶距已下沉到收键层，见其注）。 */
    mastheadToFirstBlock: 24,
} as const;

/** 写过内容段的固定留白底高（收缩时「少缩一些、留固定空间」，用户口径）：
 *  一行 26dp 视觉局促，取两行 52dp 作固定底——内容超过后仍随内容自然生长
 *  （高度派生走 field-input 的 fieldInputHeight 单点实现），删空回两行底
 *  不回弹 72dp 大盒（避免编辑中高度抖动）。 */
const MIN_PARAGRAPH_HEIGHT = BODY_LINE_HEIGHT * 2;

/** 从未写过的空段最小高度（#2「追加输入框特别小和丑」修复）：空段的
 *  「落笔大盒」不再按「是否整篇唯一段」分档——凡是没写过字的空段（空计划
 *  首段 / + 添加输入框段）一律同一 72dp 落笔体量 + 同一套字号/占位/间距，
 *  消灭「第一个输入框正常、追加输入框特别小」的形态分裂。写过即降到两行
 *  固定底（written 锁存，内容多则自然生长、删空不回弹大盒）。
 *  注：媒体插入已按用户反馈改为「只插媒体块不自动建段」（原「媒体后自动
 *  新建段」档位随之取消），本档位现只服务首段与 + 添加输入框两处。 */
const EMPTY_PARAGRAPH_MIN_HEIGHT = 72;

/** 媒体块 margin（由节奏表派生，叠加根栈 gap 后达到表值）：
 *  邻文本 16 - 4 = 12；邻媒体 (16 - 4) / 2 = 6（上下两块各担一半，RN 不折叠
 *  margin，两块媒体之间的实际空隙 = mb 6 + gap 4 + mt 6 = 16）。 */
const MEDIA_MARGIN_TEXT = EDITOR_RHYTHM.textToMedia - EDITOR_RHYTHM.blockToBlock;
const MEDIA_MARGIN_MEDIA = (EDITOR_RHYTHM.mediaToMedia - EDITOR_RHYTHM.blockToBlock) / 2;

/** 微型操作钮几何（#4 重排）：钮 28px，视觉盒完全落在文本块**内部**右上角
 *  （right-0 top-0）——与上方媒体块角部零重叠（旧版 top: -MICRO_OFFSET 浮出
 *  块外，正压上方媒体块右下角）。hitSlop 仅左/右/下各 6：命中盒 40×34 且
 *  上缘贴齐块顶（top: 0），不越块顶偷上方媒体块的可点边缘；右侧外扩 6 落在
 *  画布留白（px-6 24dp）内，无相邻按压体。命中 34 < 44：聚焦态次级入口的
 *  既有取舍（不遮正文优先），与旧版口径一致。 */
const MICRO_BUTTON = 28;
const MICRO_SLOP = 6;

/* ------------------------------------------------------------------ */
/* 三端键盘适配与聚焦定位（#12b「最佳位置」，一处 helper 收口）           */
/* ------------------------------------------------------------------ */

/**
 * 画布滚动协作契约（#12）：屏层持有 ScrollView，编辑器聚焦段需要键盘补偿时
 * 借用。offsetRef 由屏层 onScroll 落最近滚动位置（写 ref，不触发渲染）。
 */
export type EditorCanvasHandle = {
    readonly ref: React.RefObject<ScrollViewInstance | null>;
    readonly offsetRef: React.RefObject<number>;
};

/** 键盘/底部遮挡区上方的呼吸余量（「最佳位置」定义②，dp，窗口坐标口径）。 */
const FOCUS_CLEARANCE = 24;
/** 可读锚线（「最佳位置」定义③）：可视区顶部下方 1/3——需要滚动入位时段顶
 *  锚到这条线（可读动线优于贴键盘线）；只在「需要滚动」时消费，已入位零滚动。 */
const FOCUS_ANCHOR_RATIO = 1 / 3;
/** 键盘弹起/变化后的量测延时（ms）：Android adjustResize 重排在键盘动画开始
 *  即生效，160ms 足以让重排后的布局落稳，再量测/落位一次到位；iOS 走键盘
 *  事件自带 duration 排程（KeyboardAvoidingView padding 与键盘同长），无事件
 *  时长可用（硬件键盘等）时回落本值。 */
const FOCUS_MEASURE_DELAY = 160;
/** iOS 键盘事件 duration 之后的布局落稳垫片（ms）：KAV padding 与系统 insets
 *  补偿动画的收尾余量，垫在其后量测才能量到终位形。 */
const KEYBOARD_SETTLE_PADDING = 80;
/** adjustResize 重排判定容差（dp）：键盘可见时 |当前窗口高 − 收起态基线| 超过
 *  本值 → 本机型窗口已收缩（量测即真实可视区）；未超 → 问题机型（窗口不随
 *  resize 收缩，既有 #12 注），用键盘高度换算可视区底缘。 */
const KEYBOARD_WINDOW_RESIZE_TOLERANCE = 8;

/** 键盘度量快照（窗口坐标口径；Android 未重排机型兜底换算的依据）。 */
type KeyboardMetrics = {
    visible: boolean;
    /** 键盘高度（最近一次键盘事件 endCoordinates.height，dp）。 */
    height: number;
    /** 键盘收起态的窗口高基线：判定 adjustResize 是否收缩窗口的参照。 */
    baseWindowHeight: number;
    /** 最近一次键盘事件的动画时长（ms；iOS 排程用，Android 恒 0）。 */
    lastEventDurationMs: number;
};

/**
 * 键盘度量与事件分发单例（编辑器域内共享，引用计数订阅）：聚焦定位器激活
 * 期间各挂一个回调，首个订阅者安装 Keyboard 监听、末个卸载者拆除——段落
 * 聚焦切换高频发生，订阅成本由单例摊平；键盘高度变化（#12b 触发②）经此
 * 分发给所有激活中的定位器。web 不安装（浏览器原生 focus scroll-into-view，
 * 维持现状）。
 */
const keyboardChangeListeners = new Set<() => void>();
let keyboardTrackingSubs: Array<{ remove(): void }> | null = null;
let keyboardTrackingRefCount = 0;
let keyboardMetrics: KeyboardMetrics | null = null;
/** 跨会话记忆的键盘高度（激活时键盘已可见的罕见时序下基线回推用）。 */
let lastKnownKeyboardHeight = 0;

const notifyKeyboardChanged = () => {
    for (const listener of keyboardChangeListeners) listener();
};

/** 键盘收起态重采窗口高基线（旋转/分屏后基线漂移的自愈点）。 */
const refreshKeyboardBase = () => {
    if (keyboardMetrics && !keyboardMetrics.visible) {
        keyboardMetrics.baseWindowHeight = Dimensions.get('window').height;
    }
};

const markKeyboardShown = (event: {
    endCoordinates: { height: number; duration?: number };
}) => {
    if (!keyboardMetrics) return;
    keyboardMetrics.visible = true;
    keyboardMetrics.height = event.endCoordinates.height;
    // Android didShow 事件的 endCoordinates 无 duration 字段（did 系只在动画
    // 结束后派发），按 0 处理 → 排程回落固定延时档
    keyboardMetrics.lastEventDurationMs = Math.max(
        0,
        (event.endCoordinates.duration || 0) * 1000,
    );
    lastKnownKeyboardHeight = event.endCoordinates.height;
    notifyKeyboardChanged();
};

const markKeyboardHidden = () => {
    if (!keyboardMetrics) return;
    keyboardMetrics.visible = false;
    keyboardMetrics.lastEventDurationMs = 0;
    refreshKeyboardBase();
    notifyKeyboardChanged();
};

function acquireKeyboardTracking(): void {
    if (Platform.OS === 'web') return;
    keyboardTrackingRefCount += 1;
    if (keyboardTrackingSubs) return;
    // 首个订阅者：基线采样。激活时键盘已可见的罕见时序（后台切回快速重聚焦）
    // 按记忆键盘高回推收起态基线；正常时序（聚焦先于键盘弹出）直接采当前
    // 窗口高。keyboardDidHide 时也会重采（旋转/分屏基线漂移自愈）。
    const windowH = Dimensions.get('window').height;
    const visibleInitially = Keyboard.isVisible?.() ?? false;
    keyboardMetrics = {
        visible: visibleInitially,
        height: lastKnownKeyboardHeight,
        baseWindowHeight: windowH + (visibleInitially ? lastKnownKeyboardHeight : 0),
        lastEventDurationMs: 0,
    };
    const subs: Array<{ remove(): void }> = [];
    if (Platform.OS === 'ios') {
        // iOS 全事件系（will 系先于动画，可拿 duration 排程；WillChangeFrame
        // 覆盖键盘形态变化——quicktype 收展/外接键盘切换的高度变化触发②）
        subs.push(
            Keyboard.addListener('keyboardWillShow', markKeyboardShown),
            Keyboard.addListener('keyboardWillChangeFrame', markKeyboardShown),
            Keyboard.addListener('keyboardWillHide', markKeyboardHidden),
        );
    } else {
        // Android 只有 did 系（重排已完成或进行中，160ms 延时后量测落稳）；
        // 高度变化（候选词栏展开等）会再次 didShow → 自然覆盖触发②
        subs.push(
            Keyboard.addListener('keyboardDidShow', markKeyboardShown),
            Keyboard.addListener('keyboardDidHide', markKeyboardHidden),
        );
    }
    keyboardTrackingSubs = subs;
}

function releaseKeyboardTracking(): void {
    if (keyboardTrackingRefCount > 0) keyboardTrackingRefCount -= 1;
    if (keyboardTrackingRefCount > 0 || !keyboardTrackingSubs) return;
    for (const sub of keyboardTrackingSubs) sub.remove();
    keyboardTrackingSubs = null;
    keyboardMetrics = null; // 归零重采：不跨编辑器实例残留陈旧基线
}

/* ---------------------------------------------------------------- */
/* 键盘状态提升（singleton → React state，屏层「动态垫高」消费口）      */
/* ---------------------------------------------------------------- */

/**
 * 键盘视口快照（KeyboardMetrics 的可渲染投影）：屏层「键盘动态垫高」的判定
 * 输入。visible/height 与 singleton 字段同源；windowResized 是既有 adjustResize
 * 基线判定（isWindowResizedByKeyboard）的即时结论。null = 无键盘度量
 * （web 不安装追踪 / native 追踪未挂起）。
 */
export type KeyboardViewportSnapshot = {
    visible: boolean;
    /** 键盘高度（最近一次键盘事件 endCoordinates.height，dp）。 */
    height: number;
    /** 当前窗口是否已随键盘收缩（adjustResize 生效 → 系统已让出可视区，
     *  动态垫高不得再加——防双重垫高在键盘上方留出一截空带）。 */
    windowResized: boolean;
};

/**
 * 「窗口是否已被 adjustResize 收缩」基线判定的唯一实现：定位器量测口径与
 * 动态垫高判定共用（复用既有基线逻辑，见 KEYBOARD_WINDOW_RESIZE_TOLERANCE 注）。
 * 旋转/分栏时基线漂移的复核语义与既有定位器一致（收起态基线在 didHide 与
 * Dimensions change 时重采自愈，见 useKeyboardViewportSnapshot）。
 */
const isWindowResizedByKeyboard = (): boolean => {
    if (!keyboardMetrics) return false;
    const windowH = Dimensions.get('window').height;
    return (
        Math.abs(windowH - keyboardMetrics.baseWindowHeight) >
        KEYBOARD_WINDOW_RESIZE_TOLERANCE
    );
};

/** 快照读取（渲染期安全：只读 singleton 字段 + 当前窗口度量）。 */
const readKeyboardViewportSnapshot = (): KeyboardViewportSnapshot | null => {
    if (Platform.OS === 'web' || !keyboardMetrics) return null;
    return {
        visible: keyboardMetrics.visible,
        height: keyboardMetrics.height,
        windowResized: isWindowResizedByKeyboard(),
    };
};

/** 快照同值守卫：字段全等即复用旧引用（setState bail-out，重渲最小化）。 */
const isSameKeyboardViewportSnapshot = (
    a: KeyboardViewportSnapshot | null,
    b: KeyboardViewportSnapshot | null,
): boolean =>
    a === b ||
    (a != null &&
        b != null &&
        a.visible === b.visible &&
        a.height === b.height &&
        a.windowResized === b.windowResized);

/**
 * 键盘视口快照订阅（singleton → React state 的桥）。选型理由（重渲最小方案）：
 * 垫高是渲染输出，ref 无法驱动布局；callback/context 最终也要落一次 setState，
 * 渲染扇出不比 hook 小，反而把状态逼到屏根（整屏重渲）。本 hook 把状态收进
 * **叶子消费组件**（journal-edit-screen 的 CanvasDismissLayer，memo + children
 * 直传）——键盘事件只重渲垫高层自身的 style，画布子树经 children 引用相等
 * bail-out 零重渲。
 *
 * 挂载即对键盘追踪引用计数 +1（基线在挂载时采样——比首聚焦采样更早更稳；
 * 定位器 activate/deactivate 在此之上叠加引用，互不干扰）。键盘事件 / 窗口
 * 尺寸变化（旋转、分栏）到达时按字段同值守卫合并进 state：键盘一次弹出/
 * 收起各一帧，quicktype 栏收展一帧，滚动与聚焦切换零重渲。
 *
 * 垫高落地重测钩子：快照变化提交渲染后向单例补发一拍通知——聚焦定位器在
 * 垫高**已落地**的几何上重测落位，防「测量计时器跑赢垫高渲染」的时序竞争
 * 把目标钳在旧 maxScroll 上。无环：通知只触发定位器量测/滚动（不写任何
 * React 状态），本 hook 的监听器经同值守卫 bail（无第二次渲染），通知链
 * 单拍终止；且垫高只依赖键盘快照，不依赖滚动位置/内容高，天然无反馈环。
 */
const useKeyboardViewportSnapshot = (): KeyboardViewportSnapshot | null => {
    const [snapshot, setSnapshot] = useState<KeyboardViewportSnapshot | null>(
        readKeyboardViewportSnapshot,
    );
    useEffect(() => {
        // web 无键盘追踪（acquire 也早退；浏览器原生 focus scroll-into-view）
        if (Platform.OS === 'web') return undefined;
        acquireKeyboardTracking();
        const sync = () => {
            setSnapshot((current) => {
                const next = readKeyboardViewportSnapshot();
                return isSameKeyboardViewportSnapshot(current, next) ? current : next;
            });
        };
        sync(); // 挂载对齐（后台切回时键盘已可见的罕见时序）
        keyboardChangeListeners.add(sync);
        const dimensionsSub = Dimensions.addEventListener('change', () => {
            // 键盘收起态：静默重采基线（旋转/分栏漂移自愈点，不触发渲染）；
            // 打开态：重算快照——windowResized 随新窗口几何复核 → 垫高重算
            //（基线复核语义与既有定位器一致，键盘收起即自愈重采）
            if (keyboardMetrics && !keyboardMetrics.visible) refreshKeyboardBase();
            sync();
        });
        return () => {
            keyboardChangeListeners.delete(sync);
            dimensionsSub.remove();
            releaseKeyboardTracking();
        };
    }, []);
    // 垫高决策变化的落地重测（理由与无环论证见上注；web 快照恒 null 不进）
    useEffect(() => {
        if (snapshot == null) return;
        notifyKeyboardChanged();
    }, [snapshot]);
    return snapshot;
};

/**
 * 画布底部动态垫高（「滚到底后聚焦末段定位失效」修复面）：键盘打开且窗口
 * **未被**系统收缩时（Android adjustResize 不生效的问题机型），静态基线下的
 * 滚动余量 = 内容高 − 容器高，末段聚焦时无法把光标行顶到键盘上方的最佳位置
 * ——键盘打开期间把底部垫高放大到 max(键盘高 + FOCUS_CLEARANCE, 静态基线)，
 * 末段聚焦永远有足够滚动余量；键盘收起立即回静态基线。
 *
 * 生效分支矩阵（防双重垫高——垫高只在该加的分支加）：
 * - Android + 窗口未被 adjustResize 收缩（问题机型）→ **动态垫高生效**；
 * - Android + 窗口已收缩（adjustResize 正常机型，容器已被系统压矮）→ 静态
 *   基线（滚动余量已由 resize 天然补足，再加 = 键盘上方空带）；
 * - iOS → 恒静态基线（KAV padding 模式 + automaticallyAdjustKeyboardInsets
 *   已让出键盘高度，与 adjustResize 收缩同构，语义上恒「已收缩」）；
 * - web → 恒静态基线（无键盘追踪；浏览器原生 focus scroll-into-view）。
 *
 * 取 max 保证垫高 ≥ 静态基线：+ 浮钮让位语义不变（静止态布局与旧版逐 dp
 * 一致——动态分支只在键盘打开时生效，而垫高增量区又被键盘覆盖，视觉零
 * 扰动）。一次性 style 变更不动画：Animated native driver 不支持 padding
 * 这类布局属性，JS 驱动会在键盘动画期间叠帧抖动，得不偿失（垫高区又被
 * 键盘盖住，跳变不可见）。
 */
export const useKeyboardCanvasBottomPadding = (staticBaseline: number): number => {
    const snapshot = useKeyboardViewportSnapshot();
    return useMemo(() => {
        if (
            Platform.OS !== 'android' ||
            !snapshot ||
            !snapshot.visible ||
            snapshot.windowResized
        ) {
            return staticBaseline;
        }
        return Math.max(snapshot.height + FOCUS_CLEARANCE, staticBaseline);
    }, [snapshot, staticBaseline]);
};

/** 聚焦段入位的门档：`partial` = 段越出可视带即修（Android 全量补偿口径）；
 *  `fullyHidden` = 整段完全不可见才修（iOS automaticallyAdjustKeyboardInsets
 *  模式防双写打架——理由见 createFocusedBlockPositioner 注）。 */
export type FocusedBlockGate = 'partial' | 'fullyHidden';

export type FocusedBlockPositioner = {
    /** 聚焦激活：订阅键盘事件 + 立即排程一次落位（幂等，重复激活只补排程）。 */
    activate(): void;
    /** 失焦去激活：撤销在途排程 + 摘除键盘订阅（blur 后零落位扰动）。 */
    deactivate(): void;
    /** 追加一拍落位排程（内容增高/键盘变化复用；未激活时空操作）。 */
    schedule(): void;
    /** 卸载清理（= deactivate）。 */
    dispose(): void;
};

/**
 * 聚焦段「最佳位置」定位器（#12b 三端口径唯一实现）。「最佳」定义：
 * ① 聚焦段完整可见（顶不越可视区顶、底不越键盘上缘）；
 * ② 键盘/底部遮挡区上方留 ≥FOCUS_CLEARANCE 24dp 呼吸；
 * ③ 需要滚动入位时段顶锚到可视区顶下 1/3 线（可读动线，优于贴键盘线）。
 *
 * 触发时机（全部收口到 schedule 的 cancel→重排程，同窗口触发合并为一拍）：
 * ① 聚焦时（activate；含「+ → 添加输入框」切段聚焦的 autoFocus 通道）；
 * ② 键盘高度变化（singleton 分发：Android keyboardDidShow/DidHide、iOS
 *    keyboardWillShow/WillChangeFrame/WillHide——Keyboard.addListener 引用
 *    计数订阅，随激活/去激活进出）；
 * ③ 聚焦段内容增高（TextBlock onContentSizeChange → schedule，激活闸内）；
 * ④ 切段聚焦（同①）。
 *
 * 计算口径（ScrollView 与聚焦段同轮 measureInWindow，同一窗口坐标系）：
 * - 可视区 = [ScrollView 顶缘, min(ScrollView 底缘, 键盘上缘)]；Android 问题
 *   机型（adjustResize 不收缩窗口）用键盘度量换算上缘兜底——窗口高与收起态
 *   基线差超容差视为「已收缩」（量测即真实可视区），否则按 窗口高 − 键盘高
 *   换算（对重排时序鲁棒：160ms 处重排未落地也会被换算分支校正）；
 * - 目标滚动量：段高放得下「锚线→安全线」带 → 段顶锚 1/3 线（三条全满足）；
 *   高段放不下 → 底缘贴安全线优先（光标通常在增长中的段尾，完整可见优先于
 *   1/3 锚）；高段只切顶 → 段顶拉回可视区顶（贴顶是高段下的物理最优）；
 * - 幂等/去重：整段已在可视带内零滚动；目标与当前滚动位置差 <1dp 零滚动
 *   （量测亚像素抖动/同位重复触发不产生第二跳）；
 * - 平滑接管：每拍执行都重新量测（滚动动画中量到的是中间位形），新目标从
 *   当前位置续算——滚动动画被新一轮触发平滑接管，不回跳不叠加。
 *
 * 平台差异（gate 参数，唯一分叉点）：
 * - Android / `partial`：段越出可视带即修。adjustResize 只保证重排、不保证
 *   滚动位，全量补偿是既有 #12 口径的延续（叠加 1/3 锚线升级）；
 * - iOS / `fullyHidden`：automaticallyAdjustKeyboardInsets 是主补偿（与键盘
 *   动画同源同帧、与 keyboardDismissMode="interactive" 兼容），手动 scrollTo
 *   是第二个 offset 写入者，并发写入会「先跳后拉」打架——故只在整段完全
 *   不可见（系统补偿失效/来不及的罕见时序）时补一次，且执行延时 = 键盘事件
 *   duration + 垫片（系统补偿动画收尾后量测：系统已修好则幂等闸短路，
 *   无双写）；iOS 上「1/3 锚线」让位给系统同步动画（收益边际小，代价是
 *   放弃同帧动画，不划算）；
 * - Web：定位器不创建（浏览器对 focus 目标有原生 scroll-into-view，维持现状）。
 */
export function createFocusedBlockPositioner(
    canvas: EditorCanvasHandle,
    inputRef: React.RefObject<React.ComponentRef<typeof TextInput> | null>,
    gate: FocusedBlockGate,
): FocusedBlockPositioner {
    let active = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cancel = () => {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const execute = () => {
        timer = null;
        const scroller = canvas.ref.current;
        const node = inputRef.current;
        if (!scroller || !node) return;
        scroller.measureInWindow((_sx, sy, _sw, sh) => {
            // 0/NaN 防线：量测失败或重排未落地时不动滚动位置
            if (!Number.isFinite(sy) || !Number.isFinite(sh) || sh <= 0) return;
            let visibleTop = sy;
            let visibleBottom = sy + sh;
            // Android 未重排机型兜底（见注计算口径）：窗口高不随 adjustResize
            // 收缩时 ScrollView 底缘仍含键盘区，按键盘度量换算上缘取 min
            //（收缩判定复用 isWindowResizedByKeyboard——与动态垫高同一基线口径）
            if (
                Platform.OS === 'android' &&
                keyboardMetrics?.visible &&
                !isWindowResizedByKeyboard()
            ) {
                visibleBottom = Math.min(
                    visibleBottom,
                    Dimensions.get('window').height - keyboardMetrics.height,
                );
            }
            const safeBottom = visibleBottom - FOCUS_CLEARANCE;
            const anchorY = visibleTop + (visibleBottom - visibleTop) * FOCUS_ANCHOR_RATIO;
            node.measureInWindow((_x, y, _width, height) => {
                if (!Number.isFinite(y) || !Number.isFinite(height) || height <= 0) return;
                const bottomOverflow = y + height - safeBottom;
                const topOverflow = visibleTop - y;
                if (gate === 'fullyHidden') {
                    // iOS insets 模式门：整段完全不可见才补位（防双写打架，见注）
                    if (y + height > visibleTop && y < visibleBottom) return;
                } else if (bottomOverflow <= 0 && topOverflow <= 0) {
                    return; // 幂等：整段已在可视带内零滚动
                }
                // 目标滚动量（见注计算口径）：可读锚优先，高段底缘可见优先
                const anchorDelta = y - anchorY;
                let delta: number;
                if (height <= safeBottom - anchorY) {
                    delta = anchorDelta; // 段顶锚 1/3 线（三条全满足）
                } else if (bottomOverflow > 0) {
                    delta = bottomOverflow; // 高段：底缘贴安全线（含 24dp 呼吸）
                } else {
                    delta = y - visibleTop; // 高段只切顶：顶缘拉回可视区
                }
                const target = Math.max(0, canvas.offsetRef.current + delta);
                // 去重：目标与当前位置一致不重复滚（亚像素抖动/同位重复触发）
                if (Math.abs(target - canvas.offsetRef.current) < 1) return;
                // RN 核心 scrollTo 无 duration 参数（web 专有），native 用平台
                // 默认短滚动动画（iOS ~300ms / Android 固定档），符合短程口径
                scroller.scrollTo({ y: target, animated: true });
            });
        });
    };

    const schedule = () => {
        if (!active) return;
        if (timer != null) clearTimeout(timer); // 新一轮触发平滑接管（同窗口合并）
        // iOS：键盘动画时长 + 垫片后量测（KAV padding 与系统补偿都收尾，量到
        // 终位形）；Android：固定延时（adjustResize 重排即生效口径）
        const kbDuration = keyboardMetrics?.lastEventDurationMs ?? 0;
        const delay =
            Platform.OS === 'android' || kbDuration <= 0
                ? FOCUS_MEASURE_DELAY
                : kbDuration + KEYBOARD_SETTLE_PADDING;
        timer = setTimeout(execute, delay);
    };

    // 键盘事件回调（触发②）：定位器激活期间才排程（闸在 schedule 内）
    const notify = () => schedule();

    const activate = () => {
        if (active) {
            schedule(); // 幂等：重复激活只补一拍
            return;
        }
        active = true;
        acquireKeyboardTracking();
        keyboardChangeListeners.add(notify);
        schedule();
    };

    const deactivate = () => {
        if (!active) return;
        active = false;
        keyboardChangeListeners.delete(notify);
        releaseKeyboardTracking();
        cancel(); // 失焦撤销在途落位（blur 后不再扰动）
    };

    return { activate, deactivate, schedule, dispose: deactivate };
}

/** 占位文案（#3 内聚在统一组件，调用处不再各自传）：空白页引导 vs 续写。
 *  大厂风收敛：名词/动宾短语，不再用「想到什么写什么」类口语引导句。 */
const LEAD_PLACEHOLDER = '开始记录…';
const CONTINUE_PLACEHOLDER = '继续写…';

/**
 * 统一文本块（#3「输入框存在差异，改成统一大小组件」）：全屏所有段落——
 * 空计划落笔区、续写段、+ 添加输入框段——唯一的 TextInput 实现。字号/行高/
 * 内边距/最小高度/占位符/自动增高/三端输入适配全部内聚（平台 props 与高度
 * 派生统一取自 field-input.tsx 的导出常量/helper——单点收口，画布不套容器
 * 盒），差异只允许经 props 显式表达：
 * - firstBlock：只决定占位文案（空计划引导句 vs「继续写…」），不再决定高度；
 * - 高度档位由「是否写过字」驱动（#2 修复）：从未写过的空段（首段/+ 添加
 *   输入框段）一律 72dp 落笔体量，写过降到两行固定底贴合内容（written 锁存，
 *   内容多则自然生长、删空回两行底不回弹大盒）——「第一个输入框正常、追加
 *   输入框特别小」的形态分裂在此收口，空段 rect 高度三端一致可测。
 */
function TextBlock({
    value,
    editable,
    autoFocus = false,
    firstBlock = false,
    canvas,
    onChange,
    onFocus,
    onBlur,
    onInputFocus,
    onInputBlur,
}: {
    value: string;
    editable: boolean;
    /** 「+ 添加输入框」后的自动聚焦（屏层 focusTextId 驱动，变化即聚焦）；
     *  媒体插入已不自动建段，不再经此通道聚焦。 */
    autoFocus?: boolean;
    /** 落笔区位：整篇唯一段（空计划）为 true——只切换占位文案档位。 */
    firstBlock?: boolean;
    /** 画布协作句柄：聚焦时创建「最佳位置」定位器（三端平台判定内聚）。 */
    canvas?: EditorCanvasHandle;
    onChange(text: string): void;
    onFocus?(): void;
    onBlur?(): void;
    /** TextInput 实例焦点上报（聚焦/失焦均传实例）：画布空白收键层的 blur
     *  收口通道，BlockEditor 汇总当前聚焦段引用（屏层经 handle 消费）。 */
    onInputFocus?(input: React.ComponentRef<typeof TextInput> | null): void;
    onInputBlur?(input: React.ComponentRef<typeof TextInput> | null): void;
}) {
    const palette = usePalette();
    const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
    // 写过标记（锁存）：挂载时已有内容（重开旧计划）即为内容段；此后一旦
    // 写过就保持内容段档位——删空回两行固定底，不回弹 72dp 大盒（编辑中抖动源）
    const [written, setWritten] = useState(value.length > 0);
    // 本段最小高度：未写过的空段 = 72dp 落笔体量（只读态不设，阅读页空段
    // 收一行，不摆大盒子）；写过 = 两行固定底（收缩少一些、留固定空间）
    const minHeight =
        editable && !written ? EMPTY_PARAGRAPH_MIN_HEIGHT : MIN_PARAGRAPH_HEIGHT;
    // 自适应高度 = max(minHeight, 内容实高)（field-input 单点派生）：内容高
    // 独立存态、样式处派生——档位切换立即生效，不必等下一次 onContentSizeChange
    const [contentHeight, setContentHeight] = useState<number | null>(null);
    const height = fieldInputHeight(minHeight, contentHeight);
    // web 塌缩修复（#2 终验）：RN-web 的 onContentSizeChange 上报 scrollHeight
    // = max(内容实高, 盒高)——72dp 空盒挂载即把 contentHeight 抬到 72，written
    // 翻转后 max(minHeight, 72) 恒 72，「落笔降为一行」在 web 上失效（native
    // 上报的是纯内容高，无此污染）。翻转瞬间清掉被盒高污染的旧值回落 minHeight，
    // 并于下一帧（样式已按 minHeight 提交）补量一次真实内容高——粘贴多行等写
    // 入场在 72 盒内量不到真实值，缩盒后 scrollHeight 才是内容实高。非 DOM 宿主
    // （native ref 无 scrollHeight）读数 undefined → 回落 null，行为同旧。
    const prevWrittenRef = useRef(written);
    useEffect(() => {
        if (written && !prevWrittenRef.current) {
            setContentHeight(null);
            const raf = requestAnimationFrame(() => {
                const node = inputRef.current as unknown as { scrollHeight?: number } | null;
                const raw = node?.scrollHeight;
                setContentHeight(
                    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : null,
                );
            });
            return () => cancelAnimationFrame(raf);
        }
        prevWrittenRef.current = written;
    }, [written]);
    // 「最佳位置」定位器（#12b，触发①②③④的载体，见
    // createFocusedBlockPositioner 注）：native 每段一个实例；web 不创建
    // （浏览器原生 focus scroll-into-view 维持现状）。iOS 走 fullyHidden 门
    // （系统 insets 主补偿防双写打架），Android 走 partial 门（全量补偿）。
    // 键盘事件订阅在定位器内聚（引用计数 singleton），activate/deactivate
    // 随焦点进出，卸载 dispose 兜底。
    const positioner = useMemo(
        () =>
            canvas && Platform.OS !== 'web'
                ? createFocusedBlockPositioner(
                      canvas,
                      inputRef,
                      Platform.OS === 'ios' ? 'fullyHidden' : 'partial',
                  )
                : null,
        [canvas],
    );
    // 卸载清理：撤销在途落位 + 摘键盘订阅（防延时量测落在已卸载节点上）
    useEffect(() => () => positioner?.dispose(), [positioner]);
    // 聚焦时序（#1.2 修复项）：追加段（「+ 添加输入框」）的布局提交后再
    // focus，避免焦点/键盘与布局 churn 竞态——挂载即聚焦会在 measure 完成
    // 前抢焦点，Android 上键盘位置与光标位错乱。autoFocus 由 false→true
    // 驱动（重排不换实例，同值重渲染不重复触发）。
    // canvas 为屏层 useMemo 固定对象，闭包捕获安全。切段聚焦（触发④）：
    // focus 派发的 onFocus 会激活定位器，这里补一拍兜底（onFocus 未派发的
    // 异常时序也落位；activate 幂等，重复只合并排程）。
    useEffect(() => {
        if (!autoFocus) return;
        const raf = requestAnimationFrame(() => {
            inputRef.current?.focus();
            positioner?.activate();
        });
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- positioner 依赖 canvas（稳定句柄）
    }, [autoFocus]);
    return (
        <TextInput
            ref={inputRef}
            multiline
            value={value}
            editable={editable}
            onChangeText={(text) => {
                // 写过锁存：首字落下即按内容段处理（72 → 两行固定底的唯一跳变
                // 点，之后随行数平滑增高；同值 setState 被 React 合并，无额外渲染）
                setWritten((current) => current || text.length > 0);
                onChange(text);
            }}
            onFocus={() => {
                // 聚焦激活（触发①）：订阅键盘事件 + 立即排程「最佳位置」落位
                positioner?.activate();
                onInputFocus?.(inputRef.current);
                onFocus?.();
            }}
            onBlur={() => {
                // 失焦去激活：撤销在途落位 + 摘键盘订阅（blur 后零落位扰动）
                positioner?.deactivate();
                onInputBlur?.(inputRef.current);
                onBlur?.();
            }}
            onContentSizeChange={(event) => {
                // 自动增高：有效性（0/NaN 拒收）与取整在 readContentHeight 收口；
                // 同值守卫丢弃逐键同值触发，防无谓 re-render / layout 抖动
                const next = readContentHeight(event);
                if (next === null) return;
                setContentHeight((current) =>
                    current !== null && Math.abs(next - current) < 1 ? current : next,
                );
                // 内容增高（触发③，#12b）：聚焦中段落变高（多行回车/粘贴）后
                // 光标行重新入位——定位器激活闸内排程（未聚焦空操作），延时正好
                // 覆盖新高度提交与重排落稳
                positioner?.schedule();
            }}
            placeholder={firstBlock ? LEAD_PLACEHOLDER : CONTINUE_PLACEHOLDER}
            placeholderTextColor={palette.muted}
            // 画布无盒子口径：底色透明 + paddingVertical 0（INPUT_TRANSPARENT_STYLE）
            // + 平台 props（下划线/纵向对齐）从 field-input 单点取；focus 反馈 =
            // 光标 + 占位符消隐，不上底色盒/outline
            style={[
                { height },
                INPUT_TRANSPARENT_STYLE,
                FIELD_TONE_TEXT.canvas,
                { color: palette.text },
            ]}
            {...INPUT_PLATFORM_PROPS}
        />
    );
}

/**
 * 落盘进度环（2026-11-08 进度可视化）：28px 单圈 ring——底圈 muted 25% +
 * 进度弧 accent（strokeDashoffset 随 fraction 收口，rotate -90 从 12 点起走）。
 * svg 矢量三端一致，无 Lottie/无第三方进度库；100ms 节流帧驱动（store
 * mediaUploadProgress 注册表），无逐拍重渲风暴。
 */
function PendingMediaProgressRing({ fraction }: { fraction: number }) {
    const palette = usePalette();
    const RING_SIZE = 28;
    const RING_STROKE = 3;
    const radius = (RING_SIZE - RING_STROKE) / 2;
    const circumference = 2 * Math.PI * radius;
    return (
        <Svg width={RING_SIZE} height={RING_SIZE}>
            <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={radius}
                stroke={palette.muted}
                strokeWidth={RING_STROKE}
                fill="none"
                opacity={0.25}
            />
            <Circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={radius}
                stroke={palette.accent}
                strokeWidth={RING_STROKE}
                fill="none"
                strokeLinecap="round"
                strokeDasharray={`${circumference}`}
                strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, fraction)))}
                transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
        </Svg>
    );
}

/**
 * 媒体上传占位（虚线框 + spinner/进度环 + 文案，与大厂上传态一致；卡片圆角
 * 与媒体块对齐）。progress（0..1，store 注册表 100ms 节流帧）非空时以
 * 「进度环 + 保存中 N%（tabular-nums）」替代 spinner——视频直迁流有逐块
 * 进度；图片/音频字节路径无进度拍，保持 spinner 态（诚实降级，不伪造进度）。
 */
function PendingMediaBlock({ style, progress }: { style?: object; progress?: number }) {
    const palette = usePalette();
    return (
        <View
            style={style}
            className="h-[132px] items-center justify-center gap-2 rounded-card border border-dashed border-ink-accent/40 bg-ink-accent-bg/40 dark:border-inkd-accent/40 dark:bg-inkd-accent-bg/40"
        >
            {progress != null ? (
                <>
                    <PendingMediaProgressRing fraction={progress} />
                    <Text
                        className="text-[12px] text-ink-secondary dark:text-inkd-secondary"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {`保存中 ${Math.round(progress * 100)}%`}
                    </Text>
                </>
            ) : (
                <>
                    <ActivityIndicator color={palette.spinner} />
                    <Text className="text-[12px] text-ink-secondary dark:text-inkd-secondary">
                        正在上传…
                    </Text>
                </>
            )}
        </View>
    );
}

/** 媒体邻接判定（pending 占位同为 t:'media'，天然计入多图节奏）。 */
const isMediaLike = (block: JournalBlock | undefined): boolean => block?.t === 'media';

/**
 * 多选覆盖层命中面（deck 域内复用）：触摸面零 className（deck 铁律——按压体
 * 不落 className，防 css-interop 按压 observable 注入手势窗口）→ inline
 * style 模块级常量（引用恒等，任意重渲不重建样式）。
 */
const SELECTION_OVERLAY_STYLE = {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
};

/* ------------------------------------------------------------------ */
/* 连续同 kind 媒体堆叠（deck 式：渲染层合并，数据仍是独立块，分组是纯派生） */
/* ------------------------------------------------------------------ */

/** 媒体块变体（分组条目类型）。 */
type JournalMediaBlock = Extract<JournalBlock, { t: 'media' }>;

/**
 * 堆叠成员种类：图片/视频（自然相邻自动成组的既有口径）+ 音频（仅显式
 * groupId 组收编——音频卡是常驻操作面、无「换张」语义，永不参与自然成组，
 * 但自定义合并堆叠允许混合 kind，音频成员进 deck 渲染分支时按音频卡体
 * 呈现，其余成员不变）。
 */
type DeckMediaKind = 'image' | 'video' | 'audio';

/** deck 组条目（块 + 媒体行 + 成员种类 + 全局 index）。 */
type DeckItem = {
    block: JournalMediaBlock;
    media: JournalMediaRow;
    deckKind: DeckMediaKind;
    index: number;
};

/**
 * 堆叠成员资格：已就绪的图片/视频/音频媒体块 → 返回媒体行与种类（供槽位
 * 渲染直接复用，免二次查表）；其余（文本/pending 占位/媒体行缺失）返回 null。
 * pending 占位**不进堆叠也不被堆叠跨越**（占位是插入中瞬态，保持现有独立
 * 占位渲染；上传回填后自然并入/成组）。
 */
const asDeckMember = (
    block: JournalBlock,
    mediaById: Map<string, JournalMediaRow>,
): { media: JournalMediaRow; deckKind: DeckMediaKind } | null => {
    if (block.t !== 'media' || block.mediaId === PENDING_MEDIA_ID) return null;
    const media = mediaById.get(block.mediaId);
    if (media == null) return null;
    return media.kind === 'image' || media.kind === 'video' || media.kind === 'audio'
        ? { media, deckKind: media.kind }
        : null;
};

/**
 * 渲染单元：单块（现有独立渲染路径）或媒体堆叠组（≥2 才成组）。分组规则：
 * - **显式组**（自定义合并堆叠）：连续相邻且同 groupId 的就绪媒体块（混合
 *   kind 允许）合并为一个堆叠单元——成员已被合并操作物理重排成连续段
 *   （journal-logic.mergeStackBlocks）；段被用户移块拆散后，各连续子段独立
 *   成组、孤员回退 single 渲染（groupId 仍在数据里，解散操作仍可用）；
 * - **自然组**（既有口径）：无 groupId 的**连续相邻且同 kind** 图片/视频
 *   ≥2 合并（中间无文本/异 kind/音频/pending 打断）；图片视频混排按 kind
 *   分段；音频永不自然成组；单张回退独立渲染。
 * 两类互不跨越：显式组成员不进自然组，反之亦然。
 */
type RenderUnit =
    | { kind: 'single'; block: JournalBlock; index: number }
    | { kind: 'deck'; items: DeckItem[]; groupId?: string };

/**
 * 块列表 → 渲染单元（纯函数，每次渲染重算——组随块增删/移动自动重算/解散，
 * 「组内单删后剩 1 块回独立渲染」由此免费获得，零额外状态）。
 */
function buildRenderUnits(
    blocks: JournalBlock[],
    mediaById: Map<string, JournalMediaRow>,
): RenderUnit[] {
    const units: RenderUnit[] = [];
    // 自然组进行段（无 groupId、同 kind 连续）
    let auto: { deckKind: DeckMediaKind; items: DeckItem[] } | null = null;
    // 显式组进行段（同 groupId 连续，混合 kind）
    let explicit: { groupId: string; items: DeckItem[] } | null = null;
    const flushAuto = () => {
        if (!auto) return;
        if (auto.items.length >= 2) {
            units.push({ kind: 'deck', items: auto.items });
        } else {
            // 成组未满 2 块：回退现有独立渲染路径（单张 = 单元）
            for (const item of auto.items) {
                units.push({ kind: 'single', block: item.block, index: item.index });
            }
        }
        auto = null;
    };
    const flushExplicit = () => {
        if (!explicit) return;
        if (explicit.items.length >= 2) {
            units.push({ kind: 'deck', items: explicit.items, groupId: explicit.groupId });
        } else {
            for (const item of explicit.items) {
                units.push({ kind: 'single', block: item.block, index: item.index });
            }
        }
        explicit = null;
    };
    blocks.forEach((block, index) => {
        const groupId = block.t === 'media' && block.groupId ? block.groupId : null;
        const member = asDeckMember(block, mediaById);
        if (groupId != null) {
            if (
                block.t === 'media' &&
                member != null &&
                explicit != null &&
                explicit.groupId === groupId
            ) {
                // 不变量：explicit 非空 ⟹ 上一块是同组就绪媒体块（异组/非成员
                // 在上一轮已 flush），「相邻 index」天然成立
                explicit.items.push({ block, media: member.media, deckKind: member.deckKind, index });
                return;
            }
            flushAuto();
            flushExplicit();
            if (block.t === 'media' && member != null) {
                explicit = { groupId, items: [{ block, media: member.media, deckKind: member.deckKind, index }] };
                return;
            }
            // 同 groupId 但成员资格失效（行缺失等）：断段独立渲染，组数据保留
            units.push({ kind: 'single', block, index });
            return;
        }
        // 无组块：显式段收口（显式成员不参与自然成组）
        flushExplicit();
        if (block.t === 'media' && member != null && member.deckKind !== 'audio') {
            if (auto != null && auto.deckKind === member.deckKind) {
                auto.items.push({ block, media: member.media, deckKind: member.deckKind, index });
            } else {
                // 首块入组 / kind 切换（视频打断图片串、图片打断视频串）：
                // 旧段收口，新段起组
                flushAuto();
                auto = { deckKind: member.deckKind, items: [{ block, media: member.media, deckKind: member.deckKind, index }] };
            }
            return;
        }
        flushAuto();
        units.push({ kind: 'single', block, index });
    });
    flushExplicit();
    flushAuto();
    return units;
}

/** 堆叠单元在 blocks 数组中的位置投影（屏层「整组移动 / 整组删除」的取数口）：
 *  firstIndex/lastIndex = 组首/组尾块的全局下标（连续段）；blockIds = 组内全部
 *  成员块 id（批量删除清单）。null = 该块不在任何堆叠里（单张渲染路径）。 */
export type DeckUnitRange = {
    firstIndex: number;
    lastIndex: number;
    blockIds: readonly string[];
};

/**
 * 求含指定块 id 的堆叠单元（屏层整组操作的判定入口）：直接跑 buildRenderUnits
 * 再按 id 命中——分组规则的**单一事实源**仍是 buildRenderUnits（显式 groupId 组
 * + 自然相邻同 kind 组），此处零规则复制，渲染与整组操作的分组口径天然锁步。
 * 每次调用 O(n) 重派生（编辑器画布每帧本就重算，屏层操作卡入口一次调用，成本
 * 可忽略）。找不到 deck 单元（单张/文本/pending）返回 null，调用方回退单块操作。
 */
export function findDeckUnit(
    blocks: JournalBlock[],
    mediaById: Map<string, JournalMediaRow>,
    blockId: string,
): DeckUnitRange | null {
    for (const unit of buildRenderUnits(blocks, mediaById)) {
        if (unit.kind !== 'deck') continue;
        const ids = unit.items.map((item) => item.block.id);
        if (!ids.includes(blockId)) continue;
        return {
            firstIndex: unit.items[0].index,
            lastIndex: unit.items[unit.items.length - 1].index,
            blockIds: ids,
        };
    }
    return null;
}

/** deck 槽位动画容器（deck.tsx AnimatedSlot 同款）：模块级创建——组件级
 *  createAnimatedComponent 会在每次渲染重建 native 组件（整槽重挂），是
 *  手势窗口内的原生层扰动源（deck.tsx #9 同源教训）。 */
const DeckAnimatedSlot = Animated.createAnimatedComponent(View);

/* ------------------------------------------------------------------ */
/* 媒体堆（相纸堆 v11）中卡固定画幅、后卡位形与转场常量（一处收口）       */
/* ------------------------------------------------------------------ */

/**
 * 中卡宽首选档（列宽比例，62-70% 档取 66% 中值）：v11 起中卡画幅固定（用户
 * 裁决「直接固定长度宽度以及最低宽度长度，固定长度」），宽度 = clamp(列宽 ×
 * 66%, DECK_CARD_MIN_WIDTH, 列宽 − 2×DECK_PETAL_MARGIN)，高 = DECK_CARD_HEIGHT
 * 固定常量——比例只决定首选值，上下限夹取后与列宽一起构成全部几何（见
 * MediaDeckStack 几何注）。水平构图（2026-11-11 用户反馈②「图片视频单张和
 * 堆叠都改成靠左边不再居中」）：默认**靠左**（useMediaAlignPref 对齐偏好，
 * left/center/right 三档，deck 与单张卡同源消费）；center 档保留 v11 的居中
 * 构图作为可选项（偏好收口在 ui/theme，Me 外观卡可切）。
 */
const DECK_FRONT_WIDTH_RATIO = 0.66;

/**
 * 中卡固定高（dp，v11 用户裁决「固定长度」）：堆叠卡高不再随前卡自然比例
 * 派生——v10 的 min(宽 ÷ 比例, 上限) 自适应整轨撤销（比例派生让换张收口
 * 背组高 reflow、再靠前卡淡入掩盖，是「切换不丝滑」的根源之一）。固定 420
 * 与单张 MEDIA_MAX_HEIGHT = 420 数值对齐（正文流内媒体块的高度纪律同一
 * 档），语义各自维护：单张是自适应上限、堆叠是固定值；「最小卡高下限」
 * 概念并入固定值本身（固定即下限，不再单列）。三槽（中卡/左右相纸）同高；
 * 媒体 cover 铺满固定盒（裁切部分放弃，占满优先于完整显示，见 DeckFrontCard
 * 注）。组高 = 固定高 + 楔形带 + 计数行，全静态派生（换张零 reflow）。
 */
const DECK_CARD_HEIGHT = 420;

/**
 * 堆卡卡体圆角（dp）：rounded-card 16 档（tailwind 半径令牌，见
 * tailwind.config.js borderRadius.card）的 inline 双保险值——四种堆卡卡体
 * （图片前卡 / 图片露边层 / 视频前卡 / 视频占位卡）的圆角声明收口于此常量：
 * className rounded-card 与 inline borderRadius 同值并存（父层双保险），内层
 * 媒体元素（Image/VideoView/占位 View）再自挂同值圆角（内层兜底）。
 * 为何内层必须自挂：露边层卡体处于 ±4° 旋转 + 0.96 缩放的 AnimatedSlot
 * 位形下，Android（Fabric）对「旋转祖先内子内容」的 overflow-hidden 圆角
 * 裁切会失灵——内层 cover 内容「顶穿」父圆角渲染成直角（用户反馈的第二层
 * 堆卡直角缘即此病）；内层自挂圆角后可见性不依赖父裁切、随位形保持。iOS
 * 裁切可靠，同值内层圆角与父 outline 几何重合，无视觉差。不新增半径档位
 * （16 = rounded-card 既有档）。
 */
const DECK_CARD_RADIUS = 16;

/**
 * 中卡最小宽下限（dp）：列宽 × 66% 在手机窄列（正文列 272~363dp 常见）会
 * 跌破 240，堆卡被压得过窄失去体量——下限钳到 240 保证窄列堆卡仍占列宽
 * 大半（312dp 列卡宽 240 = 77%）。与上限（列宽 − 2×花瓣余量）冲突时上限
 * 优先（溢出防护 > 体量下限，夹取序见 MediaDeckStack 几何注）。
 */
const DECK_CARD_MIN_WIDTH = 240;

/**
 * 花瓣外露余量（dp，单侧）：相纸绕中心转 ±4° 后角点横向越出中卡边缘的量
 * 上界——旋转包围盒半宽 − 中卡半宽 = (W(s·cosθ−1) + H·s·sinθ)/2，固定高
 * 420 下全宽度域 ≤ 9.3dp（W 240~409dp，W 越小越出越多）。卡宽上限 = 列宽
 * − 2×本值，保证花瓣角点恒落在列内不被 overflow-hidden 裁切。取 16dp：
 * 对越出上界留 ≥6dp 余量，且恰为上限钳制时两侧留白的下界（strip = 本值），
 * 几何自洽（夹取后 strip ≥ 越出量恒成立）。
 */
const DECK_PETAL_MARGIN = 16;

/** 后卡（相纸）位形：同 frame 微缩 0.96（深度线索）+ 下移 26（底缘露出
 *  带）+ ±4° 镜像倾斜（左 −4° / 右 +4° 扇形；倾斜斜边 + 圆角 + 真实邻图
 *  内容 = 「另一张照片」的形状语法——v2 侧缘直条 / v3 底缘直条 / v5 窄边
 *  三版可读性翻车同源：轴向平行直条在视觉语法里读作边框/chrome，不读作
 *  另一张照片）+ 压暗 0.85（motion.md 戒律 dims no lower than 40%：压而
 *  不没）。无阴影设计下后卡与中卡的分层 = 缩放 + 遮挡 + 垫边 tone + 描
 *  边 + 亮度差，归中时 spring 回 1/0°/1/1。±4° 与压暗 0.85 为分离度强化
 *  档（用户反馈「相近颜色图片堆叠不可辨」：3°/0.92 在同色系照片上四路
 *  分层线索全部弱到不可辨）。 */
const DECK_BACK_SCALE = 0.96;
const DECK_BACK_DROP = 26;
const DECK_BACK_ROTATE_DEG = 4;
const DECK_BACK_OPACITY = 0.85;
/** 相纸垫边（dp）：后卡图内收 4dp 露 raised 垫底——白底照片的楔缘在浅色
 *  页上也有 tone 可依（taste-skill app-screens：表面靠 tone step 分层，
 *  不靠线不靠阴影；#13 无描边口径的延伸——垫边是填充 tone 不是 border）。
 *  2 → 4 为分离度强化档：2dp 在同色照片 + 浅色页组合下垫边窄到不可辨，
 *  4dp 与相纸装裱的常规留白档一致（照片 mat 惯例）。圆角 = 卡体本体
 *  rounded-card + inline 同值双保险（DECK_CARD_RADIUS），内图同值自挂
 *  （Android 旋转位形下不依赖父裁切，见 DECK_CARD_RADIUS 注；不新增
 *  半径档位）。 */
const DECK_MAT = 4;
/** 计数行（12px 字配 18dp 行，2dp 网格）与楔形带的呼吸缝：计数行锚定在
 *  楔形带之下（几何核算见 MediaDeckStack 注），不与相纸楔形重叠。 */
const DECK_COUNTER_LINE = 18;
const DECK_COUNTER_GAP = 2;
/** 横滑方向锁（onMoveShouldSetPanResponder）：|dx| 超过 10 且
 *  |dx| > 1.5|dy| 才认领手势——横向意图判定，画布纵向滚动零仲裁。 */
const SWIPE_LOCK_DX = 10;
const SWIPE_LOCK_RATIO = 1.5;
/** 松手提交阈值（|dx|，dp）：超过 = 提交换位（真转场），否则回弹归位。 */
const SWIPE_COMMIT_DX = 60;
/** 回弹 spring 摩擦系数（deck.tsx SPRING_FRICTION 同款口径）。 */
const DECK_SPRING_FRICTION = 8;
/** 中卡拖拽远离中位的降透明下限（插值端点）：拖出 = 即将离场的手势暗示；
 *  越过列宽的区段（出卡滑出阶段）由同一插值续降到 0（见 frontStyle 注）。 */
const DECK_DRAG_MIN_OPACITY = 0.72;
/** 出卡滑出时长（ms）与曲线：沿拖拽方向滑到列宽 + 越缘余量，
 *  overflow-hidden 裁切 + 降透明；曲线取 motion.md 研究里出场最频的
 *  ease-out quint（.22,1,.36,1），出场快于入场（约 70% 口径），220ms
 *  收住不拖沓。 */
const SWIPE_EXIT_MS = 220;
const DECK_EXIT_EASING = Easing.bezier(0.22, 1, 0.36, 1);
/** 出卡滑出的越缘余量（dp）：滑到列宽 + 余量保证整卡完全离开
 *  overflow-hidden 容器，收口帧复位换内容不可见。 */
const DECK_EXIT_MARGIN = 40;
/** 相纸归中 spring：friction 25 / tension 165 → ζ = 25/(2·√165) ≈ 0.97，
 *  ~310ms 无过冲收敛——「放平在堆上」的落定手感由近临界阻尼承担
 *  （motion.md：界面元素禁过冲；animate-expo：默认 settle 不带回弹）。 */
const DECK_ENTER_FRICTION = 25;
const DECK_ENTER_TENSION = 165;
/** 转场统一收口 deadline（ms）：出卡 220ms timing 与归中 spring（~310ms
 *  到位）都完成后 snap 复位 + 提交索引轮转；总时长 ≤350ms 预算内。 */
const ADVANCE_TOTAL_MS = 330;
/** 减弱动态转场（motion.md rule 14「弱化态 = 少而柔，保留解释状态变化的
 *  opacity 通道」）：无位移无旋转，中卡 160ms 淡化收口（AccessibilityInfo
 *  reduceMotion 驱动，见 MediaDeckStack 注动画口径段）。 */
const DECK_REDUCED_FADE_MS = 160;

/* v10 的 DECK_FRONT_FADE_IN_MS（收口帧前卡淡入）与 deckFrontRatio（前卡
 * 自然比例派生）随自适应画幅一并退役（v11）：固定几何下换张零 reflow，
 * 无尺寸跳变可掩盖，前卡淡入失去存在理由——frontFade 通道只剩减弱动态
 * 单一职责（见 finishAdvance / frontStyle 注）。 */

/**
 * 堆叠中卡（图片堆变体）：几何由 MediaDeckStack 数值化后传入显式宽高
 * （v11 固定画幅：宽 = clamp(列宽 × 66%, 240 下限, 列宽 − 2×花瓣余量)、高 =
 * DECK_CARD_HEIGHT 420 固定——组高与点按体 frame 都依赖数值高，不借助
 * yoga 的 aspectRatio 收敛）。内容语义 = **cover 铺满**（v11 用户裁决
 * 「固定尺寸 + 占满」优先于完整显示）：固定盒比例与媒体自然比例无关，
 * cover 精确填满卡体（裁切部分放弃）——v10 的 contain「卡即图」随自适应
 * 画幅一并撤销（contain 在固定盒下必然留边，是「有一些图片没真正占满」
 * 的直接病灶）；卡体 bg-ink-raised 保留为加载/失败占位底（mat 卡纸语言，
 * cover 恒满铺后不再有留边区）。圆角双保险（四种堆卡统一口径）：卡体本体
 * rounded-card + inline DECK_CARD_RADIUS 同值并存，内层 Image 同值自挂
 * ——内层可见性不依赖父 overflow-hidden 裁切（Android 最稳，见
 * DECK_CARD_RADIUS 注）。交互链 = 既有口径：点按 → requestViewer
 * 全屏（键盘先收）、长按/桌面双击 → onBlockAction 操作卡
 * （useBlockActionGestures 单点收口）。横滑拖拽不在此层——PanResponder
 * 挂在宿主手势面 wrapper（见 MediaDeckStack 注：父级方向锁认领后
 * responder 仲裁自然终止点按）。触摸面零 className（deck 触摸面纯净铁律：
 * 按压体不落 className，防 css-interop 按压 observable 注入手势窗口）。
 * 视频堆前卡 = DeckVideoFrontCard（同 frame/同描边/同手势链的封面态
 * 变体，见其注）。
 */
function DeckFrontCardImpl({
    media,
    width,
    height,
    interactive = true,
    onBlockAction,
}: {
    media: JournalMediaRow;
    width: number;
    height: number;
    /** 交互闸：转场期间中卡是「出卡层」，点按/长按一律吞掉（advancing 闩的
     *  渲染侧——disabled 传导触摸穿透到 wrapper，方向锁不认领 = 纯死区）。 */
    interactive?: boolean;
    /** 长按/桌面双击 → 块操作卡（编辑态传入；只读态不传 → 无长按层）。 */
    onBlockAction?: () => void;
}) {
    const { status, uri } = useFileUrlState(media.file_key);
    const palette = usePalette();
    const ready = status === 'ready' && uri != null;
    const usable = ready && interactive;
    const openViewer = () => {
        // 键盘态开全屏先收键盘（MediaImage 同口径：iOS 键盘浮于窗口层、
        // 路由屏盖不住；#17/#18）
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
            onPress={usable ? gestures.onPress : undefined}
            onLongPress={usable ? gestures.onLongPress : undefined}
            disabled={!usable}
            scaleTo={0.985}
        >
            {/* 1px hairline 描边（border/ink-border）：照片「卡纸装裱」（mat）语义
                ——相纸照片的常规装裱惯例是照片四周留白衬纸 + 细内线定界，与卡片
                级 chrome 无关（#13 清除的是卡片级描边；照片边缘定界属照片本体
                惯例）。分离度强化件之一：相近色调的前后卡叠放时，hairline 在
                前卡边缘给出精确轮廓（垫边 tone 与压暗都随图色漂移，唯描边恒
                定）。cover 恒满铺固定盒（v11），raised 底只在加载/失败态可见。
                圆角双保险（Android）：卡体本体 rounded-card + inline
                DECK_CARD_RADIUS 同值并存，内层 Image 同值自挂——内层可见性
                不依赖父 overflow-hidden 裁切（见 DECK_CARD_RADIUS 注）。 */}
            <View
                className="overflow-hidden rounded-card border border-ink-border bg-ink-raised dark:border-inkd-border dark:bg-inkd-raised"
                style={{ width, height, borderRadius: DECK_CARD_RADIUS }}
            >
                {ready ? (
                    <Image
                        source={{ uri }}
                        style={{ width, height, borderRadius: DECK_CARD_RADIUS }}
                        resizeMode="cover"
                    />
                ) : status === 'missing' ? (
                    <View className="flex-1 items-center justify-center gap-1.5">
                        <LucideImage size={20} strokeWidth={1.9} color={palette.muted} />
                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                            图片无法显示
                        </Text>
                    </View>
                ) : null}
            </View>
        </BouncyPressable>
    );
}

const DeckFrontCard = memo(DeckFrontCardImpl);

/**
 * 相纸卡体（底缘后卡，图片堆露边层）：与中卡同尺寸的整卡渲染（同 frame +
 * cover 裁切，楔形露出的是真实相邻图内容、不是窄边条占位），位形（下移/
 * 倾斜/微缩/压暗）由宿主层的 AnimatedSlot 恒挂通道施加——静止时底缘楔形
 * 露在中卡之下（z 恒在中卡之下）；转场时它即归中卡体（位形 spring 归零
 * 由宿主 AnimatedSlot 驱动，随中卡滑出让位逐步揭开）。
 * **露边层恒 cover（v11 与前卡同轨）**：固定 frame 下 cover 恒满铺卡体，
 * 楔形露出区（卡底 ~25~32dp 斜条）对任意邻卡画幅都有真实图内容（露出的
 * 是邻图底缘裁切条——「真实邻图内容 = 另一张照片」的形状语法（v2/v3/v5
 * 三版可读性翻车的修复面）要的是「图内容在场」，不是完整缩略；contain
 * 在固定盒下必然留边，楔形露出区只剩垫底色，整段语义不成立）。v10 的
 * 「前卡 contain / 露边层 cover 分轨」随自适应画幅一并收拢为同轨 cover。
 * **露边层圆角不变量（卡体本体挂 rounded-card16 + inline 同值双保险）**：
 * 圆角挂在后卡自身的 View 上（className rounded-card 与 inline
 * DECK_CARD_RADIUS 同值并存），transform（微缩/下移/倾斜）作用于已带圆角
 * 的层——圆角随缩放/位移/倾斜保持（RN 的 borderRadius 属层自身绘制，先
 * 圆角后变换），不被任何容器 overflow-hidden 裁成直角缘；容器
 * overflow-hidden 只承担列缘出血裁切（横滑出卡/楔形越缘），几何上露出区
 * 距容器底缘 ≥ 缝 + 计数行 ≈ 20dp（见 MediaDeckStack 几何注），底缘圆角
 * 完整呈现，与中卡圆角同档（rounded-card 16）。内层 Image 同值自挂圆角
 * （Android 双保险）：露边层处于 ±4° 旋转 + 0.96 缩放位形下，Android 对
 * 旋转祖先内的子内容圆角裁切会失灵——内图 cover「顶穿」父圆角呈直角
 * （第二层堆卡直角缘的病灶），内图自挂后圆角可见性不依赖父裁切（见
 * DECK_CARD_RADIUS 注）。
 * 4dp raised 垫边（DECK_MAT）= 相纸的「纸缘」tone step：白底照片的楔缘
 * 在浅色页上也可辨（taste-skill：表面分层靠 tone step 不靠线；#13 无描边
 * 口径的延伸——垫边是容器底色透出，不是 border 线）；不新增半径档位
 * （16 = rounded-card 既有档）。
 * 零交互纯视觉，无按压体：点按命中由宿主的底缘楔形带点按体承担（视觉面
 * 与命中面分离——双按压体叠命中区只会互相抢）；图片未就绪时保持 raised
 * 占位底（楔形带放不下失败文案，加载态即垫边色）。
 */
function DeckBackCardImpl({
    media,
    width,
    height,
}: {
    media: JournalMediaRow;
    width: number;
    height: number;
}) {
    const { status, uri } = useFileUrlState(media.file_key);
    return (
        <View
            className="overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
            style={{ width, height, padding: DECK_MAT, borderRadius: DECK_CARD_RADIUS }}
        >
            {status === 'ready' && uri ? (
                <Image
                    source={{ uri }}
                    style={{
                        width: width - DECK_MAT * 2,
                        height: height - DECK_MAT * 2,
                        // 内层同值圆角双保险（Android 旋转位形下不依赖父裁切）
                        borderRadius: DECK_CARD_RADIUS,
                    }}
                    resizeMode="cover"
                />
            ) : null}
        </View>
    );
}

const DeckBackCard = memo(DeckBackCardImpl);

/**
 * 堆叠中卡（视频堆前卡，MediaVideo 封面态的 deck frame 变体）：paused 首帧
 * + 中央播放钮（黑透圆底白三角，与 MediaVideo 同口径），点前卡 → 全屏播放
 * （requestViewer kind video，全屏内 native controls）、长按/桌面双击 →
 * 操作卡——手势链/交互闸/hairline 描边与 DeckFrontCard 完全同构（useBlock
 * ActionGestures 单点收口 + interactive 转场闸 + mat 描边）。
 *
 * 为何不复用 MediaVideo 导出：其布局契约是 w-full + aspectRatio/maxWidth
 * （media-view 单张自适应路径，本轮不动），而 deck 前卡需要宿主数值化的
 * 固定显式 frame（组高/三槽同 frame/点按体几何都依赖数值高）；且
 * MediaVideo 无 interactive 闸（转场期间点按出卡层会误开全屏）与 mat 描边
 * 档——deck 内按封面态同款实现（VideoView + 中央播放钮 + 同一 Pressability
 * 链），file/url 状态与全屏口径复用同一批收口件（useFileUrlState /
 * requestViewer / useBlockActionGestures）。
 *
 * **性能红线（视频堆）**：整堆只有本卡挂 player（useVideoPlayer，paused 封
 * 面态不自动播放）；底层露边层绝不挂载视频播放器（见 DeckVideoBackCard）。
 * 宿主以 key={media.id} 挂载本卡：收口换张 = 卸载旧 player + 挂载新 player
 * （useVideoPlayer 卸载即释放，任意时刻每堆 ≤1 个 player 实例）——不用
 * replaceAsync 复用实例的原因：源替换异步完成，换张瞬间 VideoView 会残留
 * 上一张视频的首帧（刚滑出的那张）造成错内容闪帧，重挂的空 player 以
 * raised 底过渡（与加载态同语言）直到新首帧就绪，内容永远正确。
 * contentFit = cover（v11 与图片前卡同步）：固定 frame（高 = DECK_CARD_HEIGHT
 * 420）与视频自然比例无关，cover 精确填满卡体（裁切部分放弃，占满优先于
 * 完整显示——v10 的 contain「卡即图」随自适应画幅一并撤销）；VideoView
 * backgroundColor = palette.raised 保留为 player 首帧就绪前的过渡底（解析中
 * /收口重挂态，与加载态同语言）；**不做轨道尺寸探测**（useVideoNaturalSize
 * 缺席）：固定画幅下组高与视频比例零耦合，比例不再参与任何几何派生。
 * 触摸面纪律与 DeckFrontCard 相同：VideoView 包 core View pointerEvents=
 * "none"（expo-video 原生层吞触摸，#2b 同口径），按压统一走外层
 * BouncyPressable；触摸面零 className。
 */
function DeckVideoFrontCardImpl({
    media,
    width,
    height,
    interactive = true,
    onBlockAction,
}: {
    media: JournalMediaRow;
    width: number;
    height: number;
    /** 交互闸：转场期间中卡是「出卡层」，点按/长按一律吞掉（与 DeckFrontCard
     *  同口径——disabled 传导触摸穿透到 wrapper，方向锁不认领 = 纯死区）。 */
    interactive?: boolean;
    /** 长按/桌面双击 → 块操作卡（编辑态传入；只读态不传 → 无长按层）。 */
    onBlockAction?: () => void;
}) {
    const { status, uri } = useFileUrlState(media.file_key);
    const palette = usePalette();
    const ready = status === 'ready' && uri != null;
    const usable = ready && interactive;
    // player（本堆唯一实例，见组件注性能红线）：uri 可能为 null（文件未解析/
    // 缺失），是合法 VideoSource（空 player），同 MediaVideo 口径
    const player = useVideoPlayer(uri, (p) => {
        p.loop = false;
        p.muted = false;
    });
    const openViewer = () => {
        // 键盘态开全屏先收键盘（DeckFrontCard/MediaVideo 同口径：#17/#18）
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
            onPress={usable ? gestures.onPress : undefined}
            onLongPress={usable ? gestures.onLongPress : undefined}
            disabled={!usable}
            scaleTo={0.985}
        >
            {/* frame/描边与 DeckFrontCard 完全同档：rounded-card16 + 1px hairline
                mat 描边 + raised 占位底（见 DeckFrontCard 注描边语义段） */}
            <View
                className="overflow-hidden rounded-card border border-ink-border bg-ink-raised dark:border-inkd-border dark:bg-inkd-raised"
                style={{ width, height, borderRadius: DECK_CARD_RADIUS }}
            >
                {ready ? (
                    <>
                        {/* 封面帧：paused 首帧，nativeControls=false；触摸层 =
                            core RN View 包装（pointerEvents="none"，#2b 见组件注）；
                            包装层再兜 overflow-hidden + 同值圆角（VideoView 是
                            平台视图，Android 对其外溢内容的裁切最不稳——见
                            DECK_CARD_RADIUS 注），VideoView 本体同值自挂 */}
                        <View
                            className="flex-1"
                            pointerEvents="none"
                            style={{ overflow: 'hidden', borderRadius: DECK_CARD_RADIUS }}
                        >
                            <VideoView
                                player={player}
                                nativeControls={false}
                                contentFit="cover"
                                style={{
                                    flex: 1,
                                    backgroundColor: palette.raised,
                                    borderRadius: DECK_CARD_RADIUS,
                                }}
                                allowsPictureInPicture={false}
                            />
                        </View>
                        {/* 中央播放钮：与 MediaVideo 同口径（黑透圆底 + 白播放三角，
                            不参与命中，整块按压统一进全屏） */}
                        <View className="pointer-events-none absolute inset-0 items-center justify-center">
                            <View className="h-12 w-12 items-center justify-center rounded-full bg-black/40">
                                <LucidePlay size={20} color="#FFFFFF" strokeWidth={2.2} />
                            </View>
                        </View>
                    </>
                ) : status === 'missing' ? (
                    <View className="flex-1 items-center justify-center gap-1.5">
                        <LucideVideo size={20} strokeWidth={1.9} color={palette.muted} />
                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                            视频无法播放
                        </Text>
                    </View>
                ) : (
                    // 解析中：raised 底 + spinner，非裸黑块（MediaVideo 同口径）
                    <View className="flex-1 items-center justify-center">
                        <ActivityIndicator color={palette.spinner} />
                    </View>
                )}
            </View>
        </BouncyPressable>
    );
}

const DeckVideoFrontCard = memo(DeckVideoFrontCardImpl);

/**
 * 相纸卡体（视频堆露边层）：**真封面 Image（无 player）**——2026-11-08 用户
 * 反馈「视频堆叠的底层视频没有加载封面」的修复面。旧实现是 raised 底 + 居中
 * 播放钮的自绘占位卡（当时 schema 无缩略图列、逐卡首帧提取被否）；现缩略图
 * 链路已建（store.ensureVideoThumbnail：attach 成功后生成 / 存量惰性回填，
 * key = `${fileKey}.thumb.jpg`，≤512px JPEG 落 file-storage），露边层按
 * useVideoThumbState 三态消费：
 * - ready → 真封面 Image（同 DeckBackCard 的 mat 垫边 + cover 铺满口径，
 *   楔形露出真实邻卡帧内容——形状语法 + 内容线索双成立）；
 * - loading / missing（未生成/生成失败/web 无实现）→ 回退既有占位卡
 *   （raised 底 + 居中播放钮，尺寸/位置与前卡中央钮同位同规格——收口换张
 *   「揭开 → 实体化」读感连续，钮位不跳）。
 * **性能红线不变**：露边层零 player（真封面是 Image 解码位图，非 VideoView
 * ——每堆仍只有前卡挂 1 个 player 实例）。新增的成本 = thumbKey 的 url 三态
 * 订阅（useFileUrlState：native file:// O(1) / web 会话缓存 blob，零字节
 * 搬运），是「真封面」的必要代价；楔形带放不下失败文案，媒体缺失态仍由前卡
 * 在归中后呈现。
 * 圆角不变量与 DeckBackCard 同款（露边层铁律）：rounded-card16 挂卡体本体
 * （className + inline DECK_CARD_RADIUS 同值双保险），transform 后依然保持，
 * 不被容器裁成直角；内层 Image/占位 View 同值圆角（Android 旋转位形双保险，
 * 见 DECK_CARD_RADIUS 注）；mat 垫边同 DECK_MAT。
 * 零交互纯视觉：点按命中由宿主底缘楔形带点按体承担。
 */
function DeckVideoBackCardImpl({
    media,
    width,
    height,
}: {
    media: JournalMediaRow;
    width: number;
    height: number;
}) {
    const { status, uri } = useVideoThumbState(media.file_key);
    const ready = status === 'ready' && uri != null;
    return (
        <View
            className="overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
            style={{ width, height, padding: DECK_MAT, borderRadius: DECK_CARD_RADIUS }}
        >
            {ready ? (
                <Image
                    source={{ uri }}
                    style={{
                        width: width - DECK_MAT * 2,
                        height: height - DECK_MAT * 2,
                        // 内层同值圆角双保险（Android 旋转位形下不依赖父裁切）
                        borderRadius: DECK_CARD_RADIUS,
                    }}
                    resizeMode="cover"
                />
            ) : (
                /* 内层同值圆角 + overflow-hidden 双保险（Android 与图堆同口径，
                    占位面随卡体圆角保持，见 DECK_CARD_RADIUS 注） */
                <View
                    className="flex-1 items-center justify-center"
                    style={{ overflow: 'hidden', borderRadius: DECK_CARD_RADIUS }}
                >
                    <View className="h-12 w-12 items-center justify-center rounded-full bg-black/40">
                        <LucidePlay size={20} color="#FFFFFF" strokeWidth={2.2} />
                    </View>
                </View>
            )}
        </View>
    );
}

const DeckVideoBackCard = memo(DeckVideoBackCardImpl);

/**
 * 堆叠中卡（音频成员变体，显式混合组专用）：把 AudioBlock 卡（media-view
 * 同源口径，media-view.tsx 收口）居中放进 deck 固定 frame——音频卡是常驻
 * 操作面（点按播放/暂停），deck 内音频成员保持完整交互，横滑换位仍由宿主
 * PanResponder 方向锁承担（拖拽认领后仲裁终止点按）。interactive 关闭
 * （转场期间/多选态）时整卡 pointerEvents none（转场吞点按与旧口径一致）；
 * dimmed = 多选模式下的「音频不可选」置灰（inline opacity，不落条件类）。
 * onBlockAction 透传长按/桌面双击操作卡链路。
 */
function DeckAudioFrontCardImpl({
    item,
    width,
    height,
    interactive = true,
    dimmed = false,
    onBlockAction,
}: {
    item: DeckItem;
    width: number;
    height: number;
    /** 交互闸：转场期间/多选态吞掉卡内全部点按（pointerEvents none）。 */
    interactive?: boolean;
    /** 多选模式置灰（音频不可参与合并）。 */
    dimmed?: boolean;
    onBlockAction?: () => void;
}) {
    return (
        <View
            pointerEvents={interactive ? 'auto' : 'none'}
            style={{
                width,
                height,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: dimmed ? 0.55 : 1,
            }}
        >
            <View style={{ width: '100%' }}>
                <AudioBlock
                    media={item.media}
                    durationMs={item.block.durationMs}
                    onBlockAction={interactive ? onBlockAction : undefined}
                />
            </View>
        </View>
    );
}

const DeckAudioFrontCard = memo(DeckAudioFrontCardImpl);

/**
 * 相纸卡体（音频成员露边层，显式混合组专用）：**零播放器零状态订阅**的
 * 轻量占位卡（性能红线与视频露边层同源——音频卡连 url 状态都不背）：
 * raised 底 + 声纹 icon 占位（mat 垫边/圆角双保险与 DeckBackCard 同款，
 * 见 DECK_CARD_RADIUS 注）。
 */
function DeckAudioBackCard({ width, height }: { width: number; height: number }) {
    const palette = usePalette();
    return (
        <View
            className="overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
            style={{ width, height, padding: DECK_MAT, borderRadius: DECK_CARD_RADIUS }}
        >
            <View
                className="flex-1 items-center justify-center"
                style={{ overflow: 'hidden', borderRadius: DECK_CARD_RADIUS }}
            >
                <AudioLinesIcon size={20} strokeWidth={1.9} color={palette.muted} />
            </View>
        </View>
    );
}

/**
 * 多选勾选角标（合并堆叠多选模式）：媒体块/堆叠前卡右上角 28dp 圆，
 * 选中 = accent 实底 + 白勾，未选 = 黑透底 + 白环；pointerEvents none
 * （命中全部归属下方覆盖层）。固定 hex 白 = 角标在任意媒体内容上的可辨
 * 描边（与堆卡 hairline 同源的「内容不可知」描边口径）。
 */
function SelectionCheck({ selected }: { selected: boolean }) {
    const palette = usePalette();
    return (
        <View pointerEvents="none" className="absolute right-2 top-2 z-10">
            <View
                className="h-7 w-7 items-center justify-center rounded-full"
                style={{
                    backgroundColor: selected ? palette.accent : 'rgba(0,0,0,0.4)',
                    borderWidth: 2,
                    borderColor: '#FFFFFFE6',
                }}
            >
                {selected ? <LucideCheck size={15} color="#FFFFFF" strokeWidth={2.6} /> : null}
            </View>
        </View>
    );
}

/**
 * 连续同 kind 媒体堆（v11 相纸堆：固定画幅中卡（宽 clamp(列宽 66%, 240,
 * 列宽 − 2×花瓣余量) / 高 420 固定，见「几何」段）+ 底缘倾斜相纸 + 归中真
 * 转场）。设计语言由 design skill 结论主导（候选方向与条款依据见本组设计
 * 决策书）：**Apple Photos Stacks 式「印刷相纸」隐喻**——堆叠的可读性来自
 * 形状语法（倾斜楔形 + 圆角 + 邻卡内容），不来自露边宽度（v2 44dp 侧缘直条
 * / v3 底缘直条 / v5 16:10 窄边三版翻车同源：轴向平行直条读作 chrome，
 * 不读作另一张照片）。
 *
 * **图片堆 / 视频堆同一套机制（单组件参数化，零复制）**：几何/位形/转场/
 * 手势/计数对全部 kind 完全同构，差异只在三槽的卡体渲染（**按成员 kind 分支**
 * ——显式 groupId 混合组允许图/视频/音频混排，自然组恒同 kind）——
 *   图片堆：前卡 DeckFrontCard（Image 封面）+ 露边层 DeckBackCard（真实
 *     邻图内容，楔形有内容线索）；
 *   视频堆：前卡 DeckVideoFrontCard（封面态，仅此卡挂 player，点前卡 =
 *     全屏播放）+ 露边层 DeckVideoBackCard（**缩略图 Image 真封面**——
 *     store.ensureVideoThumbnail 链路，未生成/失败回退 raised 底 + 中央
 *     播放 icon 占位卡；**绝不挂载视频播放器**——性能红线，见其注）；
 *     收口换张前卡按 media.id 重挂（player 随内容轮转重建，避免
 *     replaceAsync 异步窗口的错内容闪帧，见 DeckVideoFrontCard 注）；
 *   音频成员（仅显式组）：前卡 DeckAudioFrontCard（AudioBlock 常驻操作面）
 *     + 露边层 DeckAudioBackCard（raised 底 + 声纹 icon 占位，零订阅）。
 * 多选模式（selection prop，合并堆叠交互流）：非 null 时前卡点按 = 切换
 * 选中（覆盖层压住全屏/长按链），音频成员置灰吸收，底缘楔形带照常换位。
 *
 * 几何（组容器 relative overflow-hidden，宽 = 列宽 onLayout 量取，高 =
 * 中卡高 + 相纸楔形带 + 计数行；overflow-hidden 是横滑与楔形「部分可见」
 * 的实现基础——楔形越出容器缘的部分与滑出的出卡都被列缘裁切，不出血到
 * 画布留白；露边层圆角不靠容器：rounded-card16 挂卡体本体（inline 同值
 * 双保险）+ 内层媒体同值自挂（Android 旋转位形下不依赖父裁切，见
 * DECK_CARD_RADIUS 注）、随 transform 保持，露出区距容器底缘 ≥ 缝 + 计数
 * 行 ≈ 20dp 不会被裁成直角）：
 *   中卡（v11 固定画幅，用户裁决「直接固定长度宽度以及最低宽度长度，固定
 *       长度」）：宽 C = clamp(列宽 × 66%, 240 下限, 列宽 − 2×16 花瓣余量)，
 *       高 = DECK_CARD_HEIGHT 420 固定（三槽同固定 frame，frame 横向锚点按
 *       useMediaAlignPref 对齐偏好：默认 left 贴列缘（2026-11-11 反馈②「堆
 *       叠靠左不居中」），center 居中（left = (列宽 − C)/2）/ right 贴右缘
 *       为可选项）。夹取序 = 先 66% 比例、再 240 下限、后花瓣上限——
 *       上限最后压（溢出防护 > 体量下限）：花瓣角点横向越出中卡 ≤9.3dp
 *       （旋转包围盒，见 DECK_PETAL_MARGIN 注），上限钳制下两侧留白恒 =
 *       16dp ≥ 越出量，花瓣永不触列缘被裁；下限钳制（手机窄列 272~363dp
 *       常见触发，312dp 列卡宽 240 = 77%）时留白 = (列宽 − 240)/2 ≥ 16dp
 *       同样安全。媒体 cover 铺满固定盒（裁切部分放弃——「固定尺寸 + 占
 *       满」优先于完整显示，用户对 v10「有一些图片没真正占满」的修复裁
 *       决）；**换张零 reflow**：组高/三槽 frame 只由列宽派生、与媒体内容
 *       零耦合，列宽不变时换张（索引轮转）几何零变化——v10 的「组高随前
 *       卡比例单帧 reflow + 收口前卡淡入掩盖」整轨撤销（见 finishAdvance
 *       注）；**单张不成组走 media-view 同源自适应**（MediaImage /
 *       MediaBlock 口径，本轮不动）；
 *   后卡（相纸）：与中卡同固定 frame，位形 = 微缩 0.96 + 下移
 *       26 + 左 −4°/右 +4° 镜像倾斜（transform 数组序 [ty, rot, scale] =
 *       缩放、旋转围绕布局中心，translate 纯平移——下移量不随旋转偏斜）；
 *       左右镜像成扇，底缘露出倾斜楔形，最低点越过中卡底缘的量按几何精确解：
 *         wedgeDepth = DROP − H·(0.5 − s/2·cosθ) + (W·s/2)·sinθ
 *       （v11 固定高下 H 恒 420，楔形深只随卡宽 W 单调变化——数值表见
 *       「几何派生」注：W 240~409dp 全域 25.6~31.3dp，落在 25~33 参考带，
 *       无需调参，DROP 26 / ±4° 维持）；N=2 时左槽
 *       不渲染（只有右侧相纸，左侧空——单楔形 + 单点按区，退化优雅）；
 *   垫边：后卡图内收 4dp 露 raised（相纸「纸缘」tone，白图浅页可辨）；
 *   前卡描边：1px hairline（ink-border/inkd-border）——照片「卡纸装裱」
 *       （mat）语义，照片本体惯例非卡片级 chrome（#13 口径不变），相近
 *       色调前后卡叠放时的恒定轮廓线（详见 DeckFrontCard/DeckVideoFrontCard
 *       注）；
 *   计数行：楔形带之下（top = 中卡高 + max(wedgeDepth, 24) + 2——下限兜
 *       极端值，固定几何下 wedge ≥ 25.6 不触发，保留作防御；楔形带 +
 *       计数行合计 ≥44 触达口径恒成立，全域 45.6~51.3dp），横向锚定中卡
 *       两缘、右对齐，与楔形渲染零重叠。
 *
 * 层级 zIndex（全静态常量，一律不进动画值）：后卡槽 2 < 中卡槽 3 < 底缘
 * 点按体 4。后卡恒在中卡之下（z 不翻转），转场「揭开」语义由中卡滑出
 * 让位承担（静止重叠几何下提层会穿帮，v6 同源结论）；底缘点按体与中卡
 * frame 纵向零重叠（top = 中卡高，楔形带 + 计数行整条带），命中测试天然
 * 直达，无需 z 仲裁兜底。
 *
 * 交互链路（图/视频堆同链，既有口径）：点中卡 → requestViewer 全屏
 * （键盘先收；视频堆进全屏播放）；长按/桌面双击中卡 → onBlockAction 操作
 * 卡（useBlockActionGestures 单点收口）；点底缘楔形带 → 左半 = 上一张 /
 * 右半 = 下一张（N=2 单区全带宽 = 下一张，循环；命中区 = 带几何 ≥44dp、
 * 零 hitSlop、与中卡 frame 零重叠）；中卡横滑 = PanResponder 方向锁
 * （|dx|>10 且 |dx|>1.5|dy| 才认领，画布纵滚零仲裁）+ 提交阈值（|dx|>60）
 * ——手势面 = 满宽卡区（自中卡起手横滑）。转场期间 advancing 闩吞并发
 * 手势（方向锁不认领、点按体无效、中卡交互闸关闭；长按链路提交的是操作
 * 卡不动堆，无转场面）。
 *
 * 换位状态机（滑/点两条提交链路收口到同一条编排）：
 * - 统一编排 beginAdvance(dir)：中卡（出卡层，内容不换）沿换位方向
 *   frontX timing 220ms（ease-out quint）滑出列缘（透明度走 xFade 的
 *   |x|>列宽区段 0.72→0，与拖拽下限同一条插值）+ dir 侧相纸四值 spring
 *   归中（ty 26→0、±4°→0°、scale 0.96→1、opacity 0.85→1，~310ms 无过冲
 *   收敛——「放平在堆上」的落定）；相纸恒在中卡之下，随出卡让位逐步
 *   揭开；330ms deadline 统一收口（finishAdvance：全值 snap 复位 +
 *   advancing 闩释放 + 索引轮转，同批 React 提交零闪帧——图片堆归中相纸
 *   终态与轮转后中卡静止帧像素恒等；视频堆归中面 = 缩略图真封面（未生成回退占位卡），重挂后 raised
 *   底 + 播放钮与前卡加载态同语言，内容正确性优先于像素恒等）；
 * - 滑动提交：方向锁认领后 Animated.event 跟手写 frontX（仅中卡跟手——
 *   相纸是「堆叠在场」的静态语义，转场才入场，拖拽视差属锦上添花不做，
 *   保住「动画图零重建 + 手势窗口最小 native 扰动」口径），松手 |dx|>60 →
 *   commitSwipe = beginAdvance(dir)（出卡 timing 从当前拖拽位移续走）；
 * - 点楔形带提交：beginAdvance(±1)——出卡 timing 从 0 起走，同一编排，
 *   滑/点观感一致；
 * - 回弹：|dx|≤60 或手势被系统夺走（terminate）→ 仅 frontX spring 归 0
 *   （friction 8），索引不动、闩不介入（回弹中途可被下一轮拖拽接管）；
 * - 收口内容重指派（收口帧一次发生）：图片堆全部「像素恒等接管」或
 *   「原生缓存秒回」——中卡 ← 旧 dir 侧邻卡（归中相纸终态渲染像素恒等
 *   接管）；另一侧相纸 ← 旧中卡（刚在出卡层渲染过，原生 Image 缓存秒
 *   回）；归中相纸 snap 回位形并 ← 新 dir 侧邻卡（N=3 时 = 刚离场的另
 *   一侧相纸，秒回；N≥4 未渲染过，至多一帧 raised 占位——仅楔形带压暗
 *   露出区）；视频堆前卡 ← media.id 重挂（新 player，见 DeckVideoFrontCard
 *   注）、露边层内容零切换（占位卡无媒体状态）；v11 固定画幅下任意组收口
 *   帧零 reflow（三槽 frame 与组高恒定，像素恒等接管全组成立——比例派生
 *   与收口前卡淡入已随 v10 自适应画幅退役，见 finishAdvance 注）；
 * - N=2 退化：左相纸空缺（左槽/左点按体不渲染，prev 与 next 同卡），
 *   dir=−1（上一张）无左相纸可归中 → 与 dir=+1 同编排（中卡沿换位方向
 *   滑出 + 右相纸归中），出卡方向仍沿换位方向，视觉语义一致。
 *
 * 动画口径：RN Animated native driver，style 只 transform/opacity；旋转
 * 通道经 interpolate 出 'deg' 字符串（native 驱动旋转的文档口径）；拖拽
 * 跟手 = Animated.event([null, {dx}])（JS responder 事件映射，useNative
 * Driver: false 是 PanResponder 场景唯一合法值，native driver 由挂载方
 * 承担）；左右两槽各挂一组恒定归中通道（静止值 = 相纸位形基准，不按
 * advance 条件切换样式挂载），插值节点 useMemo 固定——任意重渲不重建
 * native 动画图（deck.tsx #9 教训），仅列宽变化（旋转/分栏）时锚定基准
 * 重设；frontStyle 透明度 = frontFade × xFade 插值（Animated.multiply，
 * 乘法节点随列宽变化同批重建）——frontFade 常态恒 1，唯一瞬态消费面 =
 * 系统「减弱动态」转场（AccessibilityInfo reduceMotion 开启时转场退化为
 * 160ms 中卡淡化收口，无位移无旋转，motion.md rule 14「弱化态 = 少而柔，
 * 保留解释状态变化的 opacity 通道」；animate-expo：reduced motion 与动画
 * 同时交付，不是后续补丁）；v10 的换张收口前卡淡入（掩盖组高 reflow）
 * 随自适应画幅退役——固定几何下收口帧零 reflow，无生硬感可掩盖，通道
 * 只剩减弱动态单一职责（beginAdvance 起手统一复位保证出卡层满透明度
 * 起步，见 finishAdvance 注）。
 *
 * 性能口径：图片堆任意 N 最多挂载 3 个图片实例（左/中/右三槽，N=2 恒
 * 2 个），转场不增实例（无第四渲染位——归中相纸复用本槽渲染位，内容零
 * 切换）；视频堆每堆仅前卡挂 1 个 player 实例、露边层零 player（缩略图
 * Image 真封面，未生成回退占位卡——仅 thumbKey 的 url 三态订阅，零字节
 * 搬运），收口换张 = 旧 player 卸载
 * 释放 + 新 player 挂载（同批 React 提交），任意时刻每堆 ≤1；两种堆
 * 其余成员都留在 blocks 数据里，换位只是索引轮转（数量无上限）；组内
 * 单删/移动 → buildRenderUnits 重派生（clamp/解散免费获得），deck 实例
 * 按组首块 id 做 key，组首块被删即重挂回第 1 块。与画布纵滚正交：方向锁
 * 保证横向意图才认领手势，纵滚零仲裁。
 */

/** 转场描述：dir = 换位方向（+1 下一张 / −1 上一张）。归中相纸内容 =
 *  渲染派生值（dir 侧邻卡槽本就渲染，零切换）；收口帧索引轮转后三槽
 *  内容随派生同帧重指派，无需携带 media。 */
interface DeckAdvance {
    dir: 1 | -1;
}

function MediaDeckStack({
    items,
    editable,
    selection,
    onBlockAction,
}: {
    items: DeckItem[];
    editable: boolean;
    /** 多选模式（合并堆叠 / 堆叠指定删除——白名单外堆叠由 BlockEditor 不透传
     *  处理，见其 selection prop 注）：非 null 时前卡点按 = 切换选中（全屏/
     *  长按被选中覆盖层屏蔽），勾选角标随选中态渲染；音频成员不可选（置灰 +
     *  触摸吸收）；底缘楔形带仍可点按换位（循环翻看选中成员）。 */
    selection?: { selectedIds: ReadonlySet<string>; onToggle(blockId: string): void } | null;
    /** 请求弹出当前中卡的块操作卡（屏层渲染，作用于该块）。 */
    onBlockAction(blockId: string): void;
}) {
    const itemCount = items.length;
    // 媒体块水平对齐偏好（2026-11-11 反馈②，hook 直读自生效——调用方零改动，
    // Me 外观卡切换实时生效）：left 靠左（默认）/ center 居中（v11 原构图）/
    // right 靠右。只改卡组的**内容流位置**（cardSlot 横向锚点），卡体尺寸/
    // 圆角/描边/位形零变化。
    const [mediaAlign] = useMediaAlignPref();
    // 组内容 ref 镜像：换位闭包读取最新组（手势/转场窗口内组可能增删）
    const itemsRef = useRef(items);
    itemsRef.current = items;

    // 组内中卡索引（换位 = 索引轮转，收口帧才提交；函数式更新串行化）
    const [frontIndex, setFrontIndex] = useState(0);
    // 容器宽（列宽自适应，onLayout 量取；全部几何由它派生，量取前不渲染卡内容）
    const [containerWidth, setContainerWidth] = useState(0);
    // 转场态（渲染驱动：中卡交互闸；z 全静态，见组件注层级段）+ advancing
    // 闩（手势闭包同步检查）——转场期间吞并发手势（滑/点全部无效）
    const [advance, setAdvance] = useState<DeckAdvance | null>(null);
    const advancingRef = useRef(false);
    const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 系统减弱动态（挂载时读一次 + 订阅变化；promise/事件在个别宿主缺失
    // 时静默回退 false——能力探测防御，弱化态判定错 only 影响转场编排档位）
    const reduceMotionRef = useRef(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled?.()
            .then((enabled) => {
                if (!cancelled) reduceMotionRef.current = !!enabled;
            })
            .catch(() => undefined);
        const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled) => {
            reduceMotionRef.current = !!enabled;
        });
        return () => {
            cancelled = true;
            subscription?.remove();
        };
    }, []);

    // 中卡索引（clamp 后派生，组收缩不越界）
    const safeIndex = Math.min(Math.max(frontIndex, 0), itemCount - 1);

    // 中卡条目（clamp 后取数；v11 固定画幅下几何与条目零耦合——只供内容
    // 渲染与操作卡定位）
    const frontItem = items[safeIndex];

    // 动画值：frontX = 中卡横滑（拖拽跟手 + 出卡滑出 + 回弹收口）；frontFade
    // = 中卡透明度乘法通道（常态恒 1）：唯一瞬态消费面 = 减弱动态转场的淡化
    // （v10 换张收口的前卡淡入已随自适应画幅退役，见 frontStyle /
    // finishAdvance 注）；左右各一组相纸归中
    // 通道（ty/rot/scale/opacity）恒挂两侧后卡槽——静止值 = 相纸位形基准，
    // 转场时对应组 spring 归中（不按 advance 条件切换样式挂载，任意重渲不
    // 重建 native 动画图，deck.tsx #9 教训）
    const frontX = useRef(new Animated.Value(0)).current;
    const frontFade = useRef(new Animated.Value(1)).current;
    const leftTy = useRef(new Animated.Value(DECK_BACK_DROP)).current;
    const leftRot = useRef(new Animated.Value(-DECK_BACK_ROTATE_DEG)).current;
    const leftScale = useRef(new Animated.Value(DECK_BACK_SCALE)).current;
    const leftOpacity = useRef(new Animated.Value(DECK_BACK_OPACITY)).current;
    const rightTy = useRef(new Animated.Value(DECK_BACK_DROP)).current;
    const rightRot = useRef(new Animated.Value(DECK_BACK_ROTATE_DEG)).current;
    const rightScale = useRef(new Animated.Value(DECK_BACK_SCALE)).current;
    const rightOpacity = useRef(new Animated.Value(DECK_BACK_OPACITY)).current;

    // 几何派生（v11 固定画幅：全部由列宽单点导出，与媒体内容零耦合；量取
    // 前 cardWidth ≤ 0 → 槽不渲染）：
    //   cardWidth = 中卡宽 = clamp(列宽 × 66%, 240 下限, 列宽 − 2×16 花瓣
    //       余量)——夹取序 = 比例 → 下限 → 上限（上限最后压：溢出防护 >
    //       体量下限）；
    //   cardHeight = 中卡高 = DECK_CARD_HEIGHT 420 固定常量（最小高下限并
    //       入固定值，前卡自然比例派生整轨撤销）；
    //   stripWidth = 中卡居中留白 = (列宽 − 中卡宽) / 2（仅 center 对齐档
    //       消费——默认 left/right 档卡 frame 贴列缘，见 cardLeft 注；
    //       上限/下限钳制下恒 ≥ 16dp ≥ 花瓣角点横向越出上界 9.3dp，见
    //       DECK_PETAL_MARGIN 注）；
    //   wedgeDepth = 相纸楔形带深 = 倾斜后卡最低点越过中卡底缘的量（几何
    //       精确解：后卡绕中心转 θ 后底缘最低点半高 = s/2·(H·cosθ + W·sinθ)，
    //       加下移 DROP，减中卡半高 H/2；v11 固定高下 H 恒 420，只随卡宽
    //       W 单调变化）——计数行锚定用它，不写 magic number。数值表
    //       （DROP 26 / s 0.96 / θ 4° / H 420）：
    //       W 240（下限钳制，列宽 272~363dp 常见）——25.6；
    //       W 283.8（430dp 列 66%）——27.1；
    //       W 409.2（620dp 列 66%）——31.3。
    //       全域 25.6~31.3 落在 25~33 参考带（固定高 420 后楔形反而比 v10
    //       横版档略浅、竖版档略深——H 项负贡献随 H 减小而减小，460→420
    //       仅加深 0.85dp），无越界无裁切，DROP 26 / ±4° 不调参；
    //   pileBand = 楔形带 + 呼吸缝（wedgeDepth 下限 24 兜极端防御：带 +
    //       计数行合计 ≥44 触达口径——固定几何下 wedge ≥ 25.6，下限不再
    //       触发，保留作防御）。
    const cardWidth =
        containerWidth > 0
            ? Math.min(
                  Math.max(containerWidth * DECK_FRONT_WIDTH_RATIO, DECK_CARD_MIN_WIDTH),
                  containerWidth - DECK_PETAL_MARGIN * 2,
              )
            : 0;
    const cardHeight = DECK_CARD_HEIGHT;
    const stripWidth = (containerWidth - cardWidth) / 2;
    // 中卡 frame 的横向锚点（对齐偏好消费点）：center = 原居中 strip；left =
    // 贴内容列左缘（left 0——与正文同列线，「不再居中」的反馈落点）；right =
    // 贴列右缘。夹取几何不变（cardWidth 只由列宽派生），flush 侧的相纸越出量
    // （旋转包围盒 ≤9.3dp，见 DECK_PETAL_MARGIN 注）会被容器 overflow-hidden
    // 裁掉角尖——靠边构图的固有代价，楔形主体（底缘露出带）完整呈现。
    const cardLeft =
        containerWidth > 0
            ? mediaAlign === 'left'
                ? 0
                : mediaAlign === 'right'
                    ? containerWidth - cardWidth
                    : stripWidth
            : 0;
    const backTiltRad = (DECK_BACK_ROTATE_DEG * Math.PI) / 180;
    const wedgeDepth =
        DECK_BACK_DROP -
        cardHeight * (0.5 - (DECK_BACK_SCALE / 2) * Math.cos(backTiltRad)) +
        ((cardWidth * DECK_BACK_SCALE) / 2) * Math.sin(backTiltRad);
    const pileBand = Math.max(wedgeDepth, 24) + DECK_COUNTER_GAP;

    useEffect(() => {
        // 挂载/列宽变化即锚定基准位（deck.tsx 同款防御：实例复用/Strict 下
        // 不残留旧值）；转场中不重设（收口 snap 按最新位形兜底）
        frontX.setValue(0);
        frontFade.setValue(1);
        if (advancingRef.current) return;
        leftTy.setValue(DECK_BACK_DROP);
        leftRot.setValue(-DECK_BACK_ROTATE_DEG);
        leftScale.setValue(DECK_BACK_SCALE);
        leftOpacity.setValue(DECK_BACK_OPACITY);
        rightTy.setValue(DECK_BACK_DROP);
        rightRot.setValue(DECK_BACK_ROTATE_DEG);
        rightScale.setValue(DECK_BACK_SCALE);
        rightOpacity.setValue(DECK_BACK_OPACITY);
    }, [
        frontX,
        frontFade,
        leftTy,
        leftRot,
        leftScale,
        leftOpacity,
        rightTy,
        rightRot,
        rightScale,
        rightOpacity,
    ]);
    // 转场 deadline 定时器随卸载清理（组解散/重挂不留悬挂收口）
    useEffect(
        () => () => {
            if (advanceTimerRef.current != null) clearTimeout(advanceTimerRef.current);
        },
        [],
    );

    // 索引轮转（收口帧提交）：函数式更新——不依赖渲染落地；组收缩按 itemsRef
    // clamp（转场窗口内增删安全）
    const rotateIndex = useCallback((dir: 1 | -1) => {
        setFrontIndex((current) => {
            const len = itemsRef.current.length;
            const safe = Math.min(Math.max(current, 0), len - 1);
            return (safe + dir + len) % len;
        });
    }, []);

    // 转场收口（ADVANCE_TOTAL_MS deadline 触发）：全值 snap 复位 + 清闩 +
    // 索引轮转，同一事件帧内全部落地（归中相纸终态与轮转后中卡静止帧像素
    // 恒等，复位换内容不可见——出卡此时已完全滑出 overflow-hidden 容器；
    // 三槽内容随轮转同帧重指派：v11 固定画幅下组高/三槽 frame 恒定，收口
    // 帧零 reflow——换张 = 纯内容重指派，几何与转场动画互不牵扯（丝滑的
    // 根本）；v10 的收口前卡淡入（掩盖比例 reflow）已随自适应画幅退役，
    // 可能的一帧垫边占位口径见组件注「收口内容重指派」）
    const finishAdvance = useCallback(
        (dir: 1 | -1) => {
            advanceTimerRef.current = null;
            // snap 前先停在飞动画，防其覆写复位值（出卡 timing 220ms 已结束）
            frontX.stopAnimation();
            frontX.setValue(0);
            // 透明度通道复位满值：减弱动态档的 1→0 淡化在此归位（快速连滑
            // 时淡化可能仍在飞，先停防覆写）。setValue(1) 与下方
            // setAdvance/rotateIndex 同一事件帧内发出（native 命令 FIFO 先
            // 于 React 提交落地），收口内容不会以半透明闪帧
            frontFade.stopAnimation();
            frontFade.setValue(1);
            // 左右两组通道全部 snap 回相纸位形基准（无论哪组在飞——复位幂等）
            leftTy.stopAnimation();
            leftTy.setValue(DECK_BACK_DROP);
            leftRot.stopAnimation();
            leftRot.setValue(-DECK_BACK_ROTATE_DEG);
            leftScale.stopAnimation();
            leftScale.setValue(DECK_BACK_SCALE);
            leftOpacity.stopAnimation();
            leftOpacity.setValue(DECK_BACK_OPACITY);
            rightTy.stopAnimation();
            rightTy.setValue(DECK_BACK_DROP);
            rightRot.stopAnimation();
            rightRot.setValue(DECK_BACK_ROTATE_DEG);
            rightScale.stopAnimation();
            rightScale.setValue(DECK_BACK_SCALE);
            rightOpacity.stopAnimation();
            rightOpacity.setValue(DECK_BACK_OPACITY);
            advancingRef.current = false;
            setAdvance(null);
            rotateIndex(dir);
        },
        [
            frontX,
            frontFade,
            leftTy,
            leftRot,
            leftScale,
            leftOpacity,
            rightTy,
            rightRot,
            rightScale,
            rightOpacity,
            rotateIndex,
        ],
    );

    // 转场起手（滑动/点楔形带提交共用同一条编排，见组件注「换位状态机」）：
    // dir 侧相纸四值 spring 归中（相纸 z 恒在中卡之下，不提层——静止重叠
    // 几何下提层会穿帮，「揭开」由出卡滑出让位承担）+ 中卡沿换位方向
    // timing 滑出列缘 + advancing 闩 + deadline 收口。
    // 归中相纸槽选择：N≥3 按方向取 dir 侧邻卡所在槽（内容 = 渲染派生值，
    // 本就在渲染中，零切换零闪）；N=2 恒右槽（左侧空无从归中，右卡内容即
    // 上一张——退化编排见组件注）。出卡 timing 起点即 frontX 当前值：滑动
    // 提交从拖拽位移续走、点楔形提交从 0 起走——总观感 = 旧卡沿换位方向
    // 滑走、底缘相纸「放平」归中补位。
    // 减弱动态（reduceMotionRef）：跳过位移/旋转编排，中卡 160ms 淡化收口
    // ——motion.md rule 14「弱化态 = 少而柔」，保留解释换张的 opacity 通道。
    const beginAdvance = useCallback(
        (dir: 1 | -1) => {
            const list = itemsRef.current;
            if (list.length < 2 || advancingRef.current) return;
            // 容器未量宽（不可达防御，卡可见即已量宽）：跳过动画直接轮转，
            // 拖拽值随手复位（不容残留位移）
            if (containerWidth <= 0) {
                frontX.stopAnimation();
                frontX.setValue(0);
                rotateIndex(dir);
                return;
            }
            advancingRef.current = true;
            setAdvance({ dir });
            // 透明度通道复位：上一轮减弱动态档的淡化可能仍在飞（快速连滑）
            // ——出卡层必须满透明度起步（减弱动态档随即自行 1→0 淡出，见
            // finishAdvance 注：通道现只剩减弱动态单一职责）
            frontFade.stopAnimation();
            frontFade.setValue(1);
            if (reduceMotionRef.current) {
                // 原位淡化（不重置 frontX——滑动提交时中卡停在拖拽位移处淡出，
                // 收口帧随内容交换 snap 归位，弱化态下零位移动画）
                frontFade.stopAnimation();
                Animated.timing(frontFade, {
                    toValue: 0,
                    duration: DECK_REDUCED_FADE_MS,
                    easing: Easing.out(Easing.cubic),
                    useNativeDriver: true,
                }).start();
                advanceTimerRef.current = setTimeout(() => finishAdvance(dir), DECK_REDUCED_FADE_MS + 10);
                return;
            }
            // 四值同参数 spring 归中（ty/rot 归零、scale/opacity 归 1）
            const springToCenter = (value: Animated.Value, toValue: number) =>
                Animated.spring(value, {
                    toValue,
                    friction: DECK_ENTER_FRICTION,
                    tension: DECK_ENTER_TENSION,
                    useNativeDriver: true,
                });
            if (dir === 1 || list.length < 3) {
                // 右相纸归中（下一张；N=2 的双向退化编排）
                Animated.parallel([
                    springToCenter(rightTy, 0),
                    springToCenter(rightRot, 0),
                    springToCenter(rightScale, 1),
                    springToCenter(rightOpacity, 1),
                ]).start();
            } else {
                // 左相纸归中（上一张）
                Animated.parallel([
                    springToCenter(leftTy, 0),
                    springToCenter(leftRot, 0),
                    springToCenter(leftScale, 1),
                    springToCenter(leftOpacity, 1),
                ]).start();
            }
            // 出卡（中卡层自身 = 出卡层，内容不换）沿换位方向 timing 220ms
            // 滑出列缘 + xFade 越缘区段同步降透明（索引在收口帧才轮转——
            // 中卡内容切换与复位同帧零闪）
            frontX.stopAnimation();
            Animated.timing(frontX, {
                toValue:
                    (dir === 1 ? -1 : 1) * (containerWidth + DECK_EXIT_MARGIN),
                duration: SWIPE_EXIT_MS,
                easing: DECK_EXIT_EASING,
                useNativeDriver: true,
            }).start();
            advanceTimerRef.current = setTimeout(() => finishAdvance(dir), ADVANCE_TOTAL_MS);
        },
        [
            frontX,
            frontFade,
            containerWidth,
            leftTy,
            leftRot,
            leftScale,
            leftOpacity,
            rightTy,
            rightRot,
            rightScale,
            rightOpacity,
            rotateIndex,
            finishAdvance,
        ],
    );

    // 滑动未过阈值 / 手势被夺：拖拽位移 spring 归位（索引不动，闩不介入——
    // 回弹中途可被下一轮拖拽接管）
    const springBack = useCallback(() => {
        Animated.spring(frontX, {
            toValue: 0,
            friction: DECK_SPRING_FRICTION,
            useNativeDriver: true,
        }).start();
    }, [frontX]);

    // 滑动提交：按拖拽方向取换位方向（左滑 = 下一张 / 右滑 = 上一张），编排
    // 全权交给 beginAdvance（出卡 timing 从当前拖拽位移续走，见其注）
    const commitSwipe = useCallback(
        (dx: number) => {
            beginAdvance(dx < 0 ? 1 : -1);
        },
        [beginAdvance],
    );

    // 点楔形带 = 切换到该侧（左半 = 上一张、右半 = 下一张，循环）：同一编排
    // （中卡滑出让位 + 相纸自底缘归中，见 beginAdvance 注）；转场期间闩吞
    // 并发点按（beginAdvance 内部检查）；useCallback 固定引用，Pressable
    // 不因重渲重配置 Pressability（#3 吞首点防御口径）
    const tapPrev = useCallback(() => beginAdvance(-1), [beginAdvance]);
    const tapNext = useCallback(() => beginAdvance(1), [beginAdvance]);

    // 横滑手势：onStart 不认领（点按/长按留给 Pressable 链），移动过方向锁
    // 才认领——认领即终止点按（拖拽期间不误开全屏，responder 仲裁免费获得）；
    // 转场期间闩吞并发手势（不认领新拖拽）；松手过阈值提交真转场、否则回弹；
    // 被系统夺走（来电/滚动接管）回弹归位。只用 transform，无布局动画
    //（Fabric/Expo Go 触摸链纪律，deck.tsx 同源教训）。
    const panResponder = useMemo(
        () =>
            PanResponder.create({
                onStartShouldSetPanResponder: () => false,
                onMoveShouldSetPanResponder: (_evt, gesture) =>
                    !advancingRef.current &&
                    Math.abs(gesture.dx) > SWIPE_LOCK_DX &&
                    Math.abs(gesture.dx) > Math.abs(gesture.dy) * SWIPE_LOCK_RATIO,
                onPanResponderGrant: () => {
                    // 打断在飞的收口动画：本轮拖拽位移由 event 的 dx 接管
                    //（快速连滑时从归位中途接管，跟手无弹簧打架）
                    frontX.stopAnimation();
                },
                // 拖拽跟手 = Animated.event 事件映射（JS responder 事件只能走
                // JS 通道，useNativeDriver: false 是 PanResponder 场景唯一合法
                // 值；native driver 由挂载方承担——frontX 挂在 native-driven
                // transform 上，setValue 经 native 节点直达 UI 线程）
                onPanResponderMove: Animated.event([null, { dx: frontX }], {
                    useNativeDriver: false,
                }),
                onPanResponderRelease: (_evt, gesture) => {
                    if (Math.abs(gesture.dx) > SWIPE_COMMIT_DX) commitSwipe(gesture.dx);
                    else springBack();
                },
                onPanResponderTerminate: springBack,
            }),
        [frontX, commitSwipe, springBack],
    );

    // 中卡动效样式（deck.tsx useSlotStyle 同款插值口径）：translateX + 透明
    // 度 = frontFade × xFade 五点插值（Animated.multiply）——xFade 中位 1 →
    // 列缘 DECK_DRAG_MIN_OPACITY（拖拽下限）→ 越缘区段续降到 0（出卡滑出
    // 与降透明共用同一条插值，不另立 fade 节点）；frontFade 常态恒 1、乘法
    // 恒等，唯一瞬态消费面 = 减弱动态转场淡化（前卡淡入已随 v10 自适应
    // 画幅退役，见组件注动画口径段 / finishAdvance 注）；插值
    // /乘法节点 useMemo 固定，仅列宽变化重建，任意重渲不重建 native 动画图
    //（deck.tsx #9 教训）
    const frontStyle = useMemo(
        () => ({
            transform: [{ translateX: frontX }],
            opacity:
                containerWidth > 0
                    ? Animated.multiply(
                          frontFade,
                          frontX.interpolate({
                              inputRange: [
                                  -(containerWidth + DECK_EXIT_MARGIN),
                                  -containerWidth,
                                  0,
                                  containerWidth,
                                  containerWidth + DECK_EXIT_MARGIN,
                              ],
                              outputRange: [0, DECK_DRAG_MIN_OPACITY, 1, DECK_DRAG_MIN_OPACITY, 0],
                              extrapolate: 'clamp',
                          }),
                      )
                    : 1,
        }),
        [frontX, frontFade, containerWidth],
    );

    // 相纸槽动效样式（恒挂左右两组归中通道；静止 = 相纸位形基准 ty 26 /
    // ±4° / scale 0.96 / opacity 0.85，转场 = 对应组 spring 归中；transform/
    // opacity 白名单键，deck 铁律）。transform 数组序 [ty, rot, scale] 语义
    // = RN 矩阵按序右乘（最后项先作用）：scale、rotate 围绕布局中心，translate
    // 是纯平移——下移量不随旋转偏斜（楔形几何推导依赖此序，见几何派生注）。
    // 旋转通道经 interpolate 出 'deg' 字符串（native 驱动旋转的文档口径），
    // 插值节点随样式 useMemo 固定
    const leftSlotStyle = useMemo(
        () => ({
            transform: [
                { translateY: leftTy },
                {
                    rotate: leftRot.interpolate({
                        inputRange: [-360, 360],
                        outputRange: ['-360deg', '360deg'],
                    }),
                },
                { scale: leftScale },
            ],
            opacity: leftOpacity,
        }),
        [leftTy, leftRot, leftScale, leftOpacity],
    );
    const rightSlotStyle = useMemo(
        () => ({
            transform: [
                { translateY: rightTy },
                {
                    rotate: rightRot.interpolate({
                        inputRange: [-360, 360],
                        outputRange: ['-360deg', '360deg'],
                    }),
                },
                { scale: rightScale },
            ],
            opacity: rightOpacity,
        }),
        [rightTy, rightRot, rightScale, rightOpacity],
    );

    // 卡槽 frame（deck.tsx 同款「静态几何全在普通 wrapper」铁律）：三槽同
    // 固定 frame（中卡/左右相纸同宽同高，left 锚定按对齐偏好：默认靠左贴列
    // 缘、center 居中、right 贴右缘），相纸位全由 transform 表达；几何只随
    // 列宽/对齐档变化（v11 固定画幅），换张零重建零重排
    const cardSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: 0,
            left: cardLeft,
            width: cardWidth,
            height: cardHeight,
        }),
        [cardLeft, cardWidth],
    );
    // 手势面 frame：满宽卡区（横滑起手覆盖中卡；底缘楔形带点按体 zIndex 4
    // 与本面纵向零重叠，见组件注层级段）；高 = 固定卡高（模块常量），恒定
    // 不重建
    const gestureSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: 0,
            left: 0,
            right: 0,
            height: cardHeight,
        }),
        // 依赖只有模块常量 DECK_CARD_HEIGHT，无组件态——恒定 memo
        [],
    );
    // 底缘楔形带点按体 frame：中卡 frame 以下的整条带（相纸楔形露出区 +
    // 计数行；命中区 = 带几何 ≥44dp 零 hitSlop，与中卡 frame 纵向零重叠，
    // 固定几何下带高 = pileBand + 计数行 ∈ 45.6~51.3dp）。
    // 左右对半分治（左 = 上一张 / 右 = 下一张）；N=2 时右区独占全带宽
    // （左侧无相纸），锚定边在 JSX 处给
    const bandPressSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: cardHeight,
            bottom: 0,
        }),
        // 依赖只有模块常量 DECK_CARD_HEIGHT，无组件态——恒定 memo
        [],
    );
    // 计数行 frame：楔形带之下——top = 中卡高 + 楔形带 + 呼吸缝（与相纸
    // 楔形渲染底不重叠），横向锚定**中卡两缘**（left/right 由 cardLeft 对齐
    // 锚点派生——页码跟着卡走，靠左构图下不脱锚到列缘）、内容右对齐（行落
    // 在中卡 frame 之内；alignItems 落实右对齐——页码语义锚在「下一张」侧，
    // 与右相纸楔形深端同侧收边，左侧楔形薄片不与计数行争读）
    const counterSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: cardHeight + pileBand,
            left: cardLeft,
            right: Math.max(0, containerWidth - cardWidth - cardLeft),
            height: DECK_COUNTER_LINE,
            alignItems: 'flex-end' as const,
        }),
        [pileBand, cardLeft, containerWidth, cardWidth],
    );

    // 防御性回退（置于全部 hook 之后：条件 return 不得跨越 hook 调用；
    // buildRenderUnits 保证 deck 单元 ≥2 块且同 kind，实际不可达，仅兜底
    // 防击穿）
    if (itemCount === 0) return null;
    if (itemCount === 1) {
        // 成组条件被并发变更击穿时按单块独立渲染（MediaBlock = 单媒体路径
        // 单点收口：图片自然比例 / 视频元数据比例 / 音频卡）
        return <MediaBlock media={items[0].media} durationMs={items[0].block.durationMs} />;
    }

    // 三槽取数（循环遍历）：左 = 上一张（N≥3 才有——2 张时 prev 与 next 同
    // 卡，左侧空、只有右侧相纸）、中 = 当前、右 = 下一张
    const leftItem = itemCount >= 3 ? items[(safeIndex - 1 + itemCount) % itemCount] : null;
    const rightItem = items[(safeIndex + 1) % itemCount];

    // 邻卡 URI 预热（v0.4.4 堆叠换张零占位帧的另一半）：换张后成为新前卡的
    // 邻卡提前 acquire（acquire 即 release——条目留会话缓存，引用计数 0 +
    // 延迟撤销），换 key 渲染期 peek 恒命中，前卡首帧就是真图（file-url-state
    // 的同步 ready 路径）。缩略图/大图共用同一会话缓存，预热零额外读取。
    const dataRevision = useDataRevision();
    useEffect(() => {
        if (leftItem) prewarmFileUrl(leftItem.media.file_key, dataRevision);
        if (rightItem) prewarmFileUrl(rightItem.media.file_key, dataRevision);
    }, [leftItem, rightItem, dataRevision]);

    return (
        <View
            className="relative overflow-hidden"
            style={
                cardWidth > 0
                    ? { height: cardHeight + pileBand + DECK_COUNTER_LINE }
                    : undefined
            }
            onLayout={(event) => {
                const width = event.nativeEvent.layout.width;
                // 亚像素抖动丢弃（旋转/分栏断点切换才有真实变化）
                setContainerWidth((current) =>
                    Math.abs(current - width) < 0.5 ? current : width,
                );
            }}
        >
            {/* 左相纸槽 = 上一张（zIndex 2 恒定，相纸恒在中卡之下——静止
                重叠几何下转场提层会穿帮，见组件注层级段）：普通 wrapper
                （静态几何 + pointerEvents none）→ AnimatedSlot（ty/rot/
                scale/opacity 恒挂 left 通道，静止 = 相纸位形基准 ty 26 +
                −4°，底缘楔形露在中卡之下、越出容器左缘部分被裁）→ 相纸
                卡体（图堆 = 真实邻图 DeckBackCard / 视频堆 = 无 player
                占位 DeckVideoBackCard，性能红线：露边层零 player）；
                N=2 不渲染（左相纸空缺，只有右侧） */}
            {cardWidth > 0 && leftItem ? (
                <View style={[cardSlot, { zIndex: 2 }]} pointerEvents="none">
                    <DeckAnimatedSlot style={[{ flex: 1 }, leftSlotStyle]}>
                        {/* 三槽按成员 kind 分支卡体（显式混合组允许图/视频/音频混排；
                            自然组恒同 kind）：图 = 真实邻图 / 视频 = 无 player 占位 /
                            音频 = 声纹占位（露边层零播放器零订阅，性能红线） */}
                        {leftItem.deckKind === 'video' ? (
                            <DeckVideoBackCard
                                key={leftItem.media.id}
                                media={leftItem.media}
                                width={cardWidth}
                                height={cardHeight}
                            />
                        ) : leftItem.deckKind === 'audio' ? (
                            <DeckAudioBackCard width={cardWidth} height={cardHeight} />
                        ) : (
                            <DeckBackCard
                                key={leftItem.media.id}
                                media={leftItem.media}
                                width={cardWidth}
                                height={cardHeight}
                            />
                        )}
                    </DeckAnimatedSlot>
                </View>
            ) : null}
            {/* 右相纸槽 = 下一张（zIndex 2 恒定，left 槽位形镜像 +4°）：right
                通道恒挂，转场时即归中卡卡体（图堆内容零切换本就渲染目标图；
                视频堆归中面 = 缩略图真封面/占位卡回退，前卡实体化在收口帧重挂完成） */}
            {cardWidth > 0 && rightItem ? (
                <View style={[cardSlot, { zIndex: 2 }]} pointerEvents="none">
                    <DeckAnimatedSlot style={[{ flex: 1 }, rightSlotStyle]}>
                        {rightItem.deckKind === 'video' ? (
                            <DeckVideoBackCard
                                key={rightItem.media.id}
                                media={rightItem.media}
                                width={cardWidth}
                                height={cardHeight}
                            />
                        ) : rightItem.deckKind === 'audio' ? (
                            <DeckAudioBackCard width={cardWidth} height={cardHeight} />
                        ) : (
                            <DeckBackCard
                                key={rightItem.media.id}
                                media={rightItem.media}
                                width={cardWidth}
                                height={cardHeight}
                            />
                        )}
                    </DeckAnimatedSlot>
                </View>
            ) : null}
            {/* 中卡层（zIndex 3，恒在相纸之上）：满宽普通 wrapper（PanResponder
                方向锁挂此，手势面 = 满宽卡区；静态布局 key 收口在内层中卡
                frame wrapper，deck 铁律）→ 中卡 frame wrapper → AnimatedSlot
                （flex:1 + translateX/frontFade×xFade，出卡滑出复用此层）→
                中卡卡体（图堆 DeckFrontCard / 视频堆 DeckVideoFrontCard
                封面态；点全屏 + 长按操作卡，既有链；转场期间 interactive
                闸关闭；触摸面零 className 收口在两卡体内）。视频前卡
                key = media.id：收口换张即重挂（旧 player 卸载释放 + 新
                player 挂载，防 replaceAsync 异步窗口的错内容闪帧，性能
                红线口径 = 每堆任意时刻 ≤1 player，见 DeckVideoFrontCard 注） */}
            <View style={[gestureSlot, { zIndex: 3 }]} {...panResponder.panHandlers}>
                <View style={cardSlot}>
                    <DeckAnimatedSlot style={[{ flex: 1 }, frontStyle]}>
                        {frontItem && cardWidth > 0 ? (
                            <>
                                {/* 前卡卡体按成员 kind 分支（图/视频既有 Deck 卡复用口径：
                                    点前卡按 kind 全屏——图 viewer / 视频全屏播放；音频 =
                                    AudioBlock 常驻操作面，deck 内直接播放/暂停） */}
                                {frontItem.deckKind === 'video' ? (
                                    <DeckVideoFrontCard
                                        key={frontItem.media.id}
                                        media={frontItem.media}
                                        width={cardWidth}
                                        height={cardHeight}
                                        interactive={advance == null && selection == null}
                                        onBlockAction={
                                            editable && selection == null
                                                ? () => onBlockAction(frontItem.block.id)
                                                : undefined
                                        }
                                    />
                                ) : frontItem.deckKind === 'audio' ? (
                                    <DeckAudioFrontCard
                                        key={frontItem.media.id}
                                        item={frontItem}
                                        width={cardWidth}
                                        height={cardHeight}
                                        interactive={advance == null && selection == null}
                                        dimmed={selection != null}
                                        onBlockAction={() => onBlockAction(frontItem.block.id)}
                                    />
                                ) : (
                                    <DeckFrontCard
                                        key={frontItem.media.id}
                                        media={frontItem.media}
                                        width={cardWidth}
                                        height={cardHeight}
                                        interactive={advance == null && selection == null}
                                        onBlockAction={
                                            editable && selection == null
                                                ? () => onBlockAction(frontItem.block.id)
                                                : undefined
                                        }
                                    />
                                )}
                                {/* 多选覆盖层（z-10 压住前卡：点按 = 切换选中，全屏/长按
                                    被屏蔽；角标 pointerEvents none 只作视觉）。触摸面零
                                    className（deck 铁律，见组件注）：覆盖层走 inline style。
                                    音频成员不可选：同位覆盖层仅吸收触摸（置灰在卡体上） */}
                                {selection ? (
                                    frontItem.deckKind === 'audio' ? (
                                        <Pressable
                                            style={SELECTION_OVERLAY_STYLE}
                                            accessibilityLabel="录音不参与本次勾选"
                                        />
                                    ) : (
                                        <>
                                            <Pressable
                                                style={SELECTION_OVERLAY_STYLE}
                                                onPress={() => selection.onToggle(frontItem.block.id)}
                                                accessibilityRole="button"
                                                accessibilityState={{
                                                    selected: selection.selectedIds.has(frontItem.block.id),
                                                }}
                                                accessibilityLabel={
                                                    selection.selectedIds.has(frontItem.block.id)
                                                        ? '取消选择这一张'
                                                        : '选择这一张'
                                                }
                                            />
                                            <SelectionCheck
                                                selected={selection.selectedIds.has(frontItem.block.id)}
                                            />
                                        </>
                                    )
                                ) : null}
                            </>
                        ) : null}
                    </DeckAnimatedSlot>
                </View>
            </View>
            {/* 底缘楔形带点按体（zIndex 4；透明纯命中面不遮相纸视觉）：中卡
                frame 以下的整条带（楔形露出区 + 计数行，带高 ≥44dp 零
                hitSlop，与中卡 frame 纵向零重叠）——点左半 = 上一张、点右半
                = 下一张（循环，转场期间闩吞并发）；N=2 单区全带宽 = 下一张
                （左相纸空缺） */}
            {cardWidth > 0 && leftItem ? (
                <Pressable
                    onPress={tapPrev}
                    style={[bandPressSlot, { zIndex: 4, left: 0, width: '50%' }]}
                    accessibilityRole="button"
                    accessibilityLabel="查看上一张"
                />
            ) : null}
            {cardWidth > 0 && rightItem ? (
                <Pressable
                    onPress={tapNext}
                    style={
                        leftItem
                            ? [bandPressSlot, { zIndex: 4, right: 0, width: '50%' }]
                            : [bandPressSlot, { zIndex: 4, left: 0, right: 0 }]
                    }
                    accessibilityRole="button"
                    accessibilityLabel="查看下一张"
                />
            ) : null}
            {/* 计数（current+1/N）：楔形带之下——top = 中卡高 + 楔形带 +
                呼吸缝（与相纸楔形渲染底不重叠），横向锚定中卡两缘、右对齐；
                堆后视觉净空 = 组 margin + 栈 gap 与堆前对称（节奏表 16dp），
                行高把三端文字行高差（±2px）吃进行内，不污染块间净空。
                muted 12px tabular-nums、无 pill chrome（克制口径）；
                pointerEvents none 不参与命中；无障碍语义 = 读屏直读计数
                （点按体拆为上一张/下一张两个，不再有单一「下一张」label 可
                并入） */}
            {cardWidth > 0 ? (
                <View pointerEvents="none" style={counterSlot}>
                    <Text
                        className="text-[12px] text-ink-muted dark:text-inkd-muted"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {`${safeIndex + 1}/${itemCount}`}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}

/** 块重排/删除的轻量反馈：位置变化时透明度脉冲一次（RN Animated，别过度）。
    Animated.View 的 opacity 动画在 web 上输出 will-change:opacity → 每个块
    各自成 stacking context：块内浮层（聚焦态 ⋯ 微钮）在本块内后渲染、天然
    盖过本块 TextInput；微钮已改为完全落在块边界内（#4），不再有跨块浮层，
    无需块级提层。 */
function BlockReveal({
    index,
    children,
}: {
    index: number;
    children: React.ReactNode;
}) {
    const opacity = useRef(new Animated.Value(1)).current;
    const prevIndex = useRef(index);
    useEffect(() => {
        if (prevIndex.current !== index) {
            prevIndex.current = index;
            // 先压低再抬回：脉冲语义 = "这块动过"，不喧宾夺主
            opacity.setValue(0.45);
            Animated.timing(opacity, {
                toValue: 1,
                duration: 160,
                useNativeDriver: true,
            }).start();
        }
    }, [index, opacity]);
    return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

/** 聚焦文本块的微型操作入口（⋯ 单粒）：默认零渲染（非聚焦不挂载），
    聚焦即挂载并 150ms 淡入（RN Animated，opacity——键盘场景 native driver
    合规），失焦即卸载回零渲染。位置 = 块内右上角（right-0 top-0），视觉盒
    完全在本块边界内，与上方媒体块角部零重叠（几何核算见 MICRO_BUTTON 注）；
    pointerEvents box-none：容器只让 ⋯ 本体接点，不遮正文点击。 */
function BlockMicroButton({ onPress }: { onPress: () => void }) {
    const palette = usePalette();
    // 挂载即淡入（组件只在聚焦态存在，无需显隐双态动画）
    const opacity = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        Animated.timing(opacity, {
            toValue: 1,
            duration: 150,
            useNativeDriver: true,
        }).start();
    }, [opacity]);
    return (
        <View pointerEvents="box-none" className="absolute right-0 top-0">
            <BouncyPressable
                onPress={onPress}
                // 上侧 0：命中区不越块顶（不偷上方媒体块可点边缘），几何核算见 MICRO_BUTTON 注
                hitSlop={{ top: 0, left: MICRO_SLOP, right: MICRO_SLOP, bottom: MICRO_SLOP }}
                scaleTo={0.86}
            >
                <Animated.View style={{ opacity }}>
                    <View
                        className="items-center justify-center rounded-full bg-ink-raised dark:bg-inkd-raised"
                        style={{ width: MICRO_BUTTON, height: MICRO_BUTTON }}
                        accessibilityRole="button"
                        accessibilityLabel="块操作"
                    >
                        <MoreIcon size={15} color={palette.secondary} strokeWidth={2.2} />
                    </View>
                </Animated.View>
            </BouncyPressable>
        </View>
    );
}

/**
 * 画布空白收键层的 blur 收口句柄（#K2）：屏层 Pressable（空白区 tap）经 ref
 * 调 dismissKeyboard——收键盘 + blur 当前聚焦段，防误触闸见其注。
 */
export type BlockEditorHandle = {
    dismissKeyboard(): void;
};

type BlockEditorProps = {
    blocks: JournalBlock[];
    mediaById: Map<string, JournalMediaRow>;
    editable: boolean;
    /** 需要聚焦的文本块 id（「+ 添加输入框」后自动续写；稳定 id 下标会漂移）。 */
    focusTextId?: string | null;
    /** 画布滚动协作句柄（#12/#12b 聚焦定位；屏层 useMemo 固定传入）。 */
    canvas?: EditorCanvasHandle;
    /**
     * 多选模式（合并堆叠 / 堆叠指定删除，屏层持有状态）：null = 未开启。开启
     * 时媒体块（图/视频就绪媒体）点按 = 切换选中（覆盖层屏蔽全屏/长按），音频
     * 置灰不可选，文本块由屏层以 editable=false 传入实现「选择优先」。
     * selectedIds 为**有序**清单的 Set 投影（合并保持选择顺序）。
     * selectableIds（可选，2026-11-11 堆叠「指定删除」模式新增）：可选成员白名
     * 单——省略 = 全部媒体可选（合并模式原口径）；传入时白名单外的媒体块**回
     * 常态渲染**（点按照常全屏查看，无选中覆盖层无死点），整组全不可选的堆叠
     * 单元同样回常态（selection 对该组不透传）。音频恒不可选（置灰口径不变）。
     */
    selection?: {
        selectedIds: ReadonlySet<string>;
        onToggle(blockId: string): void;
        selectableIds?: ReadonlySet<string>;
    } | null;
    /**
     * pending 占位块的落盘进度表（2026-11-08 进度可视化）：key = pending 占位
     * 块 id（store.mediaUploadProgress 注册表的 pending 键投影，屏层负责过滤
     * capture: 会话任务键），value = 0..1（100ms 节流帧）。有值的占位块以
     * 「进度环 + 保存中 N%」渲染；缺省/无值的保持 spinner（字节路径无进度拍，
     * 诚实降级）。引用恒等由屏层恒等键 memo 保证（会话任务进度帧不击穿画布）。
     */
    progressByPendingId?: Readonly<Record<string, number>>;
    onChange(blocks: JournalBlock[]): void;
    /** 文本块聚焦（屏层目前只借此清空待聚焦标记）。 */
    onFocusText?(id: string): void;
    /** 任一文本段失焦即存（配合防抖的双保险）。 */
    onBlurText?(): void;
    /** 请求弹出块操作卡（媒体长按/双击、文本聚焦 ⋯ 统一入口；屏层渲染浮层）。 */
    onRequestActionBlock?(blockId: string | null): void;
};

/**
 * 块操作卡（上移/下移/删除，浮层居中弹出）由**屏层**条件渲染（禁 RN Modal），
 * 不放编辑器内——编辑器深埋 ScrollView，内联遮罩只盖内容区且随滚动跑位；
 * 屏根 inset-0 才是真全屏 scrim（范式同 InsertMenu/拍摄/录音覆盖层）。
 * 手势入口在本组件（媒体长按/双击经 onBlockAction、文本聚焦 ⋯ 钮）。
 * 另 forwardRef 暴露 BlockEditorHandle（画布空白收键层的 blur 收口，#K2）。
 */
export const BlockEditor = forwardRef<BlockEditorHandle, BlockEditorProps>(function BlockEditor(
    {
        blocks,
        mediaById,
        editable,
        focusTextId,
        canvas,
        selection,
        progressByPendingId,
        onChange,
        onFocusText,
        onBlurText,
        onRequestActionBlock,
    },
    ref,
) {
    const palette = usePalette();
    // 聚焦中的文本块 id（驱动微型 ⋯ 钮显隐；媒体块手势由组件内长按/双击承担）
    const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
    // 当前聚焦段的 TextInput 实例（#K2 空白收键的 blur 收口依据）：聚焦上报
    // 登记实例、失焦上报按实例身份清除——快速换焦点时旧 blur 后到不清新聚焦
    // 段的引用（与 activeBlockId 的 #4 守卫同口径）
    const activeInputRef = useRef<React.ComponentRef<typeof TextInput> | null>(null);
    useImperativeHandle(
        ref,
        () => ({
            dismissKeyboard: () => {
                const input = activeInputRef.current;
                if (!input) return; // 防误触闸：无聚焦段时空点零动作
                // 同步清引用再 blur：双击第二击必然命中空闸（防连点抖动）
                activeInputRef.current = null;
                // Android 的 InputMethodManager 隐藏路径不派发 blur，先 dismiss
                // 兜底收键盘；再显式 blur 清聚焦态（⋯ 钮随 onBlur 卸载、占位符
                // 回归、失焦即存双通道照常）
                Keyboard.dismiss();
                input.blur();
            },
        }),
        [], // 闭包只引用稳定 ref，句柄终生不变
    );

    const updateText = (id: string, text: string) => {
        const next = blocks.map((block) =>
            block.id === id && block.t === 'p' ? { t: 'p' as const, id, text } : block,
        );
        onChange(next);
    };

    const isPending = (block: JournalBlock) =>
        block.t === 'media' && block.mediaId === PENDING_MEDIA_ID;

    // 空计划（唯一一段）= 落笔区（TextBlock 的 firstBlock 位），其余段落两行固定底起
    const isFreshNote = blocks.length === 1;

    /** 打开块操作卡前的统一动作：收键盘（键盘态浮层以收起后的窗口布局为准，
        与全屏查看器同一口径）。 */
    const openActionBlock = (blockId: string) => {
        Keyboard.dismiss();
        onRequestActionBlock?.(blockId);
    };

    // 渲染单元（纯派生，见 buildRenderUnits）：连续同 kind 媒体合并堆叠
    // （图片堆 / 视频堆，混排按 kind 分段），其余原样
    const units = buildRenderUnits(blocks, mediaById);
    /** 媒体块 margin 按邻居分档（节奏表派生值）：邻媒体 6dp / 邻文本 12dp。 */
    const mediaMargin = (neighbor: JournalBlock | undefined): number =>
        isMediaLike(neighbor) ? MEDIA_MARGIN_MEDIA : MEDIA_MARGIN_TEXT;
    /** 多选可选判定（指定删除模式白名单口）：省略 selectableIds = 全可选
     *  （合并模式原口径）；白名单外媒体块回常态渲染（见 selection prop 注）。 */
    const isSelectable = (blockId: string): boolean =>
        !selection?.selectableIds || selection.selectableIds.has(blockId);

    return (
        // 根栈 gap = 节奏表 blockToBlock（段↔段净间距；媒体块 margin 在块级叠加）
        <View style={{ gap: EDITOR_RHYTHM.blockToBlock }}>
            {units.map((unit) => {
                if (unit.kind === 'deck') {
                    const firstIndex = unit.items[0].index;
                    const lastIndex = unit.items[unit.items.length - 1].index;
                    // 组边界 margin 按组外邻居分档（与单媒体块同口径）；组内
                    // 层叠一体（deck 式无页间隙），节奏由组级 margin 承担。
                    // key = 组首块 id（稳定）：组内增删只 clamp/轮转不重挂全组；
                    // 组首块被删 → key 更替 → 重挂回第 1 块（明确语义）
                    const groupMargin = {
                        marginTop: mediaMargin(blocks[firstIndex - 1]),
                        marginBottom: mediaMargin(blocks[lastIndex + 1]),
                    };
                    // 指定删除模式（selectableIds）：组内无一可选（白名单外的
                    // 堆叠）→ selection 不透传给该组——组回常态渲染，点前卡
                    // 照常全屏查看（零死点零置灰）；组内有可选成员（指定删除
                    // 的目标堆叠 / 合并模式任意组）→ 原样透传（音频成员置灰
                    // 不可选，既有口径）
                    const deckSelection =
                        selection && unit.items.some((item) => isSelectable(item.block.id))
                            ? selection
                            : null;
                    return (
                        <BlockReveal key={unit.items[0].block.id} index={firstIndex}>
                            <View style={groupMargin}>
                                <MediaDeckStack
                                    items={unit.items}
                                    editable={editable}
                                    selection={deckSelection}
                                    onBlockAction={openActionBlock}
                                />
                            </View>
                        </BlockReveal>
                    );
                }
                const block = unit.block;
                const index = unit.index;
                if (block.t === 'p') {
                    const microVisible = editable && activeBlockId === block.id;
                    return (
                        <BlockReveal key={block.id} index={index}>
                            <View className="relative">
                                {/* 统一文本块（#3）：首段/续写段/+ 添加输入框段同一组件，
                                    差异只经 firstBlock（占位文案）/written（高度档）表达 */}
                                <TextBlock
                                    value={block.text}
                                    editable={editable}
                                    autoFocus={focusTextId === block.id}
                                    firstBlock={isFreshNote}
                                    canvas={canvas}
                                    onChange={(text) => updateText(block.id, text)}
                                    onInputFocus={(input) => {
                                        activeInputRef.current = input;
                                    }}
                                    onInputBlur={(input) => {
                                        // 实例身份守卫：快速换焦点时旧 blur 后到，
                                        // 不清新聚焦段的引用（#4 同口径）
                                        if (activeInputRef.current === input) {
                                            activeInputRef.current = null;
                                        }
                                    }}
                                    onFocus={() => {
                                        setActiveBlockId(block.id);
                                        onFocusText?.(block.id);
                                    }}
                                    onBlur={() => {
                                        // 失焦即隐（#4 非聚焦零渲染）：只清自己的 id——
                                        // 快速换焦点时 blur 后到，不误清新聚焦块
                                        setActiveBlockId((current) =>
                                            current === block.id ? null : current,
                                        );
                                        onBlurText?.();
                                    }}
                                />
                                {/* 聚焦态微型 ⋯ 钮（块操作卡入口）：块内右上角，与相邻
                                    媒体块角部零重叠（几何核算见 MICRO_BUTTON 注）；
                                    非聚焦零渲染，聚焦挂载 150ms 淡入 */}
                                {microVisible ? (
                                    <BlockMicroButton onPress={() => openActionBlock(block.id)} />
                                ) : null}
                            </View>
                        </BlockReveal>
                    );
                }
                const verticalMargin = {
                    marginTop: mediaMargin(blocks[index - 1]),
                    marginBottom: mediaMargin(blocks[index + 1]),
                };
                if (isPending(block))
                    return (
                        <PendingMediaBlock
                            key={block.id}
                            style={verticalMargin}
                            progress={progressByPendingId?.[block.id]}
                        />
                    );
                const media = mediaById.get(block.mediaId);
                if (!media) return null;
                // 多选模式（合并堆叠 / 堆叠指定删除）：可选媒体块点按 = 切换
                // 选中，全屏/长按被选中覆盖层屏蔽（absolute 后绘制在上，压住
                // MediaBlock 自身的 Pressability 链）；音频置灰不可选（同位吸收
                // 层吞触摸 + 0.55 降透明，inline style 不落条件类，既有口径）；
                // 白名单外媒体块（指定删除的目标堆叠之外）**不进多选分支**——
                // 落到下方常态渲染，点按照常全屏查看（零死点零置灰）；pending
                // 占位不参与（上方原样渲染）。文本块的多选屏蔽由屏层
                // editable=false 传入实现。
                if (selection && media.kind === 'audio') {
                    return (
                        <BlockReveal key={block.id} index={index}>
                            <View
                                className="relative"
                                style={[verticalMargin, { opacity: 0.55 }]}
                            >
                                <MediaBlock media={media} durationMs={block.durationMs} />
                                <Pressable
                                    style={SELECTION_OVERLAY_STYLE}
                                    accessibilityLabel="录音不参与本次勾选"
                                />
                            </View>
                        </BlockReveal>
                    );
                }
                if (selection && isSelectable(block.id)) {
                    const selected = selection.selectedIds.has(block.id);
                    return (
                        <BlockReveal key={block.id} index={index}>
                            <View className="relative" style={verticalMargin}>
                                <MediaBlock media={media} durationMs={block.durationMs} />
                                <Pressable
                                    style={SELECTION_OVERLAY_STYLE}
                                    onPress={() => selection.onToggle(block.id)}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected }}
                                    accessibilityLabel={selected ? '取消选择' : '选择'}
                                />
                                <SelectionCheck selected={selected} />
                            </View>
                        </BlockReveal>
                    );
                }
                return (
                    <BlockReveal key={block.id} index={index}>
                        <View className="relative" style={verticalMargin}>
                            {/* 块操作走组件内长按/双击（见 useBlockActionGestures）：
                                角落删除 chip 与浮出操作条已按 #1/#9 移除。
                                onBlockAction 保留 editable 条件挂接（非 BouncyPressable
                                onPress 面，不在 #3 恒挂接范围）：该回调的存在性参与
                                useBlockActionGestures 的手势解析（web 桌面双击消歧以
                                onBlockAction != null 为前提），恒挂接会让只读态单击进
                                全屏多等 320ms 消歧窗口——行为回归；且 editable 在本屏
                                会话内不翻转（收笔即返回、重开入口不在编辑屏），不存在
                                「状态翻转吞首点」窗口 */}
                            <MediaBlock
                                media={media}
                                durationMs={block.durationMs}
                                onBlockAction={
                                    editable ? () => openActionBlock(block.id) : undefined
                                }
                            />
                        </View>
                    </BlockReveal>
                );
            })}

            {/* 插入缝：媒体块与末段之间的提示线（只在编辑态且有媒体时出现；中性线，accent 不上 chrome） */}
            {editable && blocks.some((b) => b.t === 'media') ? (
                <View className="my-1 flex-row items-center gap-2 opacity-60">
                    <View className="h-px flex-1 bg-ink-rule dark:bg-inkd-rule" />
                    <LucidePlus size={11} color={palette.muted} />
                    <View className="h-px flex-1 bg-ink-rule dark:bg-inkd-rule" />
                </View>
            ) : null}
        </View>
    );
});

/**
 * 编辑器底部工具坞：[+] 圆钮 · 保存状态 · 字数 · 主行动。
 *
 * @deprecated journal 编辑屏已按 #1 沉浸化改为「罗盘 + 号」方案（底部清空，
 * 仅留 + 浮钮；保存状态/字数上 masthead；完成收笔进 + 选择器），本组件不再
 * 被其引用。保留导出供行程侧工具坞复用（ui/index.ts 出口未动）。
 */
export function EditorToolbar({
    editable,
    busy,
    saving,
    charCount,
    savedLabel,
    onInsert,
    primary,
}: {
    editable: boolean;
    busy: boolean;
    /** 防抖落库进行中（指示器：保存中… / 已保存） */
    saving?: boolean;
    charCount: number;
    savedLabel: string;
    /** 打开插入选择器（+ 号钮；录音/拍照/拍视频/相册由屏编排）。 */
    onInsert(): void;
    /** 右侧主行动（通常是「完成」收笔）。 */
    primary: React.ReactNode;
}) {
    // 只读态不渲染 + 钮（禁用灰钮 = 看起来坏掉的按钮，不呈现）
    const showTools = editable;
    const palette = usePalette();
    return (
        <View className="border-t border-ink-rule bg-ink-base/95 px-4 pb-2 pt-2 dark:border-inkd-rule dark:bg-inkd-base/95">
            <View className="flex-row items-center gap-3">
                {showTools ? (
                    <>
                        {/* + 号钮：56px 圆（近黑 primary-btn 口径、白 + 图标），
                            视觉 ≥44 不传 hitSlop；右邻为文本非按压体，无重叠核算项。
                            onPress 恒挂接 + disabled 显式传导（#3 条件置空显式化）：
                            busy 翻转瞬间条件置空会重配置 Pressability 吞首点；显式
                            disabled=true 不出按压反馈（禁用灰度由内层 opacity 承担），
                            可观察行为与置空一致 */}
                        <BouncyPressable onPress={onInsert} disabled={busy} scaleTo={0.88}>
                            <View
                                className={`h-14 w-14 items-center justify-center rounded-full ${busy ? 'opacity-40' : ''}`}
                                style={{ backgroundColor: palette.primaryBtn }}
                                accessibilityRole="button"
                                accessibilityLabel="插入内容"
                                accessibilityState={{ disabled: busy }}
                            >
                                <LucidePlus size={24} color={palette.onPrimaryBtn} strokeWidth={2.2} />
                            </View>
                        </BouncyPressable>
                        {/* 保存状态指示器（SaaS/Pajamas 规范：贴近内容、持续可见、不打断） */}
                        <Text
                            className={`text-[11px] ${
                                saving
                                    ? 'text-ink-muted dark:text-inkd-muted'
                                    : 'text-ink-accent dark:text-inkd-accent'
                            }`}
                        >
                            {saving ? '保存中…' : savedLabel}
                        </Text>
                    </>
                ) : null}
                <View className="flex-1" />
                <Text
                    className="mr-2 text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {charCount} 字
                </Text>
                {primary}
            </View>
        </View>
    );
}
