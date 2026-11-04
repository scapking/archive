import * as Location from 'expo-location';
import { Platform } from 'react-native';

/**
 * 通用定位接口：前台定位与地理编码（expo-location，三端）。
 * web 端走浏览器 Geolocation API（首次调用触发浏览器权限弹窗）。
 * 后台定位（startLocationUpdatesAsync）不支持 web，未纳入本接口。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const location = {
    /** 查询前台定位权限（不弹窗）。 */
    getPermissionAsync: Location.getForegroundPermissionsAsync,

    /** 请求前台定位权限（首次调用弹系统弹窗）。 */
    requestPermissionAsync: Location.requestForegroundPermissionsAsync,

    /** 系统定位服务是否开启（权限获准但服务关闭时仍取不到位置）。 */
    hasServicesEnabledAsync: Location.hasServicesEnabledAsync,

    /** 获取当前一次性定位。 */
    getCurrentPositionAsync: Location.getCurrentPositionAsync,

    /**
     * 获取系统缓存的最近一次定位；无则 null。
     * web 端无"最近缓存位置"概念，恒返回 null（三端一致的语义：null = 未知）。
     */
    async getLastKnownPositionAsync(): Promise<Location.LocationObject | null> {
        if (Platform.OS === 'web') return null;
        return Location.getLastKnownPositionAsync();
    },

    /**
     * 持续监听定位变化，返回订阅句柄（调用 .remove() 停止）。
     * 三端同一签名。
     */
    watchPositionAsync: Location.watchPositionAsync,

    /** 地址 → 坐标。 */
    geocodeAsync: Location.geocodeAsync,

    /** 坐标 → 地址。 */
    reverseGeocodeAsync: Location.reverseGeocodeAsync,
};

export type {
    LocationObject,
    LocationOptions,
    LocationSubscription,
    LocationPermissionResponse,
    LocationGeocodedLocation,
    LocationGeocodedAddress,
} from 'expo-location';
