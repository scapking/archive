import { EventFormScreen } from '@/features/archive';

/**
 * 新建事件路由（/events/new）：极简表单（标题必填 + 自动定位 + 可选元信息），
 * 成功 replace 进 /events/[id]。route adapter 模式与 trip/new 一致。
 */
export default function EventNewRoute() {
    return <EventFormScreen />;
}
