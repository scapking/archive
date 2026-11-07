import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { BouncyPressable, LucideImage, LucidePlus } from '@/core/icons';
import { MoreIcon } from './editor-icons';
import {
    FIELD_TONE_TEXT,
    INPUT_PLATFORM_PROPS,
    INPUT_TRANSPARENT_STYLE,
    fieldInputHeight,
    readContentHeight,
} from './field-input';
import {
    FALLBACK_IMAGE_RATIO,
    MEDIA_MAX_HEIGHT,
    MediaBlock,
    MediaImage,
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
 *   表值 16dp——底缘计数行锚定点按带底、带内零空气，堆后不再多出 8~16dp
 *   视觉空隙（节奏调优修复面，几何核算见 DECK_EDGE_TOTAL 注）；
 * - 块模型自上而下：文本段（自动增高、可聚焦续写）与行内媒体（图/视频/音频）混排，
 *   媒体插入即显示 pending 占位（上传中不阻塞继续写字）；
 * - 连续图片照片堆（渲染层合并，数据仍是独立块）：连续相邻的图片媒体块
 *   （中间无文本/视频/音频/pending 打断）≥2 张合并为层叠向下照片堆
 *   （ImageDeckStack）——v4 真照片堆：组内统一固定画幅 4:3（换张零尺寸
 *   跳变，决策见 DECK_ASPECT_RATIO 注）+ MEDIA_MAX_HEIGHT 封顶；后卡
 *   下移 + 缩收（层 1: +12dp/0.96、层 2: +22dp/0.92）+ 逐层降透明
 *   （0.85/0.7），缩收让后卡左右两侧露出真实内容边，堆叠一眼可读（可视
 *   2 层，第 3 张起不渲染但计数）；前卡下缘整条 44dp = 「下一张」点按体
 *   frame（露边可视带与点按空气带合一，几何即命中、零 hitSlop）；前卡
 *   横滑换位（PanResponder 方向锁：|dx|>10 且 |dx|>1.5|dy| 才认领——画布
 *   纵滚零仲裁；|dx|>60 提交真转场、否则 spring 回弹；左滑 = 下一张 /
 *   右滑 = 上一张，循环），点底缘露边 = 下一张（入卡层自露边位 spring
 *   升顶），点前卡 → 全屏预览，长按前卡 → 该图操作卡（既有 onBlockAction
 *   链）；拖拽过方向锁后 responder 仲裁自然取消点按（拖拽期间不误开全屏）。
 *   提交换位 = v4 双层真转场（出卡沿拖拽方向滑出列缘 + 降透明 timing 220ms，
 *   入卡自露边位 spring 上浮 ~230ms，240ms 统一收口，转场期间 advancing 闩
 *   吞并发手势；transform/opacity，native driver；详见 ImageDeckStack 注）。
 *   分组纯派生（buildRenderUnits），组内增删/移动自动重算，剩 1 张自动解散
 *   回独立自适应渲染（零改动）；pending 占位不进堆叠；性能口径 = 任意 N 恒
 *   挂 3 个图片实例（前卡 + 2 露边层，转场不增实例——入卡层复用露边层 1 的
 *   渲染位），其余留在 blocks 数据里，换位只是索引轮转（数量无上限）；
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
/* 连续图片堆叠（deck 式：渲染层合并，数据仍是独立块，分组是纯派生）      */
/* ------------------------------------------------------------------ */

/** 媒体块变体（分组条目类型）。 */
type JournalMediaBlock = Extract<JournalBlock, { t: 'media' }>;

/**
 * 堆叠成员资格：已就绪的图片媒体块 → 返回媒体行（供层渲染直接复用，
 * 免二次查表）；其余（文本/pending 占位/视频/音频/媒体行缺失）返回 null。
 * pending 占位**不进堆叠也不被堆叠跨越**（占位是插入中瞬态，保持现有
 * 独立占位渲染；上传回填后自然并入/成组）。
 */
const asDeckImage = (
    block: JournalBlock,
    mediaById: Map<string, JournalMediaRow>,
): JournalMediaRow | null => {
    if (block.t !== 'media' || block.mediaId === PENDING_MEDIA_ID) return null;
    const media = mediaById.get(block.mediaId);
    return media != null && media.kind === 'image' ? media : null;
};

/**
 * 渲染单元：单块（现有独立渲染路径）或连续图片堆叠组（≥2 张才成组）。
 * 分组规则：**连续相邻**的图片媒体块（index 相邻、中间无文本/视频/音频/
 * pending 打断）合并；单张图片维持独立渲染（单元回退为 single）。
 */
type RenderUnit =
    | { kind: 'single'; block: JournalBlock; index: number }
    | { kind: 'deck'; items: Array<{ block: JournalMediaBlock; media: JournalMediaRow; index: number }> };

/**
 * 块列表 → 渲染单元（纯函数，每次渲染重算——组随块增删/移动自动重算/解散，
 * 「组内单删后剩 1 张回独立渲染」由此免费获得，零额外状态）。
 */
function buildRenderUnits(
    blocks: JournalBlock[],
    mediaById: Map<string, JournalMediaRow>,
): RenderUnit[] {
    const units: RenderUnit[] = [];
    let group: Array<{ block: JournalMediaBlock; media: JournalMediaRow; index: number }> | null =
        null;
    const flushGroup = () => {
        if (!group) return;
        if (group.length >= 2) {
            units.push({ kind: 'deck', items: group });
        } else {
            // 成组未满 2 张：回退现有独立渲染路径（单张 = 单元）
            for (const item of group) {
                units.push({ kind: 'single', block: item.block, index: item.index });
            }
        }
        group = null;
    };
    blocks.forEach((block, index) => {
        const media = asDeckImage(block, mediaById);
        // block.t 判定收窄块类型（asDeckImage 内部同口径，此处显式写出
        // 供 TS 收窄进组条目）；行缺失/视频/音频/pending 落 single 路径
        if (block.t === 'media' && media != null) {
            if (group) {
                // 不变量：group 非空 ⟹ 上一块同为就绪图片块（非成员块在上一轮
                // 已 flush），「相邻 index」天然成立，无需再查邻居
                group.push({ block, media, index });
            } else {
                group = [{ block, media, index }];
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
/* 照片堆（层叠向下）画幅、露边位形与转场常量（一处收口）                */
/* ------------------------------------------------------------------ */

/**
 * 堆内统一画幅（4:3，v4 决策）：堆叠组内所有卡（前卡/露边层/转场入卡层）
 * 共用一个固定画幅，换张/滑动时卡片尺寸恒定——消除「换张时生硬变高变矮」。
 * 取 4:3 而非 16:10 的理由：
 * ① 与缺元数据兜底画幅 FALLBACK_IMAGE_RATIO 同源同值（media-view 单点事实
 *    源，零新魔数；缺宽高的图在堆内与独立渲染观感一致）；
 * ② 4:3 是手机相册主流横版画幅，cover 裁切损失最小——16:10 会把 4:3 照片
 *    上下多裁约 17% 的内容；
 * ③ 4:3 组高更高，露边带（下移 12/22dp + 两侧缩收边）相对更显眼，「堆叠
 *    一眼可读」的修复目标直接受益；16:10 的矮卡会把露边挤成细缝。
 * 仍受 MEDIA_MAX_HEIGHT 封顶（宽列/平板与单图同口径，超出 cover 裁切）；
 * 单张图片（不成组）不受此约束，保持自然比例自适应（MediaImage 原路径）。
 */
const DECK_ASPECT_RATIO = FALLBACK_IMAGE_RATIO;
/** 可视露边层数上限：前卡正下方最多渲染 2 张露边层，第 3 张起不渲染但计数
 *  （性能口径见 ImageDeckStack 注）。 */
const DECK_VISIBLE_EDGES = 2;
/** 露边层 1 位形（下移/缩收/降透明，v4 真照片堆观感）：缩收让后卡**左右
 *  两侧露出真实内容边**（能看到下一张图的实际内容），下移露底缘，降透明
 *  加深层级；该位形同时是入卡层的停靠位（上浮起点，像素恒等见组件注）。 */
const DECK_EDGE_STEP_1 = 12;
const DECK_EDGE_SCALE_1 = 0.96;
const DECK_EDGE_OPACITY_1 = 0.85;
/** 露边层 2 位形（更深一档）。 */
const DECK_EDGE_STEP_2 = 22;
const DECK_EDGE_SCALE_2 = 0.92;
const DECK_EDGE_OPACITY_2 = 0.7;
/** 前卡下缘的固定增量（dp）：底缘露边可视带与「下一张」点按带**合一**——
 *  前卡下缘以下整条 44dp 都是点按体的真实 frame（无障碍最小按压目标一步
 *  达标、零 hitSlop）。不用 hitSlop 外扩的原因：命中链逐层要求祖先 frame
 *  包含触点，hitSlop 伸出 overflow-hidden 容器 / 祖先 frame 的部分三端命中
 *  不可靠（iOS pointInside 对越界触点直接不下探），真实 frame 预留才是
 *  确定性命中。带的全高同时是堆的**可视纵深**：露边占顶部（v4 缩收位形下
 *  约 7~12dp 底缘 + 两侧内容边），计数行锚定带底缘（bottom 0）收口尾部
 *  ——带内零空气，堆的视觉底 = 布局底，堆后视觉净空 = 组 margin + 栈 gap
 *  = 节奏表 16dp，与堆前对称；计数浮层 pointerEvents none 不参与命中，
 *  点按区连续无死区。 */
const DECK_EDGE_TOTAL = 44;
/** 横滑方向锁（onMoveShouldSetPanResponder）：|dx| 超过 10 且
 *  |dx| > 1.5|dy| 才认领手势——横向意图判定，画布纵向滚动零仲裁。 */
const SWIPE_LOCK_DX = 10;
const SWIPE_LOCK_RATIO = 1.5;
/** 松手提交阈值（|dx|，dp）：超过 = 提交换位（真转场），否则回弹归位。 */
const SWIPE_COMMIT_DX = 60;
/** 回弹 spring 摩擦系数（deck.tsx SPRING_FRICTION 同款口径）。 */
const DECK_SPRING_FRICTION = 8;
/** 前卡拖拽远离中位的降透明下限（插值端点）：拖出 = 即将离场的手势暗示；
 *  越过列宽的区段（出卡滑出阶段）由同一插值续降到 0（见 frontStyle 注）。 */
const DECK_DRAG_MIN_OPACITY = 0.72;
/** 出卡滑出时长（ms，timing ease-out）：沿拖拽方向滑到列宽 + 越缘余量，
 *  overflow-hidden 裁切 + 降透明，220ms 收住不拖沓。 */
const SWIPE_EXIT_MS = 220;
/** 转场统一收口 deadline（ms）：出卡 220ms timing 与入卡 spring（~230ms
 *  到位）都完成后 snap 复位 + 提交索引轮转；总时长 ≤350ms 预算内。 */
const ADVANCE_TOTAL_MS = 240;
/** 出卡滑出的越缘余量（dp）：滑到列宽 + 余量保证整卡完全离开
 *  overflow-hidden 容器，收口帧复位换内容不可见。 */
const DECK_EXIT_MARGIN = 40;
/** 入卡上浮 spring：deck.tsx 的 friction 8/tension 40 对 12dp 小行程要
 *  ~460ms 才到位（超 350ms 预算）——提张力到 150（ζ≈0.61，保留轻过冲的
 *  「落定」手感），~230ms 到位、240ms 收口。 */
const DECK_RISE_TENSION = 150;
const DECK_RISE_FRICTION = 15;

/**
 * 堆叠前卡（当前图）：自然比例自适应 + 高度封顶（MediaImage 同口径；几何
 * 由 ImageDeckStack 按同一公式数值化后传入显式宽高——组高与露边/点按体
 * frame 都依赖数值高，不借助 yoga 的 aspectRatio 收敛，cover 裁切结果与
 * yoga 口径恒等）。交互链 = 既有口径：点按 → requestViewer 全屏（键盘先
 * 收）、长按/桌面双击 → onBlockAction 操作卡（useBlockActionGestures 单点
 * 收口）。横滑拖拽不在此层——PanResponder 挂在宿主槽位 wrapper（见
 * ImageDeckStack 注：父级方向锁认领后 responder 仲裁自然终止点按）。触摸
 * 面零 className（deck 触摸面纯净铁律：按压体不落 className，防 css-interop
 * 按压 observable 注入手势窗口）。
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
    /** 交互闸：转场期间前卡是「出卡层」，点按/长按一律吞掉（advancing 闩的
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
            <View
                className="overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
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
 * 露边卡（后位卡卡体）：与前卡同宽同高的整卡渲染（统一画幅 + cover 裁切），
 * 位形（下移/缩收/降透明）由宿主层施加——静止时缩收让左右两侧与底缘露出
 * 真实内容边，其余被前卡/更浅层遮盖；转场时它即入卡层卡体（上浮由宿主的
 * AnimatedSlot 驱动）。零交互纯视觉，无按压体（BouncyPressable 都不挂）：
 * 底缘命中整条归 44dp 点按体，双按压体叠命中区只会互相抢；图片未就绪时
 * 保持 raised 占位底（窄条放不下失败文案）。
 */
function DeckEdgeCard({
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
            style={{ width, height }}
        >
            {status === 'ready' && uri ? (
                <Image source={{ uri }} style={{ width, height }} resizeMode="cover" />
            ) : null}
        </View>
    );
}

/**
 * 连续图片照片堆（v4 真照片堆：统一画幅 + 露边位形 + 双层真转场）。
 *
 * 几何（组容器 relative overflow-hidden，宽 = 列宽 onLayout 量取，高 =
 * 统一卡高 + DECK_EDGE_TOTAL(44)；overflow-hidden 是横滑与出卡滑出的实现
 * 基础——拖拽中的前卡与滑出的旧卡都被列缘裁切，不出血到画布留白）：
 *   统一画幅：组内所有卡（前卡/露边层/转场入卡层）宽 = 列宽、高 =
 *       min(列宽 ÷ 4:3, MEDIA_MAX_HEIGHT)——固定画幅换张零尺寸跳变
 *       （决策见 DECK_ASPECT_RATIO 注；显式数值宽高 + cover 裁切，组高与
 *       点按体 frame 都依赖数值高）；
 *   露边层 i（i = 1..min(2, N−1)）：整卡下移 STEP_i + 缩收 SCALE_i + 降
 *       透明 OPACITY_i（12/0.96/0.85、22/0.92/0.7）——缩收让后卡左右两侧
 *       露出真实内容边、下移露底缘，堆叠一眼可读；N=2 只有 1 层；
 *   底缘点按体：absolute top = 卡高、高 44、横向满宽（几何即命中、零
 *       hitSlop，露边可视带与点按空气带合一）；计数行锚定带底缘。
 *
 * 层级 zIndex（state 派生 + 静态常量，一律不进动画值）：入卡层 = 转场时
 * 4 / 静止 2（advance state 派生，state 驱动铁律）> 前卡 3 > 露边层 2 = 1；
 * 点按体与计数浮层 frame 在卡区之外，不参与 z 仲裁。
 *
 * 换位状态机 v4（滑/点两条提交链路收口到同一转场；advancing 闩吞并发手势
 * ——转场期间方向锁不认领、点按体无效、前卡交互闸关闭；长按链路提交的是
 * 操作卡不动堆，无转场面）：
 * - 滑动提交：方向锁认领后 Animated.event 跟手写 frontX，松手 |dx|>60 →
 *   commitSwipe = beginAdvance(出卡层不换内容) + frontX timing 220ms 沿
 *   拖拽方向滑出列缘（透明度走 xFade 的 |x|>列宽区段 0.72→0，与拖拽下限
 *   同一条插值）+ 入卡层上浮；240ms deadline 统一收口（finishAdvance：
 *   snap 复位 + advancing 闩释放 + 索引轮转，同批 React 提交零闪帧——
 *   入卡层终态与轮转后前卡静止帧像素恒等）；
 * - 回弹：|dx|≤60 或手势被系统夺走（terminate）→ 仅 frontX spring 归 0
 *   （friction 8），索引不动、闩不介入（回弹中途可被下一轮拖拽接管）；
 * - 点击：底缘点按体 → beginAdvance(+1)：入卡层 = 当前露边层 1（图片已
 *   就绪渲染中，内容零切换零闪）自停靠位（12/0.96/0.85）spring 升顶盖过
 *   前卡；收口帧才换前卡内容（出卡无滑出——旧前卡被升顶的新前卡逐步覆盖，
 *   物理 = 堆里下一张「翻上来」；升顶首帧与露边层 1 停靠位渲染像素恒等）；
 * - 收口统一性：滑动/点击都由 ADVANCE_TOTAL_MS 定时器触发 finishAdvance
 *   ——snap（frontX=0、rise 三值回停靠位）+ setAdvance(null) + rotateIndex
 *   在同一事件帧提交，深层露边层内容随索引轮转同帧换位（该 10dp 级微移
 *   与旧版同级别，不在转场主运动面）。
 *
 * 动画口径：RN Animated native driver，style 只 transform/opacity；拖拽
 * 跟手 = Animated.event([null, {dx}])（JS responder 事件映射，useNative
 * Driver: false 是 PanResponder 场景唯一合法值，native driver 由挂载方
 * 承担）；插值节点 useMemo 固定，仅列宽变化（旋转/分栏）重建（deck.tsx
 * #9 教训）。
 *
 * 性能口径：任意 N 恒挂 3 个图片实例（前卡 + 2 露边层），转场不增实例——
 * 入卡层复用露边层 1 的渲染位（reverse 换位时其内容临时切到上一张图，
 * 该图刚作为前卡渲染过，原生 Image 缓存秒回，至多一帧 raised 占位），
 * 其余留在 blocks 数据里，换位只是索引轮转（数量无上限）；组内单删/移动
 * → buildRenderUnits 重派生（clamp/解散免费获得），deck 实例按组首块 id
 * 做 key，组首块被删即重挂回第 1 张。与画布纵滚正交：方向锁保证横向意图
 * 才认领手势，纵滚零仲裁。
 */

/** 转场描述：dir = 换位方向（+1 下一张 / −1 上一张），media = 入卡图行。 */
interface DeckAdvance {
    dir: 1 | -1;
    media: JournalMediaRow;
}

function ImageDeckStack({
    items,
    editable,
    onBlockAction,
}: {
    items: Array<{ block: JournalMediaBlock; media: JournalMediaRow; index: number }>;
    editable: boolean;
    /** 请求弹出当前前卡的块操作卡（屏层渲染，作用于该块）。 */
    onBlockAction(blockId: string): void;
}) {
    const itemCount = items.length;
    // 组内容 ref 镜像：换位闭包读取最新组（手势/转场窗口内组可能增删）
    const itemsRef = useRef(items);
    itemsRef.current = items;

    // 组内前卡索引（换位 = 索引轮转，收口帧才提交；函数式更新串行化）
    const [frontIndex, setFrontIndex] = useState(0);
    // 容器宽（列宽自适应，onLayout 量取；全部几何由它派生，量取前不渲染卡内容）
    const [containerWidth, setContainerWidth] = useState(0);
    // 转场态（渲染驱动：入卡层内容/提层 zIndex/前卡交互闸）+ advancing 闩
    //（手势闭包同步检查）——转场期间吞并发手势（滑/点全部无效）
    const [advance, setAdvance] = useState<DeckAdvance | null>(null);
    const advancingRef = useRef(false);
    const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 前卡索引（clamp 后派生，组收缩不越界）+ ref 镜像（beginAdvance 闭包
    // 读取最新值，防陈旧闭包）
    const safeIndex = Math.min(Math.max(frontIndex, 0), itemCount - 1);
    const safeIndexRef = useRef(safeIndex);
    safeIndexRef.current = safeIndex;

    // 动画值：frontX = 前卡横滑（拖拽跟手 + 出卡滑出 + 回弹收口）；rise 三值
    // = 入卡层停靠位 → 顶部的上浮通道（静止恒停靠位 = 露边层 1 位形）
    const frontX = useRef(new Animated.Value(0)).current;
    const riseY = useRef(new Animated.Value(DECK_EDGE_STEP_1)).current;
    const riseScale = useRef(new Animated.Value(DECK_EDGE_SCALE_1)).current;
    const riseOpacity = useRef(new Animated.Value(DECK_EDGE_OPACITY_1)).current;
    useEffect(() => {
        // 挂载即锚定基准位（deck.tsx 同款防御：实例复用/Strict 下不残留旧值）
        frontX.setValue(0);
        riseY.setValue(DECK_EDGE_STEP_1);
        riseScale.setValue(DECK_EDGE_SCALE_1);
        riseOpacity.setValue(DECK_EDGE_OPACITY_1);
    }, [frontX, riseY, riseScale, riseOpacity]);
    // 转场 deadline 定时器随卸载清理（组解散/重挂不留悬挂收口）
    useEffect(
        () => () => {
            if (advanceTimerRef.current != null) clearTimeout(advanceTimerRef.current);
        },
        [],
    );

    // 统一卡高（固定 4:3 画幅 + MEDIA_MAX_HEIGHT 封顶）：组内所有卡同帧，
    // 换张/滑动零尺寸跳变
    const deckHeight =
        containerWidth > 0 ? Math.min(containerWidth / DECK_ASPECT_RATIO, MEDIA_MAX_HEIGHT) : 0;

    // 前卡条目（clamp 后取数）
    const frontItem = items[safeIndex];

    // 索引轮转（收口帧提交）：函数式更新——不依赖渲染落地；组收缩按 itemsRef
    // clamp（转场窗口内增删安全）
    const rotateIndex = useCallback((dir: 1 | -1) => {
        setFrontIndex((current) => {
            const len = itemsRef.current.length;
            const safe = Math.min(Math.max(current, 0), len - 1);
            return (safe + dir + len) % len;
        });
    }, []);

    // 转场收口（ADVANCE_TOTAL_MS deadline 触发）：snap 复位 + 清闩 + 索引
    // 轮转，同一事件帧内全部落地（入卡层终态与轮转后前卡静止帧像素恒等，
    // 复位换内容不可见——出卡此时已完全滑出 overflow-hidden 容器）
    const finishAdvance = useCallback(
        (dir: 1 | -1) => {
            advanceTimerRef.current = null;
            // snap 前先停在飞动画，防其覆写复位值（出卡 timing 220ms 已结束）
            frontX.stopAnimation();
            frontX.setValue(0);
            riseY.stopAnimation();
            riseY.setValue(DECK_EDGE_STEP_1);
            riseScale.stopAnimation();
            riseScale.setValue(DECK_EDGE_SCALE_1);
            riseOpacity.stopAnimation();
            riseOpacity.setValue(DECK_EDGE_OPACITY_1);
            advancingRef.current = false;
            setAdvance(null);
            rotateIndex(dir);
        },
        [frontX, riseY, riseScale, riseOpacity, rotateIndex],
    );

    // 转场起手（滑动/点击提交共用）：入卡层自停靠位 spring 升顶（提层
    // zIndex 由 advance state 派生）+ advancing 闩 + deadline 收口。
    // rise spring 与出卡 timing 并行：总观感 = 旧卡滑走的同时新卡从堆里浮起
    const beginAdvance = useCallback(
        (dir: 1 | -1) => {
            const list = itemsRef.current;
            if (list.length < 2 || advancingRef.current) return;
            const len = list.length;
            const from = Math.min(Math.max(safeIndexRef.current, 0), len - 1);
            const incoming = list[(from + dir + len) % len];
            advancingRef.current = true;
            setAdvance({ dir, media: incoming.media });
            Animated.parallel([
                Animated.spring(riseY, {
                    toValue: 0,
                    friction: DECK_RISE_FRICTION,
                    tension: DECK_RISE_TENSION,
                    useNativeDriver: true,
                }),
                Animated.spring(riseScale, {
                    toValue: 1,
                    friction: DECK_RISE_FRICTION,
                    tension: DECK_RISE_TENSION,
                    useNativeDriver: true,
                }),
                Animated.spring(riseOpacity, {
                    toValue: 1,
                    friction: DECK_RISE_FRICTION,
                    tension: DECK_RISE_TENSION,
                    useNativeDriver: true,
                }),
            ]).start();
            advanceTimerRef.current = setTimeout(() => finishAdvance(dir), ADVANCE_TOTAL_MS);
        },
        [riseY, riseScale, riseOpacity, finishAdvance],
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

    // 滑动提交：出卡（前卡层自身 = 出卡层，内容不换）沿拖拽方向 timing 220ms
    // 滑出列缘 + xFade 越缘区段同步降透明；入卡上浮由 beginAdvance 并行发起，
    // 240ms 统一收口（索引在收口帧才轮转——前卡内容切换与复位同帧零闪）
    const commitSwipe = useCallback(
        (dx: number) => {
            // 容器未量宽（不可达防御，卡可见即已量宽）：退回回弹路径
            if (containerWidth <= 0) {
                springBack();
                return;
            }
            const dir: 1 | -1 = dx < 0 ? 1 : -1;
            beginAdvance(dir);
            frontX.stopAnimation();
            Animated.timing(frontX, {
                toValue: (dx < 0 ? -1 : 1) * (containerWidth + DECK_EXIT_MARGIN),
                duration: SWIPE_EXIT_MS,
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }).start();
        },
        [frontX, containerWidth, beginAdvance, springBack],
    );

    // 底缘点按 = 下一张（单向循环）：入卡层（当前露边层 1，图片已就绪）自
    // 停靠位升顶盖过前卡（转场期间闩吞并发点按）
    const tapNext = useCallback(() => {
        beginAdvance(1);
    }, [beginAdvance]);

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

    // 前卡动效样式（deck.tsx useSlotStyle 同款插值口径）：translateX + xFade
    // 五点插值——中位 1 → 列缘 DECK_DRAG_MIN_OPACITY（拖拽下限）→ 越缘区段
    // 续降到 0（出卡滑出与降透明共用同一条插值，不另立 fade 节点）；插值
    // 节点 useMemo 固定，仅列宽变化重建，任意重渲不重建 native 动画图
    //（deck.tsx #9 教训）
    const frontStyle = useMemo(
        () => ({
            transform: [{ translateX: frontX }],
            opacity:
                containerWidth > 0
                    ? frontX.interpolate({
                          inputRange: [
                              -(containerWidth + DECK_EXIT_MARGIN),
                              -containerWidth,
                              0,
                              containerWidth,
                              containerWidth + DECK_EXIT_MARGIN,
                          ],
                          outputRange: [0, DECK_DRAG_MIN_OPACITY, 1, DECK_DRAG_MIN_OPACITY, 0],
                          extrapolate: 'clamp',
                      })
                    : 1,
        }),
        [frontX, containerWidth],
    );

    // 入卡层动效样式（停靠位 → 顶部的上浮三值；静止 = 露边层 1 位形，
    // transform/opacity 白名单键，deck 铁律）
    const riseSlotStyle = useMemo(
        () => ({
            transform: [{ translateY: riseY }, { scale: riseScale }],
            opacity: riseOpacity,
        }),
        [riseY, riseScale, riseOpacity],
    );

    // 卡槽 frame（deck.tsx 同款「静态几何全在普通 wrapper」铁律）：前卡与
    // 露边层/入卡层同帧（统一画幅同宽同高）
    const cardSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: containerWidth,
            height: deckHeight,
        }),
        [containerWidth, deckHeight],
    );
    // 底缘点按体 frame：前卡下缘起、高 44、横向满宽（几何即命中，零 hitSlop）
    const edgePressSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            left: 0,
            right: 0,
            top: deckHeight,
            height: DECK_EDGE_TOTAL,
        }),
        [deckHeight],
    );

    // 防御性回退（置于全部 hook 之后：条件 return 不得跨越 hook 调用；
    // buildRenderUnits 保证 deck 单元 ≥2 张，实际不可达，仅兜底防击穿）
    if (itemCount === 0) return null;
    if (itemCount === 1) {
        // 成组条件被并发变更击穿时按单张独立渲染（与 single 路径同款自适应）
        return <MediaImage media={items[0].media} />;
    }

    // 露边层取数（循环遍历；N=2 时只有 1 层——第 2 层不再渲染同一张前卡）
    const stripCount = Math.min(DECK_VISIBLE_EDGES, itemCount - 1);
    const stripItems: Array<{ block: JournalMediaBlock; media: JournalMediaRow }> = [];
    for (let offset = 1; offset <= stripCount; offset += 1) {
        stripItems.push(items[(safeIndex + offset) % itemCount]);
    }

    return (
        <View
            className="relative overflow-hidden"
            style={deckHeight > 0 ? { height: deckHeight + DECK_EDGE_TOTAL } : undefined}
            onLayout={(event) => {
                const width = event.nativeEvent.layout.width;
                // 亚像素抖动丢弃（旋转/分栏断点切换才有真实变化）
                setContainerWidth((current) =>
                    Math.abs(current - width) < 0.5 ? current : width,
                );
            }}
        >
            {/* 露边层 2（最深，zIndex 1，静态位形）：items[safeIndex+2] 整卡压底，
                下移 22 + 缩收 0.92 + 降透明 0.7；第 3 张起不渲染（性能口径） */}
            {deckHeight > 0 && stripItems[1] ? (
                <View
                    style={[
                        cardSlot,
                        {
                            zIndex: 1,
                            opacity: DECK_EDGE_OPACITY_2,
                            transform: [
                                { translateY: DECK_EDGE_STEP_2 },
                                { scale: DECK_EDGE_SCALE_2 },
                            ],
                        },
                    ]}
                    pointerEvents="none"
                >
                    <DeckEdgeCard
                        media={stripItems[1].media}
                        width={containerWidth}
                        height={deckHeight}
                    />
                </View>
            ) : null}
            {/* 露边层 1 / 入卡层（zIndex 2；转场时 advance state 提层至 4，
                state 驱动铁律）：普通 wrapper（静态几何 + state zIndex）→
                AnimatedSlot（flex:1 + 上浮三值，静止 = 停靠位 12/0.96/0.85）
                → 露边卡。转场时内容切到入卡图（forward = 原内容不变，
                reverse = 上一张，原生 Image 缓存秒回） */}
            {deckHeight > 0 && stripItems[0] ? (
                <View
                    style={[cardSlot, { zIndex: advance != null ? 4 : 2 }]}
                    pointerEvents="none"
                >
                    <DeckAnimatedSlot style={[{ flex: 1 }, riseSlotStyle]}>
                        <DeckEdgeCard
                            media={advance != null ? advance.media : stripItems[0].media}
                            width={containerWidth}
                            height={deckHeight}
                        />
                    </DeckAnimatedSlot>
                </View>
            ) : null}
            {/* 前卡层（zIndex 3）：普通 wrapper（静态几何 + PanResponder 方向锁，
                手势面与视觉面同 frame）→ AnimatedSlot（flex:1 + translateX/
                xFade，出卡滑出复用此层，静态布局 key 收口在 wrapper，deck
                铁律）→ 前卡卡体（点全屏 + 长按操作卡，既有链；转场期间
                interactive 闸关闭；触摸面零 className 收口在 DeckFrontCard） */}
            <View style={[cardSlot, { zIndex: 3 }]} {...panResponder.panHandlers}>
                <DeckAnimatedSlot style={[{ flex: 1 }, frontStyle]}>
                    {frontItem && deckHeight > 0 ? (
                        <DeckFrontCard
                            media={frontItem.media}
                            width={containerWidth}
                            height={deckHeight}
                            interactive={advance == null}
                            onBlockAction={
                                editable ? () => onBlockAction(frontItem.block.id) : undefined
                            }
                        />
                    ) : null}
                </DeckAnimatedSlot>
            </View>
            {/* 底缘点按体（frame 在卡区之外，无 z 仲裁面）：前卡下缘整条 44dp
                （露边可视带 + 空气带合一，几何即命中零 hitSlop）——点 = 下一张
                （单向循环，转场期间闩吞并发）；计数浮层落在带内（pointerEvents
                none 不参与命中，点按区连续） */}
            {deckHeight > 0 ? (
                <Pressable
                    onPress={tapNext}
                    style={edgePressSlot}
                    accessibilityRole="button"
                    accessibilityLabel={`第 ${safeIndex + 1} 张，共 ${itemCount} 张，点按查看下一张`}
                />
            ) : null}
            {/* 计数（current+1/N）：锚定 44dp 点按带底缘（bottom 0）居中——
                带 44dp 全高纳入堆可视纵深（露边 → 计数行连续着墨、带内零
                空气），堆后视觉净空 = 组 margin + 栈 gap 与堆前对称（节奏表
                16dp）；bottom 锚定把三端行高差（±2px）吃进带内，不污染块间
                净空。muted 12px tabular-nums、无 pill chrome（克制口径）；
                pointerEvents none + a11y 隐藏（计数已并入点按体 label，
                不重复播报） */}
            {deckHeight > 0 ? (
                <View
                    pointerEvents="none"
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        alignItems: 'center',
                    }}
                >
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

    // 渲染单元（纯派生，见 buildRenderUnits）：连续图片合并堆叠，其余原样
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
                    // 组首块被删 → key 更替 → 重挂回第 1 张（明确语义）
                    const groupMargin = {
                        marginTop: mediaMargin(blocks[firstIndex - 1]),
                        marginBottom: mediaMargin(blocks[lastIndex + 1]),
                    };
                    return (
                        <BlockReveal key={unit.items[0].block.id} index={firstIndex}>
                            <View style={groupMargin}>
                                <ImageDeckStack
                                    items={unit.items}
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
