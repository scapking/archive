import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { createVideoPlayer, type VideoPlayer, type VideoTrack } from 'expo-video';

/**
 * 视频自然尺寸探测 hook（use-video-natural-size.ts）——「竖版视频封面容器
 * 左右空白」的根因修复面。
 *
 * 根因：录像入库（expo-camera recordAsync）只回 uri 无宽高 → journal_media
 * 行 width/height 为 null → 封面态容器回退 16:9 横比例 → 竖版视频左右信箱
 * 空白（media-view MEDIA_VIDEO 回退档）。相册选入的视频有 picker 落库宽高，
 * 不走本探测（行为不变）。
 *
 * expo-video 58 API 核实结论（node_modules/expo-video/build 类型 + 原生源码，
 * v58.0.13）：**VideoPlayer 无 `naturalSize` 属性**（58 版已移除旧 API）。可用
 * 路径 = `player.videoTrack?.size` / `player.availableVideoTracks[].size`
 * （`VideoSize { width, height }`，像素、编码分辨率）。就绪时机：
 * - Android：ExoPlayer onTracksChanged → availableVideoTracks 填充并同轮发出
 *   `sourceLoad`；currentVideoTrack 在 onVideoInputFormatChanged 落定并发出
 *   `videoTrackChange`；`statusChange('readyToPlay')` 在 STATE_READY。
 * - iOS：`statusChange('readyToPlay')` 先到，availableVideoTracks 由异步
 *   tracksLoadingTask 完成后填充并补发 `sourceLoad`；currentVideoTrack 落定
 *   发 `videoTrackChange`。
 * - Web：VideoPlayerWeb 的 videoTrack 恒 null、availableVideoTracks 恒 []，
 *   `sourceLoad`/`videoTrackChange` 不发；纯 player（不挂 VideoView）status
 *   恒 'idle'，探测不可行 → 本 hook 在 web 直接禁用（web 封面维持 16:9 +
 *   contain 现状回退，零回归）。
 *
 * 实现口径：createVideoPlayer 建**纯 JS player 实例**（不渲染 VideoView，无
 * 画面、不占 surface；不调用 play() 故不发声，另加 muted 双保险），订阅
 * statusChange / sourceLoad / videoTrackChange 三事件作就绪信号——任一到达
 * 即尝试读轨道尺寸（多信号兜底 iOS 上 ready 先于 tracks 的时序差），读到
 * 有效 { width, height } 后立即拆监听并 release player（探测结束不背资源）。
 * statusChange('error') 同样拆除（解析失败不值得继续挂事件）。
 *
 * 生命周期：createVideoPlayer 返回 SharedObject、**不随组件卸载自动
 * release**（与 useVideoPlayer 的 hook 托管路径不同），故 effect cleanup
 * 必须显式 `player.release()`；cleanup 先 remove 全部监听再 release，
 * 防 release 后事件回调落在已销毁对象上。
 *
 * 局限（如实记录）：两端 size 均为**编码分辨率**，未应用容器旋转元数据
 * （iOS 未套 preferredTransform、Android Format 不含 rotationDegrees）。
 * iPhone 竖录轨道 naturalSize 本身即竖版（正确）；Android MediaRecorder 类
 * 竖录（编码横 + rotation 90）会探得横尺寸——expo-video 58 未向 JS 暴露
 * rotation，无法在探测层校正，该场景容器比例仍横（不差于现状回退）。
 *
 * 「随机选封面帧」未做：封面帧 = player 首帧的既有视觉语言，抽帧需要渲染
 * 器/生成缩略图（generateThumbnailsAsync 需真实播放管线 + VideoThumbnail
 * 渲染依赖），超出本修复面（见任务口径）。
 */

/** 探测结果（像素，含竖版 orientation：width < height 即竖版画幅）。 */
export interface VideoNaturalSize {
    width: number;
    height: number;
}

/** 从 player 轨道状态读首个有效尺寸（0/非法值拒收，HLS 多轨取首条有效）。 */
function readTrackSize(player: VideoPlayer): VideoNaturalSize | null {
    // videoTrack 可为 null（未就绪），availableVideoTracks 可为空数组——合并
    // 候选后取首个有效项
    const candidates: Array<VideoTrack | null> = [
        player.videoTrack,
        ...player.availableVideoTracks,
    ];
    for (const track of candidates) {
        if (!track) continue;
        const { width, height } = track.size;
        if (
            typeof width === 'number' && Number.isFinite(width) && width > 0 &&
            typeof height === 'number' && Number.isFinite(height) && height > 0
        ) {
            return { width, height };
        }
    }
    return null;
}

/**
 * 探测视频自然尺寸。
 *
 * @param uri 待探测的视频 URI（file:// 等）；传 null = 不探测（相册视频有
 *            元数据、外层组件用该参数关断探测，零 player 开销）。
 * @returns 探测到的尺寸；探测中 / 平台不支持 / 解析失败返回 null（消费方
 *          维持既有回退比例渲染，探测到后一次切换，无中间抖动）。
 */
export function useVideoNaturalSize(uri: string | null): VideoNaturalSize | null {
    const [size, setSize] = useState<VideoNaturalSize | null>(null);

    useEffect(() => {
        // web 的 VideoPlayerWeb 无轨道数据（见文件头），直接禁用探测
        if (!uri || Platform.OS === 'web') return undefined;
        let active = true;
        let done = false;
        const player = createVideoPlayer({ uri });
        player.muted = true;
        const subscriptions: Array<{ remove(): void }> = [];
        const teardown = () => {
            for (const subscription of subscriptions) subscription.remove();
            player.release();
        };
        // 任一就绪信号到达即读一次轨道尺寸；error 状态无轨道可读，放弃探测
        const onSignal = () => {
            if (done) return;
            if (player.status === 'error') {
                done = true;
                teardown();
                return;
            }
            const next = readTrackSize(player);
            if (!next) return;
            done = true;
            if (active) setSize(next);
            // 探测完成即拆：player 只为量尺寸存在，不参与封面渲染
            //（封面仍由媒体块自身的 VideoView 承担，两条 player 互不相干）
            teardown();
        };
        // 三事件兜底就绪时序差（iOS ready 先于 tracks、Android tracks 先于
        // ready，见文件头核实结论）；addListener 句柄入数组供 teardown 统一拆
        subscriptions.push(
            player.addListener('statusChange', onSignal),
            player.addListener('sourceLoad', onSignal),
            player.addListener('videoTrackChange', onSignal),
        );
        return () => {
            active = false;
            // 未完成的探测：拆监听 + release（createVideoPlayer 不自动托管，
            // 漏 release = native player 泄漏）；已完成的探测已自行拆过
            if (!done) teardown();
        };
    }, [uri]);

    return size;
}
