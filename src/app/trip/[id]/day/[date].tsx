import { useLocalSearchParams } from 'expo-router';
// 深路径注记：TripDayScreen 未入域 barrel（features/archive/index.ts 不在本轮
// 改动权限内），app 层深取直连（_layout.tsx 深路径直连先例同款）；barrel 出口
// 扩充时收口。
import { TripDayScreen } from '@/features/archive/trip-day-screen';

/** 行程某天的行程表页：路径参数（web push 丢 query，见 AGENTS.md 偏差表）。 */
export default function TripDayRoute() {
    const { id, date } = useLocalSearchParams<{ id: string; date: string }>();
    return <TripDayScreen tripId={id} date={date} />;
}
