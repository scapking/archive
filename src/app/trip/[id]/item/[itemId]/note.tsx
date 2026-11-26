import { useLocalSearchParams } from 'expo-router';
// 深路径注记：TripItemNoteScreen 未入域 barrel（features/archive/index.ts 不在
// 本轮改动权限内），app 层深取直连（day/[date].tsx 深路径直连先例同款）；
// barrel 出口扩充时收口。
import { TripItemNoteScreen } from '@/features/archive/trip-item-note-screen';

/**
 * 行程项笔记编辑面路由（v0.5.3 轮 A 令 1）：路径参数传参（web push 丢 query
 * 的登记偏差，跨屏参数一律走路径段，day/[date] 同法）；itemId = 行程项 id。
 */
export default function TripItemNoteRoute() {
    const { id, itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
    return <TripItemNoteScreen tripId={id} itemId={itemId} />;
}
