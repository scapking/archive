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

export function toDatabaseError(error: unknown, context: string): DatabaseError {
    if (error instanceof DatabaseError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    const retryable = /database is locked|database table is locked|SQLITE_BUSY/i.test(detail);
    return new DatabaseError('database/failure', `${context}: ${detail}`, error, retryable);
}
