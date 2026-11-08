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
    type ScrollViewInstance,
} from 'react-native';
import { Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    BouncyPressable,
    createIcon,
    LucideBookOpen,
    LucidePencil,
    LucidePlus,
    LucideTrash,
} from '@/core/icons';
// 深路径注记：ChevronUp/Down 与 editor 的节奏表/画布句柄未在 ui/index.ts 出口，
// 域内深取（CloseButton 已收口进 barrel，不再深取）。
import { ChevronDownIcon, ChevronUpIcon } from './ui/editor-icons';
// 深路径注记：录音会话控制器（后台继续模型宿主）未在 ui/index.ts 出口（本轮
// 改动权限不含 barrel），域内深取（editor-icons / close-button 先例）。
import { AudioRecordingSession } from './ui/recorder-overlay';
// 深路径注记：节奏表 / 画布句柄 / 键盘动态垫高 hook 未在 ui/index.ts 出口
//（域内深取纪律，先例同上）。
import {
    EDITOR_RHYTHM,
    useKeyboardCanvasBottomPadding,
    type BlockEditorHandle,
    type EditorCanvasHandle,
} from './ui/editor';
import { imagePicker } from '@/core/image-picker';
import { audio } from '@/core/audio';
import { useArchiveRevision, useArchiveStore } from './store';
import {
    canInsertImages,
    countImageBlocks,
    dissolveStackBlocks,
    insertPendingBlock,
    isEditable,
    mergeStackBlocks,
    moveBlock,
    newBlockId,
    newParagraphBlock,
    parseBlocks,
    removeBlock,
    resolvePendingBlock,
    todayEntryDate,
    wordCount,
    JOURNAL_IMAGE_LIMIT,
    type JournalBlock,
} from './journal-logic';
import { formatDateParts } from './trip-logic';
import { getJournal, getTrip, mediaByJournalIds } from './db';
import type { JournalMediaRow, JournalRow, TripRow } from './db';
import { safeBack } from './ui';
// 深路径注记：安慰话语料未在 ui/index.ts 出口（该文件不在本轮改动权限内），
// 域内深取（同 editor-icons / close-button 先例）。
import { pickComfortQuote } from './ui/comfort-quotes';
import {
    BlockEditor,
    CameraCaptureOverlay,
    CloseButton,
    EmptyState,
    InsertMenu,
    LoadingView,
    PENDING_MEDIA_ID,
    RenameCard,
    TRIP_ICON_DEFAULT,
    TripBadge,
    type CameraCapture,
    type InsertAction,
    type RecordingResult,
    usePalette,
} from './ui';

/** 每篇日记的媒体上限（防误触爆量；商业版放开为分页）。图片另有更严的
 *  JOURNAL_IMAGE_LIMIT = 9（journal-logic，微信九图口径）——图片路径两道
 *  闸都过，视频/音频仍只受本值约束。 */
const MAX_MEDIA = 12;

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

/**
 * 采集会话（录音 / 拍摄二选一的互斥单元）：控制器组件挂屏层（覆盖层只是
 * 视图），一次至多一个采集面在跑；结束 = 屏层置 null（控制器随会话卸载）。
 */
type CaptureSession = { kind: 'audio' } | { kind: 'camera'; mode: 'photo' | 'video' };

/**
 * 连续日记编辑器（行程/日常通用）——三种入口：不传参 = 今天日常；
 * tripId+date = 行程某天；journalId = 直达某篇。
 *
 * 沉浸化交互承诺（#1/#6/#7，DEV.md）：
 * - 底部工具坞清空：保存状态与字数上 masthead（轻量 meta 行），底部只留
 *   一枚 + 罗盘浮钮；「完成收笔」收进 + 选择器（动作型入口统一一处），
 *   卡内确认步强调「收笔后不可再修改」；
 * - **标题编辑走屏头编辑钮**（#1 屏头同构轮；#3 回退口径）；完成后锁定
 *   （#7）：收笔/跨日即只读；
 * - **录音/拍摄后台继续模型**：采集控制器（AudioRecordingSession /
 *   CameraCaptureOverlay 控制器化）挂本屏层，覆盖层只是视图——关闭按钮
 *   （X）= 收起继续后台执行（录音 → 屏层悬浮计时 chip「● 录音中 0:32」，
 *   点按重开覆盖层无缝恢复；拍摄视频 → CameraView 保持挂载收成右下 96×144
 *   悬浮小窗，点小窗重开全屏），只有手动停止才是真停止 → 落库；取消仅
 *   覆盖层内/小窗长按；**离开编辑屏（返回/收笔）自动停止并落库（不丢素材）**
 *   ——离开拦截点 = 返回钮/硬件返回/收笔入口（captureLeaveRef 登记链），
 *   未拦截路径（iOS 侧滑）由控制器卸载兜底尽力保全（取舍见各控制器注）；
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
    // 采集会话（录音/拍摄后台继续模型）：null = 空闲；一次至多一个采集面
    //（picker/相机/录音互斥保留，编辑插入不受限——后台并行模型）
    const [captureSession, setCaptureSession] = useState<CaptureSession | null>(null);
    // 「完成收笔」等待在途上传的轻量进行态（FAB spinner）
    const [finishing, setFinishing] = useState(false);
    // 多选模式（合并堆叠）：orderedIds = **选择顺序**的块 id 清单（合并重排
    // 按此顺序落位）
    const [selectMode, setSelectMode] = useState<{ orderedIds: string[] } | null>(null);
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
    //（标题不在编辑器落库——编辑入口在首页笔记卡重命名卡，见文件头注）
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

    // 采集离开拦截点（录音/拍摄控制器经 onRegisterLeave 登记 stopForLeave）：
    // 返回/收笔入口调用——录制中自动停录并落库（不丢素材），空闲时 no-op
    const captureLeaveRef = useRef<(() => Promise<void>) | null>(null);
    const registerCaptureLeave = useCallback((stop: (() => Promise<void>) | null) => {
        captureLeaveRef.current = stop;
    }, []);

    // 在途媒体上传注册表（进程内 Map）：pendingId → { promise, kind }——
    // 多任务并行、互不影响；完成收笔经 allSettled 等待全部收敛；任务收敛即
    // 自摘除（见 doAttach）。
    const pendingUploadsRef = useRef(
        new Map<string, { promise: Promise<void>; kind: 'image' | 'video' | 'audio' }>(),
    );
    // 相册选取互斥（系统 picker 单例，防重复拉起）
    const pickingRef = useRef(false);

    // 多选模式 ref 镜像（稳定回调/返回键读取）
    const selectModeRef = useRef(selectMode);
    selectModeRef.current = selectMode;

    const editable = journal ? isEditable(journal.status) : false;
    const saving = store((s) => s.savingJournal);
    const mediaById = useMemo(() => new Map(media.map((row) => [row.id, row])), [media]);
    const chars = useMemo(() => wordCount(blocks), [blocks]);
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
    /** 多选切换（选择顺序保持追加序，合并重排按此顺序落位）。 */
    const toggleSelect = useCallback((blockId: string) => {
        setSelectMode((current) => {
            if (!current) return current;
            const exists = current.orderedIds.includes(blockId);
            return {
                orderedIds: exists
                    ? current.orderedIds.filter((id) => id !== blockId)
                    : [...current.orderedIds, blockId],
            };
        });
    }, []);

    const cancelSelect = useCallback(() => setSelectMode(null), []);

    // 多选编辑器面：选择态屏蔽文本聚焦（editable=false 下传），媒体勾选数据。
    // toggleSelect 在上方声明（useCallback [] 稳定），这里只做 Set 投影。
    const editorEditable = editable && !selectMode;
    const selection = useMemo(
        () =>
            selectMode
                ? { selectedIds: new Set(selectMode.orderedIds), onToggle: toggleSelect }
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
        [blocks, mediaById, editorEditable, focusTextId, canvas, selection, journal, store],
    );

    /**
     * 插入流本体（**后台异步并行**）：pending 占位**同步**插入（即时反馈，
     * 不阻塞继续写字），落盘+落库为后台任务注册进 pendingUploadsRef——多任务
     * 并行互不等待；单任务失败仅回滚该 pending + 上浮 store.error，其余在途
     * 任务不受影响。**只插媒体块**：不追加空文本段、不自动聚焦（想写字自己
     * 点 + →「添加输入框」）。落点/回填走 journal-logic 纯函数（v9 语义）：
     * 占位真实文末追加、回填原位替换；失败仅移除占位。
     * 守卫在入口同步判定：媒体总量（含在途占位）与图片九图配额（已就绪图片
     * + 在途图片任务计数）。updater 一律纯函数（块 id 在 updater 外预生成）。
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
        // 媒体总量守卫：blocks 已含在途 pending 占位（同为 t:'media'，天然计入）
        if (blocksRef.current.filter((block) => block.t === 'media').length >= MAX_MEDIA) {
            store.setState({ error: `本篇媒体最多 ${MAX_MEDIA} 个。` });
            return;
        }
        // 图片配额守卫（微信九图口径）：已就绪图片 + 在途图片任务数
        if (kind === 'image') {
            let pendingImages = 0;
            for (const entry of pendingUploadsRef.current.values()) {
                if (entry.kind === 'image') pendingImages += 1;
            }
            const imageCount =
                countImageBlocks(
                    blocksRef.current,
                    (mediaId) => mediaById.get(mediaId)?.kind === 'image',
                ) + pendingImages;
            if (!canInsertImages(imageCount, 1)) {
                store.setState({ error: `图片最多 ${JOURNAL_IMAGE_LIMIT} 张。` });
                return;
            }
        }
        const pendingId = newBlockId();
        applyBlocks((current) => insertPendingBlock(current, pendingId));
        const label = kind === 'video' ? '视频' : kind === 'audio' ? '录音' : '图片';
        // 后台任务（不 await——并行模型的核心）：收敛后注册表自摘除
        const task = (async () => {
            try {
                const mediaId = await store
                    .getState()
                    .attachJournalMedia(row.id, kind, uri, width, height);
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
        pendingUploadsRef.current.set(pendingId, { promise: task, kind });
        void task.then(() => {
            pendingUploadsRef.current.delete(pendingId);
        });
    };

    /**
     * 离开屏落库（DB 级，无 UI）：停录产物直接追加为**真实媒体块**（无 pending
     * 占位——屏幕即将离开/已离开，占位回填链无人渲染），追加后立刻落库一次。
     * blocks 读写全走 blocksRef 权威镜像：卸载后的兜底 flush、收笔的保存都会
     * 读到包含本块的最新值，不存在「后写覆盖」竞态（见 applyBlocks 注）。
     * 失败仅上浮 error（素材文件留 cache 随系统清理），不阻塞离开。
     */
    const appendLeaveMediaBlock = async (
        journalId: string,
        kind: 'image' | 'video' | 'audio',
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number,
    ) => {
        const mediaId = await store
            .getState()
            .attachJournalMedia(journalId, kind, uri, width, height);
        if (!mediaId) return; // 失败文案已由 store 上浮
        const mediaBlockId = newBlockId();
        applyBlocks((current) => [
            ...current,
            {
                t: 'media' as const,
                id: mediaBlockId,
                mediaId,
                ...(durationMs != null ? { durationMs } : {}),
            },
        ]);
        await store.getState().saveJournalBlocks(journalId, blocksRef.current);
    };

    /** 录音离开屏落库（AudioRecordingSession stopForLeave 消费）。 */
    const persistLeaveRecording = useCallback(
        async (result: RecordingResult) => {
            const row = journalRef.current;
            if (!row || !isEditable(row.status)) return;
            await appendLeaveMediaBlock(row.id, 'audio', result.uri, null, null, result.durationMs);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- appendLeaveMediaBlock 读 ref/store，无状态依赖
        [],
    );

    /** 拍摄离开屏落库（CameraCaptureOverlay stopForLeave 消费）。 */
    const persistLeaveCapture = useCallback(
        async (capture: CameraCapture) => {
            const row = journalRef.current;
            if (!row || !isEditable(row.status)) return;
            await appendLeaveMediaBlock(row.id, capture.kind, capture.uri, capture.width, capture.height);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- appendLeaveMediaBlock 读 ref/store，无状态依赖
        [],
    );

    /** 相册通道：权限 → 选图/选视频 → 统一插入流（doAttach 同步返回，后台并行）。 */
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
                quality: 1,
                exif: false,
            });
            if (result.canceled || result.assets.length === 0) return;
            const asset = result.assets[0];
            doAttach(kind, asset.uri, asset.width ?? null, asset.height ?? null);
        } catch (caught) {
            store.setState({
                error: `${kind === 'video' ? '视频' : '图片'}选取失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            pickingRef.current = false;
        }
    };

    /**
     * 收笔（#7）：录制中先走「离开屏自动停止落库」（等产物落库完成，后续
     * 保存 blocks 才带得上）；再等待全部在途上传收敛（allSettled——单任务
     * 失败已各自上浮 error 并回滚占位，不互相影响也不中止收笔）；保存失败
     * 中止；收笔后本页即只读锁定（无重开路径）。
     */
    const complete = async () => {
        const row = journalRef.current;
        if (!row) return;
        await captureLeaveRef.current?.();
        if (pendingUploadsRef.current.size > 0) {
            setFinishing(true);
            try {
                await Promise.allSettled(
                    Array.from(pendingUploadsRef.current.values(), (entry) => entry.promise),
                );
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

    /** + 选择器动作分发：媒体动作不再受上传阻塞（后台并行）；采集三行保持
     *  「一次一个」互斥（录音/相机进行中给可见反馈）；相册/文本随时可用。 */
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
                // 采集互斥：已有录音/拍摄进行中 → 可见反馈（不静默吞点按）
                if (captureSession) {
                    store.setState({
                        error:
                            captureSession.kind === 'audio'
                                ? '已有录音在进行中。'
                                : '相机使用中，先处理拍摄再来录音。',
                    });
                    return;
                }
                // 麦克风权限由屏层处理（录音覆盖层只负责录制本身）
                const permission = await audio.getRecordingPermissionAsync();
                if (!permission.granted) {
                    const requested = await audio.requestRecordingPermissionAsync();
                    if (!requested.granted) {
                        store.setState({ error: '没有麦克风权限，去系统设置里开一下。' });
                        return;
                    }
                }
                Keyboard.dismiss();
                setCaptureSession({ kind: 'audio' });
                return;
            }
            case 'photo':
            case 'video': {
                if (captureSession) {
                    store.setState({
                        error:
                            captureSession.kind === 'camera'
                                ? '相机使用中，先处理拍摄。'
                                : '录音进行中，不能同时拍摄。',
                    });
                    return;
                }
                Keyboard.dismiss();
                setCaptureSession({ kind: 'camera', mode: action === 'video' ? 'video' : 'photo' });
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

    /** 合并确认：物理重排 + 同 groupId（journal-logic.mergeStackBlocks）。 */
    const confirmMerge = useCallback(() => {
        const current = selectModeRef.current;
        if (!current || current.orderedIds.length < 2) return;
        const ordered = current.orderedIds;
        const groupId = newBlockId();
        applyBlocks((blocks) => mergeStackBlocks(blocks, ordered, groupId));
        setSelectMode(null);
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
        setSelectMode({ orderedIds: [anchor] });
    };

    /** 拍摄覆盖层的相册兜底入口（权限拒绝态）：关闭会话转相册图片通道。 */
    const onCameraLibraryFallback = () => {
        setCaptureSession(null);
        void pick('image');
    };

    // 离开编辑屏（返回钮/硬件返回）：录制/拍摄进行中 = 自动停止并落库（不丢
    // 素材，后台链路自洽，不阻塞返回导航）；多选中 = 先退出选择态；空闲 = 直接
    // 返回。Android 返回键在此收口（浮层各自的 handler 在栈顶优先响应）。
    const handleLeave = useCallback(() => {
        if (selectModeRef.current) {
            setSelectMode(null);
            return;
        }
        void captureLeaveRef.current?.();
        safeBack();
    }, []);

    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            handleLeave();
            return true;
        });
        return () => sub.remove();
    }, [handleLeave]);

    /** 块操作卡动作（上移/下移）：移块不删文件（软删除语义）。读 blocksRef
     *  权威镜像（后台回填/离开追加同帧写入不丢）。 */
    const moveActionBlock = (direction: -1 | 1) => {
        if (!actionBlockId) return;
        const id = actionBlockId;
        applyBlocks((current) => moveBlock(current, id, direction));
    };

    /** 块操作卡动作（删除）：删到空时 removeBlock 会补一个可落笔空段。 */
    const removeActionBlock = () => {
        if (!actionBlockId) return;
        const id = actionBlockId;
        setActionBlockId(null);
        applyBlocks((current) => removeBlock(current, id));
    };

    // 载入失败态（自愈口径，参照 useFileUrlState 三态）：明确失败 + 重试入口，
    // 绝不把失败渲染成永久 spinner；store.error（如「日记初始化失败」）一并展示
    if (loadFailed) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base">
                <View style={{ paddingTop: insets.top }} className="flex-1">
                    {error ? (
                        <Text className="px-6 pb-2 pt-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    ) : null}
                    <EmptyState
                        icon={<LucideBookOpen size={40} color={palette.muted} strokeWidth={1.5} />}
                        title="打不开这一页"
                        hint="日记可能已被删除，或数据读取失败。"
                        actionLabel="重试"
                        onAction={() => void load()}
                    />
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
                    模式）+ 名称行（**有标题才渲染**）+ 编辑钮。命中区核算：
                    - 返回钮：CloseButton 44 圆形触感底盒 in-flow 填满 h-11 行，
                      命中区 = 视觉盒（不传 hitSlop）；
                    - 编辑钮：36 视觉盒 + hitSlop 10 → 56×56 ≥44；
                    - TripBadge 40 盒为非按压体（ml-2 停车距），无命中核算项。 */}
                <View className="px-6 pb-2 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={handleLeave} />
                        {trip ? (
                            <View className="ml-2">
                                <TripBadge icon={trip.icon} size="detail" />
                            </View>
                        ) : null}
                        {title ? (
                            <Text
                                numberOfLines={1}
                                className="ml-2.5 min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                            >
                                {title}
                            </Text>
                        ) : (
                            // 无标题：名称位退场，弹性占位把编辑钮推到右缘
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
                                    <LucidePencil size={16} strokeWidth={1.9} color={palette.secondary} />
                                </View>
                            </BouncyPressable>
                        ) : null}
                    </View>
                    {/* 日期行（#3 恢复第六轮前排版）：30 报头阶 + 右侧状态位 */}
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
                    {/* meta 行（#3）：随机安慰话 + 字数/保存状态（tabular-nums 房规） */}
                    <View className="mt-0.5 flex-row items-baseline justify-between">
                        <Text
                            numberOfLines={1}
                            className="text-[13px] text-ink-secondary dark:text-inkd-secondary"
                        >
                            {comfortQuote}
                        </Text>
                        <Text
                            className="ml-3 shrink-0 text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {editable
                                ? `${chars} 字 · ${saving ? '保存中…' : savedLabel}`
                                : `${chars} 字`}
                        </Text>
                    </View>
                    {/* 行程上下文行（保留：icon + 行程名，trip 模式） */}
                    {trip ? (
                        <Text
                            numberOfLines={1}
                            className="mt-1.5 text-[12px] text-ink-muted dark:text-inkd-muted"
                        >
                            {trip.icon ?? TRIP_ICON_DEFAULT} {trip.title}
                        </Text>
                    ) : null}
                </View>
                {error ? (
                    <Text className="px-6 pb-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {error}
                    </Text>
                ) : null}
                {!editable ? (
                    <Text className="px-6 pb-3 text-[12px] text-ink-muted dark:text-inkd-muted">
                        本页已收笔，内容不可再修改。
                    </Text>
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
                之上但不遮画布（bar 以下区域全部留给媒体勾选点按） */}
            {selectMode ? (
                <View className="absolute inset-x-0 top-0 z-40" style={{ paddingTop: insets.top }}>
                    <View className="flex-row items-center gap-1 border-b border-ink-rule bg-ink-base px-3 py-1 dark:border-inkd-rule dark:bg-inkd-base">
                        <Text
                            className="px-1 text-[13px] font-medium text-ink-text dark:text-inkd-text"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`已选 ${selectMode.orderedIds.length}`}
                        </Text>
                        <View className="flex-1" />
                        <BouncyPressable onPress={cancelSelect} scaleTo={0.95}>
                            <View
                                className="h-11 items-center justify-center rounded-control px-3"
                                accessibilityRole="button"
                                accessibilityLabel="取消合并选择"
                            >
                                <Text className="text-[14px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    取消
                                </Text>
                            </View>
                        </BouncyPressable>
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
                    </View>
                </View>
            ) : null}

            {/* 录音会话（控制器挂屏层，覆盖层只是视图）：停止 = 真停止落库；
                收起 = 后台继续（chip 承接）；取消 = 丢弃；离开屏 = 停录落库 */}
            {captureSession?.kind === 'audio' ? (
                <AudioRecordingSession
                    onFinish={(result) => {
                        setCaptureSession(null);
                        doAttach('audio', result.uri, null, null, result.durationMs);
                    }}
                    onDiscard={() => setCaptureSession(null)}
                    onError={(message) => {
                        setCaptureSession(null);
                        store.setState({ error: message });
                    }}
                    onLeavePersist={persistLeaveRecording}
                    onRegisterLeave={registerCaptureLeave}
                    chipBottomInset={insets.bottom + 32}
                />
            ) : null}
            {/* 拍摄会话（控制器化）：录制中 X = 收成右下悬浮小窗（CameraView 保持
                挂载继续录）；快门/小窗停止 = 落库；覆盖层取消/小窗长按 = 丢弃 */}
            {captureSession?.kind === 'camera' ? (
                <CameraCaptureOverlay
                    initialMode={captureSession.mode}
                    onFinish={(capture) => {
                        setCaptureSession(null);
                        doAttach(capture.kind, capture.uri, capture.width, capture.height);
                    }}
                    onClose={() => setCaptureSession(null)}
                    onDiscard={() => setCaptureSession(null)}
                    onLeavePersist={persistLeaveCapture}
                    onRegisterLeave={registerCaptureLeave}
                    onLibraryFallback={onCameraLibraryFallback}
                />
            ) : null}

            {/* 块操作卡（#1/#9 + 自定义合并堆叠入口）：媒体长按/双击、文本聚焦 ⋯
                → 屏根浮层，条件渲染（禁 RN Modal） */}
            {actionBlockId && actionIndex >= 0 ? (
                <BlockActionCard
                    index={actionIndex}
                    total={blocks.length}
                    canMergeStack={canMergeStack}
                    groupId={actionBlock?.t === 'media' ? actionBlock.groupId ?? null : null}
                    onMove={moveActionBlock}
                    onDelete={removeActionBlock}
                    onMergeStack={openMergeSelect}
                    onDissolveStack={dissolveActionStack}
                    onClose={() => setActionBlockId(null)}
                />
            ) : null}
            {/* 标题重命名卡（屏头编辑钮 → 与首页笔记卡长按卡同语义，共享组件
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
            {/* 插入选择器（+ 号罗盘）：条件渲染遮罩，打开时键盘收起（组件内 blur） */}
            {menuOpen ? (
                <InsertMenu
                    onClose={() => setMenuOpen(false)}
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
            onPress={onPress}
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
 * 块操作卡（上移/下移/合并堆叠/解散堆叠/删除，浮层居中弹出）：屏根条件渲染
 * （禁 RN Modal），深色 scrim + 居中卡片；Android 返回键关闭。媒体块经长按/
 * 双击（组件内 useBlockActionGestures 平台分派）、文本块经聚焦态 ⋯ 钮进入。
 *
 * 自定义合并堆叠入口（本轮新增）：
 * - 「合并堆叠」：canMergeStack（屏内可选图/视频 ≥2）时出现——以当前块为
 *   起点（已选中）进入多选模式；
 * - 「解散堆叠」：当前块带 groupId（显式组成员，含被移散的孤员）时出现——
 *   清 groupId（journal-logic.dissolveStackBlocks）；解散后同 kind 相邻成员
 *   按渲染层自然相邻规则**立即重新成组**（默认分组语义的既定口径，报告注明）。
 */
function BlockActionCard({
    index,
    total,
    canMergeStack,
    groupId,
    onMove,
    onDelete,
    onMergeStack,
    onDissolveStack,
    onClose,
}: {
    /** 当前块下标（决定上移/下移禁用态）。 */
    index: number;
    /** 块总数。 */
    total: number;
    /** 屏内可选媒体（就绪图/视频）≥2 → 显示「合并堆叠」行。 */
    canMergeStack: boolean;
    /** 当前块所属显式组 id（null = 不在显式组 → 无「解散堆叠」行）。 */
    groupId: string | null;
    onMove(direction: -1 | 1): void;
    onDelete(): void;
    onMergeStack(): void;
    onDissolveStack(): void;
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

    const canUp = index > 0;
    const canDown = index < total - 1;
    const rows: Array<{
        key: string;
        icon: React.ReactNode;
        label: string;
        hint?: string;
        danger?: boolean;
        disabled: boolean;
        onPress(): void;
    }> = [
        {
            key: 'up',
            icon: <ChevronUpIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
            label: '上移',
            disabled: !canUp,
            onPress: () => onMove(-1),
        },
        {
            key: 'down',
            icon: <ChevronDownIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
            label: '下移',
            disabled: !canDown,
            onPress: () => onMove(1),
        },
        ...(canMergeStack
            ? [
                  {
                      key: 'merge-stack',
                      icon: <LayersIcon size={18} strokeWidth={1.9} color={palette.secondary} />,
                      label: '合并堆叠',
                      hint: '勾选多张图/视频合成一组',
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
                      hint: '移出堆叠，恢复独立排列',
                      disabled: false,
                      onPress: onDissolveStack,
                  },
              ]
            : []),
        {
            // 尺寸档收敛：16/18/20/24 档内，stroke 1.9 全仓图标口径
            key: 'delete',
            icon: <LucideTrash size={16} strokeWidth={1.9} color={palette.negative} />,
            label: '删除',
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
                <Pressable className="w-full max-w-xs rounded-card bg-ink-base p-2 dark:bg-inkd-base">
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮 */}
                    <View className="flex-row items-center justify-between pl-4 pr-1.5 pt-0.5">
                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                            调整这一块
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右侧贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    <View className="gap-0.5">
                        {/* 行高 44 视觉盒 ≥44：不传 hitSlop（0）；行间 gap-0.5(2px)
                            为不可点间隙，命中盒无重叠。onPress 恒挂接 + disabled 显式
                            传导（#3 条件置空显式化）：row.disabled 随移动操作翻转，
                            条件置空会在翻转瞬间重配置 Pressability 吞首点 */}
                        {rows.map((row) => (
                            <BouncyPressable
                                key={row.key}
                                onPress={row.onPress}
                                disabled={row.disabled}
                                scaleTo={0.98}
                            >
                                <View
                                    className={`h-11 flex-row items-center gap-3 rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface ${
                                        row.disabled ? 'opacity-30' : ''
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityLabel={row.label}
                                >
                                    <View pointerEvents="none">{row.icon}</View>
                                    <Text
                                        className={`text-[15px] font-medium ${
                                            row.danger
                                                ? 'text-ink-negative dark:text-inkd-negative'
                                                : 'text-ink-text dark:text-inkd-text'
                                        }`}
                                    >
                                        {row.label}
                                    </Text>
                                    {row.hint ? (
                                        <Text
                                            numberOfLines={1}
                                            className="ml-auto shrink text-[11px] text-ink-muted dark:text-inkd-muted"
                                        >
                                            {row.hint}
                                        </Text>
                                    ) : null}
                                </View>
                            </BouncyPressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}
