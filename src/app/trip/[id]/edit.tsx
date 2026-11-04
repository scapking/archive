import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { getTrip } from '@/features/archive/db';
import { TripFormScreen } from '@/features/archive';

/** 编辑行程：按 id 载入后进表单。 */
export default function TripEditRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [trip, setTrip] = useState<Awaited<ReturnType<typeof getTrip>>>(null);
    const [missing, setMissing] = useState(false);

    useEffect(() => {
        let active = true;
        if (typeof id === 'string') {
            getTrip(id).then((row) => {
                if (!active) return;
                if (row) setTrip(row);
                else setMissing(true);
            });
        }
        return () => {
            active = false;
        };
    }, [id]);

    if (missing) {
        return (
            <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <Text className="text-[14px] text-ink-muted dark:text-inkd-muted">行程不存在</Text>
            </View>
        );
    }
    if (!trip) {
        return (
            <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <ActivityIndicator color="#3B82F6" />
            </View>
        );
    }
    return <TripFormScreen trip={trip} />;
}
