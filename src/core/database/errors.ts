import { CodedError } from 'expo-modules-core';

/**
 * 通用 SQL 接口的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约；retryable 标记瞬时故障
 * （如 SQLite busy/locked），调用方可据此决定重试。
 */
export type DatabaseErrorCode = 'database/failure' | 'database/migration';

export class DatabaseError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    constructor(code: DatabaseErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'DatabaseError';
        this.cause = cause;
        this.retryable = retryable;
    }
}

/**
 * web 端多标签 / 其他 worker 持有 OPFS 排他句柄的特征（createSyncAccessHandle 冲突）。
 * 触发面：同库被第二个标签页打开时，其 worker 的 VFS 初始化（为池内文件建
 * sync access handle）被浏览器以 NoModificationAllowedError 拒绝。
 * 该类错误**不参与内存降级**：降级成功会把空库渲染成正常空数据，掩盖「数据其实
 * 还在其他标签页持有」的事实；专用文案引导用户关闭多余标签页后刷新即可恢复。
 */
const MULTI_TAB_LOCK_PATTERN =
    /createSyncAccessHandle|NoModificationAllowedError|sync access handle is already open|another open access handle/i;

/**
 * web 端持久存储不可用类错误的特征（OPFS 文件层 / VFS 初始化 / wasm 加载）。
 * 命中即符合内存库降级条件（见 web-fallback.ts）——注意 migration 语句错误
 * （no such table / syntax 等）不命中，schema 层问题不会触发降级掩盖。
 * 机制实证（wa-sqlite sqlite-api.js check()，db 句柄存在时抛
 * "Error code <n>: <errmsg>"）：池槽耗尽时 journal 创建被 jOpen 拒绝
 * （AccessHandlePoolVFS 'cannot create file' → SQLITE_CANTOPEN），语句期报
 * "Error code 14: unable to open database file"——建库与读操作均正常，极易误诊。
 */
const STORAGE_UNAVAILABLE_PATTERN =
    /unable to open database file|SQLITE_CANTOPEN|cannot create file|navigator\.storage|getDirectory|AccessHandlePoolVFS|Invalid VFS state|wa-sqlite|WebAssembly/i;

/** 非安全上下文 / 浏览器不支持 OPFS（降级同样不可用，文案单独引导）。 */
const INSECURE_CONTEXT_PATTERN = /context is not secure|navigator\.storage not available/i;

/**
 * web 存储类失败的分类结果，供 connect() 决定是否走内存降级。
 * - `'multi-tab-lock'`：其他标签页持有 OPFS 句柄——不降级，专用文案；
 * - `'storage-unavailable'`：OPFS/存储层不可用——降级为内存库；
 * - `null`：非存储类失败（schema/程序错误）——照常上抛，不降级。
 */
export type WebStorageFailureKind = 'multi-tab-lock' | 'storage-unavailable';

export function classifyWebStorageFailure(detail: string): WebStorageFailureKind | null {
    if (MULTI_TAB_LOCK_PATTERN.test(detail)) return 'multi-tab-lock';
    if (STORAGE_UNAVAILABLE_PATTERN.test(detail)) return 'storage-unavailable';
    return null;
}

/**
 * 裸错误 → DatabaseError 统一包装（open/run/exec 等所有出口共用）。
 * web 存储类失败在此翻译为可操作文案（错误契约不变，code 仍为 database/failure；
 * retryable 按 R6 集中在本函数设置——多标签占用关闭标签页后可恢复，视为可重试）。
 */
export function toDatabaseError(error: unknown, context: string): DatabaseError {
    if (error instanceof DatabaseError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    const retryable =
        /database is locked|database table is locked|SQLITE_BUSY/i.test(detail) ||
        MULTI_TAB_LOCK_PATTERN.test(detail);
    let message = `${context}: ${detail}`;
    const kind = classifyWebStorageFailure(detail);
    if (kind === 'multi-tab-lock') {
        message = `${context}: 数据库被其他标签页占用，请关闭其他标签页后刷新`;
    } else if (INSECURE_CONTEXT_PATTERN.test(detail)) {
        message = `${context}: 当前浏览器环境无法持久化数据（持久化存储需要 HTTPS 或 localhost 安全上下文）`;
    } else if (/unable to open database file|SQLITE_CANTOPEN/i.test(detail)) {
        message = `${context}: 数据库文件无法打开，请检查浏览器存储空间或站点数据权限后重试（${detail}）`;
    }
    return new DatabaseError('database/failure', message, error, retryable);
}
