import { useLocalSearchParams } from 'expo-router';
import { JournalEditScreen } from '@/features/archive';

/**
 * 独立笔记编辑器路由（v8，/note/[id]）：路径参数（web push 丢 query，见
 * AGENTS.md 偏差表）。编辑器按 journal.kind === 'note' 自动进入笔记模式
 * （无收笔语义），与 /journal/[id] 共用 journal-edit-screen 单一实现。
 */
export default function NoteRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <JournalEditScreen journalId={id} />;
}
