import { LibraryScreen } from '@/features/archive';

/**
 * 笔记堆路由（v8，/notes）：Me 页「笔记」行进入——只翻笔记卡（2026-11-19
 * 用户指令「笔记就是笔记，不是笔记和行程」）。route adapter 模式与
 * search/settings 同款，屏内 kind 由壳注入。
 */
export default function NotesRoute() {
    return <LibraryScreen kind="note" />;
}
