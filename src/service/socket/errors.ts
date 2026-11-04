import { CodedError } from 'expo-modules-core';

/**
 * 通用 WebSocket 接口的类型化错误。code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 */
export type SocketErrorCode = 'socket/closed' | 'socket/full';

export class SocketError extends CodedError {
    readonly cause?: unknown;

    constructor(code: SocketErrorCode, message: string, cause?: unknown) {
        super(code, message);
        this.name = 'SocketError';
        this.cause = cause;
    }
}
