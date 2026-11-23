import { EventDetailScreen } from '@/features/archive';

/**
 * 事件详情路由（/events/[id]）：计划编辑式正文（BlockEditor 复用）+ 工单状态头。
 * route adapter 模式与 trip/[id] 一致：路由参数由屏组件经 useLocalSearchParams
 * 自理，路由层只做壳。
 */
export default function EventDetailRoute() {
    return <EventDetailScreen />;
}
