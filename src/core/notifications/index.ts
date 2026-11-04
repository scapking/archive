import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { NotificationError, toNotificationError } from './errors';

/**
 * 通用通知接口：本地通知、推送 token、权限、前台展示行为，三端统一门面。
 * API 形态对齐 expo-notifications 官方语义（本模块只做收口、错误包装与平台差异抹平）。
 *
 * 平台行为差异（接口一致，能力按平台尽力而为）：
 * - web：本地通知可用（需注册 expo 提供的 service worker）；推送 token 需要
 *   浏览器 Push 订阅支持，不可用时抛 NotificationError('unsupported')；
 * - Android 13+：展示通知前需先 requestPermission()；
 * - createChannel 仅 Android 生效，其余平台为空操作（调用方无需区分）。
 */
export type NotificationHandler = Notifications.NotificationHandler;
export type NotificationBehavior = Notifications.NotificationBehavior;
export type NotificationContentInput = Notifications.NotificationContentInput;
export type NotificationTriggerInput = Notifications.NotificationTriggerInput;
export type ScheduledNotification = Notifications.NotificationRequest;
export type PushToken = Notifications.DevicePushToken;
export type EventSubscription = Notifications.EventSubscription;

export const notifications = {
    /** 请求通知权限，返回是否已获准。 */
    async requestPermission(): Promise<boolean> {
        try {
            const status = await Notifications.requestPermissionsAsync();
            return status.granted;
        } catch (error) {
            throw toNotificationError(error, 'notifications.requestPermission()');
        }
    },

    /** 查询当前权限是否已获准（不弹窗）。 */
    async getPermission(): Promise<boolean> {
        try {
            const status = await Notifications.getPermissionsAsync();
            return status.granted;
        } catch (error) {
            throw toNotificationError(error, 'notifications.getPermission()');
        }
    },

    /**
     * 设备推送 token（FCM / APNs / Web PushSubscription）。
     * 平台或配置不支持时抛 NotificationError（原始信息注明原因）。
     */
    async getDevicePushToken(): Promise<PushToken> {
        try {
            return await Notifications.getDevicePushTokenAsync();
        } catch (error) {
            throw toNotificationError(error, 'notifications.getDevicePushToken()');
        }
    },

    /** Expo 推送 token（配合 Expo push service；projectId 来自 app config 的 extra.eas.projectId）。 */
    async getExpoPushToken(projectId: string): Promise<string> {
        if (projectId.length === 0) {
            throw new NotificationError('notification/invalid-token', 'notifications.getExpoPushToken: projectId 不能为空');
        }
        try {
            const token = await Notifications.getExpoPushTokenAsync({ projectId });
            return token.data;
        } catch (error) {
            throw toNotificationError(error, 'notifications.getExpoPushToken()');
        }
    },

    /** 设置前台收到通知时的展示行为（应用在前台时系统默认不展示，需 handler 决定）。 */
    setHandler(handler: NotificationHandler | null): void {
        Notifications.setNotificationHandler(handler);
    },

    /**
     * 调度通知；trigger 传 null = 立即展示。返回通知 id 用于取消。
     * 注意：前台展示与否由 setHandler 决定（expo-notifications 语义）。
     */
    async schedule(
        content: NotificationContentInput,
        trigger: NotificationTriggerInput = null,
    ): Promise<string> {
        try {
            return await Notifications.scheduleNotificationAsync({ content, trigger });
        } catch (error) {
            throw toNotificationError(error, 'notifications.schedule()');
        }
    },

    /** 取消一条已调度通知；id 不存在同样视为成功（幂等）。 */
    async cancel(id: string): Promise<void> {
        try {
            await Notifications.cancelScheduledNotificationAsync(id);
        } catch (error) {
            throw toNotificationError(error, `notifications.cancel(${id})`);
        }
    },

    /** 取消全部已调度通知。 */
    async cancelAll(): Promise<void> {
        try {
            await Notifications.cancelAllScheduledNotificationsAsync();
        } catch (error) {
            throw toNotificationError(error, 'notifications.cancelAll()');
        }
    },

    /** 列出全部已调度通知。 */
    async listScheduled(): Promise<ScheduledNotification[]> {
        try {
            return await Notifications.getAllScheduledNotificationsAsync();
        } catch (error) {
            throw toNotificationError(error, 'notifications.listScheduled()');
        }
    },

    /**
     * 创建 Android 通知渠道（Android 8+ 展示通知需要）；其他平台空操作。
     */
    async createChannel(
        id: string,
        name: string,
        importance?: Notifications.AndroidImportance,
    ): Promise<void> {
        if (Platform.OS !== 'android') return;
        try {
            await Notifications.setNotificationChannelAsync(id, {
                name,
                importance: importance ?? Notifications.AndroidImportance.DEFAULT,
            });
        } catch (error) {
            throw toNotificationError(error, `notifications.createChannel(${id})`);
        }
    },

    /** 订阅"通知到达"事件（前台/后台行为依平台）。返回句柄，调用 .remove() 退订。 */
    onReceived(listener: (notification: Notifications.Notification) => void): EventSubscription {
        return Notifications.addNotificationReceivedListener(listener);
    },

    /** 订阅"用户点击通知"事件。返回句柄，调用 .remove() 退订。 */
    onResponse(listener: (response: Notifications.NotificationResponse) => void): EventSubscription {
        return Notifications.addNotificationResponseReceivedListener(listener);
    },
};
