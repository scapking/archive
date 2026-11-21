import { CodedError } from 'expo-modules-core';

/**
 * 文档选取能力的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约
 * （document-picker/pick、document-picker/unavailable）。
 */
export type DocumentPickerErrorCode =
    | 'document-picker/pick'
    | 'document-picker/unavailable';

export class DocumentPickerError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    /**
     * @param code pick = 选取过程 IO/权限类失败（用户可重试）；
     *             unavailable = 当前环境无实现（确定性不可用，重试无意义）。
     */
    constructor(code: DocumentPickerErrorCode, message: string, cause?: unknown, retryable = true) {
        super(code, message);
        this.name = 'DocumentPickerError';
        this.cause = cause;
        this.retryable = retryable;
    }
}
