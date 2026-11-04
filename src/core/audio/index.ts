import * as Audio from 'expo-audio';

/**
 * 通用音频接口：播放与全局音频模式（expo-audio，三端）。
 * 录制器由 useAudioRecorder hook 创建（React 层，features 使用），
 * 本模块收口与组件/hook 无关的调用。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const audio = {
    /**
     * 设置全局音频行为（静音键、后台播放、录制打断其他音频等）。
     * 全 app 一般只设一次（app 启动或首次播放前）。
     */
    setAudioModeAsync: Audio.setAudioModeAsync,

    /** 创建音频播放器（非 hook 形式，UI 绑定用 features 侧的 useAudioPlayer）。 */
    createAudioPlayer: Audio.createAudioPlayer,

    /** 查询录音权限（不弹窗）。 */
    getRecordingPermissionAsync: Audio.getRecordingPermissionsAsync,

    /** 请求录音权限（首次调用弹系统弹窗）。 */
    requestRecordingPermissionAsync: Audio.requestRecordingPermissionsAsync,
};

export {
    /** 常用录音参数预设（HIGH_QUALITY / LOW_QUALITY），配合 features 侧录制 hook 使用。 */
    RecordingPresets,
} from 'expo-audio';

export type { AudioMode, AudioPlayer, AudioRecorder, AudioSource, AudioStatus } from 'expo-audio';
