import { CodedError } from 'expo-modules-core';

/**
 * 通用分享接口的类型化错误（web 下载回退路径使用；native 透传 expo 错误，见 R4）。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 */
export type SharingErrorCode = 'sharing/unsupported' | 'sharing/io';

export class SharingError extends CodedError {
    readonly cause?: unknown;

    constructor(code: SharingErrorCode, message: string, cause?: unknown) {
        super(code, message);
        this.name = 'SharingError';
        this.cause = cause;
    }
}
