import { openDatabase, type Database, DatabaseError, toDatabaseError } from '@/core/database';

/**
 * 通用数据存储接口：app 生成的结构化数据（记录、草稿、消息体…）跨启动保留。
 * 一个 collection 是 documents 表里的一个命名分区（value 经 JSON 序列化），
 * API 形态对齐 PouchDB/Dexie 社区惯例（put/get/list/remove）。
 *
 * 需要复杂关系模型或自定义表时，直接用 core/database 的通用 SQL 接口自建。
 */
export interface DataEntry<T> {
    id: string;
    value: T;
    createdAt: number;
    updatedAt: number;
}

export interface DataListOptions {
    limit?: number;
    offset?: number;
    /** 按 updatedAt 排序，默认 'desc'（新在前） */
    order?: 'asc' | 'desc';
}

export interface Collection<T> {
    /** 写入或覆盖；返回带时间戳的完整条目。 */
    put(id: string, value: T): Promise<DataEntry<T>>;
    /** 读取；不存在返回 null。 */
    get(id: string): Promise<DataEntry<T> | null>;
    /** 删除；不存在同样视为成功（幂等）。 */
    remove(id: string): Promise<void>;
    /** 按 updatedAt 排序分页列出。 */
    list(options?: DataListOptions): Promise<Array<DataEntry<T>>>;
    count(): Promise<number>;
    /** 清空本 collection（不影响其他 collection）。 */
    clear(): Promise<void>;
}

const DATABASE_NAME = 'almightydb.db';

/**
 * 本能力的 schema 迁移。与 cache-store 共库（almightydb.db），版本号必须互不相同且递增；
 * migration 模块会组合各能力的 SCHEMA_MIGRATIONS 完成整库重建。
 */
export const SCHEMA_MIGRATIONS = [
    {
        version: 1,
        statements: [
            `CREATE TABLE IF NOT EXISTS documents (
                collection TEXT NOT NULL,
                id TEXT NOT NULL,
                payload TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (collection, id)
            )`,
        ],
    },
];

const COLLECTION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const dataStore = {
    collection<T>(name: string): Collection<T> {
        if (!COLLECTION_NAME_PATTERN.test(name) || name.length > 128) {
            throw new DatabaseError(
                'database/failure',
                `dataStore.collection: 名称必须是单段 [a-zA-Z0-9._-]，长度 1..128，收到 "${name}"`,
            );
        }
        return new SqliteCollection<T>(name);
    },
};

class SqliteCollection<T> implements Collection<T> {
    constructor(private readonly name: string) {}

    private db(): Promise<Database> {
        return openDatabase(DATABASE_NAME, { migrations: SCHEMA_MIGRATIONS });
    }

    async put(id: string, value: T): Promise<DataEntry<T>> {
        this.validateId(id, 'put');
        try {
            const db = await this.db();
            const now = Date.now();
            const existing = await db.getFirst<{ created_at: number }>(
                'SELECT created_at FROM documents WHERE collection = ? AND id = ?',
                [this.name, id],
            );
            const createdAt = existing?.created_at ?? now;
            await db.run(
                `INSERT INTO documents (collection, id, payload, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (collection, id)
                 DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
                [this.name, id, JSON.stringify(value), createdAt, now],
            );
            return { id, value, createdAt, updatedAt: now };
        } catch (error) {
            throw toDatabaseError(error, `dataStore(${this.name}).put(${id})`);
        }
    }

    async get(id: string): Promise<DataEntry<T> | null> {
        this.validateId(id, 'get');
        try {
            const db = await this.db();
            const row = await db.getFirst<Row>(
                'SELECT id, payload, created_at, updated_at FROM documents WHERE collection = ? AND id = ?',
                [this.name, id],
            );
            return row ? toEntry<T>(row) : null;
        } catch (error) {
            throw toDatabaseError(error, `dataStore(${this.name}).get(${id})`);
        }
    }

    async remove(id: string): Promise<void> {
        this.validateId(id, 'remove');
        try {
            const db = await this.db();
            await db.run('DELETE FROM documents WHERE collection = ? AND id = ?', [this.name, id]);
        } catch (error) {
            throw toDatabaseError(error, `dataStore(${this.name}).remove(${id})`);
        }
    }

    async list(options: DataListOptions = {}): Promise<Array<DataEntry<T>>> {
        const limit = options.limit ?? 100;
        const offset = options.offset ?? 0;
        const direction = options.order === 'asc' ? 'ASC' : 'DESC';
        try {
            const db = await this.db();
            const rows = await db.getAll<Row>(
                `SELECT id, payload, created_at, updated_at FROM documents
                 WHERE collection = ?
                 ORDER BY updated_at ${direction}
                 LIMIT ? OFFSET ?`,
                [this.name, limit, offset],
            );
            return rows.map((row) => toEntry<T>(row));
        } catch (error) {
            throw toDatabaseError(error, `dataStore(${this.name}).list()`);
        }
    }

    async count(): Promise<number> {
        try {
            const db = await this.db();
            const row = await db.getFirst<{ total: number }>(
                'SELECT COUNT(*) AS total FROM documents WHERE collection = ?',
                [this.name],
            );
            return row?.total ?? 0;
        } catch (error) {
            throw toDatabaseError(error, `dataStore(${this.name}).count()`);
        }
    }

    async clear(): Promise<void> {
        try {
            const db = await this.db();
            await db.run('DELETE FROM documents WHERE collection = ?', [this.name]);
        } catch (error) {
            throw toDatabaseError(error, `dataStore(${this.name}).clear()`);
        }
    }

    private validateId(id: string, action: string): void {
        if (!COLLECTION_NAME_PATTERN.test(id) || id.length > 512) {
            throw new DatabaseError(
                'database/failure',
                `dataStore(${this.name}).${action}: id 必须是单段 [a-zA-Z0-9._-]，长度 1..512`,
            );
        }
    }
}

interface Row {
    id: string;
    payload: string;
    created_at: number;
    updated_at: number;
}

function toEntry<T>(row: Row): DataEntry<T> {
    return {
        id: row.id,
        value: JSON.parse(row.payload) as T,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
