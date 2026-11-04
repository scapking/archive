import type { SchemaMigration } from '@/core/database';
import {
    DAY_PLANS_DDL,
    ENTRIES_DDL,
    PHOTOS_DDL,
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
            TRIPS_DDL,
            ENTRIES_DDL,
            PHOTOS_DDL,
            DAY_PLANS_DDL,
            'CREATE INDEX IF NOT EXISTS idx_entries_local_date ON entries(local_date)',
            'CREATE INDEX IF NOT EXISTS idx_entries_trip_id ON entries(trip_id)',
            'CREATE INDEX IF NOT EXISTS idx_photos_entry_id ON photos(entry_id)',
            'CREATE INDEX IF NOT EXISTS idx_day_plans_trip_date ON day_plans(trip_id, local_date)',
        ],
    },
];
