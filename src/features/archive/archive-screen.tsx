import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideBookOpen, LucideCalendar } from '@/core/icons';
import { useArchiveRevision, useArchiveStore } from './store';
import { getJournalByDate } from './db';
import { formatDateGroupLabel, mediaCount, previewText } from './journal-logic';
import { parseBlocks } from './journal-logic';
import { formatTripRange } from './trip-logic';
import { todayLocal } from './trip-logic';
import { CardDeck } from './ui/deck';
import { StatusChip } from './ui/status-chip';
import { ComposeFab } from './ui/compose-fab';
import { EmptyState } from './ui/empty-state';
import { MediaThumb } from './ui/media-view';
import { useJournalMedia } from './ui/use-file-url';
import type { JournalRow } from './db';

/**
 * Archive 首页：行程与当前日记两张卡，重叠、左右若隐若现。
 * 点前卡直接进内容；点后卡交换；+ 号选择要写日记还是建行程。
 */
export function ArchiveScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const trips = useArchiveStore((s) => s.trips);
    const metrics = useArchiveStore((s) => s.metrics);
    const loadAll = useArchiveStore((s) => s.loadAll);
    const revision = useArchiveRevision();

    const [todayJournal, setTodayJournal] = useState<JournalRow | null>(null);
    const [chooserOpen, setChooserOpen] = useState(false);

    useEffect(() => {
        if (!ready) void loadAll();
    }, [ready, loadAll]);
    useEffect(() => {
        let active = true;
        getJournalByDate(null, todayLocal()).then((row) => {
            if (active) setTodayJournal(row);
        });
        return () => {
            active = false;
        };
    }, [revision, ready]);

    const deckTrip = trips.length > 0 ? trips[0] : null;
    const today = todayLocal();
    const journalLabel = formatDateGroupLabel(today, today);

    if (!ready) {
        return (
            <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
                <ActivityIndicator color="#3B82F6" />
            </View>
        );
    }

    const noContent = !todayJournal && !deckTrip;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <View className="px-6 pb-1 pt-2">
                    <Text className="text-[17px] font-semibold text-ink-text dark:text-inkd-text">
                        Archive
                    </Text>
                    <Text className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary">
                        {metrics.streak > 0
                            ? `连续记录 ${metrics.streak} 天 · 点卡片进入内容`
                            : '行程与今天的一页，都在这里'}
                    </Text>
                    {error ? (
                        <Text className="mt-1 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    ) : null}
                </View>

                {noContent ? (
                    <EmptyState
                        icon={<LucideBookOpen size={40} color="#8B939C" />}
                        title="一切都还没开始"
                        hint="写下今天的第一页，或先建一个行程。"
                        actionLabel="写今天的日记"
                        onAction={() => router.push('/write')}
                    />
                ) : (
                    <View className="px-5">
                        <View className="mx-auto w-full max-w-[560px]">
                            <CardDeck
                                a={{ id: 'journal', node: <JournalCard journal={todayJournal} label={journalLabel} /> }}
                                b={{ id: 'trip', node: <TripCard trip={deckTrip} /> }}
                                onPressCard={(id, isFront) => {
                                    if (!isFront) return;
                                    if (id === 'journal') router.push('/write');
                                    else if (deckTrip) router.push({ pathname: '/trip/[id]', params: { id: deckTrip.id } });
                                }}
                            />
                            <View className="mt-3 flex-row items-center justify-center gap-1.5">
                                <View className="h-1.5 w-1.5 rounded-full bg-ink-accent dark:bg-inkd-accent" />
                                <View className="h-1.5 w-1.5 rounded-full bg-ink-faint dark:bg-inkd-faint" />
                            </View>
                        </View>
                    </View>
                )}
            </View>

            <ComposeFab onPress={() => setChooserOpen(true)} accessibilityLabel="新建" />

            {/* + 选择器：写日记 / 建行程 */}
            <Modal visible={chooserOpen} transparent animationType="fade" onRequestClose={() => setChooserOpen(false)}>
                <Pressable
                    className="flex-1 items-center justify-center bg-black/50 px-10"
                    onPress={() => setChooserOpen(false)}
                >
                    <Pressable className="w-full max-w-sm rounded-2xl border border-ink-border bg-ink-base p-5 dark:border-inkd-border dark:bg-inkd-base">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            开始什么？
                        </Text>
                        <View className="mt-4 gap-2.5">
                            <BouncyPressable
                                onPress={() => {
                                    setChooserOpen(false);
                                    router.push('/write');
                                }}
                                scaleTo={0.97}
                            >
                                <View className="flex-row items-center gap-3 rounded-lg border border-ink-border bg-ink-surface p-4 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised">
                                    <View className="h-10 w-10 items-center justify-center rounded-lg bg-ink-accent-bg dark:bg-inkd-accent-bg">
                                        <LucideBookOpen size={20} color="#3B82F6" />
                                    </View>
                                    <View className="flex-1">
                                        <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                            今天的日记
                                        </Text>
                                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                                            连续写，24:00 自动收笔
                                        </Text>
                                    </View>
                                </View>
                            </BouncyPressable>
                            <BouncyPressable
                                onPress={() => {
                                    setChooserOpen(false);
                                    router.push('/trip/new');
                                }}
                                scaleTo={0.97}
                            >
                                <View className="flex-row items-center gap-3 rounded-lg border border-ink-border bg-ink-surface p-4 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised">
                                    <View className="h-10 w-10 items-center justify-center rounded-lg bg-ink-accent-bg dark:bg-inkd-accent-bg">
                                        <LucideCalendar size={20} color="#3B82F6" />
                                    </View>
                                    <View className="flex-1">
                                        <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                            新的行程
                                        </Text>
                                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                                            图标、视频、逐日骨架
                                        </Text>
                                    </View>
                                </View>
                            </BouncyPressable>
                        </View>
                    </Pressable>
                </Pressable>
            </Modal>
        </View>
    );
}

/** 日记卡：今天的一页。 */
function JournalCard({ journal, label }: { journal: JournalRow | null; label: ReturnType<typeof formatDateGroupLabel> }) {
    if (!journal) {
        return (
            <CardShell>
                <View className="flex-1 items-center justify-center gap-2">
                    <LucideBookOpen size={34} color="#8B939C" />
                    <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                        {label.monthDay} {label.weekday}
                    </Text>
                    <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">
                        今天的一页还没写
                    </Text>
                </View>
            </CardShell>
        );
    }
    const blocks = parseBlocks(journal.blocks);
    const mediaRows = useJournalMedia(journal.id);
    const thumbs = mediaRows.slice(0, 3);
    return (
        <CardShell>
            <View className="flex-row items-center justify-between">
                <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                    {label.monthDay} {label.weekday}
                    {label.relative ? (
                        <Text className="ml-2 text-[11px] font-medium text-ink-accent dark:text-inkd-accent">
                            {label.relative}
                        </Text>
                    ) : null}
                </Text>
                <Text
                    className={`text-[11px] ${journal.status === 'open' ? 'text-ink-accent dark:text-inkd-accent' : 'text-ink-muted dark:text-inkd-muted'}`}
                >
                    {journal.status === 'open' ? '进行中' : '已收笔'}
                </Text>
            </View>
            <Text className="mt-3 text-[14px] leading-6 text-ink-secondary dark:text-inkd-secondary">
                {previewText(blocks) || '还没写字，插入一张图也算。'}
            </Text>
            {thumbs.length > 0 ? (
                <View className="mt-3 flex-row gap-2">
                    {thumbs.map((row) => (
                        <MediaThumb key={row.id} media={row} />
                    ))}
                </View>
            ) : null}
            <View className="mt-auto flex-row items-center justify-between">
                <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">
                    {mediaCount(blocks) > 0 ? `${mediaCount(blocks)} 个媒体 · ` : ''}
                    {journal.word_count} 字
                </Text>
                <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                    继续写 →
                </Text>
            </View>
        </CardShell>
    );
}

/** 行程卡：图标 + 标题 + 区间 + 状态 + 进度。 */
function TripCard({ trip }: { trip: ReturnType<typeof useArchiveStore.getState>['trips'][number] | null }) {
    if (!trip) {
        return (
            <CardShell>
                <View className="flex-1 items-center justify-center gap-2">
                    <LucideCalendar size={34} color="#8B939C" />
                    <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">还没有行程</Text>
                    <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">+ 号里可以创建</Text>
                </View>
            </CardShell>
        );
    }
    const planPct = trip.plansTotal > 0 ? Math.round((trip.plansDone / trip.plansTotal) * 100) : null;
    return (
        <CardShell>
            <View className="flex-row items-center justify-between">
                <Text className="text-[26px] leading-8">{trip.icon ?? '🧭'}</Text>
                <StatusChip status={trip.status} />
            </View>
            <Text className="mt-2 text-[17px] font-semibold text-ink-text dark:text-inkd-text">
                {trip.title}
            </Text>
            <Text className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary">
                {formatTripRange(trip.start_date, trip.end_date)} · {trip.dayCount} 天
            </Text>
            {trip.description ? (
                <Text numberOfLines={2} className="mt-2 text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                    {trip.description}
                </Text>
            ) : null}
            <View className="mt-auto">
                {planPct !== null ? (
                    <View className="mb-2">
                        <View className="h-1 w-full rounded-full bg-ink-raised dark:bg-inkd-raised">
                            <View
                                className="h-1 rounded-full bg-ink-accent dark:bg-inkd-accent"
                                style={{ width: `${planPct}%` }}
                            />
                        </View>
                        <Text className="mt-1 text-[11px] text-ink-muted dark:text-inkd-muted">
                            计划完成 {planPct}%
                        </Text>
                    </View>
                ) : null}
                <View className="flex-row items-center justify-between">
                    <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">
                        已写 {trip.journalDays}/{trip.dayCount} 天
                    </Text>
                    <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                        查看行程 →
                    </Text>
                </View>
            </View>
        </CardShell>
    );
}

function CardShell({ children }: { children: React.ReactNode }) {
    return (
        <View className="h-full rounded-2xl border border-ink-border bg-ink-surface p-5 shadow-none dark:border-inkd-border dark:bg-inkd-surface">
            {children}
        </View>
    );
}
