import { PlanFormScreen } from '@/features/archive';

/**
 * 新建独立计划路由（v8，/plan/new）：首页 + 选择器「新建计划」与库页进入，
 * route adapter 模式与 trip/new 一致——路由层只做壳，屏组件自理。
 */
export default function NoteNewRoute() {
    return <PlanFormScreen />;
}
