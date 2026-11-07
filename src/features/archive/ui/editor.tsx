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
 *   表值 16dp——堆底计数行收口尾部、行内零空气，堆后不再多出 8~16dp
 *   视觉空隙（节奏调优修复面，几何核算见 DECK_COUNTER_LINE 注）；
 * - 块模型自上而下：文本段（自动增高、可聚焦续写）与行内媒体（图/视频/音频）混排，
 *   媒体插入即显示 pending 占位（上传中不阻塞继续写字）；
 * - 连续图片照片堆（渲染层合并，数据仍是独立块）：连续相邻的图片媒体块
 *   （中间无文本/视频/音频/pending 打断）≥2 张合并为「花瓣堆叠」照片堆
 *   （ImageDeckStack v6）——中卡 = 自然比例自适应图片（宽 = 列宽 66%，
 *   高按中卡图自然宽高比派生 + MEDIA_MAX_HEIGHT 封顶，超限 cover 裁切）；
 *   左右两张邻卡像花瓣一样与中卡同 frame、z 恒在中卡之下，tx = ∓半张
 *   卡宽：恰一半藏进中卡底下、一半露在中卡外侧（露出带 = 列宽 17%，列缘
 *   overflow-hidden 裁掉越出容器部分，画布无横向出血；cover 渲染真实
 *   相邻图内容），+ translateY 12 微降错位 + scale 0.97 + 轻降透明 0.9
 *   （无阴影设计下花瓣/中卡的分层全靠这三样）；3 张起左右都有，2 张时
 *   只有右侧（左花瓣空缺）；中卡横滑换位（PanResponder 方向锁：|dx|>10
 *   且 |dx|>1.5|dy| 才认领——画布纵滚零仲裁；|dx|>60 提交真转场、否则
 *   spring 回弹；左滑 = 下一张 / 右滑 = 上一张，循环），点花瓣 = 切换
 *   到该张（露出区点按体，命中区以中卡 frame 为界、零重叠零 hitSlop），
 *   点中卡 → 全屏预览，长按中卡 → 该图操作卡（既有 onBlockAction 链）；
 *   拖拽过方向锁后 responder 仲裁自然取消点按（拖拽期间不误开全屏）。
 *   换位 = 花瓣真转场（中卡沿换位方向滑出列缘 + 降透明 timing 220ms，
 *   dir 侧花瓣自位形 spring 滑入中位 ~230ms——花瓣恒在中卡之下，随出卡
 *   让位逐步「揭开」，240ms 统一收口 + 索引轮转三槽内容重指派；滑动与
 *   点花瓣两条提交链路共用同一条编排，转场期间 advancing 闩吞并发手势；
 *   transform/opacity，native driver；详见 ImageDeckStack 注）。分组纯派生
 *   （buildRenderUnits），组内增删/移动自动重算，剩 1 张自动解散回独立
 *   自适应渲染（零改动）；pending 占位不进堆叠；性能口径 = 任意 N 最多
 *   挂载 3 个图片实例（左/中/右三槽，N=2 时左槽不渲染恒 2 个；转场不增
 *   实例——花瓣复用本槽渲染位，内容零切换），其余留在 blocks 数据里，
 *   换位只是索引轮转（数量无上限）；
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
/* 照片堆（花瓣堆叠）中卡档位、花瓣位形与转场常量（一处收口）            */
/* ------------------------------------------------------------------ */

/**
 * 中卡宽档位（列宽比例，62-70% 档取 66% 中值）：中卡 = 自然比例自适应图
 * （高按中卡图自然宽高比派生、MEDIA_MAX_HEIGHT 封顶），两侧各留
 * (列宽 − 中卡宽) / 2 = 17% 列宽的花瓣露出带——足够辨认花瓣图主体，
 * 中卡又不失主体体量。中卡高与换张尺寸跳变的取舍见 ImageDeckStack 注
 * （v6 以自然比例取代 v5 固定 16:10：单卡观感与单张路径一致优先）。
 */
const DECK_FRONT_WIDTH_RATIO = 0.66;

/** 花瓣位形（微降错位）：tx = ∓半张卡宽（花瓣槽与中卡同 frame，偏移后
 *  恰一半藏进中卡底下、一半露在外侧，几何自洽见 ImageDeckStack 注）+
 *  translateY +12（12-16 档取下限，下移错位露出底缘落差）+ scale 0.97
 *  （微收，深度线索）+ 轻降透明 0.9（层级压暗）——无阴影设计下花瓣/
 *  中卡的分层全靠这三样，滑入中位时 spring 回 1/0/1；花瓣渲染区越出
 *  容器缘的部分由容器 overflow-hidden 裁切（画布无横向出血）。 */
const DECK_PETAL_SCALE = 0.97;
const DECK_PETAL_DROP = 12;
const DECK_PETAL_OPACITY = 0.9;
/** 计数行高（dp）：「current+1/N」锚定在卡区下缘的独立行（12px 字配
 *  16dp 行，2dp 网格）；堆容器高 = 中卡高 + 花瓣下移带(12) + 计数行(16)。 */
const DECK_COUNTER_LINE = 16;
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
/** 出卡滑出时长（ms，timing ease-out）：沿拖拽方向滑到列宽 + 越缘余量，
 *  overflow-hidden 裁切 + 降透明，220ms 收住不拖沓。 */
const SWIPE_EXIT_MS = 220;
/** 转场统一收口 deadline（ms）：出卡 220ms timing 与入卡 spring（~230ms
 *  到位）都完成后 snap 复位 + 提交索引轮转；总时长 ≤350ms 预算内。 */
const ADVANCE_TOTAL_MS = 240;
/** 出卡滑出的越缘余量（dp）：滑到列宽 + 余量保证整卡完全离开
 *  overflow-hidden 容器，收口帧复位换内容不可见。 */
const DECK_EXIT_MARGIN = 40;
/** 花瓣滑入中位 spring：deck.tsx 的 friction 8/tension 40 对跨侧位行程要
 *  ~460ms 才到位（超 350ms 预算）——提张力到 150（ζ≈0.61，保留轻过冲的
 *  「落定」手感），~230ms 到位、240ms 收口（v6 行程 = 半张卡宽，比 v5 侧位
 *  行程更短，到位更早、deadline 仍从容）。 */
const DECK_RISE_TENSION = 150;
const DECK_RISE_FRICTION = 15;

/**
 * 堆叠中卡（当前图）：几何由 ImageDeckStack 数值化后传入显式宽高（自然
 * 比例 + MEDIA_MAX_HEIGHT 封顶——组高与点按体 frame 都依赖数值高，不借助
 * yoga 的 aspectRatio 收敛，cover 裁切结果与 yoga 口径恒等）。交互链 =
 * 既有口径：点按 → requestViewer 全屏（键盘先收）、长按/桌面双击 →
 * onBlockAction 操作卡（useBlockActionGestures 单点收口）。横滑拖拽不在
 * 此层——PanResponder 挂在宿主手势面 wrapper（见 ImageDeckStack 注：父级
 * 方向锁认领后 responder 仲裁自然终止点按）。触摸面零 className（deck
 * 触摸面纯净铁律：按压体不落 className，防 css-interop 按压 observable
 * 注入手势窗口）。
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
 * 花瓣卡体（左右邻卡卡体）：与中卡同尺寸的整卡渲染（同 frame + cover 裁切，
 * 露出的是真实相邻图内容、不是窄边条占位），位形（tx 半卡偏移/微收/下移/
 * 降透明）由宿主层的 AnimatedSlot 恒挂通道施加——静止时约一半藏在中卡
 * 底下（z 恒在中卡之下）、露出带越出容器缘被 overflow-hidden 裁切形成
 * 「部分可见」（容器内可见宽 = 列宽 17%）；转场时它即滑入卡卡体（tx ∓
 * 半卡宽 → 0 的 spring 由宿主 AnimatedSlot 驱动，随中卡滑出让位逐步揭开）。
 * 零交互纯视觉，无按压体：点按命中由宿主的露出区点按体承担（视觉面与
 * 命中面分离——双按压体叠命中区只会互相抢，且命中面要覆盖露出带而非
 * 整卡 frame）；图片未就绪时保持 raised 占位底（露出带放不下失败文案）。
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
 * 连续图片照片堆（v6 花瓣堆叠：自然比例中卡 + 左右花瓣半嵌 + 换位真转场）。
 *
 * 几何（组容器 relative overflow-hidden，宽 = 列宽 onLayout 量取，高 =
 * 中卡高 + DECK_PETAL_DROP(12) + DECK_COUNTER_LINE(16)；overflow-hidden 是
 * 横滑与花瓣「部分可见」的实现基础——花瓣越出容器缘的部分与滑出的出卡
 * 都被列缘裁切，不出血到画布留白）：
 *   中卡：宽 C = 列宽 × 66%（62-70% 档中值，居中 frame left = 列宽×17%），
 *       高 = min(C ÷ 自然比例, MEDIA_MAX_HEIGHT)——自然比例 = 中卡图落库
 *       宽高比（缺元数据回退 4:3，与 MediaImage 同源取 FALLBACK_IMAGE_
 *       RATIO；显式数值宽高 + cover 裁切，组高与点按体 frame 都依赖数值
 *       高）。v6 以自然比例取代 v5 固定 16:10：中卡观感与单张路径一致
 *       优先；代价 = 换张（索引轮转）时组高随新中卡比例变化，转场收口帧
 *       单次 reflow（transform/opacity 白名单内无高度动画通道，接受此
 *       跳变，见换位状态机注）；
 *   三槽同 frame：中卡槽 / 左花瓣槽 / 右花瓣槽共用同一 frame（统一槽 +
 *       transform 位形，deck 铁律「静态几何全在普通 wrapper」）——花瓣
 *       tx = ∓C/2（DECK_PETAL_* 位形）：scale 0.97 围绕布局中心微收
 *       0.015C（translate 是纯平移、不缩放位移量，矩阵序见 leftSlotStyle
 *       注），花瓣渲染缘恰越过中卡缘半张卡宽——一半藏进中卡底下、一半
 *       露在中卡外侧（几何自洽：petalShift = C/2，露出带 = 列宽×17%，
 *       越出容器的越缘半段由列缘裁掉）；
 *   花瓣位形：tx ∓C/2 + ty 12 + scale 0.97 + opacity 0.9（微降错位 +
 *       微收 + 层级压暗，无阴影设计下的三层深度线索）；N=2 时左槽不渲染
 *       （只有右侧花瓣，左侧空）；
 *   计数行：卡区下缘（横向锚定中卡两缘、右对齐），top = 中卡高 + 12
 *       （花瓣下移带之下，与花瓣渲染底不重叠）。
 *
 * 层级 zIndex（全静态常量，一律不进动画值）：花瓣槽 2 < 中卡槽 3 < 露出
 * 区点按体 4。v6 花瓣与中卡静止时同 frame 重叠，v5 的「转场滑入槽提层
 * 4」在此几何下会穿帮（提层瞬间藏在底下的半张花瓣突然浮上中卡）——故
 * 花瓣恒在中卡之下（z 不翻转），转场「揭开」语义由中卡滑出让位承担；
 * 点按体 zIndex 4：命中测试先于满宽手势面——露出带触点直达点按体（点按
 * 体为透明纯命中面，不遮花瓣视觉），横滑 move 后 PanResponder 再仲裁
 * 夺取（点按/滑动手顺与 v4/v5 同源）；计数行 frame 在点按体与卡槽之外，
 * 不参与 z 仲裁。
 *
 * 交互链路（既有口径）：点中卡 → requestViewer 全屏（键盘先收）；长按/
 * 桌面双击中卡 → onBlockAction 操作卡（useBlockActionGestures 单点收口）；
 * 点左/右花瓣露出区 → 上一张/下一张（命中区以中卡 frame 为界零重叠、
 * 零 hitSlop）；中卡横滑 = PanResponder 方向锁（|dx|>10 且 |dx|>1.5|dy|
 * 才认领，画布纵滚零仲裁）+ 提交阈值（|dx|>60）——手势面 = 满宽卡区
 * （自中卡与两侧露出带起手都可横滑）。转场期间 advancing 闩吞并发手势
 * （方向锁不认领、点按体无效、中卡交互闸关闭；长按链路提交的是操作卡
 * 不动堆，无转场面）。
 *
 * 换位状态机 v6（滑/点两条提交链路收口到同一条编排）：
 * - 统一编排 beginAdvance(dir)：中卡（出卡层，内容不换）沿换位方向
 *   frontX timing 220ms 滑出列缘（透明度走 xFade 的 |x|>列宽区段 0.72→0，
 *   与拖拽下限同一条插值）+ dir 侧花瓣四值 spring 滑入中位（tx ∓C/2 → 0、
 *   ty 12 → 0、scale 0.97 → 1、opacity 0.9 → 1；花瓣在中卡之下，随出卡
 *   让位逐步揭开）；240ms deadline 统一收口（finishAdvance：全值 snap
 *   复位 + advancing 闩释放 + 索引轮转，同批 React 提交零闪帧——花瓣
 *   终态与轮转后中卡静止帧像素恒等）；
 * - 滑动提交：方向锁认领后 Animated.event 跟手写 frontX（仅中卡跟手——
 *   花瓣是「堆叠在场」的静态语义，转场才入场，拖拽视差属锦上添花不做，
 *   保住「动画图零重建 + 手势窗口最小 native 扰动」口径），松手 |dx|>60 →
 *   commitSwipe = beginAdvance(dir)（出卡 timing 从当前拖拽位移续走）；
 * - 点花瓣提交：beginAdvance(±1)——出卡 timing 从 0 起走，同一编排。
 *   v5 点侧卡不动中卡、靠滑入槽提层盖住旧中卡；v6 花瓣静止时半张藏在中
 *   卡下，不滑出中卡则「揭开」无从发生（提层又会穿帮）——故点花瓣同样
 *   走出卡滑出，滑/点观感一致（转场决策，已在上文 z 段说明取舍）；
 * - 回弹：|dx|≤60 或手势被系统夺走（terminate）→ 仅 frontX spring 归 0
 *   （friction 8），索引不动、闩不介入（回弹中途可被下一轮拖拽接管）；
 * - 收口内容重指派（收口帧一次发生，全部「像素恒等接管」或「原生缓存
 *   秒回」）：中卡 ← 旧 dir 侧邻卡（滑入花瓣终态渲染像素恒等接管）；另
 *   一侧花瓣 ← 旧中卡（刚在出卡层渲染过，原生 Image 缓存秒回）；滑入
 *   花瓣 snap 回位形并 ← 新 dir 侧邻卡（N=3 时 = 刚离场的另一侧花瓣，
 *   秒回；N≥4 未渲染过，至多一帧 raised 占位——仅 17% 列宽压暗露出带）；
 *   同帧中卡比例换挡 → 组高/三槽尺寸按新中卡图自然比例重派生（单次
 *   reflow，自然比例口径的固有代价）；
 * - N=2 退化：左花瓣空缺（左槽/左点按体不渲染，prev 与 next 同图），
 *   dir=−1（上一张）无左花瓣可滑入 → 与 dir=+1 同编排（中卡沿换位方向
 *   滑出 + 右花瓣滑入中位），出卡方向仍沿换位方向，视觉语义一致。
 *
 * 动画口径：RN Animated native driver，style 只 transform/opacity；拖拽
 * 跟手 = Animated.event([null, {dx}])（JS responder 事件映射，useNative
 * Driver: false 是 PanResponder 场景唯一合法值，native driver 由挂载方
 * 承担）；左右两槽各挂一组恒定入卡通道（静止值 = 花瓣位形基准，不按
 * advance 条件切换样式挂载），插值节点 useMemo 固定——任意重渲不重建
 * native 动画图（deck.tsx #9 教训），仅列宽变化（旋转/分栏）时锚定基准
 * 重设。
 *
 * 性能口径：任意 N 最多挂载 3 个图片实例（左/中/右三槽，N=2 恒 2 个），
 * 转场不增实例（无第四渲染位——滑入花瓣复用本槽渲染位，内容零切换），
 * 其余留在 blocks 数据里，换位只是索引轮转（数量无上限）；组内单删/移动
 * → buildRenderUnits 重派生（clamp/解散免费获得），deck 实例按组首块 id
 * 做 key，组首块被删即重挂回第 1 张。与画布纵滚正交：方向锁保证横向意图
 * 才认领手势，纵滚零仲裁。
 */

/** 转场描述：dir = 换位方向（+1 下一张 / −1 上一张）。滑入花瓣内容 =
 *  渲染派生值（dir 侧邻卡，本就在渲染中，零切换）；收口帧索引轮转后三槽
 *  内容随派生同帧重指派，无需携带 media。 */
interface DeckAdvance {
    dir: 1 | -1;
}

function ImageDeckStack({
    items,
    editable,
    onBlockAction,
}: {
    items: Array<{ block: JournalMediaBlock; media: JournalMediaRow; index: number }>;
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

    // 中卡索引（clamp 后派生，组收缩不越界）
    const safeIndex = Math.min(Math.max(frontIndex, 0), itemCount - 1);

    // 中卡条目（clamp 后取数；中卡/花瓣几何都由它的自然比例派生）
    const frontItem = items[safeIndex];

    // 动画值：frontX = 中卡横滑（拖拽跟手 + 出卡滑出 + 回弹收口）；左右各
    // 一组入卡通道（tx/scale/ty/opacity）恒挂两侧花瓣槽——静止值 = 花瓣
    // 位形基准，转场时对应组 spring 到中位（不按 advance 条件切换样式挂载，
    // 任意重渲不重建 native 动画图，deck.tsx #9 教训）
    const frontX = useRef(new Animated.Value(0)).current;
    const leftTx = useRef(new Animated.Value(0)).current;
    const leftScale = useRef(new Animated.Value(DECK_PETAL_SCALE)).current;
    const leftTy = useRef(new Animated.Value(DECK_PETAL_DROP)).current;
    const leftOpacity = useRef(new Animated.Value(DECK_PETAL_OPACITY)).current;
    const rightTx = useRef(new Animated.Value(0)).current;
    const rightScale = useRef(new Animated.Value(DECK_PETAL_SCALE)).current;
    const rightTy = useRef(new Animated.Value(DECK_PETAL_DROP)).current;
    const rightOpacity = useRef(new Animated.Value(DECK_PETAL_OPACITY)).current;

    // 几何派生（全部由列宽 + 中卡图自然比例单点导出；量取前 cardWidth 为
    // 0 → 槽不渲染）：
    //   cardWidth = 中卡宽 = 列宽 × 66%（62-70% 档中值，居中）；
    //   frontRatio = 中卡图自然宽高比（落库宽高优先，缺元数据回退 4:3，与
    //       MediaImage 同源取 FALLBACK_IMAGE_RATIO）；
    //   deckHeight = 中卡高 = min(中卡宽 ÷ 自然比例, MEDIA_MAX_HEIGHT)——
    //       自然比例自适应（v6 口径；显式数值宽高 + cover 裁切，组高与点按
    //       体 frame 都依赖数值高）；
    //   petalShift = 花瓣横向偏移 = 半张中卡宽：花瓣槽与中卡同 frame，tx
    //       ∓petalShift 后花瓣渲染缘恰越过中卡缘半张卡宽——一半藏进中卡
    //       底下、一半露在中卡外侧（scale 0.97 围绕布局中心微收 0.015C，
    //       translate 是纯平移、不缩放位移量，矩阵序见 leftSlotStyle 注）；
    //   stripWidth = 花瓣露出带宽 = (列宽 − 中卡宽) / 2 = 容器内花瓣可见宽
    //       （越出容器的越缘半段被列缘裁掉，画布无横向出血），亦是侧点按
    //       体宽度（命中区以中卡 frame 为界）。
    const cardWidth = containerWidth * DECK_FRONT_WIDTH_RATIO;
    const frontRatio =
        frontItem && frontItem.media.width && frontItem.media.height
            ? frontItem.media.width / frontItem.media.height
            : FALLBACK_IMAGE_RATIO;
    const deckHeight =
        cardWidth > 0 ? Math.min(cardWidth / frontRatio, MEDIA_MAX_HEIGHT) : 0;
    const petalShift = cardWidth / 2;
    const stripWidth = (containerWidth - cardWidth) / 2;

    useEffect(() => {
        // 挂载/列宽变化即锚定基准位（deck.tsx 同款防御：实例复用/Strict 下
        // 不残留旧值）；转场中不重设（收口 snap 按最新 petalShift 兜底）
        frontX.setValue(0);
        if (advancingRef.current) return;
        leftTx.setValue(-petalShift);
        leftScale.setValue(DECK_PETAL_SCALE);
        leftTy.setValue(DECK_PETAL_DROP);
        leftOpacity.setValue(DECK_PETAL_OPACITY);
        rightTx.setValue(petalShift);
        rightScale.setValue(DECK_PETAL_SCALE);
        rightTy.setValue(DECK_PETAL_DROP);
        rightOpacity.setValue(DECK_PETAL_OPACITY);
    }, [
        frontX,
        leftTx,
        leftScale,
        leftTy,
        leftOpacity,
        rightTx,
        rightScale,
        rightTy,
        rightOpacity,
        petalShift,
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
    // 索引轮转，同一事件帧内全部落地（滑入花瓣终态与轮转后中卡静止帧像素
    // 恒等，复位换内容不可见——出卡此时已完全滑出 overflow-hidden 容器；
    // 三槽内容随轮转同帧重指派，同帧组高按新中卡自然比例重派生（单次
    // reflow），可能的一帧边条占位口径见组件注「收口内容重指派」）
    const finishAdvance = useCallback(
        (dir: 1 | -1) => {
            advanceTimerRef.current = null;
            // snap 前先停在飞动画，防其覆写复位值（出卡 timing 220ms 已结束）
            frontX.stopAnimation();
            frontX.setValue(0);
            // 左右两组通道全部 snap 回花瓣位形基准（无论哪组在飞——复位幂等）
            leftTx.stopAnimation();
            leftTx.setValue(-petalShift);
            leftScale.stopAnimation();
            leftScale.setValue(DECK_PETAL_SCALE);
            leftTy.stopAnimation();
            leftTy.setValue(DECK_PETAL_DROP);
            leftOpacity.stopAnimation();
            leftOpacity.setValue(DECK_PETAL_OPACITY);
            rightTx.stopAnimation();
            rightTx.setValue(petalShift);
            rightScale.stopAnimation();
            rightScale.setValue(DECK_PETAL_SCALE);
            rightTy.stopAnimation();
            rightTy.setValue(DECK_PETAL_DROP);
            rightOpacity.stopAnimation();
            rightOpacity.setValue(DECK_PETAL_OPACITY);
            advancingRef.current = false;
            setAdvance(null);
            rotateIndex(dir);
        },
        [
            frontX,
            leftTx,
            leftScale,
            leftTy,
            leftOpacity,
            rightTx,
            rightScale,
            rightTy,
            rightOpacity,
            petalShift,
            rotateIndex,
        ],
    );

    // 转场起手（滑动/点花瓣提交共用同一条编排，见组件注「换位状态机 v6」）：
    // dir 侧花瓣四值 spring 滑到中位（花瓣 z 恒在中卡之下，不提层——v6 几何
    // 静止重叠下提层会穿帮，「揭开」由出卡滑出让位承担）+ 中卡沿换位方向
    // timing 滑出列缘 + advancing 闩 + deadline 收口。
    // 滑入花瓣槽选择：N≥3 按方向取 dir 侧邻卡所在槽（内容 = 渲染派生值，本就
    // 在渲染中，零切换零闪）；N=2 恒右槽（左侧空无从滑入，右卡内容即上一
    // 张——退化编排见组件注）。出卡 timing 起点即 frontX 当前值：滑动提交
    // 从拖拽位移续走、点花瓣提交从 0 起走——总观感 = 旧卡沿换位方向滑走、
    // 新花瓣自底下滑入中位补位
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
            // 四值同参数 spring 收口中位（tx/ty 归零、scale/opacity 归 1）
            const springToCenter = (value: Animated.Value, toValue: number) =>
                Animated.spring(value, {
                    toValue,
                    friction: DECK_RISE_FRICTION,
                    tension: DECK_RISE_TENSION,
                    useNativeDriver: true,
                });
            if (dir === 1 || list.length < 3) {
                // 右花瓣滑入（下一张；N=2 的双向退化编排）
                Animated.parallel([
                    springToCenter(rightTx, 0),
                    springToCenter(rightScale, 1),
                    springToCenter(rightTy, 0),
                    springToCenter(rightOpacity, 1),
                ]).start();
            } else {
                // 左花瓣滑入（上一张）
                Animated.parallel([
                    springToCenter(leftTx, 0),
                    springToCenter(leftScale, 1),
                    springToCenter(leftTy, 0),
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
                easing: Easing.out(Easing.cubic),
                useNativeDriver: true,
            }).start();
            advanceTimerRef.current = setTimeout(() => finishAdvance(dir), ADVANCE_TOTAL_MS);
        },
        [
            frontX,
            containerWidth,
            leftTx,
            leftScale,
            leftTy,
            leftOpacity,
            rightTx,
            rightScale,
            rightTy,
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

    // 点花瓣 = 切换到该张（左 = 上一张、右 = 下一张，循环）：同一编排
    // （中卡滑出让位 + 花瓣自底下滑入，见 beginAdvance 注）；转场期间闩吞
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

    // 中卡动效样式（deck.tsx useSlotStyle 同款插值口径）：translateX + xFade
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

    // 花瓣槽动效样式（恒挂左右两组入卡通道；静止 = 花瓣位形基准 tx ∓
    // petalShift / scale 0.97 / ty 12 / opacity 0.9，转场 = 对应组 spring
    // 到中位；transform/opacity 白名单键，deck 铁律）。transform 数组序
    // [tx, ty, scale] 语义 = RN 矩阵按序右乘（最后项先作用）：scale 围绕
    // 布局中心微收、translate 是纯平移不缩放位移量——花瓣渲染缘越过中卡
    // 缘恰半张卡宽、露出带 = stripWidth 的几何自洽依赖此序（petalShift
    // 推导见几何派生注）
    const leftSlotStyle = useMemo(
        () => ({
            transform: [{ translateX: leftTx }, { translateY: leftTy }, { scale: leftScale }],
            opacity: leftOpacity,
        }),
        [leftTx, leftTy, leftScale, leftOpacity],
    );
    const rightSlotStyle = useMemo(
        () => ({
            transform: [{ translateX: rightTx }, { translateY: rightTy }, { scale: rightScale }],
            opacity: rightOpacity,
        }),
        [rightTx, rightTy, rightScale, rightOpacity],
    );

    // 卡槽 frame（deck.tsx 同款「静态几何全在普通 wrapper」铁律）：三槽同
    // frame（中卡/左右花瓣同宽同高，left 锚定中位居中），花瓣位全由
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
    // 手势面 frame：满宽卡区（横滑起手覆盖中卡与两侧露出带；花瓣露出区
    // 点按体 zIndex 4 先于本面命中，见组件注层级段）
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
    // 花瓣露出区点按体 frame：中卡 frame 以外的露出带（命中区以中卡 frame
    // 为界零重叠，几何即命中零 hitSlop）——左 [0, stripWidth] / 右
    // [W−stripWidth, W]，纵向覆盖整卡区（含花瓣下移露出的 12dp 底带，点按
    // 语义连续无死区）；左右共用同一尺寸，锚定边在 JSX 处给
    const sidePressSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: 0,
            width: stripWidth,
            height: deckHeight + DECK_PETAL_DROP,
        }),
        [stripWidth, deckHeight],
    );
    // 计数行 frame：卡区下缘——top = 中卡高 + 花瓣下移带（与花瓣渲染底
    // 不重叠），横向锚定中卡两缘、内容右对齐（行落在中卡 frame 之内）
    const counterSlot = useMemo(
        () => ({
            position: 'absolute' as const,
            top: deckHeight + DECK_PETAL_DROP,
            left: stripWidth,
            right: stripWidth,
            height: DECK_COUNTER_LINE,
        }),
        [deckHeight, stripWidth],
    );

    // 防御性回退（置于全部 hook 之后：条件 return 不得跨越 hook 调用；
    // buildRenderUnits 保证 deck 单元 ≥2 张，实际不可达，仅兜底防击穿）
    if (itemCount === 0) return null;
    if (itemCount === 1) {
        // 成组条件被并发变更击穿时按单张独立渲染（与 single 路径同款自适应）
        return <MediaImage media={items[0].media} />;
    }

    // 三槽取数（循环遍历）：左 = 上一张（N≥3 才有——2 张时 prev 与 next 同
    // 图，用户口径左侧空、只有右侧花瓣）、中 = 当前、右 = 下一张
    const leftItem = itemCount >= 3 ? items[(safeIndex - 1 + itemCount) % itemCount] : null;
    const rightItem = items[(safeIndex + 1) % itemCount];

    return (
        <View
            className="relative overflow-hidden"
            style={
                deckHeight > 0
                    ? { height: deckHeight + DECK_PETAL_DROP + DECK_COUNTER_LINE }
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
            {/* 左花瓣槽 = 上一张（zIndex 2 恒定，花瓣恒在中卡之下——v6 静止
                重叠几何下转场提层会穿帮，见组件注层级段）：普通 wrapper
                （静态几何 + pointerEvents none）→ AnimatedSlot（tx/ty/scale/
                opacity 恒挂 left 通道，静止 = 花瓣位形基准 tx −C/2，一半藏
                进中卡底下、越出容器左缘部分被裁形成部分可见）→ 花瓣卡体；
                N=2 不渲染（左花瓣空缺，只有右侧） */}
            {deckHeight > 0 && leftItem ? (
                <View style={[cardSlot, { zIndex: 2 }]} pointerEvents="none">
                    <DeckAnimatedSlot style={[{ flex: 1 }, leftSlotStyle]}>
                        <DeckEdgeCard
                            media={leftItem.media}
                            width={cardWidth}
                            height={deckHeight}
                        />
                    </DeckAnimatedSlot>
                </View>
            ) : null}
            {/* 右花瓣槽 = 下一张（zIndex 2 恒定，left 槽位形镜像）：right 通道
                恒挂，转场时即滑入卡卡体（内容零切换，本就渲染目标图） */}
            {deckHeight > 0 && rightItem ? (
                <View style={[cardSlot, { zIndex: 2 }]} pointerEvents="none">
                    <DeckAnimatedSlot style={[{ flex: 1 }, rightSlotStyle]}>
                        <DeckEdgeCard
                            media={rightItem.media}
                            width={cardWidth}
                            height={deckHeight}
                        />
                    </DeckAnimatedSlot>
                </View>
            ) : null}
            {/* 中卡层（zIndex 3，恒在花瓣之上）：满宽普通 wrapper（PanResponder
                方向锁挂此，手势面 = 满宽卡区；静态布局 key 收口在内层中卡
                frame wrapper，deck 铁律）→ 中卡 frame wrapper → AnimatedSlot
                （flex:1 + translateX/xFade，出卡滑出复用此层）→ 中卡卡体
                （点全屏 + 长按操作卡，既有链；转场期间 interactive 闸关闭；
                触摸面零 className 收口在 DeckFrontCard） */}
            <View style={[gestureSlot, { zIndex: 3 }]} {...panResponder.panHandlers}>
                <View style={cardSlot}>
                    <DeckAnimatedSlot style={[{ flex: 1 }, frontStyle]}>
                        {frontItem && deckHeight > 0 ? (
                            <DeckFrontCard
                                media={frontItem.media}
                                width={cardWidth}
                                height={deckHeight}
                                interactive={advance == null}
                                onBlockAction={
                                    editable ? () => onBlockAction(frontItem.block.id) : undefined
                                }
                            />
                        ) : null}
                    </DeckAnimatedSlot>
                </View>
            </View>
            {/* 花瓣露出区点按体（zIndex 4，命中测试先于满宽手势面；透明纯
                命中面不遮花瓣视觉）：中卡 frame 以外的露出带（命中区以中卡
                frame 为界零重叠，几何即命中零 hitSlop）——点左 = 上一张、
                点右 = 下一张（循环，转场期间闩吞并发）；N=2 无左点按体
                （左花瓣空缺） */}
            {deckHeight > 0 && leftItem ? (
                <Pressable
                    onPress={tapPrev}
                    style={[sidePressSlot, { zIndex: 4, left: 0 }]}
                    accessibilityRole="button"
                    accessibilityLabel="查看上一张"
                />
            ) : null}
            {deckHeight > 0 && rightItem ? (
                <Pressable
                    onPress={tapNext}
                    style={[sidePressSlot, { zIndex: 4, right: 0 }]}
                    accessibilityRole="button"
                    accessibilityLabel="查看下一张"
                />
            ) : null}
            {/* 计数（current+1/N）：容器下缘（卡区之下）——top = 中卡高 +
                花瓣下移带（独立于卡区的行，与花瓣渲染底不重叠），横向锚定
                中卡两缘、右对齐；堆后视觉净空 = 组 margin + 栈 gap 与堆前
                对称（节奏表 16dp），行高把三端文字行高差（±2px）吃进行内，
                不污染块间净空。muted 12px tabular-nums、无 pill chrome
                （克制口径）；pointerEvents none 不参与命中；无障碍语义 =
                读屏直读计数（点按体拆为上一张/下一张两个，不再有单一
                「下一张」label 可并入） */}
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
