import { openDatabase, DatabaseError, toDatabaseError } from '@/core/database';

/**
 * 通用缓存接口：可随时丢弃、可从源头重建的派生数据的跨启动存放。
 * API 形态对齐 Keyv/ioredis 社区惯例（set/get/clear + TTL）。
 * 过期条目在库打开时统一清除；get 命中过期键同样返回 null。
 */
export interface CacheSetOptions {
    /** 过期毫秒数；不传 = 永不过期（仍可被 clear 清除） */
    ttlMs?: number;
}

const DATABASE_NAME = 'almightydb.db';

/**
 * 本能力的 schema 迁移。与 data-store 共库（almightydb.db），版本号必须互不相同且递增；
 * migration 模块会组合各能力的 SCHEMA_MIGRATIONS 完成整库重建。
 */
export const SCHEMA_MIGRATIONS = [
    {
        version: 2,
        statements: [
            `CREATE TABLE IF NOT EXISTS cache_entries (
                key TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                expires_at INTEGER
            )`,
        ],
    },
];

const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

function validateKey(key: string, action: string): void {
    if (!KEY_PATTERN.test(key) || key.length > 512) {
            throw new DatabaseError(
                'database/failure',
                `cacheStore.${action}: key 必须形如 "a/b/c"（[a-zA-Z0-9._-]），长度 1..512`,
            );
    }
}

export const cacheStore = {
    async set(key: string, value: unknown, options: CacheSetOptions = {}): Promise<void> {
        validateKey(key, 'set');
        try {
            const db = await openDatabase(DATABASE_NAME, { migrations: SCHEMA_MIGRATIONS });
            const expiresAt = options.ttlMs !== undefined ? Date.now() + options.ttlMs : null;
            await db.run(
                `INSERT INTO cache_entries (key, payload, expires_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT (key)
                 DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`,
                [key, JSON.stringify(value), expiresAt],
            );
        } catch (error) {
            throw toDatabaseError(error, `cacheStore.set(${key})`);
        }
    },

    /** 命中返回值；缺失或已过期返回 null（过期键顺手删除）。 */
    async get<T>(key: string): Promise<T | null> {
        validateKey(key, 'get');
        try {
            const db = await openDatabase(DATABASE_NAME, { migrations: SCHEMA_MIGRATIONS });
            const row = await db.getFirst<{ payload: string; expires_at: number | null }>(
                'SELECT payload, expires_at FROM cache_entries WHERE key = ?',
                [key],
            );
            if (!row) return null;
            if (row.expires_at !== null && row.expires_at <= Date.now()) {
                await db.run('DELETE FROM cache_entries WHERE key = ?', [key]);
                return null;
            }
            return JSON.parse(row.payload) as T;
        } catch (error) {
            throw toDatabaseError(error, `cacheStore.get(${key})`);
        }
    },

    async remove(key: string): Promise<void> {
        validateKey(key, 'remove');
        try {
            const db = await openDatabase(DATABASE_NAME, { migrations: SCHEMA_MIGRATIONS });
            await db.run('DELETE FROM cache_entries WHERE key = ?', [key]);
        } catch (error) {
            throw toDatabaseError(error, `cacheStore.remove(${key})`);
        }
    },

    /** 按前缀批量清除；不传 prefix 清空全部。 */
    async clear(prefix?: string): Promise<void> {
        if (prefix !== undefined) validateKey(prefix, 'clear');
        try {
            const db = await openDatabase(DATABASE_NAME, { migrations: SCHEMA_MIGRATIONS });
            if (prefix === undefined) {
                await db.run('DELETE FROM cache_entries');
            } else {
                await db.run('DELETE FROM cache_entries WHERE key LIKE ?', [`${prefix}%`]);
            }
        } catch (error) {
            throw toDatabaseError(error, `cacheStore.clear(${prefix ?? '*'})`);
        }
    },
};
