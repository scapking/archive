import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import {
    BouncyPressable,
    LucideBell,
    LucideCheck,
    LucideImage,
    LucideMapPin,
    LucidePlus,
    LucideTrash,
    LucideVideo,
} from '@/core/icons';
import { clipboard } from '@/core/clipboard';
import { imagePicker } from '@/core/image-picker';
// 深路径注记：tintIcon 未入 ui/index.ts 出口（域内深取纪律，同 editor-icons 先例）。
import { tintIcon } from './ui/editor-icons';
// 深路径注记：节奏表 / 画布句柄 / 键盘动态垫高 hook / FieldInput 未在 ui/index.ts
// 出口（域内深取纪律，先例同 journal-edit / trip-detail）。
import {
    useKeyboardCanvasBottomPadding,
    type BlockEditorHandle,
    type EditorCanvasHandle,
} from './ui/editor';
import { FieldInput } from './ui/field-input';
import * as db from './db';
import type { EventMediaRow, EventRow, EventSubjectKind, JournalMediaRow } from './db';
import { useArchiveRevision, useArchiveStore } from './store';
import {
    EVENT_HANDLED_BY_MAX,
    EVENT_SUBJECT_KINDS,
    EVENT_SUBJECT_KIND_LABELS,
    EVENT_SUBJECT_VALUE_MAX,
    eventSubjectKindLabel,
    eventTimeline,
} from './event-logic';
import {
    insertPendingBlock,
    moveBlock,
    newBlockId,
    newParagraphBlock,
    parseBlocks,
    removeBlock,
    resolvePendingBlock,
    wordCount,
    type JournalBlock,
} from './journal-logic';
import {
    BlockEditor,
    CloseButton,
    EmptyState,
    LoadingView,
    safeBack,
    usePalette,
} from './ui';
import { EventStatusChip } from './ui/event-card';

/**
 * 事件详情编辑页（/events/[id]，笔记编辑式 + 状态头）：
 *
 * - **状态头（工单语言）**：标题行（**只读**——store.updateEventMeta 的 patch
 *   契约不含 title（store.ts 实读确认，db.EventMetaPatch 亦无 title 列），标题
 *   创建后不可改；本组不改 store（契约冻结），标题行退为纯展示并已在报告注明
 *   取舍）+ 状态片可点切换（open ↔ done，updateEventMeta）+ 时间线（创建/最近
 *   更新，event-logic.eventTimeline 单一口径）+ GPS 坐标行（点按复制，clipboard）
 *   + 处理人/对象行（点按弹元信息编辑卡，updateEventMeta，对象为原子对归一）；
 * - **正文 = BlockEditor 复用**（事件 blocks 与 journal 块模型同构，JournalBlock
 *   不变；mediaId → event_media 行经 toJournalMediaRow 适配器喂编辑器的
 *   mediaById 契约——行结构同构，仅 journal_id 槽位以 event_id 占位）：
 *   800ms 防抖 updateEventBlocks + 失焦即存双通道 + 卸载兜底 flush（含在途
 *   上传 allSettled 收敛后再存——比 journal-edit 的裸 flush 多一层在途回填
 *   保护，防「上传完成于卸载之后，块引用永不落库」的对账误杀）；
 * - **插入后台异步并行**（完整对齐 journal-edit 的 attach 模式）：doAttach 同步
 *   插 pending 占位即返回，attachEventMedia 落盘+落库为后台任务（pendingUploadsRef
 *   注册表，多任务并行）；收敛后 resolvePendingBlock 原位回填，失败仅回滚本占位
 *   + store.error。store.attachEventMedia 无 AttachMediaOptions（无 taskId 进度
 *   注册面），占位块按编辑器既有语义保持 spinner（诚实降级，进度环不做假）；
 * - **媒体入口本轮只提供相册图片/相册视频**（+ 添加输入框）：拍照/拍视频/录音
 *   走全局录制会话，其归属模型绑定 ownerJournalId（recording-session 契约），
 *   事件归属需要扩展会话模型——本轮不动 recording-session（不属于本组改动面），
 *   报告留待后续；相册插入走 attachEventMedia（copy 语义，不动源文件）；
 * - **删除**：危险区（删除事件行 + 确认卡）→ deleteEvent 级联软删 + safeBack
 *   回列表；deletedRef 闸防删除后的卸载 flush 把 blocks 写回已删行。
 *
 * typedRoutes：动态路由参数经 useLocalSearchParams 读取（同 trip-detail 范式），
 * 屏内不产生新的路由字面量。
 */

/** 每个事件的媒体上限（防误触爆量；对齐 journal-edit 的 MAX_MEDIA 口径）。
 *  事件无九图配额语义（工单媒体密度低于日记），单闸收口。 */
const MAX_MEDIA = 12;

/** 画布底部静态垫高基线（dp）：给 + 浮钮让位（journal-edit 同款几何）。 */
const CANVAS_BOTTOM_BASE_INSET = 96;

/**
 * 媒体行适配器：EventMediaRow → 编辑器 mediaById 契约（JournalMediaRow）。
 * 两表列完全同构（schema v6 对齐 trip_media），journal_id 槽位以 event_id
 * 占位（编辑器/媒体组件只消费 file_key/kind/width/height，占位值不落库）。
 */
function toJournalMediaRow(row: EventMediaRow): JournalMediaRow {
    return {
        id: row.id,
        journal_id: row.event_id,
        file_key: row.file_key,
        kind: row.kind,
        width: row.width,
        height: row.height,
        created_at: row.created_at,
        deleted_at: row.deleted_at,
    };
}

export function EventDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const eventId = typeof id === 'string' ? id : null;
    const insets = useSafeAreaInsets();
    const revision = useArchiveRevision();
    const store = useArchiveStore;
    const error = store((s) => s.error);
    const palette = usePalette();

    // ─── 数据载入（行 + 正文块一次载入；媒体行随 revision 重载）──────────────
    const [event, setEvent] = useState<EventRow | null>(null);
    const [blocks, setBlocks] = useState<JournalBlock[]>([]);
    const [media, setMedia] = useState<JournalMediaRow[]>([]);
    const [loadFailed, setLoadFailed] = useState(false);
    const loadAttemptRef = useRef(0);
    const load = useCallback(async () => {
        const attempt = ++loadAttemptRef.current;
        setLoadFailed(false);
        try {
            // eventId 缺失（路由参数异常）= 打不开：进失败态而非永久 spinner
            const row = eventId ? await db.getEvent(eventId) : null;
            if (attempt !== loadAttemptRef.current) return;
            if (!row) {
                setLoadFailed(true);
                return;
            }
            setEvent(row);
            setBlocks(parseBlocks(row.blocks));
        } catch {
            // 中断场景：db 调用失败必须落失败态（DeadEnd 口径可重试）
            if (attempt !== loadAttemptRef.current) return;
            setLoadFailed(true);
        }
    }, [eventId]);

    useEffect(() => {
        void load();
        return () => {
            // 卸载即作废在途载入（setState-after-unmount 防护，序号守卫）
            loadAttemptRef.current += 1;
        };
    }, [load]);

    // 媒体行随 revision 重载（attach/removeEventMedia 等 mutation 只 bump
    // revision；键 = eventId，不随 event 行对象引用漂移）
    useEffect(() => {
        if (!eventId) return;
        let active = true;
        db.listEventMediaByEvent(eventId)
            .then((rows) => {
                if (active) setMedia(rows.map(toJournalMediaRow));
            })
            .catch((caught) => {
                // 中断场景：媒体行刷新 reject 不能 unhandled（红屏）；revision
                // 变化（含下一次保存成功）会自动重试
                if (active) {
                    store.setState({
                        error: `媒体列表读取失败：${caught instanceof Error ? caught.message : String(caught)}`,
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [eventId, revision, store]);

    // ─── 正文编辑态（blocksRef 权威镜像 + 防抖落库，journal-edit 同构）────────
    // blocks/journal 同步进 ref（卸载兜底 flush / 后台链路取最新值）；所有写入
    // 一律经 applyBlocks（同步写 ref 再 setState），后台回填链并发安全。
    const firstRender = useRef(true);
    const blocksRef = useRef(blocks);
    const eventRef = useRef(event);
    const dirtyRef = useRef(false);
    // 删除竞态闸：deleteEvent 成功后置位——卸载 flush / 防抖保存不得再向已删行
    // 回写 blocks（db.updateEventBlocks 按 id 直更，无 deleted_at 过滤）
    const deletedRef = useRef(false);
    blocksRef.current = blocks;
    eventRef.current = event;
    // 挂载镜像（在途上传收敛于卸载之后的兜底保存闸）
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    /**
     * blocks 唯一写入口（ref 权威镜像 + setState）：读 ref 当前值算 next、
     * 同步回写 ref 再提交渲染——并发链路（多在途上传同帧回填、文本编辑）按
     * 到达序串行合并不丢写；卸载后 setBlocks 被忽略，ref 仍供兜底链读取。
     */
    const applyBlocks = useCallback(
        (updater: (current: JournalBlock[]) => JournalBlock[]) => {
            const next = updater(blocksRef.current);
            blocksRef.current = next;
            setBlocks(next);
        },
        [],
    );

    // 防抖自动保存（800ms）：跳过载入回填帧；成功同时轻量推进本地 updated_at
    //（时间线「最近更新」即时反映，权威值以下次 refreshMeta 回读为准）
    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }
        if (!event || deletedRef.current) return;
        dirtyRef.current = true;
        const timer = setTimeout(() => {
            dirtyRef.current = false;
            store
                .getState()
                .updateEventBlocks(event.id, blocks)
                .then((saved: unknown) => {
                    if (saved === false) {
                        // 保存失败置回 dirty：卸载兜底 flush 会再补存
                        dirtyRef.current = true;
                    } else {
                        setSavedAt(Date.now());
                        setEvent((prev) => (prev ? { ...prev, updated_at: Date.now() } : prev));
                    }
                })
                .catch(() => {
                    // store 内部已落 error 文案；这里防 unhandled rejection
                    dirtyRef.current = true;
                });
        }, 800);
        return () => clearTimeout(timer);
    }, [blocks, event, store]);

    const [savedAt, setSavedAt] = useState<number | null>(null);

    /** 失焦即存（防抖的双保险通道）。 */
    const saveNow = useCallback(async () => {
        const row = eventRef.current;
        if (!row || deletedRef.current) return;
        const saved = await store.getState().updateEventBlocks(row.id, blocksRef.current);
        if (saved !== false) {
            setSavedAt(Date.now());
            setEvent((prev) => (prev ? { ...prev, updated_at: Date.now() } : prev));
        } else {
            dirtyRef.current = true;
        }
    }, [store]);

    // 卸载兜底 flush：防抖窗口内退出补存最后一次正文。对 journal-edit 裸 flush
    // 的增强：先等全部在途上传收敛（allSettled）再存 blocksRef——回填块此时已
    // 在 ref 里，媒体行引用随本次保存闭合，不会被下次会话的对账误杀。
    useEffect(() => {
        return () => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return;
            const pending = Array.from(pendingUploadsRef.current.values(), (entry) => entry.promise);
            if (!dirtyRef.current && pending.length === 0) return;
            dirtyRef.current = false;
            void (async () => {
                if (pending.length > 0) await Promise.allSettled(pending);
                // 收敛期间事件被删除（deletedRef 置位）→ 跳过回写
                if (!deletedRef.current) {
                    await store
                        .getState()
                        .updateEventBlocks(row.id, blocksRef.current)
                        .catch(() => undefined);
                }
            })();
        };
    }, [store]);

    // ─── 元信息（状态切换 / 处理人 / 对象 / 坐标复制）──────────────────────────
    /** meta 落库成功后的权威回读（只影响 meta 展示；blocks 本地态不受影响）。 */
    const refreshMeta = useCallback(async () => {
        const row = eventRef.current;
        if (!row) return;
        try {
            const fresh = await db.getEvent(row.id);
            if (fresh && mountedRef.current) setEvent(fresh);
        } catch {
            // 幂等刷新失败保留当前态（保存本体已在卡内确认），下次进入按 DB 校正
        }
    }, []);

    const toggleStatus = useCallback(async () => {
        const row = eventRef.current;
        if (!row || deletedRef.current) return;
        const next = row.status === 'open' ? 'done' : 'open';
        const ok = await store.getState().updateEventMeta(row.id, { status: next });
        if (ok) void refreshMeta();
    }, [store, refreshMeta]);

    const saveHandledBy = useCallback(
        async (value: string) => {
            const row = eventRef.current;
            if (!row) return false;
            // 空串经 store 归一为 null = 清除（normalizeEventText 口径）
            const ok = await store.getState().updateEventMeta(row.id, { handledBy: value });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    const saveSubject = useCallback(
        async (kind: EventSubjectKind | null, value: string) => {
            const row = eventRef.current;
            if (!row) return false;
            // 原子对整对下发：kind null（显式清除）或 kind+value；归一化在 store
            // （normalizeEventSubject：任一侧缺失 → 双双置空）
            const ok = await store.getState().updateEventMeta(row.id, {
                subjectKind: kind,
                subjectValue: kind === null ? null : value,
            });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    // 坐标复制反馈（check 图标短暂出现，me 页 UID 同款）
    const [gpsCopied, setGpsCopied] = useState(false);
    const gpsCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        return () => {
            if (gpsCopyTimer.current) clearTimeout(gpsCopyTimer.current);
        };
    }, []);
    const copyGps = useCallback(async () => {
        const row = eventRef.current;
        if (!row || row.gps_lat == null || row.gps_lng == null) return;
        try {
            const ok = await clipboard.setStringAsync(`${row.gps_lat}, ${row.gps_lng}`);
            setGpsCopied(ok);
            if (gpsCopyTimer.current) clearTimeout(gpsCopyTimer.current);
            gpsCopyTimer.current = setTimeout(() => setGpsCopied(false), 1600);
        } catch {
            // 剪贴板异常不外抛：反馈图标不出现即是失败信号
            setGpsCopied(false);
        }
    }, []);

    // ─── 插入流（后台异步并行，journal-edit 同构）────────────────────────────
    const [focusTextId, setFocusTextId] = useState<string | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [actionBlockId, setActionBlockId] = useState<string | null>(null);
    // 在途媒体上传注册表（进程内 Map）：pendingId → { promise, kind }——多任务
    // 并行互不影响；任务收敛即自摘除
    const pendingUploadsRef = useRef(
        new Map<string, { promise: Promise<void>; kind: 'image' | 'video' }>(),
    );
    // 相册选取互斥（系统 picker 单例，防重复拉起）
    const pickingRef = useRef(false);

    const mediaById = useMemo(() => new Map(media.map((row) => [row.id, row])), [media]);
    const chars = useMemo(() => wordCount(blocks), [blocks]);

    /**
     * 插入流本体（**后台异步并行**）：pending 占位**同步**插入（即时反馈），
     * attachEventMedia 为后台任务注册进 pendingUploadsRef——多任务并行互不等待；
     * 单任务失败仅回滚本 pending + 上浮 store.error。落点/回填走 journal-logic
     * 纯函数（真实文末追加、原位替换）；updater 纯函数（块 id 在 updater 外
     * 预生成——#1.2 纪律）。
     */
    const doAttach = useCallback(
        (kind: 'image' | 'video', uri: string, width: number | null, height: number | null) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return;
            // 媒体总量守卫：blocks 已含在途 pending 占位（同为 t:'media'，天然计入）
            if (blocksRef.current.filter((block) => block.t === 'media').length >= MAX_MEDIA) {
                store.setState({ error: `本事件媒体最多 ${MAX_MEDIA} 个。` });
                return;
            }
            const pendingId = newBlockId();
            applyBlocks((current) => insertPendingBlock(current, pendingId));
            const label = kind === 'video' ? '视频' : '图片';
            const task = (async () => {
                try {
                    // 注意：attachEventMedia 契约无 taskId 进度面（store 实读）——
                    // 占位块按编辑器默认保持 spinner 态（诚实降级，不做假进度）
                    const mediaId = await store
                        .getState()
                        .attachEventMedia(row.id, kind, uri, width, height, null);
                    // 媒体块 id 在 updater 外预生成；落库失败不生成
                    const mediaBlockId = mediaId ? newBlockId() : null;
                    applyBlocks((current) =>
                        resolvePendingBlock(
                            current,
                            pendingId,
                            mediaId && mediaBlockId
                                ? { blockId: mediaBlockId, mediaId }
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
        },
        [applyBlocks, store],
    );

    /**
     * 相册通道（多选）：权限 → 批量选图/选视频 → 按选取顺序逐张插入流。多选
     * 上限 = 媒体总量剩余配额（事件无九图配额语义，单闸 MAX_MEDIA）；不严格
     * 执行 selectionLimit 的环境由插入侧尾部裁掉并提示（journal pick 同口径）。
     */
    const pick = useCallback(
        async (kind: 'image' | 'video') => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return;
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
                const selectionLimit = MAX_MEDIA - blocksRef.current.filter((block) => block.t === 'media').length;
                if (selectionLimit <= 0) {
                    store.setState({ error: `本事件媒体最多 ${MAX_MEDIA} 个。` });
                    return;
                }
                const result = await imagePicker.launchImageLibraryAsync({
                    mediaTypes: [kind === 'video' ? 'videos' : 'images'],
                    allowsMultipleSelection: true,
                    selectionLimit,
                    orderedSelection: true,
                    quality: 1,
                    exif: false,
                });
                if (result.canceled || result.assets.length === 0) return;
                const allowed = result.assets.slice(0, selectionLimit);
                for (const asset of allowed) {
                    doAttach(kind, asset.uri, asset.width ?? null, asset.height ?? null);
                }
                const overflow = result.assets.length - allowed.length;
                if (overflow > 0) {
                    store.setState({
                        error: `已插入 ${allowed.length} 个，其余 ${overflow} 个超出媒体上限（${MAX_MEDIA} 个）。`,
                    });
                }
            } catch (caught) {
                store.setState({
                    error: `${kind === 'video' ? '视频' : '图片'}选取失败：${caught instanceof Error ? caught.message : String(caught)}`,
                });
            } finally {
                pickingRef.current = false;
            }
        },
        [doAttach, store],
    );

    /** + 菜单「添加输入框」：末段空段直接聚焦续写，不堆积空行（journal 同口径）。 */
    const appendText = useCallback(() => {
        const current = blocksRef.current;
        const last = current[current.length - 1];
        if (last && last.t === 'p' && last.text === '') {
            setFocusTextId(last.id);
            return;
        }
        const appended = newParagraphBlock();
        applyBlocks((blocks) => [...blocks, appended]);
        setFocusTextId(appended.id);
    }, [applyBlocks]);

    /** 删除事件（危险区确认卡 → deleteEvent → safeBack 回列表）。 */
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    // 元信息编辑态（处理人/对象编辑卡；null = 关闭）
    const [metaEdit, setMetaEdit] = useState<MetaEditState | null>(null);
    const confirmDelete = useCallback(async () => {
        const row = eventRef.current;
        if (!row || deleting) return;
        setDeleting(true);
        try {
            const ok = await store.getState().deleteEvent(row.id);
            if (ok) {
                // 闸先置位：删除后的任何在途保存/卸载 flush 不得再写该行
                deletedRef.current = true;
                setDeleteOpen(false);
                safeBack();
            }
        } finally {
            setDeleting(false);
        }
    }, [deleting, store]);

    // ─── 画布协作（journal-edit 同款几何与键盘补偿）──────────────────────────
    const canvasRef = useRef<ScrollViewInstance>(null);
    const canvasOffsetRef = useRef(0);
    const canvas = useMemo<EditorCanvasHandle>(
        () => ({ ref: canvasRef, offsetRef: canvasOffsetRef }),
        [],
    );
    const editorRef = useRef<BlockEditorHandle | null>(null);
    const dismissCanvasKeyboard = useCallback(() => {
        editorRef.current?.dismissKeyboard();
    }, []);

    /** 离开屏：卸载 flush 兜底补存（含在途上传收敛）。 */
    const handleLeave = useCallback(() => {
        safeBack();
    }, []);

    // 块操作卡定位（上移/下移禁用态与当前块）
    const actionIndex = actionBlockId ? blocks.findIndex((block) => block.id === actionBlockId) : -1;
    const moveActionBlock = (direction: -1 | 1) => {
        if (!actionBlockId) return;
        const blockId = actionBlockId;
        applyBlocks((current) => moveBlock(current, blockId, direction));
    };
    const removeActionBlock = () => {
        if (!actionBlockId) return;
        const blockId = actionBlockId;
        setActionBlockId(null);
        applyBlocks((current) => removeBlock(current, blockId));
    };

    /**
     * 画布内容子树（children 直传垫高层）：useMemo 把引用稳定到真正影响内容的
     * 依赖上——键盘弹出/收起只重渲 CanvasDismissLayer 自身 style，本子树经
     * children 引用相等 bail-out 零重渲（journal-edit 同口径）。子树末尾是
     * 危险区（删除事件）：与正文拉开 40dp，negative 弱行钮（确认卡二次确认）。
     */
    const canvasContent = useMemo(
        () => (
            <View className="mx-auto w-full max-w-[620px]">
                <BlockEditor
                    ref={editorRef}
                    blocks={blocks}
                    mediaById={mediaById}
                    editable={event != null}
                    focusTextId={focusTextId}
                    canvas={canvas}
                    onChange={(next) => applyBlocks(() => next)}
                    onFocusText={() => setFocusTextId(null)}
                    onBlurText={() => void saveNow()}
                    onRequestActionBlock={setActionBlockId}
                />
                {/* 危险区（删除事件入口）：正文流末尾，negative 弱行钮（行高
                    44 视觉盒即命中盒，不传 hitSlop；确认卡二次确认） */}
                <View className="mt-10">
                    <BouncyPressable onPress={() => setDeleteOpen(true)} scaleTo={0.97}>
                        <View
                            className="h-11 flex-row items-center justify-center gap-2 rounded-control bg-ink-surface dark:bg-inkd-surface"
                            accessibilityRole="button"
                            accessibilityLabel="删除事件"
                        >
                            <LucideTrash size={16} strokeWidth={1.9} color={palette.negative} />
                            <Text className="text-[14px] font-medium text-ink-negative dark:text-inkd-negative">
                                删除事件
                            </Text>
                        </View>
                    </BouncyPressable>
                </View>
            </View>
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 闭包读取项已尽数列入（applyBlocks/saveNow/稳定 setter/editorRef 稳定引用）
        [blocks, mediaById, event, focusTextId, canvas, applyBlocks, saveNow, palette.negative],
    );

    // ─── 失败 / 加载门（hooks 全部之后，条件渲染不涉 hook 顺序）──────────────
    if (loadFailed) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base">
                <View style={{ paddingTop: insets.top }} className="flex-1">
                    {error ? (
                        <Text className="px-6 pb-2 pt-6 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    ) : null}
                    <View className="flex-1 pt-8">
                        <EmptyState
                            icon={<LucideBell size={40} color={palette.muted} strokeWidth={1.5} />}
                            title="打不开这个事件"
                            hint="它可能已被删除，或数据读取失败。"
                            actionLabel="重试"
                            onAction={() => void load()}
                        />
                    </View>
                </View>
            </View>
        );
    }

    if (!event) return <LoadingView />;

    const timeline = eventTimeline(event);
    const timelineText = timeline.edited
        ? `创建 ${timeline.createdText} · 更新 ${timeline.updatedText}`
        : `创建 ${timeline.createdText}`;
    const hasGps = event.gps_lat != null && event.gps_lng != null;
    const gpsText = hasGps ? `${event.gps_lat}, ${event.gps_lng}` : '';
    const savedLabel = savedAt
        ? `已保存 ${String(new Date(savedAt).getHours()).padStart(2, '0')}:${String(new Date(savedAt).getMinutes()).padStart(2, '0')}`
        : '自动保存开启';

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 状态头：屏头行（返回 + 标题只读——store.updateEventMeta 契约无
                    title 字段，标题创建后不可改，报告取舍）+ 状态片/时间线行 +
                    GPS/处理人/对象三段行 + 字数/保存 meta 行。命中区核算：返回钮
                    CloseButton 44 视觉盒（无 slop）；状态片 24 视觉盒 + hitSlop 10
                    → 44 等效（上下左右，四周 24 内无相邻命中元素）。 */}
                <View className="px-6 pb-2 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={handleLeave} />
                        <Text
                            numberOfLines={1}
                            className="ml-2.5 min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {event.title}
                        </Text>
                    </View>
                    {/* 状态 + 时间线行：状态片可点切换（open ↔ done，可逆操作不设
                        确认步）；时间线 tabular-nums */}
                    <View className="mt-1 flex-row items-center gap-2">
                        <BouncyPressable onPress={() => void toggleStatus()} scaleTo={0.92} hitSlop={10}>
                            <View
                                accessibilityRole="button"
                                accessibilityLabel={`状态：${event.status === 'open' ? '进行中' : '已完成'}，点按切换为${event.status === 'open' ? '已完成' : '进行中'}`}
                            >
                                <EventStatusChip status={event.status} />
                            </View>
                        </BouncyPressable>
                        <Text
                            numberOfLines={1}
                            className="min-w-0 flex-1 text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {timelineText}
                        </Text>
                    </View>
                    {/* 三段轻量行（各自独立命中体，gap-3 停车距 ≥ 2×slop 不交叠）：
                        GPS（有坐标点按复制 / 无坐标只读）、处理人、对象（点按弹
                        编辑卡）；hitSlop 6 = 12px 命中外扩，段间距 12 ≥ 6+6 相切
                        不重叠 */}
                    <View className="mt-2 flex-row items-center gap-3">
                        {hasGps ? (
                            <Pressable
                                onPress={() => void copyGps()}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                className="flex-row items-center gap-1.5 active:opacity-70"
                                accessibilityRole="button"
                                accessibilityLabel="复制坐标"
                            >
                                <LucideMapPin size={13} strokeWidth={1.9} color={palette.accent} />
                                <Text
                                    numberOfLines={1}
                                    className="text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                    style={{ fontVariant: ['tabular-nums'] }}
                                >
                                    {gpsText}
                                </Text>
                                {gpsCopied ? (
                                    <View className="ml-0.5" pointerEvents="none">
                                        <LucideCheck size={12} strokeWidth={2} color={palette.accent} />
                                    </View>
                                ) : null}
                            </Pressable>
                        ) : (
                            // 无坐标：只读 muted 段（非按压体——点了没反应是可感知缺陷）
                            <View className="flex-row items-center gap-1.5">
                                <LucideMapPin size={13} strokeWidth={1.9} color={palette.muted} />
                                <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                                    未定位
                                </Text>
                            </View>
                        )}
                        <Pressable
                            onPress={() => setMetaEdit({ mode: 'handled-by' })}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            className="min-w-0 flex-row items-center active:opacity-70"
                            accessibilityRole="button"
                            accessibilityLabel={`处理人：${event.handled_by ?? '未设置'}，点按编辑`}
                        >
                            <Text
                                numberOfLines={1}
                                className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                            >
                                {event.handled_by ? `处理人 ${event.handled_by}` : '处理人 未设置'}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() =>
                                setMetaEdit({
                                    mode: 'subject',
                                    kind: event.subject_kind,
                                    value: event.subject_value ?? '',
                                })
                            }
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            className="min-w-0 flex-1 flex-row items-center active:opacity-70"
                            accessibilityRole="button"
                            accessibilityLabel={`对象：${
                                event.subject_kind && event.subject_value
                                    ? `${eventSubjectKindLabel(event.subject_kind)} ${event.subject_value}`
                                    : '未设置'
                            }，点按编辑`}
                        >
                            <Text
                                numberOfLines={1}
                                className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                            >
                                {event.subject_kind && event.subject_value
                                    ? `对象 ${eventSubjectKindLabel(event.subject_kind)} ${event.subject_value}`
                                    : '对象 未设置'}
                            </Text>
                        </Pressable>
                    </View>
                    {/* meta 行：字数 + 保存状态（journal masthead meta 同语言） */}
                    <Text
                        className="mt-1 text-[11px] text-ink-muted dark:text-inkd-muted"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {`${chars} 字 · ${savedLabel}`}
                    </Text>
                </View>
                {error ? (
                    // 错误横幅下移一档（报头群 → 24dp 呼吸带，对齐 journal-edit 口径）
                    <Text className="px-6 pb-2 pt-4 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {error}
                    </Text>
                ) : null}

                <ScrollView
                    ref={canvasRef}
                    onScroll={(scrollEvent) => {
                        // 最近滚动位置落 ref（聚焦定位的落位基准，不触发渲染）
                        canvasOffsetRef.current = scrollEvent.nativeEvent.contentOffset.y;
                    }}
                    scrollEventThrottle={16}
                    keyboardShouldPersistTaps="handled"
                    automaticallyAdjustKeyboardInsets
                    keyboardDismissMode="interactive"
                >
                    {/* 画布空白收键层（#K2）：键盘动态垫高在层内收口 */}
                    <CanvasDismissLayer
                        bottomBaseline={insets.bottom + CANVAS_BOTTOM_BASE_INSET}
                        onPress={dismissCanvasKeyboard}
                    >
                        {canvasContent}
                    </CanvasDismissLayer>
                </ScrollView>

                {/* 罗盘 + 号（插入媒体/输入框）：后台并行模型不因上传禁用 */}
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
            </View>

            {/* 块操作卡（上移/下移/删除，浮层居中弹出，条件渲染禁 RN Modal） */}
            {actionBlockId && actionIndex >= 0 ? (
                <EventBlockActionCard
                    index={actionIndex}
                    total={blocks.length}
                    onMove={moveActionBlock}
                    onDelete={removeActionBlock}
                    onClose={() => setActionBlockId(null)}
                />
            ) : null}
            {/* 元信息编辑卡（处理人 / 对象，RenameCard 同语言） */}
            {metaEdit ? (
                <MetaEditCard
                    mode={metaEdit.mode}
                    initialHandledBy={event.handled_by ?? ''}
                    initialKind={metaEdit.mode === 'subject' ? metaEdit.kind : null}
                    initialValue={metaEdit.mode === 'subject' ? metaEdit.value : ''}
                    onSaveHandledBy={(value) => saveHandledBy(value)}
                    onSaveSubject={(kind, value) => saveSubject(kind, value)}
                    onClose={() => setMetaEdit(null)}
                    errorText={error}
                />
            ) : null}
            {/* 删除确认卡（危险区） */}
            {deleteOpen ? (
                <DeleteConfirmCard deleting={deleting} onDelete={() => void confirmDelete()} onClose={() => setDeleteOpen(false)} />
            ) : null}
            {/* 插入选择器（相册图/视频 + 添加输入框；拍照/录音归属录制会话扩展，
                本轮不提供） */}
            {menuOpen ? (
                <EventInsertMenu
                    onClose={() => setMenuOpen(false)}
                    onAction={(action) => {
                        if (action === 'library-image') {
                            void pick('image');
                            return;
                        }
                        if (action === 'library-video') {
                            void pick('video');
                            return;
                        }
                        appendText();
                    }}
                />
            ) : null}
        </KeyboardAvoidingView>
    );
}

/* ------------------------------------------------------------------ */
/* 元信息编辑流（处理人 / 对象，metaEdit 受控态）                        */
/* ------------------------------------------------------------------ */

/** 元信息编辑态：处理人单字段 / 对象原子对（kind + value 草稿）。 */
type MetaEditState = { mode: 'handled-by' } | { mode: 'subject'; kind: EventSubjectKind | null; value: string };

/* ------------------------------------------------------------------ */
/* 画布空白收键层（#K2）+ 键盘动态垫高（journal-edit 同构，垫高层         */
/* 为本屏私有：宿主屏不复用屏文件，模式按其注重实现）                    */
/* ------------------------------------------------------------------ */

/**
 * 画布空白收键层 + 键盘动态垫高（journal-edit 同款模式重实现，宿主屏私有）：
 * ScrollView 的唯一内容子——未被子元素认领的区域点按 → 收键盘 + blur 聚焦段；
 * memo + children 直传 + 稳定 onPress/bottomBaseline，键盘态只重渲本层 style。
 * 防误触机制在 BlockEditor 句柄内（无聚焦段空点零动作）；触摸面零 className；
 * 无障碍不挂 role（背景装饰层）。
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
                // 画布顶部留白 16dp：叠加报头 pb-2(8dp) 后净间距 24dp
                //（EDITOR_RHYTHM.mastheadToFirstBlock 节奏）
                paddingTop: 16,
                paddingHorizontal: 24,
                paddingBottom,
            }}
        >
            {children}
        </Pressable>
    );
});

/* ------------------------------------------------------------------ */
/* 块操作卡（上移/下移/删除）                                            */
/* ------------------------------------------------------------------ */

/**
 * 事件块操作卡（媒体长按/双击、文本聚焦 ⋯ 钮 → 屏根浮层，条件渲染禁 RN Modal）：
 * 保留编辑器的核心块操作（上移/下移/删除——删到空补可落笔段，journal-logic
 * removeBlock 口径）。合并堆叠/保存到手机等 journal 编辑器专属动作未纳入事件
 * 块操作卡（本轮范围；块模型同构，后续可平移）。
 */
function EventBlockActionCard({
    index,
    total,
    onMove,
    onDelete,
    onClose,
}: {
    index: number;
    total: number;
    onMove(direction: -1 | 1): void;
    onDelete(): void;
    onClose(): void;
}) {
    const palette = usePalette();

    // Android 返回键关闭（替代 Modal onRequestClose 语义）
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
        label: string;
        danger?: boolean;
        disabled: boolean;
        onPress(): void;
    }> = [
        { key: 'up', label: '上移', disabled: !canUp, onPress: () => onMove(-1) },
        { key: 'down', label: '下移', disabled: !canDown, onPress: () => onMove(1) },
        { key: 'delete', label: '删除', danger: true, disabled: false, onPress: onDelete },
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
                        <CloseButton onPress={onClose} />
                    </View>
                    <View className="gap-0.5">
                        {/* 行高 44 视觉盒 ≥44：不传 hitSlop（0）；行间 gap-0.5(2px)
                            为不可点间隙。onPress 恒挂接 + disabled 显式传导（#3） */}
                        {rows.map((row) => (
                            <BouncyPressable
                                key={row.key}
                                onPress={row.onPress}
                                disabled={row.disabled}
                                scaleTo={0.98}
                            >
                                <View
                                    className={`h-11 flex-row items-center rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface ${
                                        row.disabled ? 'opacity-30' : ''
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityLabel={row.label}
                                >
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

/* ------------------------------------------------------------------ */
/* 元信息编辑卡（处理人 / 对象）                                          */
/* ------------------------------------------------------------------ */

/**
 * 元信息编辑卡（RenameCard 同语言：scrim + 居中卡 + 卡头 CloseButton + 保存/
 * 取消成对动作 + Android 返回键出口）：
 * - 处理人模式：单字段（空串 = 清除，store normalizeEventText 口径）；
 * - 对象模式：类型分段（无/手机/邮箱/地址/GPS）+ 值输入（选「无」隐藏值输入，
 *   保存整对清除——原子对归一在 store）；
 * - onSave resolve false：卡片不关、errorText 就地展示可重试（RenameCard 契约）；
 *   onClose 是统一出口（保存成功 / 取消 / scrim / 返回键）。
 */
function MetaEditCard({
    mode,
    initialHandledBy,
    initialKind,
    initialValue,
    onSaveHandledBy,
    onSaveSubject,
    onClose,
    errorText,
}: {
    mode: 'handled-by' | 'subject';
    initialHandledBy: string;
    initialKind: EventSubjectKind | null;
    initialValue: string;
    onSaveHandledBy(value: string): Promise<boolean>;
    onSaveSubject(kind: EventSubjectKind | null, value: string): Promise<boolean>;
    onClose(): void;
    errorText?: string | null;
}) {
    const palette = usePalette();
    const [handledBy, setHandledBy] = useState(initialHandledBy);
    const [kind, setKind] = useState<EventSubjectKind | null>(initialKind);
    const [value, setValue] = useState(initialValue);
    const [saveFailed, setSaveFailed] = useState(false);
    const savingRef = useRef(false);

    // Android 返回键关闭（替代 Modal onRequestClose 语义）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    const save = async () => {
        if (savingRef.current) return;
        savingRef.current = true;
        try {
            const ok =
                mode === 'handled-by'
                    ? await onSaveHandledBy(handledBy)
                    : await onSaveSubject(kind, value);
            // 契约：false = 失败（卡片保持打开可重试）；true = 成功关闭
            if (ok === false) setSaveFailed(true);
            else onClose();
        } catch {
            setSaveFailed(true);
        } finally {
            savingRef.current = false;
        }
    };

    const title = mode === 'handled-by' ? '处理人' : '对象';
    const subjectPlaceholder =
        kind === 'phone'
            ? '手机号或备注'
            : kind === 'email'
                ? '邮箱地址'
                : kind === 'address'
                    ? '街道地址'
                    : '坐标或位置描述';

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel={`关闭${title}编辑`}
            >
                <Pressable className="w-full max-w-xs rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮 */}
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            编辑{title}
                        </Text>
                        <CloseButton onPress={onClose} />
                    </View>
                    {mode === 'handled-by' ? (
                        // 处理人单字段：rest = surface / focus = raised（加深一档，
                        // RenameCard 同一输入井语言）
                        <View className="mt-4">
                            <FieldInput
                                value={handledBy}
                                onChangeText={setHandledBy}
                                placeholder="谁来处理？（留空清除）"
                                maxLength={EVENT_HANDLED_BY_MAX}
                                accessibilityLabel="处理人"
                            />
                        </View>
                    ) : (
                        <>
                            {/* 类型分段（无/手机/邮箱/地址/GPS）：轨道语言与列表页
                                状态分段同构；横向 hitSlop 归 0（gap-1 间距） */}
                            <View className="mt-4 flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface">
                                {([null, ...EVENT_SUBJECT_KINDS] as const).map((option) => {
                                    const active = kind === option;
                                    const label = option === null ? '无' : EVENT_SUBJECT_KIND_LABELS[option];
                                    return (
                                        <Pressable
                                            key={label}
                                            onPress={() => {
                                                setKind(option);
                                                if (option === null) setValue('');
                                            }}
                                            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                                            className={`h-9 flex-1 items-center justify-center rounded-thumb active:bg-ink-raised dark:active:bg-inkd-raised ${
                                                active
                                                    ? 'bg-ink-raised dark:bg-inkd-raised'
                                                    : 'bg-ink-surface dark:bg-inkd-surface'
                                            }`}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected: active }}
                                        >
                                            <Text
                                                className={`text-[12px] ${
                                                    active
                                                        ? 'font-medium text-ink-text dark:text-inkd-text'
                                                        : 'text-ink-muted dark:text-inkd-muted'
                                                }`}
                                            >
                                                {label}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                            {kind !== null ? (
                                <View className="mt-2">
                                    <FieldInput
                                        value={value}
                                        onChangeText={setValue}
                                        placeholder={subjectPlaceholder}
                                        maxLength={EVENT_SUBJECT_VALUE_MAX}
                                        accessibilityLabel="对象值"
                                    />
                                </View>
                            ) : (
                                <Text className="mt-2 text-[12px] text-ink-muted dark:text-inkd-muted">
                                    选「无」保存即清除对象。
                                </Text>
                            )}
                        </>
                    )}
                    {saveFailed && errorText ? (
                        <Text className="mt-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {errorText}
                        </Text>
                    ) : null}
                    <View className="mt-4 gap-2.5">
                        {/* 两行视觉盒 h-11 ≥44：不传 hitSlop（0）；行距 gap-2.5(10px)
                            为不可点间隙（RenameCard 同口径） */}
                        <BouncyPressable onPress={() => void save()} scaleTo={0.97}>
                            <View
                                className="h-11 flex-row items-center gap-3 rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface"
                                accessibilityRole="button"
                                accessibilityLabel={`保存${title}`}
                            >
                                <LucideCheck size={18} strokeWidth={1.9} color={palette.secondary} />
                                <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                    保存
                                </Text>
                            </View>
                        </BouncyPressable>
                        <BouncyPressable onPress={onClose} scaleTo={0.97}>
                            <View
                                className="h-11 flex-row items-center rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface"
                                accessibilityRole="button"
                                accessibilityLabel={`取消编辑${title}`}
                            >
                                <Text className="text-[15px] font-medium text-ink-muted dark:text-inkd-muted">
                                    取消
                                </Text>
                            </View>
                        </BouncyPressable>
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}

/* ------------------------------------------------------------------ */
/* 删除确认卡（危险区）                                                  */
/* ------------------------------------------------------------------ */

/**
 * 删除确认卡（破坏性动作二次确认，块操作卡同语言）：删除为不可逆级联（事件 +
 * 媒体行软删 + 文件清理），确认卡强调后果；主行动钮 negative 实底（非 CSS 场景
 * 走 palette 语义色）。
 */
function DeleteConfirmCard({
    deleting,
    onDelete,
    onClose,
}: {
    /** 删除在途（删除钮转 spinner + 禁用防重复触发）。 */
    deleting: boolean;
    onDelete(): void;
    onClose(): void;
}) {
    const palette = usePalette();
    // Android 返回键关闭（替代 Modal onRequestClose 语义）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!deleting) onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose, deleting]);

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={() => {
                    if (!deleting) onClose();
                }}
                accessibilityLabel="关闭删除确认"
            >
                <Pressable className="w-full max-w-xs rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            删除事件？
                        </Text>
                        <CloseButton onPress={onClose} />
                    </View>
                    <Text className="mt-3 text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                        正文、媒体会一并删除，不可恢复。
                    </Text>
                    <View className="mt-4 gap-2.5">
                        {/* 取消（surface 行钮，h-11 ≥44；删除在途时禁用出口防
                            「确认卡关了、删除还在跑」的状态错位） */}
                        <BouncyPressable onPress={onClose} disabled={deleting} scaleTo={0.97}>
                            <View
                                className="h-11 items-center justify-center rounded-control bg-ink-surface dark:bg-inkd-surface"
                                accessibilityRole="button"
                                accessibilityLabel="取消删除"
                            >
                                <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                    取消
                                </Text>
                            </View>
                        </BouncyPressable>
                        {/* 删除（negative 实底主行动；in-flight spinner + 禁用） */}
                        <BouncyPressable onPress={onDelete} disabled={deleting} scaleTo={0.97}>
                            <View
                                className="h-11 items-center justify-center rounded-control"
                                style={{
                                    backgroundColor: palette.negative,
                                    opacity: deleting ? 0.6 : 1,
                                }}
                                accessibilityRole="button"
                                accessibilityLabel="确认删除事件"
                            >
                                {deleting ? (
                                    <ActivityIndicator size="small" color="#FFFFFF" />
                                ) : (
                                    <Text className="text-[15px] font-semibold text-white">删除</Text>
                                )}
                            </View>
                        </BouncyPressable>
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}

/* ------------------------------------------------------------------ */
/* 插入选择器（相册图/视频 + 添加输入框）                                */
/* ------------------------------------------------------------------ */

/** 事件插入动作词表（本轮能力边界：相册两通道 + 输入框；采集三行留待录制
 *  会话归属扩展，见文件头注）。 */
type EventInsertAction = 'library-image' | 'library-video' | 'append-text';

/**
 * 事件插入选择器（+ 罗盘弹出，InsertMenu 同语言重实现——InsertMenu 的动作词表
 * 绑定 journal 屏分发，不混用）：条件渲染遮罩（禁 RN Modal）、卡头 CloseButton、
 * Android 返回键关闭、打开即收键盘。行卡片 = icon 容器 40×40 rounded-control
 * raised 底 + 题/副标双行（icon tint secondary 经 editor-icons.tintIcon 统一上色，
 * InsertMenu MenuRow 同口径），行高 ~64 ≥44（hitSlop 0）。
 */
function EventInsertMenu({
    onClose,
    onAction,
}: {
    onClose: () => void;
    onAction: (action: EventInsertAction) => void;
}) {
    const palette = usePalette();
    // 打开即收键盘（InsertMenu 同口径）
    useEffect(() => {
        Keyboard.dismiss();
    }, []);

    // Android 返回键关闭（替代 Modal onRequestClose 语义）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    const rows: Array<{ action: EventInsertAction; icon: React.ReactNode; title: string; hint: string }> = [
        { action: 'library-image', icon: <LucideImage size={20} strokeWidth={1.9} />, title: '相册图片', hint: '从图库选取，可多选' },
        { action: 'library-video', icon: <LucideVideo size={20} strokeWidth={1.9} />, title: '相册视频', hint: '从图库选取，可多选' },
        { action: 'append-text', icon: <LucidePlus size={20} strokeWidth={1.9} />, title: '添加输入框', hint: '末尾另起一段继续写' },
    ];

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭插入菜单"
            >
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮 */}
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            插入什么？
                        </Text>
                        <CloseButton onPress={onClose} />
                    </View>
                    <View className="mt-4 gap-2.5">
                        {rows.map((row) => (
                            <BouncyPressable
                                key={row.action}
                                onPress={() => {
                                    onClose();
                                    onAction(row.action);
                                }}
                                scaleTo={0.97}
                            >
                                <View className="flex-row items-center gap-3 rounded-control bg-ink-surface p-3 dark:bg-inkd-surface">
                                    {/* 图标容器：raised 触感底 + rounded-control，与
                                        InsertMenu MenuRow 同一触感语言；icon tint
                                        统一 secondary（tintIcon 收口） */}
                                    <View
                                        pointerEvents="none"
                                        className="h-10 w-10 items-center justify-center rounded-control bg-ink-raised dark:bg-inkd-raised"
                                    >
                                        {tintIcon(row.icon, palette.secondary)}
                                    </View>
                                    <View className="flex-1">
                                        <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                            {row.title}
                                        </Text>
                                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                                            {row.hint}
                                        </Text>
                                    </View>
                                </View>
                            </BouncyPressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}
