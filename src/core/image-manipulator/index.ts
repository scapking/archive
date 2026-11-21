import * as ImageManipulatorModule from 'expo-image-manipulator';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * 通用图片变换接口（expo-image-manipulator，三端；glossary §3 已登记）。
 *
 * 薄封装（error-handling.md R4）：不吞错误，底层 CodedError 原样抛出。
 * 在 expo `manipulateAsync` 之上补一件事——读取变换结果的字节，
 * 便于调用方一步对接 fileStorage.put（图片属 user file，禁进 sqlite）。
 */
export interface ManipulatedImage {
    uri: string;
    width: number;
    height: number;
    /** 变换后（通常为 JPEG）内容字节 */
    bytes: Uint8Array;
}

export const imageManipulator = {
    /**
     * 变换图片并读取结果字节。actions 传 `[]` 时仅做转码/压缩。
     * web 端结果为 blob/data URI，走 fetch 读字节；native 直接 File.bytes()。
     */
    async manipulateAsync(
        uri: string,
        actions: ImageManipulatorModule.Action[] = [],
        saveOptions: ImageManipulatorModule.SaveOptions = {
            compress: 0.8,
            format: ImageManipulatorModule.SaveFormat.JPEG,
        },
    ): Promise<ManipulatedImage> {
        const result = await ImageManipulatorModule.manipulateAsync(uri, actions, saveOptions);
        const bytes =
            Platform.OS === 'web'
                ? new Uint8Array(await (await fetch(result.uri)).arrayBuffer())
                : await new File(result.uri).bytes();
        return { uri: result.uri, width: result.width, height: result.height, bytes };
    },
};

export type { Action, SaveOptions, ImageResult } from 'expo-image-manipulator';
export { SaveFormat } from 'expo-image-manipulator';
// 像素读取扩展面（2026-11-17 登记）：编码图片 → RGBA 原始字节（Skia 解码 +
// 离屏绘制 + readPixels），供 GIF 编码等像素级下游消费；类型化错误随出口。
export { readPixelsAsync, type RawPixels } from './read-pixels';
export { ImageManipulatorError, type ImageManipulatorErrorCode } from './errors';
