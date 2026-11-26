import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Platform, Pressable, StyleSheet, Text, View, type AppStateStatus } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { audio, type AudioPlayer } from '@/core/audio';
import { alarm } from '@/core/alarm';
import * as db from './db';
import { confirmAlarmSession, isAlarmConfirmed, isAlarmSettled } from './alarm-ladder';
import { PAPER_FLOAT_SHADOW } from './ui/paper-shadow';
import { usePalette } from './ui/theme';
import { TRIP_ITEM_PHASE_LABEL, tripItemDisplayTitle, tripItemDueAt, tripItemPhase } from './trip-item-logic';
import { formatDateParts } from './trip-logic';

/**
 * 全屏闹钟屏（v0.5.1 令 3「闹钟 UI 丑」重做 + 令 1「弹窗统一到此形态」+
 * 真机纠错「关闭后依然有声音 / 后台进来不响」）：
 *
 * 呈现通道（三端统一阶梯的「前台呈现」档，见 alarm-ladder.decideAlarmLadder）：
 * Android full-screen intent / 常驻通知 tap（URL 深链）、iOS timeSensitive
 * 通知 tap（data.path → watcher 接驳）、watcher 到点软计时、页内到点检查
 * （trip-day 令 1 改造）全部落本路由 /alarm/<id>。
 *
 * 视觉 = 「纸 × 墨 2.1」的双主题极端：闹钟是纸堆里抽出的一张「今日行程卡」
 * 放大到全屏——主题近黑/纸白（palette.sceneBg），卡用 PAPER_FLOAT 悬浮档
 * （真悬浮物才有影），信息层级严格按令：**报时时刻是主角**（84px tabular
 * 大字号）、标题次之（24px；空标题不渲染任何文字，禁兜底词）、行程名与已过
 * 时长并入卡内 meta 行。单主钮「停止」（primary-btn 近黑/反白），Android
 * 返回键同出口；无遮罩点按出口。web 路由态可直接呈现（静音——web 无系统
 * 闹钟入口）。
 * 版面收紧（v0.5.1 实拍验收「稀疏即罪」）：正文整体在安全区内垂直居中，
 * 停止钮恒钉底部（拇指热区，闹钟体感）；兜底态文字+钮同流居中不钉底，
 * 杜绝钮上大片死白。
 *
 * 生命周期（v0.5.1 纠错核心）：
 * - 出口唯一 acknowledge()：先 confirmAlarmSession 出账（跨平台单源，含 web
 *   ——确认=出账闭环不依赖原生门面），再**同步**静音（pause+remove，不等
 *   卸载清理跟随导航），再 alarm.confirm 清原生账（注册表 + fired + 常驻
 *   通知 + 保活服务），最后 replace 导航——「停止即静音」；
 * - 外部停铃收账：通知动作「停止」只清原生面，JS 无新事件面（Kotlin 保守
 *   纪律），循环播放器在场期间低频回读注册表，条目出账 = 已被停 → 本屏静默
 *   收口离场（isAlarmSettled 纯函数，tests 有契约用例）；
 * - 回前台重响：app 在后台被 watcher 拉起本屏时，Android 音频焦点可能被拒
 *   → 无声洞；AppState 回 active 时补 play()（用户令 1「响应声音」）；
 * - 查无/终态不再「自动确认离开」：改为设计过的「已结束」兜底态（web 路由
 *   /alarm/<id> 可拍；native 语义不变——出口仍走 acknowledge 清账）。
 */

/** 循环提示音（程序生成的短 wav，见 .github/scripts/generate-alarm-sound.mjs；
 *  循环无缝：包络首尾归零，时长 ~1.9s）。 */
const ALARM_SOUND = require('../../assets/sounds/alarm-chime.wav');

/** 外部停铃收账轮询节拍（ms）：仅循环播放器在场期间运行，3s 对「关掉即静」
 *  的体感足够，注册表回读是 SharedPreferences 面，成本可忽略。 */
const SETTLED_POLL_MS = 3_000;

export interface AlarmFullscreenScreenProps {
    /** 行程项 id（闹钟 id 同款约定，见 core/alarm 注）。 */
    itemId: string;
}

/** epoch → 'HH:mm:ss'/'m:ss'（已过时长显示）。 */
function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function AlarmFullscreenScreen({ itemId }: AlarmFullscreenScreenProps) {
    const palette = usePalette();
    const insets = useSafeAreaInsets();
    const [item, setItem] = useState<db.TripItemRow | null | undefined>(undefined);
    const [tripTitle, setTripTitle] = useState<string>('');
    const [elapsedMs, setElapsedMs] = useState(0);
    /** 确认只走一次（按钮/返回键/外部停铃收账互斥）。 */
    const acknowledgedRef = useRef(false);
    const playerRef = useRef<AudioPlayer | null>(null);

    /** 静音唯一收口：ref 先摘走再操作，重复调用幂等。 */
    const stopPlayer = useCallback((): void => {
        const player = playerRef.current;
        playerRef.current = null;
        if (!player) return;
        try {
            // pause 先于 remove：loop 中的播放器直接 remove 在部分 ROM 上异步
            // 释放，留下毫秒级残响；两步同 tick 走完，「停止即静音」
            player.pause();
            player.remove();
        } catch (error) {
            console.warn('[alarm-fullscreen] 播放器释放失败:', error);
        }
    }, []);

    const acknowledge = useCallback((): void => {
        if (acknowledgedRef.current) return;
        acknowledgedRef.current = true;
        // 确认 = 出账（跨平台单源，v0.5.1 返工）：id 级账无条件先写——web 无
        // 原生注册表、alarm.confirm 门面 no-op，JS 账本必须自己闭环，否则页内
        // 检查下一拍再把同一 ongoing 项跳回来（CDP wheel4/5/6 实锤劫持环；
        // 旧实现用 Date.now() 即时指纹兜底会覆盖页内检查先记的 dueAt 槽位，
        // 慢存储下 resolve 前点停止即触发）。
        confirmAlarmSession(itemId);
        // 导航前同步静音（见头注生命周期第一条）——卸载清理只是兜底，不是出口
        stopPlayer();
        // 原生清账：注册表条目 + fired 账 + 常驻通知 + 保活服务一并移除
        void alarm.confirm(itemId);
        if (item) {
            router.replace({
                pathname: '/trip/[id]/day/[date]',
                params: { id: item.trip_id, date: item.local_date },
            });
        } else {
            // 深链冷启直达本屏时栈里可能只有闹钟屏——replace 回首页最稳
            // （有历史时同样安全：不留闹钟屏于栈中）
            router.replace('/');
        }
    }, [itemId, item, stopPlayer]);

    // 数据自取 + 终态判定（查无/已收尾 = 兜底态；清账责任仍在出口按钮）。
    // 已确认 id 的陈旧重入（URL 深链不经 JS 账本闸的最后一条腿）直接按「已
    // 结束」呈现，不查库不再起声——确认 = 出账的屏侧收口。
    useEffect(() => {
        if (isAlarmConfirmed(itemId)) {
            setItem(null);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const row = await db.getTripItem(itemId);
                if (cancelled) return;
                if (!row || tripItemPhase(row, Date.now()) === 'terminal') {
                    setItem(null);
                    return;
                }
                setItem(row);
                const trip = await db.getTrip(row.trip_id);
                if (!cancelled) setTripTitle(trip?.title?.trim() || '');
            } catch {
                if (!cancelled) setItem(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [itemId]);

    // 循环提示音（web 无原生闹钟入口，静音；native 静音键下仍响 = playsInSilentMode）。
    // 已确认 id 的重入不起声：兜底态只留视觉出口。
    useEffect(() => {
        if (Platform.OS === 'web' || isAlarmConfirmed(itemId)) return;
        let disposed = false;
        (async () => {
            try {
                await audio.setAudioModeAsync({
                    playsInSilentMode: true,
                    interruptionMode: 'doNotMix',
                });
                const player = audio.createAudioPlayer(ALARM_SOUND);
                player.loop = true;
                player.play();
                if (disposed || acknowledgedRef.current) {
                    // 创建完成前已卸载/已停止：当场回收，不留孤儿 loop
                    playerRef.current = player;
                    stopPlayer();
                    return;
                }
                playerRef.current = player;
            } catch (error) {
                // 声音失败不拦停止流程（视觉在场 + 常驻通知仍在）
                console.warn('[alarm-fullscreen] 提示音播放失败:', error);
            }
        })();
        return () => {
            disposed = true;
            stopPlayer();
        };
    }, [stopPlayer, itemId]);

    // 回前台补响（v0.5.1 令 1：后台被拉进本屏时 Android 音频焦点可能被拒 →
    // 无声洞；用户真正进 app 的一刻必须响）
    useEffect(() => {
        const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
            if (state !== 'active') return;
            const player = playerRef.current;
            if (!player || acknowledgedRef.current) return;
            if (!player.playing) {
                try {
                    player.play();
                } catch (error) {
                    console.warn('[alarm-fullscreen] 回前台补播失败:', error);
                }
            }
        });
        return () => sub.remove();
    }, []);

    // 外部停铃收账轮询（Android-only：非 Android 平台注册表恒空，判据失真；
    // 仅在循环播放器在场时轮询——声音的唯一 JS 源就是它，它不在就无可静）
    useEffect(() => {
        if (Platform.OS !== 'android') return;
        const timer = setInterval(() => {
            if (acknowledgedRef.current || playerRef.current == null) return;
            void (async () => {
                try {
                    const scheduled = await alarm.listScheduled();
                    if (isAlarmSettled(itemId, scheduled)) acknowledge();
                } catch {
                    // 回读失败：铃声照旧，下一拍再判（宁响勿误静）
                }
            })();
        }, SETTLED_POLL_MS);
        return () => clearInterval(timer);
    }, [itemId, acknowledge]);

    // 到点已过时长节拍（meta 行「已过 3:12」）
    useEffect(() => {
        if (!item) return;
        const due = tripItemDueAt(item.local_date, item.time);
        setElapsedMs(Date.now() - due);
        const timer = setInterval(() => setElapsedMs(Date.now() - due), 1000);
        return () => clearInterval(timer);
    }, [item]);

    // Android 返回键 = 停止（与主钮同一出口；「必须手动确认」语义不变）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            acknowledge();
            return true;
        });
        return () => sub.remove();
    }, [acknowledge]);

    const loading = item === undefined;
    const settled = item === null;
    const phase = item ? TRIP_ITEM_PHASE_LABEL[tripItemPhase(item, Date.now())] : '';
    const itemTitle = item ? tripItemDisplayTitle(item.title) : '';

    return (
        <View
            style={[
                styles.root,
                {
                    backgroundColor: palette.sceneBg,
                    paddingTop: insets.top + 32,
                    paddingBottom: insets.bottom + 24,
                    paddingHorizontal: 24,
                },
            ]}
        >
            {settled ? (
                // ─── 兜底态（v0.5.1「数据不存在也要设计」+ 实拍验收收拢）：
                // 文字与出口钮同流垂直居中，钮不钉底——钮上方不再留大片死白 ───
                <View style={styles.centerBlock}>
                    <Text style={[styles.eyebrow, { color: palette.muted }]}>行程闹钟</Text>
                    <Text style={[styles.endedHeading, { color: palette.text }]}>
                        这条提醒已经结束
                    </Text>
                    <Text style={[styles.endedBody, { color: palette.secondary }]}>
                        对应的行程项已被删除或完成了收尾，不需要再处理。回行程看一眼就好。
                    </Text>
                    <Pressable
                        onPress={acknowledge}
                        accessibilityRole="button"
                        accessibilityLabel="知道了，返回应用"
                        style={({ pressed }) => [
                            styles.stopButton,
                            styles.settledButtonGap,
                            { backgroundColor: pressed ? palette.primaryBtnPress : palette.primaryBtn },
                        ]}
                    >
                        <Text style={[styles.stopButtonText, { color: palette.onPrimaryBtn }]}>知道了</Text>
                    </Pressable>
                </View>
            ) : (
                <>
                    {/* 正文单块垂直居中（v0.5.1 实拍验收「中部死白过大」修正：
                        旧结构把时刻/标题/卡/计时作为并列 flex 子项被 space-between
                        拉开——层级必须打包成一个整体再居中） */}
                    <View style={styles.centerBlock}>
                        {/* 主角：报时时刻。84px tabular，近黑/纸白全墨大字——
                            「时间到」的判断只看这一行（v0.5.1 令 3 信息层级） */}
                        <Text
                            style={[styles.time, { color: palette.text, opacity: loading ? 0.35 : 1 }]}
                            accessibilityRole="text"
                            accessibilityLabel={loading ? '正在读取行程项' : `行程项时刻 ${item?.time ?? ''}`}
                        >
                            {loading ? '––:––' : (item?.time ?? '––:––')}
                        </Text>
                        {loading ? (
                            <Text style={[styles.loadingNote, { color: palette.muted }]}>
                                正在读取行程项…
                            </Text>
                        ) : (
                            <>
                                {/* 次主角：行程项标题。空标题**不渲染任何文字**
                                    ——禁兜底词（v0.5.1 令 1 卡面纪律同源） */}
                                {itemTitle ? (
                                    <Text style={[styles.itemTitle, { color: palette.text }]}>
                                        {itemTitle}
                                    </Text>
                                ) : null}
                                {/* PAPER_FLOAT 悬浮卡：内容（描述/日期事实）+
                                    meta（行程名 · 阶段 · 已过）整体收进一张卡 */}
                                <View style={[styles.card, { backgroundColor: palette.surface }, PAPER_FLOAT_SHADOW]}>
                                    {item?.description ? (
                                        <Text style={[styles.description, { color: palette.secondary }]}>
                                            {item.description}
                                        </Text>
                                    ) : (
                                        // 无备注时不编兜底文案，给事实：日期 + 星期
                                        <Text style={[styles.description, { color: palette.secondary }]}>
                                            {item
                                                ? `${formatDateParts(item.local_date).monthDay} · ${formatDateParts(item.local_date).weekday}`
                                                : ''}
                                        </Text>
                                    )}
                                    <View style={styles.cardMetaRow}>
                                        <Text style={[styles.cardMeta, { color: palette.muted }]} numberOfLines={1}>
                                            {tripTitle ? `行程 · ${tripTitle}` : '行程'}
                                        </Text>
                                        {/* 已过时长并进 meta（秒动 tabular，节奏
                                            来自数字不来自留白） */}
                                        <Text
                                            style={[styles.cardMeta, { color: palette.muted, fontVariant: ['tabular-nums'] }]}
                                            numberOfLines={1}
                                        >
                                            {elapsedMs > 0 ? `${phase} · 已过 ${formatElapsed(elapsedMs)}` : phase}
                                        </Text>
                                    </View>
                                </View>
                            </>
                        )}
                    </View>
                    {/* 主钮钉底（拇指热区；闹钟必须一眼找到停止） */}
                    <View style={styles.footer}>
                        <Pressable
                            onPress={acknowledge}
                            accessibilityRole="button"
                            accessibilityLabel="停止闹钟并返回该行程当天"
                            style={({ pressed }) => [
                                styles.stopButton,
                                { backgroundColor: pressed ? palette.primaryBtnPress : palette.primaryBtn },
                            ]}
                        >
                            <Text style={[styles.stopButtonText, { color: palette.onPrimaryBtn }]}>停止</Text>
                        </Pressable>
                    </View>
                </>
            )}
        </View>
    );
}

/**
 * 版式常量刻意留本屏（结构骨架；颜色一律来自 palette，无散写 hex——
 * 「闹钟视觉脱离主题」的 v0.4.7 口径作废，v0.5.1 令 3 起闹钟并入纸×墨）。
 */
const styles = StyleSheet.create({
    root: { flex: 1 },
    // 正文/兜底内容整体垂直居中（space-between 并列拉开的结构已废——
    // 实拍验收「中部死白过大」的根因就是各层级成了独立 flex 子项）
    centerBlock: { flex: 1, justifyContent: 'center' },
    eyebrow: { fontSize: 13, marginBottom: 14 },
    endedHeading: { fontSize: 34, fontWeight: '700', letterSpacing: -0.5, lineHeight: 40 },
    endedBody: { fontSize: 16, lineHeight: 24, marginTop: 12, maxWidth: 320 },
    // 主角大字：84/700/-0.03em tabular——「两三个尺寸做大做小」的大端
    time: { fontSize: 84, fontWeight: '700', letterSpacing: -2.5, lineHeight: 92 },
    loadingNote: { fontSize: 14, marginTop: 10 },
    itemTitle: { fontSize: 24, fontWeight: '600', letterSpacing: -0.3, lineHeight: 32, marginTop: 10 },
    card: { borderRadius: 16, padding: 20, marginTop: 24 },
    description: { fontSize: 16, lineHeight: 24 },
    cardMetaRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginTop: 16,
        gap: 12,
    },
    cardMeta: { fontSize: 13, flexShrink: 1 },
    footer: { marginTop: 24 },
    // 单主钮：近黑（light）/反白近纸（dark），56 高、rounded 16 同契约档
    stopButton: {
        borderRadius: 16,
        height: 56,
        alignItems: 'center',
        justifyContent: 'center',
    },
    // 兜底态钮随文同流（不钉底），与正文留一次呼吸即可，不留整屏空
    settledButtonGap: { marginTop: 40 },
    stopButtonText: { fontSize: 17, fontWeight: '600' },
});
