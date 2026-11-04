import { CodedError } from 'expo-modules-core';

/**
 * 通用通知接口的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 */
export type NotificationErrorCode = 'notification/unsupported' | 'notification/invalid-token' | 'notification/failure';

export class NotificationError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    constructor(code: NotificationErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'NotificationError';
        this.cause = cause;
        this.retryable = retryable;
    }
}

export function toNotificationError(error: unknown, context: string): NotificationError {
    if (error instanceof NotificationError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new NotificationError('notification/failure', `${context}: ${detail}`, error);
}
