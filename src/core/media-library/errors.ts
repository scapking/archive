import { CodedError } from 'expo-modules-core';

/**
 * 媒体保存能力（media-library）的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约（2026-11-08 登记）：
 * - permission-denied：native 相册写入权限被拒（retryable=true——引导系统设置
 *   授权后重试可成功）；
 * - save-failed：取回字节 / 写入相册 / 触发下载的 IO 或编码失败（retryable=true
 *   ——瞬时故障重试可成功；expo 原生保存错误统一包装进本 code，cause 保原始
 *   错误不丢信息）；
 * - unsupported：当前平台/环境无该保存路径（如 web 缺下载 API；retryable=false）。
 */
export type MediaLibraryErrorCode =
    | 'media-library/permission-denied'
    | 'media-library/save-failed'
    | 'media-library/unsupported';

export class MediaLibraryError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    constructor(
        code: MediaLibraryErrorCode,
        message: string,
        cause?: unknown,
        retryable = false,
    ) {
        super(code, message);
        this.name = 'MediaLibraryError';
        this.cause = cause;
        this.retryable = retryable;
    }
}
