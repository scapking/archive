import { create } from 'zustand';
import { crypto } from '@/core/crypto';
import { fileStorage } from '@/core/file-storage';
import { imageManipulator } from '@/core/image-manipulator';
import * as db from './db';
import type { EntryMood } from './db';
import { decorateTrip, todayLocal, type Trip } from './trip-logic';
import { groupEntriesByDate, type TimelineGroup } from './entry-logic';

/**
 * archive 域会话状态（glossary §2：state 归 feature 内 zustand store）。
 * 数据真身在 archive.db；store 只做加载/变更编排 + 响应式通知。
 * mutation 后统一 bump revision——行程详情屏等自持状态的界面据此重载。
 */

/** 长边上限：时间线缩略图与落盘体积的平衡点（超出才缩，不放大）。 */
const PHOTO_MAX_WIDTH = 2048;

export interface TripCard extends Trip {
    entryCount: number;
}

/** 撰写中的图片（picker 产物，保存时统一压缩落盘）。 */
export interface PickedPhoto {
    uri: string;
    width: number;
    height: number;
}

export interface CreateEntryInput {
    tripId: string | null;
    localDate: string;
    content: string;
    mood: EntryMood | null;
    photos: PickedPhoto[];
}

interface ArchiveStore {
    ready: boolean;
    /** 最近一次数据操作失败的文案（界面在标题行下方展示；读操作失败可重试） */
    error: string | null;
    revision: number;
    trips: TripCard[];
    timeline: TimelineGroup[];

    loadAll(): Promise<void>;
    createTrip(input: { title: string; startDate: string; endDate: string; note: string }): Promise<Trip | null>;
    createEntry(input: CreateEntryInput): Promise<boolean>;
}

function toMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

export const useArchiveStore = create<ArchiveStore>((set, get) => ({
    ready: false,
    error: null,
    revision: 0,
    trips: [],
    timeline: [],

    async loadAll() {
        try {
            const [tripRows, entryCounts, entries, entryIds] = await (async () => {
                const tripRows = await db.listTrips();
                const entryCounts = await db.countEntriesByTrip();
                const entries = await db.listRecentEntries();
                return [tripRows, entryCounts, entries, entries.map((e) => e.id)] as const;
            })();
            const photosByEntry = await db.listPhotosByEntries(entryIds);
            set({
                ready: true,
                error: null,
                trips: tripRows.map((row) => ({
                    ...decorateTrip(row),
                    entryCount: entryCounts.get(row.id) ?? 0,
                })),
                timeline: groupEntriesByDate(entries, photosByEntry),
            });
        } catch (error) {
            // 降级语义：数据可重试加载，界面上以 error 文案提示（R3 ②）
            set({ ready: true, error: `数据加载失败：${toMessage(error)}` });
        }
    },

    async createTrip({ title, startDate, endDate, note }) {
        const now = Date.now();
        const row = {
            id: crypto.randomUUID(),
            title: title.trim(),
            start_date: startDate,
            end_date: endDate,
            note: note.trim(),
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
        return decorateTrip(row);
    },

    async createEntry({ tripId, localDate, content, mood, photos }) {
        const now = Date.now();
        const entryId = crypto.randomUUID();

        // 先落文件再插行：文件不可事务化，行插入失败只会留下无主文件（可离线清理，不影响一致性）
        const photoRows: Omit<db.PhotoRow, 'deleted_at'>[] = [];
        try {
            for (let i = 0; i < photos.length; i++) {
                const picked = photos[i];
                const actions =
                    picked.width > PHOTO_MAX_WIDTH ? [{ resize: { width: PHOTO_MAX_WIDTH } }] : [];
                const manipulated = await imageManipulator.manipulateAsync(picked.uri, actions);
                const fileKey = `photos/${entryId}/${i}.jpg`;
                await fileStorage.put(fileKey, manipulated.bytes);
                photoRows.push({
                    id: crypto.randomUUID(),
                    entry_id: entryId,
                    file_key: fileKey,
                    width: manipulated.width,
                    height: manipulated.height,
                    sort_order: i,
                    created_at: now,
                });
            }
            await db.insertEntry({
                id: entryId,
                trip_id: tripId,
                local_date: localDate,
                content: content.trim(),
                mood,
                created_at: now,
                updated_at: now,
            });
            for (const row of photoRows) await db.insertPhoto(row);
        } catch (error) {
            set({ error: `碎片保存失败：${toMessage(error)}` });
            return false;
        }
        set({ revision: get().revision + 1 });
        await get().loadAll();
        return true;
    },
}));

/** 供时间线之外的自持界面感知数据变化（如行程详情在写碎片返回后重载）。 */
export function useArchiveRevision(): number {
    return useArchiveStore((state) => state.revision);
}

/** 行程归属的碎片日期默认值：详情入口带 date 参数，时间线入口归今天。 */
export function defaultEntryDate(date?: string): string {
    return date ?? todayLocal();
}
