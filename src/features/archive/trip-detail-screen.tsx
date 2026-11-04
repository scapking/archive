import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
    BouncyPressable,
    LucideCalendar,
    LucideCheck,
    LucidePencil,
    LucidePlus,
} from '@/core/icons';
import * as db from './db';
import { useArchiveRevision } from './store';
import {
    daysInclusiveRange,
    decorateTrip,
    formatDateParts,
    formatTripRange,
    todayLocal,
} from './trip-logic';
import { previewText, parseBlocks } from './journal-logic';
import { StatusChip } from './ui/status-chip';
import { ScreenHeader } from './ui/screen-header';
import { EmptyState } from './ui/empty-state';
import { MediaThumb } from './ui/media-view';
import { MediaVideo } from './ui/media-view';

/**
 * 行程详情：图标 + 封面视频 + 描述 + 逐日骨架（D1…Dn）——
 * 每天的计划条目（计划态）与日记页（回忆态）。数据自持 + 订阅 store.revision。
 */
interface DaySection {
    localDate: string;
    dayNo: number;
    plans: db.DayPlanRow[];
    journals: db.JournalRow[];
    mediaByJournal: Map<string, db.JournalMediaRow[]>;
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
        const [planRows, journalRows] = await Promise.all([
            db.listDayPlansByTrip(id),
            db.listJournalsByTrip(id),
        ]);
        const mediaByJournal = await db.mediaByJournalIds(journalRows.map((j) => j.id));
        const plansByDate = new Map<string, db.DayPlanRow[]>();
        for (const plan of planRows) {
            const bucket = plansByDate.get(plan.local_date);
            if (bucket) bucket.push(plan);
            else plansByDate.set(plan.local_date, [plan]);
        }
        const journalsByDate = new Map<string, db.JournalRow[]>();
        for (const journal of journalRows) {
            const bucket = journalsByDate.get(journal.local_date);
            if (bucket) bucket.push(journal);
            else journalsByDate.set(journal.local_date, [journal]);
        }
        const today = todayLocal();
        setSections(
            daysInclusiveRange(row.start_date, row.end_date).map((localDate, index) => ({
                localDate,
                dayNo: index + 1,
                plans: plansByDate.get(localDate) ?? [],
                journals: journalsByDate.get(localDate) ?? [],
                mediaByJournal,
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
            <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <ActivityIndicator color="#3B82F6" />
            </View>
        );
    }
    if (missing || !trip) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base" style={{ paddingTop: 60 }}>
                <ScreenHeader title="行程" />
                <EmptyState
                    icon={<LucideCalendar size={40} color="#8B939C" />}
                    title="找不到这个行程"
                    hint="它可能已被删除。回到 Archive 看看其他内容。"
                    actionLabel="返回"
                    onAction={() => router.back()}
                />
            </View>
        );
    }

    const writtenDays = sections.filter((s) => s.journals.length > 0).length;
    const plansTotal = sections.reduce((sum, s) => sum + s.plans.length, 0);
    const plansDone = sections.reduce((sum, s) => sum + s.plans.filter((p) => p.done === 1).length, 0);

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <ScreenHeader
                    title={`${trip.icon ?? '🧭'} ${trip.title}`}
                    subtitle={`${formatTripRange(trip.start_date, trip.end_date)} · ${trip.dayCount} 天 · 已写 ${writtenDays}/${trip.dayCount} 天`}
                    right={
                        <BouncyPressable
                            onPress={() =>
                                router.push({ pathname: '/trip/[id]/edit', params: { id: trip.id } })
                            }
                            scaleTo={0.9}
                        >
                            <View className="h-9 w-9 items-center justify-center rounded-md border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface">
                                <LucidePencil size={16} color="#5A626B" />
                            </View>
                        </BouncyPressable>
                    }
                />
                <FlatList
                    data={sections}
                    keyExtractor={(section) => section.localDate}
                    ListHeaderComponent={
                        <View className="px-6">
                            {trip.video_key ? (
                                <View className="mb-4">
                                    <MediaVideo media={previewVideoRow(trip.video_key)} height={190} />
                                </View>
                            ) : null}
                            {trip.description ? (
                                <Text className="mb-4 text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                                    {trip.description}
                                </Text>
                            ) : null}
                            {plansTotal > 0 ? (
                                <View className="mb-4">
                                    <View className="h-1 w-full rounded-full bg-ink-raised dark:bg-inkd-raised">
                                        <View
                                            className="h-1 rounded-full bg-ink-accent dark:bg-inkd-accent"
                                            style={{
                                                width: `${Math.round((plansDone / plansTotal) * 100)}%`,
                                            }}
                                        />
                                    </View>
                                    <Text className="mt-1 text-[11px] text-ink-muted dark:text-inkd-muted">
                                        计划完成 {plansDone}/{plansTotal}
                                    </Text>
                                </View>
                            ) : null}
                        </View>
                    }
                    renderItem={({ item }) => (
                        <DayView section={item} tripId={trip.id} onChanged={reload} />
                    )}
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 32,
                        alignSelf: 'center',
                        width: '100%',
                        maxWidth: 668,
                    }}
                />
            </View>
        </View>
    );
}

/** 一天：骨架行 + 计划清单 + 日记页 + 写入口。 */
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
                    className="text-[12px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    D{section.dayNo}
                </Text>
                <Text className="ml-2.5 text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                    {monthDay}
                </Text>
                <Text className="ml-2 text-[12px] text-ink-muted dark:text-inkd-muted">{weekday}</Text>
                {isToday ? (
                    <Text className="ml-2 text-[11px] font-medium text-ink-accent dark:text-inkd-accent">
                        今天
                    </Text>
                ) : null}
            </View>

            {section.plans.map((plan) => (
                <Pressable
                    key={plan.id}
                    onPress={() => void togglePlan(plan)}
                    className="mb-1.5 flex-row items-center"
                    accessibilityRole="checkbox"
                    accessibilityLabel={`计划：${plan.content}`}
                >
                    <View
                        className={`h-5 w-5 items-center justify-center rounded-md border ${
                            plan.done === 1
                                ? 'border-ink-accent bg-ink-accent dark:border-inkd-accent dark:bg-inkd-accent'
                                : 'border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface'
                        }`}
                    >
                        {plan.done === 1 ? (
                            <LucideCheck size={13} color="#FFFFFF" strokeWidth={2.5} />
                        ) : null}
                    </View>
                    <Text
                        className={`ml-2.5 flex-1 text-[14px] ${
                            plan.done === 1
                                ? 'text-ink-muted line-through dark:text-inkd-muted'
                                : 'text-ink-text dark:text-inkd-text'
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
                        className="h-10 flex-1 rounded-lg border border-ink-border bg-ink-surface px-3 text-[14px] text-ink-text dark:border-inkd-border dark:bg-inkd-surface dark:text-inkd-text"
                        placeholder="这一天打算做什么？"
                        placeholderTextColor="#8B939C"
                        value={draft}
                        onChangeText={setDraft}
                        onSubmitEditing={() => void submitPlan()}
                        returnKeyType="done"
                        blurOnSubmit={false}
                    />
                    <BouncyPressable onPress={() => void submitPlan()} scaleTo={0.9}>
                        <View className="ml-2 h-10 w-10 items-center justify-center rounded-lg border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface">
                            <LucideCheck size={16} color="#3B82F6" />
                        </View>
                    </BouncyPressable>
                </View>
            ) : null}

            {section.journals.map((journal) => {
                const blocks = parseBlocks(journal.blocks);
                const media = section.mediaByJournal.get(journal.id) ?? [];
                return (
                    <Pressable
                        key={journal.id}
                        onPress={() =>
                            router.push({ pathname: '/journal/[id]', params: { id: journal.id } })
                        }
                        className="mb-2 rounded-lg border border-ink-border bg-ink-surface px-4 py-3 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised"
                    >
                        <Text className="text-[14px] leading-6 text-ink-text dark:text-inkd-text">
                            {previewText(blocks) || '[图片与视频]'}
                        </Text>
                        <View className="mt-2.5 flex-row items-center justify-between">
                            {media.length > 0 ? (
                                <View className="flex-row gap-1.5">
                                    {media.slice(0, 3).map((row) => (
                                        <MediaThumb key={row.id} media={row} size={40} />
                                    ))}
                                </View>
                            ) : (
                                <View />
                            )}
                            <Text
                                className={`text-[11px] ${
                                    journal.status === 'open'
                                        ? 'text-ink-accent dark:text-inkd-accent'
                                        : 'text-ink-muted dark:text-inkd-muted'
                                }`}
                            >
                                {journal.status === 'open' ? '进行中' : '已收笔'}
                            </Text>
                        </View>
                    </Pressable>
                );
            })}

            <View className="mt-2.5 flex-row items-center gap-2">
                {!adding ? (
                    <GhostButton
                        label="添加计划"
                        onPress={() => setAdding(true)}
                    />
                ) : null}
                <GhostButton
                    label="写今天这页"
                    onPress={() =>
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
            <View className="h-8 flex-row items-center rounded-md border border-ink-border bg-ink-surface px-3 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised">
                {label === '添加计划' ? <LucidePlus size={13} color="#5A626B" /> : null}
                <Text className="ml-1 text-[12px] text-ink-secondary dark:text-inkd-secondary">{label}</Text>
            </View>
        </BouncyPressable>
    );
}

/** 编辑预览用媒体行（真实行以 DB 为准）。 */
function previewVideoRow(fileKey: string) {
    return {
        id: 'trip-cover',
        journal_id: 'trip-cover',
        file_key: fileKey,
        kind: 'video' as const,
        width: null,
        height: null,
        created_at: 0,
        deleted_at: null,
    };
}
