import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
    AccessibilityInfo,
    Animated,
    Easing,
    Platform,
    Pressable,
    Text,
    View,
} from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import { BouncyPressable } from '@/core/icons';
import { useFileUrlState } from './use-file-url';
import { usePalette } from './theme';
import type { JournalMediaRow } from '../db';

/**
 * 音频块卡片（录音回放）：与图片/视频块同一套圆角/间距体系
 * （rounded-card16 + surface 卡底 tone 分层，禁阴影/渐变；#13 无边框规范
 * 收敛：卡片级描边清除，一致性审计轮与全站卡片语言归一）。
 *
 * 版式 v3（真机验收返工口径：「声纹太丑 / 时间移底部 / 卡片加高」，改
 * 「波浪+右置时间列」单行横排为 **上波浪下时间竖排**）：
 * - 卡面竖排两段：上 = **声纹波浪区**（48dp 高，flex 满宽），下 = **时间行**
 *   （底部水平居中一行「0:05 · 剩余 0:03」，当前实色 / 剩余 muted，
 *   tabular-nums 房规；总长未知显 —:—）。时间行移底的动机：时间不是操作
 *   信息，退到卡面末行让波浪独占全部宽度，条形更纤细、包络更完整；
 * - 卡高 ~104dp（py-4×2 32 + 波浪 48 + 行距 8 + 时间行 16），落在 96-104
 *   目标区间；内边距 px-5/py-4 档；宽度维持满列（阅读列内），「宽高增加」
 *   主要体现在高与呼吸感；
 * - **声纹几何 = 语音包络模拟**（v2 的 FNV 均匀随机「太毛刺」返工）：纯函数
 *   deriveWaveHeights(mediaId) 三层合成——
 *   ① 音节簇切分（mulberry32 种子化 PRNG）：「爆发段」4-8 条与「静音谷」
 *      1-2 条交替铺满固定 38 条，谷底条形 10dp 档仍可见；
 *   ② 簇内拱形包络：sin 半拱（升-降）× 簇能量（0.55-1.0），爆发段内部
 *      平滑起伏、无逐条乱跳；
 *   ③ 全局慢波动（低频正弦 ±18% 轻响轻重段落感）+ 邻域平滑抖动
 *      （0.6 自身 + 0.2 前后，保留细节去毛刺）。
 *   稳定性铁律不变：FNV-1a + mulberry32 全为纯整数/确定运算（无时钟、无
 *   Math.random），同一 mediaId 跨渲染/跨端/跨引擎同形（useMemo + 纯函数）；
 *   条形垂直居中（选居中不选底部对齐：微信/iMessage 语音波形均为中轴对称
 *   观感，底对齐会读成柱状均衡器，与「语音包络」语义不符）；
 * - **声纹单色 + 波纹进度（v8 用户口径 2026-11-10「全部声纹条单一颜色，
 *   进度改用动效表达」，声纹终版；撤销 v7 渐变蓝叠加层）**：全部 38 根条
 *   恒一色 palette.text（深色白/浅色黑，随主题翻转）——v6 的 text/faint
 *   点亮双色与 v7 的 accent 叠加层（AccentWaveBars / accentGlow /
 *   ACCENT_FADE_MS）整体退役，进度不再用颜色表达；**改由波纹动效承载**：
 *   播放推进时播放头邻域（[playhead−1, playhead+1]）确定性选两根做 scaleY
 *   弹跳 1→~1.25→1（上行 100ms ease-out + 下行 55ms ease-in，含相位 delay
 *   总长 155-195ms 落克制档；transform only，native driver，不改布局卡高
 *   恒定），波纹跟着 playhead 一路向前（v5「边界条脉冲」的直系演进，取代
 *   v4/v6 逐条点亮换色）。实现口径（详见 AudioBlock 注）：
 *   · 动画节点 = 3 个共享 Animated.Value，按 barIndex % 3 轮换挂载到邻域
 *     条目（不为 38 根各建节点；邻域外恒纯 View，重渲零动画开销）；单次
 *     弹跳总长 < 200ms 状态节拍 ⇒ 新邻域接管 Value 时上一 occupant 必已
 *     归 1，跨步零跳变（「续放 vs 重放」取舍见 AudioBlock 注）；
 *   · 每步动哪两根：「左右随机两个动一下」= fnv1a(mediaId+步进) 哈希在
 *     {左,当前}/{当前,右}/{左,右} 三模式中确定选取（RIPPLE_PATTERNS）；
 *     幅度（peak 1.16-1.25）与相位（delay 0-40ms）由 mulberry32(mediaId)
 *     逐条派生（纯函数 deriveRippleBeats，相邻条天然微差错落，无 Math.random）；
 *   · 同帧至多 2 根在动；暂停/播完/未就绪全排静默归位 1；reduceMotion
 *     全静止（useReduceMotionRef 本地副本，import 环规避见其注）；恢复
 *     seek（暂停态跳变）不波纹；播放中跳进（迟帧）先整组复位再起新步；
 *   · loading 占位与全排同色同形（哈希只吃 mediaId，解析前后零布局/零
 *     色彩跳变）；单色制下无「跨界半根」问题（v4 跨界条取舍随点亮制
 *     一并退役）。
 * - **交互（与媒体块 useBlockActionGestures 完全同语义）**：整卡面 = 触控体
 *   （BouncyPressable，scaleTo 0.985 与媒体块同档）——
 *   · native / web 触屏：单击切播放/暂停，长按 → 块操作卡（onBlockAction）；
 *   · web 桌面（pointer: fine）：双击 → 块操作卡，单击延迟 320ms 消歧后
 *     再切播放（与媒体块单击全屏同款消歧窗口）；
 *   手势解析为 media-view useBlockActionGestures 的**本地同构实现**（320ms
 *   窗口/平台分派/卸载清理逐项对齐）而非直接 import——media-view 已 import
 *   本文件的 AudioBlock，再反向 import 即成 require 环（DEV.md #14 循环
 *   告警同源，store 侧 v5 去环纪律，勿回潮）。点按 seek 仍不提供（与切播放
 *   同体冲突，微信/iMessage 口径）；编辑器场景另有外层 Pressable 作**兜底
 *   手势层**：波浪体 disabled（解析中）时触摸穿透到它，长按/双击照常弹
 *   操作卡；波浪体就绪时其 Pressability 最深优先独占，外层零双触发；
 * - **历史播放进度缓存（会话级）**：模块级 Map<mediaId, { positionMs }>，
 *   跨 FlatList 卸载/重挂/屏切换保留（**跨 App 重启不保留**，重启后从头）。
 *   写入点：暂停显式写 / 卸载写最后已知位 / 播放中随 200ms 状态流直接同步
 *   （updateInterval 已是节流 cadence，不再叠 throttle）；恢复点：player
 *   就绪后一次性 seekTo(缓存位)（暂停态停在原位，按播放继续）；播完
 *   （didJustFinish）清缓存位。切主题若触发 Android 树重建（见 v3 主题注），
 *   重挂卡靠此恢复到原位；
 * - **播完即停（用户口径 2026-11：声音播放一次，不是循环播放，全部音频）**：
 *   didJustFinish → 让互斥位 → 进度缓存清位 → pause（显式停止）→ seekTo(0)
 *   进度归位；按钮态由 playerStatus.playing 派生自动回「未播放」，进度行归
 *   零。旧 loopContinueRef 自动续播链（didJustFinish 自动 seekTo(0)+play）
 *   整链删除；「到尾再点播放 → 从头播」的主动路径保留（togglePlay 的
 *   atEnd 分支 → restartFromHead，播完即停口径下唯一的重播入口）。
 *   行为矩阵（全部音频统一，无例外分支）：
 *   · 未播 / 中途暂停 → 点按从原位续播（缓存恢复位或暂停位）；
 *   · 播放中 → 点按暂停（写缓存、让互斥位）；
 *   · 播完 → 自动停在头部、回「未播放」态（不循环）；
 *   · 播完 / 到尾再点播放 → 从头播（用户主动）。
 *   零长/损坏文件随同一停止路径天然降级：不再存在任何自动续播路径，
 *   旧「损坏文件以 150-200ms 周期无限重播」的死循环面随之消灭；
 *   与进度缓存不冲突：缓存只服务挂载恢复（restoreDoneRef 一次性读取），
 *   播完即清位，重挂后读到空缓存从头播；
 * - **切主题可用性（v3 硬性修复面）**：排查结论（嫌疑链逐条）——
 *   ①固定 hex / 不随主题的 tone 类：本文件无（声纹条/时间行全部 palette
 *     语义色 + ink/inkd 类），排除；
 *   ②动画插值含 palette 依赖：本文件现仅存的动画节点 = 播放头波纹的
 *     3 个 scaleY Value（v8，纯 transform，无 palette 参与，条色为静态
 *     prop），排除；
 *   ③useFileUrlState blob 误 revoke：该 hook effect deps 严格 [key]，
 *     主题重渲不重跑、blob 只在卸载/换 key 时 revoke（use-file-url.ts:52
 *     核实），排除；
 *   ④波浪几何 memo deps 漏项：waveHeights 纯 mediaId 派生 + deps 完整，
 *     与主题无关，排除。
 *   真根因指向 **Android 端 colorScheme.set → RN AppearanceModule.setColorScheme
 *   → AppCompatDelegate.setDefaultNightMode**（RN 0.88 AppearanceModule.kt
 *   源码核实）：AppCompat 夜间模式切换默认重建 Activity → React 树重挂 →
 *   播放器重建、播放中断、卡面短暂回 loading。本文件内可做的兜底 =
 *   会话进度缓存（重挂恢复原位）+ 全 palette 着色（重挂后色彩正确）+
 *   互斥位/存活门控的卸载清理（不留悬空 released player 引用）。治本项
 *   （app.json Android manifest uiMode configChanges / 系统级主题方案）
 *   超出本文件权限，见报告；
 * - 播放生命周期（「保存或播放出现 bug」的播放侧修复面）：
 *   · player 由 useAudioPlayer 持有并在卸载时自动 release（expo-audio
 *     useReleasingSharedObject 钩子语义，源码核实 58.0.11）——组件层补
 *     aliveRef 门控：seekTo(...).then(续播) 的异步链在卸载后不再触碰已
 *     release 的 player（released SharedObject 调用即抛 = unhandled rejection）；
 *   · play() AbortError 防护：native play() 为同步 void 无 promise 可断；
 *     web 端 AbortError（media element 随 blob 卸载被移出文档）在 expo-audio
 *     58.0.11 AudioPlayer.web.play() 内已按 isPlayInterrupted 吞掉（源码核实），
 *     组件层只需保证卸载后不再发起 play()——即 aliveRef 门控 + 互斥登记让位；
 *   · 互斥播放（大厂口径：同屏多张音频卡同时只允许一张出声，叠加播放会
 *     让「试听」失真）：模块级登记「正在播」的唯一一张，新卡起播前 pause
 *     旧卡；旧卡 UI 由它自己的 useAudioPlayerStatus 事件流自动回「播放」态，
 *     无需跨组件 setState；
 * - 三态：loading = 同几何同色占位条（v8 全排单色 text；哈希只吃 mediaId，
 *   解析前即可出形，载入完成零布局/零色彩跳变；触摸穿透到外层兜底手势层）；
 *   missing/失败 = 「录音
 *   无法播放」文字行（同卡面语言）；只读态同卡可播（无操作卡入口）；
 * - 状态刷新频率 = player updateInterval（200ms），React 侧轻量重渲染仅本卡。
 */

/** 互斥播放登记：同一时刻至多一张音频卡在播（null = 无卡在播）。 */
let activePlayback: { playerId: string; player: AudioPlayer } | null = null;

/** 起播前让位：pause 旧卡并登记新卡。released SharedObject 的 pause 会抛
    （旧卡可能恰好随卸载 release）——吞掉即可，released = 已静音无需恢复。 */
function claimPlayback(player: AudioPlayer): void {
    const previous = activePlayback;
    if (previous != null && previous.playerId !== player.id) {
        try {
            previous.player.pause();
        } catch {
            // 旧卡已 release：本就无声，忽略
        }
    }
    activePlayback = { playerId: player.id, player };
}

/**
 * 会话级播放进度缓存（历史播放进度）：mediaId → 最后已知毫秒位置。
 * 生命周期 = JS 会话：跨 FlatList 卸载/重挂、屏切换、切主题树重建均保留
 * （模块级 Map 不随组件树销毁）；跨 App 重启不保留（不做持久化——录音回放
 * 属轻场景，重启续听是伪需求，落库反而引入脏位置与文件失效边界）。
 */
interface PlaybackPositionEntry {
    positionMs: number;
}
const playbackPositions = new Map<string, PlaybackPositionEntry>();

/** 双击判定窗口（ms，web 桌面端块操作入口）——口径与 media-view 的
    useBlockActionGestures 一致；本地实现避免 audio-player ↔ media-view
    require 环（store 侧已有 v5 去环纪律，勿回潮）。 */
const DOUBLE_PRESS_WINDOW = 320;

/** web 桌面端（精确指针）才启用双击语义；web 触屏与 native 走长按。
    与 media-view 同口径（#9：桌面 web 长按改双击）。 */
function prefersDoubleClickActions(): boolean {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return false;
    const matcher = (window as Window).matchMedia;
    return typeof matcher === 'function' && matcher('(pointer: fine)').matches;
}

/** 秒 → m:ss（tabular 口径；≥1h 走 h:mm:ss）。 */
export function formatAudioTime(totalSeconds: number): string {
    const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* 声纹波浪几何（语音包络模拟：音节簇 × 拱形包络 × 慢波动）              */
/* ------------------------------------------------------------------ */

/** 声纹条数（固定：条数恒定 + flex 均分，条宽随容器弹性；38 落在 36-44 档，
    卡加高后单条 ~5-7dp，包络细节容得下）。 */
const WAVE_BAR_COUNT = 38;
/** 静音谷条形下限（dp）：谷是「停顿」不是「空行」，条形留 6dp 底线保连续观感。 */
const WAVE_BAR_MIN_HEIGHT = 6;
/** 爆发段峰值上限（dp，36-44 档）。 */
const WAVE_BAR_MAX_HEIGHT = 40;
/** 波浪区总高（dp，40-48 档）；条形在区内垂直居中。 */
const WAVE_HEIGHT = 48;
/** 条间隙（px）。 */
const WAVE_BAR_GAP = 2;

/* ------------------------------------------------------------------ */
/* 播放头波纹（v8「进度 = 动效」：bounce 跟着 playhead 一路向前）         */
/* ------------------------------------------------------------------ */

/** 邻域条 Animated 容器（模块级 createAnimatedComponent——组件级创建会在
 *  每次渲染重建 native 组件，deck.tsx #9 同源教训）。 */
const RippleBar = Animated.createAnimatedComponent(View);

/** 波纹上冲时长（ms，ease-out 攻速）：单条 scaleY 1 → peak 快起慢到顶。 */
const RIPPLE_UP_MS = 100;
/** 波纹回落时长（ms，ease-in 收尾）：peak → 1 略悬停后加速落定。上行+回落
 *  固定 155ms；加上相位 delay 总长 ≤ 195ms < 200ms 状态节拍——接管口径的
 *  基石（见 AudioBlock 注），调整任一时长必须保住「总长 < 节拍」不变式。 */
const RIPPLE_DOWN_MS = 55;
/** 波纹相位 delay 上限（ms）：逐条错落的最大起始错位（155 + 40 = 195ms）。 */
const RIPPLE_DELAY_MAX_MS = 40;
/** 波纹峰值下限（scaleY 倍率）：单条上冲的最小幅度。 */
const RIPPLE_PEAK_MIN = 1.16;
/** 波纹峰值跨度：peak ∈ [1.16, 1.25]（用户口径 ~1.25 封顶，克制不喧宾）。 */
const RIPPLE_PEAK_SPAN = 0.09;

/** 每步邻域动两根的模式集（「左右随机两个动一下」）：offset 相对播放头，
 *  {-1,0}=左+当前、{0,1}=当前+右、{-1,1}=左右两根；逐步由
 *  fnv1a(mediaId:ripple:playheadIndex) 哈希确定选取（确定性「随机」，
 *  三模式均落在播放头 ±1 内 ⇒ 波纹位置恒随播放进度前移）。 */
const RIPPLE_PATTERNS: ReadonlyArray<ReadonlyArray<-1 | 0 | 1>> = [
    [-1, 0],
    [0, 1],
    [-1, 1],
];

/** 单条波纹参数（幅度 + 相位）：由 mediaId 确定性派生，相邻条天然微差。 */
interface RippleBeat {
    /** scaleY 上冲峰值（1.16-1.25，幅度微差）。 */
    peak: number;
    /** 起始 delay（0-40ms，相位微差——两根不同时起跳才有「错落」观感）。 */
    delayMs: number;
}

/**
 * mediaId → 逐条波纹参数表。与 deriveWaveHeights 同族纯函数：FNV 种子 +
 * mulberry32，无时钟/无随机源/无外部状态，同 mediaId 跨渲染/跨端/跨引擎
 * 恒同参（确定性错落的基石：不引入 Math.random）。
 */
function deriveRippleBeats(mediaId: string): RippleBeat[] {
    const rand = mulberry32(fnv1a(`voice-ripple:${mediaId}`));
    const beats: RippleBeat[] = [];
    for (let i = 0; i < WAVE_BAR_COUNT; i += 1) {
        beats.push({
            peak: RIPPLE_PEAK_MIN + rand() * RIPPLE_PEAK_SPAN,
            delayMs: Math.round(rand() * RIPPLE_DELAY_MAX_MS),
        });
    }
    return beats;
}

/** 系统「减弱动态」探测（ref 形态）：与 recorder-overlay 的 useReduceMotionRef
 *  同实现——不直接 import 是因为 recorder-overlay 已 import 本文件的
 *  formatAudioTime，反向 import 即成 require 环（DEV.md #14 循环告警同源、
 *  去环纪律与 useBlockActionGestures 本地同构同理由，勿回潮）。波纹用它做
 *  「全静止」降级：true 时一步都不触发，条形恒自然高度。ref 形态（非 state）
 *  是刻意的：波纹在 effect 内触发，触发时刻读取即可，无需驱动重渲。 */
function useReduceMotionRef() {
    const reduceMotionRef = useRef(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled
            ?.()
            .then((enabled) => {
                if (!cancelled) reduceMotionRef.current = !!enabled;
            })
            .catch(() => undefined);
        const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (enabled) => {
            reduceMotionRef.current = !!enabled;
        });
        return () => {
            cancelled = true;
            subscription?.remove();
        };
    }, []);
    return reduceMotionRef;
}

/** FNV-1a 32 位哈希：同输入恒同输出，跨渲染/跨端/跨 JS 引擎稳定（无时钟、
    无随机源、纯整数运算——Math.imul 保证 32 位乘法不丢精度）。 */
function fnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** mulberry32 种子化 PRNG：仅 imul/移位/加法的 32 位整数运算，跨 JS 引擎
    位一致（v8/JSC/Hermes 同序列）——包络确定性的第二块基石（第一块是 FNV
    种子）。输出 [0,1)。 */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    };
}

/** 一段声纹区间的类型与能量（爆发段带能量，谷段能量恒 0）。 */
interface WaveSegment {
    start: number;
    length: number;
    valley: boolean;
    /** 簇能量 0.55-1.0（段落轻响轻重）；谷段不使用。 */
    energy: number;
}

/**
 * mediaId → 语音包络条高序列（dp 整数）。
 *
 * 目标观感 = 真实语音波形（微信语音条 / iMessage）：若干「爆发段」内条形
 * 高且相邻相关、簇间「静音谷」条形矮，全局有轻响轻重的段落感。三层合成：
 *
 * ① 音节簇切分：爆发段（4-8 条）与静音谷（1-2 条）交替铺满 WAVE_BAR_COUNT；
 *    末段按剩余条数截断（序列消费顺序确定，截断不破坏确定性）；
 * ② 簇内拱形包络：sin 半拱（升-峰-降）× 簇能量——爆发段内部平滑起伏，
 *    消灭 v2 均匀随机的逐条乱跳；谷段 0.08-0.15 低位平底；
 * ③ 全局慢波动（周期 2.2π 的低频正弦 ±18%，相位取自种子）叠加邻域平滑
 *    抖动（0.6 自身 + 0.2 前后）——段落感 + 细节，抖动过平滑会变「假波浪」。
 *
 * 纯函数：输入只有 mediaId（经 FNV 种子 + 域分隔前缀），无时钟/无随机源/
 * 无外部状态；输出恒在 [WAVE_BAR_MIN_HEIGHT, WAVE_BAR_MAX_HEIGHT] 的整数，
 * 同一 mediaId 跨渲染/跨端/跨引擎恒同形。
 */
function deriveWaveHeights(mediaId: string): number[] {
    const rand = mulberry32(fnv1a(`voice-envelope:${mediaId}`));

    // ① 音节簇切分：交替生成爆发段/谷段直到铺满（先簇后谷，首尾都是爆发段）
    const segments: WaveSegment[] = [];
    let cursor = 0;
    let expectValley = false;
    while (cursor < WAVE_BAR_COUNT) {
        const remaining = WAVE_BAR_COUNT - cursor;
        if (expectValley) {
            const length = Math.min(1 + Math.floor(rand() * 2), remaining);
            segments.push({ start: cursor, length, valley: true, energy: 0 });
            cursor += length;
        } else {
            const length = Math.min(4 + Math.floor(rand() * 5), remaining);
            segments.push({ start: cursor, length, valley: false, energy: 0.55 + rand() * 0.45 });
            cursor += length;
        }
        expectValley = !expectValley;
    }

    // ② 逐条基础振幅：簇内 sin 半拱 × 能量；谷内低位平底
    const amplitudes: number[] = [];
    for (const segment of segments) {
        if (segment.valley) {
            for (let i = 0; i < segment.length; i += 1) {
                amplitudes.push(0.08 + rand() * 0.07);
            }
        } else {
            for (let i = 0; i < segment.length; i += 1) {
                const arch = Math.sin(Math.PI * ((i + 0.5) / segment.length));
                amplitudes.push(arch * segment.energy);
            }
        }
    }

    // ③ 全局慢波动 + 平滑抖动，映射到条高区间（钳制防越界，整数化保稳定）
    const phase = rand() * Math.PI * 2;
    const shaped = amplitudes.map((amplitude, index) => {
        const undulation = 0.82 + 0.18 * Math.sin((index / WAVE_BAR_COUNT) * Math.PI * 2.2 + phase);
        return amplitude * undulation;
    });
    const jitter = shaped.map(() => (rand() - 0.5) * 0.14);
    return shaped.map((value, index) => {
        const prev = jitter[index > 0 ? index - 1 : 0];
        const next = jitter[index < WAVE_BAR_COUNT - 1 ? index + 1 : WAVE_BAR_COUNT - 1];
        const amplitude = Math.min(Math.max(value + jitter[index] * 0.6 + (prev + next) * 0.2, 0.04), 1);
        return Math.round(WAVE_BAR_MIN_HEIGHT + amplitude * (WAVE_BAR_MAX_HEIGHT - WAVE_BAR_MIN_HEIGHT));
    });
}

/** 一排声纹条（v8 单色 + 播放头邻域波纹渲染）：全部 38 根恒一色（palette.text，
    深色白/浅色黑，随主题翻转；v6 点亮双色与 v7 accent 叠加层已退役，进度由
    波纹动效承载，见文件头 v8 注）。播放头邻域 [playhead−1, playhead+1] 内的
    条挂共享波纹 Value（barIndex % 3 轮换取用，见 AudioBlock 注）渲染为
    RippleBar，其余恒纯 View（props 静态，200ms 状态流重渲零动画开销）。
    邻域条零 className（css-interop 不碰按压 observable 之外的动画面，
    样式全走 inline style，与动画值同挂）。 */
function WaveBars({
    heights,
    color,
    playheadIndex,
    rippleValues,
}: {
    heights: number[];
    /** 全排条色（v8 单色：palette.text，随主题翻转）。 */
    color: string;
    /** 播放头条引（0..N−1）：邻域 = [playhead−1, playhead+1]（端部自然收窄）。 */
    playheadIndex: number;
    /** 共享波纹驱动值（3 个，barIndex % 3 取用；静止恒 1，波纹 1→peak→1）。 */
    rippleValues: readonly Animated.Value[];
}) {
    return (
        <>
            {heights.map((height, index) => {
                const bar = {
                    flex: 1,
                    borderRadius: 9999,
                    height,
                    backgroundColor: color,
                };
                if (index >= playheadIndex - 1 && index <= playheadIndex + 1) {
                    // 邻域条：scaleY 波纹（transform only，native driver；
                    // scaleY 绕条自身中轴缩放，垂直居中不漂移、不改布局）
                    return (
                        <RippleBar
                            key={index}
                            style={[bar, { transform: [{ scaleY: rippleValues[index % 3] }] }]}
                        />
                    );
                }
                return <View key={index} style={bar} />;
            })}
        </>
    );
}

export function AudioBlock({
    media,
    durationMs,
    onBlockAction,
}: {
    media: JournalMediaRow;
    /** 块级时长元数据（录音落库时随块写入；播放器就绪后以真实 duration 为准）。 */
    durationMs?: number;
    /** 长按/双击卡片 → 块操作卡（编辑器场景由 BlockEditor 传入；无则不包兜底层）。 */
    onBlockAction?: () => void;
}) {
    const { status, uri } = useFileUrlState(media.file_key);
    const palette = usePalette();
    const player = useAudioPlayer(uri, { updateInterval: 200 });
    const playerStatus = useAudioPlayerStatus(player);
    // 声纹条高：mediaId 一次确定性派生（条高与容器宽无关——宽度由 flex 均分
    // 承担；deps 完整：纯函数只吃 mediaId）
    const waveHeights = useMemo(() => deriveWaveHeights(media.id), [media.id]);
    // 波纹参数表：mediaId 一次确定性派生（幅度/相位逐条错落，见 deriveRippleBeats）
    const rippleBeats = useMemo(() => deriveRippleBeats(media.id), [media.id]);

    const duration =
        playerStatus.isLoaded && playerStatus.duration > 0
            ? playerStatus.duration
            : durationMs != null && durationMs > 0
              ? durationMs / 1000
              : 0;
    const currentTime = playerStatus.isLoaded ? playerStatus.currentTime : 0;
    const playing = playerStatus.isLoaded && playerStatus.playing;
    // 剩余时间（底部时间行）：钳 0 防浮点越界显示负数
    const remainingSeconds = duration > 0 ? Math.max(duration - currentTime, 0) : 0;
    // 播放进度（0..1，渲染期纯派生，无动画节点/无额外 state）：驱动播放头
    // 邻域（波纹位置随进度前移）；duration 未知（0）时 ratio 恒 0 = 播放头
    // 停在首条；seek/播完归位的位置跳变整排同色（单色制无重着色面），只有
    // 波纹邻域整体迁移（跳进复位口径见下）
    const progressRatio = duration > 0 ? Math.min(Math.max(currentTime / duration, 0), 1) : 0;
    // 播放头条引 = floor(progress × N) 钳到末条（progress=1 时 floor 越界）
    const playheadIndex = Math.min(Math.floor(progressRatio * WAVE_BAR_COUNT), WAVE_BAR_COUNT - 1);

    // 播放头波纹（v8「进度 = 动效」，v5 边界条脉冲的直系演进）：播放推进
    // （playheadIndex 前进）时，新邻域内确定性选两根做 scaleY 弹跳 1→peak→1
    // （模式与参数选择见文件头 v8 注 / RIPPLE_PATTERNS / deriveRippleBeats；
    // transform only，native driver，不改布局——媒体卡高度恒定）。实现口径：
    // - 动画节点 = 3 个共享 Animated.Value，按 barIndex % 3 轮换挂载到邻域
    //   条目（不为 38 根各建节点）：任一步的三根邻域条索引连续 ⇒ 恰好用满
    //   3 个不同 Value；邻域每步滑动 1 根时条目跨步持有同一 Value（「轮换
    //   挂载」），在飞弹跳不因重渲被打断；
    // - 零跳变接管的取舍（用户口径二选一：续放 or 重放）：**重放**。基石
    //   是不变式「单次弹跳总长（delay ≤40 + 上行 100 + 下行 55 ≤195ms）<
    //   200ms 状态节拍」——每步触发时上一步所有弹跳必已落定归 1，重放的
    //   stop→setValue(1) 恒为无感空操作；代价是弹跳总长被节拍钉死上限
    //   （RIPPLE_DOWN_MS 注），要更绵长的波纹需改「从在飞相位续放」（要
    //   读在飞值/跨 Value 迁移，复杂度不成比例，故不取）；
    // - 同帧至多 2 根在动（每步一对 + 总长 < 节拍 ⇒ 不与上一步残波叠加），
    //   落「同帧至多 2-3 根」克制档；
    // - 暂停/播完/未就绪（playing 翻 false，含互斥让位/播完即停/卸载前态）：
    //   全排静默归位 1（见下方 useLayoutEffect，先于绘制复位）；
    // - 恢复 seek（暂停态位置跳变）不触发波纹（不是「播放到了」）；播放中
    //   跳进（迟帧一次前进 ≥2 根）或回退：先整组复位再按新邻域起波纹
    //   （离场条不再挂动画值，复位先于绘制无闪帧）；
    // - reduceMotion：一步都不触发，全排恒自然高度（useReduceMotionRef）；
    // - AudioBlock 是音频卡唯一实现（照片堆不收音频），堆内复用即同行为。
    const rippleValues = useRef<readonly Animated.Value[]>([
        new Animated.Value(1),
        new Animated.Value(1),
        new Animated.Value(1),
    ]).current;
    const reduceMotionRef = useReduceMotionRef();
    const playheadRef = useRef(0);
    useLayoutEffect(() => {
        const previous = playheadRef.current;
        playheadRef.current = playheadIndex;
        if (!playing) return; // 未播（暂停/未就绪/播完归位）：静默，只同步游标
        const stepped = playheadIndex === previous + 1;
        if (!stepped) {
            // 跳进/回退（迟帧、seek）：整组复位先于绘制——旧邻域离场条不以
            // 在飞值闪帧；随后按新邻域重新起波纹（回退则不起）
            for (const value of rippleValues) {
                value.stopAnimation();
                value.setValue(1);
            }
        }
        if (playheadIndex <= previous) return; // 「一路向前」：回退/原地不波纹
        if (reduceMotionRef.current) return; // 减弱动态：全静止
        // 「左右随机两个动一下」：本步模式由 (mediaId, playhead) 哈希确定选取
        const pattern =
            RIPPLE_PATTERNS[fnv1a(`${media.id}:ripple:${playheadIndex}`) % RIPPLE_PATTERNS.length];
        for (const offset of pattern) {
            const barIndex = playheadIndex + offset;
            if (barIndex < 0 || barIndex >= WAVE_BAR_COUNT) continue; // 端部邻域越界条跳过
            const beat = rippleBeats[barIndex];
            const value = rippleValues[barIndex % 3];
            // 接管：stop→复位→重放（总长 < 节拍 ⇒ 此刻恒已归 1，无感空操作）
            value.stopAnimation();
            value.setValue(1);
            Animated.sequence([
                // 相位错落：delay 为 sequence 子节点，与 timing 同走 native
                Animated.delay(beat.delayMs),
                Animated.timing(value, {
                    toValue: beat.peak,
                    duration: RIPPLE_UP_MS,
                    easing: Easing.out(Easing.quad),
                    useNativeDriver: true,
                }),
                Animated.timing(value, {
                    toValue: 1,
                    duration: RIPPLE_DOWN_MS,
                    easing: Easing.in(Easing.quad),
                    useNativeDriver: true,
                }),
            ]).start();
        }
        // deps：playheadIndex/playing 驱动；media.id/rippleBeats 同源 memo；
        // rippleValues/reduceMotionRef 为稳定引用
    }, [playheadIndex, playing, media.id, rippleBeats, rippleValues, reduceMotionRef]);
    // 暂停/播完清波纹：邻域条回落 1（静止位形），下次推进重新起波纹；
    // useLayoutEffect 先于绘制——暂停帧不见半途缩放值
    useLayoutEffect(() => {
        if (playing) return;
        for (const value of rippleValues) {
            value.stopAnimation();
            value.setValue(1);
        }
    }, [playing, rippleValues]);

    // 最后已知播放位（卸载写缓存用）：状态流里同步，卸载清理函数只读 ref
    const latestTimeRef = useRef(0);
    // 存活门控：seekTo(...).then(续播) 与到尾重播的异步链在卸载/换源（player
    // 重建）后不得再触碰旧 player——released SharedObject 的方法调用会抛
    // （native）或以 AbortError 拒绝（web media element 已移出文档）。
    // uri null→file:// 会重建一次 player，旧实例同样在此门控下作废。
    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => {
            aliveRef.current = false;
            // 卸载（FlatList 回收/屏切换/切主题树重建/换源）：最后已知位置写入
            // 会话缓存——重挂后由恢复点拉回原位（「历史播放进度」的卸载写入点）
            playbackPositions.set(media.id, {
                positionMs: Math.round(latestTimeRef.current * 1000),
            });
            // 卸载/换源即让出互斥位（player 本体由 useAudioPlayer 钩子 release）
            if (activePlayback?.playerId === player.id) activePlayback = null;
        };
    }, [player, media.id]);

    // 到尾重播（用户主动路径，播完即停口径下唯一的重播入口）：抢互斥位 →
    // seekTo(0) → 复核存活/互斥后 play()。「播完/到尾再点播放」走此链
    // （行为矩阵见文件头「播完即停」节）。seek 异常（卸载/换源竞态）无
    // 界面可更新，静默即可。
    const restartFromHead = () => {
        // 先抢互斥位再 seek：seek 是异步 promise，续播前复核存活 + 互斥位
        // （窗口内用户可能已暂停/别的卡可能已起播——都不得回弹续播）
        claimPlayback(player);
        void player
            .seekTo(0)
            .then(() => {
                if (!aliveRef.current) return;
                if (activePlayback?.playerId !== player.id) return;
                player.play();
            })
            .catch(() => {
                // 卸载/换源竞态：静默（web AbortError 同源症状的续播路径）
            });
    };

    // 播完即停（用户口径 2026-11：声音播放一次，不是循环播放，全部音频）：
    // didJustFinish → 让互斥位 → 进度缓存清位 → pause（显式停止，按钮态由
    // playerStatus.playing 派生自动回「未播放」）→ seekTo(0) 进度归位。
    // 旧 loopContinueRef 自动续播闩与续播链整链删除，无替代闩——web 端
    // seek 落地前 media.ended 可持续为 true（200ms 状态帧重复进入），重复
    // pause/seekTo(0) 幂等无声，旧闩防的是重复 seek+play 的可闻续播，该链
    // 已不存在。零长/损坏文件随同一停止路径天然降级（不再有续播路径可
    // 死循环）。与进度缓存不冲突：缓存只服务挂载恢复，播完即清。
    useEffect(() => {
        if (!playerStatus.didJustFinish) return;
        // 让出互斥位（登记语义 = 「正在播」的唯一一张）
        if (activePlayback?.playerId === player.id) activePlayback = null;
        // 播完清缓存位：重听 = 用户主动（到尾再点播放 → 从头播）
        playbackPositions.delete(media.id);
        if (!aliveRef.current) return;
        player.pause();
        void player.seekTo(0).catch(() => {
            // 卸载/换源竞态：静默（点亮条停在归位后的 0，不穿帮）
        });
        // pause/seekTo 只消费 player 与稳定引用（aliveRef / 模块级登记），
        // player 与 media.id 已在 deps
    }, [playerStatus.didJustFinish, player, media.id]);

    // 会话缓存随状态流同步：updateInterval 200ms 已是节流 cadence，直接同步
    // 写入不再叠 throttle；didJustFinish 帧跳过（播完清位语义归上面的播完
    // 即停 effect 管，避免把尾部位置又写回缓存）。暂停后 currentTime 不再
    // 变化，本 effect 停在最后已知位——暂停显式写入点见 togglePlay。
    useEffect(() => {
        if (!playerStatus.isLoaded || playerStatus.didJustFinish) return;
        playbackPositions.set(media.id, { positionMs: Math.round(currentTime * 1000) });
    }, [playerStatus.isLoaded, playerStatus.didJustFinish, currentTime, media.id]);

    // 挂载恢复（历史播放进度的读取点）：player 就绪后一次性回到缓存位置
    // （暂停态停在原位，按播放继续；不自动续播——自动播违反平台媒体策略
    // 且打扰）。restoreDoneRef 闩保证每挂载至多恢复一次；已在播/player 自带
    // 残留进度时不覆盖。
    const restoreDoneRef = useRef(false);
    useEffect(() => {
        if (!playerStatus.isLoaded || restoreDoneRef.current) return;
        restoreDoneRef.current = true;
        const cached = playbackPositions.get(media.id);
        if (cached == null || cached.positionMs <= 0) return;
        if (playerStatus.playing) return;
        if (playerStatus.currentTime > 0.25) return;
        void player.seekTo(cached.positionMs / 1000).catch(() => {
            // seek 被卸载/换源打断：静默（点亮条停在 0，不穿帮）
        });
        // restoreDoneRef 闩后仅首帧生效，闭包值即为就绪时刻快照
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [playerStatus.isLoaded, playerStatus.playing, playerStatus.currentTime, media.id, player]);

    // 最后已知位随 200ms 状态流同步（卸载写会话缓存的读取源）；波纹邻域
    // 直接消费渲染期派生的 playheadIndex，本 effect 不再驱动动画
    useEffect(() => {
        latestTimeRef.current = currentTime;
    }, [currentTime]);

    const togglePlay = () => {
        // player 未就绪（duration 常为 0、seekTo 行为平台不定）一律不发起：
        // 本地文件 <100ms 即 isLoaded，静默短窗可接受，错误状态另行整卡呈现
        if (!player || !playerStatus.isLoaded) return;
        if (playing) {
            player.pause();
            // 暂停即写会话缓存（「历史播放进度」的显式收口点：暂停刻的
            // currentTime 为状态流最后已知位，与卸载写入同口径）
            playbackPositions.set(media.id, { positionMs: Math.round(currentTime * 1000) });
            // 本卡让出互斥位（登记语义 = 「正在播」的唯一一张）
            if (activePlayback?.playerId === player.id) activePlayback = null;
            return;
        }
        // 播完/到尾再点播放：从头开始（播完即停口径下的用户主动重播路径，
        // 行为矩阵见文件头「播完即停」节）。duration 未知（0）时不得把
        // 「从头播」当默认分支——先直接 play
        const atEnd = playerStatus.didJustFinish || (duration > 0 && currentTime >= duration - 0.05);
        if (atEnd) {
            restartFromHead();
            return;
        }
        claimPlayback(player);
        player.play();
    };

    // 块操作手势（media-view useBlockActionGestures 范式的本地同构实现，
    // require 环规避见文件头）：native/web 触屏 → 单击切播放 + 长按操作卡；
    // web 桌面 → 双击操作卡、单击 320ms 消歧后切播放。
    const finePointer = useMemo(() => prefersDoubleClickActions(), []);
    const gesturesEnabled = onBlockAction != null;
    const doubleClick = gesturesEnabled && finePointer;
    const lastWavePressRef = useRef(0);
    const singlePressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        // 消歧定时器随卸载清理（挂起中的单击不再落放——媒体块同款清理）
        return () => {
            if (singlePressTimerRef.current != null) clearTimeout(singlePressTimerRef.current);
        };
    }, []);

    const handleWavePress = () => {
        if (!doubleClick) {
            // native / web 触屏 / 无操作卡场景：单击即切播放（无消歧成本）
            togglePlay();
            return;
        }
        const now = Date.now();
        if (now - lastWavePressRef.current < DOUBLE_PRESS_WINDOW) {
            // 第二击：取消挂起的切播放，弹操作卡
            lastWavePressRef.current = 0;
            if (singlePressTimerRef.current != null) {
                clearTimeout(singlePressTimerRef.current);
                singlePressTimerRef.current = null;
            }
            onBlockAction?.();
            return;
        }
        // 首击：挂起切播放，等双击判定窗口收口
        lastWavePressRef.current = now;
        if (singlePressTimerRef.current != null) clearTimeout(singlePressTimerRef.current);
        singlePressTimerRef.current = setTimeout(() => {
            singlePressTimerRef.current = null;
            togglePlay();
        }, DOUBLE_PRESS_WINDOW);
    };

    // 双击语义生效时不再挂长按（避免桌面鼠标按住 500ms 触发第二套入口）
    const waveLongPress = gesturesEnabled && !doubleClick ? onBlockAction : undefined;

    // 兜底手势层（仅编辑器场景挂载）：波浪体 disabled（解析中）时触摸穿透
    // 到本层，长按（native/web 触屏）/双击（web 桌面）仍可弹操作卡——加载
    // 窗口内操作卡不断。波浪体就绪时其 Pressability 最深优先独占整卡触摸，
    // 本层零触发、零双派发。
    const lastFallbackPressRef = useRef(0);
    const handleFallbackPress = () => {
        if (!finePointer) return; // native/web 触屏走长按，单击无动作
        const now = Date.now();
        if (now - lastFallbackPressRef.current < DOUBLE_PRESS_WINDOW) {
            lastFallbackPressRef.current = 0;
            onBlockAction?.();
            return;
        }
        lastFallbackPressRef.current = now;
    };

    const ready = status === 'ready' && uri != null;

    const card = (
        <BouncyPressable
            onPress={handleWavePress}
            onLongPress={waveLongPress}
            disabled={!ready}
            scaleTo={0.985}
        >
            <View className="rounded-card bg-ink-surface px-5 py-4 dark:bg-inkd-surface">
                {/* 上：声纹波浪区（48dp，条形垂直居中）。整卡触摸体由
                    BouncyPressable 承担（命中区 = 波浪 + 时间行，≥44dp 等效
                    目标，无 hitSlop 外扩——与邻卡间距 16dp > 8，无重叠核算项） */}
                <View
                    accessibilityRole="button"
                    accessibilityLabel={playing ? '暂停录音' : '播放录音'}
                    style={{ height: WAVE_HEIGHT }}
                >
                    {/* 单色声纹 + 播放头波纹（v8 终版）：全排 38 根恒一色
                        palette.text（深色白/浅色黑，随主题翻转；v6 faint 双色
                        与 v7 accent 叠加层已退役，进度由波纹动效承载，见文件头
                        v8 注）。未就绪（loading）期 currentTime=0 ⇒ playhead=0，
                        整排同几何同色占位（哈希只吃 mediaId，解析前即出形，
                        载入零跳变；触摸穿透到外层兜底手势层）。颜色从 palette
                        取语义色（无固定 hex，深浅翻转由 useEffectiveTheme 驱动
                        重渲自动换色）；播放头邻域条挂共享波纹 Value，其余恒
                        纯 View（重渲零动画开销） */}
                    <View
                        style={{
                            height: WAVE_HEIGHT,
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: WAVE_BAR_GAP,
                        }}
                    >
                        <WaveBars
                            heights={waveHeights}
                            color={palette.text}
                            playheadIndex={playheadIndex}
                            rippleValues={rippleValues}
                        />
                    </View>
                </View>
                {/* 下：时间行（底部水平居中）——「0:05 · 剩余 0:03」：当前
                    （text 实色）/ 分隔+剩余（muted），tabular-nums 房规；
                    总长未知（未加载且无块级元数据）显 —:— 占位（已有时间则
                    只显当前），行高稳定不跳。非按压体（触摸体为整卡） */}
                <View className="mt-2 flex-row items-center justify-center gap-1.5">
                    {duration > 0 ? (
                        <>
                            <Text
                                className="text-[12px] font-medium text-ink-text dark:text-inkd-text"
                                style={{ fontVariant: ['tabular-nums'] }}
                            >
                                {formatAudioTime(currentTime)}
                            </Text>
                            <Text
                                className="text-[12px] text-ink-muted dark:text-inkd-muted"
                                style={{ fontVariant: ['tabular-nums'] }}
                            >
                                {`· 剩余 ${formatAudioTime(remainingSeconds)}`}
                            </Text>
                        </>
                    ) : currentTime > 0 ? (
                        <Text
                            className="text-[12px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {formatAudioTime(currentTime)}
                        </Text>
                    ) : (
                        <Text
                            className="text-[12px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {'—:—'}
                        </Text>
                    )}
                </View>
            </View>
        </BouncyPressable>
    );

    if (status === 'missing') {
        // 失败态：同一卡面语言（surface 底 + ink-border）；纯文字行——装饰 icon
        // 一并退场（用户口径：卡面只要文字）
        return (
            <View className="rounded-card bg-ink-surface px-5 py-4 dark:bg-inkd-surface">
                <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                    录音无法播放
                </Text>
            </View>
        );
    }

    if (!onBlockAction) return card;

    // 编辑器场景兜底手势层：见 handleFallbackPress 注。子元素保持 in-flow
    //（唯一子元素 absolute 会塌父命中区）。
    return (
        <Pressable
            onPress={finePointer ? handleFallbackPress : undefined}
            onLongPress={finePointer ? undefined : onBlockAction}
            accessibilityLabel="录音块操作"
        >
            <View collapsable={false}>{card}</View>
        </Pressable>
    );
}
