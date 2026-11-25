import { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { audio, type AudioPlayer } from '@/core/audio';
import { alarm } from '@/core/alarm';
import * as db from './db';
import { TRIP_ITEM_PHASE_LABEL, tripItemDueAt, tripItemPhase } from './trip-item-logic.ts';

/**
 * 全屏闹钟屏（v0.4.7 用户令 #2 的「实在做不到的档位」呈现本体）：
 *
 * 到点后（Android 精确闹钟被拒 = 非精确档兜底、iOS 无系统闹钟 API、以及
 * 精确档 full-screen intent 拉起）由深链 `archive://alarm/<id>` 或 watcher
 * 软计时进入本屏——**显示闹钟/行程内容 + 循环播放提示音 + 全屏遮罩不可
 * 滑掉，必须手动「确认停止」**。确认出口三处统一走 acknowledge()：按钮、
 * Android 返回键（无 scrim 点按出口——点遮罩不关）；出口动作 = core/alarm
 * confirm（移除常驻通知 + 停保活服务，「确认后移除」语义）+ 跳该行程当天页。
 *
 * 数据独立自取（db 直查，不依赖 store 会话态）：本屏可能被 full-screen
 * intent 冷启动直达，store.loadAll 未必收口——行程项/行程行按 id 现查，
 * 查无（已删/收尾终态）= 自动确认离开，不拦用户。
 */

/** 循环提示音（程序生成的短 wav，见 .github/scripts/generate-alarm-sound.mjs；
 *  循环无缝：包络首尾归零，时长 ~1.9s）。 */
const ALARM_SOUND = require('../../assets/sounds/alarm-chime.wav');

export interface AlarmFullscreenScreenProps {
    /** 行程项 id（闹钟 id 同款约定，见 core/alarm 注）。 */
    itemId: string;
}

/** epoch → 'HH:mm:ss'（已过时长显示）。 */
function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function AlarmFullscreenScreen({ itemId }: AlarmFullscreenScreenProps) {
    const [item, setItem] = useState<db.TripItemRow | null | undefined>(undefined);
    const [tripTitle, setTripTitle] = useState<string>('');
    const [elapsedMs, setElapsedMs] = useState(0);
    /** 确认只走一次（按钮/返回键/查无自动确认互斥）。 */
    const acknowledgedRef = useRef(false);
    const playerRef = useRef<AudioPlayer | null>(null);

    // 数据自取 + 终态检查（已删/已收尾 = 无「该动手」语义，自动确认离开）
    useEffect(() => {
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
                if (!cancelled) setTripTitle(trip?.title?.trim() || '未命名行程');
            } catch {
                if (!cancelled) setItem(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [itemId]);

    // 循环提示音（web 无原生闹钟入口，静音；native 静音键下仍响 = playsInSilentMode）
    useEffect(() => {
        if (Platform.OS === 'web') return;
        let disposed = false;
        let player: AudioPlayer | null = null;
        (async () => {
            try {
                await audio.setAudioModeAsync({
                    playsInSilentMode: true,
                    interruptionMode: 'doNotMix',
                });
                player = audio.createAudioPlayer(ALARM_SOUND);
                player.loop = true;
                player.play();
                playerRef.current = player;
            } catch (error) {
                // 声音失败不拦确认流程（视觉遮罩 + 常驻通知仍在场）
                console.warn('[alarm-fullscreen] 提示音播放失败:', error);
            }
            if (disposed && player) void player.remove();
        })();
        return () => {
            disposed = true;
            const current = playerRef.current ?? player;
            playerRef.current = null;
            if (current) {
                try {
                    void current.remove();
                } catch (error) {
                    console.warn('[alarm-fullscreen] 播放器释放失败:', error);
                }
            }
        };
    }, []);

    // 到点已过时长节拍（内容区「已过期 N 分钟」）
    useEffect(() => {
        if (!item) return;
        const due = tripItemDueAt(item.local_date, item.time);
        setElapsedMs(Date.now() - due);
        const timer = setInterval(() => setElapsedMs(Date.now() - due), 1000);
        return () => clearInterval(timer);
    }, [item]);

    const acknowledge = useCallback(() => {
        if (acknowledgedRef.current) return;
        acknowledgedRef.current = true;
        // 原生清理：移除常驻通知 + 停保活服务（「确认后移除」）；best-effort
        void alarm.confirm(itemId);
        if (item) {
            router.replace({
                pathname: '/trip/[id]/day/[date]',
                params: { id: item.trip_id, date: item.local_date },
            });
        } else {
            // 深链冷启直达本屏时栈里只有闹钟屏——back() 无历史可退会原地不动，
            // 统一 replace 回首页（有历史时 replace 同样安全：不留闹钟屏于栈中）
            router.replace('/');
        }
    }, [itemId, item]);

    // 查无/终态：不打扰——同确认口径清账离开
    useEffect(() => {
        if (item === null) acknowledge();
    }, [item, acknowledge]);

    // Android 返回键 = 确认停止（必须手动确认的「出口」之一，不是绕过）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            acknowledge();
            return true;
        });
        return () => sub.remove();
    }, [acknowledge]);

    const phase = item ? TRIP_ITEM_PHASE_LABEL[tripItemPhase(item, Date.now())] : '';

    return (
        <View style={styles.root}>
            {/* 全屏遮罩：无任何点按关闭路径（Pressable 无 onPress），
                唯一出口 = 确认按钮 / Android 返回（同走 acknowledge） */}
            <View style={styles.content}>
                <Text style={styles.eyebrow}>{tripTitle || '行程提醒'}</Text>
                <Text style={styles.heading}>行程时间到</Text>
                {item ? (
                    <>
                        <Text style={styles.time}>{item.time}</Text>
                        <Text style={styles.title}>{item.title}</Text>
                        {item.description ? (
                            <Text style={styles.description}>{item.description}</Text>
                        ) : null}
                        <Text style={styles.meta}>
                            {`${phase}${elapsedMs > 0 ? ` · 已过 ${formatElapsed(elapsedMs)}` : ''}`}
                        </Text>
                    </>
                ) : item === undefined ? (
                    <Text style={styles.title}>读取行程项…</Text>
                ) : null}
            </View>
            <View style={styles.footer}>
                <Pressable
                    onPress={acknowledge}
                    accessibilityRole="button"
                    accessibilityLabel="确认停止闹钟"
                    style={({ pressed }) => [styles.confirm, pressed && styles.confirmPressed]}
                >
                    <Text style={styles.confirmText}>确认停止</Text>
                </Pressable>
            </View>
        </View>
    );
}

// 闹钟视觉刻意脱离 app 主题（全屏响铃面 = 系统闹钟语言的深色高对比），
// 不引 ui/theme——本屏与 deck/editor 等屏零耦合（v0.4.7 文件边界）。
const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0B0D10', justifyContent: 'space-between' },
    content: { flex: 1, justifyContent: 'center', paddingHorizontal: 28 },
    eyebrow: { color: '#8B939C', fontSize: 13, letterSpacing: 1, marginBottom: 10 },
    heading: { color: '#F7F8FA', fontSize: 17, fontWeight: '600', marginBottom: 18 },
    time: { color: '#60A5FA', fontSize: 64, fontWeight: '700', fontVariant: ['tabular-nums'] },
    title: { color: '#F7F8FA', fontSize: 24, fontWeight: '600', marginTop: 10 },
    description: { color: '#B8C0C8', fontSize: 15, lineHeight: 22, marginTop: 10 },
    meta: { color: '#8B939C', fontSize: 13, marginTop: 14 },
    footer: { paddingHorizontal: 28, paddingBottom: 48 },
    // v0.4.9「退蓝」口径核对：深蓝渐变作为**整面卡底**退役，但 accent 蓝的
    // 控件级小面积用途保留（本屏 = 唯一主行动钮）。confirm 底 = accent 档
    // #2563EB，按压 = ink-accent-press 同档加深 #1D4ED8（白字对比 6.7:1 ≥ AA，
    // 静置底 5.2:1 ≥ AA）——值即 theme.ts LIGHT.accent/accent-press 两档，
    // 非新增散写蓝；全屏遮罩高对比语言不变。
    confirm: {
        backgroundColor: '#2563EB',
        borderRadius: 16,
        paddingVertical: 18,
        alignItems: 'center',
    },
    confirmPressed: { backgroundColor: '#1D4ED8' },
    confirmText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
});
