import { Stack, useLocalSearchParams } from 'expo-router';
// 深路径注记：新屏未入域 barrel（避免与并行 agent 的 index.ts 改动冲突，
// TripDayScreen 路由壳同款先例）；barrel 出口扩充时收口。
import { AlarmFullscreenScreen } from '@/features/archive/alarm-fullscreen-screen';
// v0.5.1 令 3：路由级底衬并入纸×墨双主题（原硬编码 #0B0D10 夜板退场——
// 闹钟屏不再刻意脱离主题，转场淡入/overscroll 底色跟随 palette.sceneBg）
import { usePalette } from '@/features/archive/ui/theme';

/**
 * 全屏闹钟路由壳（v0.4.7 用户令 #2/#3；v0.5.1 令 1/2/3 扩展）：
 * `archive://alarm/<id>` 深链（full-screen intent / 常驻通知 tap）+
 * 本地通知 data.path tap（watcher 接驳）+ watcher 软计时 + 页内到点检查
 * 四通道共同入口。路由级压死「可滑掉」面——iOS 侧滑返回禁用、转场淡入
 * （冷启直达不闪下层屏）；Android 返回键由屏内 BackHandler 收口为「停止」
 * （必须手动确认语义）。屏本体见 features/archive/alarm-fullscreen-screen
 * .tsx；id = 行程项 id（闹钟 id 同款）。
 */
export default function AlarmRoute() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const palette = usePalette();
    return (
        <>
            <Stack.Screen
                options={{
                    gestureEnabled: false,
                    animation: 'fade',
                    contentStyle: { backgroundColor: palette.sceneBg },
                }}
            />
            <AlarmFullscreenScreen itemId={id} />
        </>
    );
}
