import { PlanFormScreen } from '@/features/archive';

/**
 * 新建独立计划路由（v8，/plan/new）：首页 + 选择器「新建计划」与库页进入，
 * route adapter 模式与 trip/new、events/new 一致——路由层只做壳，屏组件自理
 * （v0.4.5 起屏内为分步创建向导：标题 → 描述逐步揭示 + 直接创建，对齐事件）。
 */
export default function NoteNewRoute() {
    return <PlanFormScreen />;
}
