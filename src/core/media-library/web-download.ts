import { MediaLibraryError } from './errors';

/**
 * web 端「保存到手机」的落点：浏览器下载（fetch 取回字节 → blob → anchor 触发）。
 * web 无系统相册，这是图/视频/音频统一的最终落点；实现参照 core/sharing 的
 * 下载回退（同构模式：取字节 → 临时 objectURL → click → 延迟 revoke）。
 *
 * 错误契约（error-handling.md R2 media-library 行）：
 * - 环境缺下载 API（SSR / 老内核）→ `media-library/unsupported`（retryable=false）；
 * - 字节取回失败（网络/OPFS 读取）→ `media-library/save-failed`（retryable=true）。
 */

/** 常见 mime → 扩展名（blob: URI 的路径名推不出扩展名时按响应 mime 补齐）。 */
const MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/webm': 'webm',
};

export async function downloadViaBrowser(uri: string, fallbackName: string): Promise<void> {
    if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) {
        throw new MediaLibraryError(
            'media-library/unsupported',
            '当前浏览器环境不支持下载保存。',
            undefined,
            false,
        );
    }
    let response: Response;
    try {
        response = await fetch(uri);
    } catch (error) {
        throw new MediaLibraryError(
            'media-library/save-failed',
            `取回媒体内容失败，请重试。`,
            error,
            true,
        );
    }
    if (!response.ok) {
        throw new MediaLibraryError(
            'media-library/save-failed',
            `取回媒体内容失败（${response.status}），请重试。`,
            undefined,
            true,
        );
    }
    const blob = await response.blob().catch((error) => {
        throw new MediaLibraryError('media-library/save-failed', '读取媒体内容失败，请重试。', error, true);
    });
    const url = globalThis.URL.createObjectURL(blob);
    try {
        const anchor = globalThis.document.createElement('a');
        anchor.href = url;
        anchor.download = inferDownloadFilename(uri, blob.type, fallbackName);
        anchor.click();
    } finally {
        // 下载已触发，稍后释放引用（保留窗口覆盖浏览器异步取流的延迟）
        globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 10_000);
    }
}

/**
 * 下载文件名推断：① fallbackName 自带扩展名（file-storage key 末段，入库段
 * 命名保证真实容器扩展名）→ 原样使用；② 无扩展名 → 按响应 mime 补齐；③ 都
 * 推不出 → 保留 fallback 名（下载能成功，只是系统可能不识别类型）。
 */
function inferDownloadFilename(uri: string, mimeType: string, fallbackName: string): string {
    const fallback = fallbackName || 'media';
    if (/\.[a-zA-Z0-9]{1,8}$/.test(fallback)) return fallback;
    const mimeExtension = MIME_EXTENSIONS[mimeType.split(';')[0].trim().toLowerCase()];
    if (mimeExtension) return `${fallback}.${mimeExtension}`;
    // URI 路径末段兜底（blob: 的 uuid 名无扩展名时该分支通常也拿不到，仅直链场景有用）
    const segment = uri.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
    if (/\.[a-zA-Z0-9]{1,8}$/.test(segment)) return decodeURIComponentSafe(segment);
    return fallback;
}

function decodeURIComponentSafe(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text; // 含非法百分号编码时退回原文
    }
}
