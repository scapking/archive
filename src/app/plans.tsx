import { LibraryScreen } from '@/features/archive';

/**
 * 计划堆路由（v8，/notes）：Me 页「计划」行进入——只翻计划卡（2026-11-19
 * 用户指令「计划就是计划，不是计划和行程」）。route adapter 模式与
 * search/settings 同款，屏内 kind 由壳注入。
 */
export default function NotesRoute() {
    return <LibraryScreen kind="note" />;
}
