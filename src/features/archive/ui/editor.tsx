import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Animated,
    Keyboard,
    Platform,
    Pressable,
    Text,
    TextInput,
    View,
    type ScrollViewInstance,
} from 'react-native';
import { BouncyPressable, LucidePlus } from '@/core/icons';
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
} from './media-view';
import { usePalette } from './theme';
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
 *   （报头 pb-2 8dp + 画布 pt 16dp 叠加，由屏层消费）；
 * - 块模型自上而下：文本段（自动增高、可聚焦续写）与行内媒体（图/视频/音频）混排，
 *   媒体插入即显示 pending 占位（上传中不阻塞继续写字）；
 * - 连续图片 deck 式堆叠（渲染层合并，数据仍是独立块）：连续相邻的图片
 *   媒体块（中间无文本/视频/音频/pending 打断）≥2 张合并为首页双卡同构的
 *   层叠堆（ImageDeckStack，交互范式照抄 ui/deck.tsx）——前卡完整显示 +
 *   右缘露条（下一张的边缘）；点露条 → 换位（下一张成为前卡，循环遍历
 *   全部）；点前卡主体 → 全屏预览（既有 MediaImage 入口）；长按前卡 →
 *   该图操作卡（作用于当前前卡块）。分组纯派生（buildRenderUnits），组内
 *   增删/移动自动重算，剩 1 张自动解散回独立渲染；pending 占位不进堆叠；
 *   性能口径 = 只挂载前卡 + 露条两层可视内容（其余 N 张留在 blocks 数据里，
 *   换位只是索引轮转，数量无上限），动画共用一对 Animated.Value；
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

/** 露条宽（dp）：编辑列宽口径的右缘露条——下一张图片的可见边缘宽度，兼作
 *  独立换位按压体的命中宽（全高 28×组高，等效目标远超 44dp）。首页 deck
 *  PEEK=76 是 430dp 大卡口径，编辑列照搬会吃掉前卡近 1/4 宽；28（2dp 网格）
 *  露条可辨、前卡构图损失最小（前卡以列宽−28 渲染，照片 cover 裁切约 9%
 *  宽，deck 范式的固有代价——露条必须真实露出来且可点）。 */
const DECK_PEEK = 28;
/** 换位 spring 摩擦系数（deck.tsx SPRING_FRICTION 同款口径）。 */
const DECK_SPRING_FRICTION = 8;

/**
 * 连续图片 deck 式堆叠（首页双卡同构，交互范式照抄 ui/deck.tsx）。
 *
 * 层级与命中区（三层命中区互不重叠，几何见各层注）：
 *   组容器（relative，高 = 组内最高卡 → 换位/换前卡零布局跳变）
 *   ├ 后层槽位（absolute left0/right=PEEK，zIndex 随 state）
 *   │   → AnimatedSlot（flex:1 + translateX(PEEK)/scale/opacity 插值，
 *   │     pointerEvents none 整层穿透）→ 下一张 MediaImage（纯视觉，
 *   │     右缘 = 露条）
 *   ├ 前层槽位（同 frame，zIndex 随 state）
 *   │   → AnimatedSlot（同款插值）→ MediaImage 本体即前卡按压体
 *   │     （点全屏 + 长按操作卡，作用于当前前卡块；BouncyPressable 零
 *   │     className——deck 触摸面纯净铁律）
 *   └ 露条按压体（absolute right0 width=PEEK 全高，zIndex 3）→ 点它换位
 *
 * - 换位状态机（deck.tsx 同款扩展）：aIsFront（层内容指派 + 静止 zIndex，
 *   deck 的 aFront state）+ advancing（换位进行中：zIndex 让位给「正在滑
 *   向前位的层」并吞并发点击）+ frontIndex（组内前卡索引）。点露条 →
 *   zIndex 翻转（state 驱动，铁律：zIndex 不走动画值）→ 双 spring（共享
 *   一对 Animated.Value，deck 同款，不为每张图建值，值跨换位持久无 snap）
 *   → 动画收口一次性提交 aIsFront 翻转 + frontIndex 轮转。收口零跳变的
 *   几何依据：A/B 两层槽位 frame 恒等、offset 互补，前层内容指派在指派
 *   翻转前后像素恒等（换位后前卡就停在它动画到达的位置），唯一可见变化
 *   = 露条/底部露出的后层内容就地轮转（dimmed 后层硬切，28dp 露条上不可
 *   感）。换位 = 索引轮转，循环遍历全部。
 * - 性能口径（无上限 + 稳定）：任何 N 只挂载两层可视内容（前卡 + 露条的
 *   下一张），其余 N−2 张不挂载（数据在 blocks 里，换位只是索引轮转）；
 *   动画值恒 2 个（共享对，deck 同款）；组高一次 O(N) 纯算术算好，换位
 *   不触发布局。组内单删/移动 → buildRenderUnits 重派生（clamp/解散在此
 *   免费获得），deck 实例按组首块 id 做 key，组首块被删即重挂回第 1 张。
 * - 与外层画布正交：deck 式无横滑手势（换位 = 点露条），画布纵滚零仲裁。
 * - 露条计数（current+1/N）：露条本体是下一张照片的边缘（底色不可控，
 *   muted 灰叠照片不可读——上轮已归档结论），计数放露条正下方同右缘：
 *   12px muted tabular-nums、无 pill chrome（克制口径）。
 */
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
    // 组内容 ref 镜像：动画收口闭包读取最新组（动画窗口内组可能增删）
    const itemsRef = useRef(items);
    itemsRef.current = items;
    // 换位动画收口的存活门控：卸载后回调不再触碰 state / 动画值
    //（audio-player aliveRef 同款纪律）
    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
        };
    }, []);

    // 层内容指派 + 静止 zIndex（deck.tsx 的 aFront state 同款语义）
    const [aIsFront, setAIsFront] = useState(true);
    // 组内前卡索引（换位 = 索引轮转）；组收缩 clamp 在派生处（渲染一致性
    // 由派生保证，state 本身不追踪收缩——收口轮转时按 clamp 后的值取模）
    const [frontIndex, setFrontIndex] = useState(0);
    // 换位进行中：zIndex 让位给正在滑向前位的层 + 吞并发点击（spring 重入
    // 会错位——deck.tsx 固定双卡无此面，N 张轮转必须闩）
    const [advancing, setAdvancing] = useState(false);
    // 容器宽（列宽自适应，onLayout 量取；组高由它派生，量取前不渲染卡内容）
    const [containerWidth, setContainerWidth] = useState(0);

    // 共享一对动画值（deck 同款）：0=在前，1=在后；A/B 层身份固定（内容
    // 指派随 aIsFront 轮转），值跨换位持久（spring 就地重定目标，无 snap）
    const aOffset = useRef(new Animated.Value(0)).current;
    const bOffset = useRef(new Animated.Value(1)).current;
    useEffect(() => {
        // 挂载即锚定基准位（deck.tsx 同款防御：实例复用/Strict 下不残留旧值）
        aOffset.setValue(0);
        bOffset.setValue(1);
    }, [aOffset, bOffset]);

    // 前卡/露条内容（clamp 后派生，组收缩不越界）
    const safeIndex = Math.min(Math.max(frontIndex, 0), itemCount - 1);
    const frontItem = items[safeIndex];
    const backItem = items[(safeIndex + 1) % itemCount];

    // 组高 = 组内最高卡（各图自然比例 + 封顶，公式与 MediaImage 同源取自
    // media-view 导出）：容器高恒定 → 露条几何不随内容高度变化（deck 铁律）
    const slotWidth = Math.max(containerWidth - DECK_PEEK, 0);
    let groupHeight = 0;
    if (slotWidth > 0) {
        for (const { media } of items) {
            const ratio =
                media.width && media.height ? media.width / media.height : FALLBACK_IMAGE_RATIO;
            groupHeight = Math.max(groupHeight, Math.min(slotWidth / ratio, MEDIA_MAX_HEIGHT));
        }
    }

    // 换位（deck.tsx swap 同款结构）：zIndex 先行（state），双 spring 随后；
    // 收口一次性提交层指派翻转 + 索引轮转（前层内容像素恒等，见组件注）。
    // 闩住 advancing：动画窗口内再点露条直接忽略（队列化会让收口语义复杂
    // 化且无收益，spring 全程 ~300ms 可忽略窗口足够窄）
    const advance = () => {
        if (advancing || itemCount < 2) return;
        const nextIsAFront = !aIsFront;
        setAdvancing(true);
        Animated.parallel([
            Animated.spring(aOffset, {
                toValue: nextIsAFront ? 0 : 1,
                friction: DECK_SPRING_FRICTION,
                useNativeDriver: true,
            }),
            Animated.spring(bOffset, {
                toValue: nextIsAFront ? 1 : 0,
                friction: DECK_SPRING_FRICTION,
                useNativeDriver: true,
            }),
        ]).start(({ finished }) => {
            if (!finished || !aliveRef.current) return;
            // 就地提交（无 snap）：前层内容指派前后像素恒等（组件注）；
            // 索引轮转按收口时刻的最新组取模（itemsRef 恒新鲜）
            setAIsFront((current) => !current);
            setFrontIndex((current) => {
                const length = itemsRef.current.length;
                const safe = Math.min(Math.max(current, 0), length - 1);
                return (safe + 1) % length;
            });
            setAdvancing(false);
        });
    };

    // 槽位动效样式（deck.tsx useSlotStyle 同款插值口径：translateX [0,PEEK] /
    // scale [1,0.95] / opacity [1,0.45]，native driver 白名单键）；插值节点
    // useMemo 固定——任意重渲不重建 native 动画图（deck.tsx #9 教训）
    const aStyle = useMemo(
        () => ({
            transform: [
                {
                    translateX: aOffset.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, DECK_PEEK],
                    }),
                },
                {
                    scale: aOffset.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 0.95],
                    }),
                },
            ],
            opacity: aOffset.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
        }),
        [aOffset],
    );
    const bStyle = useMemo(
        () => ({
            transform: [
                {
                    translateX: bOffset.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, DECK_PEEK],
                    }),
                },
                {
                    scale: bOffset.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, 0.95],
                    }),
                },
            ],
            opacity: bOffset.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] }),
        }),
        [bOffset],
    );

    // 卡槽（deck.tsx 同款几何）：left 0 / right=PEEK；后位 translateX(PEEK)
    // 后右缘对齐容器——露条 = 后卡右缘，恒在前层槽位 frame 之外（命中不重叠，
    // deck 铁律：露条必须真实可点）。静态布局 key 全在普通 wrapper 上。
    const slot = useMemo(
        () => ({ position: 'absolute' as const, top: 0, bottom: 0, left: 0, right: DECK_PEEK }),
        [],
    );
    // 露条按压体槽位：右缘全高独立命中（宽 = DECK_PEEK）
    const stripSlot = useMemo(
        () => ({ position: 'absolute' as const, top: 0, bottom: 0, right: 0, width: DECK_PEEK }),
        [],
    );

    // zIndex（state 驱动，铁律不走动画值）：静止时前层 2 / 后层 1；换位中
    // 让位给正在滑向前位的层（incoming on top，deck.tsx swap 先翻 zIndex
    // 同语义）。XOR 恒等式：advancing ⊕ aIsFront 为真 = A 在前位。
    const aZIndex = advancing !== aIsFront ? 2 : 1;
    const bZIndex = advancing !== aIsFront ? 1 : 2;

    // 防御性回退（置于全部 hook 之后：条件 return 不得跨越 hook 调用；
    // buildRenderUnits 保证 deck 单元 ≥2 张，实际不可达，仅兜底防击穿）
    if (itemCount === 0) return null;
    if (itemCount === 1) {
        // 成组条件被并发变更击穿时按单张独立渲染（与 single 路径同款）
        return <MediaImage media={items[0].media} />;
    }

    return (
        <View>
            <View
                className="relative"
                style={groupHeight > 0 ? { height: groupHeight } : undefined}
                onLayout={(event) => {
                    const width = event.nativeEvent.layout.width;
                    // 亚像素抖动丢弃（旋转/分栏断点切换才有真实变化）
                    setContainerWidth((current) =>
                        Math.abs(current - width) < 0.5 ? current : width,
                    );
                }}
            >
                {/* 层 A：普通 wrapper（静态几何 + state 驱动 zIndex）→
                    AnimatedSlot（flex:1 + transform/opacity，静态布局 key 全
                    收口在 wrapper，deck 铁律）→ 内容。前位 = 前卡按压体
                    （MediaImage 本体，零 className）；后位 = 纯视觉层，整层
                    pointerEvents none（露条换位是独立按压体，后层不参与触摸
                    ——deck 的「卡内按压体让位」语义由整层 none 直接达成） */}
                <View style={[slot, { zIndex: aZIndex }]}>
                    <DeckAnimatedSlot style={[{ flex: 1 }, aStyle]}>
                        {aIsFront ? (
                            <MediaImage
                                media={frontItem.media}
                                onBlockAction={
                                    editable ? () => onBlockAction(frontItem.block.id) : undefined
                                }
                            />
                        ) : (
                            <View pointerEvents="none">
                                <MediaImage media={backItem.media} />
                            </View>
                        )}
                    </DeckAnimatedSlot>
                </View>
                {/* 层 B（与 A 同构，指派镜像）：见上层注 */}
                <View style={[slot, { zIndex: bZIndex }]}>
                    <DeckAnimatedSlot style={[{ flex: 1 }, bStyle]}>
                        {aIsFront ? (
                            <View pointerEvents="none">
                                <MediaImage media={backItem.media} />
                            </View>
                        ) : (
                            <MediaImage
                                media={frontItem.media}
                                onBlockAction={
                                    editable ? () => onBlockAction(frontItem.block.id) : undefined
                                }
                            />
                        )}
                    </DeckAnimatedSlot>
                </View>
                {/* 露条按压体：右缘全高（宽 DECK_PEEK × 组高），点它换位；无
                    按压视觉（deck 触摸面纯净铁律，卡体零 className 同源）；
                    与前卡主体命中区不重叠（前层槽位 right=PEEK 收口于露条
                    左缘）。zIndex 3 恒最高：换位动画期间前后卡滑经露条区时
                    点击仍归换位体（吞于 advancing 闩），无死区 */}
                <View style={[stripSlot, { zIndex: 3 }]}>
                    <Pressable
                        onPress={advance}
                        style={{ flex: 1 }}
                        accessibilityRole="button"
                        accessibilityLabel="切换到下一张图片"
                    />
                </View>
            </View>
            {/* 露条计数（current+1/N）：露条正下方同右缘——muted 灰叠照片不可读
                （露条本体是下一张照片边缘，底色不可控，上轮已归档结论），落页
                底可读且克制（12px muted tabular-nums，无 pill chrome）；换位
                收口后才更新（随 safeIndex，与前卡内容同步） */}
            {containerWidth > 0 ? (
                <View className="mt-1 flex-row justify-end">
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
