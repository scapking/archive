import { AppState, Platform } from 'react-native';
import { create } from 'zustand';
import { crypto } from '@/core/crypto';
import {
    fileStorage,
    readUriBytes,
    type PutProgress,
    type PutProgressListener,
} from '@/core/file-storage';
import { imageManipulator } from '@/core/image-manipulator';
import { videoThumbnails } from '@/core/video-thumbnails';
// 行程项通知（v9）：权限/渠道走 core/notifications 门面收口；调度/取消直连
// expo-notifications——门面 schedule 只收 (content, trigger)，不支持 identifier
// 形参，而行程项约定用确定性 identifier（trip-item-<itemId>，取消/重排无需持久
// 登记表）。core/notifications 本轮不在改动权限内，capability 未覆盖面直连与
// camera-overlay 直连 CameraView 同款先例（门面为主、参数级补充为辅）。
import * as ExpoNotifications from 'expo-notifications';
import { notifications, type NotificationContentInput } from '@/core/notifications';
// 时刻换算单一事实源（v0.4.4 起收口在 trip-item-logic 纯函数模块，node 测试
// 直接覆盖）；本模块重导出保持既有消费面（trip-day-screen 等）不变。
import {
    TRIP_ITEM_PHASE_LABEL,
    tripItemDueAt,
    tripItemPhaseMap,
} from './trip-item-logic';
// 系统闹钟门面（v0.4.4 用户指令 #9）：Android 真闹钟 / iOS·web unsupported
// 自动 no-op——best-effort 增强，失败仅 warn 不阻塞数据面
import { alarm, type FiredAlarmEntry } from '@/core/alarm';
// 桌面 widget 门面（v0.4.4 用户指令 #7）：快照推送 best-effort，iOS/web no-op
import { widget } from '@/core/widget';
// v0.4.7 D 接线：widget 快照编排收口进纯函数（status/dueAt/跨日时间格式），
// 闹钟深链路径由 alarm-ladder 单源提供（三端一律路径参数，勿 query）。
import { buildWidgetSnapshot } from './widget-snapshot';
import {
    alarmCardContent,
    alarmMonitorNotificationText,
    alarmRoutePath,
    deriveAlarmMonitorSummary,
} from './alarm-ladder';

export { tripItemDueAt };
import * as db from './db';
import { PENDING_MEDIA_ID, TRIP_OPEN_ENDED } from './db';
import type {
    EventMediaKind,
    EventRow,
    EventStatus,
    EventSubjectKind,
    JournalBlock,
    JournalMediaKind,
    TripItemRow,
    TripItemStatus,
    TripMediaKind,
    TripRow,
} from './db';
import {
    addDaysLocal,
    decorateTrip,
    isTripLocked,
    isValidLocalDate,
    pickDeckTrip,
    todayLocal,
    tripDisplayTitle,
    type Trip,
} from './trip-logic';
import {
    curveSeries,
    isEditable,
    JOURNAL_TITLE_MAX,
    newBlockId,
    newParagraphBlock,
    normalizeJournalTitle,
    PLAN_DESCRIPTION_MAX,
    parseBlocks,
    serializeBlocks,
    streakFromDates,
    wordCount,
    type JournalRow,
} from './journal-logic';
// 事件纯逻辑（v6）：校验/归一化/装饰统一走纯函数模块，store 只做编排
import {
    EVENT_DESCRIPTION_MAX,
    EVENT_EMAIL_MAX,
    EVENT_HANDLED_BY_MAX,
    EVENT_PHONE_MAX,
    EVENT_TITLE_MAX,
    decorateEvent,
    isEventStatus,
    isEventSubjectKind,
    isValidGpsAccuracy,
    isValidGpsCoordinate,
    newEventBlocksJson,
    normalizeEventEmail,
    normalizeEventSubject,
    normalizeEventText,
    validateEventInput,
    type Event,
} from './event-logic';
// 计划纯逻辑（v11）：状态枚举守卫与门槛文案单一事实源（node 测试直接覆盖）
import {
    isPlanStatus,
    PLAN_TITLE_REQUIRED_ERROR,
    type PlanStatus,
} from './plan-logic';
// v5 require cycle 修复：store 不再从 './ui' 取任何符号（PENDING_MEDIA_ID 已下沉 db）。
// mutation 的数据变化广播经中立层发出，ui 侧用 useDataRevision 订阅、不回头 import store
// （依赖图见 data-revision.ts 头注）。
import { notifyDataRevision } from './data-revision';

/**
 * archive 域会话状态（glossary §2：state 归 feature 内 zustand store）。
 * 数据真身在 archive.db；store 只做加载/变更编排 + 响应式通知。
 * mutation 后统一 bump revision——行程详情等自持状态的界面据此重载。
 */

/** 图片长边上限：时间线缩略图与落盘体积的平衡点（超出才缩，不放大）。 */
const IMAGE_MAX_WIDTH = 2048;

/* ------------------------------------------------------------------ */
/* 媒体上传进度注册表（2026-11-08 落盘异步化配套）                        */
/* ------------------------------------------------------------------ */

/**
 * 进度回调节流帧间隔（ms）：file-storage 的原始进度拍（web 每写入块一拍）
 * 直驱 setState 会形成重渲风暴，统一收敛到 100ms 一帧（终值拍不节流——
 * 占位块收口/横幅消失不延迟）。
 */
const PROGRESS_EMIT_INTERVAL_MS = 100;

/**
 * 附件落盘选项（attach 系列共用）：进度注册键 + 原始监听 + 直迁语义。
 */
export interface AttachMediaOptions {
    /**
     * 进度注册键（store.mediaUploadProgress 的 key）：编辑器 pending 占位
     * 场景传占位块 id（占位卡按 key 查百分比）；全局录制会话落库场景传
     * `capture:<seq>` 前缀任务 id（会话保存横幅按前缀聚合）。缺省 = 不进
     * 注册表（行程侧等无进度消费面的调用方）。
     */
    taskId?: string;
    /**
     * 仅 video 生效：true = moveFromUri（录像/录音 cache 产物直迁，原件移走
     * 零残留）；false/undefined = copyFromUri（相册/外部产物，不动原件）。
     */
    moveSource?: boolean;
    /**
     * 原始进度监听（**未节流**的原始拍，file-storage 每写入块一拍）：录制会话
     * 护栏的活跃度跟踪消费（「N 秒无进度增量」判定——任意拍点即活跃），不直接
     * 驱动 UI；UI 消费面走 mediaUploadProgress 注册表（已节流）。
     */
    onProgress?: PutProgressListener;
}

/**
 * 进度汇（file-storage 原始拍 → 节流 → store 注册表 + 原始监听转发）：
 * taskId 缺省且无监听时返回 undefined（零开销，fileStorage 侧不挂回调）。
 */
function makeProgressSink(
    taskId: string | undefined,
    listener: PutProgressListener | undefined,
): PutProgressListener | undefined {
    if (taskId == null && listener == null) return undefined;
    let lastEmitAt = 0;
    return (progress: PutProgress) => {
        listener?.(progress);
        if (taskId == null) return;
        const fraction =
            progress.totalBytes != null && progress.totalBytes > 0
                ? Math.min(1, progress.bytesWritten / progress.totalBytes)
                : null;
        if (fraction == null) return; // 未知总量不进注册表（UI 按「无百分比」降级）
        const isFinal = fraction >= 1;
        const now = Date.now();
        // 首拍（lastEmitAt 0）与终值拍不节流：占位块快速出现百分比、收口不延迟
        if (!isFinal && lastEmitAt !== 0 && now - lastEmitAt < PROGRESS_EMIT_INTERVAL_MS) return;
        lastEmitAt = now;
        useArchiveStore.setState((state) =>
            state.mediaUploadProgress[taskId] === fraction
                ? state
                : {
                      mediaUploadProgress: { ...state.mediaUploadProgress, [taskId]: fraction },
                  },
        );
    };
}

/** 任务收敛后摘除进度注册键（成功/失败同口径，占位块随之收口）。 */
function clearUploadProgress(taskId: string | undefined): void {
    if (taskId == null) return;
    useArchiveStore.setState((state) => {
        if (state.mediaUploadProgress[taskId] === undefined) return state;
        const next = { ...state.mediaUploadProgress };
        delete next[taskId];
        return { mediaUploadProgress: next };
    });
}

/**
 * 会话保存进度聚合（纯函数）：取指定前缀任务的平均进度（0..1）。多任务并行
 * 时平均比取 max 诚实（一卡 90% 一卡 10% 时 max 会提前报满）；无活跃任务
 * 返回 null（横幅/百分比位随之消失）。
 */
export function aggregateSaveProgress(
    progress: Record<string, number>,
    keyPrefix: string,
): number | null {
    let sum = 0;
    let count = 0;
    for (const [key, fraction] of Object.entries(progress)) {
        if (!key.startsWith(keyPrefix)) continue;
        sum += fraction;
        count += 1;
    }
    return count === 0 ? null : sum / count;
}

export interface TripCard extends Trip {
    journalDays: number;
    plansTotal: number;
    plansDone: number;
}

/**
 * me 页指标（loadAll 一次性算出）：
 * - streak / journalDays 同一记录日集合口径（db.activityDates：用户内容活动日
 *   并集——有内容日记（日常+行程同表）∪ 事件创建/更新日 ∪ 行程创建/更新日 ∪
 *   媒体上传日，排除打开即自动建行的空页）；
 * - totalWords / curve 仍为日记字数口径（事件行程无字数，曲线不动）；
 * - eventCounts / noteCounts（2026-11-20 用户指令新增；v11 计划改三态计数）：
 *   事件三态计数（open = 进行中 / done = 完成 / failed = 失败）与计划三态计数
 *   （open = 进行 / closed = 完成 / failed = 失败，对齐事件行尾口径——原
 *   noteCount 库存总数改 GROUP BY 三档，Me 行尾「进行 N · 完成 N · 失败 N」），
 *   Me 内容卡行尾用；历史行程数不从 db 另取——store.trips 已有全量行程卡，
 *   UI 按 status === 'finished' 派生（与进行中行程同款派生口径）。
 */
export interface MeMetrics {
    streak: number;
    journalDays: number;
    totalWords: number;
    eventCounts: { open: number; done: number; failed: number };
    noteCounts: { open: number; closed: number; failed: number };
    curve: Array<{ date: string; value: number }>;
}

/** 载入后的 deck 数据：当前日记（今天，可能还没有）+ 选中的行程卡。 */
export interface DeckData {
    todayJournal: JournalRow | null;
    deckTrip: TripCard | null;
}

interface ArchiveStore {
    ready: boolean;
    /** 最近一次数据操作失败的文案（界面在标题行下方展示；读操作失败可重试） */
    error: string | null;
    revision: number;
    /** 日记防抖落库进行中（保存状态指示器用） */
    savingJournal: boolean;
    trips: TripCard[];
    metrics: MeMetrics;
    /**
     * 媒体落盘进度注册表（2026-11-08 落盘异步化配套，只读订阅面）：key =
     * AttachMediaOptions.taskId（编辑器 pending 占位块 id / capture:<seq> 会话
     * 落库任务 id），value = 0..1。任务收敛（成功/失败）即摘除；写入口仅在
     * store 内部（makeProgressSink 节流 100ms），UI 按 key 查询 + 前缀聚合
     * （aggregateSaveProgress）。
     */
    mediaUploadProgress: Record<string, number>;

    loadAll(): Promise<void>;
    /** 路由壳取单条行程（编辑入口预检；只读，不 bump revision）。 */
    resolveTrip(id: string): Promise<TripRow | null>;
    /** deck 数据由屏层派生：trips + 今天日记（loadAll 后即可取）。 */
    deck(): DeckData;
    /** 建行程：endDate = null 表示持续性行程（不设固定结束，DEV.md #4）。 */
    createTrip(input: { title: string; startDate: string; endDate: string | null; description: string; icon: string | null }): Promise<Trip | null>;
    /** endDate 传 null 把行程改为持续性；传日期则固定结束。 */
    updateTrip(id: string, patch: { title?: string; startDate?: string; endDate?: string | null; description?: string; icon?: string | null; videoKey?: string | null }): Promise<boolean>;
    /** 删行程：行级级联（日记/媒体/计划）+ 文件清理（DEV.md #1.1，不留孤儿引用）。 */
    deleteTrip(id: string): Promise<boolean>;
    /** 行程封面视频：落 file-storage，回写 video_key。 */
    attachTripVideo(tripId: string, uri: string): Promise<boolean>;
    /**
     * 行程内媒体（v4，DEV.md #4）：直接落盘+落库（无块模型，不需要日记媒体那套
     * pending 占位链路——两者取简者），返回 mediaId 供卡片引用；行程已结束则拒绝（#7）。
     * opts 为 2026-11-08 落盘异步化配套（进度注册键 / 直迁语义 / 原始进度监听）；
     * itemId（v9）传入时媒体行落 item_id（行程项图片/视频归属，仅 attachTripItemMedia
     * 使用）。
     */
    attachTripMedia(
        tripId: string,
        kind: TripMediaKind,
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number | null,
        opts?: AttachMediaOptions,
        itemId?: string,
    ): Promise<string | null>;
    /**
     * 删单条行程媒体（行程媒体卡长按删除入口）：行软删 + 文件尽力清理
     * （对齐 deleteTrip 口径：失败聚合上浮 error，不阻塞行删除）；已结束行程
     * 拒绝（#7 锁定语义，UI 侧入口先挡，这里是兜底）。true = 删除成功。
     */
    removeTripMedia(mediaId: string): Promise<boolean>;
    /**
     * 日卡背景（v5，行程逐日卡）：图片走行程媒体上传流落为 trip_media 行，
     * 指针落 trip_day_meta（主键 = (trip_id, local_date)，一天至多一张）。
     * 换图 = 新行落库 → 指针切换 → 旧行软删 + 文件尽力清理（「删除媒体」口径）。
     * 已结束行程拒绝（#7；UI 侧长按入口先挡，这里兜底）。true = 成功。
     */
    setTripDayBackground(
        tripId: string,
        date: string,
        uri: string,
        width: number | null,
        height: number | null,
    ): Promise<boolean>;
    // ─── 行程项（v9：trip_items，行程表页）────────────────────────────────────
    // 刷新口径：行程项不进 loadAll 的 store 状态（trips/metrics 与行程项无关），
    // mutation 成功只 bump revision——行程表页由屏层按 useArchiveRevision 局部
    // 重载（对齐事件/计划的取径）。
    /**
     * 创建行程项（行程表页 + 表单卡）：v0.5.1 令 1 起 title 可空（trim 后空串
     * 直接入库，快速路径无标题输入框；展示层 tripItemDisplayTitle 空标题不渲染
     * 任何文字）；time 须合法 'HH:mm'、date 须合法本地日期（错误进 error 通道
     * 返回 null，不 throw）。成功落库 +
     * 调度本地通知（确定性 identifier trip-item-<itemId>；权限被拒静默降级，
     * 不阻塞创建）+ withAlarm 时注册系统闹钟（core/alarm 门面，Android 真闹钟
     * /iOS·web unsupported 自动 no-op）+ bump revision。
     */
    createTripItem(input: { tripId: string; date: string; time: string; title: string; description?: string; withAlarm?: boolean }): Promise<TripItemRow | null>;
    /**
     * 进入收尾（v0.4.4 状态机，用户指令 #8）：done 阶段（自动完成已过、尚未
     * 收尾）时把 completed_at 落库 → wrap 阶段（补图补视频窗口）。时间闸 =
     * 时刻未到拒绝；已收尾幂等成功。true = 成功。
     */
    startTripItemWrap(id: string): Promise<boolean>;
    /**
     * 结束收尾：wrap 阶段把 wrap_closed_at 落库 = terminal 终态（只读）。
     * 未收尾直接结束也放行（completed_at 同拍兜底——用户在 done 卡直接点
     * 「结束收尾」的防御路径）。true = 成功。
     */
    closeTripItemWrap(id: string): Promise<boolean>;
    /**
     * 行程项内容编辑（v0.5.2 令7：卡面笔记位/「进入编辑」）：title /
     * description 给了才动（空串 = 清空，合法——空标题只报时刻是既有口径）。
     * 已过点项同样可编辑（「编辑没有关闭时间」）。内容变了就把闹钟/通知文案
     * 重挂一次（未到点且 pending 才重排，已过点不动调度）。true = 成功。
     */
    updateTripItemContent(id: string, patch: { title?: string; description?: string }): Promise<boolean>;
    /**
     * 删除行程项：软删 + 摘 item_id 媒体关联（媒体行保留，记录留档）+ 取消通知。
     * true = 成功。
     */
    deleteTripItem(id: string): Promise<boolean>;
    /**
     * 行程项媒体（图片/视频挂 trip_media 既有链路，item_id 关联到行程项）：
     * 复用 attachTripMedia 上传管线（落盘 key 同规则 trip-media/<tripId>/…），
     * 行程锁定（#7）与存在性预检在内部完成，返回 mediaId。
     */
    attachTripItemMedia(
        tripItemId: string,
        kind: TripMediaKind,
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number | null,
    ): Promise<string | null>;
    /** 行程搜索（DEV.md #5）：标题+描述 LIKE，range 为行程区间与 [from, to] 相交。 */
    searchTrips(keyword: string, range?: { from?: string; to?: string }): Promise<TripCard[]>;
    /** 计划搜索（DEV.md #5 扩展）：正文/标题 LIKE + local_date ∈ [from, to]。
     *  v8 起独立计划同样被搜到（不筛 kind，期望行为）。 */
    searchJournals(keyword: string, range?: { from?: string; to?: string }): Promise<JournalRow[]>;
    // ─── 独立计划（v8：journals.kind = 'note'，复用日记容器管线）──────────────
    // 刷新口径与 events 相同：计划不进 loadAll 的 store 状态（trips/metrics 与
    // 计划无关），mutation 成功只 bump revision——计划列表由屏层按
    // useDataRevision 局部重载（读取走 db.listPlans）。
    // 复用既有 mutation，无需为计划新增对应入口：正文保存走 saveJournalBlocks
    // （块模型/占位过滤/媒体引用对账全量同构）、插图/录音走 attachJournalMedia、
    // 删除走 deleteJournal（级联媒体行 + 文件清理，计划无行程级联分支）、标题
    // 走 updateJournalTitle（进行中天然放行；v11 终态计划与收笔日记同被
    // isEditable 闸挡下——只读口径一致）。

    /**
     * 新建独立计划（显式建页动作，像建行程/事件一样走分步向导；同日可建任意
     * 多篇）：v0.4.5 起**标题必填**（对齐 createEvent 的 validateEventInput
     * 口径，文案 PLAN_TITLE_REQUIRED_ERROR），描述选填。校验先行（错误进
     * error 通道返回 null）：title trim 后非空、≤ JOURNAL_TITLE_MAX；
     * description trim 后 ≤ PLAN_DESCRIPTION_MAX，超长整体拒绝不走截断。
     * 成功返回新行（status 'open' = 进行中，deleted_at = null）并 bump
     * revision（不 loadAll）。
     */
    createPlan(input: { title: string; description: string }): Promise<JournalRow | null>;

    /**
     * 独立计划元信息更新（标题/描述/状态，均可选）：title null = 清除；字符串经
     * normalizeJournalTitle（空串归一为 null = 未命名，超长钳制——对齐
     * updateJournalTitle 口径）；description trim 后超 PLAN_DESCRIPTION_MAX
     * 整体拒绝（与创建同口径），空串合法。status（v11）仅接受计划三态
     * open/closed/failed（isPlanStatus 守卫，非法值整体拒绝——updateEventMeta
     * 同款），终态由 db 层同批落 completed_at。仅接受 kind = 'note' 的行
     * （日记的标题清除语义走 updateJournalTitle，日记无 description/failed，
     * 防误写）。true = 成功（bump revision，不 loadAll）。
     */
    updatePlanMeta(
        id: string,
        patch: { title?: string | null; description?: string; status?: PlanStatus },
    ): Promise<boolean>;
    /**
     * 建事件（v6，类似工单）：标题必填，其余可选；正文 blocks 以单空文本段初始化；
     * 状态恒从 'open' 起。GPS 注入不在 store（UI 层经 core/location 取好后传参）。
     * 返回新行（deleted_at = null）；失败走 error 通道返回 null（不 throw）。
     */
    createEvent(input: {
        title: string;
        gps?: { lat: number; lng: number; accuracy?: number } | null;
        handledBy?: string;
        subjectKind?: EventSubjectKind;
        subjectValue?: string;
        /** 手机号（v7，可选独立联系方式；自由文本，不做格式校验）。 */
        phone?: string;
        /** 邮箱（v7，可选；值内明显空白由 normalizeEventEmail 剥除）。 */
        email?: string;
        description?: string;
    }): Promise<EventRow | null>;
    /**
     * 事件正文保存（复用 saveJournalBlocks 语义）：pending 占位过滤 + 落库 +
     * event_media 引用对账（未被持久化 blocks 引用且对账基准时刻前的媒体行软删
     * + 文件尽力清理）。true = 成功；false = 失败（error 通道照旧上浮）。
     * 注：事件表无 word_count 冗余列，字数派生走 event-logic 纯函数按需计算。
     */
    updateEventBlocks(eventId: string, blocks: JournalBlock[]): Promise<boolean>;
    /**
     * 事件元信息更新（title/status/handledBy/subject 对/description/gps，均可选）：
     * - title（设置卡改名）：trim 后必填非空、上限 EVENT_TITLE_MAX（与创建同源
     *   口径，空串/超长整体拒绝不走截断）；
     * - subject 为原子对：kind/value 任一侧出现在 patch 即合并当前行后整体归一化
     *   （显式 null = 清除该侧；归一化后任一侧缺失 → 双双置空）；
     * - gps：undefined = 不动；null = 清除；对象 = 覆盖写（非法坐标整体拒绝）；
     * - status 仅接受 'open' | 'done'。true = 成功。
     */
    updateEventMeta(
        eventId: string,
        patch: {
            title?: string;
            status?: EventStatus;
            handledBy?: string | null;
            subjectKind?: EventSubjectKind | null;
            subjectValue?: string | null;
            /** 手机号（v7，可空 = 清除；自由文本，不做格式校验）。 */
            phone?: string | null;
            /** 邮箱（v7，可空 = 清除；值内明显空白由 normalizeEventEmail 剥除）。 */
            email?: string | null;
            description?: string | null;
            gps?: { lat: number; lng: number; accuracy?: number } | null;
        },
    ): Promise<boolean>;
    /**
     * 事件媒体（v6）：对齐 attachJournalMedia——落盘分流（视频 copy/move 直迁、
     * 图片 manipulator 字节路径、音频字节落盘+容器嗅探）+ 落库，返回 mediaId 供
     * blocks 引用；缩略图增强可选不做（v6 取舍）。落盘 key：
     * event-media/<eventId>/<mediaId>.<ext>。
     * v6.1 录制归属泛化补齐 opts（AttachMediaOptions，对齐 attachJournalMedia）：
     * taskId 进进度注册表（事件编辑屏占位卡 / 录制会话 `capture:<seq>` 横幅）、
     * moveSource = 录像/录音 cache 产物直迁、onProgress 供会话护栏活跃度跟踪。
     */
    attachEventMedia(
        eventId: string,
        kind: EventMediaKind,
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number | null,
        opts?: AttachMediaOptions,
    ): Promise<string | null>;
    /**
     * 删单条事件媒体：行软删 + **DB 级 blocks 引用摘除**（事件正文块引用媒体，
     * 直接删行会留死引用——参照 appendMediaBlockToJournal 的 DB 权威改写）+
     * 文件尽力清理。true = 删除成功。
     */
    removeEventMedia(mediaId: string): Promise<boolean>;
    /** 删事件（v6）：行级级联（事件 + 媒体行软删）+ 文件清理（不留孤儿引用）。 */
    deleteEvent(id: string): Promise<boolean>;
    /**
     * 事件搜索（v6，v7 扩充为六通道）：关键词 LIKE（title/description/
     * subject_value/handled_by/phone/email——联系方式可被搜索）+ 状态筛选，
     * updated_at DESC。空 keyword 且无 status 返回空
     * （不做无界全量；全量列表走 db.listEvents）。返回装饰后的 Event[]。
     */
    searchEvents(keyword: string, filter?: { status?: EventStatus }): Promise<Event[]>;
    ensureTodayJournal(): Promise<JournalRow | null>;
    ensureJournal(tripId: string | null, date: string): Promise<JournalRow | null>;
    /**
     * 编辑器防抖保存入口（blocks 已在内存，这里只落库）。
     * 落库后做媒体引用对账（DEV.md #1.1 数据面闭环）：未被持久化 blocks 引用的
     * journal_media 行软删 + 文件尽力清理（失败聚合上浮 error，不改变返回值）。
     * true = 成功；false = 失败（error 状态照旧上浮，不 throw）——调用方据 false 置回 dirty。
     */
    saveJournalBlocks(journalId: string, blocks: JournalBlock[]): Promise<boolean>;
    completeJournal(journalId: string): Promise<void>;
    /** 重开当天的收笔页（仅当天；历史页不可重开）。 */
    reopenJournal(journalId: string): Promise<void>;
    /** 计划标题（v4，DEV.md #6）：空串 = 清除；非 open 不可改（#7 只读语义——
     *  日记 = closed 收笔，计划 = closed/failed 终态，v11 同闸）。 */
    updateJournalTitle(journalId: string, title: string): Promise<boolean>;
    /** 删单篇日记：级联删其媒体行 + 文件（同 deleteTrip 的不留孤儿口径）。 */
    deleteJournal(journalId: string): Promise<boolean>;
    /** 编辑器插图/视频：落 file-storage + 建媒体行，返回 mediaId 供块引用。
     *  opts.taskId 传入时进度进 mediaUploadProgress 注册表（占位卡百分比）；
     *  视频默认 copyFromUri 直迁，moveSource = true 时录像产物走 move。 */
    attachJournalMedia(
        journalId: string,
        kind: JournalMediaKind,
        uri: string,
        width: number | null,
        height: number | null,
        opts?: AttachMediaOptions,
    ): Promise<string | null>;
    /**
     * 【归属铁律】DB 级媒体块追加（全局录制会话停录产物落库专用，见
     * recording-session.tsx）：绕过任何未挂载/在栈下的编辑屏本地态，读该
     * journal 当前 blocks（DB 权威值）→ 尾部追加真实媒体块（复用既有
     * parse/serialize 语义）→ 立即落库 + revision bump。幂等：mediaId 已被
     * 引用时直接成功（owner 屏在 DB 写入前经 persist 事件合并进本地态并抢先
     * 保存的场景，不产生重复块）。已收笔（closed）/ 已删除的计划拒绝（#7
     * 只读语义 + 归属目标失效兜底）。true = 追加成功（含幂等命中）。
     */
    appendMediaBlockToJournal(journalId: string, media: { mediaId: string; kind: JournalMediaKind; durationMs?: number }): Promise<boolean>;
    /**
     * 【归属铁律·事件侧】DB 级媒体块追加（全局录制会话停录产物落库专用，见
     * recording-session.tsx；对齐 appendMediaBlockToJournal）：绕过任何未挂载/
     * 在栈下的编辑屏本地态，读该事件当前 blocks（DB 权威值）→ 尾部追加真实
     * 媒体块（复用既有 parse/serialize 语义）→ 立即落库 + revision bump。幂等：
     * mediaId 已被引用时直接成功（owner 屏在 DB 写入前经 persist 事件合并进
     * 本地态并抢先保存的场景，不产生重复块）。目标事件不存在/已删除拒绝（归属
     * 目标失效兜底；事件无收笔锁定语义，open/done 均可增补）。true = 追加成功
     * （含幂等命中）。
     */
    appendMediaBlockToEvent(eventId: string, media: { mediaId: string; kind: JournalMediaKind; durationMs?: number }): Promise<boolean>;
}

function toMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

/**
 * 图片落盘前的统一准备：经 manipulator 缩边（超出 IMAGE_MAX_WIDTH 才缩），
 * 返回产物字节（已在 JS，直接 fileStorage.put——图片体量 ≤ 数 MB，字节路径
 * 不构成卡顿面）。视频/音频不再经此函数：视频走 fileStorage 直迁（大文件
 * 字节路径退役），音频在 attach 内联读字节做容器嗅探（体量小）。
 */
async function prepareImageBytes(
    uri: string,
    width: number | null,
): Promise<{ bytes: Uint8Array; width: number | null; height: number | null }> {
    const actions = width && width > IMAGE_MAX_WIDTH ? [{ resize: { width: IMAGE_MAX_WIDTH } }] : [];
    const manipulated = await imageManipulator.manipulateAsync(uri, actions);
    return { bytes: manipulated.bytes, width: manipulated.width, height: manipulated.height };
}

/** 媒体文件的存储扩展名（audio 由 audioExtFromBytes 按容器嗅探，不经此函数）。 */
function mediaFileExt(kind: JournalMediaKind | TripMediaKind): string {
    return kind === 'video' ? 'mp4' : kind === 'audio' ? 'm4a' : 'jpg';
}

/**
 * 音频落盘扩展名按字节头核对容器（入库段容器一致性，防「webm 字节背 .m4a
 * 名字」的数据完整性坑）：native（Android/iOS）HIGH_QUALITY 预设录出
 * .m4a（mp4 容器，偏移 4 起为 'ftyp'）；web 的 MediaRecorder 走 audio/webm
 * （EBML 容器，字节头 1A 45 DF A3）。无法识别时保守回 m4a（native 主路径）。
 */
function audioExtFromBytes(bytes: Uint8Array): 'm4a' | 'webm' {
    const isWebm =
        bytes.length > 4 &&
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3;
    return isWebm ? 'webm' : 'm4a';
}

/* ------------------------------------------------------------------ */
/* 视频缩略图（deck 露边层真封面，2026-11-08）                           */
/* ------------------------------------------------------------------ */

/**
 * 缩略图 key 约定：媒体 key 直接追加 `.thumb.jpg` 后缀（选型：不用独立
 * thumbs/ 前缀——同前缀 = 删除级联/GC/列表 prefix 查询零改动地随媒体走，
 * 报告已注明取舍）。段内字符集 [a-zA-Z0-9._-] 合法（validateKey 通过）。
 */
export function videoThumbKeyFor(fileKey: string): string {
    return `${fileKey}.thumb.jpg`;
}

/** 缩略图宽上限（px）：deck 卡 420dp 高 + 相纸位形，512px 在 2x 屏足够；
 *  控制落盘体积（每视频 ~30-80KB）。超出才缩（expo-video-thumbnails 无
 *  resize 参数，缩边经 image-manipulator，超出才缩不放大）。 */
const VIDEO_THUMB_MAX_WIDTH = 512;

/**
 * 缩略图单飞注册表（fileKey → 在途任务）：并发调用（attach 生成 + 屏进入
 * 惰性生成撞车）共享同一 promise，不重复解码。
 */
const videoThumbTasks = new Map<string, Promise<boolean>>();

/**
 * 已验证存在的缩略图（本 JS 会话内存缓存）：媒体行的 revision 重载会反复
 * 触发惰性回填入口，存在性已确认的 fileKey 直接短路——免去每次 revision
 * 变化对每视频的 exists 查询（native = stat + db 查询）。会话级缓存： Thumb
 * 被外部删除（GC/换设备迁移）的场景下次冷启自愈。
 */
const verifiedThumbKeys = new Set<string>();

/**
 * 生成并缓存某媒体文件的缩略图（幂等：已存在直接命中）。
 *
 * **增强语义（任务口径）**：任何失败（web 无实现/解码失败/IO 失败）只
 * resolve false——不进 error、不抛出、绝不阻塞媒体入库（调用方是增强侧，
 * 落库主链已在此之前完成）；消费方（editor 的 DeckVideoBackCard）按
 * useFileUrlState(thumbKey) 三态回退占位卡。生成成功 bump revision：deck/
 * 媒体列表的 useFileUrlState(thumbKey) 订阅在 revision 漂移时复验拿到图。
 * 存量旧视频的回填：journal-edit-screen 载入媒体行后对本篇全部视频逐个
 * 调用（惰性生成，首篇打开一次性补齐，之后命中缓存零成本）。
 */
export function ensureVideoThumbnail(fileKey: string): Promise<boolean> {
    const inFlight = videoThumbTasks.get(fileKey);
    if (inFlight) return inFlight;
    const task = (async (): Promise<boolean> => {
        const thumbKey = videoThumbKeyFor(fileKey);
        try {
            if (verifiedThumbKeys.has(fileKey)) return true;
            if (await fileStorage.exists(thumbKey)) {
                verifiedThumbKeys.add(fileKey);
                return true;
            }
            if (!videoThumbnails.isSupported()) return false;
            const sourceUri = await fileStorage.url(fileKey);
            const frame = await videoThumbnails.generateAsync(sourceUri);
            const actions =
                frame.width > VIDEO_THUMB_MAX_WIDTH
                    ? [{ resize: { width: VIDEO_THUMB_MAX_WIDTH } }]
                    : [];
            const prepared = await imageManipulator.manipulateAsync(frame.uri, actions);
            await fileStorage.put(thumbKey, prepared.bytes);
            verifiedThumbKeys.add(fileKey);
            // revision bump 是「图已可用」的广播：deck 露边层/媒体列表据此
            // 复验 thumbKey 并切真封面（不 reloadAll——缩略图不影响任何行）
            useArchiveStore.setState((state) => ({ revision: state.revision + 1 }));
            return true;
        } catch (error) {
            // 增强失败文档化降级（error-handling R3 ②）：占位卡回退可自愈
            // （下次进入重试），console.warn 留痕不静默
            console.warn(`[archive-thumb] 缩略图生成失败（回退占位卡）: ${fileKey}`, error);
            return false;
        } finally {
            videoThumbTasks.delete(fileKey);
        }
    })();
    videoThumbTasks.set(fileKey, task);
    return task;
}

/**
 * 尽力而为的文件清理：单个失败不阻塞其余（DEV.md #1.1「文件删除失败不阻塞行删除」），
 * 返回失败清单交调用方聚合上报——行已删，引用不会复活，失败只影响存储回收。
 * 缩略图与媒体同生命周期：删媒体连带删 `${key}.thumb.jpg`（无缩略图时 remove
 * 幂等 no-op），所有删除路径（删行程/删日记/删单媒体/孤儿对账）经此单点收口。
 */
async function removeFilesBestEffort(keys: string[]): Promise<{ key: string; message: string }[]> {
    const failures: { key: string; message: string }[] = [];
    await Promise.all(
        keys.flatMap((key) => [key, videoThumbKeyFor(key)]).map(async (target) => {
            try {
                await fileStorage.remove(target);
            } catch (error) {
                failures.push({ key: target, message: toMessage(error) });
            }
        }),
    );
    return failures;
}

/* ------------------------------------------------------------------ */
/* 行程项本地通知（v9，行程表页）                                        */
/* ------------------------------------------------------------------ */

/**
 * 行程项通知的确定性 identifier 约定：`trip-item-<itemId>`。
 * 取消/重排按同一 identifier 先 cancel 再 schedule——无需持久登记表
 * （expo 侧调度表按 identifier 收口，JS 上下文重启后依然可寻址）。
 */
const TRIP_ITEM_NOTIFICATION_PREFIX = 'trip-item-';

/**
 * Android 通知渠道（expo-notifications：Android 8+ 展示通知必须有渠道；
 * iOS 无渠道概念，createChannel 在门面内按平台短路）。importance HIGH +
 * 渠道默认声音：行程提醒是到点即时动作，不作静默档。
 */
const TRIP_ITEM_NOTIFICATION_CHANNEL = 'trip-items';
/** 渠道已建标记（每 JS 会话一次；渠道创建幂等，标记只为省重复原生调用）。 */
let tripItemChannelEnsured = false;
/** 通知标题 = `${time} ${item.title}`（2026-11-19 系统通知卡片化：时间 +
 * 内容 + 描述三段；subtitle = 所属行程名，正文 = 描述——见调度函数注）。 */
const TRIP_ITEM_NOTIFICATION_TITLE = '行程提醒';

/** 行程项通知 identifier（确定性，约定见上注）。 */
function tripItemNotificationId(itemId: string): string {
    return `${TRIP_ITEM_NOTIFICATION_PREFIX}${itemId}`;
}

/** 'HH:mm' 合法性（24 小时制；创建入口的第一道闸，屏层表单复用同一导出）。 */
export function isValidTripItemTime(time: string): boolean {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
}

/** Android 渠道确保（幂等；非 Android 平台门面内短路，iOS 直接过）。 */
async function ensureTripItemNotificationChannel(): Promise<void> {
    if (tripItemChannelEnsured) return;
    await notifications.createChannel(
        TRIP_ITEM_NOTIFICATION_CHANNEL,
        TRIP_ITEM_NOTIFICATION_TITLE,
        ExpoNotifications.AndroidImportance.HIGH,
    );
    tripItemChannelEnsured = true;
}

/**
 * 调度/重排行程项通知（best-effort，绝不阻塞数据面）：
 * - 权限未授权先请求一次，仍被拒：静默降级 console.warn 留痕，不调度——
 *   通知是提醒增强，不是数据完整性依赖，行程项照常落库（产品口径）；
 * - 触发时刻已过去：跳过（不调度过去的闹钟；页内应用内闹钟兜底前台提醒）；
 * - 重排语义：先按确定性 identifier 取消旧调度（无则幂等成功）再落新调度。
 * 任何失败 console.warn 留痕、不进 error 通道（对齐 ensureVideoThumbnail 的
 * 增强失败文档化降级口径）。
 */
async function scheduleTripItemNotification(
    item: Pick<TripItemRow, 'id' | 'trip_id' | 'local_date' | 'time' | 'title' | 'description'>,
): Promise<void> {
    try {
        let granted = await notifications.getPermission();
        if (!granted) granted = await notifications.requestPermission();
        if (!granted) {
            console.warn(`[archive-trip-item] 通知权限被拒，行程提醒降级为仅应用内（item: ${item.id}）`);
            return;
        }
        const dueAt = tripItemDueAt(item.local_date, item.time);
        if (dueAt <= Date.now()) return;
        await ensureTripItemNotificationChannel();
        // 系统通知卡片化（2026-11-19 用户指令「系统组件显示行程内容：时间和
        // 内容和描述」）：标题 = 时间 + 行程项名，subtitle = 所属行程名，
        // 正文 = 描述（Android shade 卡片 / iOS 横幅按 title+subtitle+body
        // 三段卡片式呈现；iOS 与 Android 展开态即 BigText 卡片形态）。
        const trip = await db.getTrip(item.trip_id).catch(() => null);
        // v0.5.1 令2：通知文案单源 alarmCardContent——空标题只报时刻、禁兜底
        // 词；Android 注册表 title/body 快照与 iOS content 自此同构（A 申报接线）
        const card = alarmCardContent(item);
        const body = card.body;
        await ExpoNotifications.cancelScheduledNotificationAsync(tripItemNotificationId(item.id));
        await ExpoNotifications.scheduleNotificationAsync({
            identifier: tripItemNotificationId(item.id),
            content: {
                title: card.title,
                subtitle: trip ? tripDisplayTitle(trip.title) : undefined,
                body,
                sound: true,
                // iOS 强提醒（用户指令 #9/#11：timeSensitive 档穿透专注模式
                // 摘要；Android 忽略该字段）。平台事实：iOS 无第三方加系统
                // 闹钟 API，timeSensitive 本地通知即「强提醒」的全部可行面
                // （静音键仍可静音，Critical Alerts 需 Apple 特批资质）
                interruptionLevel: 'timeSensitive',
                // v0.4.7 闹钟阶梯接线：通知 data 携带全屏闹钟深链路径，
                // tap/冷启 drainFired 经 expo-router 直达 /alarm/<id>
                data: { path: alarmRoutePath(item.id) },
            } satisfies NotificationContentInput,
            trigger: {
                type: ExpoNotifications.SchedulableTriggerInputTypes.DATE,
                date: new Date(dueAt),
                channelId: TRIP_ITEM_NOTIFICATION_CHANNEL,
            },
        });
    } catch (error) {
        console.warn(`[archive-trip-item] 行程提醒调度失败（不阻塞行程项，item: ${item.id}）:`, error);
    }
}

/**
 * 常驻监控通知刷新（v0.5.2 用户令3「正确应该是创建行程的时候就创建常驻通知，
 * 如果不是这样后台就会冻结没有办法使用」）：
 * - Android：以原生注册表为准（alarm.listScheduled 回读，非 store 状态镜像），
 *   pending =「未到点且有闹钟」非空 → 前台服务挂「N 个行程提醒监控中 ·
 *   最近 HH:mm」静默常驻通知（点击回 app）维持进程存活；空 → 停。触发时机 =
 *   hydration（loadAll 尾部）+ 每次创建/编辑/删除/收尾行程项与删行程（本文件
 *   各 alarm.schedule/cancel 之后链入）——幂等，原生侧同样自判 start/stop，
 *   JS 文案只是呈现镜像（boot/sticky 重入时无 JS 在场由 Kotlin 自算同构文案）。
 * - **平台差异如实**：iOS 无第三方前台服务 API，「常驻」退化为已排期本地通知
 *   在通知中心可见（本就是 iOS 行为，闹钟链不因此减弱）；web 无系统面。
 *   两端经门面 no-op（alarm.isSupported()=false 早退）。
 * - best-effort：链上每一环（listScheduled/syncMonitor）门面内全兜底不抛，
 *   本函数失败不阻塞任何数据面。
 */
export async function refreshAlarmMonitor(scheduled?: FiredAlarmEntry[]): Promise<void> {
    if (!alarm.isSupported()) return;
    const summary = deriveAlarmMonitorSummary(
        scheduled ?? (await alarm.listScheduled()),
        Date.now(),
    );
    const text = summary
        ? alarmMonitorNotificationText(summary)
        : { title: '', body: '' };
    await alarm.syncMonitor(text.title, text.body);
}

// ─── 桌面 widget 快照（v0.4.4 用户指令 #7）───────────────────────────────

/**
 * 快照编排（用户裁决：**自动选最新行程 + 其行程项列表**，不是固定题式工具）：
 * 行程取进行中（planning/ongoing，按 start_date 最新）一趟；行程项取「今天 +
 * 未来」按时间升序最多 4 条，阶段词表随行带出。无进行中行程 = 空快照
 * （widget 显空态文案，不再显示上一趟）。fire-and-forget：失败仅 warn。
 */
async function pushWidgetSnapshot(): Promise<void> {
    if (!widget.isSupported()) return;
    try {
        const trips = await db.listTrips();
        // 选择逻辑与 buildWidgetSnapshot 严格同规则（同数组同比较器，结果
        // 恒等）：这里只为拿「被选中行程」的行程项喂给纯函数编排。
        const active = trips
            .filter((trip) => !isTripLocked(trip))
            .sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
        const items = active ? await db.listTripItemsByTrip(active.id) : [];
        await widget.push(buildWidgetSnapshot(trips, items));    } catch (error) {
        console.warn('[archive-widget] 快照编排失败（不影响数据面）:', error);
    }
}

let widgetRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/** 防抖 1s：同一拍内的多个 mutation（连点/批量）只推一次快照。 */
function queueWidgetRefresh(): void {
    if (!widget.isSupported()) return;
    if (widgetRefreshTimer != null) clearTimeout(widgetRefreshTimer);
    widgetRefreshTimer = setTimeout(() => {
        widgetRefreshTimer = null;
        void pushWidgetSnapshot();
    }, 1000);
}

// 回前台刷新（新一天/相对阶段漂移的兜底；store 模块单例生命周期 == app 会话）
if (Platform.OS === 'android') {
    AppState.addEventListener('change', (state) => {
        if (state === 'active') queueWidgetRefresh();
    });
}

/** 取消行程项通知（幂等 best-effort：identifier 无对应调度视为成功；失败仅告警）。 */
async function cancelTripItemNotification(itemId: string): Promise<void> {
    try {
        await ExpoNotifications.cancelScheduledNotificationAsync(tripItemNotificationId(itemId));
    } catch (error) {
        console.warn(`[archive-trip-item] 行程提醒取消失败（item: ${itemId}）:`, error);
    }
}

// ─── 启动孤儿文件 GC（上传中断恢复）────────────────────────────────────────

/**
 * GC 管辖的媒体 key 前缀：与 store 各上传入口的 key 规则一一对应
 * （journal-media/<journalId>/<mediaId>.<ext>、trip-media/<tripId>/<mediaId>.<ext>、
 * trip-video/<tripId>.mp4、event-media/<eventId>/<mediaId>.<ext>（v6））。
 * GC 只在这些前缀内求差集，其余 key（迁移包、未来扩展等）一律不碰——前缀外
 * 文件即使无引用也绝不误删。
 */
const GC_MEDIA_PREFIXES = ['journal-media/', 'trip-media/', 'trip-video/', 'event-media/'] as const;

/**
 * 宽限期：mtime 距今不足该时长的孤儿候选一律不删。覆盖两类窗口——
 * ① 「落盘完成 → 媒体行落库」间隙被杀的孤儿（GC 的目标本体，但刚发生时若用户
 *    立刻重开 App，sweep 与重试上传可能在同一时段，宽限期避免把重试正要引用的
 *    同 key 文件删掉）；
 * ② sweep 自身「引用集采集 → 文件列表遍历」非原子的间隙里新落盘的在途上传
 *    （其 key 必不在已采集的引用集内，没有宽限期就是确定性误删）。
 * 1h 取舍：图片经 manipulator、视频直落字节，正常上传远小于 1h；被杀孤儿至多
 * 多活一个宽限期 + 距下次冷启的间隔，存储浪费可接受。半文件不校验内容（写入
 * 无 checksum 比对，且部分写入的文件 mtime 一样新鲜，校验也无从区分「在途」
 * 与「损坏」）——内容完整性交给「行引用为唯一事实源」：无行引用的文件本就不可见。
 */
const GC_GRACE_PERIOD_MS = 60 * 60 * 1000;

/**
 * 冷启单飞闸门：整个 JS 会话至多执行一次 sweep。模块级而非 ref——effect 重跑 /
 * Fast Refresh 重挂载会重建 ref，模块变量在本 JS 会话内恒存（同 last-route 的
 * lastRouteRestoreDone 取径）。失败后不重试（下次冷启再说），Promise 不携带
 * rejection（sweep 内部全兜底）。
 */
let startupGcOnce: Promise<void> | null = null;

/**
 * 启动孤儿媒体文件 GC（冷启一次，fire-and-forget）：
 * 引用集采集（db）→ 遍历媒体前缀文件列表 → 差集 - 宽限期 → best-effort 删除。
 * 任何失败（引用集查询/列表遍历/单文件删除）只 console.warn 聚合告警：不抛错、
 * 不进 error 状态、不阻塞启动。GC 是存储回收增强而非正确性依赖——漏删只浪费
 * 存储（下次冷启重扫），误删由「行引用集 + 宽限期」双保险挡住。
 */
export function runStartupOrphanMediaGc(): Promise<void> {
    startupGcOnce ??= sweepOrphanMediaFiles();
    return startupGcOnce;
}

/** sweep 本体：所有异常自吞（调用方 fire-and-forget，无人接 rejection）。 */
async function sweepOrphanMediaFiles(): Promise<void> {
    try {
        const [referencedMediaKeys, ...listings] = await Promise.all([
            db.listReferencedMediaFileKeys(),
            ...GC_MEDIA_PREFIXES.map((prefix) => fileStorage.list(prefix)),
        ]);
        // 引用集扩容：缩略图（`${mediaKey}.thumb.jpg`）不是任何行的 file_key，
        // 但其存亡与宿主媒体一致——宿主被引用则缩略图同样受保护；宿主删除后
        // （行软删 → file_key 出引用集）缩略图随之进入差集，宽限期后一并回收。
        // 缩略图 key 与媒体 key 同前缀（见 videoThumbKeyFor 注），GC 前缀清单
        // 无需扩容。
        const referencedKeys = new Set<string>();
        for (const key of referencedMediaKeys) {
            referencedKeys.add(key);
            referencedKeys.add(videoThumbKeyFor(key));
        }
        const now = Date.now();
        const orphans = listings
            .flat()
            .filter((info) => !referencedKeys.has(info.key))
            // 宽限期保护：mtime 缺失（平台未提供）视同新鲜保守跳过——漏删只浪费
            // 存储，误删在途上传会丢用户数据，两侧代价不对称
            .filter(
                (info) =>
                    info.modifiedAt !== null && now - info.modifiedAt >= GC_GRACE_PERIOD_MS,
            );
        if (orphans.length === 0) return;
        const failures = await removeFilesBestEffort(orphans.map((info) => info.key));
        if (failures.length > 0) {
            console.warn(
                `[archive-gc] 孤儿媒体清理 ${orphans.length - failures.length}/${orphans.length} 成功，` +
                    `失败留待下次冷启重试，示例：${failures[0].key} ${failures[0].message}`,
            );
            return;
        }
        console.log(`[archive-gc] 孤儿媒体清理完成：${orphans.length} 个文件已回收`);
    } catch (error) {
        console.warn('[archive-gc] 孤儿媒体扫描失败（本次跳过，不影响功能）：', error);
    }
}

/** 搜索时间范围参数校验：非法本地日期返回错误文案（调用方走 error 通道 + 空结果）。 */
function invalidSearchRangeError(range?: { from?: string; to?: string }): string | null {
    if (range?.from && !isValidLocalDate(range.from)) return `搜索范围起点不是有效日期：${range.from}`;
    if (range?.to && !isValidLocalDate(range.to)) return `搜索范围终点不是有效日期：${range.to}`;
    return null;
}

/** TripRow → 行程卡（loadAll 与 searchTrips 共用的装饰口径，避免两处漂移）。 */
function toTripCards(rows: TripRow[], stats: Map<string, db.TripStats>): TripCard[] {
    return rows.map((row) => {
        const trip = decorateTrip(row);
        const s = stats.get(row.id);
        return { ...trip, journalDays: s?.journalDays ?? 0, plansTotal: s?.plansTotal ?? 0, plansDone: s?.plansDone ?? 0 };
    });
}

export const useArchiveStore = create<ArchiveStore>((set, get) => ({
    ready: false,
    error: null,
    revision: 0,
    savingJournal: false,
    trips: [],
    metrics: {
        streak: 0,
        journalDays: 0,
        totalWords: 0,
        eventCounts: { open: 0, done: 0, failed: 0 },
        noteCounts: { open: 0, closed: 0, failed: 0 },
        curve: [],
    },
    mediaUploadProgress: {},

    async loadAll() {
        try {
            const today = todayLocal();
            // 本地时区 24:00 自动收笔：加载即收口昨日及更早的 open 日记
            await db.closeStaleOpenJournals(today);
            const [tripRows, stats, totalWords, dates, eventCounts, noteCounts] = await Promise.all([
                db.listTrips(),
                db.tripStats(),
                db.journalTotalWords(),
                // 记录日并集（内容活动日：有内容日记 ∪ 事件创建/更新日 ∪ 行程
                // 创建/更新日 ∪ 媒体上传日）——journalDays 与 streak 同一集合口径
                //（「写过 X 天」与「连续 N 天」不分裂），排除自动建行的空页灌水
                db.activityDates(),
                db.eventStatusCounts(),
                db.noteStatusCounts(),
            ]);
            // 曲线窗口覆盖最近 30 天
            const window30 = await db.wordCountByDate(addDaysLocal(today, -29));
            set({
                ready: true,
                error: null,
                trips: toTripCards(tripRows, stats),
                metrics: {
                    streak: streakFromDates(dates, today),
                    journalDays: dates.size,
                    totalWords,
                    eventCounts,
                    noteCounts,
                    curve: curveSeries(window30, 30, today),
                },
            });
        } catch (error) {
            // 降级语义：数据可重试加载，界面上以 error 文案提示（R3 ②）
            set({ ready: true, error: `数据加载失败：${toMessage(error)}` });
        }
        // 桌面 widget 快照（best-effort）：行程集合变化 = 「最新行程」选择变化
        queueWidgetRefresh();
        // v0.5.2 令3：hydration 完成即对齐常驻监控通知（app 启动/回前台重建；
        // 被杀期间过点的陈旧计数在此收敛。幂等——原生以注册表自判 start/stop）
        void refreshAlarmMonitor();
    },

    deck(): DeckData {
        const { trips } = get();
        return {
            deckTrip: pickDeckTrip(trips),
            todayJournal: null, // 屏层经 useTodayJournal() 异步获取
        };
    },

    async resolveTrip(id) {
        try {
            return await db.getTrip(id);
        } catch (error) {
            set({ error: `行程读取失败：${toMessage(error)}` });
            return null;
        }
    },

    async createTrip({ title, startDate, endDate, description, icon }) {
        // row 构造必须在 try 内：web 非安全上下文 crypto.randomUUID 会抛 TypeError，
        // 构造留在 try 外会让失败绕过 error 通道直接 unhandled rejection（调用方 void 调用无人接）
        let row: Omit<TripRow, 'deleted_at'> | null = null;
        try {
            const now = Date.now();
            row = {
                id: crypto.randomUUID(),
                title: title.trim(),
                start_date: startDate,
                // 持续性行程（endDate = null）落 TRIP_OPEN_ENDED 哨兵，语义见 schema.ts
                end_date: endDate ?? TRIP_OPEN_ENDED,
                note: '',
                description: description.trim(),
                icon,
                video_key: null,
                cover_key: null,
                created_at: now,
                updated_at: now,
            };
            await db.insertTrip(row);
        } catch (error) {
            set({ error: `行程创建失败：${toMessage(error)}` });
            return null;
        }
        set({ error: null, revision: get().revision + 1 });
        await get().loadAll();
        return decorateTrip(row);
    },

    async updateTrip(id, patch) {
        try {
            await db.updateTrip(id, {
                ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
                ...(patch.startDate !== undefined ? { start_date: patch.startDate } : {}),
                // endDate: null → 持续性哨兵；日期串 → 固定结束（两种语义都算显式修改）
                ...(patch.endDate !== undefined
                    ? { end_date: patch.endDate === null ? TRIP_OPEN_ENDED : patch.endDate }
                    : {}),
                ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
                ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
                ...(patch.videoKey !== undefined ? { video_key: patch.videoKey } : {}),
            });
        } catch (error) {
            set({ error: `行程保存失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
        await get().loadAll();
        return true;
    },

    async deleteTrip(id) {
        try {
            // ① 先收集文件 key：级联软删后行不可见（所有查询过滤 deleted_at）。
            //    封面视频 video_key 一并回收（首页卡片「删了还引用」的直接来源之一）。
            const [trip, journalRows, tripItems] = await Promise.all([
                db.getTrip(id),
                db.listJournalsByTrip(id),
                // 行程项（v9）：级联软删后行不可见，identifier 需在此先收集
                db.listTripItemsByTrip(id),
            ]);
            const journalMedia = await db.mediaByJournalIds(journalRows.map((row) => row.id));
            const tripMediaRows = await db.listTripMediaByTrip(id);
            const fileKeys = [
                ...journalRows.flatMap((row) => (journalMedia.get(row.id) ?? []).map((m) => m.file_key)),
                ...tripMediaRows.map((m) => m.file_key),
                ...(trip?.video_key ? [trip.video_key] : []),
            ];
            // ② 行级级联一个事务（日记/日记媒体/行程媒体/逐日计划/行程项/行程本体，软删）
            await db.softDeleteTripCascade(id, Date.now());
            // ②' 行程项通知随级联取消（best-effort；identifier 已在 ① 收集）
            await Promise.all(tripItems.map((item) => cancelTripItemNotification(item.id)));
            // v0.5.2 D 审计纠错：级联软删同样要摘 Android 系统闹钟——此前只取消
            // expo 通知链，注册表条目存活 = 删掉的行程照样到点炸铃（僵尸闹钟）。
            // alarm.cancel 幂等（未注册 = 无操作）；同拍清 fired 账与呈现面，
            // 常驻监控通知由末尾 loadAll → refreshAlarmMonitor 收敛。
            await Promise.all(tripItems.map((item) => alarm.cancel(item.id)));
            // ③ 文件清理不阻塞行删除：失败聚合上浮（行已删，孤儿文件只浪费存储不再被引用）
            const failures = await removeFilesBestEffort(fileKeys);
            set({
                error: null,
                revision: get().revision + 1,
                ...(failures.length > 0
                    ? { error: `行程已删除，但 ${failures.length} 个媒体文件清理失败：${failures[0].message}` }
                    : {}),
            });
        } catch (error) {
            set({ error: `行程删除失败：${toMessage(error)}` });
            return false;
        }
        await get().loadAll();
        return true;
    },

    async attachTripVideo(tripId, uri) {
        try {
            const key = `trip-video/${tripId}.mp4`;
            // 大文件直迁（copyFromUri）：native 原生 copy 零 JS 字节拷贝、web
            // 流式分块——行程封面视频几十 MB 不再卡主线程；相册产物 copy 语义
            // （源归系统管理）。行程侧无进度消费面，不挂 taskId。
            await fileStorage.copyFromUri(key, uri);
            void ensureVideoThumbnail(key);
            return await get().updateTrip(tripId, { videoKey: key });
        } catch (error) {
            set({ error: `视频上传失败：${toMessage(error)}` });
            return false;
        }
    },

    async attachTripMedia(tripId, kind, uri, width, height, durationMs = null, opts?: AttachMediaOptions, itemId?: string) {
        const sink = makeProgressSink(opts?.taskId, opts?.onProgress);
        try {
            // 锁定预检（#7）：已结束的行程不可再增内容（UI 侧入口同样要挡，这里是兜底）
            const trip = await db.getTrip(tripId);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return null;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，不能添加内容' });
                return null;
            }
            // 直接落盘+落库（行程媒体无块模型，不需要日记那套 pending 占位回填链路）
            const mediaId = crypto.randomUUID();
            const key = `trip-media/${tripId}/${mediaId}.${mediaFileExt(kind)}`;
            // 落盘分流（与 attachJournalMedia 同口径，见其注）：视频直迁、图片
            // manipulator 字节路径
            if (kind === 'video') {
                if (opts?.moveSource) {
                    await fileStorage.moveFromUri(key, uri, { onProgress: sink });
                } else {
                    await fileStorage.copyFromUri(key, uri, { onProgress: sink });
                }
            } else {
                const prepared = await prepareImageBytes(uri, width);
                await fileStorage.put(key, prepared.bytes);
                width = prepared.width;
                height = prepared.height;
            }
            await db.insertTripMedia({
                id: mediaId,
                trip_id: tripId,
                file_key: key,
                kind,
                width,
                height,
                duration_ms: durationMs,
                // 行程项归属（v9）：undefined = 无主媒体（日卡背景等既有形态）
                item_id: itemId ?? null,
                created_at: Date.now(),
            });
            if (kind === 'video') void ensureVideoThumbnail(key);
            set({ error: null, revision: get().revision + 1 });
            return mediaId;
        } catch (error) {
            set({ error: `媒体上传失败：${toMessage(error)}` });
            return null;
        } finally {
            clearUploadProgress(opts?.taskId);
        }
    },

    async removeTripMedia(mediaId) {
        try {
            // ① 先取行：软删后（或行本就不存在）无法再拿 file_key（所有查询过滤 deleted_at）
            const media = await db.getTripMedia(mediaId);
            if (!media) {
                set({ error: '媒体不存在或已删除' });
                return false;
            }
            // ② 锁定预检（#7）：已结束行程内容只读，删除也在其列（UI 侧入口先挡，这里兜底）
            const trip = await db.getTrip(media.trip_id);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return false;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定，不能删除媒体' });
                return false;
            }
            // ③ 行级软删（单行，无 updated_at 列）；文件清理随后尽力执行
            await db.softDeleteTripMedia(mediaId, Date.now());
            // ③' 摘日卡背景指针（v5 联动）：该媒体若正被某天用作背景，指针同步清零，
            //     读取侧当日降级文字卡（防悬挂引用；at 仅审计时间戳）
            await db.detachTripDayBackgroundByMediaId(mediaId, Date.now());
            // ④ 文件清理不阻塞行删除：失败聚合上浮（行已删，孤儿文件只浪费存储不再被引用）
            const failures = await removeFilesBestEffort([media.file_key]);
            set({
                error: null,
                revision: get().revision + 1,
                ...(failures.length > 0
                    ? { error: `记录已删除，但媒体文件清理失败：${failures[0].message}` }
                    : {}),
            });
        } catch (error) {
            set({ error: `媒体删除失败：${toMessage(error)}` });
            return false;
        }
        return true;
    },

    async setTripDayBackground(tripId, date, uri, width, height) {
        let mediaId: string | null = null;
        let fileKey: string | null = null;
        let pointerSwapped = false;
        try {
            // 预检（#7）：已结束行程内容只读，背景也属内容（UI 长按入口先挡，这里兜底）
            const trip = await db.getTrip(tripId);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return false;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定，不能修改背景' });
                return false;
            }
            if (!isValidLocalDate(date)) {
                set({ error: `背景日期不合法：${date}` });
                return false;
            }
            // 先取旧指针（upsert 之后就读不到旧值了）
            const oldMediaId = await db.getTripDayBackgroundMediaId(tripId, date);
            // 背景图 = trip_media 的一行：复用行程媒体上传流（缩边 + 落盘 + 落库）
            mediaId = crypto.randomUUID();
            fileKey = `trip-media/${tripId}/${mediaId}.jpg`;
            const prepared = await prepareImageBytes(uri, width);
            await fileStorage.put(fileKey, prepared.bytes);
            await db.insertTripMedia({
                id: mediaId,
                trip_id: tripId,
                file_key: fileKey,
                kind: 'image',
                width: prepared.width,
                height: prepared.height,
                duration_ms: null,
                // 日卡背景 = 无主媒体（item_id 恒 null，v9 列默认语义显式落）
                item_id: null,
                created_at: Date.now(),
            });
            // 指针切换在新行落库之后：任何时刻指针都指向活行（顺序见 db.upsertTripDayBackground）
            await db.upsertTripDayBackground(tripId, date, mediaId, Date.now());
            pointerSwapped = true;
            // 旧背景清理（「删除媒体」口径：行软删 + 文件尽力清理）。清理段自带兜底：
            // 指针已切、新背景已生效，此处任何失败只聚合上浮，不推翻结果也不拦住
            // revision bump（否则 UI 停在旧背景还报「失败」，状态错位）
            let cleanupError: string | null = null;
            if (oldMediaId && oldMediaId !== mediaId) {
                try {
                    const oldRow = await db.getTripMedia(oldMediaId);
                    if (oldRow) {
                        await db.softDeleteTripMedia(oldRow.id, Date.now());
                        const failures = await removeFilesBestEffort([oldRow.file_key]);
                        if (failures.length > 0) {
                            cleanupError = `背景已更新，但旧图文件清理失败：${failures[0].message}`;
                        }
                    }
                } catch (cleanupCaught) {
                    cleanupError = `背景已更新，但旧图清理失败：${toMessage(cleanupCaught)}`;
                }
            }
            set({ error: cleanupError, revision: get().revision + 1 });
            return true;
        } catch (error) {
            // 回滚半程产物（不留孤儿字节/坏指针）：文件删了、行未落库则无事发生；
            // 行已落库但指针未切 → 行软删（对账口径同 attachJournalMedia 的入库失败回滚）
            if (mediaId && !pointerSwapped) {
                await db.softDeleteTripMedia(mediaId, Date.now()).catch(() => undefined);
            }
            if (fileKey) await fileStorage.remove(fileKey).catch(() => undefined);
            set({ error: `背景设置失败：${toMessage(error)}` });
            return false;
        }
    },

    // ─── 行程项（v9：trip_items，行程表页）────────────────────────────────────
    // 刷新口径（见接口段注）：行程项不进 loadAll 状态，mutation 成功只 bump
    // revision，行程表页按 useArchiveRevision 局部重载。

    async createTripItem({ tripId, date, time, title, description, withAlarm }) {
        // 校验先行（错误进 error 通道，对齐 createEvent 口径）：
        // v0.5.1 令 1——标题校验放开：快速路径删标题输入框，trim 后空串合法
        // 直接入库（卡面「空标题只显时刻、无兜底文字」由展示层 tripItemDisplayTitle
        // 把关）；时间合法 'HH:mm'、日期合法本地日期照旧；超长不设截断（备注为自由短文）
        const trimmedTitle = title.trim();
        if (!isValidTripItemTime(time)) {
            set({ error: `时间格式不对，用 HH:mm（如 09:30）` });
            return null;
        }
        if (!isValidLocalDate(date)) {
            set({ error: `行程项日期不合法：${date}` });
            return null;
        }
        // row 构造留在 try 内：web 非安全上下文 crypto.randomUUID 会抛 TypeError，
        // 失败必须走 error 通道（对齐 createTrip 的注释口径）。行以完整 TripItemRow
        // 形态构造（deleted_at 显式 null），传给 insertTripItem 的 Omit 形参按结构
        // 兼容放行
        let row: TripItemRow | null = null;
        try {
            // 存在性 + 锁定预检（#7）：已结束行程内容只读（UI 侧入口先挡，这里兜底）
            const trip = await db.getTrip(tripId);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return null;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定，不能添加行程项' });
                return null;
            }
            const now = Date.now();
            const created: TripItemRow = {
                id: crypto.randomUUID(),
                trip_id: tripId,
                local_date: date,
                time,
                title: trimmedTitle,
                description: (description ?? '').trim(),
                status: 'pending',
                completed_at: null,
                wrap_closed_at: null,
                created_at: now,
                updated_at: now,
                deleted_at: null,
            };
            await db.insertTripItem(created);
            row = created;
        } catch (error) {
            set({ error: `行程项创建失败：${toMessage(error)}` });
            return null;
        }
        // 防御式收窄（杜绝 try/catch 控制流歧义）：此处置信非空
        if (!row) return null;
        // 通知调度（best-effort，fire-and-forget：内部全兜底，不阻塞也不进 error 通道）
        void scheduleTripItemNotification(row);
        // 系统闹钟（用户指令 #9，创建时可选）：iOS/web 模块缺失自动 no-op，
        // 调度失败仅 warn——闹钟是提醒增强，创建照常成功
        if (withAlarm) {
            // v0.5.1 令2：Android 注册表快照与 iOS 通知同走 alarmCardContent
            // 单源（空标题只报时刻，双端卡片文案一致）
            const alarmCard = alarmCardContent(row);
            // v0.5.2 令3：链在 schedule 落地之后再刷常驻监控——同拍 poke 可能
            // 读到未写入新条目的注册表，计数少一且无后续触发点纠正
            void alarm.schedule({
                id: row.id,
                at: tripItemDueAt(row.local_date, row.time),
                title: alarmCard.title,
                body: alarmCard.body,
            }).then(() => refreshAlarmMonitor());
        }
        set({ error: null, revision: get().revision + 1 });
        queueWidgetRefresh();
        return row;
    },

    async updateTripItemContent(id, patch) {
        try {
            const item = await db.getTripItem(id);
            if (!item) {
                set({ error: '行程项不存在或已删除' });
                return false;
            }
            const trip = await db.getTrip(item.trip_id);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return false;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定，不能编辑' });
                return false;
            }
            const nextTitle = patch.title !== undefined ? patch.title.trim() : undefined;
            const nextDescription = patch.description !== undefined ? patch.description.trim() : undefined;
            if (nextTitle === undefined && nextDescription === undefined) return false;
            const wrote = await db.updateTripItemContent(
                id,
                { title: nextTitle, description: nextDescription },
                Date.now(),
            );
            if (!wrote) {
                set({ error: '行程项编辑失败' });
                return false;
            }
            const updated = await db.getTripItem(id);
            if (updated) {
                // 文案单源重挂（v0.5.1 alarmCardContent 口径）：只动「未到点且
                // pending」的调度——已过点重排会立刻炸响；收尾/终态项调度已清账。
                const due = tripItemDueAt(updated.local_date, updated.time);
                if (due > Date.now() && updated.status === 'pending') {
                    void scheduleTripItemNotification(updated);
                    const card = alarmCardContent(updated);
                    // 文案变了监控文案也可能变（body 快照同 alarmCardContent）：
                    // 链在 schedule 落地后刷新，pending 集合本身变少时同样收敛
                    void alarm.schedule({ id: updated.id, at: due, title: card.title, body: card.body })
                        .then(() => refreshAlarmMonitor());
                }
            }
        } catch (error) {
            set({ error: `行程项编辑失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
        queueWidgetRefresh();
        return true;
    },

    async startTripItemWrap(id) {
        try {
            const item = await db.getTripItem(id);
            if (!item) {
                set({ error: '行程项不存在或已删除' });
                return false;
            }
            const trip = await db.getTrip(item.trip_id);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return false;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定' });
                return false;
            }
            if ((item.wrap_closed_at ?? null) != null || item.status === 'failed') {
                set({ error: '行程项已结束' });
                return false;
            }
            // 幂等：已进入收尾直接成功（不 bump revision）
            if ((item.completed_at ?? null) != null) return true;
            // 时间闸：时刻未到不允许收尾（UI 只在 done 阶段出该行，这里兜底）
            if (tripItemDueAt(item.local_date, item.time) > Date.now()) {
                set({ error: '时间还没到，还不能收尾' });
                return false;
            }
            await db.startTripItemWrap(id, Date.now());
            // v0.4.7 D 接线 4：进入收尾 = 该项闹钟/通知不应再响（幂等 best-effort）
            void alarm.cancel(id).then(() => refreshAlarmMonitor());
            void cancelTripItemNotification(id);
        } catch (error) {
            set({ error: `收尾操作失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
        queueWidgetRefresh();
        return true;
    },

    async closeTripItemWrap(id) {
        try {
            const item = await db.getTripItem(id);
            if (!item) {
                set({ error: '行程项不存在或已删除' });
                return false;
            }
            const trip = await db.getTrip(item.trip_id);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return false;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定' });
                return false;
            }
            if (item.status === 'failed') {
                set({ error: '行程项已结束' });
                return false;
            }
            // 幂等：已终态直接成功（不 bump revision）
            if ((item.wrap_closed_at ?? null) != null) return true;
            await db.closeTripItemWrap(id, Date.now());
            // v0.4.7 D 接线 4：收尾关闭 = 同拍清账（与删除链同款）
            void alarm.cancel(id).then(() => refreshAlarmMonitor());
            void cancelTripItemNotification(id);
        } catch (error) {
            set({ error: `结束收尾失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
        queueWidgetRefresh();
        return true;
    },

    async deleteTripItem(id) {
        try {
            const item = await db.getTripItem(id);
            if (!item) {
                set({ error: '行程项不存在或已删除' });
                return false;
            }
            const trip = await db.getTrip(item.trip_id);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return false;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定，不能删除行程项' });
                return false;
            }
            await db.softDeleteTripItem(id, Date.now());
            // 摘 item_id 媒体关联（媒体行保留——记录留档，挂靠关系随项消失）
            await db.detachTripMediaByItemId(id);
        } catch (error) {
            set({ error: `行程项删除失败：${toMessage(error)}` });
            return false;
        }
        // 通知取消（best-effort：行已软删，提醒不应再响；失败仅告警不回滚）
        void cancelTripItemNotification(id);
        // 系统闹钟同拍取消（幂等 best-effort；未注册过 = 无操作）；
        // v0.5.2 令3：出账后链刷常驻监控（删到最后一个 pending 即撤通知）
        void alarm.cancel(id).then(() => refreshAlarmMonitor());
        set({ error: null, revision: get().revision + 1 });
        queueWidgetRefresh();
        return true;
    },

    async attachTripItemMedia(tripItemId, kind, uri, width, height, durationMs = null) {
        try {
            // 归属预检：行程项存在（媒体没有落点则拒绝）；行程锁定闸（#7）与
            // 落盘/落库管线全部在 attachTripMedia 内完成（itemId 落 item_id 列）
            const item = await db.getTripItem(tripItemId);
            if (!item) {
                set({ error: '行程项不存在或已删除' });
                return null;
            }
            return await get().attachTripMedia(item.trip_id, kind, uri, width, height, durationMs, undefined, tripItemId);
        } catch (error) {
            set({ error: `媒体上传失败：${toMessage(error)}` });
            return null;
        }
    },

    async searchTrips(keyword, range) {
        const rangeError = invalidSearchRangeError(range);
        if (rangeError) {
            set({ error: rangeError });
            return [];
        }
        const trimmed = keyword.trim();
        // 空 keyword 且无范围 = 全量浏览（2026-11-19 用户指令「搜索默认全部的
        // 不管什么状态」）：全量行程（含 finished——历史在搜索可见）
        if (!trimmed && !range?.from && !range?.to) {
            const [rows, stats] = await Promise.all([db.listTrips(), db.tripStats()]);
            return toTripCards(rows, stats);
        }
        try {
            const [rows, stats] = await Promise.all([
                db.searchTrips(trimmed, { from: range?.from, to: range?.to }),
                db.tripStats(),
            ]);
            return toTripCards(rows, stats);
        } catch (error) {
            set({ error: `行程搜索失败：${toMessage(error)}` });
            return [];
        }
    },

    async searchJournals(keyword, range) {
        const rangeError = invalidSearchRangeError(range);
        if (rangeError) {
            set({ error: rangeError });
            return [];
        }
        const trimmed = keyword.trim();
        // 空 keyword 且无范围 = 全量浏览（日记 + 计划两类、含已收笔——历史在
        // 搜索可见；2026-11-19 用户指令）
        if (!trimmed && !range?.from && !range?.to) {
            return db.listAllJournals();
        }
        try {
            return await db.searchJournals(trimmed, { from: range?.from, to: range?.to });
        } catch (error) {
            set({ error: `计划搜索失败：${toMessage(error)}` });
            return [];
        }
    },

    // ─── 独立计划（v8）────────────────────────────────────────────────────────
    // 刷新口径与 events 相同：计划不进 loadAll 的 store 状态（trips/metrics 与
    // 计划无关），mutation 成功只 bump revision——列表由屏层按 useDataRevision
    // 局部重载。正文保存/插图/录音/删除/标题复用既有 mutation（见接口注释），
    // 这里只补「创建」与「元信息更新」两个无对应入口的动作。

    async createPlan(input) {
        // 校验先行（超长整体拒绝不走截断）；v0.4.5 起标题必填、描述选填——
        // 与 createEvent 的 validateEventInput 同构（「给计划起个名字」对齐
        // 「给事件起个名字」），/plan/new 向导的按钮门槛与本校验同源
        const title = input.title.trim();
        if (title.length === 0) {
            set({ error: PLAN_TITLE_REQUIRED_ERROR });
            return null;
        }
        if (title.length > JOURNAL_TITLE_MAX) {
            set({ error: `计划标题最多 ${JOURNAL_TITLE_MAX} 个字` });
            return null;
        }
        const description = input.description.trim();
        if (description.length > PLAN_DESCRIPTION_MAX) {
            set({ error: `计划描述最多 ${PLAN_DESCRIPTION_MAX} 个字` });
            return null;
        }
        // 行构造（含 id 生成）在 db.createPlan 内：随机源异常原样上抛，这里的
        // try 保证失败走 error 通道而非 unhandled rejection（对齐 createTrip
        // 的注释口径——调用方 void 调用无人接）
        let row: JournalRow | null = null;
        try {
            row = await db.createPlan({ title, description });
        } catch (error) {
            set({ error: `计划创建失败：${toMessage(error)}` });
            return null;
        }
        set({ error: null, revision: get().revision + 1 });
        return row;
    },

    async updatePlanMeta(id, patch) {
        try {
            const note = await db.getJournal(id);
            if (!note) {
                set({ error: '计划不存在或已删除' });
                return false;
            }
            // kind 预检：本入口是计划专用（标题单独编辑走 updateJournalTitle，
            // 日记无 description 语义）——防误把日记 id 传进来写 description
            if (note.kind !== 'note') {
                set({ error: '目标不是独立计划' });
                return false;
            }
            // title：null = 清除；字符串经 normalizeJournalTitle（空串归一为 null
            // = 未命名，超长钳制——对齐 updateJournalTitle 的既有口径）
            const title =
                patch.title === undefined
                    ? undefined
                    : patch.title === null
                      ? null
                      : normalizeJournalTitle(patch.title);
            // description：trim + 上限校验（超长整体拒绝，与创建同口径）；空串合法
            // （列 NOT NULL DEFAULT ''，未填落 ''，不做 null 化）
            let description: string | undefined;
            if (patch.description !== undefined) {
                const trimmed = patch.description.trim();
                if (trimmed.length > PLAN_DESCRIPTION_MAX) {
                    set({ error: `计划描述最多 ${PLAN_DESCRIPTION_MAX} 个字` });
                    return false;
                }
                description = trimmed;
            }
            // status（v11）：仅接受合法枚举（非法值整体拒绝，updateEventMeta
            // 同款防脏值）；终态落 completed_at、回 open 清锚点在 db 层同批写
            let status: PlanStatus | undefined;
            if (patch.status !== undefined) {
                if (!isPlanStatus(patch.status)) {
                    set({ error: `计划状态不合法：${String(patch.status)}` });
                    return false;
                }
                status = patch.status;
            }
            await db.updatePlanMeta(id, {
                ...(title !== undefined ? { title } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(status !== undefined ? { status } : {}),
            });
        } catch (error) {
            set({ error: `计划保存失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
        return true;
    },

    // ─── events（v6：事件实体，类似工单）─────────────────────────────────────
    // 刷新口径：事件不进 loadAll 的 store 状态（trips/metrics 与事件无关，loadAll
    // 是纯浪费），mutation 成功只 bump revision——事件列表由屏层按
    // useDataRevision 局部重载（对齐 attachTripMedia/removeTripMedia 的取径）。

    async createEvent(input) {
        // 校验先行（title 必填等）：错误文案直接进 error 通道（对齐 validateTripInput 消费方式）
        const validationError = validateEventInput(input);
        if (validationError) {
            set({ error: validationError });
            return null;
        }
        // row 构造留在 try 内：web 非安全上下文 crypto.randomUUID 会抛 TypeError，
        // 失败必须走 error 通道（对齐 createTrip 的注释口径）
        let row: EventRow | null = null;
        try {
            const now = Date.now();
            const subject = normalizeEventSubject(input.subjectKind, input.subjectValue);
            const gps = input.gps ?? null;
            row = {
                id: crypto.randomUUID(),
                title: input.title.trim(),
                status: 'open',
                description: normalizeEventText(input.description, EVENT_DESCRIPTION_MAX),
                blocks: newEventBlocksJson(),
                gps_lat: gps ? gps.lat : null,
                gps_lng: gps ? gps.lng : null,
                gps_accuracy: gps?.accuracy ?? null,
                handled_by: normalizeEventText(input.handledBy, EVENT_HANDLED_BY_MAX),
                subject_kind: subject.kind,
                subject_value: subject.value,
                phone: normalizeEventText(input.phone, EVENT_PHONE_MAX),
                email: normalizeEventEmail(input.email, EVENT_EMAIL_MAX),
                created_at: now,
                updated_at: now,
                deleted_at: null,
            };
            await db.insertEvent(row);
        } catch (error) {
            set({ error: `事件创建失败：${toMessage(error)}` });
            return null;
        }
        set({ error: null, revision: get().revision + 1 });
        return row;
    },

    async updateEventBlocks(eventId, blocks) {
        // 序列化/落库前滤掉上传中的 pending 占位块（与 saveJournalBlocks 同口径：
        // 占位 mediaId 在 event_media 无对应行，落库会让读取侧渲染坏引用）
        const persistable = blocks.filter(
            (block) => !(block.t === 'media' && block.mediaId === PENDING_MEDIA_ID),
        );
        // 对账基准时刻（回填竞态保护）：只清 created_at 早于本次 blocks 落库的媒体行
        const persistedAt = Date.now();
        try {
            await db.updateEventBlocks(eventId, serializeBlocks(persistable));
        } catch (error) {
            set({ error: `事件保存失败：${toMessage(error)}` });
            return false;
        }
        // event_media 引用对账（事件版孤儿回收，DEV.md #1.1 数据面闭环）：编辑器删
        // 媒体块只摘 blocks 引用，孤儿行在此统一软删 + 文件尽力清理（失败聚合上浮
        // error，不推翻已落库正文——对齐 saveJournalBlocks 口径）
        let fileFailures: { key: string; message: string }[] = [];
        try {
            const referenced = new Set(
                persistable.flatMap((block) => (block.t === 'media' ? [block.mediaId] : [])),
            );
            const rows = await db.listEventMediaByEvent(eventId);
            const orphans = rows.filter(
                (row) => !referenced.has(row.id) && row.created_at <= persistedAt,
            );
            if (orphans.length > 0) {
                await db.softDeleteEventMediaByIds(orphans.map((row) => row.id), Date.now());
                fileFailures = await removeFilesBestEffort(orphans.map((row) => row.file_key));
            }
        } catch (error) {
            set({ error: `事件已保存，但孤儿媒体清理失败：${toMessage(error)}` });
            return true;
        }
        set({
            error: null,
            revision: get().revision + 1,
            ...(fileFailures.length > 0
                ? {
                      error: `事件已保存，但 ${fileFailures.length} 个媒体文件清理失败：${fileFailures[0].message}`,
                  }
                : {}),
        });
        return true;
    },

    async updateEventMeta(eventId, patch) {
        try {
            const current = await db.getEvent(eventId);
            if (!current) {
                set({ error: '事件不存在或已删除' });
                return false;
            }
            // 标题（设置卡改名）：与创建同源口径——trim 后必填非空、上限
            // EVENT_TITLE_MAX；空串/超长整体拒绝（不走截断，标题是必填语义字段）
            let title: string | undefined;
            if (patch.title !== undefined) {
                const trimmed = patch.title.trim();
                if (trimmed.length === 0) {
                    set({ error: '给事件起个名字' });
                    return false;
                }
                if (trimmed.length > EVENT_TITLE_MAX) {
                    set({ error: `事件名最多 ${EVENT_TITLE_MAX} 个字` });
                    return false;
                }
                title = trimmed;
            }
            // 状态仅接受合法枚举（非法值整体拒绝，避免脏状态落库）
            let status: EventStatus | undefined;
            if (patch.status !== undefined) {
                if (!isEventStatus(patch.status)) {
                    set({ error: `事件状态不合法：${String(patch.status)}` });
                    return false;
                }
                status = patch.status;
            }
            if (
                patch.subjectKind !== undefined &&
                patch.subjectKind !== null &&
                !isEventSubjectKind(patch.subjectKind)
            ) {
                set({ error: '对象类型不合法' });
                return false;
            }
            // GPS patch 防御校验（undefined = 不动；null = 清除；对象必须含合法坐标）
            if (patch.gps) {
                if (!isValidGpsCoordinate(patch.gps.lat, patch.gps.lng)) {
                    set({ error: 'GPS 经纬度不合法' });
                    return false;
                }
                if (!isValidGpsAccuracy(patch.gps.accuracy)) {
                    set({ error: '定位精度不合法' });
                    return false;
                }
            }
            // subject 原子对合并：patch 出现任一侧 → 与当前行合并后整体归一化
            // （显式 null = 清除该侧；归一化后任一侧缺失 → 双双置空，见 event-logic）
            const touchSubject = patch.subjectKind !== undefined || patch.subjectValue !== undefined;
            const subject = touchSubject
                ? normalizeEventSubject(
                      patch.subjectKind !== undefined ? patch.subjectKind : current.subject_kind,
                      patch.subjectValue !== undefined ? patch.subjectValue : current.subject_value,
                  )
                : null;
            await db.updateEventMeta(eventId, {
                ...(title !== undefined ? { title } : {}),
                ...(status !== undefined ? { status } : {}),
                ...(patch.handledBy !== undefined
                    ? { handled_by: normalizeEventText(patch.handledBy, EVENT_HANDLED_BY_MAX) }
                    : {}),
                ...(patch.description !== undefined
                    ? { description: normalizeEventText(patch.description, EVENT_DESCRIPTION_MAX) }
                    : {}),
                // 联系方式（v7）：undefined = 不动；null/空串 = 清除（normalize
                // 口径）；邮箱经 normalizeEventEmail 剥净值内空白
                ...(patch.phone !== undefined
                    ? { phone: normalizeEventText(patch.phone, EVENT_PHONE_MAX) }
                    : {}),
                ...(patch.email !== undefined
                    ? { email: normalizeEventEmail(patch.email, EVENT_EMAIL_MAX) }
                    : {}),
                ...(subject ? { subject_kind: subject.kind, subject_value: subject.value } : {}),
                ...(patch.gps !== undefined
                    ? {
                          gps_lat: patch.gps ? patch.gps.lat : null,
                          gps_lng: patch.gps ? patch.gps.lng : null,
                          gps_accuracy: patch.gps?.accuracy ?? null,
                      }
                    : {}),
            });
        } catch (error) {
            set({ error: `事件保存失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
        return true;
    },

    async attachEventMedia(eventId, kind, uri, width, height, durationMs = null, opts?) {
        // 进度汇（对齐 attachJournalMedia）：taskId 进注册表（编辑屏占位卡 /
        // capture: 会话横幅），onProgress 原始拍供录制会话护栏跟踪
        const sink = makeProgressSink(opts?.taskId, opts?.onProgress);
        try {
            // 存在性预检（事件已删则媒体没有落点；事件无锁定语义，open/done 均可增补）
            const event = await db.getEvent(eventId);
            if (!event) {
                set({ error: '事件不存在或已删除' });
                return null;
            }
            const mediaId = crypto.randomUUID();
            // 音频容器/扩展名按字节头核对（对齐 attachJournalMedia；空字节坏产物拒绝入库）
            let ext = mediaFileExt(kind);
            if (kind === 'audio') {
                const bytes = await readUriBytes(uri);
                if (bytes.byteLength === 0) {
                    throw new Error('录音文件为空，请重试');
                }
                ext = audioExtFromBytes(bytes);
            }
            const key = `event-media/${eventId}/${mediaId}.${ext}`;
            // 落盘分流（对齐 attachJournalMedia/attachTripMedia）：视频 move/copy
            // 直迁（moveSource = 录像/录音 cache 产物直迁零残留；相册产物 copy
            // 不动源文件），图片 manipulator 字节路径，音频字节落盘
            if (kind === 'video') {
                if (opts?.moveSource) {
                    await fileStorage.moveFromUri(key, uri, { onProgress: sink });
                } else {
                    await fileStorage.copyFromUri(key, uri, { onProgress: sink });
                }
            } else if (kind === 'audio') {
                await fileStorage.put(key, await readUriBytes(uri));
            } else {
                const prepared = await prepareImageBytes(uri, width);
                width = prepared.width;
                height = prepared.height;
                await fileStorage.put(key, prepared.bytes);
            }
            try {
                await db.insertEventMedia({
                    id: mediaId,
                    event_id: eventId,
                    file_key: key,
                    kind,
                    width,
                    height,
                    duration_ms: durationMs,
                    created_at: Date.now(),
                });
            } catch (dbError) {
                // 落库失败回滚已落盘文件（不留孤儿字节，对齐 attachJournalMedia）
                await fileStorage.remove(key).catch(() => undefined);
                throw dbError;
            }
            // 缩略图是展示增强（fire-and-forget，失败仅回退占位卡，不阻塞入库）
            if (kind === 'video') void ensureVideoThumbnail(key);
            set({ error: null, revision: get().revision + 1 });
            return mediaId;
        } catch (error) {
            set({ error: `媒体上传失败：${toMessage(error)}` });
            return null;
        } finally {
            // 任务收敛即摘除进度注册键（占位卡/横幅收口，成功失败同口径）
            clearUploadProgress(opts?.taskId);
        }
    },

    async removeEventMedia(mediaId) {
        try {
            // ① 先取行：软删后（或行本就不存在）无法再拿 file_key（所有查询过滤 deleted_at）
            const media = await db.getEventMedia(mediaId);
            if (!media) {
                set({ error: '媒体不存在或已删除' });
                return false;
            }
            // ② 行级软删（单行，无 updated_at 列，对齐 softDeleteTripMedia 口径）
            await db.softDeleteEventMedia(mediaId, Date.now());
            // ③ DB 级 blocks 引用摘除（事件正文块引用媒体 id，直接删行会留死引用；
            //    参照 appendMediaBlockToJournal 的 DB 权威改写）：blocks 无该引用时
            //    no-op 不回写。摘除后补「至少一个可落笔段」不变式（removeBlock 口径）。
            //    直写 db.updateEventBlocks 而非 updateEventBlocks action：对账已在
            //    ② 完成，避免二次对账/重复语义
            const event = await db.getEvent(media.event_id);
            if (event) {
                const blocks = parseBlocks(event.blocks);
                const stripped = blocks.filter(
                    (block) => !(block.t === 'media' && block.mediaId === mediaId),
                );
                if (stripped.length !== blocks.length) {
                    const next = stripped.some((block) => block.t === 'p')
                        ? stripped
                        : [...stripped, newParagraphBlock()];
                    await db.updateEventBlocks(event.id, serializeBlocks(next));
                }
            }
            // ④ 文件清理不阻塞行删除：失败聚合上浮（行已删，孤儿文件只浪费存储）
            const failures = await removeFilesBestEffort([media.file_key]);
            set({
                error: null,
                revision: get().revision + 1,
                ...(failures.length > 0
                    ? { error: `记录已删除，但媒体文件清理失败：${failures[0].message}` }
                    : {}),
            });
        } catch (error) {
            set({ error: `媒体删除失败：${toMessage(error)}` });
            return false;
        }
        return true;
    },

    async deleteEvent(id) {
        try {
            // ① 先收集文件 key：级联软删后媒体行不可见（所有查询过滤 deleted_at）
            const mediaRows = await db.listEventMediaByEvent(id);
            const fileKeys = mediaRows.map((row) => row.file_key);
            // ② 行级级联一个事务（事件 + 媒体行，软删）
            await db.softDeleteEventCascade(id, Date.now());
            // ③ 文件清理不阻塞行删除：失败聚合上浮（行已删，引用不会复活）
            const failures = await removeFilesBestEffort(fileKeys);
            set({
                error: null,
                revision: get().revision + 1,
                ...(failures.length > 0
                    ? { error: `事件已删除，但 ${failures.length} 个媒体文件清理失败：${failures[0].message}` }
                    : {}),
            });
        } catch (error) {
            set({ error: `事件删除失败：${toMessage(error)}` });
            return false;
        }
        return true;
    },

    async searchEvents(keyword, filter) {
        const trimmed = keyword.trim();
        const status = filter?.status;
        // 空 keyword 且无 status = 全量浏览（2026-11-19 用户指令「不管什么状态
        // 默认全有」：done/failed 也在搜索可见）
        if (!trimmed && !status) {
            const rows = await db.listEvents({});
            return rows.map(decorateEvent);
        }
        try {
            const rows = await db.searchEvents(trimmed, status ? { status } : {});
            return rows.map(decorateEvent);
        } catch (error) {
            set({ error: `事件搜索失败：${toMessage(error)}` });
            return [];
        }
    },

    async ensureTodayJournal() {
        return get().ensureJournal(null, todayLocal());
    },

    /** 取或建某归属日的日记（日常 null / 行程内某天）；open 状态才可写。
     *  独立计划（v8）不经此路径——显式新建走 createPlan，计划无归属日语义。 */
    async ensureJournal(tripId: string | null, date: string) {
        try {
            const existing = await db.getJournalByDate(tripId, date);
            if (existing) return existing;
            const now = Date.now();
            const row: JournalRow = {
                id: crypto.randomUUID(),
                trip_id: tripId,
                local_date: date,
                title: null, // 新页默认未命名（v4 标题可空）
                kind: 'daily', // 日记实体（v8）：ensureJournal 只建日记，计划走 createPlan
                description: '', // 日记无描述语义（v8 列默认值，显式落 ''）
                blocks: serializeBlocks([newParagraphBlock()]),
                status: 'open',
                word_count: 0,
                created_at: now,
                updated_at: now,
                completed_at: null,
                deleted_at: null,
            };
            // 同日唯一索引（迁移 v3）兜底并发：StrictMode 双 effect / 快速双击时 OR IGNORE
            // 挡下重复行，回读并发方已建的行返回——ensureJournal 语义不变（返回该日 journal）
            const inserted = await db.insertJournalIfAbsent(row);
            if (!inserted) {
                const winner = await db.getJournalByDate(tripId, date);
                if (!winner) throw new Error('日记同日唯一冲突后回读失败');
                return winner;
            }
            set({ revision: get().revision + 1 });
            return row;
        } catch (error) {
            set({ error: `日记初始化失败：${toMessage(error)}` });
            return null;
        }
    },

    async saveJournalBlocks(journalId, blocks) {
        // 序列化/落库前滤掉上传中的 pending 占位块：占位 mediaId 在 journal_media 无对应行，
        // 落库会让读取侧渲染坏引用；上传完成由屏层回填真实块后自然会再存
        const persistable = blocks.filter(
            (block) => !(block.t === 'media' && block.mediaId === PENDING_MEDIA_ID),
        );
        set({ savingJournal: true });
        // 对账基准时刻（回填竞态保护）：只清 created_at 早于本次 blocks 落库的媒体行。
        // 插入流顺序 = attachJournalMedia 先建行落盘 → 屏层回填真实块 → 下一次保存带
        // 引用——晚于本时刻建的行必属进行中的插入流（其引用此刻尚未持久化），本轮
        // 对账绝不误杀，回填后的保存自然对上引用；PENDING 占位块已被滤除，不产生引用。
        const persistedAt = Date.now();
        try {
            await db.updateJournalBlocks(journalId, serializeBlocks(persistable), wordCount(persistable));
        } catch (error) {
            set({ error: `保存失败：${toMessage(error)}`, savingJournal: false });
            return false;
        }
        // 引用对账（DEV.md #1.1 数据面闭环）：编辑器删媒体块只摘 blocks 引用
        // （journal-logic.removeBlock 软删语义，不动媒体行），孤儿 journal_media 行
        // 在落库后统一回收——图片/视频/音频同口径。行软删（复用 deleted_at 列）+
        // 文件尽力清理：失败聚合上浮 error、不推翻已落库正文（对齐 deleteTrip 口径：
        // 行已删引用不会复活，文件失败只影响存储回收）。
        let fileFailures: { key: string; message: string }[] = [];
        try {
            const referenced = new Set(
                persistable.flatMap((block) => (block.t === 'media' ? [block.mediaId] : [])),
            );
            const rows = (await db.mediaByJournalIds([journalId])).get(journalId) ?? [];
            const orphans = rows.filter(
                (row) => !referenced.has(row.id) && row.created_at <= persistedAt,
            );
            if (orphans.length > 0) {
                await db.softDeleteJournalMediaByIds(orphans.map((row) => row.id), Date.now());
                fileFailures = await removeFilesBestEffort(orphans.map((row) => row.file_key));
            }
        } catch (error) {
            // 对账链路失败（查询/软删异常）不阻塞保存结果：正文已落库，文案上浮可重试
            set({ error: `计划已保存，但孤儿媒体清理失败：${toMessage(error)}`, savingJournal: false });
            return true;
        }
        set({
            error: null,
            revision: get().revision + 1,
            savingJournal: false,
            ...(fileFailures.length > 0
                ? {
                      error: `计划已保存，但 ${fileFailures.length} 个媒体文件清理失败：${fileFailures[0].message}`,
                  }
                : {}),
        });
        return true;
    },

    async completeJournal(journalId) {
        try {
            await db.completeJournal(journalId);
        } catch (error) {
            set({ error: `收笔失败：${toMessage(error)}` });
            return;
        }
        set({ error: null, revision: get().revision + 1 });
        await get().loadAll();
    },

    async reopenJournal(journalId) {
        try {
            await db.reopenJournal(journalId);
        } catch (error) {
            set({ error: `重开失败：${toMessage(error)}` });
            return;
        }
        set({ error: null, revision: get().revision + 1 });
    },

    async updateJournalTitle(journalId, title) {
        try {
            // 锁定预检（#7）：closed = 只读，标题与正文同口径不可改（UI 侧入口先挡，这里兜底）
            const journal = await db.getJournal(journalId);
            if (!journal) {
                set({ error: '计划不存在或已删除' });
                return false;
            }
            if (!isEditable(journal.status)) {
                set({ error: '已收笔的计划不可修改' });
                return false;
            }
            await db.updateJournalTitle(journalId, normalizeJournalTitle(title));
        } catch (error) {
            set({ error: `标题保存失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
        return true;
    },

    async deleteJournal(journalId) {
        try {
            // 先收集文件 key（级联软删后媒体行不可见），再行级级联，最后清文件
            const media = await db.mediaByJournalIds([journalId]);
            const fileKeys = (media.get(journalId) ?? []).map((row) => row.file_key);
            await db.softDeleteJournalCascade(journalId, Date.now());
            const failures = await removeFilesBestEffort(fileKeys);
            set({
                error: null,
                revision: get().revision + 1,
                ...(failures.length > 0
                    ? { error: `计划已删除，但 ${failures.length} 个媒体文件清理失败：${failures[0].message}` }
                    : {}),
            });
        } catch (error) {
            set({ error: `计划删除失败：${toMessage(error)}` });
            return false;
        }
        await get().loadAll();
        return true;
    },

    async attachJournalMedia(journalId, kind, uri, width, height, opts) {
        const sink = makeProgressSink(opts?.taskId, opts?.onProgress);
        try {
            const mediaId = crypto.randomUUID();
            // 音频分支：容器/扩展名按字节头核对（native m4a、web webm，见
            // audioExtFromBytes）；空字节录音（stop-before-record 等坏产物）
            // 拒绝入库——坏块落库后播放必败，不如在此给明确错误。嗅探需要
            // 字节（体量分钟级 ≤ 数 MB，字节路径保留），先读后写
            let ext = mediaFileExt(kind);
            if (kind === 'audio') {
                const bytes = await readUriBytes(uri);
                if (bytes.byteLength === 0) {
                    throw new Error('录音文件为空，请重试');
                }
                ext = audioExtFromBytes(bytes);
            }
            const key = `journal-media/${journalId}/${mediaId}.${ext}`;
            // 落盘分流（2026-11-08 落盘异步化）：
            // - video：大文件直迁——native 原生 move/copy（JS 线程零字节拷贝，
            //   原生 SHA-256）或 web 流式分块（主线程让步）；录像/录音 cache
            //   产物 moveSource = true（原件移走零残留，cache 清理天然兼容），
            //   相册产物 copy（不动原件）。旧「全量字节读进 JS + JS 算哈希 +
            //   全量回写」路径是保存卡住界面的根因，就此退役；
            // - audio：字节路径保留（体量小 + 嗅探已需字节）；
            // - image：manipulator 产物字节路径（≤ 数 MB）。
            if (kind === 'video') {
                if (opts?.moveSource) {
                    await fileStorage.moveFromUri(key, uri, { onProgress: sink });
                } else {
                    await fileStorage.copyFromUri(key, uri, { onProgress: sink });
                }
            } else if (kind === 'audio') {
                await fileStorage.put(key, await readUriBytes(uri));
            } else {
                const prepared = await prepareImageBytes(uri, width);
                width = prepared.width;
                height = prepared.height;
                await fileStorage.put(key, prepared.bytes);
            }
            try {
                await db.insertJournalMedia({
                    id: mediaId,
                    journal_id: journalId,
                    file_key: key,
                    kind,
                    width,
                    height,
                    created_at: Date.now(),
                });
            } catch (dbError) {
                // 落库失败回滚已落盘文件（不留孤儿字节，对齐 DEV.md #1.1 口径）；
                // 清理失败不掩盖原始入库错误（孤儿文件只浪费存储，不再被引用）
                await fileStorage.remove(key).catch(() => undefined);
                throw dbError;
            }
            // 缩略图是展示增强（deck 露边层真封面）：生成失败不阻塞入库（fire
            // -and-forget，失败仅 warn + 占位卡回退，见 ensureVideoThumbnail 注）
            if (kind === 'video') void ensureVideoThumbnail(key);
            set({ error: null, revision: get().revision + 1 });
            return mediaId;
        } catch (error) {
            set({ error: `媒体上传失败：${toMessage(error)}` });
            return null;
        } finally {
            // 任务收敛即摘除进度注册键（占位卡/横幅收口，成功失败同口径）
            clearUploadProgress(opts?.taskId);
        }
    },

    async appendMediaBlockToJournal(journalId, media) {
        try {
            // DB 权威读取（不经过任何屏的本地态——owner 屏可能未挂载/在栈下/
            // 已卸载，本地 blocksRef 不可信）
            const row = await db.getJournal(journalId);
            if (!row) {
                set({ error: '计划不存在或已删除，录音没有落点。' });
                return false;
            }
            // #7 只读语义兜底：发起后计划被收笔（手动/24:00 自动）→ 拒绝追加
            if (!isEditable(row.status)) {
                set({ error: '这篇计划已收笔，录音素材未能保存。' });
                return false;
            }
            const blocks = parseBlocks(row.blocks);
            // 幂等闸：owner 屏在 DB 写入前经 persist 事件合并进本地态并抢先保存
            // （blocks 已带引用）→ 不重复追加，直接成功
            if (blocks.some((block) => block.t === 'media' && block.mediaId === media.mediaId)) {
                return true;
            }
            // 块 id 在 store 层生成（与屏层 newBlockId 同源）；durationMs 仅音频携带
            const appended: JournalBlock = {
                t: 'media',
                id: newBlockId(),
                mediaId: media.mediaId,
                ...(media.durationMs != null ? { durationMs: media.durationMs } : {}),
            };
            const next = [...blocks, appended];
            // 直接 updateJournalBlocks（非 saveJournalBlocks）：这里是「新增引用」，
            // 不需要孤儿对账，也不该动 savingJournal 指示器；媒体行刚由
            // attachJournalMedia 建立，引用随写随闭合
            await db.updateJournalBlocks(journalId, serializeBlocks(next), wordCount(next));
            set({ error: null, revision: get().revision + 1 });
            return true;
        } catch (error) {
            set({ error: `媒体块追加失败：${toMessage(error)}` });
            return false;
        }
    },

    async appendMediaBlockToEvent(eventId, media) {
        try {
            // DB 权威读取（不经过任何屏的本地态——owner 屏可能未挂载/在栈下/
            // 已卸载，本地 blocksRef 不可信）
            const row = await db.getEvent(eventId);
            if (!row) {
                set({ error: '事件不存在或已删除，素材没有落点。' });
                return false;
            }
            // 事件无收笔锁定语义（open/done 均可编辑），不做 #7 只读闸；
            // 归属目标已删除的场景由上方存在性预检兜住
            const blocks = parseBlocks(row.blocks);
            // 幂等闸：owner 屏在 DB 写入前经 persist 事件合并进本地态并抢先保存
            // （blocks 已带引用）→ 不重复追加，直接成功
            if (blocks.some((block) => block.t === 'media' && block.mediaId === media.mediaId)) {
                return true;
            }
            // 块 id 在 store 层生成（与屏层 newBlockId 同源）；durationMs 仅音频携带
            const appended: JournalBlock = {
                t: 'media',
                id: newBlockId(),
                mediaId: media.mediaId,
                ...(media.durationMs != null ? { durationMs: media.durationMs } : {}),
            };
            const next = [...blocks, appended];
            // 直接 updateEventBlocks（非 updateEventBlocks action 的对账版）：这里是
            // 「新增引用」，不需要孤儿对账；媒体行刚由 attachEventMedia 建立，引用
            // 随写随闭合。事件表无 word_count 冗余列（字数按需派生）
            await db.updateEventBlocks(eventId, serializeBlocks(next));
            set({ error: null, revision: get().revision + 1 });
            return true;
        } catch (error) {
            set({ error: `媒体块追加失败：${toMessage(error)}` });
            return false;
        }
    },
}));

// ─── 数据变化广播（v5 require cycle 修复的接线）────────────────────────────
// zustand revision 仍是单一事实源；这里把它的变化转发到中立层 data-revision，
// ui 层用 useDataRevision()（useSyncExternalStore）订阅，不再 import store。
// 转发而非双写：所有 mutation 只改 revision 一处，两条订阅链永不漂移。
useArchiveStore.subscribe((state, prev) => {
    if (state.revision !== prev.revision) notifyDataRevision();
});

/**
 * 供时间线之外的自持界面感知数据变化（屏层/路由层用；ui/ 组件层一律改用
 * data-revision.useDataRevision，禁止 ui 文件 import store——cycle 已拆除，勿回填）。
 */
export function useArchiveRevision(): number {
    return useArchiveStore((state) => state.revision);
}
