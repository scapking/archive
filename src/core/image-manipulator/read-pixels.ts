import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';
import { Platform } from 'react-native';
import { ImageManipulatorError } from './errors';

/**
 * 图片原始像素读取（image-manipulator 能力的扩展面，2026-11-17 登记）：
 * 编码图片（JPEG/PNG…）→ RGBA 原始字节，供 GIF 编码等像素级下游消费。
 *
 * 实现 = Skia 解码 + 离屏 surface 绘制 + canvas.readPixels：
 * - 解码用 Skia.Image.MakeImageFromEncoded（原生 codec，JPEG/PNG/WebP 全支持）；
 * - 缩边在绘制时完成（dst rect 缩放，最大边 maxWidth 不放大只缩小）——GIF
 *   帧预算（≤360px 宽）与内存量级在此一步收口，不需要二次变换；
 * - readPixels 读回 RGBA_8888 / Unpremul 字节（canvas.readPixels 三端可用；
 *   读空（GPU 上下文异常等）按 read-pixels 类型化错误上浮，调用方降级）。
 *
 * 与 manipulateAsync（编码产物字节）互补：一个出口给「落盘」，一个出口给
 * 「进像素管线」。web 端 Skia 走 canvas 后端，readPixels 同样可用（帧抽取
 * 本身仍受 video-thumbnails 的 web 无实现限制，见该能力注）。
 */

export interface RawPixels {
    width: number;
    height: number;
    /** RGBA_8888 像素（4 字节/像素，长度 = width * height * 4）。 */
    rgba: Uint8Array;
}

/** URI 字节读取：native File.bytes() / web fetch（与 manipulateAsync 同源口径）。 */
async function uriBytes(uri: string): Promise<Uint8Array> {
    if (Platform.OS === 'web') {
        return new Uint8Array(await (await fetch(uri)).arrayBuffer());
    }
    return new File(uri).bytes();
}

export async function readPixelsAsync(
    uri: string,
    options?: { maxWidth?: number },
): Promise<RawPixels> {
    const bytes = await uriBytes(uri);
    const image = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
    if (!image) {
        throw new ImageManipulatorError('image-manipulator/decode', `readPixelsAsync: 图片解码失败（${uri}）`);
    }
    try {
        const sourceWidth = image.width();
        const sourceHeight = image.height();
        // 只缩不放：maxWidth 仅在超宽时生效（等比收边，最小 1px）
        const maxWidth = options?.maxWidth ?? sourceWidth;
        const scale = sourceWidth > maxWidth ? maxWidth / sourceWidth : 1;
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const surface = Skia.Surface.MakeOffscreen(width, height);
        if (!surface) {
            throw new ImageManipulatorError(
                'image-manipulator/read-pixels',
                `readPixelsAsync: 离屏 surface 创建失败（${width}x${height}）`,
                undefined,
                true,
            );
        }
        try {
            const canvas = surface.getCanvas();
            canvas.drawImageRect(
                image,
                { x: 0, y: 0, width: sourceWidth, height: sourceHeight },
                { x: 0, y: 0, width, height },
                Skia.Paint(),
            );
            surface.flush?.();
            const rgba = canvas.readPixels(0, 0, {
                width,
                height,
                colorType: ColorType.RGBA_8888,
                alphaType: AlphaType.Unpremul,
            });
            if (!rgba) {
                throw new ImageManipulatorError(
                    'image-manipulator/read-pixels',
                    `readPixelsAsync: 像素读取返回空（${width}x${height}）`,
                    undefined,
                    true,
                );
            }
            return { width, height, rgba: rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba) };
        } finally {
            // SharedRef 显式释放（RN Skia 2.x dispose；不存在时静默跳过）
            (surface as unknown as { dispose?: () => void }).dispose?.();
        }
    } finally {
        (image as unknown as { dispose?: () => void }).dispose?.();
    }
}
