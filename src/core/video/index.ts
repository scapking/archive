import * as Video from 'expo-video';

/**
 * 通用视频接口：播放器工厂与缓存管理（expo-video，三端）。
 * 画面渲染由 VideoView 组件承载（React 层，features 使用），
 * 本模块收口与组件无关的调用。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const video = {
    /** 创建视频播放器（非 hook 形式；组件绑定用 features 侧的 useVideoPlayer）。 */
    createVideoPlayer: Video.createVideoPlayer,

    /** 清空视频缓存（网络流的本地缓存）。 */
    clearVideoCacheAsync: Video.clearVideoCacheAsync,

    /** 设置视频缓存上限（字节）。 */
    setVideoCacheSizeAsync: Video.setVideoCacheSizeAsync,

    /** 当前视频缓存占用（字节）。 */
    getCurrentVideoCacheSize: Video.getCurrentVideoCacheSize,
};

export type { VideoPlayer, VideoSource, PlayerBuilderOptions } from 'expo-video';
