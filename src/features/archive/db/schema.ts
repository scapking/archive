/**
 * archive 业务域自建表（R9）：DDL 常量 + 行类型，与 migrations.ts 一一对应。
 *
 * 约定（README/产品规划）：
 * - 主键一律 UUID 字符串（crypto.randomUUID），为将来云同步/合并预留；
 * - 日期归属用本地日期字符串 `YYYY-MM-DD`（禁用 UTC 时间戳判断"哪天"）；
 * - `created_at` / `updated_at` 为 epoch ms，同步预留；删除一律软删除（deleted_at）。
 */

/** 心情枚举：UI 层以点色呈现（色只上数据）。 */
export type EntryMood = 'great' | 'good' | 'flat' | 'low';

export interface TripRow {
    id: string;
    title: string;
    start_date: string; // YYYY-MM-DD
    end_date: string; // YYYY-MM-DD
    note: string;
    cover_key: string | null; // file-storage key
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export interface EntryRow {
    id: string;
    trip_id: string | null; // 日常日记不挂行程
    local_date: string; // YYYY-MM-DD
    content: string;
    mood: EntryMood | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export interface PhotoRow {
    id: string;
    entry_id: string;
    file_key: string; // file-storage key，如 photos/<entryId>/<n>.jpg
    width: number;
    height: number;
    sort_order: number;
    created_at: number;
    deleted_at: number | null;
}

export interface DayPlanRow {
    id: string;
    trip_id: string;
    local_date: string; // YYYY-MM-DD
    content: string;
    sort_order: number;
    done: number; // 0 | 1
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export const TRIPS_DDL = `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    cover_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

export const ENTRIES_DDL = `CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT,
    local_date TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    mood TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

export const PHOTOS_DDL = `CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT NOT NULL,
    file_key TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

export const DAY_PLANS_DDL = `CREATE TABLE IF NOT EXISTS day_plans (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;
