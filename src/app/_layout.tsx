import '../global.css';
import { useEffect } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import { Stack, useRouter, useNavigationContainerRef } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as NavigationBar from 'expo-navigation-bar';
import { applyThemePref, getPalette, useEffectiveTheme, useArchiveStore, type ThemePref } from '@/features/archive';
// 上一次界面缓存（R8 深路径直连：域 barrel index.ts 不在本次允许改动清单内）
import {
    consumeLastRoute,
    flushLastRoute,
    isRestorablePath,
    pathFromNavigationState,
    saveLastRoute,
} from '@/features/archive/last-route';
// 启动孤儿媒体 GC（上传中断恢复）：同 last-route 深路径直连先例——barrel 只导出
// useArchiveStore/useArchiveRevision，本次允许改动清单不含 index.ts
import { runStartupOrphanMediaGc } from '@/features/archive/store';
import { archiveConfig } from '@/config/archive';

/**
 * 播种锚点：Expo Go reload / 深链会直达「上次停留的屏」并播种为单屏栈——
 * 该屏上的任何 router.back() 都会 GO_BACK 无屏可退（真机实测报错）。
 * anchor 让播种时前置 [(tabs), 目标屏]，所有直达屏天然有退路；
 * 冷启动默认路由也由 anchor 显式化为 (tabs)，不依赖目录隐式顺序。
 */
export const unstable_settings = { anchor: '(tabs)' };

/**
 * 上一次界面恢复的一次性闸门（模块级而非 ref）：effect 重跑 / Fast Refresh 重挂载
 * 时 ref 会随组件重建，模块变量在本 JS 会话内恒存——恢复只执行一次。双重防护：
 * - 本会话内重复触发（Fast Refresh 重挂载）由该变量拦截；
 * - 跨 dev reload 由 consumeLastRoute 读后清除兜底（缓存已消费，重跑读到 null）。
 * 同时它也是保存闸门：恢复完成前根容器的初始 state 事件（anchor 播种 (tabs)）
 * 不得写入缓存——否则慢启动时上次停留路径会被默认路由 '/' 覆盖掉。
 */
let lastRouteRestoreDone = false;

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
    // 上一次界面恢复用（replace 到缓存路径）
    const router = useRouter();

    useEffect(() => {
        if (!ready) void loadAll();
        applyThemePref(archiveConfig.get()['ui.theme'] as ThemePref);
    }, [ready, loadAll]);

    useEffect(() => {
        // 启动孤儿媒体文件 GC（上传中断恢复）：冷启 sweep 至多一次（单飞闸门在
        // store 模块级，effect 重跑 / Fast Refresh 重挂载无害）。fire-and-forget：
        // sweep 内部全兜底静默降级，不 reject、不 set error、不阻塞 ready——GC 是
        // 存储回收增强，失败只浪费存储不影响功能。
        void runStartupOrphanMediaGc();
    }, []);

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
        // 路径①主题翻转（deps 含 theme，effect 重跑即触发；挂载首帧同样覆盖）：
        // 立即幂等重设窗口底色 + 按钮深浅
        if (Platform.OS === 'android') {
            applyAndroidSceneBackground(theme);
            // 按钮深浅随主题：浅色主题配深色按钮图标（'dark'），深色主题配浅色图标（'light'）。
            // 3-button 模式生效前提：app.json 中 expo-navigation-bar 插件 enforceContrast=false。
            NavigationBar.setStyle(theme === 'dark' ? 'light' : 'dark');
        }
        // 路径②屏切换兜底（真机「底部导航栏边缘没有刷新」）：订阅根容器 state
        // 变化——含嵌套 tab 切换 / push / pop / modal（嵌套导航状态变化会上抛
        // 到容器 state）——每次变化幂等重设一次窗口底色，强制导航栏条带跟手。
        // addListener 是事件订阅不触发 React 重渲（对比 useRootNavigationState
        // 的 state 订阅重渲路径），零重渲风暴；theme 变化时本 effect 重跑重建
        // 监听，闭包 theme 恒为当前值。回调即「state 变化时调用一次」，不在
        // 渲染期触碰原生 API。
        // 路径③上一次界面缓存：订阅原本仅 Android（edge-to-edge 修复挂上），
        // 现提升为全平台——同一 'state' 监听里顺手把根 state 序列化为路径节流
        // 落盘（复用既有订阅，不另挂第二份）；Android 专属调用收进回调内 gate。
        // 仅序列化成功（path 非 null）时写，无效路由不覆盖上次缓存；恢复完成前
        // 不写（见 lastRouteRestoreDone 注——初始播种 state 不得覆盖上次缓存）。
        const unsubscribe = navigationRef.addListener('state', (e) => {
            if (Platform.OS === 'android') applyAndroidSceneBackground(theme);
            if (!lastRouteRestoreDone) return;
            const path = pathFromNavigationState(e.data.state);
            if (path) saveLastRoute(path);
        });
        return () => {
            unsubscribe();
            // 卸载 flush：Fast Refresh / 容器卸载时把节流窗口内未落盘的路径立即写掉
            void flushLastRoute();
        };
    }, [theme, navigationRef]);

    useEffect(() => {
        // 上一次界面恢复（一次性，根导航 ready 后；在主题初始化 effect 与 anchor
        // 播种之后异步执行，不抢跑——replace 在 ready 后覆盖播种的默认路由）。
        // ready 检测用轮询 getCurrentRoute：EventMapCore 没有 ready 事件可订阅
        // （焦点外只有 focus/blur/state/removePrevented），而 useRootNavigationState
        // 会让 RootLayout 随每次导航状态变化重渲——仓库此前已为此特意选了事件
        // 订阅路径，这里沿用零重渲方案。10ms × 200 次 ≈ 2s 上限：超时放弃恢复
        // （只少一次增强，保存闸门照常放行）。
        if (lastRouteRestoreDone) return;
        let cancelled = false;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let polls = 0;
        const tryRestore = async () => {
            try {
                const nav = navigationRef.current;
                const saved = await consumeLastRoute();
                if (cancelled) return;
                // 深链守卫：显式深链 / web 地址栏入口不恢复——URL 本身就是用户意图；
                // Expo Go 冷启 initialURL 恒为 exp://…（非显式深链）正常恢复，原生
                // 图标启动 getInitialURL() 返回 null 同样恢复；exp+<slug>://（dev
                // client 深链）与自定义 scheme 均视为显式入口。
                const initialUrl = await Linking.getInitialURL().catch(() => null);
                if (cancelled) return;
                if (initialUrl && !initialUrl.startsWith('exp://')) return;
                // 路径合法守卫：'/' 开头非空、非 '/viewer' 透明路由、无 '+' 特殊段；
                // 无缓存 / 无效路径 → 不动作（停在默认 '/'）
                if (!saved || !isRestorablePath(saved)) return;
                // 已在目标屏则不动作（web 重载同路径 / 锚点播种即目标）
                const currentPath = pathFromNavigationState(nav?.getRootState());
                if (currentPath === saved) return;
                // replace（非 push）：恢复屏落在栈底，back 直接退出应用而非回落默认页。
                // typedRoutes 的路径联合类型是构建期生成，运行期动态路径无法静态收窄；
                // saved 已过 isRestorablePath 运行时守卫，此处仅做类型放行。
                router.replace(saved as Parameters<typeof router.replace>[0]);
            } catch (e) {
                // 静默降级：恢复是增强不是关键路径，任何失败都不影响正常启动
                console.warn('[last-route] restore failed:', e);
            }
        };
        const tick = () => {
            if (cancelled || lastRouteRestoreDone) return;
            if (navigationRef.current?.getCurrentRoute()) {
                lastRouteRestoreDone = true;
                void tryRestore();
                return;
            }
            if (++polls >= 200) {
                lastRouteRestoreDone = true;
                return;
            }
            pollTimer = setTimeout(tick, 10);
        };
        pollTimer = setTimeout(tick, 0);
        return () => {
            cancelled = true;
            if (pollTimer !== null) clearTimeout(pollTimer);
        };
    }, [navigationRef, router]);

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
