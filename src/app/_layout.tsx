import '../global.css';
import { useEffect, useRef } from 'react';
import { AppState, Linking, Platform, Pressable, Text, View } from 'react-native';
import { Stack, useRouter, useNavigationContainerRef } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { applyThemePref, getPalette, useEffectiveTheme, useArchiveStore, type ThemePref } from '@/features/archive';
// Android E2E 冷启自愈（同 last-route/store 深路径直连先例——域 barrel index.ts
// 不在本次允许改动清单内）：reapply 等价调 Me 切换链的 native 生效点但不切主题
// （dev build 正解，Expo Go 下 no-op）；useAndroidE2eSelfRepair 是 Expo Go 冷启
// 非 E2E 的主题双翻自动修复（检测口径、时序与 guardrail 全集见 theme.ts 尾段），
// useBootReady 是它驱动的启动门控（bootReady=false 期间本布局以过渡页替代 app
// 内容，收口口径与时序见 theme.ts boot gate 段）。
import { reapplyAndroidEdgeToEdge, useAndroidE2eSelfRepair, useBootReady } from '@/features/archive/ui/theme';
// 启动过渡页（深路径直连同上）：仅 Android 且 bootReady=false 期间渲染，
// 全屏 sceneBg 底 + 品牌 Logo，盖住双翻的两次 Activity 重建（boot-screen.tsx 头注）。
import { BootScreen } from '@/features/archive/ui/boot-screen';
// Web Desktop 全局壳（侧边栏常驻，2026-11-11）：宽屏下侧栏提为根布局层
// chrome，Stack 落在侧栏右侧 flex-1 内——stack push 不再整窗覆盖侧栏。
// 深路径直连先例（域 barrel index.ts 不在本次允许改动清单内）：壳仅在 web
// 宽屏改变视觉树（native/窄屏 children 直出），收起偏好持久化见
// desktop-shell 头注；RecordingSessionHost / 降级条仍在壳之外（Stack 兄弟，
// 全窗覆盖语义不变）。
import { DesktopShell } from '@/features/archive/ui/desktop-shell';
// 上一次界面缓存（R8 深路径直连：域 barrel index.ts 不在本次允许改动清单内）
import {
    consumeLastRoute,
    flushLastRoute,
    initLastRouteSaveGate,
    isRestorablePath,
    markLastRouteBootCompleted,
    pathFromNavigationState,
    saveLastRoute,
} from '@/features/archive/last-route';
// 启动孤儿媒体 GC（上传中断恢复）：同 last-route 深路径直连先例——barrel 只导出
// useArchiveStore/useArchiveRevision，本次允许改动清单不含 index.ts
import { runStartupOrphanMediaGc } from '@/features/archive/store';
import { useAlarmReminderWatcher } from '@/features/archive/alarm-watcher';
// 全局录制会话宿主（跨页面后台录制 + 归属铁律）：同 last-route/store 深路径直连
// 先例——域 barrel index.ts 不在本次允许改动清单内。
import { RecordingSessionHost, useRecordingSessionStore } from '@/features/archive/recording-session';
// App 锁门禁（M3）：锁定覆盖层挂根层级（不卸载 Stack，解锁回原屏），三档配置
// security.appLockMode（设置页安全卡切换，旧布尔字段兼容读取）。同上方深路径直连先例。
import { AppLockGate } from '@/features/archive/app-lock';
// web 端数据库降级提示条（持久库打不开 → 会话内存库兜底时常驻提示，native 恒
// 渲染 null）：状态与决策收口在 core/database（web-fallback），此处仅挂载注入色板。
import { WebStorageDegradationBanner } from '@/core/database';
import { archiveConfig } from '@/config/archive';
import { preventScreenCaptureAsync } from '@/core/screen-capture';

/**
 * 播种锚点：Expo Go reload / 深链会直达「上次停留的屏」并播种为单屏栈——
 * 该屏上的任何 router.back() 都会 GO_BACK 无屏可退（真机实测报错）。
 * anchor 让播种时前置 [(tabs), 目标屏]，所有直达屏天然有退路；
 * 冷启动默认路由也由 anchor 显式化为 (tabs)，不依赖目录隐式顺序。
 */
export const unstable_settings = { anchor: '(tabs)' };

/**
 * 上一次界面恢复的一次性闸门（模块级而非 ref）：effect 重跑 / Fast Refresh 重挂载
 * 时 ref 会随组件重建，模块变量在本 JS 会话内恒存——恢复轮询只执行一次。双重防护：
 * - 本会话内重复触发（Fast Refresh 重挂载）由该变量拦截；
 * - 跨 dev reload 由 consumeLastRoute 读后清除兜底（缓存已消费，重跑读到 null）。
 * **它不再是保存闸门**：Android 主题双翻（E2E 自愈）触发 Activity 重建产生新
 * JS 上下文时，本变量随模块状态全部重置（theme.ts:215-219 实测口径），靠它挡
 * 「播种路径覆盖真实缓存」跨上下文必失效。保存门在 last-route.ts 内部实现
 * （BOOT_COMPLETED_KEY 持久标志 + saveGateOpen，跨上下文存活）：新上下文异步
 * 读标志装填，恢复周期各收口分支 markLastRouteBootCompleted 前一律不落盘；
 * 本变量现仅承担两层职责——①恢复轮询一次性；②恢复收口前把播种态事件挡在
 * 序列化之前（监听器早退，省一次无意义序列化）。
 */
let lastRouteRestoreDone = false;

/** Android edge-to-edge：把窗口背景（= 透明导航栏露出的区域）重设为当前主题
    的 sceneBg（与 Stack contentStyle 同源）。幂等可重入，以下路径都会调用——
    ①主题翻转、②路由 state 变化、④回前台（AppState active）、⑤录制覆盖层
    收场。真机实测，窗口底色只在主题变化时设置的话，路由切换/转场后导航栏
    条带会停留陈旧底色、直到下一次窗口重绘才恢复（「点击一些界面底部导航栏
    边缘没有刷新，刷新之后又正常」），故每次屏切换也幂等重设一次强制该条带
    跟手；重复设同色无原生副作用，各触发点均为低频一次性调用（无风暴面）。

    注意：**不再调用 NavigationBar.setStyle**（2026-11-09 撤销）。原生源码核实
    （expo-navigation-bar NavigationBarModule.kt）——Q+ 上 setStyle 的
    isContrastEnforced 读的是平台 attr android.R.attr.enforceNavigationBarContrast，
    而 config plugin 只写库自有 attr（enforceNavigationBarContrast，无 android:
    前缀）与 expoEnforceNavigationBarContrast，平台 attr 无人写入 → 解析失败
    恒为默认 true → 每次调用把 react-native-edge-to-edge 插件刚关掉的
    isNavigationBarContrastEnforced 重新打开（系统对比度 scrim 重现）——正是
    「插件生效后又被重置」的那只手。edge-to-edge 模型下导航栏透明 + 窗口背景
    （本函数）即为全部所需；按钮图标深浅由 react-native-edge-to-edge 的
    applyEdgeToEdge 在每次 onHostResume / Activity 重建时按 uiMode 自管
    （EdgeToEdgeModuleImpl.kt），主题切换本就伴随 AppCompatDelegate 触发的
    Activity 重建，无需 app 侧重复设置。 */
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
    // Android E2E 自愈探测用 bottom inset（ref 镜像：effect 闭包恒读当前值，
    // 与下方 themeRef 同法；600ms 探测点在首帧布局 + SafeAreaProvider 测量完成后）。
    const insets = useSafeAreaInsets();
    const insetsBottomRef = useRef(insets.bottom);
    insetsBottomRef.current = insets.bottom;
    // expo-router 模块级单例 ref（= 挂在 NavigationContainer 上的同一个对象）：
    // 跨挂载稳定，仅用于订阅 state 变化事件（不消费 .current，无渲染依赖）
    const navigationRef = useNavigationContainerRef();
    // 上一次界面恢复用（replace 到缓存路径）
    const router = useRouter();
    // Expo Go 冷启非 E2E 的自动修复挂载点（Android-only，web/iOS 短路）：内部
    // 自取 insets/生效主题，挂载 ~700ms 单次判定 bottom===0 → 主题双翻两次
    // Activity 重建。与下方 600ms 探测 effect 无耦合（一个 Expo Go no-op 只服务
    // dev build，一个只服务 Expo Go），机理与时序见 theme.ts 尾段实现注。
    useAndroidE2eSelfRepair();
    // v0.4.7 闹钟阶梯接线：到点账本回收（drainFired）+ 前台软计时拉起全屏
    // 闹钟屏 + Android 常驻通知在场维护；hook 内部自管订阅与清理，无条件挂载。
    useAlarmReminderWatcher();
    // 启动门控（Android：自愈链收口前 false；web/iOS 恒 true）——false 期间本
    // 布局渲染 BootScreen 替代 Stack，双翻两次重建全程盖在过渡页下。注意 hook
    // 须无条件调用（conditional render 在全部 hooks 之后，见 return 前的门控分支）。
    const bootReady = useBootReady();

    useEffect(() => {
        if (!ready) void loadAll();
        applyThemePref(archiveConfig.get()['ui.theme'] as ThemePref);
    }, [ready, loadAll]);

    useEffect(() => {
        // 防截屏冷启生效（security.preventCapture）：设置页切档已即时生效，这里只把
        // 持久化档位应用到本次会话——Android FLAG_SECURE 是窗口属性，进程重启必须重设。
        // 只读一次不订阅：切档即时生效由设置页负责，双订阅会竞态
        if (!archiveConfig.get()['security.preventCapture']) return;
        preventScreenCaptureAsync().catch((caught: unknown) => {
            // 失败只留痕不阻断启动（防截屏是增强层，不能挡住 app 可用）
            console.warn('[screen-capture] 冷启应用防截屏档失败（本次会话不防截屏）：', caught);
        });
    }, []);

    useEffect(() => {
        // Android edge-to-edge 冷启自愈（2026-11-09 二轮审计修订生效域注释，
        // 完整机理证见 theme.ts 头注；定时器逻辑不变）：补调
        // RNEdgeToEdge.onColorSchemeChange()（原生 = 插件 applyEdgeToEdge，
        // setDecorFitsSystemWindows(false) 等，幂等可重入、无闪屏、不切主题）。
        // 【dev build】react-native-edge-to-edge 原生模块存在，此为冷启自愈
        // 正解；两道保险：①挂载后一拍无条件补调（错过插件 onHostResume 派发
        // 即补）；②600ms insets 稳定点条件补调：E2E 下手势条/三键导航的
        // bottom inset 必 >0，decorFits=true（非 E2E）时 insets 被窗口消费恒
        // =0 → bottom===0 判定①未生效；误判后果只是多一次幂等调用，无害。
        // 【Expo Go】RNEdgeToEdge 原生模块未捆绑（expo 58 bundledNativeModules
        // .json 无此包），两次调用均为静默 no-op；Expo Go 的窗口状态通道是
        // app.json → manifest extra['expo-navigation-bar']（enforceContrast
        // :false，勿删）→ 原生 ExperienceActivity.onWindowFocusChanged 每次
        // 焦点写 isNavigationBarContrastEnforced=false（theme.ts 头注③）。
        // 两次调用均为冷启一次性定时器（无监听订阅、无循环重入，Fast Refresh
        // 重挂载重复执行也因幂等无害）；与用户 600ms 窗口内手动切主题无竞态：
        // onColorSchemeChange 与主题无耦合（导航栏按钮深浅由原生按当前 uiMode
        // 自取），用户切主题伴随的重建链路本就会重跑 applyEdgeToEdge，幂等叠加。
        // 【Expo Go 的冷启修复不在此 effect】两次调用在该宿主均为 no-op，真正的
        // 修复走 useAndroidE2eSelfRepair 的主题双翻（上方挂载点），本 effect 仅
        // 服务 dev build；两机制判定窗口错开（600/700ms）互不干扰。
        if (Platform.OS !== 'android') return;
        const immediate = setTimeout(() => reapplyAndroidEdgeToEdge(), 0);
        const probe = setTimeout(() => {
            if (insetsBottomRef.current === 0) reapplyAndroidEdgeToEdge();
        }, 600);
        return () => {
            clearTimeout(immediate);
            clearTimeout(probe);
        };
    }, []);

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
        // 立即幂等重设窗口底色（按钮图标深浅由 edge-to-edge 插件自管，见
        // applyAndroidSceneBackground 头注，app 侧不再调 NavigationBar.setStyle）
        if (Platform.OS === 'android') {
            applyAndroidSceneBackground(theme);
        }
        // 路径④回前台保险层（2026-11-08 E2E 底色偶发消失修复）：部分系统路径
        // 会把窗口背景重置回主题默认（典型：拉起外部 Activity（相册 picker/
        // 分享面板）返回时的 activity 前景重建、系统栏 flag 重排）——该路径
        // 既无导航 state 事件（路径②收不到）也无主题变化（路径①收不到），
        // 底色丢失后一直残留到下次切主题。回前台幂等重设一次即可覆盖这一类；
        // 重复设同色无原生副作用，回前台是低频一次性调用（无风暴面）。
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
        // 仅序列化成功（path 非 null）时写，无效路由不覆盖上次缓存。不写的门控
        // 有两层：本变量（恢复轮询收口前的播种态事件直接早退，不进序列化）+
        // last-route 持久保存门（saveLastRoute 内部，恢复周期收口前丢弃——跨
        // 上下文鲁棒，见 lastRouteRestoreDone 与 BOOT_COMPLETED_KEY 注）。
        const appStateSub =
            Platform.OS === 'android'
                ? AppState.addEventListener('change', (state) => {
                      if (state === 'active') {
                          applyAndroidSceneBackground(theme);
                      }
                  })
                : null;
        const unsubscribe = navigationRef.addListener('state', (e) => {
            if (Platform.OS === 'android') applyAndroidSceneBackground(theme);
            if (!lastRouteRestoreDone) return;
            const path = pathFromNavigationState(e.data.state);
            if (path) saveLastRoute(path);
        });
        return () => {
            appStateSub?.remove();
            unsubscribe();
            // 卸载 flush：Fast Refresh / 容器卸载时把节流窗口内未落盘的路径立即写掉
            void flushLastRoute();
        };
    }, [theme, navigationRef]);

    // 路径⑤会话覆盖层收场补设（2026-11-08 E2E 保险层，Android）：全局录制
    // 覆盖层（全屏取景卡/隐形保活槽/CameraView 原生视图栈）整层挂载/卸载是
    // 导航 state 之外的原生视图重排点——收场（stopping→persisting / 会话
    // 终结 kind→null）时幂等补设一次窗口底色，覆盖「覆盖层收掉后底色残留」
    // 的观察面。订阅经 zustand（零渲染），低频一次性调用无风暴；theme 走
    // ref 镜像（订阅只挂一次，闭包不随主题 effect 重建）。
    const themeRef = useRef(theme);
    themeRef.current = theme;
    useEffect(() => {
        if (Platform.OS !== 'android') return;
        return useRecordingSessionStore.subscribe((state, prev) => {
            const wasCaptureUiAlive = prev.kind != null && prev.phase !== 'persisting';
            const isCaptureUiGone = state.kind == null || state.phase === 'persisting';
            if (wasCaptureUiAlive && isCaptureUiGone) {
                applyAndroidSceneBackground(themeRef.current);
            }
        });
    }, []);

    useEffect(() => {
        // 保存门装填（每上下文一次，模块级幂等；置于早退分支之前——异步读标志
        // 须随上下文挂载立即启动，读完成前的 state 事件由保存门丢弃，见
        // initLastRouteSaveGate / BOOT_COMPLETED_KEY 注）。
        initLastRouteSaveGate();
        // 上一次界面恢复（一次性，根导航 ready 后；在主题初始化 effect 与 anchor
        // 播种之后异步执行，不抢跑——replace 在 ready 后覆盖播种的默认路由）。
        // ready 检测用轮询 getCurrentRoute：EventMapCore 没有 ready 事件可订阅
        // （焦点外只有 focus/blur/state/removePrevented），而 useRootNavigationState
        // 会让 RootLayout 随每次导航状态变化重渲——仓库此前已为此特意选了事件
        // 订阅路径，这里沿用零重渲方案。20ms × 400 次 ≈ 8s 上限（覆盖自愈双翻的重建窗口，慢设备不误超时）：超时放弃恢复
        // （只少一次增强，保存闸门照常放行）。
        //
        // boot 门控顺延（Android）：恢复必须等 bootReady=true（自愈链收口）后
        // 再走——①双翻的两次重建会整树重挂，boot 期间 Stack 未挂载，replace 的
        // 目标屏在重建中必丢；②boot 期间 navigationRef.current 为 null，轮询只
        // 会空转把 2s 预算烧完、恢复静默失效。bootReady 收口与 Stack 首挂同
        // commit，此处启动轮询时路由已可读（10ms 首拍即中）。web/iOS 恒 ready，
        // 时序与历史行为一致。
        if (lastRouteRestoreDone) return;
        if (!bootReady) return;
        let cancelled = false;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let polls = 0;
        const tryRestore = async () => {
            try {
                const nav = navigationRef.current;
                const saved = await consumeLastRoute();
                // cancelled（effect 清理 / 上下文将死）中断不收口：boot 完成标志
                // 保持缺失态，后继上下文的保存门保持关闭直至自身收口（见
                // BOOT_COMPLETED_KEY 注——双翻链中途死亡的上、下文交接口径）。
                if (cancelled) return;
                // 深链守卫：显式深链 / web 地址栏入口不恢复——URL 本身就是用户意图；
                // Expo Go 冷启 initialURL 恒为 exp://…（非显式深链）正常恢复，原生
                // 图标启动 getInitialURL() 返回 null 同样恢复；exp+<slug>://（dev
                // client 深链）与自定义 scheme 均视为显式入口。
                const initialUrl = await Linking.getInitialURL().catch(() => null);
                if (cancelled) return;
                if (initialUrl && !initialUrl.startsWith('exp://')) {
                    // 深链入口：恢复周期照常收口（后续导航按真实意图记录）
                    markLastRouteBootCompleted();
                    return;
                }
                // 路径合法守卫：'/' 开头非空、非 '/viewer' 透明路由、无 '+' 特殊段；
                // 无缓存 / 无效路径 → 不动作（停在默认 '/'）
                if (!saved || !isRestorablePath(saved)) {
                    markLastRouteBootCompleted();
                    return;
                }
                // 已在目标屏则不动作（web 重载同路径 / 锚点播种即目标）
                const currentPath = pathFromNavigationState(nav?.getRootState());
                if (currentPath === saved) {
                    markLastRouteBootCompleted();
                    return;
                }
                // replace（非 push）：恢复屏落在栈底，back 直接退出应用而非回落默认页。
                // typedRoutes 的路径联合类型是构建期生成，运行期动态路径无法静态收窄；
                // saved 已过 isRestorablePath 运行时守卫，此处仅做类型放行。
                router.replace(saved as Parameters<typeof router.replace>[0]);
                // 404 自愈回退：若 saved 仍命中 +not-found（历史脏缓存等静态守卫
                // 意外的残余），500ms 后核实一次并回落首页——死路不困人。正常命中
                // 目标屏时该核实为 no-op。
                setTimeout(() => {
                    if (cancelled) return;
                    const path = pathFromNavigationState(navigationRef.current?.getRootState());
                    if (path === '/+not-found' || path === null) {
                        router.replace('/');
                    }
                }, 500);
                // 恢复 replace 完成 = 周期收口（持久标志置位 + 保存门同步开启）：
                // 此后 replace 触发的 state 事件把恢复目标正常写回缓存，播种路径
                // 已被收口前的门控丢弃，不会被其覆盖。
                markLastRouteBootCompleted();
            } catch (e) {
                // 静默降级：恢复是增强不是关键路径，任何失败都不影响正常启动。
                // 异常同样按收口处理：保存门放行本上下文后续真实导航，不因一次
                // 恢复失败丢掉整个会话的缓存写入。
                console.warn('[last-route] restore failed:', e);
                markLastRouteBootCompleted();
            }
        };
        const tick = () => {
            if (cancelled || lastRouteRestoreDone) return;
            if (navigationRef.current?.getCurrentRoute()) {
                lastRouteRestoreDone = true;
                void tryRestore();
                return;
            }
            if (++polls >= 400) {
                lastRouteRestoreDone = true;
                // 轮询超时放弃恢复：周期按超时口径收口（保存门放行后续真实导航）
                markLastRouteBootCompleted();
                return;
            }
            pollTimer = setTimeout(tick, 20);
        };
        pollTimer = setTimeout(tick, 0);
        return () => {
            cancelled = true;
            if (pollTimer !== null) clearTimeout(pollTimer);
        };
    }, [navigationRef, router, bootReady]);

    // Android 启动门控分支（在全部 hooks 之后，hook 顺序跨渲染恒定）：bootReady
    // 收口前以过渡页替代全部 app 内容——不渲染 Stack（首页在双翻重建期间不可见，
    // 也不被重建吞掉恢复导航），RecordingSessionHost 一并顺延挂载（冷启本就无
    // 录制会话，无状态丢失面）。其余常驻副作用（窗口底色跟随、键盘/E2E 补调、
    // 数据 loadAll、启动 GC）照常在 boot 期间运行——窗口底色必须随主题翻转，
    // 否则导航栏条带会露陈旧底色。theme 同步刷新 StatusBar（boot 页底色翻转到
    // 哪档，状态栏内容就配哪档）。
    if (Platform.OS === 'android' && !bootReady) {
        return (
            <>
                <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
                <BootScreen />
            </>
        );
    }

    return (
        <AppLockGate>
            {/* 状态栏绑定生效主题（'system' 档由 useEffectiveTheme 已解析为具体档）：
                深色底用浅色内容，浅色底用深色内容 */}
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            {/* Web Desktop 全局壳（desktop-shell.tsx 头注）：仅 web 宽屏包出
                flex-row 侧栏槽位 + flex-1 内容区，Stack 渲染在内容区内——所有
                push 屏（计划编辑/事件/行程/搜索）不再覆盖侧栏；native 与窄屏
                children 原样直出，导航层级零插入（无嵌套 Stack），last-route
                恢复 / E2E 自愈 / 录制会话宿主机制不受影响。web 端 viewer 的
                全窗覆盖由 ViewerPortal(body portal) 自保证，与壳正交。 */}
            <DesktopShell>
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
                    {/* 独立计划（v8）：创建表单与编辑器都对齐 write/journal 的 modal
                        口径——编辑/创建类流程（表单成功后 replace 进编辑器的连续动线） */}
                    <Stack.Screen name="plan/new" options={{ presentation: 'modal' }} />
                    <Stack.Screen name="plan/[id]" options={{ presentation: 'modal' }} />
                    {/* 搜索（DEV.md #5）：card 而非 modal——它是内容型目的地页（日历 + 长结果
                        列表滚动、键盘输入），需要整页高度与系统返回手势；modal 留给编辑/创建类
                        流程（write / journal / trip form），与本 Stack 既有分工一致 */}
                    <Stack.Screen name="search" />
                    {/* 设置页（新1）：同 search 的内容型目的地页口径（card，整页滚动） */}
                    <Stack.Screen name="settings" />
                    {/* 计划堆 / 行程堆（v8）：同 search 的内容型目的地页口径（card） */}
                    <Stack.Screen name="plans" />
                    <Stack.Screen name="trips" />
                    {/* 搜索结果独立页（spec 路径参数 = 'all' 或编码 JSON 规格） */}
                    <Stack.Screen name="search-results/[spec]" />
                    {/* 行程表页（v9）：内容型目的地页，card 口径 */}
                    <Stack.Screen name="trip/[id]/day/[date]" />
                    {/* 计划与行程堆叠库（v8）：Me 页「计划」入口的内容型目的地页
                        （横滑翻卡浏览），同 search/settings 的 card 口径——modal 留给
                        编辑/创建类流程 */}
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
            </DesktopShell>
            {/* 全局录制会话宿主（跨页面后台录制 + 归属铁律，见 recording-session.tsx
                头注）：常驻根层级、Stack 之后的兄弟节点 = 绘制在全部屏之上——录音
                控制器 / 相机隐形保活槽 / 覆盖层 / 悬浮 chip 都在这里，不随任何屏
                挂载/卸载。与 viewer 透明路由天然互斥：覆盖层展开时其 scrim 拦截
                全部触摸（viewer 打不开）；最小化会话 + viewer 时 chip 悬浮其上，
                点按重开的覆盖层同样以 scrim 覆盖 viewer，关闭后回到 viewer，
                无层级穿透路径。空闲（无会话）渲染 null，零布局挤占。 */}
            <RecordingSessionHost />
            {/* web 数据库降级提示条（见上方 import 注）：降级 ≠ 失败态——内存库模式下
                全 app 功能照常，此条只提示「本次记录不落盘」。色板随生效主题注入。 */}
            <WebStorageDegradationBanner
                colors={{
                    background: getPalette(theme).surface,
                    border: getPalette(theme).negative,
                    text: getPalette(theme).negative,
                }}
            />
        </AppLockGate>
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
