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
     * web 端 Web Share API 不可用时回退：取回内容（fetch）→ 触发浏览器下载。
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

async function downloadFallback(uri: string, filename: string): Promise<void> {
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
        anchor.download = filename;
        anchor.click();
    } finally {
        // 下载已触发，稍后释放引用
        globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 10_000);
    }
}
