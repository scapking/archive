import { CodedError } from 'expo-modules-core';

/**
 * 通用 Skia SVG 渲染的类型化错误。code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 */
export type SkiaSvgErrorCode = 'svg/parse' | 'svg/empty';

export class SkiaSvgError extends CodedError {
    readonly cause?: unknown;

    constructor(code: SkiaSvgErrorCode, message: string, cause?: unknown) {
        super(code, message);
        this.name = 'SkiaSvgError';
        this.cause = cause;
    }
}
