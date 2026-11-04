import { CodedError } from 'expo-modules-core';

/**
 * 通用迁移接口的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 */
export type MigrationErrorCode = 'migration/invalid-bundle' | 'migration/not-found' | 'migration/io';

export class MigrationError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    constructor(code: MigrationErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'MigrationError';
        this.cause = cause;
        this.retryable = retryable;
    }
}

export function toMigrationError(error: unknown, context: string): MigrationError {
    if (error instanceof MigrationError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new MigrationError('migration/io', `${context}: ${detail}`, error);
}
