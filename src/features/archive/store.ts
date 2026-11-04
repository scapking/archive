import { create } from 'zustand';
import { crypto } from '@/core/crypto';
import { fileStorage, readUriBytes } from '@/core/file-storage';
import { imageManipulator } from '@/core/image-manipulator';
import * as db from './db';
import type { JournalBlock, JournalMediaKind } from './db';
import { addDaysLocal, decorateTrip, pickDeckTrip, todayLocal, type Trip } from './trip-logic';
import {
    curveSeries,
    parseBlocks,
    serializeBlocks,
    streakFromDates,
    wordCount,
    type JournalRow,
} from './journal-logic';

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
    /** deck 数据由屏层派生：trips + 今天日记（loadAll 后即可取）。 */
    deck(): DeckData;
    createTrip(input: { title: string; startDate: string; endDate: string; description: string; icon: string | null }): Promise<Trip | null>;
    updateTrip(id: string, patch: { title?: string; startDate?: string; endDate?: string; description?: string; icon?: string | null; videoKey?: string | null }): Promise<boolean>;
    deleteTrip(id: string): Promise<boolean>;
    /** 行程封面视频：落 file-storage，回写 video_key。 */
    attachTripVideo(tripId: string, uri: string): Promise<boolean>;
    ensureTodayJournal(): Promise<JournalRow | null>;
    ensureJournal(tripId: string | null, date: string): Promise<JournalRow | null>;
    /** 编辑器防抖保存入口（blocks 已在内存，这里只落库）。 */
    saveJournalBlocks(journalId: string, blocks: JournalBlock[]): Promise<void>;
    completeJournal(journalId: string): Promise<void>;
    /** 重开当天的收笔页（仅当天；历史页不可重开）。 */
    reopenJournal(journalId: string): Promise<void>;
    /** 编辑器插图/视频：落 file-storage + 建媒体行，返回 mediaId 供块引用。 */
    attachJournalMedia(journalId: string, kind: JournalMediaKind, uri: string, width: number | null, height: number | null): Promise<string | null>;
}

function toMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
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
                trips: tripRows.map((row) => {
                    const trip = decorateTrip(row);
                    const s = stats.get(row.id);
                    return { ...trip, journalDays: s?.journalDays ?? 0, plansTotal: s?.plansTotal ?? 0, plansDone: s?.plansDone ?? 0 };
                }),
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

    async createTrip({ title, startDate, endDate, description, icon }) {
        const now = Date.now();
        const row = {
            id: crypto.randomUUID(),
            title: title.trim(),
            start_date: startDate,
            end_date: endDate,
            note: '',
            description: description.trim(),
            icon,
            video_key: null,
            cover_key: null,
            created_at: now,
            updated_at: now,
        };
        try {
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
                ...(patch.endDate !== undefined ? { end_date: patch.endDate } : {}),
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
            await db.softDeleteTrip(id);
        } catch (error) {
            set({ error: `行程删除失败：${toMessage(error)}` });
            return false;
        }
        set({ error: null, revision: get().revision + 1 });
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
                blocks: serializeBlocks([{ t: 'p', text: '' }]),
                status: 'open',
                word_count: 0,
                created_at: now,
                updated_at: now,
                completed_at: null,
                deleted_at: null,
            };
            await db.insertJournal(row);
            set({ revision: get().revision + 1 });
            return row;
        } catch (error) {
            set({ error: `日记初始化失败：${toMessage(error)}` });
            return null;
        }
    },

    async saveJournalBlocks(journalId, blocks) {
        set({ savingJournal: true });
        try {
            await db.updateJournalBlocks(journalId, serializeBlocks(blocks), wordCount(blocks));
        } catch (error) {
            set({ error: `保存失败：${toMessage(error)}`, savingJournal: false });
            return;
        }
        set({ error: null, revision: get().revision + 1, savingJournal: false });
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

    async attachJournalMedia(journalId, kind, uri, width, height) {
        try {
            const ext = kind === 'video' ? 'mp4' : 'jpg';
            let w = width;
            let h = height;
            let bytes: Uint8Array;
            if (kind === 'image') {
                const actions = width && width > IMAGE_MAX_WIDTH ? [{ resize: { width: IMAGE_MAX_WIDTH } }] : [];
                const manipulated = await imageManipulator.manipulateAsync(uri, actions);
                bytes = manipulated.bytes;
                w = manipulated.width;
                h = manipulated.height;
            } else {
                // 视频不经 manipulator：源文件字节直落
                bytes = await readUriBytes(uri);
            }
            const mediaId = crypto.randomUUID();
            const key = `journal-media/${journalId}/${mediaId}.${ext}`;
            await fileStorage.put(key, bytes);
            await db.insertJournalMedia({
                id: mediaId,
                journal_id: journalId,
                file_key: key,
                kind,
                width: w,
                height: h,
                created_at: Date.now(),
            });
            set({ error: null, revision: get().revision + 1 });
            return mediaId;
        } catch (error) {
            set({ error: `媒体上传失败：${toMessage(error)}` });
            return null;
        }
    },
}));

/** 供时间线之外的自持界面感知数据变化（如行程详情在写日记返回后重载）。 */
export function useArchiveRevision(): number {
    return useArchiveStore((state) => state.revision);
}
