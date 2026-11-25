import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
    ActivityIndicator,
    BackHandler,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
    type GestureResponderEvent,
    type ScrollViewInstance,
} from 'react-native';
import { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
    BouncyPressable,
    createIcon,
    LucidePenLine,
    LucideRepeat2,
    LucidePlus,
    LucideTrash,
    LucideType,
} from '@/core/icons';
// 深路径注记：ChevronUp/Down 与 editor 的节奏表/画布句柄未在 ui/index.ts 出口，
// 域内深取（CloseButton 已收口进 barrel，不再深取）。
import { ChevronDownIcon, ChevronUpIcon } from './ui/editor-icons';
// 深路径注记：全局录制会话（跨页面后台录制 + 归属铁律的宿主）未在域 barrel
// 出口，域内深取（editor-icons / close-button 先例）。控制器/覆盖层/保活槽
// 都挂根层级（app/_layout 的 RecordingSessionHost），本屏只发起与展示状态。
import {
    restoreCaptureOverlay,
    startCaptureSession,
    stopCaptureSession,
    subscribeRecordingSessionPersist,
    useRecordingSessionStore,
} from './recording-session';
// 深路径注记：节奏表 / 画布句柄 / 键盘动态垫高 hook / 堆叠单元判定（findDeckUnit，
// 分组规则单一事实源 buildRenderUnits 的屏层取数口）未在 ui/index.ts 出口
//（域内深取纪律，先例同上）。
import {
    EDITOR_RHYTHM,
    findDeckUnit,
    useKeyboardCanvasBottomPadding,
    type BlockEditorHandle,
    type EditorCanvasHandle,
} from './ui/editor';
import { imagePicker } from '@/core/image-picker';
import { audio } from '@/core/audio';
import { fileStorage } from '@/core/file-storage';
import { mediaLibrary, MediaLibraryError } from '@/core/media-library';
import { videoThumbnails } from '@/core/video-thumbnails';
// 视频转 GIF 编排（M3）：抽帧 → 编码 → 存相册，失败 throw 由本屏 catch 上浮
import { convertVideoToGif } from './video-gif';
import { useArchiveRevision, useArchiveStore, aggregateSaveProgress, ensureVideoThumbnail } from './store';
import {
    dissolveStackBlocks,
    insertPendingBlock,
    isEditable,
    mergeStackBlocks,
    moveBlock,
    moveBlockRun,
    newBlockId,
    newParagraphBlock,
    parseBlocks,
    removeBlock,
    removeBlocks,
    resolvePendingBlock,
    todayEntryDate,
    wordCount,
    type JournalBlock,
} from './journal-logic';
import { formatDateParts, tripDisplayTitle } from './trip-logic';
// 计划状态派生（v11）：锁页横幅按终态分文案，禁屏内散落 status 字面量
import { isPlanFailed, planStatusLabel } from './plan-logic';
import { getJournal, getTrip, mediaByJournalIds } from './db';
import type { JournalMediaRow, JournalRow, TripRow } from './db';
import { safeBack } from './ui';
// 深路径注记：安慰话语料未在 ui/index.ts 出口（该文件不在本轮改动权限内），
// 域内深取（同 editor-icons / close-button 先例）。
import { pickComfortQuote } from './ui/comfort-quotes';
import {
    BlockEditor,
    CloseButton,
    formatAudioTime,
    InsertMenu,
    LoadingView,
    PENDING_MEDIA_ID,
    RenameCard,
    TRIP_ICON_DEFAULT,
    TripBadge,
    type InsertAction,
    usePalette,
} from './ui';

/**
 * 计划空标题的展示兜底名（v0.4.6 指令 3）：计划屏头名称位恒渲染，标题列
 * 空串/纯空白时回退此名——模式对齐 trip-logic.tripDisplayTitle 的
 * TRIP_TITLE_FALLBACK（行程卡面另有口径：行程名不上堆叠卡面，指令 4；
 * 计划名上卡面不受影响）。录制归属标签同源复用（见 journalTitleLabel 注）。
 */
export const PLAN_TITLE_FALLBACK = '未命名计划';

/**
 * 计划模式的 + 选择器行词表（v8）：全行裁「完成收笔」——收笔/24:00 是日记
 * 语义，计划不继承（schema.ts JournalKind 注）；v11 计划的标记完成/失败入口在
 * 首页计划卡长按菜单（对齐事件），编辑器是内容通道、不挂状态动作。InsertMenu
 * 的 actions 过滤
 * 机制（事件编辑器同款接线面）收敛在词表一个常量上：过滤不重排，行序仍由
 * 组件内 allRows 决定；complete 确认步随行退场不可达，runInsert 的 'complete'
 * 分支成为日常模式专属路径。
 */
const NOTE_INSERT_ACTIONS: readonly InsertAction[] = [
    'library-image',
    'library-video',
    'record',
    'photo',
    'video',
    'append-text',
];

/**
 * 多选模式状态（屏层持有，discriminated union 防两用途互串）：
 * - merge = 合并堆叠（2026-11 既有）：全媒体可选，选择顺序 = 合并落位顺序；
 * - deckDelete = 堆叠「指定删除」（2026-11-11 反馈①新增）：deckIds 白名单 =
 *   目标堆叠成员块 id（编辑器内组外媒体回常态渲染，见 BlockEditor selection
 *   的 selectableIds 注；音频成员恒不可选），勾选清单经顶栏「删除」确认。
 */
type SelectModeState =
    | { purpose: 'merge'; orderedIds: string[]; deckIds: null }
    | { purpose: 'deckDelete'; orderedIds: string[]; deckIds: ReadonlySet<string> };

/**
 * 画布底部静态垫高基线（dp）：contentContainer 底部留白给 + 浮钮让位
 * （浮钮 bottom = insets.bottom + 24 悬浮其上，不被内容顶穿）。键盘动态垫高
 * （editor 的 useKeyboardCanvasBottomPadding）以此为下限取大——垫高 ≥ 基线，
 * 静止态（键盘收起）布局与旧版逐 dp 一致。
 */
const CANVAS_BOTTOM_BASE_INSET = 96;

/* ------------------------------------------------------------------ */
/* 图标（块操作卡新增行；lucide 1.64 path 数据，createIcon 官方用法）    */
/* ------------------------------------------------------------------ */

/** 合并堆叠（块操作卡行；layers）。 */
const LayersIcon = createIcon(
    <>
        <Path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
        <Path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
        <Path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </>,
);

/** 解散堆叠（块操作卡行；ungroup）。 */
const UngroupIcon = createIcon(
    <>
        <Rect x={11} y={14} width={10} height={7} rx={2} />
        <Rect x={3} y={3} width={10} height={7} rx={2} />
    </>,
);

/** 保存到手机（块操作卡行；download）。 */
const DownloadIcon = createIcon(
    <>
        <Path d="M12 15V3" />
        <Path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <Path d="m7 10 5 5 5-5" />
    </>,
);

/** 指定删除（块操作卡行；list-checks，lucide 1.64 官方 path 数据——「进入
 *  堆叠勾选模式」的清单语义）。 */
const ListChecksIcon = createIcon(
    <>
        <Path d="M13 5h8" />
        <Path d="M13 12h8" />
        <Path d="M13 19h8" />
        <Path d="m3 17 2 2 4-4" />
        <Path d="m3 7 2 2 4-4" />
    </>,
);

/**
 * 连续日记编辑器（行程/日常通用）——三种入口：不传参 = 今天日常；
 * tripId+date = 行程某天；journalId = 直达某篇。
 *
 * **计划模式（v8 独立计划复用本编辑器，单一实现源）**：/plan/[id] 路由以
 * journalId 挂载计划行，屏内按 journal.kind === 'note' 分流（不设独立 prop
 * ——行类型即模式事实源，错传日记 id 也天然回落日记行为；journalId 载入路径
 * 本就跳过 ensureTodayJournal，计划侧零改动）：计划不参与收笔机（v8）——
 * + 选择器按 NOTE_INSERT_ACTIONS 裁「完成收笔」行、屏头「进行中/已
 * 收笔」状态位不渲染、录制归属标签无标题时落「未命名计划」而非「M月D日 日记」
 * ；重命名（updateJournalTitle 对 open 计划有效）/正文/媒体/录音按 journalId
 * 天然可用。v11 计划三态（进行/完成/失败，标记入口在首页计划卡长按菜单）：
 * 终态行 isEditable 天然为 false → 正文/媒体/改名只读，锁页横幅走计划文案
 * （「该计划已完成 / 已标记失败」，不借日记的「收笔」措辞）。日常（daily）
 * 路径行为零变化。
 *
 * 沉浸化交互承诺（#1/#6/#7，DEV.md）：
 * - 底部工具坞清空：保存状态与字数上 masthead（轻量 meta 行），底部只留
 *   一枚 + 罗盘浮钮；「完成收笔」收进 + 选择器（动作型入口统一一处），
 *   卡内确认步强调「收笔后不可再修改」；
 * - **标题编辑走屏头编辑钮**（#1 屏头同构轮；#3 回退口径）；完成后锁定
 *   （#7）：收笔/跨日即只读；
 * - **录音/拍摄全局会话（跨页面后台录制 + 归属铁律）**：采集控制器与覆盖层
 *   上收根层级（recording-session.tsx + app/_layout 的 RecordingSessionHost），
 *   本屏只负责发起（startCaptureSession 带 **ownerJournalId**——发起时编辑
 *   上下文的 journal id，ensureJournal 已保证写前有 id）与状态展示。会话
 *   不随本屏离开而中止（后台继续，任意页面可经悬浮 chip / + 菜单状态行
 *   重开）；停止产物经 DB 级 appendMediaBlockToJournal **固定落回发起计划**
 *   ——无论停止发生在哪个页面、本屏是否在栈下；owner 屏挂载时经 persist
 *   事件把产物块合并进本地 blocksRef（applyBlocks 到达序合并，随后的保存
 *   天然携带，零丢写）；非 owner 屏的 + 菜单显示状态行可「继续」，但其
 *   编辑/收笔与该会话零交互（B 的 blocks/pendingUploads 不消费 A 的产物）；
 * - **插入后台异步并行**：doAttach 同步插 pending 占位即返回，落盘+落库为
 *   后台任务（pendingUploadsRef 进程内注册表，多任务并行）；+ 菜单/插入在
 *   上传中不再禁用（picker/相机/录音一次一个的互斥保留）；「完成收笔」
 *   等待全部在途 allSettled（FAB 轻量进行态）再保存收笔；单任务失败仅该
 *   pending 回滚 + store.error；录制中可继续编辑插入（采集不阻塞编辑）；
 * - **自定义合并堆叠**：块操作卡新增「合并堆叠」（屏内图/视频 ≥2 可选）→
 *   多选模式（媒体块勾选、点按切换、屏蔽全屏/长按，音频置灰不可选，顶部
 *   选择栏「已选 N · 合并 · 取消」）→ 合并 = 物理重排成连续段 + 同 groupId
 *   （journal-logic.mergeStackBlocks）；显式组堆叠操作卡新增「解散堆叠」
 *   （dissolveStackBlocks 清 groupId——同 kind 相邻成员按默认规则重新成组）；
 * - 插入统一走 pending 占位流（异常上浮 error 且回滚占位）；updater 一律
 *   纯函数（块 id 在提交路径外预生成——#1.2）；
 * - 块操作卡（#1/#9）：媒体长按/双击、文本聚焦 ⋯ 钮 → 屏根浮层；
 * - 正文 800ms 防抖 + 失焦即存双通道。
 */
export function JournalEditScreen({
    tripId,
    date,
    journalId,
}: {
    tripId?: string;
    date?: string;
    journalId?: string;
} = {}) {
    const insets = useSafeAreaInsets();
    const revision = useArchiveRevision();
    const store = useArchiveStore;
    const error = store((s) => s.error);
    const ensureTodayJournal = store((s) => s.ensureTodayJournal);
    const ensureJournal = store((s) => s.ensureJournal);
    const palette = usePalette();

    const [journal, setJournal] = useState<JournalRow | null>(null);
    const [trip, setTrip] = useState<TripRow | null>(null);
    const [blocks, setBlocks] = useState<JournalBlock[]>([]);
    const [media, setMedia] = useState<JournalMediaRow[]>([]);
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const [focusTextId, setFocusTextId] = useState<string | null>(null);
    // 「完成收笔」等待在途上传的轻量进行态（FAB spinner）
    const [finishing, setFinishing] = useState(false);
    // 多选模式（合并堆叠 / 堆叠指定删除，见 SelectModeState 注）：orderedIds =
    // **选择顺序**的块 id 清单（合并重排按此顺序落位；指定删除即删除清单）
    const [selectMode, setSelectMode] = useState<SelectModeState | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [actionBlockId, setActionBlockId] = useState<string | null>(null);
    // 标题重命名卡（屏头编辑钮入口；与首页长按卡同语义，共享组件 ui/rename-card）
    const [renameOpen, setRenameOpen] = useState(false);

    // 画布滚动协作句柄（#12 键盘补偿）：ScrollView ref + 最近滚动位置 ref
    //（onScroll 写 ref 不触发渲染）；useMemo 固定同一对象，BlockEditor props
    // 不漂移、TextBlock 闭包捕获安全。
    const canvasRef = useRef<ScrollViewInstance>(null);
    const canvasOffsetRef = useRef(0);
    const canvas = useMemo<EditorCanvasHandle>(
        () => ({ ref: canvasRef, offsetRef: canvasOffsetRef }),
        [],
    );
    // 空白收键层的 blur 收口句柄（#K2）：画布空白 Pressable onPress →
    // dismissKeyboard（无聚焦段空点零动作的防误触闸在 BlockEditor 句柄内）
    const editorRef = useRef<BlockEditorHandle | null>(null);

    // 载入日记 + 行程上下文（失败落明确失败态可重试，不永久 spinner）：
    // getJournal/getTrip 是裸 db 调用可 reject；ensureJournal 失败也返回 null——
    // 两者若不接住，本屏会永远停在 LoadingView（错误横幅在 journal 就绪后才渲染，
    // 根本没机会显示）。卸载/重试竞态用 attempt 序号守卫，防旧响应回填。
    const [loadFailed, setLoadFailed] = useState(false);
    const loadAttemptRef = useRef(0);
    const load = useCallback(async () => {
        const attempt = ++loadAttemptRef.current;
        setLoadFailed(false);
        try {
            let row: JournalRow | null = null;
            if (journalId) {
                row = await getJournal(journalId);
            } else if (tripId || date) {
                row = await ensureJournal(tripId ?? null, date ?? todayEntryDate());
            } else {
                row = await ensureTodayJournal();
            }
            if (attempt !== loadAttemptRef.current) return;
            // row = null（日记已被删 / ensureJournal 失败后 store.error 已落文案）：
            // 同样进失败态，不能拿 null 硬撑 LoadingView
            if (!row) {
                setLoadFailed(true);
                return;
            }
            setJournal(row);
            setBlocks(parseBlocks(row.blocks));
            if (row.trip_id) {
                const tripRow = await getTrip(row.trip_id);
                if (attempt !== loadAttemptRef.current) return;
                setTrip(tripRow);
            }
        } catch (caught) {
            // 中断场景：db 调用被中断/失败（db 异常、web 非安全上下文等）必须落失败态
            if (attempt !== loadAttemptRef.current) return;
            setLoadFailed(true);
        }
    }, [journalId, tripId, date, ensureJournal, ensureTodayJournal]);

    useEffect(() => {
        void load();
        return () => {
            // 卸载即作废在途载入：setState-after-unmount 防护（序号守卫）
            loadAttemptRef.current += 1;
        };
    }, [load]);

    // 媒体行随 revision 重载
    useEffect(() => {
        if (!journal) return;
        let active = true;
        mediaByJournalIds([journal.id])
            .then((grouped) => {
                if (active) setMedia(grouped.get(journal.id) ?? []);
            })
            .catch((caught) => {
                // 中断场景：媒体行刷新 reject 不能 unhandled（红屏）；失败上浮可感知，
                // revision 变化（含下一次保存成功）会自动重试，无需手动干预
                if (active) {
                    store.setState({
                        error: `媒体列表读取失败：${caught instanceof Error ? caught.message : String(caught)}`,
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [journal, revision, store]);

    // 防抖自动保存（800ms）：跳过载入回填帧。
    // blocks/journal 同步进 ref（卸载兜底 flush / 后台链路要取最新值）；dirty
    // 标记是否有未落库改动。**blocksRef 是本屏 blocks 的权威镜像**：所有写入
    // 一律经 applyBlocks（同步写 ref 再 setState），后台落库链（在途上传回填、
    // 离开屏追加媒体块）在任意渲染时序下都基于最新值，杜绝「后写覆盖」竞态。
    const firstRender = useRef(true);
    const blocksRef = useRef(blocks);
    const journalRef = useRef(journal);
    const dirtyRef = useRef(false);
    blocksRef.current = blocks;
    journalRef.current = journal;
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }
        if (!journal || !isEditable(journal.status)) return;
        dirtyRef.current = true;
        const timer = setTimeout(() => {
            dirtyRef.current = false;
            store
                .getState()
                .saveJournalBlocks(journal.id, blocks)
                .then((saved: unknown) => {
                    // 保存失败（新契约 false）置回 dirty：卸载兜底 flush 会再补存一次
                    if (saved === false) dirtyRef.current = true;
                    else setSavedAt(Date.now());
                })
                .catch(() => {
                    // store 内部已落 error 文案；这里防 unhandled rejection 并保留待存标记
                    dirtyRef.current = true;
                });
        }, 800);
        return () => clearTimeout(timer);
    }, [blocks, journal, store]);

    /**
     * blocks 唯一写入口（ref 权威镜像 + setState）：读 ref 当前值算 next、
     * 同步回写 ref 再提交渲染——并发链路（多个在途上传同帧回填、离开屏追加、
     * 文本编辑）按到达序串行合并，不丢写；卸载后 setBlocks 被 React 静默
     * 忽略，ref 仍供后台落库链读取（纯 store/db 路径自洽）。
     */
    const applyBlocks = useCallback(
        (updater: (current: JournalBlock[]) => JournalBlock[]) => {
            const next = updater(blocksRef.current);
            blocksRef.current = next;
            setBlocks(next);
        },
        [],
    );

    // 卸载兜底 flush：防抖窗口（≤800ms）内 safeBack/dismiss 退出时补存最后一次
    // 正文，否则静默丢失；fire-and-forget 但必须 catch（卸载后无界面）。
    //（标题不在编辑器落库——编辑入口在首页计划卡重命名卡，见文件头注）
    useEffect(() => {
        return () => {
            const row = journalRef.current;
            if (row && isEditable(row.status)) {
                if (dirtyRef.current) {
                    dirtyRef.current = false;
                    store.getState().saveJournalBlocks(row.id, blocksRef.current).catch(() => {
                        // 失败文案已由 store 落 error
                    });
                }
            }
        };
    }, [store]);

    // 全局录制会话归属合并（owner 屏挂载时）：会话停录产物在媒体行建立后、
    // DB 块写入前发 persist 事件——本屏若正是发起方（ownerJournalId 匹配），
    // 先把媒体块合并进本地 blocksRef（applyBlocks 到达序合并），其后的防抖/
    // 收笔保存天然携带该块（DB 追加侧幂等，不产生重复块）。非 owner 事件
    // 一律忽略（归属铁律：B 的编辑状态与 A 的会话零耦合）。订阅随卸载摘除
    //（已卸载的 owner 屏无需合并——DB 级追加不依赖屏）。
    useEffect(() => {
        return subscribeRecordingSessionPersist((event) => {
            const row = journalRef.current;
            if (!row || event.ownerJournalId !== row.id || !isEditable(row.status)) return;
            applyBlocks((current) => {
                // 幂等闸：同一 mediaId 只合并一次（双挂载同篇/重复事件防重）
                if (current.some((block) => block.t === 'media' && block.mediaId === event.mediaId)) {
                    return current;
                }
                return [
                    ...current,
                    {
                        t: 'media' as const,
                        id: newBlockId(),
                        mediaId: event.mediaId,
                        ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
                    },
                ];
            });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- applyBlocks 稳定引用（useCallback []）
    }, []);

    // 在途媒体上传注册表（进程内 Map）：pendingId → promise——多任务并行、
    // 互不影响；完成收笔经 allSettled 等待全部收敛；任务收敛即自摘除（见
    // doAttach）。（kind 槽已随媒体数量上限移除退役——原仅供图片配额计数）
    const pendingUploadsRef = useRef(new Map<string, Promise<void>>());
    // 相册选取互斥（系统 picker 单例，防重复拉起）
    const pickingRef = useRef(false);

    // 多选模式 ref 镜像（稳定回调/返回键读取）
    const selectModeRef = useRef(selectMode);
    selectModeRef.current = selectMode;

    const editable = journal ? isEditable(journal.status) : false;
    // 计划模式判定（v8）：行 kind 即模式事实源（见文件头计划模式段）。载入前
    // 恒 false 无竞态面——+ 菜单由 FAB（editable 门控）打开、屏头分支在
    // journal 就绪后才渲染，两处消费都发生在判定为真值之后
    const isPlan = journal?.kind === 'note';
    const saving = store((s) => s.savingJournal);
    // 全局录制会话状态投影（+ 菜单状态行「录音中 0:32 · 继续」）：owner 本尊
    // 与非 owner 屏都展示（任意页面可重开），停止产物一律归发起计划
    //（ownerJournalId）；本屏的 blocks/pendingUploads 与会话零交互
    const sessionKind = useRecordingSessionStore((s) => s.kind);
    const sessionPhase = useRecordingSessionStore((s) => s.phase);
    const sessionElapsed = useRecordingSessionStore((s) => s.elapsedSec);
    const sessionOwnerJournalId = useRecordingSessionStore((s) => s.ownerJournalId);
    const mediaById = useMemo(() => new Map(media.map((row) => [row.id, row])), [media]);
    const chars = useMemo(() => wordCount(blocks), [blocks]);

    // 媒体落盘进度（2026-11-08 进度可视化）：注册表是 100ms 节流帧——pending
    // 占位块百分比与 meta 行会话保存百分比两个消费面共用同一帧，无额外节拍。
    // pendingProgress 的恒等键技巧：仅当 pending 条目真变化才换引用（capture:
    // 会话任务进度帧不影响 pendingProgress 恒等 → canvasContent memo 不被
    // 无关帧击穿，画布零重渲）。
    const uploadProgress = useArchiveStore((s) => s.mediaUploadProgress);
    const pendingProgressKey = Object.entries(uploadProgress)
        .filter(([key]) => !key.startsWith('capture:'))
        .map(([key, fraction]) => `${key}:${fraction}`)
        .join('|');
    const pendingProgress = useMemo<Record<string, number>>(() => {
        const entries = Object.entries(uploadProgress).filter(
            ([key]) => !key.startsWith('capture:'),
        );
        return Object.fromEntries(entries);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 恒等键模式：uploadProgress 拆解已由 pendingProgressKey 代表
    }, [pendingProgressKey]);
    // 会话落库进度（capture: 前缀聚合，全局录制会话产物保存中显示「保存中 N%」）
    const captureProgress = aggregateSaveProgress(uploadProgress, 'capture:');

    // 视频缩略图惰性回填（deck 露边层真封面，存量旧视频口径）：本篇媒体行
    // 载入后逐个 ensure（幂等单飞，已存在直命中零成本）；生成成功 bump
    // revision → editor 的 useFileUrlState(thumbKey) 复验后切真封面。
    // fire-and-forget：增强失败仅回退占位卡（ensureVideoThumbnail 内部兜底）。
    useEffect(() => {
        for (const row of media) {
            if (row.kind === 'video') void ensureVideoThumbnail(row.file_key);
        }
    }, [media]);
    const { monthDay } = formatDateParts(journal?.local_date ?? todayEntryDate());
    // 名称行（#3 回退）：有标题才渲染；无标题不再给「M月D日 日记」占位名，
    // 回到纯日期口径（标题编辑入口 = 铅笔钮 + 重命名卡，保留）
    const title = journal?.title?.trim() ?? '';
    // meta 行左侧槽位（#3）：原时间/星期槽位改为随机安慰话——挂载时定一句
    //（useMemo 一次：重渲染/保存不换句，重进页面才换）
    const comfortQuote = useMemo(() => pickComfortQuote(), []);
    const savedLabel = savedAt
        ? `已保存 ${String(new Date(savedAt).getHours()).padStart(2, '0')}:${String(new Date(savedAt).getMinutes()).padStart(2, '0')}`
        : '自动保存开启';
    // 块操作卡定位：id → 下标（操作卡按位置禁用上移/下移）
    const actionIndex = actionBlockId
        ? blocks.findIndex((block) => block.id === actionBlockId)
        : -1;
    const actionBlock = actionBlockId
        ? blocks.find((block) => block.id === actionBlockId) ?? null
        : null;
    // 操作卡的堆叠单元投影（2026-11-11 反馈①「堆叠整组移动/批量删除/指定删除」
    // 取数口）：操作块落在某媒体堆内 → deck 单元（组界下标 + 全员块 id，分组
    // 判定直接复用编辑器的 buildRenderUnits——渲染与操作口径天然锁步）；
    // null = 单块路径（单张媒体/文本/组内孤员）。
    const actionDeckUnit = useMemo(
        () => (actionBlockId ? findDeckUnit(blocks, mediaById, actionBlockId) : null),
        [blocks, mediaById, actionBlockId],
    );
    // 「合并堆叠」入口条件：屏内可选媒体（就绪图/视频）≥ 2（音频/pending 不
    // 可选——多选模式置灰，见 BlockEditor selection 注）
    const canMergeStack = useMemo(() => {
        let count = 0;
        for (const block of blocks) {
            if (block.t !== 'media' || block.mediaId === PENDING_MEDIA_ID) continue;
            const kind = mediaById.get(block.mediaId)?.kind;
            if (kind === 'image' || kind === 'video') count += 1;
            if (count >= 2) return true;
        }
        return false;
    }, [blocks, mediaById]);
    /**
     * 「保存到手机」行数据（媒体块操作卡，2026-11-08）：图/视频/音频就绪媒体
     * 都出现；pending 占位（mediaId === PENDING_MEDIA_ID）与媒体行缺失（已删）
     * 不出现。hint 按落点给（平台 × 类型矩阵的文案面；保存本体在能力内收口）。
     */
    const saveToPhone = (() => {
        if (actionBlock?.t !== 'media' || actionBlock.mediaId === PENDING_MEDIA_ID) return null;
        const row = mediaById.get(actionBlock.mediaId);
        if (!row) return null;
        const hint =
            Platform.OS === 'web'
                ? '下载到本机'
                : row.kind === 'audio'
                    ? '经分享面板保存'
                    : '存入手机相册';
        return { kind: row.kind, hint };
    })();
    /**
     * 「转成 GIF」行数据（M3，视频块操作卡）：仅就绪视频块 + 抽帧能力可达
     * （web 无原生抽帧，行不出现）。hint 如实说明 v1 抽帧窗口（前 4 秒、
     * 每 0.5 秒一帧）——固定窗口是确定性路径（时长探测需要播放器通道），
     * 文案不夸大成「全片转换」。
     */
    const canConvertGif = (() => {
        if (actionBlock?.t !== 'media' || actionBlock.mediaId === PENDING_MEDIA_ID) return null;
        const row = mediaById.get(actionBlock.mediaId);
        if (!row || row.kind !== 'video') return null;
        if (!videoThumbnails.isSupported()) return null;
        return { ok: true as const };
    })();
    /** 多选切换（选择顺序保持追加序，合并重排按此顺序落位；指定删除即删除
     *  清单）。指定删除白名单守卫：目标堆叠之外的块不可勾（编辑器侧已用
     *  selectableIds 限制，屏层兜底防直调路径）。 */
    const toggleSelect = useCallback((blockId: string) => {
        setSelectMode((current) => {
            if (!current) return current;
            if (current.purpose === 'deckDelete' && !current.deckIds.has(blockId)) {
                return current;
            }
            const exists = current.orderedIds.includes(blockId);
            return {
                ...current,
                orderedIds: exists
                    ? current.orderedIds.filter((id) => id !== blockId)
                    : [...current.orderedIds, blockId],
            };
        });
    }, []);

    const cancelSelect = useCallback(() => setSelectMode(null), []);

    // 多选编辑器面：选择态屏蔽文本聚焦（editable=false 下传），媒体勾选数据。
    // toggleSelect 在上方声明（useCallback [] 稳定），这里只做 Set 投影；
    // 指定删除模式附加 selectableIds 白名单（= 目标堆叠成员，组外媒体在编辑器
    // 内回常态渲染），合并模式省略（全可选，原口径）。
    const editorEditable = editable && !selectMode;
    const selection = useMemo(
        () =>
            selectMode
                ? {
                      selectedIds: new Set(selectMode.orderedIds),
                      onToggle: toggleSelect,
                      ...(selectMode.purpose === 'deckDelete'
                          ? { selectableIds: selectMode.deckIds }
                          : {}),
                  }
                : null,
        [selectMode, toggleSelect],
    );

    // 画布空白收键层的 onPress（#K2）：引用稳定（editorRef 为固定 ref），
    // CanvasDismissLayer 的 memo 契约依赖它恒等
    const dismissCanvasKeyboard = useCallback(() => {
        editorRef.current?.dismissKeyboard();
    }, []);

    /**
     * 画布内容子树（children 直传垫高层）：useMemo 把引用稳定到「真正影响
     * 内容的依赖」上——键盘弹出/收起只重渲 CanvasDismissLayer 自身的 style，
     * 本子树经 children 引用相等 bail-out 零重渲（键盘事件零波及媒体堆/
     * 音频卡/TextBlock）；保存状态位、错误横幅、浮层开关等屏级重渲同样被
     * 挡在子树之外（比旧版「屏渲即全画布 reconcile」更省）。deps 与闭包
     * 读取严格对齐（onBlurText 读 journal/blocks/store），无陈旧闭包面。
     */
    const canvasContent = useMemo(
        () => (
            <View className="mx-auto w-full max-w-[620px]">
                <BlockEditor
                    ref={editorRef}
                    blocks={blocks}
                    mediaById={mediaById}
                    editable={editorEditable}
                    focusTextId={focusTextId}
                    canvas={canvas}
                    selection={selection}
                    progressByPendingId={pendingProgress}
                    onChange={(next) => applyBlocks(() => next)}
                    onFocusText={() => setFocusTextId(null)}
                    onBlurText={() => {
                        if (journal && isEditable(journal.status)) {
                            void store
                                .getState()
                                .saveJournalBlocks(journal.id, blocks)
                                .then((saved: unknown) => {
                                    // 新契约 Promise<boolean>：失败（false）不更新已保存时间，
                                    // 「已保存 HH:MM」只反映真实落库；失败文案由 error 横幅展示
                                    if (saved !== false) setSavedAt(Date.now());
                                })
                                .catch(() => {
                                    // store 内部已落 error 文案；这里防 unhandled rejection
                                });
                        }
                    }}
                    onRequestActionBlock={setActionBlockId}
                />
            </View>
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 闭包读取项已尽数列入（applyBlocks/稳定 setter/editorRef 稳定引用）
        [blocks, mediaById, editorEditable, focusTextId, canvas, selection, journal, store, pendingProgress],
    );

    /**
     * 插入流本体（**后台异步并行**）：pending 占位**同步**插入（即时反馈，
     * 不阻塞继续写字），落盘+落库为后台任务注册进 pendingUploadsRef——多任务
     * 并行互不等待；单任务失败仅回滚该 pending + 上浮 store.error，其余在途
     * 任务不受影响。**只插媒体块**：不追加空文本段、不自动聚焦（想写字自己
     * 点 + →「添加输入框」）。落点/回填走 journal-logic 纯函数（v9 语义）：
     * 占位真实文末追加、回填原位替换；失败仅移除占位。
     * 媒体数量上限已按用户指令全域移除（2026-11-20）：插入入口不再设总量/
     * 九图配额闸。updater 一律纯函数（块 id 在 updater 外预生成）。
     */
    const doAttach = (
        kind: 'image' | 'video' | 'audio',
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number,
    ): void => {
        const row = journalRef.current;
        if (!row || !isEditable(row.status)) return;
        const pendingId = newBlockId();
        applyBlocks((current) => insertPendingBlock(current, pendingId));
        const label = kind === 'video' ? '视频' : kind === 'audio' ? '录音' : '图片';
        // 后台任务（不 await——并行模型的核心）：收敛后注册表自摘除。
        // taskId = pendingId：落盘进度进 store.mediaUploadProgress（100ms 节流），
        // 占位块经 progressByPendingId 显示百分比（视频直迁流有逐块进度；图片
        // /音频字节路径无进度拍，占位块保持 spinner 态）
        const task = (async () => {
            try {
                const mediaId = await store
                    .getState()
                    .attachJournalMedia(row.id, kind, uri, width, height, { taskId: pendingId });
                // 媒体块 id 在 updater 外预生成（#1.2 纯函数纪律）；落库失败不生成
                const mediaBlockId = mediaId ? newBlockId() : null;
                applyBlocks((current) =>
                    // 原位回填：段落数量不变、不补空文本段；落库失败（store 已上浮
                    // error）仅移除占位，不进无效媒体块；只动本 pendingId，不误伤
                    // 其他在途占位
                    resolvePendingBlock(
                        current,
                        pendingId,
                        mediaId && mediaBlockId
                            ? { blockId: mediaBlockId, mediaId, durationMs }
                            : null,
                    ),
                );
            } catch (caught) {
                // 单任务失败：仅回滚本 pending + 上浮 error，不影响其他在途任务
                store.setState({
                    error: `${label}保存失败：${caught instanceof Error ? caught.message : String(caught)}`,
                });
                applyBlocks((current) => resolvePendingBlock(current, pendingId, null));
            }
        })();
        pendingUploadsRef.current.set(pendingId, task);
        void task.then(() => {
            pendingUploadsRef.current.delete(pendingId);
        });
    };

    /**
     * 离开屏落库职责已上收全局会话（recording-session.persistCaptureProduct →
     * store.appendMediaBlockToJournal，DB 级、不依赖屏）——本屏不再持有离开
     * 兜底链；离开编辑屏不再中止录制（跨页面后台继续是会话的一等语义）。
     */

    /**
     * 相册通道（多选，2026-11）：权限 → 批量选图/选视频 → 按选取顺序逐张
     * 插入流（doAttach 同步插 pending 占位即返回，后台异步并行上传）。图片
     * 与视频通道都开 allowsMultipleSelection，不设 selectionLimit——媒体
     * 数量上限已按用户指令全域移除（2026-11-20），选取数量不封顶；
     * orderedSelection（iOS 15+）= 序号角标 + 严格按选取顺序返回，
     * Android/web 忽略。
     */
    const pick = async (kind: 'image' | 'video') => {
        const row = journalRef.current;
        if (!row || !isEditable(row.status)) return;
        if (pickingRef.current) {
            store.setState({ error: '相册选取进行中，稍等一下。' });
            return;
        }
        pickingRef.current = true;
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) {
                    store.setState({ error: '没有相册权限，去系统设置里开一下。' });
                    return;
                }
            }
            const result = await imagePicker.launchImageLibraryAsync({
                mediaTypes: [kind === 'video' ? 'videos' : 'images'],
                // 多选（图片/视频通道都开）不设上限；orderedSelection（iOS 15+）
                // = 序号角标 + 严格按选取顺序返回，Android/web 忽略
                allowsMultipleSelection: true,
                orderedSelection: true,
                quality: 1,
                exif: false,
            });
            if (result.canceled || result.assets.length === 0) return;
            // picked 顺序 = 插入顺序：assets 按选取序逐张同步插 pending 占位
            //（各自独立后台任务并行上传，占位块各挂各的进度）
            for (const asset of result.assets) {
                doAttach(kind, asset.uri, asset.width ?? null, asset.height ?? null);
            }
        } catch (caught) {
            store.setState({
                error: `${kind === 'video' ? '视频' : '图片'}选取失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            pickingRef.current = false;
        }
    };

    /** 归属提示名（发起会话时冻结）：有标题用标题；无标题按实体种类回退——
     *  日记落「M月D日 日记」，计划落「未命名计划」（计划无「当天一页」语义，
     *  日期口径不属于它，v8；与卡片列表的「未命名计划」兜底同文案）。 */
    const captureOwnerLabel = () => {
        const current = journalRef.current;
        const label = current?.title?.trim();
        if (label) return label;
        return current?.kind === 'note' ? PLAN_TITLE_FALLBACK : `${monthDay} 日记`;
    };

    /**
     * 收笔（#7）：本篇发起的录制会话先停录（归属落库链：产物经 persist 事件
     * 已合并进本地 blocksRef + DB 级 appendMediaBlockToJournal 落回本篇——
     * 后续保存 blocks 才带得上；非 owner 会话零交互，各自独立）；再等待全部
     * 在途上传收敛（allSettled——单任务失败已各自上浮 error 并回滚占位，不
     * 互相影响也不中止收笔）；保存失败中止；收笔后本页即只读锁定（无重开路径）。
     */
    const complete = async () => {
        const row = journalRef.current;
        if (!row) return;
        // owner 路径：只有本篇发起的会话才停（别的计划发起的录制与本篇收笔无关）
        const session = useRecordingSessionStore.getState();
        if (session.kind && session.ownerJournalId === row.id) {
            const outcome = await stopCaptureSession();
            // 停止失败（错误文案已上浮）：中止收笔，否则录制产物与本次输入一起丢失
            if (!outcome.ok) return;
        }
        if (pendingUploadsRef.current.size > 0) {
            setFinishing(true);
            try {
                await Promise.allSettled(Array.from(pendingUploadsRef.current.values()));
            } finally {
                setFinishing(false);
            }
        }
        // 保存失败必须中止收笔：否则旧内容会连同本次输入一起封存。
        // 结果按 unknown 收窄判断：旧契约返回 void（放行），store 侧正收紧为
        // Promise<boolean>（false 中止）——两种形态下这里的语义都成立
        const saved: unknown = await store.getState().saveJournalBlocks(row.id, blocksRef.current);
        if (saved === false) return;
        await store.getState().completeJournal(row.id);
        safeBack();
    };

    /** + 选择器动作分发：媒体动作不再受上传阻塞（后台并行）；采集三行经全局
     *  会话互斥（已有会话 → start 拒绝并给 reason，可见反馈不静默吞点按）；
     *  相册/文本随时可用。 */
    const runInsert = async (action: InsertAction) => {
        const row = journalRef.current;
        if (!row) return;
        switch (action) {
            case 'complete': {
                Keyboard.dismiss();
                await complete();
                return;
            }
            case 'record': {
                // 互斥预检（先于权限弹窗——已有会话时直接给可见反馈，不拉系统弹窗；
                // start 内部另有竞态闸）
                const existing = useRecordingSessionStore.getState();
                if (existing.kind) {
                    store.setState({
                        error:
                            existing.kind === 'audio'
                                ? '已有录音在进行中（素材将保存到发起的计划）。'
                                : '相机使用中，先处理拍摄再来录音。',
                    });
                    return;
                }
                // 麦克风权限由屏层预检（拒绝不开会话；会话内 prepare 失败另有兜底）
                const permission = await audio.getRecordingPermissionAsync();
                if (!permission.granted) {
                    const requested = await audio.requestRecordingPermissionAsync();
                    if (!requested.granted) {
                        store.setState({ error: '没有麦克风权限，去系统设置里开一下。' });
                        return;
                    }
                }
                Keyboard.dismiss();
                // 全局会话发起（归属铁律）：ownerJournalId = 当前编辑的 journal id
                //（ensureJournal 保证写前有 id，row 就绪才可能到这里）；
                // 已有会话 → 拒绝并给 reason（可见反馈）
                const started = startCaptureSession('audio', row.id, { ownerLabel: captureOwnerLabel() });
                if (!started.ok) {
                    store.setState({ error: started.reason });
                    return;
                }
                return;
            }
            case 'photo':
            case 'video': {
                // 互斥预检（与录音行同口径：已有会话直接可见反馈）
                const existing = useRecordingSessionStore.getState();
                if (existing.kind) {
                    store.setState({
                        error:
                            existing.kind === 'audio'
                                ? '录音进行中，不能同时拍摄。'
                                : '相机使用中，先处理拍摄。',
                    });
                    return;
                }
                Keyboard.dismiss();
                // 全局拍摄会话（拍照 = 即时产物；拍视频 = 可后台继续的录像）——
                // 互斥/归属口径与录音一致
                const started = startCaptureSession('video', row.id, {
                    cameraMode: action === 'video' ? 'video' : 'photo',
                    ownerLabel: captureOwnerLabel(),
                });
                if (!started.ok) {
                    store.setState({ error: started.reason });
                    return;
                }
                return;
            }
            case 'library-image':
                void pick('image');
                return;
            case 'library-video':
                void pick('video');
                return;
            case 'append-text': {
                // 「+ → 添加输入框」（#11）：块 id 在 updater 外预生成、焦点走
                // focusTextId 通道（TextBlock 内延后一帧聚焦 + Android 滚动补偿）。
                // 末段已是空段时不堆积空行，直接聚焦续写。判定读 blocksRef 权威
                // 镜像（后台回填链同帧写入也不丢）。
                const current = blocksRef.current;
                const last = current[current.length - 1];
                if (last && last.t === 'p' && last.text === '') {
                    setFocusTextId(last.id);
                    return;
                }
                const appended = newParagraphBlock();
                applyBlocks((blocks) => [...blocks, appended]);
                setFocusTextId(appended.id);
                return;
            }
        }
    };

    /** 合并确认：物理重排 + 同 groupId（journal-logic.mergeStackBlocks）。
     *  purpose 闸：仅合并模式响应（指定删除模式经 confirmDeckDelete 收口）。 */
    const confirmMerge = useCallback(() => {
        const current = selectModeRef.current;
        if (!current || current.purpose !== 'merge' || current.orderedIds.length < 2) return;
        const ordered = current.orderedIds;
        const groupId = newBlockId();
        applyBlocks((blocks) => mergeStackBlocks(blocks, ordered, groupId));
        setSelectMode(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- applyBlocks 稳定引用
    }, []);

    /** 指定删除确认（2026-11-11 反馈①「指定删除」）：删除勾选清单——媒体堆
     *  是独立块序列，按块 id 摘除即可；「至少留一个可落笔段」兜底与单块删除
     *  同口径（journal-logic.removeBlocks），媒体行/二进制不删（软删除语义）。 */
    const confirmDeckDelete = useCallback(() => {
        const current = selectModeRef.current;
        if (!current || current.purpose !== 'deckDelete' || current.orderedIds.length === 0) {
            return;
        }
        const ids = current.orderedIds;
        setSelectMode(null);
        applyBlocks((blocks) => removeBlocks(blocks, ids));
        // eslint-disable-next-line react-hooks/exhaustive-deps -- applyBlocks 稳定引用
    }, []);

    /** 解散堆叠（仅显式组）：清 groupId；同 kind 相邻成员按默认规则重新成组。 */
    const dissolveActionStack = () => {
        const gid = actionBlock?.t === 'media' ? actionBlock.groupId : null;
        if (!gid) return;
        setActionBlockId(null);
        applyBlocks((current) => dissolveStackBlocks(current, gid));
    };

    /** 块操作卡「合并堆叠」行：以当前块为起点进入多选（首块已选中）。 */
    const openMergeSelect = () => {
        if (!actionBlockId) return;
        const anchor = actionBlockId;
        setActionBlockId(null);
        Keyboard.dismiss();
        setSelectMode({ purpose: 'merge', orderedIds: [anchor], deckIds: null });
    };

    /**
     * 块操作卡「指定删除」行（2026-11-11 反馈①，仅堆叠锚块出现）：进入堆叠
     * 勾选模式——白名单 = 目标堆叠成员（组外媒体在编辑器内回常态渲染可照常
     * 查看，不进勾选面）；堆内翻看（底缘楔形带/横滑）逐张点选，勾完经顶栏
     * 「删除」确认（confirmDeckDelete）。入口即收键盘 + 关操作卡（与合并
     * 多选同口径：选择优先，画布让位给勾选交互）。
     */
    const openDeckDeleteSelect = () => {
        if (!actionDeckUnit) return;
        setActionBlockId(null);
        Keyboard.dismiss();
        setSelectMode({
            purpose: 'deckDelete',
            orderedIds: [],
            deckIds: new Set(actionDeckUnit.blockIds),
        });
    };

    // 离开编辑屏（返回钮/硬件返回）：**录制会话不再随离开中止**（跨页面后台
    // 继续是全局会话的一等语义——产物归属发起计划，用户可从任意页面经 chip /
    // + 菜单状态行停止）；多选中 = 先退出选择态。Android 返回键在此收口
    //（全局覆盖层各自的 handler 在其展开时优先响应）。
    const handleLeave = useCallback(() => {
        if (selectModeRef.current) {
            setSelectMode(null);
            return;
        }
        safeBack();
    }, []);

    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            handleLeave();
            return true;
        });
        return () => sub.remove();
    }, [handleLeave]);

    /**
     * 块操作卡动作（上移/下移，2026-11-11 反馈①「堆叠时全部移动不是单张」）：
     * 操作块落在媒体堆内 → **整组移动**（组首/组尾连续段同进退，组内顺序与
     * 连续性零变化——deck 是独立块序列，moveBlockRun 按段换位）；单块（单张
     * 媒体/文本/组内孤员）走原单块移动。移块不删文件（软删除语义）。读
     * blocksRef 权威镜像（后台回填/离开追加同帧写入不丢）。
     */
    const moveActionBlock = (direction: -1 | 1) => {
        if (!actionBlockId) return;
        const id = actionBlockId;
        const unit = findDeckUnit(blocksRef.current, mediaById, id);
        applyBlocks((current) =>
            unit
                ? moveBlockRun(current, unit.firstIndex, unit.lastIndex, direction)
                : moveBlock(current, id, direction),
        );
    };

    /** 块操作卡动作（删除）：删到空时 removeBlock 会补一个可落笔空段。 */
    const removeActionBlock = () => {
        if (!actionBlockId) return;
        const id = actionBlockId;
        setActionBlockId(null);
        applyBlocks((current) => removeBlock(current, id));
    };

    /**
     * 块操作卡动作（「删除整组」，2026-11-11 反馈①「批量删除」）：堆叠全员
     * 一次摘除（deck = 独立块序列，按组内块 id 清单删；媒体行与二进制不删，
     * 与单块删除同一软删除语义——journal-logic.removeBlocks）。删除后组内
     * 剩余成员自动重派生（buildRenderUnits）：≥2 仍成堆、1 张回单张渲染。
     */
    const removeActionDeck = () => {
        if (!actionDeckUnit) return;
        setActionBlockId(null);
        applyBlocks((current) => removeBlocks(current, actionDeckUnit.blockIds));
    };

    // 「保存到手机」在途镜像（ref 守卫防双击双跑——state 在异步链里读旧值）
    const savingToPhoneRef = useRef(false);
    const [savingToPhone, setSavingToPhone] = useState(false);

    /**
     * 块操作卡「保存到手机」（2026-11-08 媒体保存能力接线）：解析 file-storage
     * 本地 URI → media-library.saveAsync 统一保存（native 图/视频入系统相册、
     * 音频经分享面板；web 全部浏览器下载——平台 × 类型矩阵收口在能力内，屏层
     * 零分支）。suggestedName 取 file-storage key 末段（入库段命名自带真实容器
     * 扩展名，web 下载文件名由此保真）。
     *
     * 反馈口径（2026-11-09 用户口径改版：成功静默）：成功关闭卡片即反馈——
     * 文件落相册/下载开始/分享面板拉起本身就是结果，媒体块出现即确认，不再把
     * 「已保存到手机相册」等成功文案写入 store.error（负向红字横幅）；失败保持
     * 卡片打开（同卡可重试）+ 红字上浮，文案面向用户（MediaLibraryError 携带
     * 引导性 message，如权限拒绝 → 引导系统设置）。in-flight 期间保存行转
     * spinner + 全行禁用（见 BlockActionCard）。
     */
    const saveActionBlockToPhone = async () => {
        const block = actionBlock;
        const row = block && block.t === 'media' ? mediaById.get(block.mediaId) : null;
        // pending 占位与缺失媒体行不出现该行（canSaveToPhone 已门控），双保险
        if (!row || row.id === PENDING_MEDIA_ID) return;
        if (savingToPhoneRef.current) return;
        savingToPhoneRef.current = true;
        setSavingToPhone(true);
        try {
            // web blob: URL 引用即用即还（native 为 file:// 直路径，revoke 幂等 no-op）
            const uri = await fileStorage.url(row.file_key);
            try {
                // 成功静默（2026-11-09 用户口径）：不再把「已保存到手机相册」/
                // 「已打开分享面板」/「已开始下载」等结果文案写入 store.error
                //（负向红字横幅）——文件落相册即反馈；失败仍走 catch 上浮红字，
                // 错误路径不动
                await mediaLibrary.saveAsync(uri, row.kind, {
                    suggestedName: row.file_key.split('/').pop() ?? '',
                });
                setActionBlockId(null);
            } finally {
                fileStorage.revokeUrl(uri);
            }
        } catch (caught) {
            // 失败保持卡片打开（可重试）；权限拒绝的引导文案在错误内
            const detail =
                caught instanceof MediaLibraryError
                    ? caught.message
                    : caught instanceof Error
                        ? caught.message
                        : String(caught);
            store.setState({ error: `保存失败：${detail}` });
        } finally {
            savingToPhoneRef.current = false;
            setSavingToPhone(false);
        }
    };

    // 「转成 GIF」在途镜像（ref 守卫防双击双跑，同 savingToPhoneRef 口径）
    const convertingGifRef = useRef(false);
    const [convertingGif, setConvertingGif] = useState(false);

    /**
     * 块操作卡「转成 GIF」（M3 视频转 GIF）：file-storage 本地 URI → 抽帧
     * （前 4 秒每 0.5 秒一帧，≤360px）→ GIF89a 编码 → media-library.saveAsync
     * 存相册（web 下载）。反馈口径与「保存到手机」一致：成功关闭卡片即反馈
     * （文件落相册本身是结果）；失败保持卡片打开可重试 + 红字上浮。in-flight
     * 期间行转 spinner + 全行禁用（见 BlockActionCard）。
     */
    const convertActionBlockToGif = async () => {
        const block = actionBlock;
        const row = block && block.t === 'media' ? mediaById.get(block.mediaId) : null;
        // 行出现条件已门控（canConvertGif），这里双保险
        if (!row || row.kind !== 'video') return;
        if (convertingGifRef.current) return;
        convertingGifRef.current = true;
        setConvertingGif(true);
        try {
            // web blob: URL 引用即用即还（native 为 file:// 直路径，revoke 幂等 no-op）
            const uri = await fileStorage.url(row.file_key);
            try {
                // 成功静默（保存到手机同口径）：GIF 落相册即反馈，不写成功文案进
                // store.error（负向红字横幅）；失败走 catch 上浮
                await convertVideoToGif(uri, row.file_key.split('/').pop() ?? 'video');
                setActionBlockId(null);
            } finally {
                fileStorage.revokeUrl(uri);
            }
        } catch (caught) {
            const detail = caught instanceof Error ? caught.message : String(caught);
            store.setState({ error: `GIF 转换失败：${detail}` });
        } finally {
            convertingGifRef.current = false;
            setConvertingGif(false);
        }
    };

    // + 菜单状态行数据（全局会话进行中且本屏可编辑时展示）：「● 录音中 0:32 ·
    // 继续」点按重开全局覆盖层（无缝恢复）；副标按 owner 身份分流——归属
    // 铁律可视化：非 owner 屏明示「素材将保存到发起的计划」
    const activeCapture = (() => {
        if (!sessionKind || !editable) return null;
        const label =
            sessionKind === 'audio'
                ? '录音中'
                : sessionPhase === 'recording'
                    ? '录像中'
                    : '拍摄中';
        return {
            title: `${label} ${formatAudioTime(sessionElapsed)}`,
            hint:
                sessionOwnerJournalId === journal?.id
                    ? '点按回到录制界面，停止后保存到本篇'
                    : '点按回到录制界面，素材将保存到发起的计划',
            onResume: () => {
                setMenuOpen(false);
                restoreCaptureOverlay();
            },
        };
    })();

    // 载入失败态（自愈口径，参照 useFileUrlState 三态）：明确失败 + 重试入口，
    // 绝不把失败渲染成永久 spinner；store.error（如「日记初始化失败」）一并展示。
    // 死路页交互重做（2026-11-10 反馈二轮，与 trip-detail 行程不存在视图同一
    // 实现 = DeadEndView 共享组件，取舍见其注）：动作区间距再加大（24→48dp）、
    // 整页点按回首页、6s 无操作自动返回（重试即取消）。
    if (loadFailed) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base">
                <View style={{ paddingTop: insets.top }} className="flex-1">
                    {error ? (
                        // 失败文案下移一档（2026-11-09 反馈）：屏头→文案 8→24dp
                        //（mt-6，与主画布报头下节奏同档）；v0.4.7 令 3 收进
                        // settings 同源 tinted 横幅卡（错误是设计面不是贴底小字）
                        <View className="mx-6 mt-6 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                            <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                                {error}
                            </Text>
                        </View>
                    ) : null}
                    {/* 空态块整体下移一档（2026-11-09 反馈）：容器顶 pt-8 呼吸带
                        ——居中口径下内容净下移 16dp，与屏头群留出明确间距（本轮
                        保留）；内容→动作区间距归 DeadEndView（mt-12） */}
                    <View className="flex-1 pt-8">
                        <DeadEndView
                            icon={<LucidePenLine size={40} color={palette.muted} strokeWidth={1.5} />}
                            title="打不开这一页"
                            hint="日记可能已被删除，或数据读取失败。"
                            actionLabel="重试"
                            onAction={() => void load()}
                        />
                    </View>
                </View>
            </View>
        );
    }

    if (!journal) return <LoadingView />;

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头（#3 回退：日期行恢复第六轮之前的排版——30px 日期 + 右侧
                    状态同一基线行，整体上移到报头最紧位置）。结构：CloseButton 返回
                    （离开 = 录制中自动停录落库，见 handleLeave）+ TripBadge（trip
                    模式）+ 名称行 + 编辑钮。命中区核算：
                    - 返回钮：CloseButton 44 圆形触感底盒 in-flow 填满 h-11 行，
                      命中区 = 视觉盒（不传 hitSlop）；
                    - 编辑钮：36 视觉盒 + hitSlop 10 → 56×56 ≥44；
                    - TripBadge 40 盒为非按压体（ml-2 停车距），无命中核算项。
                    计划模式（v0.4.6 用户指令 3「计划顶部导航栏要有计划名称，参考
                    行程列表的顶部导航栏」）：名称位**恒渲染**——空标题走兜底名
                    （对齐 trip-detail 屏头的 tripDisplayTitle 模式，见
                    PLAN_TITLE_FALLBACK 注），24px 屏题档与行程详情屏头等档。 */}
                <View className={`px-6 pt-2 ${isPlan ? 'pb-3' : 'pb-2'}`}>
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={handleLeave} />
                        {trip ? (
                            <View className="ml-2">
                                <TripBadge icon={trip.icon} size="detail" />
                            </View>
                        ) : null}
                        {isPlan ? (
                            <Text
                                numberOfLines={1}
                                className="ml-2.5 min-w-0 flex-1 text-[24px] font-semibold text-ink-text dark:text-inkd-text"
                            >
                                {title || PLAN_TITLE_FALLBACK}
                            </Text>
                        ) : title ? (
                            <Text
                                numberOfLines={1}
                                className="ml-2.5 min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                            >
                                {title}
                            </Text>
                        ) : (
                            // 日记档无标题：名称位退场，弹性占位把编辑钮推到右缘
                            // （日期行 30px 即本屏屏题，标题槽只是可选别名——计划档
                            // 无日期行，屏题职责由计划名承担，故计划档恒渲染名称位）
                            <View className="flex-1" />
                        )}
                        {editable ? (
                            <BouncyPressable
                                onPress={() => setRenameOpen(true)}
                                scaleTo={0.9}
                                hitSlop={10}
                            >
                                {/* 无障碍属性挂内层 View（BouncyPressable 契约不透传） */}
                                <View
                                    accessibilityRole="button"
                                    accessibilityLabel="编辑标题"
                                    className="h-9 w-9 items-center justify-center rounded-control border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface"
                                >
                                    <LucideType size={16} strokeWidth={1.9} color={palette.secondary} />
                                </View>
                            </BouncyPressable>
                        ) : null}
                    </View>
                    {/* 日期行（#3 恢复第六轮前排版）：30 报头阶 + 右侧状态位。
                        计划模式（v0.4.4 用户指令「去除日记相关的日期信息」）整行
                        退场：报头日期（创建日）与「进行中/已收笔」状态位都是日记
                        语义（一天一篇 + 收笔机），计划不继承——计划头 = 题行 +
                        字数行；日期行与安慰话只在日记档渲染，左缘基线不变 */}
                    {isPlan ? null : (
                        <View className="flex-row items-baseline justify-between">
                            <Text className="text-[30px] font-semibold tracking-wide text-ink-text dark:text-inkd-text">
                                {monthDay}
                            </Text>
                            <Text
                                className={`text-[11px] font-medium ${
                                    editable
                                        ? 'text-ink-accent dark:text-inkd-accent'
                                        : 'text-ink-muted dark:text-inkd-muted'
                                }`}
                            >
                                {editable ? '进行中' : '已收笔'}
                            </Text>
                        </View>
                    )}
                    {/* meta 行（#3）：日记档 = 随机安慰话 + 字数/保存状态；计划档
                        （v0.4.6 指令 3，对齐 trip-detail 屏头两行解剖）= 状态词 +
                        保存状态。「0 字」类零值噪音不上屏（方向文档字阶纪律）。 */}
                    <View className="mt-0.5 flex-row items-baseline justify-between">
                        {isPlan ? (
                            <Text
                                className={`text-[12px] font-medium ${
                                    editable
                                        ? 'text-ink-accent dark:text-inkd-accent'
                                        : 'text-ink-muted dark:text-inkd-muted'
                                }`}
                            >
                                {planStatusLabel(journal.status)}
                            </Text>
                        ) : (
                            <Text
                                numberOfLines={1}
                                className="text-[13px] text-ink-secondary dark:text-inkd-secondary"
                            >
                                {comfortQuote}
                            </Text>
                        )}
                        <Text
                            className="ml-3 shrink-0 text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {editable
                                ? `${chars > 0 ? `${chars} 字 · ` : ''}${
                                      captureProgress != null
                                          ? `保存中 ${Math.round(captureProgress * 100)}%`
                                          : saving
                                            ? '保存中…'
                                            : savedLabel
                                  }`
                                : chars > 0
                                  ? `${chars} 字`
                                  : ''}
                        </Text>
                    </View>
                    {/* 终态提示行（v0.4.6 指令 3：与 trip-detail 锁定提示同位置同
                        语言——收进屏头带内，不再悬在屏头下方的独立横幅位）；仅计划档，
                        日记档收笔横幅保持原位原措辞 */}
                    {isPlan && !editable ? (
                        <Text className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted">
                            {isPlanFailed(journal)
                                ? '该计划已标记失败，内容不可再修改。'
                                : '该计划已完成，内容不可再修改。'}
                        </Text>
                    ) : null}
                    {/* 行程上下文行（保留：icon + 行程名，trip 模式） */}
                    {trip ? (
                        <Text
                            numberOfLines={1}
                            className="mt-1.5 text-[12px] text-ink-muted dark:text-inkd-muted"
                        >
                            {trip.icon ?? TRIP_ICON_DEFAULT} {tripDisplayTitle(trip.title)}
                        </Text>
                    ) : null}
                </View>
                {error ? (
                    // 错误横幅整体下移一档（2026-11-09 反馈）：报头群→横幅间距
                    // 8→24dp（mt-4 呼吸带，对齐 EDITOR_RHYTHM.mastheadToFirstBlock
                    // =24 的报头下节奏），不再贴着报头/返回键区域；v0.4.7 令 3
                    // 收进 settings 同源 tinted 横幅卡
                    <View className="mx-6 mt-4 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                        <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    </View>
                ) : null}
                {!editable && !isPlan ? (
                    // 锁页横幅（v11 拆分 → v0.4.6 指令 3 收口）：日记 = 收笔口径不变，
                    // 仍悬于屏头之下；计划的终态提示上移进屏头带（见上方 meta 行后的
                    // 提示行），此处不再给计划渲染第二条。v0.4.7 令 3：settings 完成
                    // 横幅同款 surface 井——状态说明是设计面，不是一行裸灰字
                    <View className="mx-6 mt-4 rounded-control bg-ink-surface px-4 py-3 dark:bg-inkd-surface">
                        <Text className="text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                            本页已收笔，内容不可再修改。
                        </Text>
                    </View>
                ) : null}

                <ScrollView
                    ref={canvasRef}
                    onScroll={(event) => {
                        // 最近滚动位置落 ref（#12/#12b 聚焦定位的落位基准，不触发渲染）
                        canvasOffsetRef.current = event.nativeEvent.contentOffset.y;
                    }}
                    scrollEventThrottle={16}
                    keyboardShouldPersistTaps="handled"
                    automaticallyAdjustKeyboardInsets
                    keyboardDismissMode="interactive"
                >
                    {/* 画布空白收键层（#K2，垫高层 CanvasDismissLayer）：键盘动态垫高
                        在层内收口（生效分支矩阵与防双重垫高见 editor 注）。多选模式
                        期间本层仍可点（收键语义已无键盘，空操作） */}
                    <CanvasDismissLayer
                        bottomBaseline={insets.bottom + CANVAS_BOTTOM_BASE_INSET}
                        onPress={dismissCanvasKeyboard}
                    >
                        {canvasContent}
                    </CanvasDismissLayer>
                </ScrollView>

                {/* 罗盘 + 号（#1）：上传中不再禁用（后台并行模型）；多选模式隐藏
                    （选择优先）；收笔等待在途时显示轻量进行态（spinner 替换 + 号）。
                    位置口径同 compose-fab（bottom = insets.bottom + 24） */}
                {editable && !selectMode ? (
                    <View
                        className="absolute right-6 z-10"
                        style={{ bottom: insets.bottom + 24 }}
                        pointerEvents="box-none"
                    >
                        <BouncyPressable onPress={() => setMenuOpen(true)} scaleTo={0.88}>
                            <View
                                className="h-14 w-14 items-center justify-center rounded-full"
                                style={{ backgroundColor: palette.primaryBtn }}
                                accessibilityRole="button"
                                accessibilityLabel="插入内容"
                            >
                                {finishing ? (
                                    <ActivityIndicator size="small" color={palette.onPrimaryBtn} />
                                ) : (
                                    <LucidePlus size={24} color={palette.onPrimaryBtn} strokeWidth={2.2} />
                                )}
                            </View>
                        </BouncyPressable>
                    </View>
                ) : null}
            </View>

            {/* 多选选择栏（顶部，选择优先）：44 命中双钮 + 已选计数；覆盖在报头
                之上但不遮画布（bar 以下区域全部留给媒体勾选点按）。用途分档：
                merge = 合并（「合并」确认钮）；deckDelete = 堆叠指定删除（计数
                带「/ 总数」、确认钮 = 负色「删除」，0 选中禁用）。 */}
            {selectMode ? (
                <View className="absolute inset-x-0 top-0 z-40" style={{ paddingTop: insets.top }}>
                    <View className="flex-row items-center gap-1 border-b border-ink-rule bg-ink-base px-3 py-1 dark:border-inkd-rule dark:bg-inkd-base">
                        <Text
                            className="px-1 text-[13px] font-medium text-ink-text dark:text-inkd-text"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {selectMode.purpose === 'deckDelete'
                                ? `已选 ${selectMode.orderedIds.length} / ${selectMode.deckIds.size}`
                                : `已选 ${selectMode.orderedIds.length}`}
                        </Text>
                        <View className="flex-1" />
                        <BouncyPressable onPress={cancelSelect} scaleTo={0.95}>
                            <View
                                className="h-11 items-center justify-center rounded-control px-3"
                                accessibilityRole="button"
                                accessibilityLabel={
                                    selectMode.purpose === 'deckDelete'
                                        ? '取消指定删除'
                                        : '取消合并选择'
                                }
                            >
                                <Text className="text-[14px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    取消
                                </Text>
                            </View>
                        </BouncyPressable>
                        {selectMode.purpose === 'deckDelete' ? (
                            <BouncyPressable
                                onPress={confirmDeckDelete}
                                disabled={selectMode.orderedIds.length === 0}
                                scaleTo={0.95}
                            >
                                <View
                                    className={`h-11 items-center justify-center rounded-control px-4 ${
                                        selectMode.orderedIds.length === 0 ? 'opacity-40' : ''
                                    }`}
                                    style={{ backgroundColor: palette.negative }}
                                    accessibilityRole="button"
                                    accessibilityLabel="删除所选单张"
                                    accessibilityState={{
                                        disabled: selectMode.orderedIds.length === 0,
                                    }}
                                >
                                    <Text
                                        className="text-[14px] font-semibold"
                                        style={{ color: '#FFFFFF' }}
                                    >
                                        删除
                                    </Text>
                                </View>
                            </BouncyPressable>
                        ) : (
                            <BouncyPressable
                                onPress={confirmMerge}
                                disabled={selectMode.orderedIds.length < 2}
                                scaleTo={0.95}
                            >
                                <View
                                    className={`h-11 items-center justify-center rounded-control px-4 ${
                                        selectMode.orderedIds.length < 2 ? 'opacity-40' : ''
                                    }`}
                                    style={{ backgroundColor: palette.primaryBtn }}
                                    accessibilityRole="button"
                                    accessibilityLabel="合并为堆叠"
                                    accessibilityState={{ disabled: selectMode.orderedIds.length < 2 }}
                                >
                                    <Text
                                        className="text-[14px] font-semibold"
                                        style={{ color: palette.onPrimaryBtn }}
                                    >
                                        合并
                                    </Text>
                                </View>
                            </BouncyPressable>
                        )}
                    </View>
                </View>
            ) : null}

            {/* 录音/拍摄会话已上收根层级（app/_layout 的 RecordingSessionHost）：
                覆盖层/隐形保活槽/悬浮 chip 全局渲染，任意页面可重开；停止产物经
                DB 级 appendMediaBlockToJournal 落回发起计划（ownerJournalId），
                owner 屏经 persist 事件合并进本地 blocksRef（见订阅 effect） */}

            {/* 块操作卡（#1/#9 + 自定义合并堆叠入口 + 堆叠批量/指定删除与整组
                移动）：媒体长按/双击、文本聚焦 ⋯ → 屏根浮层，条件渲染（禁
                RN Modal） */}
            {actionBlockId && actionIndex >= 0 ? (
                <BlockActionCard
                    index={actionIndex}
                    total={blocks.length}
                    deck={
                        actionDeckUnit
                            ? {
                                  firstIndex: actionDeckUnit.firstIndex,
                                  lastIndex: actionDeckUnit.lastIndex,
                                  size: actionDeckUnit.blockIds.length,
                              }
                            : null
                    }
                    canMergeStack={canMergeStack}
                    groupId={actionBlock?.t === 'media' ? actionBlock.groupId ?? null : null}
                    saveToPhone={saveToPhone}
                    savingToPhone={savingToPhone}
                    toGif={canConvertGif}
                    convertingGif={convertingGif}
                    onMove={moveActionBlock}
                    onDelete={removeActionBlock}
                    onDeleteDeck={removeActionDeck}
                    onSelectDelete={openDeckDeleteSelect}
                    onMergeStack={openMergeSelect}
                    onDissolveStack={dissolveActionStack}
                    onSaveToPhone={() => void saveActionBlockToPhone()}
                    onConvertGif={() => void convertActionBlockToGif()}
                    onClose={() => setActionBlockId(null)}
                />
            ) : null}
            {/* 标题重命名卡（屏头编辑钮 → 与首页计划卡长按卡同语义，共享组件
                ui/rename-card；条件渲染 scrim，禁 RN Modal）。落库通道经 onSave
                注入（store.updateJournalTitle，不回退）；onClose 一律回读刷新 */}
            {renameOpen && journal ? (
                <RenameCard
                    initialTitle={journal.title ?? ''}
                    onSave={(title) => store.getState().updateJournalTitle(journal.id, title)}
                    onClose={() => {
                        setRenameOpen(false);
                        void getJournal(journal.id)
                            .then((row) => {
                                if (row) setJournal(row);
                            })
                            .catch(() => {
                                // 回读失败保留当前标题（幂等刷新，保存本体已在卡内确认），
                                // 下次进入按 DB 校正；静默需注释：无界面可回滚的只读刷新
                            });
                    }}
                    errorText={error}
                />
            ) : null}
            {/* 插入选择器（+ 号罗盘）：条件渲染遮罩，打开时键盘收起（组件内 blur）；
                全局录制会话进行中时顶部展示状态行（「录音中 0:32 · 继续」） */}
            {menuOpen ? (
                <InsertMenu
                    onClose={() => setMenuOpen(false)}
                    // 计划模式裁「完成收笔」行（词表见 NOTE_INSERT_ACTIONS 注）；
                    // 日常模式传 undefined = 全行，行为零变化
                    actions={isPlan ? NOTE_INSERT_ACTIONS : undefined}
                    activeCapture={activeCapture}
                    onAction={(action) =>
                        void runInsert(action).catch((caught) => {
                            // 中断场景：录音权限/收笔通道 reject（系统中断、环境异常）
                            // 必须可见，不能 unhandled rejection 红屏
                            store.setState({
                                error: `操作失败：${caught instanceof Error ? caught.message : String(caught)}`,
                            });
                        })
                    }
                />
            ) : null}
        </KeyboardAvoidingView>
    );
}

/* ------------------------------------------------------------------ */
/* 死路页共享视图（journal-edit 载入失败 / trip-detail 行程不存在）       */
/* ------------------------------------------------------------------ */

/** 自动返回首页倒计时时长（秒）：用户口径 4-8s 档取中 6s——够读完两行文案
    并反应一次，又不让「走不通」的页面滞留太久。 */
const DEAD_END_AUTO_BACK_SECONDS = 6;

/**
 * 死路页视图（走到没有路的地方的统一降级面，2026-11-10 反馈二轮重做）：
 *
 * - **单一实现源**：journal-edit 载入失败与 trip-detail「行程不存在」两处
 *   同语言同实现——宿主在本文件（两处均在本组改动权限内），trip-detail 深
 *   路径引入（域内深取纪律，先例同 editor-icons / field-input；ui/index.ts
 *   出口无本组改动权限，barrel 扩充时迁走收口）。不复用 ui/empty-state.tsx：
 *   该文件无改动权限，且死路页需要倒计时/整页命中等 EmptyState 契约外行为
 *   ——视觉语言（icon/题/hint/按钮规格与类名）与 EmptyState 逐项对齐，仅
 *   内容→动作区间距按本轮反馈加大。
 * - **动作区间距（反馈①）**：hint→按钮 24dp（EmptyState mt-6）→ 48dp
 *   （mt-12），净增 24dp（「再加 16-24dp」档顶格）。间距放 Pressable 外层
 *   包裹（margin 不计入命中区），按钮视觉盒即命中区。
 * - **整页点按回首页（反馈②）**：本组件根 = 全域 Pressable，onPress →
 *   router.replace('/')（回首页语义，按反馈原文口径；非 safeBack——深链/
 *   无栈场景与倒计时落点一致，且「回首页」明确于「退一层」）。命中区分：
 *   动作按钮在内层 BouncyPressable，RN responder 深度优先认领——点按钮
 *   只触发按钮、不落背景层（按钮优先），其余任意区域触发回首页。
 * - **自动返回倒计时（反馈③）**：挂载即启动 6s 倒计时，归零 router.replace
 *   ('/')；用户点重试/返回先停倒计时再走原动作；卸载/成功恢复（loadFailed
 *   翻 false / missing 翻 false 时本视图随分支卸载）由 effect 清理自然收口。
 *   实现分工：interval 只递减（纯 updater，无副作用——StrictMode 双调防护），
 *   导航独立 effect 在归零帧触发。重试失败重进本视图 = 重新挂载 = 计时重置，
 *   无陈旧计时面。可视（克制口径）：无进度环、无动画，按钮下方 muted 小字
 *   「N 秒后返回首页」每秒跳变，tabular-nums 防数字宽度抖动（房规）。
 * - **a11y**：根命中体 role=button（点按回首页的真实语义）；动作按钮 role=
 *   button 挂内层 View（BouncyPressable 契约不透传 a11y props，屏内既有口径）。
 *   嵌套按压体在 RN 无 HTML 非法嵌套面（RNW 亦渲染 div 而非 <button>）。
 */
export function DeadEndView({
    icon,
    title,
    hint,
    actionLabel,
    onAction,
}: {
    icon: React.ReactNode;
    title: string;
    hint: string;
    actionLabel?: string;
    onAction?: () => void;
}) {
    const router = useRouter();
    // 倒计时状态：remaining = 剩余秒数；countdownOn = 倒计时在跑（用户点按
    // 按钮置 false——计数行隐藏、递减与归零导航一并停摆）
    const [remaining, setRemaining] = useState(DEAD_END_AUTO_BACK_SECONDS);
    const [countdownOn, setCountdownOn] = useState(true);

    // 每秒递减：interval 唯一职责是减数（纯 updater）；卸载/停跑清理 interval
    useEffect(() => {
        if (!countdownOn) return;
        const interval = setInterval(() => {
            setRemaining((current) => Math.max(current - 1, 0));
        }, 1000);
        return () => clearInterval(interval);
    }, [countdownOn]);

    // 归零导航（副作用的独立出口）：replace('/') 回首页，本视图随页面卸载，
    // interval 由上一 effect 清理；置停后的归零帧不再触发（countdownOn 闸）
    useEffect(() => {
        if (!countdownOn || remaining > 0) return;
        router.replace('/');
    }, [countdownOn, remaining, router]);

    /** 用户点动作按钮（重试/返回）：先停倒计时再走原动作——倒计时不再在
        动作进行中（重试载入窗口）触发导航。 */
    const handleAction = () => {
        setCountdownOn(false);
        onAction?.();
    };

    /** 背景区任意点按 → 回首页（导航即卸载，计时随卸载清理）。 */
    const goHome = () => {
        router.replace('/');
    };

    return (
        // 整页命中体（EmptyState 区域点任意处回首页）：flex-1 铺满宿主让出的
        // 全部区域；命中区分靠 RN 嵌套 Pressable 深度优先 responder（按钮优先）
        <Pressable
            onPress={goHome}
            accessibilityRole="button"
            accessibilityLabel="回到首页"
            className="flex-1 items-center justify-center px-10"
        >
            {/* 视觉语言与 ui/empty-state.tsx 逐项对齐（icon/题/hint 同规格同类），
                仅间距按本轮反馈加大——见文件头与上注 */}
            <View className="mb-4 h-12 w-12 items-center justify-center opacity-70">{icon}</View>
            <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">{title}</Text>
            <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                {hint}
            </Text>
            {actionLabel && onAction ? (
                // 动作区（反馈①）：hint→按钮 24dp（EmptyState mt-6）→ 48dp
                // （mt-12），净增 24dp；间距在 Pressable 外层（margin 不计入
                // 命中区，按钮视觉盒 = 命中区，与背景层无重叠核算项）
                <View className="mt-12">
                    <BouncyPressable onPress={handleAction} scaleTo={0.96}>
                        <View
                            accessibilityRole="button"
                            accessibilityLabel={actionLabel}
                            className="h-11 items-center justify-center rounded-control border border-ink-border bg-ink-surface px-6 dark:border-inkd-border dark:bg-inkd-surface"
                        >
                            <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                {actionLabel}
                            </Text>
                        </View>
                    </BouncyPressable>
                </View>
            ) : null}
            {countdownOn && remaining > 0 ? (
                // 倒计时可视（反馈③，克制口径）：无进度环、无动画，muted 小字
                // 每秒跳变；tabular-nums 防数字换位抖动（房规）。位于动作区下方
                // ——「不动就会发生什么」读在动作语义之后，不打断内容→动作的
                // 间距节奏（反馈①的 48dp 净空保持完整）。归零帧整行退场
                // （不给「0 秒后」闪一帧，导航同帧触发）
                <Text
                    className="mt-4 text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {`${remaining} 秒后返回首页`}
                </Text>
            ) : null}
        </Pressable>
    );
}

/**
 * 画布空白收键层（#K2）+ 键盘动态垫高（滚动余量组）：ScrollView 的唯一内容
 * 子——块间 gap、内容区 padding、报头下方留白，未被子元素认领的区域点按 →
 * 收键盘 + blur 聚焦段；原 contentContainerStyle 三向 padding 全数下沉到本层
 * （几何不变，padding 区变成可点面）。
 *
 * 键盘动态垫高：paddingBottom = useKeyboardCanvasBottomPadding(bottomBaseline)
 * ——键盘打开且窗口未被 adjustResize 收缩（Android 问题机型）时放大，末段
 * 聚焦永远有足够滚动余量；键盘收起立即回静态基线。生效分支矩阵见 editor 注。
 *
 * 重渲隔离：memo + children 直传 + 稳定 onPress/bottomBaseline——键盘弹出/
 * 收起只重渲本层自身 style，children 子树经引用相等 bail-out 零重渲。
 *
 * 防误触机制（原 Pressable 契约原样保留）：tap 语义（滚动接管的手势不触发）、
 * dismissKeyboard 空引用闸、子元素认领优先；触摸面零 className；无障碍不挂
 * role（背景装饰层）。卸载零副作用。
 */
/**
 * Web 可编辑目标闸（#K2 补丁，2026-11-12 用户反馈 web「聚焦即失焦」）：
 * RNW 的合成点击会从 `<textarea>`/`<input>` 一路冒泡到本层（native 的
 * responder 体系由 TextInput 最深优先认领，本层根本不会收到——所以 native
 * 无此 bug），onPress 直达 dismissKeyboard 会把刚聚焦的输入框 blur 掉，且
 * 与 TextBlock 的容器兜底聚焦互相打架（focus→blur→refocus→blur 乒乓）。
 * 目标为可编辑元素时本层让路；空白区域 target 仍是本层/画布容器，照常
 * 收键。native 直接 false 零变化。
 * 【同步锚点：journal-edit-screen / event-detail-screen 两份 CanvasDismissLayer 同字面量】
 */
const isWebEditablePressTarget = (e: GestureResponderEvent): boolean => {
    if (Platform.OS !== 'web') return false;
    const target = e.nativeEvent.target as { tagName?: string; isContentEditable?: boolean } | null;
    return target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable === true;
};

const CanvasDismissLayer = memo(function CanvasDismissLayer({
    bottomBaseline,
    onPress,
    children,
}: {
    /** 底部垫高静态基线（insets.bottom + CANVAS_BOTTOM_BASE_INSET）。 */
    bottomBaseline: number;
    onPress(): void;
    children: React.ReactNode;
}) {
    const paddingBottom = useKeyboardCanvasBottomPadding(bottomBaseline);
    return (
        <Pressable
            onPress={(e) => {
                // 内联箭头仅本层重渲时重建（memo 层重渲只发生在垫高变化），
                // children 子树经元素引用相等 bail-out，无重渲波及
                if (isWebEditablePressTarget(e)) return;
                onPress();
            }}
            style={{
                // 画布顶部留白 16dp：叠加报头 pb-2(8dp) 后，报头→首段净间距
                // 24dp（EDITOR_RHYTHM.mastheadToFirstBlock）
                paddingTop: 16,
                paddingHorizontal: 24,
                paddingBottom,
            }}
        >
            {children}
        </Pressable>
    );
});

/**
 * 块操作卡（上移/下移/合并堆叠/解散堆叠/保存到手机/删除 + 堆叠「指定删除 /
 * 删除整组」，浮层居中弹出）：屏根条件渲染（禁 RN Modal），深色 scrim + 居中
 * 卡片；Android 返回键关闭。媒体块经长按/双击（组件内 useBlockActionGestures
 * 平台分派）、文本块经聚焦态 ⋯ 钮进入。
 *
 * 堆叠锚块分档（2026-11-11 反馈①，deck prop 非 null 时）：
 * - 「上移/下移」= **整组移动**（组首/组尾连续段同进退，journal-logic
 *   .moveBlockRun；禁用态按组界判定而非锚块下标），hint 标明「整组 N 张」；
 * - 「指定删除」：进入堆叠勾选模式（白名单 = 组内成员，组外媒体照常可查看，
 *   勾完经顶栏「删除」确认——iOS 照片多选同语言，克制不花哨）；
 * - 「删除整组」：批量删除组内全部块（软删除语义与单块删除一致）；
 * - 「删除」行改义为「删除当前张」（只删当前显示的前卡成员）。
 *
 * 自定义合并堆叠入口（2026-11 既有）：
 * - 「合并堆叠」：canMergeStack（屏内可选图/视频 ≥2）时出现——以当前块为
 *   起点（已选中）进入多选模式；
 * - 「解散堆叠」：当前块带 groupId（显式组成员，含被移散的孤员）时出现——
 *   清 groupId（journal-logic.dissolveStackBlocks）；解散后同 kind 相邻成员
 *   按渲染层自然相邻规则**立即重新成组**（默认分组语义的既定口径，报告注明）。
 *
 * 「保存到手机」行（2026-11-08）：就绪图/视频/音频媒体块出现（pending 占位/
 * 文本块/媒体行缺失不出现，见屏层 saveToPhone 推导）；保存编排在屏层（本组件
 * 只展示），in-flight 时该行 hint 槽转 spinner + 行禁用，其余行不受影响。
 */
function BlockActionCard({
    index,
    total,
    deck,
    canMergeStack,
    groupId,
    saveToPhone,
    savingToPhone,
    toGif,
    convertingGif,
    onMove,
    onDelete,
    onDeleteDeck,
    onSelectDelete,
    onMergeStack,
    onDissolveStack,
    onSaveToPhone,
    onConvertGif,
    onClose,
}: {
    /** 当前块下标（单块路径决定上移/下移禁用态；堆叠路径按 deck 组界判定）。 */
    index: number;
    /** 块总数。 */
    total: number;
    /** 当前块所属堆叠单元（null = 单块路径）：整组移动/批量删除/指定删除行
     *  的开关与组界禁用态依据（size = 组内块数）。 */
    deck: { firstIndex: number; lastIndex: number; size: number } | null;
    /** 屏内可选媒体（就绪图/视频）≥2 → 显示「合并堆叠」行。 */
    canMergeStack: boolean;
    /** 当前块所属显式组 id（null = 不在显式组 → 无「解散堆叠」行）。 */
    groupId: string | null;
    /** 「保存到手机」行数据（null = 不出现；hint 按落点预格式化）。 */
    saveToPhone: { kind: 'image' | 'video' | 'audio'; hint: string } | null;
    /** 保存到手机在途（保存行 spinner + 禁用）。 */
    savingToPhone: boolean;
    /** 「转成 GIF」行开关（M3，仅就绪视频块 + 抽帧能力可达；null = 不出现）。 */
    toGif: { ok: true } | null;
    /** GIF 转换在途（行 spinner + 禁用）。 */
    convertingGif: boolean;
    onMove(direction: -1 | 1): void;
    onDelete(): void;
    onDeleteDeck(): void;
    onSelectDelete(): void;
    onMergeStack(): void;
    onDissolveStack(): void;
    onSaveToPhone(): void;
    onConvertGif(): void;
    onClose(): void;
}) {
    const palette = usePalette();
    // Android 返回键关闭（替代 Modal onRequestClose 语义，范式同各覆盖层）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    // 堆叠路径禁用态按**组界**判定（整组同进退：组首块之上无块才能上移、
    // 组尾块之下无块才能下移）；单块路径按锚块下标（原口径）
    const canUp = deck ? deck.firstIndex > 0 : index > 0;
    const canDown = deck ? deck.lastIndex < total - 1 : index < total - 1;
    // 从简口径（2026-11-19 用户指令）：行副标描述全线退役（hint 槽仅存
    // spinner 在途反馈，标题自释）
    const rows: Array<{
        key: string;
        icon: React.ReactNode;
        label: string;
        /** hint 槽转 spinner（in-flight 反馈）。 */
        spinner?: boolean;
        danger?: boolean;
        disabled: boolean;
        onPress(): void;
    }> = [
        {
            key: 'up',
            icon: <ChevronUpIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
            label: '上移一格',
            disabled: !canUp,
            onPress: () => onMove(-1),
        },
        {
            key: 'down',
            icon: <ChevronDownIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
            label: '下移一格',
            disabled: !canDown,
            onPress: () => onMove(1),
        },
        ...(canMergeStack
            ? [
                  {
                      key: 'merge-stack',
                      icon: <LayersIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
                      label: '合并堆叠',
                      disabled: false,
                      onPress: onMergeStack,
                  },
              ]
            : []),
        ...(groupId
            ? [
                  {
                      key: 'dissolve-stack',
                      icon: <UngroupIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
                      label: '解散堆叠',
                      disabled: false,
                      onPress: onDissolveStack,
                  },
              ]
            : []),
        ...(saveToPhone
            ? [
                  {
                      key: 'save-to-phone',
                      icon: <DownloadIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
                      label: '存到手机',
                      // in-flight：hint 槽转 spinner（保存中可见反馈，行禁用防重复触发）
                      spinner: savingToPhone,
                      disabled: savingToPhone,
                      onPress: onSaveToPhone,
                  },
              ]
            : []),
        ...(toGif
            ? [
                  {
                      key: 'convert-gif',
                      icon: <LucideRepeat2 size={18} strokeWidth={1.9} color={palette.secondary} />,
                      label: '转成动图',
                      spinner: convertingGif,
                      disabled: convertingGif,
                      onPress: onConvertGif,
                  },
              ]
            : []),
        ...(deck
            ? [
                  {
                      key: 'select-delete',
                      icon: (
                          <ListChecksIcon size={18} strokeWidth={1.9} color={palette.secondary} />
                      ),
                      label: '指定删除',
                      disabled: false,
                      onPress: onSelectDelete,
                  },
                  {
                      // 尺寸档收敛：16/18/20/24 档内，stroke 1.9 全仓图标口径
                      key: 'delete-deck',
                      icon: <LucideTrash size={16} strokeWidth={1.9} color={palette.negative} />,
                      label: '删除整组',
                      danger: true,
                      disabled: false,
                      onPress: onDeleteDeck,
                  },
              ]
            : []),
        {
            // 尺寸档收敛：16/18/20/24 档内，stroke 1.9 全仓图标口径
            key: 'delete',
            icon: <LucideTrash size={16} strokeWidth={1.9} color={palette.negative} />,
            // 堆叠锚块：本行只删当前显示的前卡成员（整组走「删除整组」、逐张
            // 勾选走「指定删除」——三条删除路径语义互斥不打架）；行名统一四字
            label: deck ? '删除此张' : '删除本块',
            danger: true,
            disabled: false,
            onPress: onDelete,
        },
    ];

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭块操作"
            >
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base">
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮；堆叠锚块标明
                        「这一堆」（操作语义 = 整组），单块保持「这一块」 */}
                    <View className="flex-row items-center justify-between pl-4 pr-1.5 pt-0.5">
                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                            {deck ? `调整这一堆（${deck.size} 张）` : '调整这一块'}
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右侧贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    {/* 单容器行组（2026-11-19 与 + 菜单统一：rounded-card surface
                        包裹，行 h-12 贴靠零线条，裸图标 + 题单行，行级 active:bg
                        高亮）。onPress 恒挂接 + disabled 显式传导（#3 条件置空
                        显式化）：row.disabled 随移动操作翻转，条件置空会在翻转
                        瞬间重配置 Pressability 吞首点 */}
                    <View className="mt-3 overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                        {rows.map((row) => (
                            <Pressable
                                key={row.key}
                                onPress={row.onPress}
                                disabled={row.disabled}
                                className={`h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised ${
                                    row.disabled ? 'opacity-30' : ''
                                }`}
                                accessibilityRole="button"
                                accessibilityLabel={row.label}
                            >
                                <View pointerEvents="none">{row.icon}</View>
                                <Text
                                    className={`flex-1 text-[15px] font-medium ${
                                        row.danger
                                            ? 'text-ink-negative dark:text-inkd-negative'
                                            : 'text-ink-text dark:text-inkd-text'
                                    }`}
                                >
                                    {row.label}
                                </Text>
                                {row.spinner ? (
                                    // in-flight 反馈（保存到手机/转 GIF）：行尾 spinner
                                    <ActivityIndicator size="small" color={palette.secondary} />
                                ) : null}
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}
