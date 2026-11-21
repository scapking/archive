import { encodeGif, type GifFrame } from '@/core/gif-encoding';
import { fileStorage } from '@/core/file-storage';
import { haptics } from '@/core/haptics';
import { readPixelsAsync } from '@/core/image-manipulator';
import { mediaLibrary } from '@/core/media-library';
import { videoThumbnails } from '@/core/video-thumbnails';

/**
 * 视频转 GIF 编排（M3）：视频 → 定窗抽帧 → RGBA 像素 → GIF89a 编码 → 保存
 * 到手机（native 入相册 / web 浏览器下载，media-library 统一保存矩阵）。
 *
 * - **抽帧窗口（v1 口径）**：取视频**前 4 秒、每 0.5 秒一帧、共 8 帧**——
 *   时长探测需要播放器通道（expo-video 无轻量元数据读取 API），固定窗口
 *   是确定性路径；超过 4 秒的视频只转开头（hint 文案如实说明）；不足 4 秒
 *   的视频尾帧由原生 retriever 钳在末帧（GIF 尾部定格一帧，可接受）；
 * - **帧预算**：单帧缩边 ≤360px 宽（GIF 体积/编码耗时的平衡点，中位切分
 *   + LZW 纯 JS 编码在 360px × 8 帧量级秒级完成）；
 * - **落盘**：GIF 是运行时生成的二进制 → file-storage（export/ 前缀，不在
 *   GC 媒体前缀清单），保存完成后尽力清理副本（一次性交付物，同导出备份
 *   口径）；
 * - 失败语义：异常原样 throw（调用方编辑器屏 catch → store.error 红字，
 *   卡片保持可重试）；成功静默（文件落相册/下载开始即反馈）+ haptics.success。
 */

/** 抽帧参数：前 4 秒、每 0.5 秒一帧、共 8 帧（0ms 起步覆盖首帧）。 */
export const GIF_FRAME_COUNT = 8;
export const GIF_FRAME_INTERVAL_MS = 500;
/** 单帧缩边上限（宽）：帧像素预算的收口点（见文件头）。 */
export const GIF_MAX_WIDTH = 360;

export interface VideoGifResult {
    /** 保存落点（library = 相册 / downloaded = 浏览器下载）。 */
    destination: 'library' | 'shared' | 'downloaded';
    /** 实际抽取的帧数（个别时间点抽帧失败会跳过，至少 1 帧才可编码）。 */
    frames: number;
}

/** GIF 抽帧在单时间点失败（如超出时长/解码瞬时失败）时跳过该帧继续。 */
async function extractFrame(sourceUri: string, timeMs: number): Promise<GifFrame | null> {
    try {
        const thumbnail = await videoThumbnails.generateAsync(sourceUri, {
            timeMs,
            quality: 0.8,
        });
        const pixels = await readPixelsAsync(thumbnail.uri, {
            maxWidth: GIF_MAX_WIDTH,
        });
        return { rgba: pixels.rgba, width: pixels.width, height: pixels.height, delayMs: GIF_FRAME_INTERVAL_MS };
    } catch (error) {
        console.warn(`[video-gif] ${timeMs}ms 帧抽取失败（跳过）：`, error);
        return null;
    }
}

/** 视频转 GIF 并保存到手机（编排在屏层调用；文件落点与清理见文件头）。 */
export async function convertVideoToGif(sourceUri: string, suggestedName: string): Promise<VideoGifResult> {
    if (!videoThumbnails.isSupported()) {
        throw new Error('当前环境不支持视频抽帧（仅手机端可用）');
    }
    const frames: GifFrame[] = [];
    for (let i = 0; i < GIF_FRAME_COUNT; i++) {
        const frame = await extractFrame(sourceUri, i * GIF_FRAME_INTERVAL_MS);
        if (frame) frames.push(frame);
    }
    if (frames.length === 0) {
        throw new Error('没有抽到可用帧，视频可能已损坏');
    }
    // 同尺寸契约：readPixelsAsync 等比缩边到同一 maxWidth，但高度按各自宽高比
    // 独立取整——极端竖/横混排的源视频理论上可能差 1px，此处按首帧尺寸为基准
    // 校验，不一致时裁齐（GIF 全帧同尺寸是硬约束，encodeGif 会拒绝混尺寸）。
    const { width, height } = frames[0];
    for (const frame of frames) {
        if (frame.width !== width || frame.height !== height) {
            frame.rgba = cropToSize(frame, width, height);
            frame.width = width;
            frame.height = height;
        }
    }
    const gifBytes = encodeGif(frames);
    // file-storage key 段内字符集 [a-zA-Z0-9._-]：从建议名剥掉路径段与非法字符
    const safeStem = (suggestedName.replace(/\.[a-zA-Z0-9]+$/, '').match(/[a-zA-Z0-9._-]+/g) ?? []).join('-').slice(0, 64) || 'video';
    const key = `export/${safeStem}-${Date.now()}.gif`;
    await fileStorage.put(key, gifBytes);
    try {
        const uri = await fileStorage.url(key);
        const destination = await mediaLibrary.saveAsync(uri, 'image', {
            suggestedName: `${safeStem}.gif`,
        });
        haptics.success();
        return { destination, frames: frames.length };
    } finally {
        // 保存完成后清理副本（media-library web 下载路径已取走内容 / native 已入相册）
        await fileStorage.remove(key).catch((error: unknown) => {
            console.warn('[video-gif] GIF 副本清理失败：', error);
        });
    }
}

/** RGBA 像素裁切到目标尺寸（左上对齐；仅用于抽帧尺寸差 1px 的齐边兜底）。 */
function cropToSize(frame: GifFrame, width: number, height: number): Uint8Array {
    const cropped = new Uint8Array(width * height * 4);
    const copyWidth = Math.min(frame.width, width);
    const copyHeight = Math.min(frame.height, height);
    for (let y = 0; y < copyHeight; y++) {
        const from = (y * frame.width) * 4;
        const to = (y * width) * 4;
        cropped.set(frame.rgba.subarray(from, from + copyWidth * 4), to);
    }
    return cropped;
}
