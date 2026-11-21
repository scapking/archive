import * as Print from 'expo-print';
import { Platform } from 'react-native';

/**
 * 打印/文档生成接口（expo-print，glossary §3 已登记）。
 *
 * 薄封装（error-handling.md R4）：不吞错误、不包装——底层 CodedError 原样抛出。
 * 三端口径：native（iOS/Android）走系统 HTML→PDF 渲染（AirPrint 管线离线产物，
 * 落临时目录返回 file:// URI）；web 官方构建为 stub（调用期抛错），isSupported()
 * 为唯一分流口径——web 端调用方降级为 HTML 文件下载（经 sharing 能力）。
 */
export const print = {
    /** 当前平台是否支持 HTML→PDF（web 无实现恒 false，调用方据此降级）。 */
    isSupported(): boolean {
        return Platform.OS !== 'web';
    },

    /**
     * 把 HTML 文档渲染为 PDF 文件（系统临时目录），返回 { uri }（file://）。
     * 产物生命周期归系统临时目录管理，调用方分享后无需清理。
     */
    async printToFileAsync(html: string): Promise<{ uri: string }> {
        return Print.printToFileAsync({ html });
    },
};
