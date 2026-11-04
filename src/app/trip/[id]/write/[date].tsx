import { useLocalSearchParams } from 'expo-router';
import { EntryNewScreen } from '@/features/archive';

/**
 * 行程详情入口写碎片：tripId 与日期全走路径参数——
 * 本仓库 web 构建下 router.push 的 query 会被丢弃（见 AGENTS.md 偏差表），
 * 路径参数三端行为一致。路由适配层负责把 [id]/[date] 映射为屏的 props。
 */
export default function TripWriteRoute() {
    const { id, date } = useLocalSearchParams<{ id: string; date: string }>();
    return <EntryNewScreen tripId={id} date={date} />;
}
