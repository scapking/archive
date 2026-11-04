import { useLocalSearchParams } from 'expo-router';
import { JournalEditScreen } from '@/features/archive';

/** 直达某篇日记（me 页搜索结果 / 行程详情点击）。 */
export default function JournalRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <JournalEditScreen journalId={id} />;
}
