import { openDatabase } from '@/core/database';
import { ARCHIVE_MIGRATIONS } from './migrations';
import type { DayPlanRow, EntryRow, PhotoRow, TripRow } from './schema';

export type { DayPlanRow, EntryRow, EntryMood, PhotoRow, TripRow } from './schema';

/**
 * archive 域数据库（R9）：域内唯一 SQL 出口。
 * 文件按域隔离为 archive.db，与 core 五件套（almightydb.db）互不混用；
 * 迁移经 core/database 注册表在事务内执行。
 */
const DATABASE_NAME = 'archive.db';

let dbPromise: ReturnType<typeof openDatabase> | null = null;

function getDb(): ReturnType<typeof openDatabase> {
    if (!dbPromise) {
        dbPromise = openDatabase(DATABASE_NAME, { migrations: ARCHIVE_MIGRATIONS });
    }
    return dbPromise;
}

// ─── trips ───────────────────────────────────────────────────────────────────

export async function listTrips(): Promise<TripRow[]> {
    const db = await getDb();
    return db.getAll<TripRow>(
        'SELECT * FROM trips WHERE deleted_at IS NULL ORDER BY start_date DESC',
    );
}

export async function getTrip(id: string): Promise<TripRow | null> {
    const db = await getDb();
    return db.getFirst<TripRow>('SELECT * FROM trips WHERE id = ? AND deleted_at IS NULL', [id]);
}

export async function insertTrip(row: Omit<TripRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO trips (id, title, start_date, end_date, note, cover_key, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [row.id, row.title, row.start_date, row.end_date, row.note, row.cover_key, row.created_at, row.updated_at],
    );
}

/** 各行程的日记碎片计数（时间线/行程卡用）。 */
export async function countEntriesByTrip(): Promise<Map<string, number>> {
    const db = await getDb();
    const rows = await db.getAll<{ trip_id: string; n: number }>(
        'SELECT trip_id, COUNT(*) AS n FROM entries WHERE deleted_at IS NULL AND trip_id IS NOT NULL GROUP BY trip_id',
    );
    return new Map(rows.map((r) => [r.trip_id, r.n]));
}

// ─── entries ─────────────────────────────────────────────────────────────────

/** 时间线：最近的碎片（跨行程 + 日常），新日期在前由调用方分组处理。 */
export async function listRecentEntries(limit = 300): Promise<EntryRow[]> {
    const db = await getDb();
    return db.getAll<EntryRow>(
        `SELECT * FROM entries WHERE deleted_at IS NULL
         ORDER BY local_date DESC, created_at ASC LIMIT ?`,
        [limit],
    );
}

export async function listEntriesByTrip(tripId: string): Promise<EntryRow[]> {
    const db = await getDb();
    return db.getAll<EntryRow>(
        `SELECT * FROM entries WHERE deleted_at IS NULL AND trip_id = ?
         ORDER BY local_date ASC, created_at ASC`,
        [tripId],
    );
}

export async function insertEntry(row: Omit<EntryRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO entries (id, trip_id, local_date, content, mood, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [row.id, row.trip_id, row.local_date, row.content, row.mood, row.created_at, row.updated_at],
    );
}

// ─── photos ──────────────────────────────────────────────────────────────────

/** 指定碎片集合的全部图片（键按 entry_id 分组返回）。 */
export async function listPhotosByEntries(entryIds: string[]): Promise<Map<string, PhotoRow[]>> {
    const grouped = new Map<string, PhotoRow[]>();
    if (entryIds.length === 0) return grouped;
    const db = await getDb();
    const placeholders = entryIds.map(() => '?').join(', ');
    const rows = await db.getAll<PhotoRow>(
        `SELECT * FROM photos WHERE deleted_at IS NULL AND entry_id IN (${placeholders})
         ORDER BY entry_id, sort_order ASC`,
        entryIds,
    );
    for (const row of rows) {
        const bucket = grouped.get(row.entry_id);
        if (bucket) bucket.push(row);
        else grouped.set(row.entry_id, [row]);
    }
    return grouped;
}

export async function insertPhoto(row: Omit<PhotoRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO photos (id, entry_id, file_key, width, height, sort_order, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        [row.id, row.entry_id, row.file_key, row.width, row.height, row.sort_order, row.created_at],
    );
}

// ─── day plans ───────────────────────────────────────────────────────────────

export async function listDayPlansByTrip(tripId: string): Promise<DayPlanRow[]> {
    const db = await getDb();
    return db.getAll<DayPlanRow>(
        `SELECT * FROM day_plans WHERE deleted_at IS NULL AND trip_id = ?
         ORDER BY local_date ASC, sort_order ASC`,
        [tripId],
    );
}

export async function insertDayPlan(row: Omit<DayPlanRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO day_plans (id, trip_id, local_date, content, sort_order, done, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [row.id, row.trip_id, row.local_date, row.content, row.sort_order, row.done, row.created_at, row.updated_at],
    );
}

export async function setDayPlanDone(id: string, done: boolean): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE day_plans SET done = ?, updated_at = ? WHERE id = ?', [
        done ? 1 : 0,
        Date.now(),
        id,
    ]);
}

/** 下一个排序号（同行程同日期内追加到末尾）。 */
export async function nextDayPlanSortOrder(tripId: string, localDate: string): Promise<number> {
    const db = await getDb();
    const row = await db.getFirst<{ max_sort: number | null }>(
        'SELECT MAX(sort_order) AS max_sort FROM day_plans WHERE trip_id = ? AND local_date = ? AND deleted_at IS NULL',
        [tripId, localDate],
    );
    return (row?.max_sort ?? -1) + 1;
}
