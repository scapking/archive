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
    LucideMapPin,
    LucidePlus,
    LucideSettings,
    LucideTrash,
} from '@/core/icons';
import { clipboard } from '@/core/clipboard';
import { imagePicker } from '@/core/image-picker';
import { audio } from '@/core/audio';
import { location } from '@/core/location';
// 深路径注记：全局录制会话（跨页面后台录制 + 归属铁律的宿主）未在域 barrel
// 出口，域内深取（journal-edit-screen 同款先例）。控制器/覆盖层/保活槽都挂
// 根层级（app/_layout 的 RecordingSessionHost），本屏只发起与展示状态、订阅
// persist 事件合并产物块。
import {
    restoreCaptureOverlay,
    startCaptureSession,
    subscribeRecordingSessionPersist,
    useRecordingSessionStore,
} from './recording-session';
// 深路径注记：tintIcon 未入 ui/index.ts 出口（域内深取纪律，同 editor-icons 先例）。
// 事件屏本轮已复用共享 InsertMenu（actions 过滤词表），不再自带图标上色面。
// 深路径注记：节奏表 / 画布句柄 / 键盘动态垫高 hook / FieldInput 未在 ui/index.ts
// 出口（域内深取纪律，先例同 journal-edit / trip-detail）。
import {
    useKeyboardCanvasBottomPadding,
    type BlockEditorHandle,
    type EditorCanvasHandle,
} from './ui/editor';
import { FieldInput } from './ui/field-input';
import * as db from './db';
import type { EventMediaRow, EventRow, EventStatus, EventSubjectKind, JournalMediaRow } from './db';
import { ensureVideoThumbnail, useArchiveRevision, useArchiveStore } from './store';
import {
    EVENT_DESCRIPTION_MAX,
    EVENT_HANDLED_BY_MAX,
    EVENT_SUBJECT_KINDS,
    EVENT_SUBJECT_KIND_LABELS,
    EVENT_SUBJECT_VALUE_MAX,
    EVENT_TITLE_MAX,
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
    formatAudioTime,
    InsertMenu,
    LoadingView,
    safeBack,
    usePalette,
    type InsertAction,
} from './ui';
import { EventStatusChip } from './ui/event-card';

/**
 * 事件详情编辑页（/events/[id]，笔记编辑式 + 工单状态头 + 设置卡）：
 *
 * - **状态头（工单语言，展示 + 编辑入口）**：标题行（**只读展示**——标题编辑
 *   收进设置卡，编辑后经 refreshMeta 权威回读即时刷新）+ 设置钮（LucideSettings，
 *   36 视觉盒 + hitSlop 10 → 56×56 ≥44，journal-edit 屏头编辑钮同款几何）+
 *   状态片（点按打开设置卡——元信息编辑统一收口，不再直切）+ 时间线（创建/
 *   最近更新，event-logic.eventTimeline 单一口径）+ GPS 坐标行（**点按复制**
 *   clipboard——只读快捷动作保留，编辑（重定位/清除）在设置卡）+ 处理人/对象
 *   行（点按打开设置卡）+ 字数/保存 meta 行；
 * - **正文 = BlockEditor 复用**（事件 blocks 与 journal 块模型同构，JournalBlock
 *   不变；mediaId → event_media 行经 toJournalMediaRow 适配器喂编辑器的
 *   mediaById 契约——行结构同构，仅 journal_id 槽位以 event_id 占位）：
 *   800ms 防抖 updateEventBlocks + 失焦即存双通道 + 卸载兜底 flush（含在途
 *   上传 allSettled 收敛后再存——比 journal-edit 的裸 flush 多一层在途回填
 *   保护，防「上传完成于卸载之后，块引用永不落库」的对账误杀）；
 * - **插入后台异步并行**（完整对齐 journal-edit 的 attach 模式）：doAttach 同步
 *   插 pending 占位即返回，attachEventMedia 落盘+落库为后台任务（pendingUploadsRef
 *   注册表，多任务并行；taskId = 占位 id → 占位卡进度百分比，journal 同口径）；
 *   收敛后 resolvePendingBlock 原位回填，失败仅回滚本占位 + store.error；
 * - **+ 菜单与笔记编辑完全一致**（共享 ui/insert-menu 的 InsertMenu，actions
 *   过滤词表；journal 行序 = 事件行序）：相册图片 / 相册视频 / 录音 / 拍照 /
 *   拍视频 / 添加输入框——事件版无「完成收笔」（事件无收笔语义，状态切换在
 *   设置卡）、无「新建事件」（journal 版专属行）；全局录制会话进行中时同款
 *   状态行（「● 录音中 0:32 · 继续」）；
 * - **录制归属泛化（v6.1）**：拍照/录像/录音经全局会话发起（startCaptureSession
 *   带 { kind: 'event', id } owner），停止产物落库链 = attachEventMedia（媒体
 *   行，taskId/moveSource/onProgress 全量 opts）→ persist 事件（本屏订阅：
 *   owner.kind === 'event' 且 id 匹配才合并）→ appendMediaBlockToEvent（DB 级
 *   块追加）。本屏合并进本地 blocksRef（applyBlocks 到达序合并 + 幂等闸，
 *   journal-edit 同构），其后的防抖保存天然携带该块；停止发生在任意页面均
 *   落回本事件（DB 级追加不依赖屏挂载）；
 * - **设置卡（EventSettingsCard，scrim + 居中卡，MetaEditCard 模式）**：标题
 *   行右上设置钮进入，整合全部元信息编辑——名称（title，store.updateEventMeta
 *   v6.1 扩展 title patch）/ 状态（open/done 分段）/ GPS（重定位/清除）/
 *   处理人 / 对象（类型+值，原子对归一在 store）/ 描述 / 时间线（只读）/
 *   删除事件（negative → 卡内确认步）；字段变更**即时落库**（updateEventMeta
 *   + revision bump + refreshMeta 权威回读），文本字段 blur 保存、分段/按钮
 *   点按即存；删除为级联软删 + safeBack，deletedRef 闸防删除后的卸载 flush
 *   把 blocks 写回已删行；
 * - **正文区纯编辑**：原「危险区（删除事件行）」与处理人/对象编辑卡
 *   （MetaEditCard）已移除——删除与元信息编辑统一收进设置卡。
 *
 * typedRoutes：动态路由参数经 useLocalSearchParams 读取（同 trip-detail 范式），
 * 屏内不产生新的路由字面量。
 */

/** 每个事件的媒体上限（防误触爆量；对齐 journal-edit 的 MAX_MEDIA 口径）。
 *  事件无九图配额语义（工单媒体密度低于日记），单闸收口。 */
const MAX_MEDIA = 12;

/** 画布底部静态垫高基线（dp）：给 + 浮钮让位（journal-edit 同款几何）。 */
const CANVAS_BOTTOM_BASE_INSET = 96;

/** 定位超时上限（ms）：设置卡「重新定位」的单次 getCurrentPosition 等待上限
 *  （新建表单同款兜底口径，超时按失败降级）。 */
const LOCATE_TIMEOUT_MS = 8000;

/**
 * 事件 + 菜单词表（actions 过滤 prop 喂共享 InsertMenu）：与 journal 行序
 * **同源同序**（InsertMenu 既定行序 = 相册两行 → 采集三行 → 输入 → 收笔），
 * 事件版仅裁去「完成收笔」（无收笔语义）与「新建事件」（journal 版专属行）
 * ——词表对齐即过滤集合对齐，行序天然一致（过滤不重排）。
 */
const EVENT_INSERT_ACTIONS = [
    'library-image',
    'library-video',
    'record',
    'photo',
    'video',
    'append-text',
] as const;

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

    // 媒体行随 revision 重载（attach/removeEventMedia、录制会话落库等 mutation
    // 只 bump revision；键 = eventId，不随 event 行对象引用漂移）
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

    // 视频缩略图惰性回填（deck 露边层真封面，journal-edit 同款口径）：本事件
    // 媒体行载入后逐个 ensure（幂等单飞，已存在直命中零成本）；fire-and-forget，
    // 失败仅回退占位卡（ensureVideoThumbnail 内部兜底）
    useEffect(() => {
        for (const row of media) {
            if (row.kind === 'video') void ensureVideoThumbnail(row.file_key);
        }
    }, [media]);

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
     * 同步回写 ref 再提交渲染——并发链路（多在途上传同帧回填、录制会话
     * persist 合并、文本编辑）按到达序串行合并不丢写；卸载后 setBlocks 被
     * 忽略，ref 仍供兜底链读取。
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

    // ─── 全局录制会话归属合并（v6.1 泛化，journal-edit 同构）─────────────────
    // 会话停录产物在媒体行建立后、DB 块写入前发 persist 事件——本屏若正是发起
    // 方（owner.kind === 'event' 且 id 匹配），先把媒体块合并进本地 blocksRef
    // （applyBlocks 到达序合并），其后的防抖保存天然携带该块（DB 追加侧
    // appendMediaBlockToEvent 幂等，不产生重复块）。journal 归属的事件一律
    // 忽略（事件屏只认 event owner）；订阅随卸载摘除（已卸载的 owner 屏无需
    // 合并——DB 级追加不依赖屏）。
    useEffect(() => {
        return subscribeRecordingSessionPersist((persisted) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return;
            if (persisted.owner.kind !== 'event' || persisted.owner.id !== row.id) return;
            applyBlocks((current) => {
                // 幂等闸：同一 mediaId 只合并一次（重复事件防重）
                if (current.some((block) => block.t === 'media' && block.mediaId === persisted.mediaId)) {
                    return current;
                }
                return [
                    ...current,
                    {
                        t: 'media' as const,
                        id: newBlockId(),
                        mediaId: persisted.mediaId,
                        ...(persisted.durationMs != null ? { durationMs: persisted.durationMs } : {}),
                    },
                ];
            });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- applyBlocks 稳定引用（useCallback []）
    }, []);

    // ─── 元信息落库回调（设置卡字段 × updateEventMeta，全部即时落库）──────────
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

    /** 设置卡：标题改名（store.updateEventMeta v6.1 扩展 title patch）。 */
    const saveTitle = useCallback(
        async (value: string) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, { title: value });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    /** 设置卡：状态分段（open/done）。 */
    const saveStatus = useCallback(
        async (status: EventStatus) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, { status });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    /** 设置卡：GPS 重定位（对象 = 覆盖写）/ 清除（null）；校验在 store。 */
    const saveGps = useCallback(
        async (gps: { lat: number; lng: number; accuracy?: number } | null) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, { gps });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    /** 设置卡：处理人（空串经 store 归一为 null = 清除，normalizeEventText 口径）。 */
    const saveHandledBy = useCallback(
        async (value: string) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, { handledBy: value });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    /** 设置卡：对象原子对（kind null = 显式清除；归一化在 store）。 */
    const saveSubject = useCallback(
        async (kind: EventSubjectKind | null, value: string) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, {
                subjectKind: kind,
                subjectValue: kind === null ? null : value,
            });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    /** 设置卡：描述（空串 = 清除，normalizeEventText 口径）。 */
    const saveDescription = useCallback(
        async (value: string) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, { description: value });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    /** 设置卡错误文案上浮（定位失败等 store 外异常的统一出口 → 错误横幅 +
     *  卡内 errorText 双消费面）。 */
    const surfaceError = useCallback(
        (message: string) => {
            store.setState({ error: message });
        },
        [store],
    );

    /** 设置卡：删除事件（级联软删 + safeBack 回列表）。闸先置位：删除后的任何
     *  在途保存/卸载 flush 不得再写该行。false = 失败（卡内确认步保持打开，
     *  errorText 就地展示）。 */
    const performDelete = useCallback(async () => {
        const row = eventRef.current;
        if (!row || deletedRef.current) return false;
        try {
            const ok = await store.getState().deleteEvent(row.id);
            if (ok) {
                deletedRef.current = true;
                setSettingsOpen(false);
                safeBack();
            }
            return ok;
        } catch {
            return false;
        }
    }, [store]);

    // 坐标复制反馈（check 图标短暂出现，me 页 UID 同款）：只读快捷动作保留，
    // GPS 编辑（重定位/清除）在设置卡
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
     * 单任务失败仅回滚本 pending + 上浮 error。落点/回填走 journal-logic
     * 纯函数（真实文末追加、原位替换）；updater 纯函数（块 id 在 updater 外
     * 预生成——#1.2 纪律）。taskId = 占位 id：视频直迁流有逐块进度，占位块
     * 经 progressByPendingId 显示百分比（journal 同口径；图片/音频字节路径
     * 无进度拍，占位保持 spinner 态）。
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
                    const mediaId = await store
                        .getState()
                        .attachEventMedia(row.id, kind, uri, width, height, null, { taskId: pendingId });
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

    // ─── 全局录制会话发起（录音/拍照/拍视频，v6.1 事件归属）──────────────────
    /**
     * + 菜单动作分发（与 journal runInsert 同构，归属换 event owner）：采集三行
     * 经全局会话互斥（已有会话 → start 拒绝并给 reason，可见反馈不静默吞点按）；
     * 麦克风权限由屏层预检（拒绝不开会话）；相册/文本随时可用。
     * 'complete' / 'new-event' 不在事件词表（EVENT_INSERT_ACTIONS 已过滤），
     * default 显式吞掉（防御分支，正常不可达）。
     */
    const runInsert = useCallback(
        async (action: InsertAction) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return;
            switch (action) {
                case 'record': {
                    // 互斥预检（先于权限弹窗——已有会话时直接给可见反馈）
                    const existing = useRecordingSessionStore.getState();
                    if (existing.kind) {
                        store.setState({
                            error:
                                existing.kind === 'audio'
                                    ? '已有录音在进行中（素材将保存到发起的页面）。'
                                    : '相机使用中，先处理拍摄再来录音。',
                        });
                        return;
                    }
                    const permission = await audio.getRecordingPermissionAsync();
                    if (!permission.granted) {
                        const requested = await audio.requestRecordingPermissionAsync();
                        if (!requested.granted) {
                            store.setState({ error: '没有麦克风权限，去系统设置里开一下。' });
                            return;
                        }
                    }
                    Keyboard.dismiss();
                    // 全局会话发起（归属铁律·事件侧）：owner = { kind: 'event', id }
                    const started = startCaptureSession('audio', { kind: 'event', id: row.id }, {
                        ownerLabel: row.title,
                    });
                    if (!started.ok) {
                        store.setState({ error: started.reason });
                    }
                    return;
                }
                case 'photo':
                case 'video': {
                    // 互斥预检（与录音行同口径）
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
                    // 全局拍摄会话（拍照 = 即时产物；拍视频 = 可后台继续的录像）
                    const started = startCaptureSession('video', { kind: 'event', id: row.id }, {
                        cameraMode: action === 'video' ? 'video' : 'photo',
                        ownerLabel: row.title,
                    });
                    if (!started.ok) {
                        store.setState({ error: started.reason });
                    }
                    return;
                }
                case 'library-image':
                    void pick('image');
                    return;
                case 'library-video':
                    void pick('video');
                    return;
                case 'append-text':
                    appendText();
                    return;
                default:
                    // 'complete' / 'new-event' 不在事件词表（见 EVENT_INSERT_ACTIONS 注）
                    return;
            }
        },
        [appendText, pick, store],
    );

    // + 菜单状态行数据（全局录制会话进行中时展示，journal 同款）：「● 录音中
    // 0:32 · 继续」点按重开全局覆盖层；副标按 owner 身份分流——归属铁律可视化
    const sessionKind = useRecordingSessionStore((s) => s.kind);
    const sessionPhase = useRecordingSessionStore((s) => s.phase);
    const sessionElapsed = useRecordingSessionStore((s) => s.elapsedSec);
    const sessionOwner = useRecordingSessionStore((s) => s.owner);
    const activeCapture = (() => {
        if (!sessionKind || !event) return null;
        const label =
            sessionKind === 'audio'
                ? '录音中'
                : sessionPhase === 'recording'
                    ? '录像中'
                    : '拍摄中';
        return {
            title: `${label} ${formatAudioTime(sessionElapsed)}`,
            hint:
                sessionOwner?.kind === 'event' && sessionOwner.id === event.id
                    ? '点按回到录制界面，停止后保存到本事件'
                    : '点按回到录制界面，素材将保存到发起的页面',
            onResume: () => {
                setMenuOpen(false);
                restoreCaptureOverlay();
            },
        };
    })();

    // ─── 设置卡 + 画布协作 ───────────────────────────────────────────────────
    // 设置卡（全部元信息编辑 + 删除收口）：标题行右上设置钮进入
    const [settingsOpen, setSettingsOpen] = useState(false);

    // 画布协作（journal-edit 同款几何与键盘补偿）
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
     * children 引用相等 bail-out 零重渲（journal-edit 同口径）。正文区纯编辑
     * （删除危险区已移除——删除收进设置卡，正文不再混元信息动作）。
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
            </View>
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 闭包读取项已尽数列入（applyBlocks/saveNow/稳定 setter/editorRef 稳定引用）
        [blocks, mediaById, event, focusTextId, canvas, applyBlocks, saveNow],
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
                {/* 状态头（展示 + 编辑入口，编辑统一收口设置卡）。节奏口径对齐
                    journal-edit（报头群 px-6 pb-2 pt-2；报头→正文净间距 =
                    pb-2(8) + 画布 paddingTop(16) = 24dp =
                    EDITOR_RHYTHM.mastheadToFirstBlock），行间 4dp 网格（mt-2 = 8dp）。
                    命中区核算：
                    - 返回钮：CloseButton 44 视觉盒（无 slop）；
                    - 设置钮：36 视觉盒 + hitSlop 10 → 56×56 ≥44（journal 编辑钮
                      同款几何，右侧贴屏内边距 px-6，外扩落画布留白无相邻命中）；
                    - 状态片：24 视觉盒 + hitSlop 10 → 44 等效；
                    - 处理人/对象行：hitSlop 6 = 12px 命中外扩，段间距 gap-3(12)
                      ≥ 6+6 相切不重叠。 */}
                <View className="px-6 pb-2 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={handleLeave} />
                        <Text
                            numberOfLines={1}
                            className="ml-2.5 min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {event.title}
                        </Text>
                        {/* 设置入口（全部元信息编辑 + 删除的统一门）：journal-edit
                            屏头编辑钮同款几何（36 盒 + hitSlop 10） */}
                        <BouncyPressable
                            onPress={() => setSettingsOpen(true)}
                            scaleTo={0.9}
                            hitSlop={10}
                        >
                            <View
                                accessibilityRole="button"
                                accessibilityLabel="事件设置"
                                className="h-9 w-9 items-center justify-center rounded-control border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface"
                            >
                                <LucideSettings size={16} strokeWidth={1.9} color={palette.secondary} />
                            </View>
                        </BouncyPressable>
                    </View>
                    {/* 状态 + 时间线行：状态片点按打开设置卡（状态编辑统一收口
                        设置卡——快切直改已收编，避免双编辑面漂移）；时间线
                        tabular-nums */}
                    <View className="mt-2 flex-row items-center gap-2">
                        <BouncyPressable
                            onPress={() => setSettingsOpen(true)}
                            scaleTo={0.92}
                            hitSlop={10}
                        >
                            <View
                                accessibilityRole="button"
                                accessibilityLabel={`状态：${event.status === 'open' ? '进行中' : '已完成'}，点按在设置中修改`}
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
                    {/* 三段轻量展示行（各自独立命中体）：GPS（有坐标点按复制——
                        只读快捷动作；无坐标只读 muted 段）、处理人、对象（点按
                        打开设置卡编辑）；hitSlop 6 = 12px 命中外扩，段间距 12
                        ≥ 6+6 相切不重叠 */}
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
                            onPress={() => setSettingsOpen(true)}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            className="min-w-0 flex-row items-center active:opacity-70"
                            accessibilityRole="button"
                            accessibilityLabel={`处理人：${event.handled_by ?? '未设置'}，点按在设置中编辑`}
                        >
                            <Text
                                numberOfLines={1}
                                className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                            >
                                {event.handled_by ? `处理人 ${event.handled_by}` : '处理人 未设置'}
                            </Text>
                        </Pressable>
                        <Pressable
                            onPress={() => setSettingsOpen(true)}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                            className="min-w-0 flex-1 flex-row items-center active:opacity-70"
                            accessibilityRole="button"
                            accessibilityLabel={`对象：${
                                event.subject_kind && event.subject_value
                                    ? `${
                                          eventSubjectKindLabel(event.subject_kind)
                                              ? `${eventSubjectKindLabel(event.subject_kind)} `
                                              : ''
                                      }${event.subject_value}`
                                    : '未设置'
                            }，点按在设置中编辑`}
                        >
                            <Text
                                numberOfLines={1}
                                className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                            >
                                {event.subject_kind && event.subject_value
                                    ? `对象 ${
                                          eventSubjectKindLabel(event.subject_kind)
                                              ? `${eventSubjectKindLabel(event.subject_kind)} `
                                              : ''
                                      }${event.subject_value}`
                                    : '对象 未设置'}
                            </Text>
                        </Pressable>
                    </View>
                    {/* meta 行：字数 + 保存状态（journal masthead meta 同语言） */}
                    <Text
                        className="mt-2 text-[11px] text-ink-muted dark:text-inkd-muted"
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
            {/* 设置卡（名称/状态/GPS/处理人/对象/描述/时间线/删除，scrim + 居中卡，
                MetaEditCard 模式；字段变更即时落库） */}
            {settingsOpen ? (
                <EventSettingsCard
                    event={event}
                    onSaveTitle={(value) => saveTitle(value)}
                    onSaveStatus={(status) => saveStatus(status)}
                    onSaveGps={(gps) => saveGps(gps)}
                    onSaveHandledBy={(value) => saveHandledBy(value)}
                    onSaveSubject={(kind, value) => saveSubject(kind, value)}
                    onSaveDescription={(value) => saveDescription(value)}
                    onDelete={() => performDelete()}
                    onSurfaceError={surfaceError}
                    onClose={() => setSettingsOpen(false)}
                    errorText={error}
                />
            ) : null}
            {/* 插入选择器（共享 InsertMenu + actions 过滤词表：相册图/视频、录音/
                拍照/拍视频、添加输入框；全局录制会话进行中时顶部状态行） */}
            {menuOpen ? (
                <InsertMenu
                    actions={EVENT_INSERT_ACTIONS}
                    activeCapture={activeCapture}
                    onClose={() => setMenuOpen(false)}
                    onAction={(action) =>
                        void runInsert(action).catch((caught) => {
                            // 中断场景：录音权限通道 reject（系统中断、环境异常）
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
/* 设置卡（全部元信息编辑 + 删除，MetaEditCard 模式）                     */
/* ------------------------------------------------------------------ */

/** 设置卡删除步（卡内两段式：行 → 确认步，InsertMenu confirming 同语言）。 */
type SettingsStep = 'main' | 'confirm-delete';

/**
 * 事件设置卡（scrim + 居中卡，MetaEditCard/RenameCard 同语言：卡头 CloseButton +
 * Android 返回键出口 + 失败就地 errorText）：
 *
 * - **字段 × 行为矩阵（全部即时落库 updateEventMeta + revision 刷新 + 父层
 *   refreshMeta 权威回读）**：
 *   名称 = FieldInput，blur 保存（无变更跳过；空串/超长 store 拒绝 → 卡内
 *   errorText 就地可重试）；状态 = open/done 分段，点按即存；GPS = 坐标只读
 *   行 + 「重新定位」（权限/服务预检 → 8s 超时兜底，新建表单同口径）/「清除」
 *   点按即存；处理人 = blur 保存（空串 = 清除）；对象 = 类型分段 + 值输入，
 *   类型点按即存整对（原子对归一在 store）、值 blur 保存整对；描述 = multiline
 *   blur 保存（空串 = 清除）；时间线 = 只读展示（event-logic.eventTimeline，
 *   保存后随 refreshMeta 即时刷新）；删除事件 = negative 行 → 卡内确认步
 *   （正文/媒体一并删除警示 + 删除在途 spinner）；
 * - 草稿与基线：文本字段以挂载时行值为基线（baselineRef），成功保存后推进
 *   ——blur 比对基线，无变更不落库（防抖掉无意义写）；草稿不随 props 回读
 *   重置（卡内编辑期间 props 刷新只影响 GPS/时间线等只读展示位）；
 * - onSave resolve false：errorText 就地展示可重试；onClose 是统一出口
 *  （scrim / 卡头 CloseButton / 返回键）。
 */
function EventSettingsCard({
    event,
    onSaveTitle,
    onSaveStatus,
    onSaveGps,
    onSaveHandledBy,
    onSaveSubject,
    onSaveDescription,
    onDelete,
    onSurfaceError,
    onClose,
    errorText,
}: {
    /** 当前行（父层 refreshMeta 权威回读后刷新——只读展示位消费，草稿不回灌）。 */
    event: EventRow;
    onSaveTitle(value: string): Promise<boolean>;
    onSaveStatus(status: EventStatus): Promise<boolean>;
    onSaveGps(gps: { lat: number; lng: number; accuracy?: number } | null): Promise<boolean>;
    onSaveHandledBy(value: string): Promise<boolean>;
    onSaveSubject(kind: EventSubjectKind | null, value: string): Promise<boolean>;
    onSaveDescription(value: string): Promise<boolean>;
    /** 删除（确认步触发；true = 成功——父层已 safeBack，本卡随卸载消失）。 */
    onDelete(): Promise<boolean>;
    /** 卡内非 store 异常（定位失败等）的统一上浮出口（store.error 通道）。 */
    onSurfaceError(message: string): void;
    onClose(): void;
    errorText?: string | null;
}) {
    const palette = usePalette();
    const timeline = eventTimeline(event);
    const hasGps = event.gps_lat != null && event.gps_lng != null;

    // ─── 草稿态（挂载时以行值播种，不随 props 回灌）────────────────────────
    const [titleDraft, setTitleDraft] = useState(event.title);
    const [statusDraft, setStatusDraft] = useState<EventStatus>(event.status);
    const [handledByDraft, setHandledByDraft] = useState(event.handled_by ?? '');
    const [valueDraft, setValueDraft] = useState(event.subject_value ?? '');
    const [descriptionDraft, setDescriptionDraft] = useState(event.description ?? '');
    /** 成功保存后的基线（blur 比对用；失败不推进——下次 blur 可重试）。 */
    const baselineRef = useRef({
        title: event.title,
        handledBy: event.handled_by ?? '',
        kind: event.subject_kind,
        value: event.subject_value ?? '',
        description: event.description ?? '',
    });
    const [deleting, setDeleting] = useState(false);
    const deletingRef = useRef(false);
    const [step, setStep] = useState<SettingsStep>('main');
    // GPS 重定位在途（spinner + 重入闸）
    const [relocating, setRelocating] = useState(false);
    const relocatingRef = useRef(false);
    const locateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Android 返回键：确认步先退回主步（InsertMenu confirming 同语义），主步关闭
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (step === 'confirm-delete') {
                setStep('main');
                return true;
            }
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose, step]);

    // 卸载卫生：在途定位的竞速计时器清理
    useEffect(() => {
        return () => {
            if (locateTimerRef.current) clearTimeout(locateTimerRef.current);
        };
    }, []);

    const saveTitleDraft = async () => {
        if (titleDraft.trim() === baselineRef.current.title.trim()) return;
        const ok = await onSaveTitle(titleDraft);
        if (ok) baselineRef.current.title = titleDraft.trim();
    };

    const saveHandledByDraft = async () => {
        if (handledByDraft === baselineRef.current.handledBy) return;
        const ok = await onSaveHandledBy(handledByDraft);
        if (ok) baselineRef.current.handledBy = handledByDraft;
    };

    /** 对象保存（自定义自由文本；空 = 清除，归一化在 store）。 */
    const saveSubjectDraft = async (value: string) => {
        const trimmed = value.trim();
        const kind: EventSubjectKind | null = trimmed ? 'custom' : null;
        if (kind === baselineRef.current.kind && trimmed === baselineRef.current.value) return;
        const ok = await onSaveSubject(kind, trimmed);
        if (ok) {
            baselineRef.current.kind = kind;
            baselineRef.current.value = kind === null ? '' : trimmed;
        }
    };

    const saveDescriptionDraft = async () => {
        if (descriptionDraft === baselineRef.current.description) return;
        const ok = await onSaveDescription(descriptionDraft);
        if (ok) baselineRef.current.description = descriptionDraft;
    };

    /** 状态分段点按：本地立即翻面（即时反馈）+ 落库；失败回弹原状态
     *  （errorText 就地反馈，同段可重试——不会卡在「选中但没存上」的死相）。 */
    const saveStatusDraft = async (status: EventStatus) => {
        if (status === statusDraft) return;
        const previous = statusDraft;
        setStatusDraft(status);
        const ok = await onSaveStatus(status);
        if (!ok) setStatusDraft(previous);
    };

    /** 重新定位（新建表单同口径）：权限预检（已授权跳过弹窗）→ 系统服务检查 →
     *  8s 超时兜底；成功即覆盖写（saveGps），失败/拒绝/超时给明确文案（store
     *  外异常经 onSurfaceError 上浮——卡内 errorText 同帧可见）。 */
    const relocate = async () => {
        if (relocatingRef.current) return;
        relocatingRef.current = true;
        setRelocating(true);
        try {
            const permission = await location.getPermissionAsync();
            let granted = permission.granted;
            if (!granted) {
                const requested = await location.requestPermissionAsync();
                granted = requested.granted;
            }
            if (!granted) throw new Error('定位权限未授权');
            const services = await location.hasServicesEnabledAsync();
            if (!services) throw new Error('定位服务未开启');
            const pos = await Promise.race([
                location.getCurrentPositionAsync(),
                new Promise<never>((_, reject) => {
                    locateTimerRef.current = setTimeout(() => reject(new Error('定位超时')), LOCATE_TIMEOUT_MS);
                }),
            ]);
            const ok = await onSaveGps({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                ...(pos.coords.accuracy != null ? { accuracy: pos.coords.accuracy } : {}),
            });
            // ok false：store 已落 GPS 校验文案（errorText 就地可见）
        } catch (caught) {
            onSurfaceError(`定位失败：${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
            if (locateTimerRef.current) {
                clearTimeout(locateTimerRef.current);
                locateTimerRef.current = null;
            }
            relocatingRef.current = false;
            setRelocating(false);
        }
    };

    /** 确认步删除（in-flight spinner + 重入闸；成功父层 safeBack 本卡随卸载）。 */
    const confirmDelete = async () => {
        if (deletingRef.current) return;
        deletingRef.current = true;
        setDeleting(true);
        try {
            await onDelete();
        } finally {
            deletingRef.current = false;
            setDeleting(false);
        }
    };

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭事件设置"
            >
                <Pressable className="w-full max-w-xs rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮 */}
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            {step === 'confirm-delete' ? '删除事件？' : '事件设置'}
                        </Text>
                        <CloseButton onPress={onClose} />
                    </View>
                    <ScrollView
                        className="mt-4"
                        style={{ maxHeight: 440 }}
                        nestedScrollEnabled
                        keyboardShouldPersistTaps="handled"
                    >
                        {step === 'confirm-delete' ? (
                            /* ── 确认步（破坏性动作二次确认，DeleteConfirmCard 同语言收进卡内）── */
                            <View>
                                <Text className="text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                                    正文、媒体会一并删除，不可恢复。
                                </Text>
                                <View className="mt-4 gap-2.5">
                                    {/* 取消 = 退回主步（返回键同语义）；删除在途时禁用出口，
                                        防「确认步关了、删除还在跑」的状态错位 */}
                                    <BouncyPressable
                                        onPress={() => setStep('main')}
                                        disabled={deleting}
                                        scaleTo={0.97}
                                    >
                                        <View
                                            className="h-11 items-center justify-center rounded-control bg-ink-surface dark:bg-inkd-surface"
                                            accessibilityRole="button"
                                            accessibilityLabel="返回设置"
                                        >
                                            <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                                取消
                                            </Text>
                                        </View>
                                    </BouncyPressable>
                                    <BouncyPressable
                                        onPress={() => void confirmDelete()}
                                        disabled={deleting}
                                        scaleTo={0.97}
                                    >
                                        <View
                                            className="h-11 items-center justify-center rounded-control"
                                            style={{ backgroundColor: palette.negative, opacity: deleting ? 0.6 : 1 }}
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
                            </View>
                        ) : (
                            /* ── 主步：字段 × 即时落库 ── */
                            <View className="gap-4">
                                {/* 名称（title 编辑，store.updateEventMeta v6.1 扩展） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        名称
                                    </Text>
                                    <FieldInput
                                        value={titleDraft}
                                        onChangeText={setTitleDraft}
                                        placeholder="事件叫什么？"
                                        maxLength={EVENT_TITLE_MAX}
                                        accessibilityLabel="事件名称"
                                        onBlur={() => void saveTitleDraft()}
                                    />
                                </View>

                                {/* 状态（open/done 分段，点按即存）：轨道语言与列表页
                                    状态分段同构；横向 hitSlop 归 0（gap-1 间距） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        状态
                                    </Text>
                                    <View className="flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface">
                                        {(['open', 'done'] as const).map((option) => {
                                            const active = statusDraft === option;
                                            const label = option === 'open' ? '进行中' : '已完成';
                                            return (
                                                <Pressable
                                                    key={option}
                                                    onPress={() => void saveStatusDraft(option)}
                                                    hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                                                    className={`h-9 flex-1 items-center justify-center rounded-thumb active:bg-ink-raised dark:active:bg-inkd-raised ${
                                                        active
                                                            ? 'bg-ink-raised dark:bg-inkd-raised'
                                                            : 'bg-ink-surface dark:bg-inkd-surface'
                                                    }`}
                                                    accessibilityRole="button"
                                                    accessibilityState={{ selected: active }}
                                                    accessibilityLabel={`状态：${label}`}
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
                                </View>

                                {/* GPS（坐标只读 + 重定位/清除，点按即存） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        位置
                                    </Text>
                                    <View className="rounded-control bg-ink-surface px-3.5 py-2 dark:bg-inkd-surface">
                                        {hasGps ? (
                                            <>
                                                <Text
                                                    className="text-[13px] text-ink-secondary dark:text-inkd-secondary"
                                                    style={{ fontVariant: ['tabular-nums'] }}
                                                >
                                                    {`${event.gps_lat}, ${event.gps_lng}`}
                                                </Text>
                                                {event.gps_accuracy != null ? (
                                                    <Text
                                                        className="mt-1 text-[11px] text-ink-muted dark:text-inkd-muted"
                                                        style={{ fontVariant: ['tabular-nums'] }}
                                                    >
                                                        {`精度 ±${Math.round(event.gps_accuracy)}m`}
                                                    </Text>
                                                ) : null}
                                            </>
                                        ) : (
                                            <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">
                                                未定位
                                            </Text>
                                        )}
                                    </View>
                                    <View className="mt-2 flex-row gap-2">
                                        <BouncyPressable
                                            onPress={() => void relocate()}
                                            disabled={relocating}
                                            scaleTo={0.97}
                                            hitSlop={4}
                                        >
                                            <View
                                                className="h-9 flex-row items-center justify-center gap-1.5 rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface"
                                                accessibilityRole="button"
                                                accessibilityLabel="重新定位"
                                            >
                                                {relocating ? (
                                                    <ActivityIndicator size="small" color={palette.secondary} />
                                                ) : (
                                                    <LucideMapPin size={14} strokeWidth={1.9} color={palette.secondary} />
                                                )}
                                                <Text className="text-[13px] font-medium text-ink-text dark:text-inkd-text">
                                                    {relocating ? '定位中…' : '重新定位'}
                                                </Text>
                                            </View>
                                        </BouncyPressable>
                                        {hasGps ? (
                                            <BouncyPressable
                                                onPress={() => void onSaveGps(null)}
                                                scaleTo={0.97}
                                                hitSlop={4}
                                            >
                                                <View
                                                    className="h-9 items-center justify-center rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface"
                                                    accessibilityRole="button"
                                                    accessibilityLabel="清除定位"
                                                >
                                                    <Text className="text-[13px] font-medium text-ink-text dark:text-inkd-text">
                                                        清除
                                                    </Text>
                                                </View>
                                            </BouncyPressable>
                                        ) : null}
                                    </View>
                                </View>

                                {/* 处理人（blur 保存，空串 = 清除） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        处理人
                                    </Text>
                                    <FieldInput
                                        value={handledByDraft}
                                        onChangeText={setHandledByDraft}
                                        placeholder="谁来处理？（留空清除）"
                                        maxLength={EVENT_HANDLED_BY_MAX}
                                        accessibilityLabel="处理人"
                                        onBlur={() => void saveHandledByDraft()}
                                    />
                                </View>

                                {/* 对象（可选，自定义自由文本：blur 保存，空 = 清除） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        对象
                                    </Text>
                                    <FieldInput
                                        value={valueDraft}
                                        onChangeText={setValueDraft}
                                        placeholder="针对的对象：手机号 / 邮箱 / 地址 / 坐标（留空清除）"
                                        maxLength={EVENT_SUBJECT_VALUE_MAX}
                                        accessibilityLabel="对象"
                                        onBlur={() => void saveSubjectDraft(valueDraft)}
                                    />
                                </View>

                                {/* 描述（multiline，blur 保存，空串 = 清除） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        描述
                                    </Text>
                                    <FieldInput
                                        value={descriptionDraft}
                                        onChangeText={setDescriptionDraft}
                                        placeholder="一句话摘要（留空清除）"
                                        multiline
                                        maxLength={EVENT_DESCRIPTION_MAX}
                                        accessibilityLabel="事件描述"
                                        onBlur={() => void saveDescriptionDraft()}
                                    />
                                </View>

                                {/* 时间线（只读）：event-logic.eventTimeline 单一口径，
                                    保存后随父层 refreshMeta 即时刷新 */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        时间线
                                    </Text>
                                    <View className="rounded-control bg-ink-surface px-3.5 py-2 dark:bg-inkd-surface">
                                        <Text
                                            className="text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                            style={{ fontVariant: ['tabular-nums'] }}
                                        >
                                            {`创建 ${timeline.createdText}`}
                                        </Text>
                                        {timeline.edited ? (
                                            <Text
                                                className="mt-1 text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                                style={{ fontVariant: ['tabular-nums'] }}
                                            >
                                                {`更新 ${timeline.updatedText}`}
                                            </Text>
                                        ) : null}
                                    </View>
                                </View>

                                {/* 删除事件（negative 弱行钮 → 卡内确认步；删除为级联
                                    软删 + 文件清理，确认步强调后果） */}
                                <View>
                                    <BouncyPressable
                                        onPress={() => setStep('confirm-delete')}
                                        scaleTo={0.97}
                                    >
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
                        )}
                        {/* 失败就地展示（保存/定位失败的 store 文案；卡内可重试） */}
                        {errorText ? (
                            <Text className="mt-3 text-[12px] text-ink-negative dark:text-inkd-negative">
                                {errorText}
                            </Text>
                        ) : null}
                    </ScrollView>
                </Pressable>
            </Pressable>
        </View>
    );
}
