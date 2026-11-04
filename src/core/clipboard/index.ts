import * as Clipboard from 'expo-clipboard';

/**
 * 通用剪贴板接口（expo-clipboard）。
 * web 端走 navigator.clipboard，首次读取可能触发浏览器权限弹窗。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const clipboard = {
    /** 读取文本；剪贴板为空/非文本返回空串。 */
    getStringAsync: Clipboard.getStringAsync,

    /** 写入文本；返回是否成功（web 端可能因权限失败返回 false）。 */
    setStringAsync: Clipboard.setStringAsync,

    hasStringAsync: Clipboard.hasStringAsync,

    /** 读取 URL；无 URL 返回 null。 */
    getUrlAsync: Clipboard.getUrlAsync,

    setUrlAsync: Clipboard.setUrlAsync,

    /** 读取剪贴板图片（返回 base64 PNG）；无图返回 null。 */
    getImageAsync: Clipboard.getImageAsync,

    /** 写入图片（base64 PNG）。 */
    setImageAsync: Clipboard.setImageAsync,
};
