import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    BouncyPressable,
    LucideBookOpen,
    LucidePencil,
    LucidePlus,
    LucideTrash,
} from '@/core/icons';
// 深路径注记：ChevronUp/Down 与 editor 的节奏表/画布句柄未在 ui/index.ts 出口，
// 域内深取（CloseButton 已收口进 barrel，不再深取）。
import { ChevronDownIcon, ChevronUpIcon } from './ui/editor-icons';
import { EDITOR_RHYTHM, type BlockEditorHandle, type EditorCanvasHandle } from './ui/editor';
import { imagePicker } from '@/core/image-picker';
import { audio } from '@/core/audio';
import { useArchiveRevision, useArchiveStore } from './store';
import {
    canInsertImages,
    countImageBlocks,
    insertPendingBlock,
    isEditable,
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
    RecordingOverlay,
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
 * 连续日记编辑器（行程/日常通用）——三种入口：不传参 = 今天日常；
 * tripId+date = 行程某天；journalId = 直达某篇。
 *
 * 沉浸化交互承诺（#1/#6/#7，DEV.md）：
 * - 底部工具坞清空：保存状态与字数上 masthead（轻量 meta 行），底部只留
 *   一枚 + 罗盘浮钮；「完成收笔」收进 + 选择器（动作型入口统一一处），
 *   卡内确认步强调「收笔后不可再修改」；
 * - **标题编辑走屏头编辑钮**（#1 屏头同构轮；#3 回退口径）：masthead =
 *   CloseButton 返回 + TripBadge（trip 模式）+ 名称行（有标题才渲染，无标题
 *   回纯日期口径，不再显示「M月D日 日记」占位名）+ 编辑钮；日期行恢复第六轮
 *   前排版（30px 日期 + 右侧状态）并整体上移；meta 行左槽为随机安慰话
 *   （ui/comfort-quotes，挂载时定一句）。编辑钮打开屏内重命名卡（共享组件
 *   ui/rename-card RenameCard，与首页笔记卡长按卡 archive-screen 同一落库
 *   通道 store.updateJournalTitle）；只读态编辑钮不渲染；
 * - **完成后锁定**（#7）：收笔/跨日即只读，不再自动重开（reopenAttemptedRef
 *   已移除）——「24:00 收笔后不可改」是无例外的产品承诺；
 * - 插入统一走 pending 占位流：录音/拍照/拍视频/相册先插占位块，
 *   落盘后回填真实媒体块（**只插媒体块**：不追加文本段、不自动聚焦——
 *   想写字自己点 + →「添加输入框」）；异常落 store.error 上浮且回滚占位；
 *   updater 一律纯函数（块 id 在提交路径外预生成——#1.2 修复项）；
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
    const [busy, setBusy] = useState(false);
    const [savedAt, setSavedAt] = useState<number | null>(null);
    const [focusTextId, setFocusTextId] = useState<string | null>(null);
    // 插入通道：+ 选择器 / 录音覆盖层 / 拍摄覆盖层 / 块操作卡（条件渲染遮罩，禁 RN Modal）
    const [menuOpen, setMenuOpen] = useState(false);
    const [recordingOpen, setRecordingOpen] = useState(false);
    const [cameraOpen, setCameraOpen] = useState(false);
    const [cameraMode, setCameraMode] = useState<'photo' | 'video'>('photo');
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
    // blocks/journal 同步进 ref（卸载兜底 flush 要取最新值）；dirty 标记是否有未落库改动
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

    /**
     * 插入流本体（busy 由调用方管理）：pending 占位 → file-storage 落盘 → 回填
     * 真实媒体块。**只插媒体块**：不追加空文本段、不自动聚焦新输入框（用户
     * 反馈——想写字自己点 + →「添加输入框」，媒体插入只管媒体本身，pending
     * 占位 → 回填的既有流程不变）。异常上浮 error 并回滚占位。
     * 落点/回填走 journal-logic 纯函数（v9 插入语义回正，用户裁决推翻 v8）：
     * - 占位插入点 = **真实文末追加**（不跳位：v8 的「图片插到最后一个图片
     *   块之后」会在堆叠位于文档中间、且其后已加输入框/音频/视频时越过新
     *   内容并入旧堆叠，破坏文档时间线）；回填后是否并入堆叠只由**自然相
     *   邻**决定（buildRenderUnits 连续相邻判定）——堆叠恰在文末 → 新图紧
     *   邻并入；堆叠在中间/其后有其他内容 → 新图文末独立不成组；
     * - 回填 = 占位**原位替换**为真实媒体块（v8 修复保留：占位不被后续编
     *   辑挤漂移，真实块留在插入位置）；失败仅移除占位。
     * updater 一律纯函数：块 id 在 updater 外预生成（#1.2：旧实现把 id 生成/
     * 焦点副作用夹进 updater，并发重跑会生成漂移 id，媒体回填竞态下布局错乱）。
     *
     * @returns 本次插入的 pending 占位块 id（供调用方兜底 catch 精确回滚）。
     */
    const doAttach = async (
        kind: 'image' | 'video' | 'audio',
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number,
    ) => {
        if (!journal) return null;
        const pendingId = newBlockId();
        // 先插 pending 占位（真实文末追加，不阻塞继续写字），落盘后原位回填
        setBlocks((current) => insertPendingBlock(current, pendingId));
        try {
            const mediaId = await store.getState().attachJournalMedia(journal.id, kind, uri, width, height);
            // 媒体块 id 在 updater 外预生成（#1.2 纯函数纪律）；落库失败不生成
            const mediaBlockId = mediaId ? newBlockId() : null;
            setBlocks((current) =>
                // 原位回填：段落数量不变、不补空文本段；落库失败（store 已上浮
                // error）仅移除占位，不进无效媒体块（画布段落由既有不变量保证
                // 非空）；只动本 pendingId，不误伤其他在途占位
                resolvePendingBlock(
                    current,
                    pendingId,
                    mediaId && mediaBlockId
                        ? { blockId: mediaBlockId, mediaId, durationMs }
                        : null,
                ),
            );
        } catch (caught) {
            // 通道失败（环境/权限/取消异常）必须可见，不能是"点了没反应"
            const label = kind === 'video' ? '视频' : kind === 'audio' ? '录音' : '图片';
            store.setState({
                error: `${label}保存失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
            // 回滚 pending 占位（按 pendingId 精确回滚，不全局过滤）
            setBlocks((current) => resolvePendingBlock(current, pendingId, null));
        }
        return pendingId;
    };

    /**
     * 图片配额守卫（相册/拍照两路径统一入口，#5b）：现有图片数 + 待插张数
     * 超过 JOURNAL_IMAGE_LIMIT（journal-logic 常量，微信九图口径）→ 落
     * store.error 可见提示并拒绝。守卫触发必须给可见反馈（同 busy 守卫
     * #1 口径）；kind 判定注入 mediaById（pending 占位查不到行不计入）。
     * 返回 true = 放行。
     */
    const assertImageQuota = (incoming: number): boolean => {
        const imageCount = countImageBlocks(
            blocks,
            (mediaId) => mediaById.get(mediaId)?.kind === 'image',
        );
        if (canInsertImages(imageCount, incoming)) return true;
        store.setState({ error: `图片最多 ${JOURNAL_IMAGE_LIMIT} 张。` });
        return false;
    };

    /**
     * 插入统一入口（录音/拍摄完成回调用）：busy 守卫 + 上限守卫 + 统一流。
     * 守卫触发必须给可见反馈（#1「点了没反应」修复面）：静默 return 会被
     * 感知为「没点上，再点一下才好」。图片路径在总量守卫之外再过图片配额
     * （JOURNAL_IMAGE_LIMIT = 9，拍照与相册同闸）。
     */
    const attachMedia = async (
        kind: 'image' | 'video' | 'audio',
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number,
    ) => {
        if (!journal) return;
        if (busy) {
            store.setState({ error: '上一个媒体还在保存，稍等一下。' });
            return;
        }
        const mediaCount = blocks.filter((b) => b.t === 'media').length;
        if (mediaCount >= MAX_MEDIA) {
            store.setState({ error: `本篇媒体最多 ${MAX_MEDIA} 个。` });
            return;
        }
        if (kind === 'image' && !assertImageQuota(1)) return;
        setBusy(true);
        try {
            await doAttach(kind, uri, width, height, durationMs);
        } catch (caught) {
            // 中断场景：doAttach 之外的意外 reject 也必须可见——只写 finally 会让
            // busy 复位但异常变 unhandled rejection。占位回滚已由 doAttach 自愈
            // （其内部 catch 按 pendingId 精确回滚，v8 起不再在外层做全局 pending
            // 过滤——那会误删其他在途占位）
            store.setState({
                error: `媒体插入失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setBusy(false);
        }
    };

    /** 相册通道：权限 → 选图/选视频 → 统一插入流。图片在打开 picker 前先过
     *  配额守卫（与拍照同闸，省一次权限流程；当前通道单张选入，incoming=1，
     *  未来放开多选时传批量张数即可）。 */
    const pick = async (kind: 'image' | 'video') => {
        if (!journal) return;
        if (busy) {
            store.setState({ error: '上一个媒体还在保存，稍等一下。' });
            return;
        }
        const mediaCount = blocks.filter((b) => b.t === 'media').length;
        if (mediaCount >= MAX_MEDIA) {
            store.setState({ error: `本篇媒体最多 ${MAX_MEDIA} 个。` });
            return;
        }
        if (kind === 'image' && !assertImageQuota(1)) return;
        setBusy(true);
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
            await doAttach(kind, asset.uri, asset.width ?? null, asset.height ?? null);
        } catch (caught) {
            store.setState({
                error: `${kind === 'video' ? '视频' : '图片'}选取失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setBusy(false);
        }
    };

    /** 收笔（#7）：保存失败中止；收笔后本页即只读锁定（无重开路径）。 */
    const complete = async () => {
        if (!journal) return;
        if (busy) {
            store.setState({ error: '媒体还在保存，稍等一下再收笔。' });
            return;
        }
        // 保存失败必须中止收笔：否则旧内容会连同本次输入一起封存。
        // 结果按 unknown 收窄判断：旧契约返回 void（放行），store 侧正收紧为
        // Promise<boolean>（false 中止）——两种形态下这里的语义都成立
        const saved: unknown = await store.getState().saveJournalBlocks(journal.id, blocks);
        if (saved === false) return;
        await store.getState().completeJournal(journal.id);
        safeBack();
    };

    /** + 选择器动作分发：录音/拍照/拍视频先收键盘，相册走既有 picker 通道，
     *  添加输入框走块栈追加（#11）。busy 只护媒体通道（非媒体动作放行）。 */
    const runInsert = async (action: InsertAction) => {
        if (!journal) return;
        if (action !== 'complete' && action !== 'append-text' && busy) {
            store.setState({ error: '上一个媒体还在保存，稍等一下。' });
            return;
        }
        switch (action) {
            case 'complete': {
                Keyboard.dismiss();
                await complete();
                return;
            }
            case 'record': {
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
                setRecordingOpen(true);
                return;
            }
            case 'photo':
                Keyboard.dismiss();
                setCameraMode('photo');
                setCameraOpen(true);
                return;
            case 'video':
                Keyboard.dismiss();
                setCameraMode('video');
                setCameraOpen(true);
                return;
            case 'library-image':
                void pick('image');
                return;
            case 'library-video':
                void pick('video');
                return;
            case 'append-text': {
                // 「+ → 添加输入框」（#11）：块 id 在 updater 外预生成、焦点走
                // focusTextId 通道（TextBlock 内延后一帧聚焦 + Android 滚动补偿，
                // 机制不变）。末段已是空段时不堆积空行，直接聚焦续写（连点两次 +
                // 不会出现两个空段）。注：媒体插入已改为不自动建段，本动作是
                // 唯一的手动加段入口。
                // 闭包 blocks 判定安全：菜单打开期间键盘已收起，blocks 不会变化。
                const last = blocks[blocks.length - 1];
                if (last && last.t === 'p' && last.text === '') {
                    setFocusTextId(last.id);
                    return;
                }
                const appended = newParagraphBlock();
                setBlocks((current) => [...current, appended]);
                setFocusTextId(appended.id);
                return;
            }
        }
    };

    const onRecordingComplete = (result: RecordingResult) => {
        setRecordingOpen(false);
        void attachMedia('audio', result.uri, null, null, result.durationMs);
    };

    const onCameraCapture = (capture: CameraCapture) => {
        setCameraOpen(false);
        void attachMedia(
            capture.kind,
            capture.uri,
            capture.width,
            capture.height,
        );
    };

    /** 拍摄覆盖层的相册兜底入口（权限拒绝态）：转相册图片通道。 */
    const onCameraLibraryFallback = () => {
        setCameraOpen(false);
        void pick('image');
    };

    /** 块操作卡动作（上移/下移/删除）：移块不删文件（软删除语义）。 */
    const moveActionBlock = (direction: -1 | 1) => {
        if (!actionBlockId) return;
        const id = actionBlockId;
        setBlocks((current) => moveBlock(current, id, direction));
    };
    const removeActionBlock = () => {
        if (!actionBlockId) return;
        const id = actionBlockId;
        setActionBlockId(null);
        // 删到空时 removeBlock 会补一个可落笔空段（编辑器永不空容器）
        setBlocks((current) => removeBlock(current, id));
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
                    状态同一基线行，整体上移到报头最紧位置；上一轮的「名称行常驻 +
                    日期徽章角色」组合撤销）。结构：CloseButton 返回 + TripBadge
                    （trip 模式）+ 名称行（**有标题才渲染**，无标题回纯日期口径，
                    不再显示「M月D日 日记」占位名）+ 编辑钮（铅笔 → 屏内标题重命名
                    卡，保留；只读态不渲染）。命中区核算：
                    - 返回钮：CloseButton 44 圆形触感底盒 in-flow 填满 h-11 行，
                      命中区 = 视觉盒（不传 hitSlop），命中底缘 = insets.top + 8 + 44；
                    - 顶部 pt-2 与 trip-detail 屏头容器（px-6 pb-3 pt-2）同口径——
                      native 上 insets.top 掩盖差异、web（insets.top=0）会裸露 8dp
                      错位，故报头顶距必须与行程屏逐 dp 对齐；日期行行盒顶 =
                      insets.top + 52；与返回钮命中底缘齐平但为 in-flow 兄弟
                      节点，天然无重叠；30px 行盒自带 ~4dp 字面 leading 作视觉净空；
                    - 编辑钮：36 视觉盒 + hitSlop 10 → 56×56 ≥44（trip-detail
                      编辑钮同口径）；左邻名称/占位为非按压体、右缘距屏 24，无
                      重叠核算项；
                    - TripBadge 40 盒为非按压体（ml-2 停车距），无命中核算项。 */}
                <View className="px-6 pb-2 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
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
                    {/* 日期行（#3 恢复第六轮前排版）：30 报头阶 + 右侧状态位（进行中/
                        已收笔，工具坞下沉的状态位 #1 同行右对齐）——上移见上核算 */}
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
                    {/* meta 行（#3）：原时间/星期槽位改为随机安慰话（挂载时定一句，
                        语料见 ui/comfort-quotes）；字数/保存状态保持原位（tabular-nums
                        房规；只读态只展示字数） */}
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
                    {/* 行程上下文行（保留：icon + 行程名，trip 模式——在写谁的哪一天）。
                        icon 空值兜底走 TRIP_ICON_DEFAULT 具名常量（trip-badge 收口纪律，
                        不散写字面量） */}
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
                    // iOS：键盘弹出时滚动位置由系统 insets 自动补偿（主补偿，与键盘
                    // 动画同源同帧），编辑器定位器只在聚焦段完全不可见时补一次
                    // （防双写打架，见 editor.createFocusedBlockPositioner 注）；
                    // Android 走 adjustResize 整体重排 + 定位器「最佳位置」落位；
                    // Web 走浏览器原生 focus scroll-into-view
                    automaticallyAdjustKeyboardInsets
                    // 滚动即拖拽收键盘（journal 手感；Android interactive 回落 on-drag 语义）
                    keyboardDismissMode="interactive"
                >
                    {/* 画布空白收键层（#K2）：块间 gap、内容区 padding、报头下方留白
                        ——未被子元素认领的区域点按 → 收键盘 + blur 聚焦段。原
                        contentContainerStyle 三向 padding 全数下沉到本层（几何不变，
                        padding 区变成可点面）。防误触机制：
                        - Pressable tap 语义：滚动接管的手势不触发 onPress（滚动手感
                          中不误收键盘），长按/横滑等被子元素认领的手势同样到不了本层；
                        - dismissKeyboard 空引用闸（BlockEditorHandle）：无聚焦段空点
                          零动作；引用同步清空，双击第二击短路（防连点抖动）；
                        - 子元素认领优先：输入框本体/媒体块/音频卡/⋯微钮/deck 点按带
                          各自消费，零影响；块操作卡/重命名卡/选择器/录音/拍摄等浮层
                          在屏根后渲染、层级恒在本层之上（不抢）；+ 浮钮 z-10 悬浮于
                          本层之上；报头在 ScrollView 之外（报头点击无动作，保持）。
                        触摸面零 className（房规：css-interop 按压 observable 不进
                        手势窗口）；无障碍不挂 role（背景装饰层，非交互语义）。 */}
                    <Pressable
                        onPress={() => editorRef.current?.dismissKeyboard()}
                        style={{
                            // 画布顶部留白 16dp：叠加报头 pb-2(8dp) 后，报头→首段净间距
                            // 24dp（EDITOR_RHYTHM.mastheadToFirstBlock；360dp 小屏到平板
                            // 同值，间距体系不随屏宽变化）
                            paddingTop: 16,
                            paddingHorizontal: 24,
                            paddingBottom: insets.bottom + 96,
                        }}
                    >
                        {/* 阅读列：桌面端行长 ≤80 字符（可读性口径）；媒体块与正文同列宽对齐。
                            onRequestActionBlock 恒挂接（条件置空显式化 #3）：只读关断在编辑器
                            源头把门（微钮只按 editable 渲染、媒体块 onBlockAction 同口径），
                            本回调仅被可编辑路径触达；undefined↔fn 翻转没有可观察收益，只增加
                            状态翻转时的重配置窗口 */}
                        <View className="mx-auto w-full max-w-[620px]">
                            <BlockEditor
                                ref={editorRef}
                                blocks={blocks}
                                mediaById={mediaById}
                                editable={editable}
                                focusTextId={focusTextId}
                                canvas={canvas}
                                onChange={setBlocks}
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
                    </Pressable>
                </ScrollView>

                {/* 罗盘 + 号（#1：底部工具坞清空，只留一枚 + 浮钮）：右手拇指区，
                    位置口径同 compose-fab（bottom + 24）；全程可点（busy 不禁用——
                    上传中也能打开选择器，动作分发处统一给可见反馈），杀掉
                    「上传中点 + 没反应 → 再点一下才好」的假双击感知 */}
                {editable ? (
                    // right-6（24）：与 ComposeFab 同一屏隅口径（原 right-5(20) 双轨，收敛）
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
                                <LucidePlus size={24} color={palette.onPrimaryBtn} strokeWidth={2.2} />
                            </View>
                        </BouncyPressable>
                    </View>
                ) : null}
            </View>

            {/* 块操作卡（#1/#9：媒体长按/双击、文本聚焦 ⋯ → 屏根浮层，条件渲染） */}
            {actionBlockId && actionIndex >= 0 ? (
                <BlockActionCard
                    index={actionIndex}
                    total={blocks.length}
                    onMove={moveActionBlock}
                    onDelete={removeActionBlock}
                    onClose={() => setActionBlockId(null)}
                />
            ) : null}
            {/* 标题重命名卡（屏头编辑钮 → 与首页笔记卡长按卡同语义，共享组件
                ui/rename-card；条件渲染 scrim，禁 RN Modal）。落库通道经 onSave
                注入（store.updateJournalTitle，不回退）；onClose 一律回读刷新：
                保存成功以 DB 归一化结果为准（normalizeJournalTitle 落库），取消时
                为幂等回读 */}
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
            {/* 录音覆盖层：卡片浮层 + 声纹条；停止落库 / 取消丢弃 */}
            {recordingOpen ? (
                <RecordingOverlay
                    onComplete={onRecordingComplete}
                    onCancel={() => setRecordingOpen(false)}
                    onError={(message) => {
                        setRecordingOpen(false);
                        store.setState({ error: message });
                    }}
                />
            ) : null}
            {/* 拍摄覆盖层：卡片取景 + 快门/翻转/关闭（拍照/视频 + 权限拒绝引导与相册兜底） */}
            {cameraOpen ? (
                <CameraCaptureOverlay
                    initialMode={cameraMode}
                    onClose={() => setCameraOpen(false)}
                    onCapture={onCameraCapture}
                    onLibraryFallback={onCameraLibraryFallback}
                />
            ) : null}
        </KeyboardAvoidingView>
    );
}

/**
 * 块操作卡（上移/下移/删除，浮层居中弹出）：屏根条件渲染（禁 RN Modal），
 * 深色 scrim + 居中卡片；Android 返回键关闭。媒体块经长按/双击（组件内
 * useBlockActionGestures 平台分派）、文本块经聚焦态 ⋯ 微钮进入。
 */
function BlockActionCard({
    index,
    total,
    onMove,
    onDelete,
    onClose,
}: {
    /** 当前块下标（决定上移/下移禁用态）。 */
    index: number;
    /** 块总数。 */
    total: number;
    onMove(direction: -1 | 1): void;
    onDelete(): void;
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
        {
            // 尺寸档收敛：17 → 16（16/18/20/24 档内），stroke 1.9 全仓图标口径
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
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮（scrim 点击与 Android
                        返回键之外的显式出口，与其他浮层卡同一设计语言） */}
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
                            传导（#3 条件置空显式化）：row.disabled 随每次移动操作高频
                            翻转，条件置空会在翻转瞬间重配置 Pressability 吞首点；显式
                            disabled=true 时 BouncyPressable 不出按压反馈、触摸穿透到
                            无按压体的 scrim（行为矩阵见 bouncy-pressable 文件头），
                            可观察行为与置空一致 */}
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
                                </View>
                            </BouncyPressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}
