import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { BouncyPressable, LucideCalendar, LucideCheck, LucidePlus } from '@/core/icons';
import { crypto } from '@/core/crypto';
import * as db from './db';
import { useArchiveRevision } from './store';
import {
    daysInclusiveRange,
    decorateTrip,
    formatDateParts,
    formatTripRange,
    todayLocal,
} from './trip-logic';
import { groupEntriesByDate } from './entry-logic';
import { StatusChip } from './ui/status-chip';
import { EntryCard } from './ui/entry-card';
import { ScreenHeader } from './ui/screen-header';
import { EmptyState } from './ui/empty-state';

/**
 * 行程详情：天骨架（D1…Dn）逐日展开——每天的计划条目（计划态）与碎片（回忆态）。
 * 数据自持 + 订阅 store.revision（写碎片返回后重载）。
 */
interface DaySection {
    localDate: string;
    dayNo: number;
    plans: db.DayPlanRow[];
    entries: db.EntryRow[];
    photos: Map<string, db.PhotoRow[]>;
}

export function TripDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const revision = useArchiveRevision();

    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);
    const [trip, setTrip] = useState<ReturnType<typeof decorateTrip> | null>(null);
    const [sections, setSections] = useState<DaySection[]>([]);

    const reload = useCallback(async () => {
        if (typeof id !== 'string') {
            setMissing(true);
            setLoading(false);
            return;
        }
        const row = await db.getTrip(id);
        if (!row) {
            setMissing(true);
            setLoading(false);
            return;
        }
        const [planRows, entryRows] = await Promise.all([
            db.listDayPlansByTrip(id),
            db.listEntriesByTrip(id),
        ]);
        const photosByEntry = await db.listPhotosByEntries(entryRows.map((e) => e.id));
        const plansByDate = new Map<string, db.DayPlanRow[]>();
        for (const plan of planRows) {
            const bucket = plansByDate.get(plan.local_date);
            if (bucket) bucket.push(plan);
            else plansByDate.set(plan.local_date, [plan]);
        }
        const entryGroups = groupEntriesByDate(entryRows, photosByEntry);
        const entriesByDate = new Map(entryGroups.map((g) => [g.localDate, g.entries]));
        const today = todayLocal();
        setSections(
            daysInclusiveRange(row.start_date, row.end_date).map((localDate, index) => ({
                localDate,
                dayNo: index + 1,
                plans: plansByDate.get(localDate) ?? [],
                entries: entriesByDate.get(localDate) ?? [],
                photos: photosByEntry,
            })),
        );
        setTrip(decorateTrip(row, today));
        setLoading(false);
    }, [id]);

    useEffect(() => {
        void reload();
    }, [reload, revision]);

    if (loading) {
        return (
            <View className="flex-1 items-center justify-center bg-hatch-base">
                <ActivityIndicator color="#10B981" />
            </View>
        );
    }
    if (missing || !trip) {
        return (
            <View className="flex-1 bg-hatch-base" style={{ paddingTop: 60 }}>
                <ScreenHeader title="行程" />
                <EmptyState
                    icon={<LucideCalendar size={40} color="#5F6664" />}
                    title="找不到这个行程"
                    hint="它可能已被删除。回到列表看看其他的。"
                    actionLabel="返回"
                    onAction={() => router.back()}
                />
            </View>
        );
    }

    const writtenDays = sections.filter((s) => s.entries.length > 0).length;

    return (
        <View className="flex-1 bg-hatch-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <ScreenHeader
                    title={trip.title}
                    subtitle={`${formatTripRange(trip.start_date, trip.end_date)} · ${trip.dayCount} 天 · 已写 ${writtenDays}/${trip.dayCount} 天${trip.note ? `\n${trip.note}` : ''}`}
                    right={<StatusChip status={trip.status} />}
                />
                <FlatList
                    data={sections}
                    keyExtractor={(section) => section.localDate}
                    renderItem={({ item }) => <DayView section={item} tripId={trip.id} onChanged={reload} />}
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 32,
                    }}
                />
            </View>
        </View>
    );
}

/** 一天：骨架行 + 计划清单 + 碎片 + 写入口。 */
function DayView({
    section,
    tripId,
    onChanged,
}: {
    section: DaySection;
    tripId: string;
    onChanged(): void;
}) {
    const router = useRouter();
    const [adding, setAdding] = useState(false);
    const [draft, setDraft] = useState('');
    const { monthDay, weekday } = formatDateParts(section.localDate);
    const isToday = section.localDate === todayLocal();

    const submitPlan = async () => {
        const content = draft.trim();
        if (!content) return;
        const now = Date.now();
        await db.insertDayPlan({
            id: crypto.randomUUID(),
            trip_id: tripId,
            local_date: section.localDate,
            content,
            sort_order: section.plans.length,
            done: 0,
            created_at: now,
            updated_at: now,
        });
        setDraft('');
        setAdding(false);
        onChanged();
    };

    const togglePlan = async (plan: db.DayPlanRow) => {
        await db.setDayPlanDone(plan.id, plan.done === 0);
        onChanged();
    };

    return (
        <View className="mb-7">
            <View className="mb-2.5 flex-row items-baseline">
                <Text
                    className="text-[12px] text-hatch-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    D{section.dayNo}
                </Text>
                <Text className="ml-2.5 text-[15px] font-semibold text-hatch-text">{monthDay}</Text>
                <Text className="ml-2 text-[12px] text-hatch-muted">{weekday}</Text>
                {isToday ? (
                    <Text className="ml-2 text-[11px] font-medium text-hatch-accent">今天</Text>
                ) : null}
            </View>

            {/* 计划（行程的计划态） */}
            {section.plans.map((plan) => (
                <Pressable
                    key={plan.id}
                    onPress={() => void togglePlan(plan)}
                    className="mb-1.5 flex-row items-center"
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: plan.done === 1 }}
                    accessibilityLabel={`计划：${plan.content}`}
                >
                    <View
                        className={`h-5 w-5 items-center justify-center rounded-md border ${
                            plan.done === 1
                                ? 'border-hatch-accent bg-hatch-accent'
                                : 'border-hatch-border bg-hatch-surface'
                        }`}
                    >
                        {plan.done === 1 ? <LucideCheck size={13} color="#080A0A" strokeWidth={2.5} /> : null}
                    </View>
                    <Text
                        className={`ml-2.5 flex-1 text-[14px] ${
                            plan.done === 1
                                ? 'text-hatch-muted line-through'
                                : 'text-hatch-text'
                        }`}
                    >
                        {plan.content}
                    </Text>
                </Pressable>
            ))}

            {adding ? (
                <View className="mb-1.5 flex-row items-center">
                    <TextInput
                        autoFocus
                        className="h-10 flex-1 rounded-lg border border-hatch-border bg-hatch-surface px-3 text-[14px] text-hatch-text"
                        placeholder="这一天打算做什么？"
                        placeholderTextColor="#5F6664"
                        value={draft}
                        onChangeText={setDraft}
                        onSubmitEditing={() => void submitPlan()}
                        returnKeyType="done"
                        blurOnSubmit={false}
                    />
                    <BouncyPressable onPress={() => void submitPlan()} scaleTo={0.9}>
                        <View className="ml-2 h-10 w-10 items-center justify-center rounded-lg border border-hatch-border bg-hatch-surface">
                            <LucideCheck size={16} color="#10B981" />
                        </View>
                    </BouncyPressable>
                </View>
            ) : null}

            {/* 碎片（行程的回忆态） */}
            <View className="gap-2">
                {section.entries.map((entry) => (
                    <EntryCard
                        key={entry.id}
                        entry={{
                            ...entry,
                            photos: section.photos.get(entry.id) ?? [],
                        }}
                    />
                ))}
            </View>

            <View className="mt-2.5 flex-row items-center gap-2">
                {!adding ? (
                    <GhostButton
                        label={section.plans.length > 0 ? '加一条计划' : '添加计划'}
                        onPress={() => setAdding(true)}
                    />
                ) : null}
                <GhostButton
                    label="写一条"
                    onPress={() =>
                        // 参数全走路径：web push 的 query 会被丢弃（AGENTS.md 偏差表），路径参数三端一致
                        router.push(`/trip/${tripId}/write/${section.localDate}`)
                    }
                />
            </View>
        </View>
    );
}

function GhostButton({ label, onPress }: { label: string; onPress(): void }) {
    return (
        <BouncyPressable onPress={onPress} scaleTo={0.96}>
            <View className="h-8 flex-row items-center rounded-md border border-hatch-border bg-hatch-surface px-3 active:bg-hatch-raised">
                {label === '添加计划' || label === '加一条计划' ? (
                    <LucidePlus size={13} color="#9BA1A0" />
                ) : null}
                <Text className="ml-1 text-[12px] text-hatch-secondary">{label}</Text>
            </View>
        </BouncyPressable>
    );
}
