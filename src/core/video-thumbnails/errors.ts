import { CodedError } from 'expo-modules-core';

/**
 * 视频缩略图能力的类型化错误。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约
 * （video-thumbnails/unavailable、video-thumbnails/generation，2026-11-08 登记）。
 */
export type VideoThumbnailErrorCode =
    | 'video-thumbnails/unavailable'
    | 'video-thumbnails/generation';

export class VideoThumbnailError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    /**
     * @param code unavailable = web / 原生模块缺失（确定性不可用，重试无意义）；
     *             generation = 解码/帧提取失败（编码器瞬时繁忙可重试）。
     */
    constructor(code: VideoThumbnailErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'VideoThumbnailError';
        this.cause = cause;
        this.retryable = retryable;
    }
}

export function toVideoThumbnailError(error: unknown, context: string): VideoThumbnailError {
    if (error instanceof VideoThumbnailError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new VideoThumbnailError('video-thumbnails/generation', `${context}: ${detail}`, error, true);
}
