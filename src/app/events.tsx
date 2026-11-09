import { EventsScreen } from '@/features/archive';

/**
 * 事件列表路由（/events）：工单式容器（搜索 + 状态筛选 + 时间线卡流）。
 * route adapter 模式与 trip/[id] 一致：路由层只做壳，屏 props 由屏组件自理。
 */
export default function EventsRoute() {
    return <EventsScreen />;
}
