import * as WebBrowser from 'expo-web-browser';

/**
 * 通用外部浏览器接口（expo-web-browser）。
 * native 为应用内浏览器会话（Chrome Custom Tabs / SFSafariViewController）；
 * web 端为打开新标签页。三端同一调用。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const webBrowser = {
    /** 打开 URL（应用内浏览器/新标签页）。 */
    openBrowserAsync: WebBrowser.openBrowserAsync,

    /** 关闭当前浏览器会话。 */
    dismissBrowser: WebBrowser.dismissBrowser,

    /** OAuth 式授权会话（等待跳回 redirectUrl）。 */
    openAuthSessionAsync: WebBrowser.openAuthSessionAsync,

    /** 关闭授权会话。 */
    dismissAuthSession: WebBrowser.dismissAuthSession,
};

export type {
    WebBrowserOpenOptions,
    WebBrowserResult,
    WebBrowserAuthSessionResult,
} from 'expo-web-browser';
