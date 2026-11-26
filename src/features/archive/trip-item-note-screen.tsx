import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LucideStickyNote } from '@/core/icons';
import { haptics } from '@/core/haptics';
import * as db from './db';
import { useArchiveRevision, useArchiveStore } from './store';
// 标题展示唯一走 tripItemDisplayTitle（空标题零兜底词，卡面同款纪律）
import { tripItemDisplayTitle } from './trip-item-logic';
import { isTripLocked, todayLocal } from './trip-logic';
// 「表单编辑」回跳信号宿主在 trip-day-screen（消费端持有 editItem 通道；
// trip-day 不反向依赖本屏，无 require 环——DeadEndView 同款跨屏取用先例）
import { requestTripItemFormEdit } from './trip-day-screen';
// 深路径注记：FieldInput 未入 ui/index.ts 出口，域内深取（trip-day 同款）
import { FieldInput } from './ui/field-input';
import {
    LoadingView,
    ScreenHeader,
    safeBack,
    usePalette,
} from './ui';
import { DeadEndView } from './journal-edit-screen';

/**
 * 行程项笔记编辑面（v0.5.3 轮 A 令 1，/trip/[id]/item/[itemId]/note）：
 * 「进入编辑」不再直通行程项表单，而是进这张**纸感大正文页**直接写备注
 * （description）——行程项的笔记主角化，标题/时刻退为只读信息行。
 *
 * 解剖（简洁至上，对齐新建行程的克制度；零渐变，纸×墨 token）：
 * - 屏头：ScreenHeader 统一规格（24/600 无副题），屏题 = 时刻；
 * - 信息行：时刻 + 标题只读回显（空标题不渲染、禁兜底词）——要改标题/时刻
 *   走底部「表单编辑」进旧行程项表单（该形态保留为次级入口）；
 * - 主体 = 一张纸面大正文输入（canvas 档 FieldInput、multiline、flex-1，
 *   字号走日记正文档 16/行高 26），**失焦即 updateTripItemContent
 *   ({description}) 落库**（store 单源：trim/锁定拒绝/闹钟重挂）；
 * - 底部动作行（钉屏底，v0.5.2 事件向导同款：KeyboardAvoidingView iOS
 *   padding 通道 + h-12 flex-1 双钮）：左 ghost「表单编辑」= 先落库、携
 *   最新行快照挂一次性回跳信号（requestTripItemFormEdit）、router.back()
 *   回行程表页并打开该步表单编辑态（信号消费见 trip-day-screen
 *   useFocusEffect 段）；右 primary「完成」= 落库成功后返回，失败留页经
 *   store.error 通道可见可重试；
 * - 只读态：行程锁定（isTripLocked）时正文不可编、无「表单编辑」（表单会
 *   被锁定闸拒），只剩「完成」= 返回；
 * - 冷启动深链：对齐 trip-day 的 hydration 竞态纪律——storeReady 闸 +
 *   瞬态错误重试预算（700/1600/2600ms 三轮，耗尽才走死路页），不把启动
 *   竞态锁死成「找不到」。
 */
export function TripItemNoteScreen({ tripId, itemId }: { tripId: string; itemId: string }) {
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const revision = useArchiveRevision();
    const storeReady = useArchiveStore((s) => s.ready);
    const storeError = useArchiveStore((s) => s.error);

    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);
    const [item, setItem] = useState<db.TripItemRow | null>(null);
    const [locked, setLocked] = useState(false);
    const [draft, setDraft] = useState('');
    const [saveFailed, setSaveFailed] = useState(false);
    // 正文初值只在首次装载成功时灌入（后续 revision 重载不得覆盖正打的字）
    const draftInitRef = useRef(false);
    const savingRef = useRef(false);
    // 冷启动/锁争用重试预算（trip-day 同款）
    const loadRetryRef = useRef(0);
    const loadRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const reload = useCallback(async () => {
        if (
            typeof tripId !== 'string' || tripId.length === 0 ||
            typeof itemId !== 'string' || itemId.length === 0
        ) {
            setMissing(true);
            setLoading(false);
            return;
        }
        if (!storeReady) return; // hydration 竞态闸：未就绪不查库，ready 翻真自动补跑
        try {
            const row = await db.getTripItem(itemId);
            // 路由参数成对校验：item 不存在或不属于 URL 里的行程 = 死路（防跨行程串数据）
            if (!row || row.trip_id !== tripId) {
                setMissing(true);
                return;
            }
            const trip = await db.getTrip(row.trip_id);
            if (!trip) {
                setMissing(true);
                return;
            }
            setItem(row);
            setLocked(isTripLocked(trip, todayLocal()));
            if (!draftInitRef.current) {
                setDraft(row.description);
                draftInitRef.current = true;
            }
            setMissing(false);
            loadRetryRef.current = 0;
        } catch {
            // 区分瞬时失败（OPFS 单写锁争用/启动竞态）与真错：预算内自动重试，
            // 耗尽才降级「找不到」（trip-day v0.5.2 收口教训，不再一次冲突锁生死路）
            if (loadRetryRef.current < 3) {
                loadRetryRef.current += 1;
                clearTimeout(loadRetryTimerRef.current);
                loadRetryTimerRef.current = setTimeout(
                    () => void reload(),
                    loadRetryRef.current === 1 ? 700 : loadRetryRef.current === 2 ? 1600 : 2600,
                );
                return;
            }
            setMissing(true);
            setLoading(false); // 预算耗尽显式摘 loading（finally 在 retry≠0 时不动它）
        } finally {
            if (loadRetryRef.current === 0) setLoading(false);
        }
    }, [tripId, itemId, storeReady]);

    useEffect(() => {
        void reload();
    }, [reload, revision]);

    // 卸载摘除重试定时器（防卸载后 setState 泄漏）
    useEffect(() => () => {
        if (loadRetryTimerRef.current != null) clearTimeout(loadRetryTimerRef.current);
    }, []);

    /** 最近一次成功落库的正文（幂等闸：失焦已存、卸载兜底不再重复写一遍）。 */
    const savedRef = useRef<string | null>(null);

    /** 落库通道：未变/只读态视为成功；真写走 store 内容单源，失败由调用方呈现。 */
    const flush = useCallback(async (): Promise<boolean> => {
        if (!item || locked) return true;
        const next = draft.trim();
        if (next === item.description || next === savedRef.current) return true;
        const ok = await useArchiveStore.getState().updateTripItemContent(item.id, { description: next });
        if (ok) savedRef.current = next;
        return ok;
    }, [item, locked, draft]);

    // 卸载兜底（「完成」/回跳外的手势返回不保证触发 blur）：latest flush 经 ref
    // 取新，仅卸载一刻执行；savedRef 幂等闸防重复写
    const flushRef = useRef(flush);
    flushRef.current = flush;
    useEffect(() => () => void flushRef.current(), []);

    // 失焦即收笔（卡面笔记位同语义；失败经 store.error 通道上浮，不吞错误）
    const handleBlur = () => {
        void flush();
    };

    /** 「完成」：先落库（键盘未收起时 blur 未必触发）再返回；失败留页可重试。 */
    const finish = async () => {
        if (savingRef.current) return;
        Keyboard.dismiss();
        setSaveFailed(false);
        savingRef.current = true;
        const ok = await flush();
        savingRef.current = false;
        if (ok) router.back();
        else setSaveFailed(true);
    };

    /** 「表单编辑」：落库 → 携最新行快照挂回跳信号 → 返回行程表页（信号在其
     *  focus 时消费；预填吃快照不吃屏间竞态，见 trip-day 信号注）。 */
    const openFormEdit = async () => {
        if (!item || savingRef.current) return;
        Keyboard.dismiss();
        setSaveFailed(false);
        savingRef.current = true;
        const ok = await flush();
        savingRef.current = false;
        if (!ok) {
            setSaveFailed(true);
            return;
        }
        requestTripItemFormEdit({ ...item, description: draft.trim() });
        router.back();
    };

    if (loading) return <LoadingView />;

    if (missing || !item) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base" style={{ paddingTop: insets.top }}>
                <ScreenHeader title="行程项" />
                <View className="flex-1 pt-8">
                    <DeadEndView
                        icon={<LucideStickyNote size={40} color={palette.muted} strokeWidth={1.5} />}
                        title="找不到这个行程项"
                        hint="它可能已被删除，或链接不完整。回到行程表看看别的内容。"
                        actionLabel="返回"
                        onAction={safeBack}
                    />
                </View>
            </View>
        );
    }

    const editable = !locked;
    const displayTitle = tripItemDisplayTitle(item.title);

    const ghostBtn = (label: string, onPress: () => void) => (
        <Pressable
            onPress={() => {
                haptics.selection();
                onPress();
            }}
            disabled={savingRef.current}
            className={`h-12 flex-1 items-center justify-center rounded-control bg-ink-surface active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                savingRef.current ? 'opacity-40' : ''
            }`}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            <Text
                numberOfLines={1}
                className="text-[16px] font-medium text-ink-secondary dark:text-inkd-secondary"
            >
                {label}
            </Text>
        </Pressable>
    );

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头：时刻即屏题（24/600 无副题，轮 B 统一规格走 ScreenHeader） */}
                <ScreenHeader title={item.time} />
                {/* store.error 通道（锁定拒绝/写入失败）统一在此可见 */}
                {storeError ? (
                    <Text className="mb-2 px-6 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {storeError}
                    </Text>
                ) : null}
                <View className="mx-auto w-full max-w-[560px] flex-1 px-6">
                    {/* 信息行：时刻 + 标题只读回显（空标题不渲染，改标题走「表单编辑」） */}
                    <View className="flex-row items-center justify-between rounded-control bg-ink-surface px-4 py-3 dark:bg-inkd-surface">
                        <Text
                            className="text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {item.time}
                        </Text>
                        {displayTitle !== '' ? (
                            <Text
                                numberOfLines={1}
                                className="ml-3 min-w-0 flex-1 text-right text-[15px] text-ink-secondary dark:text-inkd-secondary"
                            >
                                {displayTitle}
                            </Text>
                        ) : null}
                    </View>
                    {/* 纸面大正文区：一张 surface 纸卡铺满剩余屏高，canvas 档输入
                        无盒透传（纸感 = 底色一体），16/26 日记正文档 */}
                    <View className="mt-3 flex-1 rounded-card bg-ink-surface px-5 pb-4 pt-2 dark:bg-inkd-surface">
                        <FieldInput
                            tone="canvas"
                            multiline
                            editable={editable}
                            value={draft}
                            onChangeText={setDraft}
                            onBlur={handleBlur}
                            placeholder={editable ? '写下这一刻…' : ''}
                            style={{ flex: 1, fontSize: 16, lineHeight: 26 }}
                            containerClassName="flex-1"
                            accessibilityLabel="行程项备注（失焦即保存）"
                        />
                    </View>
                </View>
                {/* 底部动作行（钉屏底，v0.5.2 事件向导同款语言）：左 ghost「表单
                    编辑」回行程表开旧表单；右 primary「完成」落库并返回。锁定
                    态无表单入口，「完成」即纯返回 */}
                <View
                    className="w-full items-center px-6"
                    style={{ paddingTop: 12, paddingBottom: insets.bottom + 16 }}
                >
                    <View className="flex-row gap-3" style={{ width: '100%', maxWidth: 560 }}>
                        {editable ? ghostBtn('表单编辑', () => void openFormEdit()) : null}
                        <Pressable
                            onPress={() => {
                                haptics.impact('light');
                                if (editable) void finish();
                                else router.back();
                            }}
                            disabled={savingRef.current}
                            className={`h-12 flex-1 items-center justify-center rounded-control active:opacity-90 ${
                                savingRef.current ? 'opacity-40' : ''
                            }`}
                            style={{ backgroundColor: palette.primaryBtn }}
                            accessibilityRole="button"
                            accessibilityLabel="完成"
                        >
                            <Text
                                numberOfLines={1}
                                className="text-[16px] font-semibold"
                                style={{ color: palette.onPrimaryBtn }}
                            >
                                完成
                            </Text>
                        </Pressable>
                    </View>
                    {saveFailed && storeError ? (
                        <Text className="mt-2 text-center text-[12px] text-ink-negative dark:text-inkd-negative">
                            {storeError}
                        </Text>
                    ) : null}
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}
