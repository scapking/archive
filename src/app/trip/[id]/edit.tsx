import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { LoadingView, TripFormScreen, useArchiveStore } from '@/features/archive';

/** 编辑行程：按 id 载入后进表单（取数走域入口 resolveTrip，不做深路径 import）。 */
export default function TripEditRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const resolveTrip = useArchiveStore((s) => s.resolveTrip);
    const [trip, setTrip] = useState<Awaited<ReturnType<typeof resolveTrip>>>(null);
    const [missing, setMissing] = useState(false);

    useEffect(() => {
        let active = true;
        if (typeof id === 'string') {
            void resolveTrip(id).then((row) => {
                if (!active) return;
                if (row) setTrip(row);
                else setMissing(true);
            });
        }
        return () => {
            active = false;
        };
    }, [id, resolveTrip]);

    if (missing) {
        return (
            <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <Text className="text-[14px] text-ink-muted dark:text-inkd-muted">行程不存在</Text>
            </View>
        );
    }
    if (!trip) return <LoadingView />;
    return <TripFormScreen trip={trip} />;
}
