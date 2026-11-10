import { useSyncExternalStore } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { getWebStorageDegradation, subscribeWebStorageDegradation } from './web-fallback';

/**
 * 降级提示条配色（由挂载方从语义 palette 注入——core 层禁止 import
 * @/features（H4），色值经 props 传入保持主题一致）。
 */
export interface WebStorageDegradationBannerColors {
    background: string;
    border: string;
    text: string;
}

/**
 * web 端数据库降级提示条：持久库打不开、会话内存库兜底生效时常驻展示。
 *
 * - **降级成功 ≠ 失败态**：内存库模式下数据读写正常，本条是「数据不落盘」的
 *   状态提示而非错误页；屏层 error/dead-end 语义不受影响。
 * - native 恒渲染 null（Android/iOS 无此概念，挂载点零副作用）。
 * - useSyncExternalStore 订阅 web-fallback 状态：无降级时不渲染、降级时单次
 *   重渲（markWebStorageDegraded 首事件通知一次），无轮询无风暴。
 * - absolute 定位挂根布局 Stack 之后（同 RecordingSessionHost 层级），盖在
 *   内容之上；用 RN 合法样式（position: 'absolute'），避免 RN-web fixed 兼容面。
 */
export function WebStorageDegradationBanner({ colors }: { colors: WebStorageDegradationBannerColors }) {
    const degradation = useSyncExternalStore(subscribeWebStorageDegradation, getWebStorageDegradation);
    if (Platform.OS !== 'web') return null;
    if (!degradation) return null;
    return (
        <View
            style={[
                styles.banner,
                { backgroundColor: colors.background, borderColor: colors.border },
            ]}
        >
            <Text style={[styles.dot, { color: colors.text }]}>{'●'}</Text>
            <Text style={[styles.text, { color: colors.text }]}>
                {degradation.reason}。关闭多余标签页或清理站点数据后刷新页面可恢复持久保存。
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    banner: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    dot: {
        fontSize: 10,
        lineHeight: 16,
    },
    text: {
        flex: 1,
        fontSize: 12,
        lineHeight: 16,
    },
});
