import { Platform } from 'react-native';
import { getThumbnailAsync } from 'expo-video-thumbnails';
import { VideoThumbnailError, toVideoThumbnailError, type VideoThumbnailErrorCode } from './errors';

/**
 * 视频首帧缩略图生成（glossary §3，2026-11-08 登记）：
 * expo-video-thumbnails 的 getThumbnailAsync 是原生解码（MediaCodec/AVAsset），
 * 在原生线程执行、不占 JS 主线程；产物为一张帧图 URI，供 file-storage 落盘
 * / image-manipulator 缩边等下游组合。
 *
 * 三端口径：Android/iOS 全量可用；web 无原生实现——官方包自带 web stub
 * （build/ExpoVideoThumbnails.web.js，**调用期**抛错而非 import 期，模块可
 * 安全静态引入），本模块按 Platform 分流：web 一律抛 unavailable 类型化错误
 * （error-handling R2 登记），调用方（features 层）据失败回退占位卡——缩略图
 * 是展示增强，不是数据正确性依赖，失败绝不阻塞媒体入库。
 */

/** 生成结果：帧图本地 URI + 像素尺寸（供缩边决策）。 */
export interface VideoThumbnail {
    uri: string;
    width: number;
    height: number;
}

export interface VideoThumbnailOptions {
    /** 取帧时间位置（毫秒，默认 0 = 首帧）。 */
    timeMs?: number;
    /** JPEG 压缩质量 0..1（默认 0.85——封面图档，肉眼无损级）。 */
    quality?: number;
}

export const videoThumbnails = {
    /**
     * 当前平台是否有真实现（web 官方 stub 抛错 → false）。能力探测供调用方
     * 在「生成是锦上添花」的场景静默跳过，避免每次 attach 白抛一场错误。
     */
    isSupported(): boolean {
        return Platform.OS !== 'web';
    },

    /**
     * 从视频生成一帧缩略图。sourceFilename 接受本地 file:// URI（file-storage
     * url() 的 native 返回值即此形态）；远端 URI 底层也支持（headers 透传），
     * 本域调用方一律传本地已落盘文件。
     */
    async generateAsync(sourceUri: string, options?: VideoThumbnailOptions): Promise<VideoThumbnail> {
        if (Platform.OS === 'web') {
            throw new VideoThumbnailError(
                'video-thumbnails/unavailable',
                'videoThumbnails.generateAsync: web 无原生实现（官方 stub），调用方应回退占位卡',
            );
        }
        try {
            const result = await getThumbnailAsync(sourceUri, {
                time: options?.timeMs ?? 0,
                quality: options?.quality ?? 0.85,
            });
            return { uri: result.uri, width: result.width, height: result.height };
        } catch (error) {
            throw toVideoThumbnailError(error, `videoThumbnails.generateAsync(${sourceUri})`);
        }
    },
};

export { VideoThumbnailError };
export type { VideoThumbnailErrorCode };
