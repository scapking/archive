import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    Animated,
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
import { BouncyPressable, LucideImage, LucidePlay, LucidePlus, LucideVideo } from '@/core/icons';
import { MoreIcon } from './editor-icons';
import {
    FIELD_TONE_TEXT,
    INPUT_PLATFORM_PROPS,
    INPUT_TRANSPARENT_STYLE,
    fieldInputHeight,
    readContentHeight,
} from './field-input';
import {
    MEDIA_MAX_HEIGHT,
    MediaBlock,
    useBlockActionGestures,
} from './media-view';
import { usePalette } from './theme';
import { useFileUrlState } from './use-file-url';
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
 *   就绪媒体块 ≥2 合并为媒体堆（MediaDeckStack v8，Apple Photos Stacks 式印刷
 *   相纸隐喻）——连续图片 ≥2 = 图片堆，连续视频 ≥2 = 视频堆（新增）；图片视频
 *   混排按 kind 分段（视频打断图片串、图片打断视频串，各自成段成组）；音频不进
 *   堆叠。中卡 = 统一画幅 1:1 方形标准档（宽 = 列宽 66%，高按统一画幅派生 +
 *   MEDIA_MAX_HEIGHT 封顶，cover 裁切，居中构图；混分辨率组换张零形变，
 *   单张不成组仍走自然比例自适应）；上一张/下一张以
 *   「相纸」压在卡底：同 frame 微缩 0.96 + 下移 26 + ±4° 镜像倾斜 + 压暗
 *   0.85，底缘露出倾斜楔形（楔形的斜边 + 圆角 + 真实邻图内容是「另一张
 *   照片」的形状语法——轴向平行直条会被读作边框/chrome，v2/v3/v5 三版
 *   可读性翻车的同源根因；4dp raised 垫边 + 前卡 1px hairline 相框描边
 *   （照片 mat 装裱惯例）保证白底/同色照片在浅色页上的楔缘可辨，表面
 *   分层全靠 tone step，无阴影无渐变；露边层圆角挂卡体本体 rounded-card16，
 *   随缩放/位移/倾斜保持，不被容器裁成直角——见 DeckBackCard 注）；
 *   3 张起左右都有，2 张时只有右侧（左相纸空缺）；视频堆卡体差异（堆叠
 *   机制与图片堆完全同一套，见 MediaDeckStack 注）：前卡 = 封面态（paused
 *   首帧 + 中央播放钮，点前卡 = 全屏播放、长按 = 操作卡），**性能红线：
 *   底层露边层绝不挂载视频播放器**——露边层 = raised 底 + 中央播放 icon
 *   占位卡（schema 无缩略图列，不背逐卡首帧提取开销），只有前卡挂 player；
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
     *  journal-edit-screen 的报头容器与 ScrollView contentContainerStyle）。 */
    mastheadToFirstBlock: 24,
} as const;

/** 写过内容段的固定留白底高（收缩时「少缩一些、留固定空间」，用户口径）：
 *  一行 26dp 视觉局促，取两行 52dp 作固定底——内容超过后仍随内容自然生长
 *  （高度派生走 field-input 的 fieldInputHeight 单点实现），删空回两行底
 *  不回弹 72dp 大盒（避免编辑中高度抖动）。 */
const MIN_PARAGRAPH_HEIGHT = BODY_LINE_HEIGHT * 2;

/** 从未写过的空段最小高度（#2「追加输入框特别小和丑」修复）：空段的
 *  「落笔大盒」不再按「是否整篇唯一段」分档——凡是没写过字的空段（空笔记
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
/* 三端键盘输入适配（#12，一处 helper 收口）                             */
/* ------------------------------------------------------------------ */

/**
 * 画布滚动协作契约（#12）：屏层持有 ScrollView，编辑器聚焦段需要键盘补偿时
 * 借用。offsetRef 由屏层 onScroll 落最近滚动位置（写 ref，不触发渲染）。
 */
export type EditorCanvasHandle = {
    readonly ref: React.RefObject<ScrollViewInstance | null>;
    readonly offsetRef: React.RefObject<number>;
};

/** 可视区底缘的呼吸余量（窗口坐标口径；adjustResize 下窗口底 = 键盘上缘）。 */
const FOCUS_CLEARANCE = 24;
/** 键盘弹起后的量测延时：adjustResize 重排在键盘动画开始即生效，160ms 足以
 *  让重排后的布局落稳，再量测/落位一次到位。 */
const FOCUS_MEASURE_DELAY = 160;

/**
 * 聚焦段滚到可见（#12 三端口径唯一实现，Android 专用补偿）：
 * - iOS：画布 ScrollView automaticallyAdjustKeyboardInsets 原生补偿 → 跳过；
 * - Web：浏览器对 focus 目标有原生 scroll-into-view → 跳过；
 * - Android：adjustResize 整体重排但滚动位置不动，聚焦段（尤其「+ → 添加
 *   输入框」追加的末段）会被键盘盖住 → 延时后与画布可视区**同轮**
 *   measureInWindow（同一坐标系；Android 的 Dimensions window 高在部分机型
 *   不随 adjustResize 收缩，不可作基准），聚焦段底缘越过可视区即按越出量
 *   scrollTo。幂等：已可见零滚动，不扰动当前阅读位置。
 *
 * @returns 撤销句柄（卸载/再次聚焦时清理，防延时量测落在已卸载节点上）。
 */
export function scrollFocusedBlockIntoView(
    canvas: EditorCanvasHandle,
    input: React.ComponentRef<typeof TextInput> | null,
): () => void {
    if (Platform.OS !== 'android' || !input) return () => undefined;
    const timer = setTimeout(() => {
        const scroller = canvas.ref.current;
        if (!scroller) return;
        scroller.measureInWindow((_sx, sy, _sw, sh) => {
            // 0/NaN 防线：量测失败或重排未落地时不动滚动位置
            if (!Number.isFinite(sy) || !Number.isFinite(sh) || sh <= 0) return;
            const safeBottom = sy + sh - FOCUS_CLEARANCE;
            input.measureInWindow((_x, y, _width, height) => {
                if (!Number.isFinite(y) || !Number.isFinite(height)) return;
                if (y + height <= safeBottom) return;
                scroller.scrollTo({
                    y: Math.max(0, canvas.offsetRef.current + (y + height - safeBottom)),
                    animated: true,
                });
            });
        });
    }, FOCUS_MEASURE_DELAY);
    return () => clearTimeout(timer);
}

/** 占位文案（#3 内聚在统一组件，调用处不再各自传）：空白页引导 vs 续写。 */
const LEAD_PLACEHOLDER = '想到什么写什么，图片和录音随时插进来。';
const CONTINUE_PLACEHOLDER = '继续写…';

/**
 * 统一文本块（#3「输入框存在差异，改成统一大小组件」）：全屏所有段落——
 * 空笔记落笔区、续写段、+ 添加输入框段——唯一的 TextInput 实现。字号/行高/
 * 内边距/最小高度/占位符/自动增高/三端输入适配全部内聚（平台 props 与高度
 * 派生统一取自 field-input.tsx 的导出常量/helper——单点收口，画布不套容器
 * 盒），差异只允许经 props 显式表达：
 * - firstBlock：只决定占位文案（空笔记引导句 vs「继续写…」），不再决定高度；
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
}: {
    value: string;
    editable: boolean;
    /** 「+ 添加输入框」后的自动聚焦（屏层 focusTextId 驱动，变化即聚焦）；
     *  媒体插入已不自动建段，不再经此通道聚焦。 */
    autoFocus?: boolean;
    /** 落笔区位：整篇唯一段（空笔记）为 true——只切换占位文案档位。 */
    firstBlock?: boolean;
    /** 画布协作句柄：聚焦时请求滚动补偿（helper 内部带三端平台判定）。 */
    canvas?: EditorCanvasHandle;
    onChange(text: string): void;
    onFocus?(): void;
    onBlur?(): void;
}) {
    const palette = usePalette();
    const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
    // 写过标记（锁存）：挂载时已有内容（重开旧笔记）即为内容段；此后一旦
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
    // 滚动补偿任务句柄：卸载时撤销，防延时量测落在已卸载节点上
    const cancelScrollRef = useRef<(() => void) | null>(null);
    useEffect(() => () => cancelScrollRef.current?.(), []);
    /** 聚焦段滚到可见（Android；scrollFocusedBlockIntoView 内部做平台判定）。 */
    const scrollIntoView = () => {
        if (!canvas) return;
        cancelScrollRef.current?.();
        cancelScrollRef.current = scrollFocusedBlockIntoView(canvas, inputRef.current);
    };
    // 聚焦时序（#1.2 修复项）：追加段（「+ 添加输入框」）的布局提交后再
    // focus，避免焦点/键盘与布局 churn 竞态——挂载即聚焦会在 measure 完成
    // 前抢焦点，Android 上键盘位置与光标位错乱。autoFocus 由 false→true
    // 驱动（重排不换实例，同值重渲染不重复触发）。
    // canvas 为屏层 useMemo 固定对象，闭包捕获安全。
    useEffect(() => {
        if (!autoFocus) return;
        const raf = requestAnimationFrame(() => {
            inputRef.current?.focus();
            scrollIntoView();
        });
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollIntoView 依赖 canvas（稳定句柄）
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
                onFocus?.();
                scrollIntoView();
            }}
            onBlur={onBlur}
            onContentSizeChange={(event) => {
                // 自动增高：有效性（0/NaN 拒收）与取整在 readContentHeight 收口；
                // 同值守卫丢弃逐键同值触发，防无谓 re-render / layout 抖动
                const next = readContentHeight(event);
                if (next === null) return;
                setContentHeight((current) =>
                    current !== null && Math.abs(next - current) < 1 ? current : next,
                );
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

/** 媒体上传占位（虚线框 + spinner + 文案，与大厂上传态一致；卡片圆角与媒体块对齐）。 */
function PendingMediaBlock({ style }: { style?: object }) {
    const palette = usePalette();
    return (
        <View
            style={style}
            className="h-[132px] items-center justify-center gap-2 rounded-card border border-dashed border-ink-accent/40 bg-ink-accent-bg/40 dark:border-inkd-accent/40 dark:bg-inkd-accent-bg/40"
        >
            <ActivityIndicator color={palette.spinner} />
            <Text className="text-[12px] text-ink-secondary dark:text-inkd-secondary">
                正在上传…
            </Text>
        </View>
    );
}

/** 媒体邻接判定（pending 占位同为 t:'media'，天然计入多图节奏）。 */
const isMediaLike = (block: JournalBlock | undefined): boolean => block?.t === 'media';

/* ------------------------------------------------------------------ */
/* 连续同 kind 媒体堆叠（deck 式：渲染层合并，数据仍是独立块，分组是纯派生） */
/* ------------------------------------------------------------------ */

/** 媒体块变体（分组条目类型）。 */
type JournalMediaBlock = Extract<JournalBlock, { t: 'media' }>;

/** 可堆叠媒体种类：图片堆 / 视频堆（音频不进堆叠——音频卡是常驻操作面，
 *  无「换张」语义，堆叠只会破坏播放连续性）。 */
type DeckMediaKind = 'image' | 'video';

/** deck 组条目（块 + 媒体行 + 全局 index）。 */
type DeckItem = { block: JournalMediaBlock; media: JournalMediaRow; index: number };

/**
 * 堆叠成员资格：已就绪的图片/视频媒体块 → 返回媒体行与种类（供层渲染直接
 * 复用，免二次查表）；其余（文本/pending 占位/音频/媒体行缺失）返回 null。
 * pending 占位**不进堆叠也不被堆叠跨越**（占位是插入中瞬态，保持现有
 * 独立占位渲染；上传回填后自然并入/成组）。
 */
const asDeckMedia = (
    block: JournalBlock,
    mediaById: Map<string, JournalMediaRow>,
): { media: JournalMediaRow; kind: DeckMediaKind } | null => {
    if (block.t !== 'media' || block.mediaId === PENDING_MEDIA_ID) return null;
    const media = mediaById.get(block.mediaId);
    if (media == null) return null;
    return media.kind === 'image' || media.kind === 'video'
        ? { media, kind: media.kind }
        : null;
};

/**
 * 渲染单元：单块（现有独立渲染路径）或连续同 kind 媒体堆叠组（≥2 才成组）。
 * 分组规则：**连续相邻且同 kind** 的就绪媒体块（index 相邻、中间无文本/
 * 异 kind 媒体/音频/pending 打断）合并——连续图片 ≥2 = 图片堆，连续视频
 * ≥2 = 视频堆；图片视频混排按 kind 分段（视频打断图片串、图片打断视频串，
 * 各自成段）；单张（同段只 1 块）维持独立渲染（单元回退为 single）。
 */
type RenderUnit =
    | { kind: 'single'; block: JournalBlock; index: number }
    | { kind: 'deck'; mediaKind: DeckMediaKind; items: DeckItem[] };

/**
 * 块列表 → 渲染单元（纯函数，每次渲染重算——组随块增删/移动自动重算/解散，
 * 「组内单删后剩 1 块回独立渲染」由此免费获得，零额外状态）。
 */
function buildRenderUnits(
    blocks: JournalBlock[],
    mediaById: Map<string, JournalMediaRow>,
): RenderUnit[] {
    const units: RenderUnit[] = [];
    let group: DeckItem[] | null = null;
    // 当前组的 kind（组内同 kind 铁律；异 kind 媒体/非成员块到达即 flush 换段）
    let groupKind: DeckMediaKind | null = null;
    const flushGroup = () => {
        if (!group || groupKind == null) return;
        if (group.length >= 2) {
            units.push({ kind: 'deck', mediaKind: groupKind, items: group });
        } else {
            // 成组未满 2 块：回退现有独立渲染路径（单张 = 单元）
            for (const item of group) {
                units.push({ kind: 'single', block: item.block, index: item.index });
            }
        }
        group = null;
        groupKind = null;
    };
    blocks.forEach((block, index) => {
        const member = asDeckMedia(block, mediaById);
        // block.t 判定收窄块类型（asDeckMedia 内部同口径，此处显式写出
        // 供 TS 收窄进组条目）；行缺失/音频/pending 落 single 路径
        if (block.t === 'media' && member != null) {
            if (group && groupKind === member.kind) {
                // 不变量：group 非空 ⟹ 上一块同为就绪同 kind 媒体块（非成员
                // 块与异 kind 块在上一轮已 flush），「相邻 index」天然成立，
                // 无需再查邻居
                group.push({ block, media: member.media, index });
            } else {
                // 首块入组 / kind 切换（视频打断图片串、图片打断视频串）：
                // 旧段收口，新段起组
                flushGroup();
                group = [{ block, media: member.media, index }];
                groupKind = member.kind;
            }
            return;
        }
        flushGroup();
        units.push({ kind: 'single', block, index });
    });
    flushGroup();
    return units;
}

/** deck 槽位动画容器（deck.tsx AnimatedSlot 同款）：模块级创建——组件级
 *  createAnimatedComponent 会在每次渲染重建 native 组件（整槽重挂），是
 *  手势窗口内的原生层扰动源（deck.tsx #9 同源教训）。 */
const DeckAnimatedSlot = Animated.createAnimatedComponent(View);

/* ------------------------------------------------------------------ */
/* 媒体堆（相纸堆 v8）中卡档位、后卡位形与转场常量（一处收口）           */
/* ------------------------------------------------------------------ */

/**
 * 中卡宽档位（列宽比例，62-70% 档取 66% 中值）：中卡 = 统一画幅 1:1 方形
 * 标准档（高 = 宽 ÷ DECK_UNIFORM_RATIO、MEDIA_MAX_HEIGHT 封顶），居中构图
 * （用户认可保留项）；两侧留白由相纸堆的留白节奏承担（见 MediaDeckStack 注）。
 */
const DECK_FRONT_WIDTH_RATIO = 0.66;

/**
 * 堆叠组统一画幅（1:1 方形标准档）：组内三槽（中卡/左右相纸）共用同一
 * 宽高比 + cover 裁切，混合分辨率（横版 + 竖版等）换张零 reflow 零
 * 形变——v7 按中卡图自然比例派生组高，换张（索引轮转）时组高随新图比例
 * 跳变，混分辨率组的「翻页」全程在变形。取值 = 1（用户反馈 4:3 横版
 * 偏矮「堆叠容器长一些」，改取方形档：同宽下组高 +33%，横竖媒体在方形
 * frame 里 cover 裁切量也最均衡）；桌面列呈现核对：画布列 max-w 620dp
 * → 中卡 409.2dp < MEDIA_MAX_HEIGHT 420，**封顶不触发**（封顶只在列宽
 * > 636.4dp 的假想列才生效，届时 420×420 楔形 31.2dp 仍在区间）；**单张
 * 不成组保持自然比例自适应不变**（MediaImage/MediaBlock 路径零改动），
 * 统一画幅只约束堆叠组。
 */
const DECK_UNIFORM_RATIO = 1;

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
 *  4dp 与相纸装裱的常规留白档一致（照片 mat 惯例）。外层 rounded-card
 *  overflow-hidden 裁切，内图零圆角（不新增半径档位）。 */
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

/**
 * 堆叠中卡（图片堆变体）：几何由 MediaDeckStack 数值化后传入显式宽高
 * （统一画幅 + MEDIA_MAX_HEIGHT 封顶——组高与点按体 frame 都依赖数值高，
 * 不借助 yoga 的 aspectRatio 收敛，cover 裁切结果与 yoga 口径恒等）。交互
 * 链 = 既有口径：点按 → requestViewer 全屏（键盘先收）、长按/桌面双击 →
 * onBlockAction 操作卡（useBlockActionGestures 单点收口）。横滑拖拽不在
 * 此层——PanResponder 挂在宿主手势面 wrapper（见 MediaDeckStack 注：父级
 * 方向锁认领后 responder 仲裁自然终止点按）。触摸面零 className（deck
 * 触摸面纯净铁律：按压体不落 className，防 css-interop 按压 observable
 * 注入手势窗口）。视频堆前卡 = DeckVideoFrontCard（同 frame/同描边/同
 * 手势链的封面态变体，见其注）。
 */
function DeckFrontCard({
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
                定）。border-box 下内图显式宽高溢出 content box ≤2px 被
                overflow-hidden 裁切，cover 裁切语义内不可感知。 */}
            <View
                className="overflow-hidden rounded-card border border-ink-border bg-ink-raised dark:border-inkd-border dark:bg-inkd-raised"
                style={{ width, height }}
            >
                {ready ? (
                    <Image source={{ uri }} style={{ width, height }} resizeMode="cover" />
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

/**
 * 相纸卡体（底缘后卡，图片堆露边层）：与中卡同尺寸的整卡渲染（同 frame +
 * cover 裁切，楔形露出的是真实相邻图内容、不是窄边条占位），位形（下移/
 * 倾斜/微缩/压暗）由宿主层的 AnimatedSlot 恒挂通道施加——静止时底缘楔形
 * 露在中卡之下（z 恒在中卡之下）；转场时它即归中卡体（位形 spring 归零
 * 由宿主 AnimatedSlot 驱动，随中卡滑出让位逐步揭开）。
 * **露边层圆角不变量（卡体本体挂 rounded-card16）**：圆角挂在后卡自身的
 * View 上，transform（微缩/下移/倾斜）作用于已带圆角的层——圆角随缩放/
 * 位移/倾斜保持（RN 的 borderRadius 属层自身绘制，先圆角后变换），不被
 * 任何容器 overflow-hidden 裁成直角缘；容器 overflow-hidden 只承担列缘
 * 出血裁切（横滑出卡/楔形越缘），几何上露出区距容器底缘 ≥ 缝 + 计数行
 * ≈ 20dp（见 MediaDeckStack 几何注），底缘圆角完整呈现，与中卡圆角
 * 同档（rounded-card 16）。
 * 4dp raised 垫边（DECK_MAT）= 相纸的「纸缘」tone step：白底照片的楔缘
 * 在浅色页上也可辨（taste-skill：表面分层靠 tone step 不靠线；#13 无描边
 * 口径的延伸——垫边是容器底色透出，不是 border 线）；外层 rounded-card
 * overflow-hidden 裁切，内图零圆角（不新增半径档位）。
 * 零交互纯视觉，无按压体：点按命中由宿主的底缘楔形带点按体承担（视觉面
 * 与命中面分离——双按压体叠命中区只会互相抢）；图片未就绪时保持 raised
 * 占位底（楔形带放不下失败文案，加载态即垫边色）。
 */
function DeckBackCard({
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
            style={{ width, height, padding: DECK_MAT }}
        >
            {status === 'ready' && uri ? (
                <Image
                    source={{ uri }}
                    style={{ width: width - DECK_MAT * 2, height: height - DECK_MAT * 2 }}
                    resizeMode="cover"
                />
            ) : null}
        </View>
    );
}

/**
 * 堆叠中卡（视频堆前卡，MediaVideo 封面态的 deck frame 变体）：paused 首帧
 * + 中央播放钮（黑透圆底白三角，与 MediaVideo 同口径），点前卡 → 全屏播放
 * （requestViewer kind video，全屏内 native controls）、长按/桌面双击 →
 * 操作卡——手势链/交互闸/hairline 描边与 DeckFrontCard 完全同构（useBlock
 * ActionGestures 单点收口 + interactive 转场闸 + mat 描边）。
 *
 * 为何不复用 MediaVideo 导出：其布局契约是 w-full + aspectRatio/maxHeight
 * （自然比例自适应），而 deck 前卡需要宿主数值化的统一画幅显式 frame；且
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
 * contentFit 恒 cover：统一画幅显式 frame + cover 裁切（与图片前卡同构，
 * 横竖视频零信箱条）；不做自然尺寸探测（deck frame 不依赖媒体比例，
 * useVideoNaturalSize 无必要）。
 * 触摸面纪律与 DeckFrontCard 相同：VideoView 包 core View pointerEvents=
 * "none"（expo-video 原生层吞触摸，#2b 同口径），按压统一走外层
 * BouncyPressable；触摸面零 className。
 */
function DeckVideoFrontCard({
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
                style={{ width, height }}
            >
                {ready ? (
                    <>
                        {/* 封面帧：paused 首帧，nativeControls=false；触摸层 =
                            core RN View 包装（pointerEvents="none"，#2b 见组件注） */}
                        <View className="flex-1" pointerEvents="none">
                            <VideoView
                                player={player}
                                nativeControls={false}
                                contentFit="cover"
                                style={{ flex: 1, backgroundColor: palette.raised }}
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

/**
 * 相纸卡体（视频堆露边层）：**无 player 的轻量占位卡**——性能红线的落地面。
 * 取舍（媒体域约束下三选一）：media-view 不新增「无 player 封面变体」导出
 * （本组只允许改 editor.tsx，media-view.tsx 不可动）；schema 无缩略图列，
 * 逐卡生成首帧图要背异步 IO + 缓存生命周期（#2b 注否决过的方案不回潮）——
 * 故自绘占位：raised 底 + 居中播放钮占位（黑透圆底白三角，尺寸/位置与
 * DeckVideoFrontCard 的中央播放钮同规格）。
 * 对位细节：占位钮与前卡真实封面态的钮**同位同尺寸**——收口换张时占位卡
 * 归中 → 前卡重挂（新 player 首帧就绪前同为 raised 底），钮像素恒位，
 * 「揭开 → 实体化」读感连续，无钮位跳变。
 * 圆角不变量与 DeckBackCard 同款（露边层铁律）：rounded-card16 挂卡体本体，
 * transform 后依然保持，不被容器裁成直角；mat 垫边同 DECK_MAT（视频占位
 * 面与垫边同 tone——垫边承担「纸缘」语义于图堆，视频堆楔形以形状语法
 * （倾斜 + 圆角）分层，tone 差由 raised vs 页底承担）。
 * 零交互、零媒体状态订阅（不挂 useFileUrlState——露边层连 url 状态都不背，
 * 楔形带放不下失败文案，媒体缺失态由前卡在归中后呈现）。
 */
function DeckVideoBackCard({ width, height }: { width: number; height: number }) {
    return (
        <View
            className="overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
            style={{ width, height, padding: DECK_MAT }}
        >
            <View className="flex-1 items-center justify-center">
                <View className="h-12 w-12 items-center justify-center rounded-full bg-black/40">
                    <LucidePlay size={20} color="#FFFFFF" strokeWidth={2.2} />
                </View>
            </View>
        </View>
    );
}

/**
 * 连续同 kind 媒体堆（v8 相纸堆：居中统一画幅中卡 + 底缘倾斜相纸 + 归中真
 * 转场）。设计语言由 design skill 结论主导（候选方向与条款依据见本组设计
 * 决策书）：**Apple Photos Stacks 式「印刷相纸」隐喻**——堆叠的可读性来自
 * 形状语法（倾斜楔形 + 圆角 + 邻卡内容），不来自露边宽度（v2 44dp 侧缘直条
 * / v3 底缘直条 / v5 16:10 窄边三版翻车同源：轴向平行直条读作 chrome，
 * 不读作另一张照片）。
 *
 * **图片堆 / 视频堆同一套机制（单组件参数化，零复制）**：几何/位形/转场/
 * 手势/计数对两种 kind 完全同构，差异只在三槽的卡体渲染——
 *   图片堆：前卡 DeckFrontCard（Image 封面）+ 露边层 DeckBackCard（真实
 *     邻图内容，楔形有内容线索）；
 *   视频堆：前卡 DeckVideoFrontCard（封面态，仅此卡挂 player，点前卡 =
 *     全屏播放）+ 露边层 DeckVideoBackCard（raised 底 + 中央播放 icon
 *     占位卡，**绝不挂载视频播放器**——性能红线，见其注；schema 无缩略
 *     图列，楔形露 tone 不露内容，形状语法承担可读性）；收口换张前卡按
 *     media.id 重挂（player 随内容轮转重建，避免 replaceAsync 异步窗口的
 *     错内容闪帧，见 DeckVideoFrontCard 注）。
 *
 * 几何（组容器 relative overflow-hidden，宽 = 列宽 onLayout 量取，高 =
 * 中卡高 + 相纸楔形带 + 计数行；overflow-hidden 是横滑与楔形「部分可见」
 * 的实现基础——楔形越出容器缘的部分与滑出的出卡都被列缘裁切，不出血到
 * 画布留白；露边层圆角不靠容器：rounded-card16 挂卡体本体、随 transform
 * 保持，露出区距容器底缘 ≥ 缝 + 计数行 ≈ 20dp 不会被裁成直角）：
 *   中卡：宽 C = 列宽 × 66%（62-70% 档中值，居中 frame left = 列宽×17%），
 *       高 = min(C ÷ DECK_UNIFORM_RATIO, MEDIA_MAX_HEIGHT)——**堆叠组统一
 *       画幅 1:1 方形标准档**（显式数值宽高 + cover 裁切，组高与点按体
 *       frame 都依赖数值高；桌面列核对：列 max-w 620dp → 中卡 409.2dp <
 *       420 封顶不触发）。统一画幅是混分辨率修复面：v7 按中卡自然比例
 *       派生组高，混合组换张（索引轮转）时组高随新卡比例跳变、全程变形；
 *       组内三槽共用同一画幅后换张零 reflow 零形变（相纸/中卡同 frame 的
 *       前提也由此恒成立）。**单张不成组保持自然比例自适应**（MediaImage /
 *       MediaBlock 路径零改动），统一画幅只约束堆叠组；
 *   后卡（相纸）：与中卡同 frame，位形 = 微缩 0.96 + 下移 26 + 左 −4°/
 *       右 +4° 镜像倾斜（transform 数组序 [ty, rot, scale] = 缩放、旋转
 *       围绕布局中心，translate 纯平移——下移量不随旋转偏斜）；左右镜像
 *       成扇，底缘露出倾斜楔形，最低点越过中卡底缘的量按几何精确解：
 *         wedgeDepth = DROP − H·(0.5 − s/2·cosθ) + (W·s/2)·sinθ
 *       （1:1 方形画幅下随列宽单调派生：312dp 列 ≈ 28.5、342dp 列 ≈ 28.8、
 *       430dp 列 ≈ 29.5、桌面 620dp 全宽列 ≈ 31.0，全部落在 25~33dp 目标
 *       区间——4:3 旧档桌面 33.2 的 +0.2 容差项随方形画幅消除；H = W 使
 *       H·(0.5 − s/2·cosθ) 项增大、W·sinθ 项同步增长，净深略降——pileBand
 *       按派生值收口无重叠无裁切）；N=2 时左槽不渲染（只有右侧相纸，
 *       左侧空——单楔形 + 单点按区，退化优雅）；
 *   垫边：后卡图内收 4dp 露 raised（相纸「纸缘」tone，白图浅页可辨）；
 *   前卡描边：1px hairline（ink-border/inkd-border）——照片「卡纸装裱」
 *       （mat）语义，照片本体惯例非卡片级 chrome（#13 口径不变），相近
 *       色调前后卡叠放时的恒定轮廓线（详见 DeckFrontCard/DeckVideoFrontCard
 *       注）；
 *   计数行：楔形带之下（top = 中卡高 + max(wedgeDepth, 24) + 2——下限
 *       兜极窄列，楔形带 + 计数行合计 ≥44 触达口径），横向锚定中卡两缘、
 *       右对齐，与楔形渲染零重叠。
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
 *   终态与轮转后中卡静止帧像素恒等；视频堆归中面 = 占位卡，重挂后 raised
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
 *   注）、露边层内容零切换（占位卡无媒体状态）；统一画幅下三槽 frame 与
 *   组高恒定，收口帧零 reflow；
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
 * 乘法节点随列宽变化同批重建）——frontFade 常态恒 1，仅供系统「减弱
 * 动态」转场使用：AccessibilityInfo reduceMotion 开启时转场退化为 160ms
 * 中卡淡化收口（无位移无旋转，motion.md rule 14「弱化态 = 少而柔，保留
 * 解释状态变化的 opacity 通道」；animate-expo：reduced motion 与动画
 * 同时交付，不是后续补丁）。
 *
 * 性能口径：图片堆任意 N 最多挂载 3 个图片实例（左/中/右三槽，N=2 恒
 * 2 个），转场不增实例（无第四渲染位——归中相纸复用本槽渲染位，内容零
 * 切换）；视频堆每堆仅前卡挂 1 个 player 实例、露边层零 player（raised +
 * 播放 icon 占位卡，连媒体状态订阅都不挂），收口换张 = 旧 player 卸载
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
    mediaKind,
    editable,
    onBlockAction,
}: {
    items: DeckItem[];
    /** 堆种类（buildRenderUnits 按 kind 分段保证组内同 kind；图/视频只
     *  差异化三槽卡体，堆叠机制同一套——见组件注）。 */
    mediaKind: DeckMediaKind;
    editable: boolean;
    /** 请求弹出当前中卡的块操作卡（屏层渲染，作用于该块）。 */
    onBlockAction(blockId: string): void;
}) {
    const itemCount = items.length;
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

    // 中卡条目（clamp 后取数；统一画幅下几何只由列宽派生，条目只供内容
    // 渲染与操作卡定位）
    const frontItem = items[safeIndex];

    // 动画值：frontX = 中卡横滑（拖拽跟手 + 出卡滑出 + 回弹收口）；frontFade
    // = 减弱动态专用的交叉淡化通道（常态恒 1，乘进中卡透明度，见 frontStyle
    // 注）；左右各一组相纸归中通道（ty/rot/scale/opacity）恒挂两侧后卡槽
    // ——静止值 = 相纸位形基准，转场时对应组 spring 归中（不按 advance 条件
    // 切换样式挂载，任意重渲不重建 native 动画图，deck.tsx #9 教训）
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

    // 几何派生（全部由列宽 + 统一画幅单点导出；量取前 cardWidth 为
    // 0 → 槽不渲染）：
    //   cardWidth = 中卡宽 = 列宽 × 66%（62-70% 档中值，居中）；
    //   deckHeight = 中卡高 = min(中卡宽 ÷ DECK_UNIFORM_RATIO, MEDIA_MAX_HEIGHT)
    //       ——统一画幅 1:1 方形（显式数值宽高 + cover 裁切，组高与点按体
    //       frame 都依赖数值高）。不随中卡媒体自然比例变化 → 换张（索引轮
    //       转）组高恒定，混合分辨率组的转场全程零 reflow 零形变（v7 按自
    //       然比例派生，换张单次 reflow 是混分辨率组的变形根因）；桌面列
    //       max-w 620dp → 409.2dp < 420，MEDIA_MAX_HEIGHT 封顶不触发；
    //   stripWidth = 中卡居中留白 = (列宽 − 中卡宽) / 2（中卡 frame 锚定）；
    //   wedgeDepth = 相纸楔形带深 = 倾斜后卡最低点越过中卡底缘的量（几何
    //       精确解：后卡绕中心转 θ 后底缘最低点半高 = s/2·(H·cosθ + W·sinθ)，
    //       加下移 DROP，减中卡半高 H/2）——计数行锚定用它，不写 magic
    //       number（画幅/列宽变化自适应）；1:1 画幅下楔形深度随列宽单调、
    //       手机画幅区间 28.5~29.5dp、桌面 620dp 列 31.0dp（几何核对表见
    //       组件注，全区间 25~33dp 达标）；
    //   pileBand = 楔形带 + 呼吸缝（wedgeDepth 下限 24 兜极窄列：带 +
    //       计数行合计 ≥44 触达口径）。
    const cardWidth = containerWidth * DECK_FRONT_WIDTH_RATIO;
    const deckHeight =
        cardWidth > 0 ? Math.min(cardWidth / DECK_UNIFORM_RATIO, MEDIA_MAX_HEIGHT) : 0;
    const stripWidth = (containerWidth - cardWidth) / 2;
    const backTiltRad = (DECK_BACK_ROTATE_DEG * Math.PI) / 180;
    const wedgeDepth =
        DECK_BACK_DROP -
        deckHeight * (0.5 - (DECK_BACK_SCALE / 2) * Math.cos(backTiltRad)) +
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
    // 三槽内容随轮转同帧重指派，统一画幅下组高/三槽 frame 恒定零 reflow，
    // 可能的一帧垫边占位口径见组件注「收口内容重指派」）
    const finishAdvance = useCallback(
        (dir: 1 | -1) => {
            advanceTimerRef.current = null;
            // snap 前先停在飞动画，防其覆写复位值（出卡 timing 220ms 已结束）
            frontX.stopAnimation();
            frontX.setValue(0);
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
    // 恒等，仅供减弱动态转场的 160ms 淡化使用（见组件注动画口径段）；插值
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
    // frame（中卡/左右相纸同宽同高，left 锚定中位居中），相纸位全由
    // transform 表达
    const cardSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: 0,
            left: stripWidth,
            width: cardWidth,
            height: deckHeight,
        }),
        [stripWidth, cardWidth, deckHeight],
    );
    // 手势面 frame：满宽卡区（横滑起手覆盖中卡；底缘楔形带点按体 zIndex 4
    // 与本面纵向零重叠，见组件注层级段）
    const gestureSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: 0,
            left: 0,
            right: 0,
            height: deckHeight,
        }),
        [deckHeight],
    );
    // 底缘楔形带点按体 frame：中卡 frame 以下的整条带（相纸楔形露出区 +
    // 计数行；命中区 = 带几何 ≥44dp 零 hitSlop，与中卡 frame 纵向零重叠）。
    // 左右对半分治（左 = 上一张 / 右 = 下一张）；N=2 时右区独占全带宽
    // （左侧无相纸），锚定边在 JSX 处给
    const bandPressSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: deckHeight,
            bottom: 0,
        }),
        [deckHeight],
    );
    // 计数行 frame：楔形带之下——top = 中卡高 + 楔形带 + 呼吸缝（与相纸
    // 楔形渲染底不重叠），横向锚定中卡两缘、内容右对齐（行落在中卡 frame
    // 之内；alignItems 落实右对齐——页码语义锚在「下一张」侧，与右相纸
    // 楔形深端同侧收边，左侧楔形薄片不与计数行争读）
    const counterSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: deckHeight + pileBand,
            left: stripWidth,
            right: stripWidth,
            height: DECK_COUNTER_LINE,
            alignItems: 'flex-end' as const,
        }),
        [deckHeight, pileBand, stripWidth],
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

    return (
        <View
            className="relative overflow-hidden"
            style={
                deckHeight > 0
                    ? { height: deckHeight + pileBand + DECK_COUNTER_LINE }
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
            {deckHeight > 0 && leftItem ? (
                <View style={[cardSlot, { zIndex: 2 }]} pointerEvents="none">
                    <DeckAnimatedSlot style={[{ flex: 1 }, leftSlotStyle]}>
                        {mediaKind === 'video' ? (
                            <DeckVideoBackCard width={cardWidth} height={deckHeight} />
                        ) : (
                            <DeckBackCard
                                media={leftItem.media}
                                width={cardWidth}
                                height={deckHeight}
                            />
                        )}
                    </DeckAnimatedSlot>
                </View>
            ) : null}
            {/* 右相纸槽 = 下一张（zIndex 2 恒定，left 槽位形镜像 +4°）：right
                通道恒挂，转场时即归中卡卡体（图堆内容零切换本就渲染目标图；
                视频堆归中面 = 占位卡，前卡实体化在收口帧重挂完成） */}
            {deckHeight > 0 && rightItem ? (
                <View style={[cardSlot, { zIndex: 2 }]} pointerEvents="none">
                    <DeckAnimatedSlot style={[{ flex: 1 }, rightSlotStyle]}>
                        {mediaKind === 'video' ? (
                            <DeckVideoBackCard width={cardWidth} height={deckHeight} />
                        ) : (
                            <DeckBackCard
                                media={rightItem.media}
                                width={cardWidth}
                                height={deckHeight}
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
                        {frontItem && deckHeight > 0 ? (
                            mediaKind === 'video' ? (
                                <DeckVideoFrontCard
                                    key={frontItem.media.id}
                                    media={frontItem.media}
                                    width={cardWidth}
                                    height={deckHeight}
                                    interactive={advance == null}
                                    onBlockAction={
                                        editable
                                            ? () => onBlockAction(frontItem.block.id)
                                            : undefined
                                    }
                                />
                            ) : (
                                <DeckFrontCard
                                    media={frontItem.media}
                                    width={cardWidth}
                                    height={deckHeight}
                                    interactive={advance == null}
                                    onBlockAction={
                                        editable
                                            ? () => onBlockAction(frontItem.block.id)
                                            : undefined
                                    }
                                />
                            )
                        ) : null}
                    </DeckAnimatedSlot>
                </View>
            </View>
            {/* 底缘楔形带点按体（zIndex 4；透明纯命中面不遮相纸视觉）：中卡
                frame 以下的整条带（楔形露出区 + 计数行，带高 ≥44dp 零
                hitSlop，与中卡 frame 纵向零重叠）——点左半 = 上一张、点右半
                = 下一张（循环，转场期间闩吞并发）；N=2 单区全带宽 = 下一张
                （左相纸空缺） */}
            {deckHeight > 0 && leftItem ? (
                <Pressable
                    onPress={tapPrev}
                    style={[bandPressSlot, { zIndex: 4, left: 0, width: '50%' }]}
                    accessibilityRole="button"
                    accessibilityLabel="查看上一张"
                />
            ) : null}
            {deckHeight > 0 && rightItem ? (
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
            {deckHeight > 0 ? (
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
 * 块操作卡（上移/下移/删除，浮层居中弹出）由**屏层**条件渲染（禁 RN Modal），
 * 不放编辑器内——编辑器深埋 ScrollView，内联遮罩只盖内容区且随滚动跑位；
 * 屏根 inset-0 才是真全屏 scrim（范式同 InsertMenu/拍摄/录音覆盖层）。
 * 手势入口在本组件（媒体长按/双击经 onBlockAction、文本聚焦 ⋯ 钮）。
 */

export function BlockEditor({
    blocks,
    mediaById,
    editable,
    focusTextId,
    canvas,
    onChange,
    onFocusText,
    onBlurText,
    onRequestActionBlock,
}: {
    blocks: JournalBlock[];
    mediaById: Map<string, JournalMediaRow>;
    editable: boolean;
    /** 需要聚焦的文本块 id（「+ 添加输入框」后自动续写；稳定 id 下标会漂移）。 */
    focusTextId?: string | null;
    /** 画布滚动协作句柄（#12 键盘补偿；屏层 useMemo 固定传入）。 */
    canvas?: EditorCanvasHandle;
    onChange(blocks: JournalBlock[]): void;
    /** 文本块聚焦（屏层目前只借此清空待聚焦标记）。 */
    onFocusText?(id: string): void;
    /** 任一文本段失焦即存（配合防抖的双保险）。 */
    onBlurText?(): void;
    /** 请求弹出块操作卡（媒体长按/双击、文本聚焦 ⋯ 统一入口；屏层渲染浮层）。 */
    onRequestActionBlock?(blockId: string | null): void;
}) {
    const palette = usePalette();
    // 聚焦中的文本块 id（驱动微型 ⋯ 钮显隐；媒体块手势由组件内长按/双击承担）
    const [activeBlockId, setActiveBlockId] = useState<string | null>(null);

    const updateText = (id: string, text: string) => {
        const next = blocks.map((block) =>
            block.id === id && block.t === 'p' ? { t: 'p' as const, id, text } : block,
        );
        onChange(next);
    };

    const isPending = (block: JournalBlock) =>
        block.t === 'media' && block.mediaId === PENDING_MEDIA_ID;

    // 空笔记（唯一一段）= 落笔区（TextBlock 的 firstBlock 位），其余段落两行固定底起
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
                    return (
                        <BlockReveal key={unit.items[0].block.id} index={firstIndex}>
                            <View style={groupMargin}>
                                <MediaDeckStack
                                    items={unit.items}
                                    mediaKind={unit.mediaKind}
                                    editable={editable}
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
                    return <PendingMediaBlock key={block.id} style={verticalMargin} />;
                const media = mediaById.get(block.mediaId);
                if (!media) return null;
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
}

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
