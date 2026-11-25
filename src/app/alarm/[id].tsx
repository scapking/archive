import { Stack, useLocalSearchParams } from 'expo-router';
// 深路径注记：新屏未入域 barrel（避免与并行 agent 的 index.ts 改动冲突，
// TripDayScreen 路由壳同款先例）；barrel 出口扩充时收口。
import { AlarmFullscreenScreen } from '@/features/archive/alarm-fullscreen-screen';

/**
 * 全屏闹钟路由壳（v0.4.7 用户令 #2/#3）：`archive://alarm/<id>` 深链（full-screen
 * intent / 通知 tap / watcher 软计时）共同入口。路由级压死「可滑掉」面——iOS
 * 侧滑返回禁用、转场淡入（冷启直达不闪下层屏）；Android 返回键由屏内
 * BackHandler 收口为「确认停止」（必须手动确认语义）。屏本体见
 * features/archive/alarm-fullscreen-screen.tsx；id = 行程项 id（闹钟 id 同款）。
 */
export default function AlarmRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return (
        <>
            <Stack.Screen
                options={{
                    gestureEnabled: false,
                    animation: 'fade',
                    contentStyle: { backgroundColor: '#0B0D10' },
                }}
            />
            <AlarmFullscreenScreen itemId={id} />
        </>
    );
}
