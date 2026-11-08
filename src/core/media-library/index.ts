import { Platform } from 'react-native';
import * as LegacyMediaLibrary from 'expo-media-library/legacy';
import { sharing } from '@/core/sharing';
import { MediaLibraryError } from './errors';
import { downloadViaBrowser } from './web-download';

/**
 * 媒体保存到手机统一入口（glossary §3 `media-library`，2026-11-08 登记）：
 *
 * **平台 × 媒体类型保存矩阵**（saveAsync 内部收口，调用方零平台分支）：
 *
 * | 媒体类型 | native                      | web                |
 * |---------|-----------------------------|--------------------|
 * | 图/视频  | 系统相册（expo-media-library，权限预检+请求收口在本能力） | 浏览器下载（blob → anchor） |
 * | 音频     | 系统分享面板（expo-sharing，系统相册不收音频）       | 浏览器下载           |
 *
 * 返回落点（'library' | 'shared' | 'downloaded'）供调用方给差异化成功反馈。
 *
 * 权限语义：图/视频 native 保存需要相册**写入**权限（writeOnly=true，最小授权
 * ——不请求读相册）；未授权时先查后请求，拒绝抛
 * `media-library/permission-denied`（retryable=true，引导系统设置后可重试）。
 * 音频与 web 路径不经相册权限。
 *
 * 依赖方向：core→core（sharing 能力复用，音频 native 分享面板通道）；web 下载
 * 实现参照 core/sharing 的下载回退（fetch → blob → anchor，见 web-download.ts）。
 *
 * 底座说明（SDK 58）：expo-media-library 顶层导出的 saveToLibraryAsync 是
 * deprecated 桩（运行时直接抛错），实际 API 在官方保留的 `expo-media-library/legacy`
 * 子路径（package exports 明示）；web 官方构建为 stub（权限恒未授权、保存不可用
 * ——本能力运行时按平台分流，web 不触碰该模块调用面）。
 */

/** 可保存的媒体类型（与 journal_media.kind 对齐；core 不感知业务命名）。 */
export type MediaSaveKind = 'image' | 'video' | 'audio';

/** 保存落点：library = 已写入系统相册；shared = 已拉起系统分享面板（用户还需
 *  在面板里选保存目标）；downloaded = 已触发浏览器下载。 */
export type MediaSaveDestination = 'library' | 'shared' | 'downloaded';

export interface MediaSaveOptions {
    /** web 下载文件名建议（**带扩展名**优先——file-storage key 末段即真实容器
     *  扩展名）；native 音频分享面板复用为 dialogTitle。缺省时按落点推断。 */
    suggestedName?: string;
}

/** 音频扩展名 → mime（native 分享面板 Android 端需要 mimeType 才能识别类型；
 *  iOS 由文件扩展名推 UTI，mime 与之一致不冲突）。 */
const AUDIO_MIME_BY_EXT: Record<string, string> = {
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    webm: 'audio/webm',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
};

/** kind 的兜底文件名词干（suggestedName 缺失且 mime 推不出扩展名时的最后兜底）。 */
const FALLBACK_STEM: Record<MediaSaveKind, string> = {
    image: 'photo',
    video: 'video',
    audio: 'audio',
};

export const mediaLibrary = {
    /** 系统相册可用性（能力探测）：native 有系统相册（图/视频可入库）；web 无
     *  系统相册（统一走浏览器下载）。调用方可据此裁剪入口或调整文案。 */
    isSystemLibraryAvailable(): boolean {
        return Platform.OS !== 'web';
    },

    /** 查询相册写入权限（不弹窗；writeOnly=保存语义最小授权）。
     *  web stub 恒返回未授权——web 保存路径不经权限，本方法仅供 native 前置提示。 */
    async getWritePermissionAsync(): Promise<LegacyMediaLibrary.PermissionResponse> {
        return LegacyMediaLibrary.getPermissionsAsync(true);
    },

    /** 请求相册写入权限（首次调用弹系统弹窗；writeOnly 同上）。 */
    async requestWritePermissionAsync(): Promise<LegacyMediaLibrary.PermissionResponse> {
        return LegacyMediaLibrary.requestPermissionsAsync(true);
    },

    /**
     * 保存媒体到手机（统一入口，平台/类型分流内部收口）。
     * @param uri 本地媒体 URI：native 传 file:// 直路径（相册/分享面板直读）；
     *            web 传可 fetch 的 URL（file-storage 的 blob: URL 即可）。
     * @param kind 媒体类型（决定落点：相册/分享面板/下载）。
     * @returns 保存落点（调用方据此给差异化成功反馈）。
     * @throws MediaLibraryError（code 契约见 errors.ts 头注）。
     */
    async saveAsync(
        uri: string,
        kind: MediaSaveKind,
        options?: MediaSaveOptions,
    ): Promise<MediaSaveDestination> {
        const suggestedName = options?.suggestedName?.trim() ?? '';
        if (Platform.OS === 'web') {
            // web 无系统相册：图/视频/音频统一浏览器下载（web-download.ts）
            await downloadViaBrowser(uri, suggestedName || FALLBACK_STEM[kind]);
            return 'downloaded';
        }
        if (kind === 'audio') {
            // 音频 native：系统相册不收音频 → 系统分享面板（用户在面板里选
            // 「存储到文件」等目标）。错误统一收进本能力 code（cause 保原始）
            const ext = extensionOf(suggestedName);
            const mimeType = AUDIO_MIME_BY_EXT[ext];
            try {
                await sharing.shareAsync(uri, {
                    ...(mimeType ? { mimeType } : {}),
                    dialogTitle: suggestedName || FALLBACK_STEM.audio,
                });
                return 'shared';
            } catch (error) {
                if (error instanceof MediaLibraryError) throw error;
                throw new MediaLibraryError(
                    'media-library/save-failed',
                    `分享失败：${describe(error)}`,
                    error,
                    true,
                );
            }
        }
        // 图/视频 native：权限预检（已授 → 直存；未授 → 请求一次；拒绝 →
        // permission-denied，retryable=true——引导系统设置后重试可成功）
        let permission: LegacyMediaLibrary.PermissionResponse;
        try {
            permission = await LegacyMediaLibrary.getPermissionsAsync(true);
            if (!permission.granted) {
                permission = await LegacyMediaLibrary.requestPermissionsAsync(true);
            }
        } catch (error) {
            // 权限查询/弹窗被系统中断（reject）：按可重试的保存失败上浮，不静默
            throw new MediaLibraryError(
                'media-library/save-failed',
                `相册权限查询失败：${describe(error)}`,
                error,
                true,
            );
        }
        if (!permission.granted) {
            throw new MediaLibraryError(
                'media-library/permission-denied',
                '没有相册权限，去系统设置允许「照片」后重试。',
                undefined,
                true,
            );
        }
        try {
            await LegacyMediaLibrary.saveToLibraryAsync(uri);
            return 'library';
        } catch (error) {
            // expo 原生保存错误（编码/IO/路径非法）统一包装（R1：类型化归属 +
            // cause 保原始信息）；瞬时故障重试可成功 → retryable=true
            throw new MediaLibraryError(
                'media-library/save-failed',
                `保存到相册失败：${describe(error)}`,
                error,
                true,
            );
        }
    },
};

function extensionOf(name: string): string {
    const segment = name.split('/').filter(Boolean).pop() ?? '';
    const dot = segment.lastIndexOf('.');
    return dot > -1 ? segment.slice(dot + 1).toLowerCase() : '';
}

function describe(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error);
}

export { MediaLibraryError, type MediaLibraryErrorCode } from './errors';
export type { PermissionResponse as MediaLibraryPermissionResponse } from 'expo-media-library/legacy';
