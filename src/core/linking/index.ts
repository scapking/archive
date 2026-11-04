import * as Linking from 'expo-linking';
import { Linking as ReactNativeLinking } from 'react-native';

/**
 * 通用深链/外链接口（expo-linking + react-native Linking，三端）。
 * expo-linking 负责 URL 的构造与解析（<app-scheme>://，见 app.json 的 scheme）；系统跳转收口自 react-native Linking。
 * 薄封装：不吞错误。
 */
export const linking = {
    /** 用 app scheme 构造深链 URL，如 createURL('settings', { queryParams: { a: '1' } })。 */
    createURL: Linking.createURL,

    /** 解析 URL（scheme/host/path/queryParams）。 */
    parse: Linking.parse,

    /** 解析冷启动时的初始 URL（scheme 跳入）。 */
    parseInitialURLAsync: Linking.parseInitialURLAsync,

    /** 订阅运行期间的 URL 打开事件。返回句柄，调用 .remove() 退订。 */
    addUrlEventListener: Linking.addEventListener,

    /** 用系统方式打开 URL（外部浏览器/其他 app）。 */
    openURL: ReactNativeLinking.openURL,

    /** 查询当前环境是否能打开该 URL。 */
    canOpenURL: ReactNativeLinking.canOpenURL,
};

export type { ParsedURL, CreateURLOptions, URLListener } from 'expo-linking';
