/**
 * archive 业务域自建表（R9）：DDL 常量 + 行类型，与 migrations.ts 一一对应。
 *
 * v2 产品形态（商业版）：
 * - 日记 = 连续容器（journals）：一天一篇、块结构（文本 + 行内媒体）、
 *   open/closed 状态（手动"完成"或本地时区 24:00 自动收笔）；
 * - 行程（trips）：图标（emoji）、封面视频、描述；
 * - v1 的碎片流（entries/photos）为灰度前形态，v2 直接弃用（发布前 schema 重置）。
 *
 * 约定不变：UUID 主键；日期归属用本地日期字符串 `YYYY-MM-DD`；
 * created_at/updated_at 为 epoch ms；删除一律软删除。
 */

/** 日记状态：open = 可继续写；closed = 已收笔（手动完成或跨日自动）。 */
export type JournalStatus = 'open' | 'closed';

/** 日记内容块：文本段或行内媒体（mediaId → journal_media）。 */
export type JournalBlock = { t: 'p'; text: string } | { t: 'media'; mediaId: string };

export interface TripRow {
    id: string;
    title: string;
    start_date: string; // YYYY-MM-DD
    end_date: string; // YYYY-MM-DD
    note: string; // 兼容 v1 列，v2 语义并入 description
    description: string;
    icon: string | null; // emoji
    video_key: string | null; // file-storage key（封面视频）
    cover_key: string | null; // 兼容 v1 列（未使用）
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
}

export interface JournalRow {
    id: string;
    trip_id: string | null; // null = 日常日记
    local_date: string; // YYYY-MM-DD
    blocks: string; // JSON: JournalBlock[]
    status: JournalStatus;
    word_count: number; // 冗余指标（me 页曲线），保存时同步
    created_at: number;
    updated_at: number;
    completed_at: number | null;
    deleted_at: number | null;
}

export type JournalMediaKind = 'image' | 'video';

export interface JournalMediaRow {
    id: string;
    journal_id: string;
    file_key: string; // file-storage key
    kind: JournalMediaKind;
    width: number | null;
    height: number | null;
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
    description TEXT NOT NULL DEFAULT '',
    icon TEXT,
    video_key TEXT,
    cover_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
)`;

export const JOURNALS_DDL = `CREATE TABLE IF NOT EXISTS journals (
    id TEXT PRIMARY KEY NOT NULL,
    trip_id TEXT,
    local_date TEXT NOT NULL,
    blocks TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    word_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    deleted_at INTEGER
)`;

export const JOURNAL_MEDIA_DDL = `CREATE TABLE IF NOT EXISTS journal_media (
    id TEXT PRIMARY KEY NOT NULL,
    journal_id TEXT NOT NULL,
    file_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
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
