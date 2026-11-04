import { Camera, scanFromURLAsync } from 'expo-camera';
import type { PermissionResponse } from 'expo';

/**
 * 通用相机接口：权限与纯函数能力（expo-camera，三端）。
 * 取景、拍照、录像、扫码的实时交互由 CameraView 组件承载（React 层，features 使用），
 * 本模块只收口与组件无关的调用。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const camera = {
    /** 查询相机权限（不弹窗）。 */
    getPermissionAsync: Camera.getCameraPermissionsAsync,

    /** 请求相机权限（首次调用弹系统弹窗）。 */
    requestPermissionAsync: Camera.requestCameraPermissionsAsync,

    /** 查询麦克风权限（录像需要，不弹窗）。 */
    getMicrophonePermissionAsync: Camera.getMicrophonePermissionsAsync,

    /** 请求麦克风权限（录像需要）。 */
    requestMicrophonePermissionAsync: Camera.requestMicrophonePermissionsAsync,

    /** 扫描网络图片中的条码/二维码（iOS 仅支持二维码）。 */
    scanFromURLAsync,
};

export type { PermissionResponse };
export type { BarcodeScanningResult, BarcodeType } from 'expo-camera';
