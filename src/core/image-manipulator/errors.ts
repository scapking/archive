import { CodedError } from 'expo-modules-core';

/**
 * 图片变换能力的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约
 * （image-manipulator/decode、image-manipulator/read-pixels）。
 */
export type ImageManipulatorErrorCode =
    | 'image-manipulator/decode'
    | 'image-manipulator/read-pixels';

export class ImageManipulatorError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    /**
     * @param code decode = 字节不是可解码图片（确定性失败，重试无意义）；
     *             read-pixels = 像素读取失败（surface 创建/读取返回空，
     *             渲染环境瞬时问题可重试）。
     */
    constructor(code: ImageManipulatorErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'ImageManipulatorError';
        this.cause = cause;
        this.retryable = retryable;
    }
}
