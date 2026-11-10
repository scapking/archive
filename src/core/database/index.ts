import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import { classifyWebStorageFailure, DatabaseError, toDatabaseError } from './errors';
import { MEMORY_DB_PATH, markWebStorageDegraded } from './web-fallback';

export { DatabaseError, type DatabaseErrorCode, toDatabaseError } from './errors';
export {
    getWebStorageDegradation,
    subscribeWebStorageDegradation,
    type WebStorageDegradation,
} from './web-fallback';
export {
    WebStorageDegradationBanner,
    type WebStorageDegradationBannerColors,
} from './degradation-banner';

/**
 * 通用 SQL 调用接口：expo-sqlite 的三端统一门面（web 走 WASM）。
 *
 * - 同名数据库是单例，重复 openDatabase 返回同一连接；
 * - schema 版本用 PRAGMA user_version 管理；多个模块可各自带 migrations 调
 *   openDatabase(同名)，迁移按 version 合并、升序在事务内执行；
 * - 所有操作错误统一包装为 DatabaseError（带 code）；
 * - web 降级链（native 无此分支）：持久库打开失败且为存储类错误（OPFS 文件层 /
 *   VFS 初始化 / wasm 加载，见 classifyWebStorageFailure）→ 以 ':memory:' 重建
 *   （会话内可用、刷新即失），console.warn + 应用内横幅提示，业务层无感知；
 *   多标签句柄占用不降级（专用文案引导，防止空库冒充正常数据）；
 *   内存降级也失败时按原错误上抛（根因优先）。
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
// 缓存连接上补跑迁移的串行链：并发 openDatabase 的补跑按注册顺序逐个执行，
// 且每次执行前重读 user_version（前一个补跑可能已完成同样的迁移），避免重复执行
const migrationCatchUpChains = new Map<string, Promise<void>>();
// 冷连接全局串行链（web 端正确性保障，不只性能）：expo-sqlite web 的
// AccessHandlePoolVFS 在共享 worker 里按 worker 级单例惰性初始化（maybeInitAsync
// 的 _vfs 判空与赋值之间横跨 await，无锁）——同帧并发 openDatabase（不同库名，
// 如首屏业务域库与根布局 almightydb.db 的启动查询同 commit 触发）会让 worker
// 为同一 OPFS 目录建出第二个 VFS 实例，对首批 pool 块文件二次
// createSyncAccessHandle，被浏览器以「another open Access Handle」拒绝：
// VFS 初始化半途而废 + 失败连接被缓存，全 document 的 DB 层自此污染（
// 表现为 createSyncAccessHandle 冲突 / SQLITE_CANTOPEN(14) / 迁移半套 no such
// table，随交错时序漂移）。主线程把 connect 排队即从源头消灭并发 open——
// native 端无此 VFS，串行化只是让首个连接的建连时序可预期，零副作用。
let connectChain: Promise<unknown> = Promise.resolve();

export function openDatabase(name: string, options: DatabaseOpenOptions = {}): Promise<Database> {
    registerMigrations(name, options.migrations ?? []);
    let connection = connections.get(name);
    if (!connection) {
        // 冷连接入全局链：前一个 connect（含 worker 内 VFS 初始化 + 首次迁移）
        // 完成后才开始下一个；失败不从链上传播（后续连接照常尝试）。
        // 错误包装由 connect 内部负责（toDatabaseError 前缀 open database(...)）。
        const chained = connectChain.then(() => connect(name));
        connectChain = chained.then(() => undefined, () => undefined);
        connections.set(name, chained);
        // 失败连接出栈（AGENTS.md 已登记偏差的清偿）：失败的 promise 不再驻留
        // 缓存，同名库下次 openDatabase 重新建连——屏层「重试」按钮真实生效。
        // 并发调用方仍共享本次 in-flight 尝试（同一 promise），不产生并发 open。
        void chained.catch(() => {
            if (connections.get(name) === chained) connections.delete(name);
        });
        return chained;
    }
    // 缓存命中：连接建立后可能又有更高版本的迁移被注册（其他模块懒加载 openDatabase），
    // connect 时的一次性 applyMigrations 看不到它们——必须对该连接补跑 pending 迁移，
    // 否则调用方随后的建表查询会报 no such table
    return runPendingMigrations(name, connection);
}

/**
 * 对已建立（或建立中）的连接补跑 pending 迁移。
 * 串行化：链上任务等待前一个补跑结束；连接未就绪时自然等待 connect 完成
 * （connect 内部的首次 applyMigrations 先于本链执行，二者不会交叉）。
 */
function runPendingMigrations(name: string, connection: Promise<Database>): Promise<Database> {
    const previous = migrationCatchUpChains.get(name) ?? Promise.resolve();
    const task = previous
        .then(() => connection)
        .then(async (db) => {
            const current = (await db.getFirst<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
            for (const migration of pendingMigrations(name, current)) {
                // 每个迁移独立事务：语句原子生效，user_version 与建表同事务提交
                await db.withTransaction(async () => {
                    for (const statement of migration.statements) {
                        await db.exec(statement);
                    }
                    await db.exec(`PRAGMA user_version = ${migration.version}`);
                });
            }
        });
    // 链本身不携带 rejection（失败交给本次调用方）；下一次补跑会重新复查版本再决定是否执行
    migrationCatchUpChains.set(name, task.then(() => undefined, () => undefined));
    return task.then(
        () => connection,
        (error: unknown) => {
            // 门面方法抛出的已是 DatabaseError；其余（罕见）按 open 失败统一包装，错误契约不变
            throw error instanceof DatabaseError ? error : toDatabaseError(error, `migrate database(${name})`);
        },
    );
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
    if (Platform.OS === 'web') {
        return connectWeb(name);
    }
    // native（Android/iOS）：原路径零改动——打开失败即失败，无降级语义
    try {
        return wrapFacade(await openAndMigrate(name));
    } catch (error) {
        throw toDatabaseError(error, `open database(${name})`);
    }
}

/**
 * web 端连接 + 降级链：持久库 → （存储类失败时）内存库 → 都失败按原错误上抛。
 * 全程在 connectChain 串行链上执行（调用方 openDatabase 已保证），降级尝试
 * 不会与其他连接的建连/VFS 初始化交错。
 */
async function connectWeb(name: string): Promise<Database> {
    try {
        requestWebPersistentStorage();
        return wrapFacade(await openAndMigrate(name));
    } catch (error) {
        const persistentError = toDatabaseError(error, `open database(${name})`);
        const kind = classifyWebStorageFailure(error instanceof Error ? error.message : String(error));
        // 多标签句柄占用：不降级（防空库冒充正常数据），toDatabaseError 已给专用文案
        if (kind !== 'storage-unavailable') throw persistentError;
        console.warn(
            `[core/database] web 持久库 ${name} 打开失败，降级为会话内存库` +
                `（本次记录仅保留在会话中，刷新后丢失）: ${persistentError.message}`,
        );
        try {
            // ':memory:' 是 SQLite 内核魔法文件名 → 每连接独立私有内存库（实验实证：
            // VFS 文件层完全不参与，池耗尽下仍可打开）。这里 useNewConnection 防的是
            // expo worker JS 层的连接复用：findCachedDatabase 按 databasePath 匹配，
            // 缺省时第二个逻辑库的 openDatabaseAsync(':memory:') 会命中首个内存库的
            // 缓存实体——多个逻辑库共享同一 SQLite 实例、表全部串库。
            const db = await openAndMigrate(name, { useNewConnection: true }, MEMORY_DB_PATH);
            // 降级登记（横幅订阅源；首个降级事件通知一次）
            markWebStorageDegraded(name);
            return wrapFacade(db);
        } catch (memoryError) {
            // 内存降级也失败（worker 被 VFS 初始化失败污染 / wasm 不可用等）：
            // 上抛持久层原始错误（根因优先），记忆失败细节便于排查。
            console.warn(`[core/database] web 内存库降级亦失败: ${String(memoryError)}`);
            throw persistentError;
        }
    }
}

/**
 * 打开库并执行 pending 迁移。
 * @param name 逻辑库名（迁移注册表键；降级时仍用原名，保证迁移合并语义不变）
 * @param options expo-sqlite 打开参数（降级内存库时传 useNewConnection 防连接复用）
 * @param path 实际打开路径（缺省 = name；内存降级传 ':memory:'）
 */
async function openAndMigrate(
    name: string,
    options?: SQLite.SQLiteOpenOptions,
    path: string = name,
): Promise<SQLite.SQLiteDatabase> {
    const db = await SQLite.openDatabaseAsync(path, options);
    await applyMigrations(name, db);
    return db;
}

/** SQLiteDatabase → Database 门面（三端共用，错误统一包装为带 code 的 DatabaseError）。 */
function wrapFacade(db: SQLite.SQLiteDatabase): Database {
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
}

/**
 * web 端申请持久化存储：未申请时浏览器在存储压力下可能清掉 IndexedDB（sqlite 的 web 底座）。
 * 申请失败不影响打开（隐私模式等场景），尽力而为。仅在持久路径调用（内存库无需申请）。
 */
function requestWebPersistentStorage(): void {
    if (globalThis.navigator?.storage?.persist === undefined) return;
    void globalThis.navigator.storage.persist().catch(() => undefined);
}

async function applyMigrations(name: string, db: SQLite.SQLiteDatabase): Promise<void> {
    const current = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    for (const migration of pendingMigrations(name, current)) {
        await db.withTransactionAsync(async () => {
            for (const statement of migration.statements) {
                await db.execAsync(statement);
            }
            await db.execAsync(`PRAGMA user_version = ${migration.version}`);
        });
    }
}

/** 注册表中高于 currentVersion 的迁移，升序排列（首次连接与缓存连接补跑共用）。 */
function pendingMigrations(name: string, currentVersion: number): Array<{ version: number; statements: string[] }> {
    return [...(migrationRegistry.get(name)?.entries() ?? [])]
        .map(([version, statements]) => ({ version, statements }))
        .filter((migration) => migration.version > currentVersion)
        .sort((a, b) => a.version - b.version);
}
