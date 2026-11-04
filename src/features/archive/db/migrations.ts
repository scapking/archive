import type { SchemaMigration } from '@/core/database';
import {
    DAY_PLANS_DDL,
    JOURNALS_DDL,
    JOURNAL_MEDIA_DDL,
    TRIPS_DDL,
} from './schema';

/**
 * archive 域迁移注册表（R9）：version 递增且只追加，历史迁移发布后禁改。
 * 迁移在事务内执行并由 core/database 记账（PRAGMA user_version）。
 */
export const ARCHIVE_MIGRATIONS: SchemaMigration[] = [
    {
        version: 1,
        statements: [
            // v1（碎片流形态）：已被 v2 取代；保留注册保证从 v1 升级的库 user_version 可推进
            `CREATE TABLE IF NOT EXISTS trips (
                id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL,
                start_date TEXT NOT NULL, end_date TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '', cover_key TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
            )`,
            `CREATE TABLE IF NOT EXISTS entries (
                id TEXT PRIMARY KEY NOT NULL, trip_id TEXT, local_date TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '', mood TEXT,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
            )`,
            `CREATE TABLE IF NOT EXISTS photos (
                id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL, file_key TEXT NOT NULL,
                width INTEGER NOT NULL, height INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL, deleted_at INTEGER
            )`,
            DAY_PLANS_DDL,
            'CREATE INDEX IF NOT EXISTS idx_entries_local_date ON entries(local_date)',
            'CREATE INDEX IF NOT EXISTS idx_day_plans_trip_date ON day_plans(trip_id, local_date)',
        ],
    },
    {
        version: 2,
        statements: [
            // v2（商业版连续容器）：v1 碎片流为灰度前形态，无生产数据，直接重置
            'DROP TABLE IF EXISTS photos',
            'DROP TABLE IF EXISTS entries',
            'DROP TABLE IF EXISTS trips',
            TRIPS_DDL,
            JOURNALS_DDL,
            JOURNAL_MEDIA_DDL,
            'CREATE INDEX IF NOT EXISTS idx_journals_local_date ON journals(local_date)',
            'CREATE INDEX IF NOT EXISTS idx_journals_trip_id ON journals(trip_id)',
            'CREATE INDEX IF NOT EXISTS idx_journal_media_journal ON journal_media(journal_id)',
            'CREATE INDEX IF NOT EXISTS idx_day_plans_trip_date_v2 ON day_plans(trip_id, local_date)',
        ],
    },
];
