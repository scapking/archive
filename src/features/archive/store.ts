import { create } from 'zustand';
import { crypto } from '@/core/crypto';
import { fileStorage, readUriBytes } from '@/core/file-storage';
import { imageManipulator } from '@/core/image-manipulator';
import * as db from './db';
import { PENDING_MEDIA_ID, TRIP_OPEN_ENDED } from './db';
import type { JournalBlock, JournalMediaKind, TripMediaKind, TripRow } from './db';
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
    newParagraphBlock,
    normalizeJournalTitle,
    parseBlocks,
    serializeBlocks,
    streakFromDates,
    wordCount,
    type JournalRow,
} from './journal-logic';
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
    /** 编辑器插图/视频：落 file-storage + 建媒体行，返回 mediaId 供块引用。 */
    attachJournalMedia(journalId: string, kind: JournalMediaKind, uri: string, width: number | null, height: number | null): Promise<string | null>;
}

function toMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

/** 媒体落盘前的统一准备：图片经 manipulator 缩边（超出才缩），视频/音频源字节直落。 */
async function prepareMediaBytes(
    kind: JournalMediaKind | TripMediaKind,
    uri: string,
    width: number | null,
    height: number | null,
): Promise<{ bytes: Uint8Array; width: number | null; height: number | null }> {
    if (kind === 'image') {
        const actions = width && width > IMAGE_MAX_WIDTH ? [{ resize: { width: IMAGE_MAX_WIDTH } }] : [];
        const manipulated = await imageManipulator.manipulateAsync(uri, actions);
        return { bytes: manipulated.bytes, width: manipulated.width, height: manipulated.height };
    }
    // 视频/音频不经 manipulator：源文件字节直落
    return { bytes: await readUriBytes(uri), width, height };
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

/**
 * 尽力而为的文件清理：单个失败不阻塞其余（DEV.md #1.1「文件删除失败不阻塞行删除」），
 * 返回失败清单交调用方聚合上报——行已删，引用不会复活，失败只影响存储回收。
 */
async function removeFilesBestEffort(keys: string[]): Promise<{ key: string; message: string }[]> {
    const failures: { key: string; message: string }[] = [];
    await Promise.all(
        keys.map(async (key) => {
            try {
                await fileStorage.remove(key);
            } catch (error) {
                failures.push({ key, message: toMessage(error) });
            }
        }),
    );
    return failures;
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
            await fileStorage.putFromUri(key, uri);
            return await get().updateTrip(tripId, { videoKey: key });
        } catch (error) {
            set({ error: `视频上传失败：${toMessage(error)}` });
            return false;
        }
    },

    async attachTripMedia(tripId, kind, uri, width, height, durationMs = null) {
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
            const prepared = await prepareMediaBytes(kind, uri, width, height);
            await fileStorage.put(key, prepared.bytes);
            await db.insertTripMedia({
                id: mediaId,
                trip_id: tripId,
                file_key: key,
                kind,
                width: prepared.width,
                height: prepared.height,
                duration_ms: durationMs,
                created_at: Date.now(),
            });
            set({ error: null, revision: get().revision + 1 });
            return mediaId;
        } catch (error) {
            set({ error: `媒体上传失败：${toMessage(error)}` });
            return null;
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
            const prepared = await prepareMediaBytes('image', uri, width, height);
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

    async attachJournalMedia(journalId, kind, uri, width, height) {
        try {
            const mediaId = crypto.randomUUID();
            const prepared = await prepareMediaBytes(kind, uri, width, height);
            // 音频分支：容器/扩展名按字节头核对（native m4a、web webm，见
            // audioExtFromBytes）；空字节录音（stop-before-record 等坏产物）
            // 拒绝入库——坏块落库后播放必败，不如在此给明确错误
            let ext = mediaFileExt(kind);
            if (kind === 'audio') {
                if (prepared.bytes.byteLength === 0) {
                    throw new Error('录音文件为空，请重试');
                }
                ext = audioExtFromBytes(prepared.bytes);
            }
            const key = `journal-media/${journalId}/${mediaId}.${ext}`;
            await fileStorage.put(key, prepared.bytes);
            try {
                await db.insertJournalMedia({
                    id: mediaId,
                    journal_id: journalId,
                    file_key: key,
                    kind,
                    width: prepared.width,
                    height: prepared.height,
                    created_at: Date.now(),
                });
            } catch (dbError) {
                // 落库失败回滚已落盘文件（不留孤儿字节，对齐 DEV.md #1.1 口径）；
                // 清理失败不掩盖原始入库错误（孤儿文件只浪费存储，不再被引用）
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
