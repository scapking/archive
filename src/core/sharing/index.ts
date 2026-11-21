import * as Sharing from 'expo-sharing';
import { SharingError } from './errors';

/**
 * 通用系统分享接口（expo-sharing）。
 * native 走系统分享面板；web 端优先 Web Share API，
 * 不可用时自动回退为浏览器下载（弥合三端差异，调用方无需分支）。
 * 薄封装：native 透传 expo CodedError；web 回退路径的错误为 SharingError。
 */
export const sharing = {
    /** 当前平台是否支持分享（web 端取决于 Web Share API；不支持时 shareAsync 自动走下载回退）。 */
    isAvailableAsync: Sharing.isAvailableAsync,

    /**
     * 分享本地文件或远程 URL。
     * web 端 Web Share API 不可用时回退：取回内容（fetch）→ 触发浏览器下载；
     * 下载文件名从 URI 路径/blob mime 推断，dialogTitle 仅作分享标题不充当文件名。
     */
    async shareAsync(uri: string, options?: Sharing.SharingOptions): Promise<void> {
        if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(uri, options);
            return;
        }
        await downloadFallback(uri, options?.dialogTitle ?? 'download');
    },
};

export type { SharingOptions } from 'expo-sharing';
export { SharingError, type SharingErrorCode } from './errors';

async function downloadFallback(uri: string, fallbackName: string): Promise<void> {
    if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) {
        throw new SharingError('sharing/unsupported', '当前环境既不支持分享也不支持下载');
    }
    let response: Response;
    try {
        response = await fetch(uri);
    } catch (error) {
        throw new SharingError('sharing/io', `取回分享内容失败（${uri}）`, error);
    }
    if (!response.ok) {
        throw new SharingError('sharing/io', `取回分享内容失败（${response.status}）`);
    }
    const blob = await response.blob();
    const url = globalThis.URL.createObjectURL(blob);
    try {
        const anchor = globalThis.document.createElement('a');
        anchor.href = url;
        anchor.download = inferDownloadFilename(uri, blob.type, fallbackName);
        anchor.click();
    } finally {
        // 下载已触发，稍后释放引用
        globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 10_000);
    }
}

/** 常见 mime → 扩展名（下载回退无法从 URI 推断扩展名时补齐，保证 OS 能识别文件类型）。 */
const MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/mp4': 'm4a',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/json': 'json',
    'text/plain': 'txt',
    'text/html': 'html',
};

/**
 * 从 URI 路径名与 blob mime 推断下载文件名：
 * ① URI 路径末段（去查询/片段）自带扩展名 → 原样使用；
 * ② 路径末段无扩展名但 mime 可识别 → 补扩展名（如 blob: 的 uuid 名）；
 * ③ 都推断不出 → 保留原兜底名（dialogTitle ?? 'download'），mime 可识别时同样补扩展名。
 */
function inferDownloadFilename(uri: string, mimeType: string, fallbackName: string): string {
    const fallback = fallbackName || 'download';
    const segment = uri.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '';
    const mimeExtension = MIME_EXTENSIONS[mimeType.split(';')[0].trim().toLowerCase()];
    const name = segment ? decodeURIComponentSafe(segment) : '';
    if (/\.[a-zA-Z0-9]{1,8}$/.test(name)) return name;
    if (name && mimeExtension) return `${name}.${mimeExtension}`;
    if (mimeExtension) return `${fallback}.${mimeExtension}`;
    return fallback;
}

function decodeURIComponentSafe(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text; // 含非法百分号编码时退回原文
    }
}
