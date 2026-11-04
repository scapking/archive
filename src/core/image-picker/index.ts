import * as ImagePicker from 'expo-image-picker';

/**
 * 通用图片/视频选取接口（expo-image-picker，三端）。
 * web 端：mediaLibrary 走文件选择器；camera 走 getUserMedia 取景框。
 * 结果统一为 ImagePickerResult：canceled=true 时其余字段无意义。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const imagePicker = {
    /** 拉起系统相册/文件选择。 */
    launchImageLibraryAsync: ImagePicker.launchImageLibraryAsync,

    /** 拉起相机拍摄。需先获准相机权限。 */
    launchCameraAsync: ImagePicker.launchCameraAsync,

    /** 查询媒体库权限（不弹窗）。 */
    getMediaLibraryPermissionAsync: ImagePicker.getMediaLibraryPermissionsAsync,

    /** 请求媒体库权限（首次调用弹系统弹窗）。 */
    requestMediaLibraryPermissionAsync: ImagePicker.requestMediaLibraryPermissionsAsync,

    /** 查询相机权限（不弹窗）。 */
    getCameraPermissionAsync: ImagePicker.getCameraPermissionsAsync,

    /** 请求相机权限（首次调用弹系统弹窗）。 */
    requestCameraPermissionAsync: ImagePicker.requestCameraPermissionsAsync,
};

export type {
    ImagePickerOptions,
    ImagePickerResult,
    CameraPermissionResponse,
    MediaLibraryPermissionResponse,
} from 'expo-image-picker';
