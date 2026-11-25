import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import {
    BouncyPressable,
    createIcon,
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
// 深路径注记：节奏表 / 画布句柄 / 键盘动态垫高 hook / 堆叠单元判定（findDeckUnit，
// 分组规则单一事实源 buildRenderUnits 的屏层取数口）/ EventSettingsCard 未在
// ui/index.ts 出口（域内深取纪律，先例同 journal-edit / trip-detail）。
import {
    findDeckUnit,
    useKeyboardCanvasBottomPadding,
    type BlockEditorHandle,
    type EditorCanvasHandle,
} from './ui/editor';
// 深路径注记：ChevronUp/Down 未在 ui/index.ts 出口（域内深取纪律，
// journal-edit 块操作卡同款先例）。
import { ChevronDownIcon, ChevronUpIcon } from './ui/editor-icons';
import * as db from './db';
import type { EventMediaRow, EventRow, EventStatus, EventSubjectKind, JournalMediaRow } from './db';
import { ensureVideoThumbnail, useArchiveRevision, useArchiveStore } from './store';
import {
    eventStatusLabel,
    eventSubjectKindLabel,
    eventTimeline,
} from './event-logic';
import {
    insertPendingBlock,
    moveBlock,
    moveBlockRun,
    newBlockId,
    newParagraphBlock,
    parseBlocks,
    removeBlock,
    removeBlocks,
    resolvePendingBlock,
    type JournalBlock,
} from './journal-logic';
import {
    BlockEditor,
    CloseButton,
    EmptyState,
    formatAudioTime,
    InsertMenu,
    LoadingView,
    PAPER_FLOAT_SHADOW,
    safeBack,
    usePalette,
    type InsertAction,
} from './ui';
import { EventStatusChip } from './ui/event-card';
// 设置卡共享组件（列表页长按同款入口）：落库通道经回调注入（本屏 = updateEventMeta
// + refreshMeta 既有链），组件不回头依赖 store/屏文件（RenameCard 先例）。
import { EventSettingsCard } from './ui/event-settings-card';

/**
 * 事件详情编辑页（/events/[id]，计划编辑式 + 工单状态头 + 设置卡）：
 *
 * - **状态头（工单语言，展示 + 编辑入口，v0.4.6 收敛）**：标题行（**只读展示**
 *   ——标题编辑收进设置卡，编辑后经 refreshMeta 权威回读即时刷新；屏题档
 *   24 semibold，与 ScreenHeader 同字阶）+ 设置钮（LucideSettings，44 圆形
 *   触感底盒 + hitSlop 10，与返回钮同解剖左右呼应）+ 状态片（点按打开设置卡
 *   ——元信息编辑统一收口，不再直切）+ 时间线（只留「创建」一档，方向令 §2
 *   「更新于 …」冗余串退役；更新事实在设置卡时间线只读位）+ 轻量 meta 行
 *   （GPS 坐标 **点按复制** / 处理人 / 对象 / 电话 / 邮箱——**只展示有值的
 *   字段**，「未设置/未定位」占位噪音退役，全缺位整行不渲染；点按打开设置卡
 *   编辑）+ 保存落点闪现行（仅 savedAt 后一行「已保存 HH:mm」，字数与
 *   「自动保存开启」常驻串退役）；
 * - **正文 = BlockEditor 复用**（事件 blocks 与 journal 块模型同构，JournalBlock
 *   不变；mediaId → event_media 行经 toJournalMediaRow 适配器喂编辑器的
 *   mediaById 契约——行结构同构，仅 journal_id 槽位以 event_id 占位）：
 *   800ms 防抖 updateEventBlocks + 失焦即存双通道 + 卸载兜底 flush（含在途
 *   上传 allSettled 收敛后再存——比 journal-edit 的裸 flush 多一层在途回填
 *   保护，防「上传完成于卸载之后，块引用永不落库」的对账误杀）；
 * - **块操作卡与堆叠操作（2026-11-11 反馈①补齐，journal-edit 同词表同构）**：
 *   堆叠锚块「上移/下移」= 整组移动（moveBlockRun 连续段同进退，hint 标
 *   「整组 N 张」）、「指定删除」进入 deckDelete 勾选模式（顶栏多选，白名单
 *   = 组内成员）、「删除整组」批量摘除（danger）、「删除」改义「删除当前张」；
 *   单块路径行为不变。落库统一走既有防抖链（applyBlocks → blocks effect →
 *   800ms updateEventBlocks），与文本编辑同一条保存通道；
 * - **插入后台异步并行**（完整对齐 journal-edit 的 attach 模式）：doAttach 同步
 *   插 pending 占位即返回，attachEventMedia 落盘+落库为后台任务（pendingUploadsRef
 *   注册表，多任务并行；taskId = 占位 id → 占位卡进度百分比，journal 同口径）；
 *   收敛后 resolvePendingBlock 原位回填，失败仅回滚本占位 + store.error；
 * - **+ 菜单与计划编辑完全一致**（共享 ui/insert-menu 的 InsertMenu，actions
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
 *   v6.1 扩展 title patch）/ 状态（open/done/failed 三分段）/ GPS（重定位/清除）/
 *   处理人 / 对象（类型+值，原子对归一在 store）/ 手机号 / 邮箱（v7）/
 *   描述 / 时间线（只读）；字段变更**即时落库**（updateEventMeta
 *   + revision bump + refreshMeta 权威回读），文本字段 blur 保存、分段/按钮
 *   点按即存。**事件不可删除**（产品口径）：设置卡与屏内均无删除入口，store/
 *   db 的 deleteEvent 数据层能力保留仅 UI 不暴露；deletedRef 闸保留为数据层
 *   侧软删竞态的防御位；
 * - **正文区纯编辑**：原「危险区（删除事件行）」与处理人/对象编辑卡
 *   （MetaEditCard）已移除——元信息编辑统一收进设置卡。
 *
 * typedRoutes：动态路由参数经 useLocalSearchParams 读取（同 trip-detail 范式），
 * 屏内不产生新的路由字面量。
 */

/** 画布底部静态垫高基线（dp）：给 + 浮钮让位（journal-edit 同款几何）。 */
const CANVAS_BOTTOM_BASE_INSET = 96;

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

/**
 * 事件多选模式状态（deckDelete 单用途，journal-edit SelectModeState 的
 * deckDelete 分支同构）：deckIds 白名单 = 目标堆叠成员块 id（编辑器内组外
 * 媒体回常态渲染，见 BlockEditor selection 的 selectableIds 注；音频成员恒
 * 不可选），orderedIds = 勾选清单（选择顺序），勾完经顶栏「删除」确认。
 * purpose 字段与 journal 侧形状对齐（后续若平移合并堆叠语义直接扩 union）。
 */
type EventSelectMode = {
    purpose: 'deckDelete';
    orderedIds: string[];
    deckIds: ReadonlySet<string>;
};

/* ------------------------------------------------------------------ */
/* 图标（块操作卡堆叠行；journal-edit 块操作卡同词表同图标）              */
/* ------------------------------------------------------------------ */

/** 指定删除（块操作卡堆叠行；list-checks，lucide 1.64 官方 path 数据）。与
 *  journal-edit 的 ListChecksIcon 同源同形——该屏文件为上一波成果（禁改），
 *  其字面量未抽共享模块，事件侧镜像同 path 数据保持两边一致（词表一致性
 *  选法见 EventBlockActionCard 注）。 */
const ListChecksIcon = createIcon(
    <>
        <Path d="M13 5h8" />
        <Path d="M13 12h8" />
        <Path d="M13 19h8" />
        <Path d="m3 17 2 2 4-4" />
        <Path d="m3 7 2 2 4-4" />
    </>,
);

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
    // 数据层软删竞态闸（防御位）：事件 UI 不可删除（产品口径，无删除入口），
    // 但 store/db 的 deleteEvent 能力保留——若行在数据层被软删（GC/迁移对账
    // 等数据侧路径），置位后卸载 flush / 防抖保存不得再向已删行回写 blocks
    // （db.updateEventBlocks 按 id 直更，无 deleted_at 过滤）
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
            const pending = Array.from(pendingUploadsRef.current.values());
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

    /** 设置卡：状态分段（open/done/failed，任意态互切）。 */
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

    /** 设置卡：手机号（v7，空串经 store 归一为 null = 清除，normalizeEventText
     *  口径；自由文本无格式校验）。 */
    const savePhone = useCallback(
        async (value: string) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, { phone: value });
            if (ok) void refreshMeta();
            return ok;
        },
        [store, refreshMeta],
    );

    /** 设置卡：邮箱（v7，空串 = 清除；值内明显空白由 store 的 normalizeEventEmail
     *  剥除——单一清洗点在 store，屏层不复制口径）。 */
    const saveEmail = useCallback(
        async (value: string) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return false;
            const ok = await store.getState().updateEventMeta(row.id, { email: value });
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

    // 事件不可删除（产品口径）：设置卡 onDelete 通道与屏内删除路径已移除，
    // store/db 的 deleteEvent 数据层能力保留仅 UI 不暴露；deletedRef 闸保留
    // 为数据层侧软删竞态的防御位（语义见其声明注）。

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
    // 多选模式（堆叠「指定删除」，journal-edit 同构）：deckIds 白名单 = 目标
    // 堆叠成员块 id，orderedIds = 勾选清单；勾完经顶栏「删除」确认落库
    const [selectMode, setSelectMode] = useState<EventSelectMode | null>(null);
    // 多选模式 ref 镜像（离开屏/确认回调读取，journal-edit 同款）
    const selectModeRef = useRef(selectMode);
    selectModeRef.current = selectMode;
    // 在途媒体上传注册表（进程内 Map）：pendingId → promise——多任务并行互不
    // 影响；任务收敛即自摘除。（kind 槽已随媒体数量上限移除退役——原仅供
    // 选取上限计数）
    const pendingUploadsRef = useRef(new Map<string, Promise<void>>());
    // 相册选取互斥（系统 picker 单例，防重复拉起）
    const pickingRef = useRef(false);

    const mediaById = useMemo(() => new Map(media.map((row) => [row.id, row])), [media]);

    /**
     * 插入流本体（**后台异步并行**）：pending 占位**同步**插入（即时反馈），
     * attachEventMedia 为后台任务注册进 pendingUploadsRef——多任务并行互不等待；
     * 单任务失败仅回滚本 pending + 上浮 error。落点/回填走 journal-logic
     * 纯函数（真实文末追加、原位替换）；updater 纯函数（块 id 在 updater 外
     * 预生成——#1.2 纪律）。taskId = 占位 id：视频直迁流有逐块进度，占位块
     * 经 progressByPendingId 显示百分比（journal 同口径；图片/音频字节路径
     * 无进度拍，占位保持 spinner 态）。媒体数量上限已按用户指令全域移除
     * （2026-11-20）：插入入口不再设总量闸。
     */
    const doAttach = useCallback(
        (kind: 'image' | 'video', uri: string, width: number | null, height: number | null) => {
            const row = eventRef.current;
            if (!row || deletedRef.current) return;
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
            pendingUploadsRef.current.set(pendingId, task);
            void task.then(() => {
                pendingUploadsRef.current.delete(pendingId);
            });
        },
        [applyBlocks, store],
    );

    /**
     * 相册通道（多选）：权限 → 批量选图/选视频 → 按选取顺序逐张插入流。
     * allowsMultipleSelection 不设 selectionLimit——媒体数量上限已按用户指令
     * 全域移除（2026-11-20），选取数量不封顶；orderedSelection = 序号角标 +
     * 严格按选取顺序返回，Android/web 忽略。
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
                const result = await imagePicker.launchImageLibraryAsync({
                    mediaTypes: [kind === 'video' ? 'videos' : 'images'],
                    // 多选不设上限；orderedSelection（iOS 15+）= 序号角标 +
                    // 严格按选取顺序返回，Android/web 忽略
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
    // 设置卡（全部元信息编辑收口；事件不可删除，无删除入口）：标题行右上设置
    // 钮进入。onClose 稳定引用（memo 卡的生效前提——saveX 系列已 useCallback 化）
    const [settingsOpen, setSettingsOpen] = useState(false);
    const closeSettings = useCallback(() => setSettingsOpen(false), []);

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

    /**
     * 离开屏（journal-edit 同构）：多选中 = 先退出选择态（返回不直接丢路由，
     * 防误触把勾选面整页带走）；其余路径 safeBack（卸载 flush 兜底补存，含
     * 在途上传收敛）。Android 硬件返回在此收口——操作卡/设置卡各自注册的
     * BackHandler 在其展开时优先响应（后注册先派发），落不到本 effect。
     */
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

    // ─── 块操作卡 + 多选模式（堆叠整组/指定删除，journal-edit 同词表同构）──────
    // 块操作卡定位（上移/下移禁用态与当前块）
    const actionIndex = actionBlockId ? blocks.findIndex((block) => block.id === actionBlockId) : -1;
    // 操作卡的堆叠单元投影（journal-edit 同款取数口）：操作块落在某媒体堆内 →
    // deck 单元（组界下标 + 全员块 id，分组判定复用编辑器 buildRenderUnits——
    // 渲染与整组操作口径天然锁步）；null = 单块路径（单张媒体/文本/组内孤员）
    const actionDeckUnit = useMemo(
        () => (actionBlockId ? findDeckUnit(blocks, mediaById, actionBlockId) : null),
        [blocks, mediaById, actionBlockId],
    );

    /** 多选切换（journal-edit toggleSelect 同构）：指定删除白名单守卫——目标
     *  堆叠之外的块不可勾（编辑器侧已用 selectableIds 限制，屏层兜底防直调）。 */
    const toggleSelect = useCallback((blockId: string) => {
        setSelectMode((current) => {
            if (!current || !current.deckIds.has(blockId)) return current;
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

    /** 指定删除确认（journal-edit confirmDeckDelete 同构）：删除勾选清单——
     *  媒体堆是独立块序列，按块 id 摘除即可；「至少留一个可落笔段」兜底与
     *  单块删除同口径（journal-logic.removeBlocks，软删除语义：媒体行/二进制
     *  不删）。落库走事件侧既有防抖链（applyBlocks → blocks effect → 800ms
     *  updateEventBlocks），与文本编辑同一条保存通道，无需额外落库面。 */
    const confirmDeckDelete = useCallback(() => {
        const current = selectModeRef.current;
        if (!current || current.orderedIds.length === 0) return;
        const ids = current.orderedIds;
        setSelectMode(null);
        applyBlocks((blocks) => removeBlocks(blocks, ids));
    }, [applyBlocks]);

    /**
     * 块操作卡「指定删除」行（journal-edit openDeckDeleteSelect 同构，仅堆叠
     * 锚块出现）：进入堆叠勾选模式——白名单 = 目标堆叠成员（组外媒体在编辑器
     * 内回常态渲染可照常查看，不进勾选面）；入口即收键盘 + 关操作卡（与
     * journal 多选同口径：选择优先，画布让位给勾选交互）。
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

    /**
     * 块操作卡动作（上移/下移，journal-edit 同构「堆叠时全部移动不是单张」）：
     * 操作块落在媒体堆内 → **整组移动**（组首/组尾连续段同进退，组内顺序与
     * 连续性零变化——journal-logic.moveBlockRun 按段换位）；单块（单张媒体/
     * 文本/组内孤员）走原单块移动。读 blocksRef 权威镜像（后台回填同帧写入
     * 不丢）。
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

    /** 块操作卡动作（删除；堆叠锚块词表改义「删除当前张」，行为=删前卡成员）：
     *  删到空时 removeBlock 会补一个可落笔空段。 */
    const removeActionBlock = () => {
        if (!actionBlockId) return;
        const blockId = actionBlockId;
        setActionBlockId(null);
        applyBlocks((current) => removeBlock(current, blockId));
    };

    /** 块操作卡动作（「删除整组」，journal-edit removeActionDeck 同构）：堆叠
     *  全员一次摘除（deck = 独立块序列，按组内块 id 清单删；软删除语义与单块
     *  删除一致——媒体行与二进制不删）。删除后组内剩余成员自动重派生。 */
    const removeActionDeck = () => {
        if (!actionDeckUnit) return;
        setActionBlockId(null);
        applyBlocks((current) => removeBlocks(current, actionDeckUnit.blockIds));
    };

    // 多选编辑器面（journal-edit 同构）：选择态屏蔽文本聚焦（editable=false
    // 下传），媒体勾选数据 + 指定删除白名单透传——音频置灰不可选、组外媒体
    // 回常态渲染由编辑器内部处理（selection/selectedIds/selectableIds 契约，
    // 事件画布复用零假设破裂：mediaById 已是同构适配行）。
    const editorEditable = event != null && !selectMode;
    const selection = useMemo(
        () =>
            selectMode
                ? {
                      selectedIds: new Set(selectMode.orderedIds),
                      onToggle: toggleSelect,
                      selectableIds: selectMode.deckIds,
                  }
                : null,
        [selectMode, toggleSelect],
    );

    /**
     * 画布内容子树（children 直传垫高层）：useMemo 把引用稳定到真正影响内容的
     * 依赖上——键盘弹出/收起只重渲 CanvasDismissLayer 自身 style，本子树经
     * children 引用相等 bail-out 零重渲（journal-edit 同口径）。正文区纯编辑
     * （危险区已移除——元信息编辑收进设置卡，正文不再混元信息动作）。
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
                    onBlurText={() => void saveNow()}
                    onRequestActionBlock={setActionBlockId}
                />
            </View>
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 闭包读取项已尽数列入（applyBlocks/saveNow/稳定 setter/editorRef 稳定引用）
        [blocks, mediaById, editorEditable, selection, focusTextId, canvas, applyBlocks, saveNow],
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

    // 冗余串收敛（方向令 §2）：报头时间线只留「创建」一档（「更新于 …」串
    // 退役——更新事实在设置卡时间线只读位查），未设置字段不再顶「未设置」
    // 占位；「N 字 · 自动保存开启」整行退役，仅保存落点闪现「已保存 HH:mm」。
    const timeline = eventTimeline(event);
    const hasGps = event.gps_lat != null && event.gps_lng != null;
    const gpsText = hasGps ? `${event.gps_lat}, ${event.gps_lng}` : '';
    const savedText = savedAt
        ? `已保存 ${String(new Date(savedAt).getHours()).padStart(2, '0')}:${String(new Date(savedAt).getMinutes()).padStart(2, '0')}`
        : null;

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
                            className="ml-2.5 min-w-0 flex-1 text-[24px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {event.title}
                        </Text>
                        {/* 设置入口（全部元信息编辑的统一门）：v0.4.6 起与
                            CloseButton 同一圆钮解剖（44 触感底盒 + 裸图标，
                            描边方盒退役——报头两个圆钮左右呼应，一个回一个调） */}
                        <BouncyPressable
                            onPress={() => setSettingsOpen(true)}
                            scaleTo={0.9}
                            hitSlop={10}
                        >
                            <View
                                accessibilityRole="button"
                                accessibilityLabel="事件设置"
                                className="h-11 w-11 items-center justify-center rounded-full bg-ink-raised dark:bg-inkd-raised"
                            >
                                <LucideSettings size={18} strokeWidth={1.9} color={palette.secondary} />
                            </View>
                        </BouncyPressable>
                    </View>
                    {/* 状态 + 创建时间行：状态片点按打开设置卡（状态编辑统一收口
                        设置卡——快切直改已收编，避免双编辑面漂移）；时间线只留
                        「创建」一档（方向令 §2 冗余串退役），tabular-nums */}
                    <View className="mt-2 flex-row items-center gap-2">
                        <BouncyPressable
                            onPress={() => setSettingsOpen(true)}
                            scaleTo={0.92}
                            hitSlop={10}
                        >
                            <View
                                accessibilityRole="button"
                                accessibilityLabel={`状态：${eventStatusLabel(event.status)}，点按在设置中修改`}
                            >
                                <EventStatusChip status={event.status} />
                            </View>
                        </BouncyPressable>
                        <Text
                            numberOfLines={1}
                            className="min-w-0 flex-1 text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`创建 ${timeline.createdText}`}
                        </Text>
                    </View>
                    {/* 轻量 meta 行（v0.4.6 收敛）：只展示**已有值**的字段（GPS
                        点按复制 / 处理人 / 对象 / 电话 / 邮箱），未设置不再顶
                        「未设置/未定位」占位噪音（方向令 §2「最小必要 meta」）；
                        全部缺位时整行不渲染。各段独立命中体，hitSlop 6 = 12px
                        外扩，段间距 gap-3(12) ≥ 6+6 相切不重叠（旧核算保留） */}
                    {hasGps || event.handled_by || (event.subject_kind && event.subject_value) || event.phone || event.email ? (
                        <View className="mt-2 flex-row flex-wrap items-center gap-x-3 gap-y-1">
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
                            ) : null}
                            {event.handled_by ? (
                                <Pressable
                                    onPress={() => setSettingsOpen(true)}
                                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                    className="min-w-0 flex-row items-center active:opacity-70"
                                    accessibilityRole="button"
                                    accessibilityLabel={`处理人：${event.handled_by}，点按在设置中编辑`}
                                >
                                    <Text
                                        numberOfLines={1}
                                        className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                    >
                                        {`处理人 ${event.handled_by}`}
                                    </Text>
                                </Pressable>
                            ) : null}
                            {event.subject_kind && event.subject_value ? (
                                <Pressable
                                    onPress={() => setSettingsOpen(true)}
                                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                    className="min-w-0 flex-row items-center active:opacity-70"
                                    accessibilityRole="button"
                                    accessibilityLabel={`对象：${
                                        eventSubjectKindLabel(event.subject_kind)
                                            ? `${eventSubjectKindLabel(event.subject_kind)} `
                                            : ''
                                    }${event.subject_value}，点按在设置中编辑`}
                                >
                                    <Text
                                        numberOfLines={1}
                                        className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                    >
                                        {`对象 ${
                                            eventSubjectKindLabel(event.subject_kind)
                                                ? `${eventSubjectKindLabel(event.subject_kind)} `
                                                : ''
                                        }${event.subject_value}`}
                                    </Text>
                                </Pressable>
                            ) : null}
                            {event.phone ? (
                                <Pressable
                                    onPress={() => setSettingsOpen(true)}
                                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                    className="min-w-0 flex-row items-center active:opacity-70"
                                    accessibilityRole="button"
                                    accessibilityLabel={`电话：${event.phone}，点按在设置中编辑`}
                                >
                                    <Text
                                        numberOfLines={1}
                                        className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                    >
                                        {`电话 ${event.phone}`}
                                    </Text>
                                </Pressable>
                            ) : null}
                            {event.email ? (
                                <Pressable
                                    onPress={() => setSettingsOpen(true)}
                                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                    className="min-w-0 flex-row items-center active:opacity-70"
                                    accessibilityRole="button"
                                    accessibilityLabel={`邮箱：${event.email}，点按在设置中编辑`}
                                >
                                    <Text
                                        numberOfLines={1}
                                        className="shrink text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                    >
                                        {`邮箱 ${event.email}`}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}
                    {/* 保存落点闪现（11 muted tabular；「N 字 · 自动保存开启」
                        常驻噪音已退役——保存过才有一行，没保存就什么都没有） */}
                    {savedText ? (
                        <Text
                            className="mt-2 text-[11px] text-ink-faint dark:text-inkd-faint"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {savedText}
                        </Text>
                    ) : null}
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

                {/* 罗盘 + 号（插入媒体/输入框）：后台并行模型不因上传禁用；多选
                    模式隐藏（选择优先，journal-edit 同口径） */}
                {!selectMode ? (
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

            {/* 多选选择栏（顶部，选择优先；堆叠「指定删除」模式，journal-edit
                同词表同构）：44 命中双钮 + 已选计数（带「/ 总数」）；覆盖在报头
                之上但不遮画布（bar 以下区域全部留给媒体勾选点按）；确认钮 =
                负色「删除」，0 选中禁用。 */}
            {selectMode ? (
                <View className="absolute inset-x-0 top-0 z-40" style={{ paddingTop: insets.top }}>
                    <View className="flex-row items-center gap-1 border-b border-ink-rule bg-ink-base px-3 py-1 dark:border-inkd-rule dark:bg-inkd-base">
                        <Text
                            className="px-1 text-[13px] font-medium text-ink-text dark:text-inkd-text"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`已选 ${selectMode.orderedIds.length} / ${selectMode.deckIds.size}`}
                        </Text>
                        <View className="flex-1" />
                        <BouncyPressable onPress={cancelSelect} scaleTo={0.95}>
                            <View
                                className="h-11 items-center justify-center rounded-control px-3"
                                accessibilityRole="button"
                                accessibilityLabel="取消指定删除"
                            >
                                <Text className="text-[14px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    取消
                                </Text>
                            </View>
                        </BouncyPressable>
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
                    </View>
                </View>
            ) : null}

            {/* 块操作卡（上移/下移/删除 + 堆叠「指定删除/删除整组」，浮层居中
                弹出，条件渲染禁 RN Modal） */}
            {actionBlockId && actionIndex >= 0 ? (
                <EventBlockActionCard
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
                    onMove={moveActionBlock}
                    onDelete={removeActionBlock}
                    onDeleteDeck={removeActionDeck}
                    onSelectDelete={openDeckDeleteSelect}
                    onClose={() => setActionBlockId(null)}
                />
            ) : null}
            {/* 设置卡（名称/状态/GPS/处理人/对象/手机号/邮箱/描述/时间线，scrim +
                居中卡，MetaEditCard 模式；字段变更即时落库；回调稳定引用直传——
                memo 卡的生效前提；事件不可删除，无 onDelete 通道） */}
            {settingsOpen ? (
                <EventSettingsCard
                    event={event}
                    onSaveTitle={saveTitle}
                    onSaveStatus={saveStatus}
                    onSaveGps={saveGps}
                    onSaveHandledBy={saveHandledBy}
                    onSaveSubject={saveSubject}
                    onSavePhone={savePhone}
                    onSaveEmail={saveEmail}
                    onSaveDescription={saveDescription}
                    onSurfaceError={surfaceError}
                    onClose={closeSettings}
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
/* 块操作卡（上移/下移/删除 + 堆叠「指定删除/删除整组」）                 */
/* ------------------------------------------------------------------ */

/**
 * 事件块操作卡（媒体长按/双击、文本聚焦 ⋯ 钮 → 屏根浮层，条件渲染禁 RN Modal）：
 * 编辑器核心块操作（上移/下移/删除——删到空补可落笔段，journal-logic removeBlock
 * 口径）+ 堆叠锚块分档（deck prop 非 null 时，与 journal-edit BlockActionCard
 * **同词表 / 同图标 / 同行结构**——日记与事件的媒体块行为一致，用户
 * 口径「作用是全部计划编辑。和事件操作」）：
 * - 「上移/下移」= **整组移动**（组首/组尾连续段同进退，journal-logic
 *   .moveBlockRun；禁用态按组界判定而非锚块下标）；
 * - 「指定删除」：进入堆叠勾选模式（白名单 = 组内成员，组外媒体照常可查看，
 *   勾完经顶栏「删除」确认——屏层 openDeckDeleteSelect/confirmDeckDelete）；
 * - 「删除整组」：批量删除组内全部块（danger，软删除语义与单块删除一致）；
 * - 「删除」行改义为「删除当前张」（只删当前显示的前卡成员）。
 *
 * 行结构（2026-11-19 容器化）：与 journal-edit BlockActionCard 同一单容器行组
 * （卡壳 max-w-sm p-3 + rounded-card surface 单容器 + 行 h-12 px-4 贴靠零线条
 * + 行级 active:bg），行名四字（hint 已退役，journal-edit 2026-11-19 同口径）。
 *
 * 词表一致性选法（回报项）：journal-edit-screen.tsx 为上一波成果（禁改），其
 * 行词表为卡内字面量、未抽共享模块——事件侧取「两边同字面量」，行词表 /
 * 图标（ChevronUp/Down、ListChecks、Trash）逐项对齐并各自挂注释锚点；
 * 改动任一侧行词表/行结构时两侧必须同改（后续若建共享词表模块再一并收口）。
 *
 * 合并堆叠/解散堆叠/保存到手机等 journal 编辑器专属动作未纳入事件块操作卡
 * （既有范围决策；块模型同构，后续可平移）。
 */
function EventBlockActionCard({
    index,
    total,
    deck,
    onMove,
    onDelete,
    onDeleteDeck,
    onSelectDelete,
    onClose,
}: {
    /** 当前块下标（单块路径决定上移/下移禁用态；堆叠路径按 deck 组界判定）。 */
    index: number;
    /** 块总数。 */
    total: number;
    /** 当前块所属堆叠单元（null = 单块路径）：整组移动/批量删除/指定删除行
     *  的开关与组界禁用态依据（size = 组内块数）。 */
    deck: { firstIndex: number; lastIndex: number; size: number } | null;
    onMove(direction: -1 | 1): void;
    onDelete(): void;
    onDeleteDeck(): void;
    onSelectDelete(): void;
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

    // 堆叠路径禁用态按**组界**判定（整组同进退：组首块之上无块才能上移、
    // 组尾块之下无块才能下移）；单块路径按锚块下标（原口径）
    const canUp = deck ? deck.firstIndex > 0 : index > 0;
    const canDown = deck ? deck.lastIndex < total - 1 : index < total - 1;
    const rows: Array<{
        key: string;
        icon: React.ReactNode;
        label: string;
        danger?: boolean;
        disabled: boolean;
        onPress(): void;
    }> = [
        // 行名统一四字 + hint 退役（2026-11-19 与 journal-edit 块操作卡同口径）
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
            // 勾选走「指定删除」——三条删除路径语义互斥不打架；journal-edit
            // 同字面量）
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
                {/* 容器收紧（v0.4.6）：max-w-sm p-3 口径不动，卡身加悬浮投影
                    ——scrim 之下的真悬浮物才有影（taste 房规同款豁免） */}
                <Pressable
                    className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base"
                    style={PAPER_FLOAT_SHADOW}
                >
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮；堆叠锚块标明
                        「这一堆」（操作语义 = 整组），单块保持「这一块」 */}
                    <View className="flex-row items-center justify-between pl-4 pr-1.5 pt-0.5">
                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                            {deck ? `调整这一堆（${deck.size} 张）` : '调整这一块'}
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右侧贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    {/* 单容器行组（2026-11-19 与 journal-edit BlockActionCard 统一：
                        rounded-card surface 单容器包裹，行 h-12 px-4 贴靠零线条，
                        裸图标 + 题单行，行级 active:bg 高亮替代旧「每行一个小卡」
                        ；同步锚点：journal-edit-screen BlockActionCard 同字面量，
                        改任一侧行结构/行距必须同改）。onPress 恒挂接 + disabled
                        显式传导（#3 条件置空显式化）：row.disabled 随移动操作
                        翻转，条件置空会在翻转瞬间重配置 Pressability 吞首点 */}
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
                                    className={`flex-1 text-[16px] font-medium ${
                                        row.danger
                                            ? 'text-ink-negative dark:text-inkd-negative'
                                            : 'text-ink-text dark:text-inkd-text'
                                    }`}
                                >
                                    {row.label}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}

