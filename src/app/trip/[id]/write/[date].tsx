import { useLocalSearchParams } from 'expo-router';
import { JournalEditScreen } from '@/features/archive';

/** 行程某天的一页：路径参数（web push 丢 query，见 AGENTS.md 偏差表）。 */
export default function TripWriteRoute() {
    const { id, date } = useLocalSearchParams<{ id: string; date: string }>();
    return <JournalEditScreen tripId={id} date={date} />;
}
