import { CodedError } from 'expo-modules-core';

/**
 * 通用文件接口的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 */
export type FileStorageErrorCode = 'file-storage/invalid-key' | 'file-storage/not-found' | 'file-storage/io';

export class FileStorageError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    constructor(code: FileStorageErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'FileStorageError';
        this.cause = cause;
        this.retryable = retryable;
    }
}

export function toFileStorageError(error: unknown, context: string): FileStorageError {
    if (error instanceof FileStorageError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new FileStorageError('file-storage/io', `${context}: ${detail}`, error);
}
