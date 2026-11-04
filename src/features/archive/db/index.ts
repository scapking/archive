import { openDatabase } from '@/core/database';
import { ARCHIVE_MIGRATIONS } from './migrations';
import type { JournalMediaRow, JournalRow, DayPlanRow, TripRow } from './schema';

export type {
    DayPlanRow,
    JournalBlock,
    JournalMediaKind,
    JournalMediaRow,
    JournalRow,
    JournalStatus,
    TripRow,
} from './schema';

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
        `INSERT INTO trips (id, title, start_date, end_date, note, description, icon, video_key, cover_key, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
            row.id,
            row.title,
            row.start_date,
            row.end_date,
            row.note,
            row.description,
            row.icon,
            row.video_key,
            row.cover_key,
            row.created_at,
            row.updated_at,
        ],
    );
}

export async function updateTrip(
    id: string,
    patch: Partial<Pick<TripRow, 'title' | 'start_date' | 'end_date' | 'description' | 'icon' | 'video_key'>>,
): Promise<void> {
    const db = await getDb();
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [column, value] of Object.entries(patch)) {
        fields.push(`${column} = ?`);
        params.push(value as string | number | null);
    }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    params.push(Date.now(), id);
    await db.run(`UPDATE trips SET ${fields.join(', ')} WHERE id = ?`, params);
}

export async function softDeleteTrip(id: string): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE trips SET deleted_at = ?, updated_at = ? WHERE id = ?', [Date.now(), Date.now(), id]);
}

/** 各行程的日记天数与计划完成度（行程卡 / me 页）。 */
export interface TripStats {
    journalDays: number;
    plansTotal: number;
    plansDone: number;
}

export async function tripStats(): Promise<Map<string, TripStats>> {
    const db = await getDb();
    const journalCounts = await db.getAll<{ trip_id: string; n: number }>(
        'SELECT trip_id, COUNT(DISTINCT local_date) AS n FROM journals WHERE deleted_at IS NULL AND trip_id IS NOT NULL GROUP BY trip_id',
    );
    const planRows = await db.getAll<{ trip_id: string; total: number; done: number }>(
        'SELECT trip_id, COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM day_plans WHERE deleted_at IS NULL GROUP BY trip_id',
    );
    const map = new Map<string, TripStats>();
    for (const row of journalCounts) {
        map.set(row.trip_id, { journalDays: row.n, plansTotal: 0, plansDone: 0 });
    }
    for (const row of planRows) {
        const existing = map.get(row.trip_id) ?? { journalDays: 0, plansTotal: 0, plansDone: 0 };
        map.set(row.trip_id, { ...existing, plansTotal: row.total, plansDone: row.done });
    }
    return map;
}

// ─── journals（连续日记容器）────────────────────────────────────────────────

export async function getJournalByDate(tripId: string | null, localDate: string): Promise<JournalRow | null> {
    const db = await getDb();
    return db.getFirst<JournalRow>(
        'SELECT * FROM journals WHERE deleted_at IS NULL AND trip_id IS ? AND local_date = ? LIMIT 1',
        [tripId, localDate],
    );
}

export async function insertJournal(row: Omit<JournalRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        `INSERT INTO journals (id, trip_id, local_date, blocks, status, word_count, created_at, updated_at, completed_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [row.id, row.trip_id, row.local_date, row.blocks, row.status, row.word_count, row.created_at, row.updated_at, row.completed_at],
    );
}

export async function updateJournalBlocks(id: string, blocks: string, wordCount: number): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE journals SET blocks = ?, word_count = ?, updated_at = ? WHERE id = ?', [
        blocks,
        wordCount,
        Date.now(),
        id,
    ]);
}

export async function completeJournal(id: string): Promise<void> {
    const db = await getDb();
    await db.run("UPDATE journals SET status = 'closed', completed_at = ?, updated_at = ? WHERE id = ?", [
        Date.now(),
        Date.now(),
        id,
    ]);
}

export async function getJournal(id: string): Promise<JournalRow | null> {
    const db = await getDb();
    return db.getFirst<JournalRow>('SELECT * FROM journals WHERE id = ? AND deleted_at IS NULL', [id]);
}

/** 本地时区 24:00 自动收笔：所有 open 且日期早于今天的日记收口。 */
export async function closeStaleOpenJournals(today: string): Promise<number> {
    const db = await getDb();
    const result = await db.run(
        "UPDATE journals SET status = 'closed', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE status = 'open' AND local_date < ?",
        [Date.now(), Date.now(), today],
    );
    return result.changes;
}

/** 行程内逐日日记（行程详情时间线）。 */
export async function listJournalsByTrip(tripId: string): Promise<JournalRow[]> {
    const db = await getDb();
    return db.getAll<JournalRow>(
        'SELECT * FROM journals WHERE deleted_at IS NULL AND trip_id = ? ORDER BY local_date DESC, created_at ASC',
        [tripId],
    );
}

/** 日常日记（无行程）最近列表。 */
export async function listDailyJournals(limit = 60): Promise<JournalRow[]> {
    const db = await getDb();
    return db.getAll<JournalRow>(
        'SELECT * FROM journals WHERE deleted_at IS NULL AND trip_id IS NULL ORDER BY local_date DESC LIMIT ?',
        [limit],
    );
}

/** me 页搜索：块 JSON 里 LIKE（文本块内容在 JSON 内，LIKE 可命中）。 */
export async function searchJournals(query: string, limit = 20): Promise<JournalRow[]> {
    const db = await getDb();
    return db.getAll<JournalRow>(
        `SELECT * FROM journals WHERE deleted_at IS NULL AND blocks LIKE ? ESCAPE '\\'
         ORDER BY local_date DESC LIMIT ?`,
        [`%${escapeLike(query)}%`, limit],
    );
}

export async function searchTrips(query: string, limit = 20): Promise<TripRow[]> {
    const db = await getDb();
    return db.getAll<TripRow>(
        `SELECT * FROM trips WHERE deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
         ORDER BY start_date DESC LIMIT ?`,
        [`%${escapeLike(query)}%`, `%${escapeLike(query)}%`, limit],
    );
}

function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** me 页 30 天写作曲线：按日的字数总和。 */
export async function wordCountByDate(sinceDate: string): Promise<Map<string, number>> {
    const db = await getDb();
    const rows = await db.getAll<{ local_date: string; total: number }>(
        'SELECT local_date, SUM(word_count) AS total FROM journals WHERE deleted_at IS NULL AND local_date >= ? GROUP BY local_date',
        [sinceDate],
    );
    return new Map(rows.map((row) => [row.local_date, row.total]));
}

/** 有日记的日期集合（连续记录 streak 计算）。 */
export async function journalDates(limitDays = 400): Promise<Set<string>> {
    const db = await getDb();
    const rows = await db.getAll<{ local_date: string }>(
        'SELECT DISTINCT local_date FROM journals WHERE deleted_at IS NULL ORDER BY local_date DESC LIMIT ?',
        [limitDays],
    );
    return new Set(rows.map((row) => row.local_date));
}

export interface JournalTotals {
    journalDays: number;
    totalWords: number;
}

export async function journalTotals(): Promise<JournalTotals> {
    const db = await getDb();
    const row = await db.getFirst<{ days: number; words: number }>(
        'SELECT COUNT(DISTINCT local_date) AS days, COALESCE(SUM(word_count), 0) AS words FROM journals WHERE deleted_at IS NULL',
    );
    return { journalDays: row?.days ?? 0, totalWords: row?.words ?? 0 };
}

// ─── journal media ───────────────────────────────────────────────────────────

export async function insertJournalMedia(row: Omit<JournalMediaRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        'INSERT INTO journal_media (id, journal_id, file_key, kind, width, height, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
        [row.id, row.journal_id, row.file_key, row.kind, row.width, row.height, row.created_at],
    );
}

export async function getJournalMedia(id: string): Promise<JournalMediaRow | null> {
    const db = await getDb();
    return db.getFirst<JournalMediaRow>('SELECT * FROM journal_media WHERE id = ? AND deleted_at IS NULL', [id]);
}

/** 指定日记集合的媒体（按 journal_id 分组）。 */
export async function mediaByJournalIds(journalIds: string[]): Promise<Map<string, JournalMediaRow[]>> {
    const grouped = new Map<string, JournalMediaRow[]>();
    if (journalIds.length === 0) return grouped;
    const db = await getDb();
    const placeholders = journalIds.map(() => '?').join(', ');
    const rows = await db.getAll<JournalMediaRow>(
        `SELECT * FROM journal_media WHERE deleted_at IS NULL AND journal_id IN (${placeholders}) ORDER BY created_at ASC`,
        journalIds,
    );
    for (const row of rows) {
        const bucket = grouped.get(row.journal_id);
        if (bucket) bucket.push(row);
        else grouped.set(row.journal_id, [row]);
    }
    return grouped;
}

// ─── day plans ───────────────────────────────────────────────────────────────

export async function listDayPlansByTrip(tripId: string): Promise<DayPlanRow[]> {
    const db = await getDb();
    return db.getAll<DayPlanRow>(
        'SELECT * FROM day_plans WHERE deleted_at IS NULL AND trip_id = ? ORDER BY local_date ASC, sort_order ASC',
        [tripId],
    );
}

export async function insertDayPlan(row: Omit<DayPlanRow, 'deleted_at'>): Promise<void> {
    const db = await getDb();
    await db.run(
        'INSERT INTO day_plans (id, trip_id, local_date, content, sort_order, done, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        [row.id, row.trip_id, row.local_date, row.content, row.sort_order, row.done, row.created_at, row.updated_at],
    );
}

export async function setDayPlanDone(id: string, done: boolean): Promise<void> {
    const db = await getDb();
    await db.run('UPDATE day_plans SET done = ?, updated_at = ? WHERE id = ?', [done ? 1 : 0, Date.now(), id]);
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
