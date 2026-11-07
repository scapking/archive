import '../global.css';
import { useEffect } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Stack, useNavigationContainerRef } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as NavigationBar from 'expo-navigation-bar';
import { applyThemePref, getPalette, useEffectiveTheme, useArchiveStore, type ThemePref } from '@/features/archive';
import { archiveConfig } from '@/config/archive';

/**
 * 播种锚点：Expo Go reload / 深链会直达「上次停留的屏」并播种为单屏栈——
 * 该屏上的任何 router.back() 都会 GO_BACK 无屏可退（真机实测报错）。
 * anchor 让播种时前置 [(tabs), 目标屏]，所有直达屏天然有退路；
 * 冷启动默认路由也由 anchor 显式化为 (tabs)，不依赖目录隐式顺序。
 */
export const unstable_settings = { anchor: '(tabs)' };

/** Android edge-to-edge：把窗口背景（= 透明导航栏露出的区域）重设为当前主题
    的 sceneBg（与 Stack contentStyle 同源）。幂等可重入：主题变化与路由 state
    变化两条路径都会调用——真机实测，窗口底色只在主题变化时设置的话，路由
    切换/转场后导航栏条带会停留陈旧底色、直到下一次窗口重绘才恢复（「点击
    一些界面底部导航栏边缘没有刷新，刷新之后又正常」），故每次屏切换也幂等
    重设一次强制该条带跟手；重复设同色无原生副作用。expo-system-ui 会把该色
    持久化，下次冷启动 JS 未执行前原生即恢复，消除首帧导航栏底色不确定。 */
function applyAndroidSceneBackground(theme: 'light' | 'dark'): void {
    SystemUI.setBackgroundColorAsync(getPalette(theme).sceneBg).catch((e: unknown) => {
        console.warn('[system-ui] setBackgroundColorAsync failed:', e);
    });
}

export default function RootLayout() {
    // 域数据一次性加载 + 恢复主题偏好（web 初始恒 light，需显式 set 回 'system'）
    const ready = useArchiveStore((s) => s.ready);
    const loadAll = useArchiveStore((s) => s.loadAll);
    const theme = useEffectiveTheme();
    // expo-router 模块级单例 ref（= 挂在 NavigationContainer 上的同一个对象）：
    // 跨挂载稳定，仅用于订阅 state 变化事件（不消费 .current，无渲染依赖）
    const navigationRef = useNavigationContainerRef();

    useEffect(() => {
        if (!ready) void loadAll();
        applyThemePref(archiveConfig.get()['ui.theme'] as ThemePref);
    }, [ready, loadAll]);

    useEffect(() => {
        // web reset 注入（DEV.md #11 + #13 输入框规范）：web-reset.css 只能走静态
        // 资源（元素选择器/裸声明进 metro 会崩 Android bundle，见该文件头注），
        // 但 +html.tsx 的 <link> 仅在 output: 'static' 导出生效——本项目 web.output
        // = 'single'，dev 服务器与 SPA 导出的 HTML 壳都是默认模板，link 从未上线。
        // 这里 web 侧运行时补挂（幂等）：dev 与导出产物双通；native 直接短路。
        if (Platform.OS !== 'web') return;
        if (document.querySelector('link[data-web-reset]')) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/web-reset.css';
        link.setAttribute('data-web-reset', 'true');
        document.head.appendChild(link);
    }, []);

    useEffect(() => {
        // Android：edge-to-edge 下系统栏透明，导航栏区域露出的是窗口（decorView）背景。
        // 窗口背景不随主题时，导航栏观感与页面脱节——冷启动露出 splash 底色（有时白
        // 有时黑取决于系统深浅）、重渲后按钮外观跳变。见 react-native-edge-to-edge
        // README「Transparent navigation bar」：透明导航栏需自管样式，与状态栏同等待遇。
        if (Platform.OS !== 'android') return;
        // 路径①主题翻转（deps 含 theme，effect 重跑即触发；挂载首帧同样覆盖）：
        // 立即幂等重设窗口底色 + 按钮深浅
        applyAndroidSceneBackground(theme);
        // 按钮深浅随主题：浅色主题配深色按钮图标（'dark'），深色主题配浅色图标（'light'）。
        // 3-button 模式生效前提：app.json 中 expo-navigation-bar 插件 enforceContrast=false。
        NavigationBar.setStyle(theme === 'dark' ? 'light' : 'dark');
        // 路径②屏切换兜底（真机「底部导航栏边缘没有刷新」）：订阅根容器 state
        // 变化——含嵌套 tab 切换 / push / pop / modal（嵌套导航状态变化会上抛
        // 到容器 state）——每次变化幂等重设一次窗口底色，强制导航栏条带跟手。
        // addListener 是事件订阅不触发 React 重渲（对比 useRootNavigationState
        // 的 state 订阅重渲路径），零重渲风暴；theme 变化时本 effect 重跑重建
        // 监听，闭包 theme 恒为当前值。回调即「state 变化时调用一次」，不在
        // 渲染期触碰原生 API。
        const unsubscribe = navigationRef.addListener('state', () => {
            applyAndroidSceneBackground(theme);
        });
        return unsubscribe;
    }, [theme, navigationRef]);

    return (
        <>
            {/* 状态栏绑定生效主题（'system' 档由 useEffectiveTheme 已解析为具体档）：
                深色底用浅色内容，浅色底用深色内容 */}
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <Stack
                screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: getPalette(theme).sceneBg },
                }}
            >
                <Stack.Screen name="(tabs)" />
                <Stack.Screen name="trip/[id]" />
                <Stack.Screen name="trip/new" options={{ presentation: 'modal' }} />
                <Stack.Screen name="trip/[id]/edit" options={{ presentation: 'modal' }} />
                <Stack.Screen name="write" options={{ presentation: 'modal' }} />
                <Stack.Screen name="trip/[id]/write/[date]" options={{ presentation: 'modal' }} />
                <Stack.Screen name="journal/[id]" options={{ presentation: 'modal' }} />
                {/* 搜索（DEV.md #5）：card 而非 modal——它是内容型目的地页（日历 + 长结果
                    列表滚动、键盘输入），需要整页高度与系统返回手势；modal 留给编辑/创建类
                    流程（write / journal / trip form），与本 Stack 既有分工一致 */}
                <Stack.Screen name="search" />
                {/* 全屏媒体查看器（transparentModal）：root Stack 级窗口容器，位于 (tabs)
                    之上——tab 屏内任何覆盖层都盖不住 BottomTabView 的 tabBar 条带
                    （screens 容器 overflow:hidden + tabBar 后绘，Android 尤甚），路由化后
                    viewer 是 (tabs) 的兄弟屏，天然整窗覆盖（图片放大「不是全屏」的根治）。
                    contentStyle 显式透明：screenOptions 的 sceneBg 不落本屏——iOS 淡入
                    转场不闪底色，web 透明容器透出下层屏（web 的 transparentModal 退化为
                    普通透明容器 + 常驻下层屏，viewer 内容经 body portal 全窗覆盖，
                    观感即普通全屏路由，无需另行分支）。 */}
                <Stack.Screen
                    name="viewer"
                    options={{
                        presentation: 'transparentModal',
                        headerShown: false,
                        contentStyle: { backgroundColor: 'transparent' },
                    }}
                />
            </Stack>
        </>
    );
}

/**
 * 路由级错误边界（expo-router 约定）：渲染异常不再白屏，
 * 给出可读的降级页 + 重试入口。
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry(): void }) {
    return (
        <View className="flex-1 items-center justify-center bg-ink-base px-10 dark:bg-inkd-base">
            <Text className="text-[17px] font-semibold text-ink-text dark:text-inkd-text">
                出了点问题
            </Text>
            <Text className="mt-2 text-center text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                {error.message || '界面渲染遇到未预期的错误。'}
            </Text>
            <Pressable
                onPress={retry}
                className="mt-6 h-11 items-center justify-center rounded-lg border border-ink-border bg-ink-surface px-6 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised"
            >
                <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">重试</Text>
            </Pressable>
        </View>
    );
}
