import { CodedError } from 'expo-modules-core';

/**
 * 通用 POST 封装的类型化错误。code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 */
export type PostErrorCode = 'post/network' | 'post/http';

export class PostError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    constructor(code: PostErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'PostError';
        this.cause = cause;
        this.retryable = retryable;
    }
}
