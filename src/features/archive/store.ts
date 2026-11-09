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
import * as db from './db';
import { PENDING_MEDIA_ID, TRIP_OPEN_ENDED } from './db';
import type {
    EventMediaKind,
    EventRow,
    EventStatus,
    EventSubjectKind,
    JournalBlock,
    JournalMediaKind,
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
    type Trip,
} from './trip-logic';
import {
    curveSeries,
    isEditable,
    newBlockId,
    newParagraphBlock,
    normalizeJournalTitle,
    parseBlocks,
    serializeBlocks,
    streakFromDates,
    wordCount,
    type JournalRow,
} from './journal-logic';
// 事件纯逻辑（v6）：校验/归一化/装饰统一走纯函数模块，store 只做编排
import {
    EVENT_DESCRIPTION_MAX,
    EVENT_HANDLED_BY_MAX,
    decorateEvent,
    isEventStatus,
    isEventSubjectKind,
    isValidGpsAccuracy,
    isValidGpsCoordinate,
    newEventBlocksJson,
    normalizeEventSubject,
    normalizeEventText,
    validateEventInput,
    type Event,
} from './event-logic';
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

export interface MeMetrics {
    streak: number;
    journalDays: number;
    totalWords: number;
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
     */
    attachTripMedia(
        tripId: string,
        kind: TripMediaKind,
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number | null,
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
    /**
     * 清除日卡背景：摘指针行 + 背景媒体行软删 + 文件尽力清理（清的是行程内
     * 副本，源图仍在系统相册，无需确认）；无背景时幂等成功。已结束行程拒绝（#7）。
     */
    clearTripDayBackground(tripId: string, date: string): Promise<boolean>;
    /** 行程搜索（DEV.md #5）：标题+描述 LIKE，range 为行程区间与 [from, to] 相交。 */
    searchTrips(keyword: string, range?: { from?: string; to?: string }): Promise<TripCard[]>;
    /** 笔记搜索（DEV.md #5 扩展）：正文/标题 LIKE + local_date ∈ [from, to]。 */
    searchJournals(keyword: string, range?: { from?: string; to?: string }): Promise<JournalRow[]>;
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
     * 事件元信息更新（status/handledBy/subject 对/description/gps，均可选）：
     * - subject 为原子对：kind/value 任一侧出现在 patch 即合并当前行后整体归一化
     *   （显式 null = 清除该侧；归一化后任一侧缺失 → 双双置空）；
     * - gps：undefined = 不动；null = 清除；对象 = 覆盖写（非法坐标整体拒绝）；
     * - status 仅接受 'open' | 'done'。true = 成功。
     */
    updateEventMeta(
        eventId: string,
        patch: {
            status?: EventStatus;
            handledBy?: string | null;
            subjectKind?: EventSubjectKind | null;
            subjectValue?: string | null;
            description?: string | null;
            gps?: { lat: number; lng: number; accuracy?: number } | null;
        },
    ): Promise<boolean>;
    /**
     * 事件媒体（v6）：对齐 attachTripMedia——落盘分流（视频 copyFromUri 直迁、
     * 图片 manipulator 字节路径、音频字节落盘+容器嗅探）+ 落库，返回 mediaId 供
     * blocks 引用；缩略图增强可选不做（v6 取舍）。落盘 key：
     * event-media/<eventId>/<mediaId>.<ext>。
     */
    attachEventMedia(
        eventId: string,
        kind: EventMediaKind,
        uri: string,
        width: number | null,
        height: number | null,
        durationMs?: number | null,
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
     * 事件搜索（v6）：关键词四通道 LIKE（title/description/subject_value/
     * handled_by）+ 状态筛选，updated_at DESC。空 keyword 且无 status 返回空
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
    /** 笔记标题（v4，DEV.md #6）：空串 = 清除；已收笔（closed）不可改（#7 只读语义）。 */
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
     * 保存的场景，不产生重复块）。已收笔（closed）/ 已删除的笔记拒绝（#7
     * 只读语义 + 归属目标失效兜底）。true = 追加成功（含幂等命中）。
     */
    appendMediaBlockToJournal(journalId: string, media: { mediaId: string; kind: JournalMediaKind; durationMs?: number }): Promise<boolean>;
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
    metrics: { streak: 0, journalDays: 0, totalWords: 0, curve: [] },
    mediaUploadProgress: {},

    async loadAll() {
        try {
            const today = todayLocal();
            // 本地时区 24:00 自动收笔：加载即收口昨日及更早的 open 日记
            await db.closeStaleOpenJournals(today);
            const [tripRows, stats, totals, dates] = await Promise.all([
                db.listTrips(),
                db.tripStats(),
                db.journalTotals(),
                db.journalDates(),
            ]);
            // 曲线窗口覆盖最近 30 天
            const window30 = await db.wordCountByDate(addDaysLocal(today, -29));
            set({
                ready: true,
                error: null,
                trips: toTripCards(tripRows, stats),
                metrics: {
                    streak: streakFromDates(dates, today),
                    journalDays: totals.journalDays,
                    totalWords: totals.totalWords,
                    curve: curveSeries(window30, 30, today),
                },
            });
        } catch (error) {
            // 降级语义：数据可重试加载，界面上以 error 文案提示（R3 ②）
            set({ ready: true, error: `数据加载失败：${toMessage(error)}` });
        }
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
            // ① 先收集文件 key：级联软删后行不可见（所有查询过滤 deleted_at IS NULL）。
            //    封面视频 video_key 一并回收（首页卡片「删了还引用」的直接来源之一）。
            const [trip, journalRows] = await Promise.all([db.getTrip(id), db.listJournalsByTrip(id)]);
            const journalMedia = await db.mediaByJournalIds(journalRows.map((row) => row.id));
            const tripMediaRows = await db.listTripMediaByTrip(id);
            const fileKeys = [
                ...journalRows.flatMap((row) => (journalMedia.get(row.id) ?? []).map((m) => m.file_key)),
                ...tripMediaRows.map((m) => m.file_key),
                ...(trip?.video_key ? [trip.video_key] : []),
            ];
            // ② 行级级联一个事务（日记/日记媒体/行程媒体/逐日计划/行程本体，软删）
            await db.softDeleteTripCascade(id, Date.now());
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

    async attachTripMedia(tripId, kind, uri, width, height, durationMs = null, opts?: AttachMediaOptions) {
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

    async clearTripDayBackground(tripId, date) {
        try {
            // 预检（#7）：与设置背景同口径（UI 侧锁定态无长按入口，这里兜底）
            const trip = await db.getTrip(tripId);
            if (!trip) {
                set({ error: '行程不存在或已删除' });
                return false;
            }
            if (isTripLocked(trip)) {
                set({ error: '行程已结束，内容锁定，不能修改背景' });
                return false;
            }
            // 摘指针 → 行软删 → 文件尽力清理（对齐 removeTripMedia 分工；
            // 源图在系统相册，清的只是行程内副本，无需二次确认）。
            // 指针摘除后的清理段自带兜底：清除已生效，失败只聚合上浮、不拦 revision bump
            const oldMediaId = await db.getTripDayBackgroundMediaId(tripId, date);
            if (!oldMediaId) return true; // 幂等：本来就没有背景
            await db.removeTripDayBackground(tripId, date);
            let cleanupError: string | null = null;
            try {
                const oldRow = await db.getTripMedia(oldMediaId);
                if (oldRow) {
                    await db.softDeleteTripMedia(oldRow.id, Date.now());
                    const failures = await removeFilesBestEffort([oldRow.file_key]);
                    if (failures.length > 0) {
                        cleanupError = `背景已清除，但图片文件清理失败：${failures[0].message}`;
                    }
                }
            } catch (cleanupCaught) {
                cleanupError = `背景已清除，但旧图清理失败：${toMessage(cleanupCaught)}`;
            }
            set({ error: cleanupError, revision: get().revision + 1 });
            return true;
        } catch (error) {
            set({ error: `背景清除失败：${toMessage(error)}` });
            return false;
        }
    },

    async searchTrips(keyword, range) {
        const rangeError = invalidSearchRangeError(range);
        if (rangeError) {
            set({ error: rangeError });
            return [];
        }
        const trimmed = keyword.trim();
        // 空 keyword 且无范围 → 不做无界全量兜底（调用方语义错误应显式给范围）
        if (!trimmed && !range?.from && !range?.to) return [];
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
        if (!trimmed && !range?.from && !range?.to) return [];
        try {
            return await db.searchJournals(trimmed, { from: range?.from, to: range?.to });
        } catch (error) {
            set({ error: `笔记搜索失败：${toMessage(error)}` });
            return [];
        }
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
                ...(status !== undefined ? { status } : {}),
                ...(patch.handledBy !== undefined
                    ? { handled_by: normalizeEventText(patch.handledBy, EVENT_HANDLED_BY_MAX) }
                    : {}),
                ...(patch.description !== undefined
                    ? { description: normalizeEventText(patch.description, EVENT_DESCRIPTION_MAX) }
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

    async attachEventMedia(eventId, kind, uri, width, height, durationMs = null) {
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
            // 落盘分流（对齐 attachTripMedia/attachJournalMedia）：视频 copyFromUri
            // 直迁（本签名无 moveSource 选项——事件媒体统一 copy 语义，不动源文件），
            // 图片 manipulator 字节路径，音频字节落盘
            if (kind === 'video') {
                await fileStorage.copyFromUri(key, uri);
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
            set({ error: null, revision: get().revision + 1 });
            return mediaId;
        } catch (error) {
            set({ error: `媒体上传失败：${toMessage(error)}` });
            return null;
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
        // 空 keyword 且无 status = 无界全量，拒绝（全量列表语义走 db.listEvents）
        if (!trimmed && !status) return [];
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

    /** 取或建某归属日的日记（日常 null / 行程内某天）；open 状态才可写。 */
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
            set({ error: `笔记已保存，但孤儿媒体清理失败：${toMessage(error)}`, savingJournal: false });
            return true;
        }
        set({
            error: null,
            revision: get().revision + 1,
            savingJournal: false,
            ...(fileFailures.length > 0
                ? {
                      error: `笔记已保存，但 ${fileFailures.length} 个媒体文件清理失败：${fileFailures[0].message}`,
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
                set({ error: '笔记不存在或已删除' });
                return false;
            }
            if (!isEditable(journal.status)) {
                set({ error: '已收笔的笔记不可修改' });
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
                    ? { error: `笔记已删除，但 ${failures.length} 个媒体文件清理失败：${failures[0].message}` }
                    : {}),
            });
        } catch (error) {
            set({ error: `笔记删除失败：${toMessage(error)}` });
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
                set({ error: '笔记不存在或已删除，录音没有落点。' });
                return false;
            }
            // #7 只读语义兜底：发起后笔记被收笔（手动/24:00 自动）→ 拒绝追加
            if (!isEditable(row.status)) {
                set({ error: '这篇笔记已收笔，录音素材未能保存。' });
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
