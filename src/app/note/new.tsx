import { NoteFormScreen } from '@/features/archive';

/**
 * 新建独立笔记路由（v8，/note/new）：首页 + 选择器「新建笔记」与库页进入，
 * route adapter 模式与 trip/new 一致——路由层只做壳，屏组件自理。
 */
export default function NoteNewRoute() {
    return <NoteFormScreen />;
}
