import * as ScreenCapture from 'expo-screen-capture';
import { Platform } from 'react-native';

/**
 * 防截屏与录屏接口（expo-screen-capture，glossary §3 登记表已登记）。
 *
 * 三端差异（如实口径，依据 expo-screen-capture@58 源码核对）：
 * - Android：FLAG_SECURE 窗口旗标，系统级强制——截屏得到黑图、录屏黑屏、
 *   最近任务预览同黑；prevent 后直到 allow 或进程重启才解除；
 * - iOS：系统**没有官方"阻止用户截屏"的 API**（Apple 不提供）——库内用
 *   SecureWindowCanvas 覆盖层技巧近似防护（录屏经 UIScreen.isCaptured 盖黑块，
 *   截屏防护为覆盖层实现，效力依赖库内技巧而非系统保证）；另提供
 *   addScreenshotListener 截屏**事件监听**（只能感知不能阻止），本封装暂不
 *   收口（消费面出现再扩）；
 * - web：无系统级防截屏语义，恒 no-op——底层模块是空 stub，直调会抛
 *   UnavailabilityError，本封装先按平台分流再进底层。
 *
 * 薄封装铁律（error-handling R6）：expo 错误透传不包装，调用方自行决定失败
 * 呈现方式（失败策略属业务决策，不属于能力层）。
 */

/** 开启防截屏：Android FLAG_SECURE / iOS 库内覆盖层防护；web 恒 no-op。 */
export async function preventScreenCaptureAsync(): Promise<void> {
    if (Platform.OS === 'web') return;
    return ScreenCapture.preventScreenCaptureAsync();
}

/** 解除防截屏（与 prevent 配对；未开启时调用为无害 no-op）；web 恒 no-op。 */
export async function allowScreenCaptureAsync(): Promise<void> {
    if (Platform.OS === 'web') return;
    return ScreenCapture.allowScreenCaptureAsync();
}
