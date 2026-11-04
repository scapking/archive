import * as SQLite from 'expo-sqlite';
import { DatabaseError, toDatabaseError } from './errors';

export { DatabaseError, type DatabaseErrorCode, toDatabaseError } from './errors';

/**
 * 通用 SQL 调用接口：expo-sqlite 的三端统一门面（web 走 WASM）。
 *
 * - 同名数据库是单例，重复 openDatabase 返回同一连接；
 * - schema 版本用 PRAGMA user_version 管理；多个模块可各自带 migrations 调
 *   openDatabase(同名)，迁移按 version 合并、升序在事务内执行；
 * - 所有操作错误统一包装为 DatabaseError（带 code）。
 */
export interface SchemaMigration {
    /** 目标 schema 版本（= 迁移执行后的 PRAGMA user_version），必须递增 */
    version: number;
    statements: string[];
}

export interface DatabaseOpenOptions {
    migrations?: SchemaMigration[];
}

export interface SqlRunResult {
    changes: number;
    lastInsertRowId: number;
}

export interface Database {
    exec(sql: string): Promise<void>;
    run(sql: string, params?: SQLite.SQLiteBindParams): Promise<SqlRunResult>;
    getFirst<T>(sql: string, params?: SQLite.SQLiteBindParams): Promise<T | null>;
    getAll<T>(sql: string, params?: SQLite.SQLiteBindParams): Promise<T[]>;
    withTransaction(task: () => Promise<void>): Promise<void>;
    close(): Promise<void>;
}

const connections = new Map<string, Promise<Database>>();
const migrationRegistry = new Map<string, Map<number, string[]>>();

export function openDatabase(name: string, options: DatabaseOpenOptions = {}): Promise<Database> {
    registerMigrations(name, options.migrations ?? []);
    let connection = connections.get(name);
    if (!connection) {
        connection = connect(name);
        connections.set(name, connection);
    }
    return connection;
}

function registerMigrations(name: string, migrations: SchemaMigration[]): void {
    let registry = migrationRegistry.get(name);
    if (!registry) {
        registry = new Map();
        migrationRegistry.set(name, registry);
    }
    for (const migration of migrations) {
        const existing = registry.get(migration.version);
        if (existing && existing.join('\n') !== migration.statements.join('\n')) {
            throw new DatabaseError(
                'database/migration',
                `database(${name}): migration version ${migration.version} 被重复注册且内容不同`,
            );
        }
        registry.set(migration.version, migration.statements);
    }
}

async function connect(name: string): Promise<Database> {
    try {
        requestWebPersistentStorage();
        const db = await SQLite.openDatabaseAsync(name);
        await applyMigrations(name, db);
        return {
            async exec(sql) {
                await db.execAsync(sql).catch((error) => { throw toDatabaseError(error, `exec: ${sql.slice(0, 80)}`); });
            },
            async run(sql, params) {
                const result = await db.runAsync(sql, params ?? []).catch((error) => { throw toDatabaseError(error, `run: ${sql.slice(0, 80)}`); });
                return { changes: result.changes, lastInsertRowId: result.lastInsertRowId };
            },
            getFirst<T>(sql: string, params?: SQLite.SQLiteBindParams) {
                return db.getFirstAsync<T>(sql, params ?? []).catch((error) => { throw toDatabaseError(error, `getFirst: ${sql.slice(0, 80)}`); });
            },
            getAll<T>(sql: string, params?: SQLite.SQLiteBindParams) {
                return db.getAllAsync<T>(sql, params ?? []).catch((error) => { throw toDatabaseError(error, `getAll: ${sql.slice(0, 80)}`); });
            },
            withTransaction(task) {
                return db.withTransactionAsync(task).catch((error) => { throw toDatabaseError(error, 'transaction'); });
            },
            close() {
                return db.closeAsync().catch((error) => { throw toDatabaseError(error, 'close'); });
            },
        };
    } catch (error) {
        throw toDatabaseError(error, `open database(${name})`);
    }
}

/**
 * web 端申请持久化存储：未申请时浏览器在存储压力下可能清掉 IndexedDB（sqlite 的 web 底座）。
 * 申请失败不影响打开（隐私模式等场景），尽力而为。
 */
function requestWebPersistentStorage(): void {
    if (globalThis.navigator?.storage?.persist === undefined) return;
    void globalThis.navigator.storage.persist().catch(() => undefined);
}

async function applyMigrations(name: string, db: SQLite.SQLiteDatabase): Promise<void> {
    const current = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    const pending = [...(migrationRegistry.get(name)?.entries() ?? [])]
        .map(([version, statements]) => ({ version, statements }))
        .filter((migration) => migration.version > current)
        .sort((a, b) => a.version - b.version);

    for (const migration of pending) {
        await db.withTransactionAsync(async () => {
            for (const statement of migration.statements) {
                await db.execAsync(statement);
            }
            await db.execAsync(`PRAGMA user_version = ${migration.version}`);
        });
    }
}
