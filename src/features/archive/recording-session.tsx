import { useCallback, useEffect, useRef } from 'react';
import { useAudioRecorder, useAudioRecorderState, RecordingPresets } from 'expo-audio';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { imagePicker } from '@/core/image-picker';
import { useArchiveStore } from './store';
import type { JournalMediaKind } from './db';
import { RecordingChip, RecordingOverlay } from './ui/recorder-overlay';
import {
    CameraCaptureOverlay,
    type CameraCapture,
    type CameraCaptureHardware,
} from './ui/camera-overlay';

/**
 * 录制会话全局化（跨页面后台录制 + 归属铁律）——本模块是全局采集会话的唯一宿主：
 * 会话状态（zustand）、编排（start/stop/cancel + 归属落库链）、硬件控制器
 * （录音 hook 控制器 / 相机硬件桥）与根层级挂载点（RecordingSessionHost）。
 *
 * 两条铁律：
 * 1. **跨页面后台录制**：状态与控制器全部挂根层级（app/_layout.tsx 渲染
 *    <RecordingSessionHost />，位于 <Stack> 之后的兄弟节点 = 全部屏之上），
 *    录音/录像不依赖任何屏的存活——从 A 笔记发起后切到任意页面（B 笔记 /
 *    tab 页 / viewer）录制继续；展开覆盖层与收起悬浮 chip 都在根层级条件
 *    渲染，任意页面可重开无缝恢复（状态一直在会话层，重开零重启动）。
 * 2. **归属铁律**：会话绑定发起时的编辑上下文 ownerJournalId；停止产物走
 *    persistCaptureProduct → store.attachJournalMedia（媒体行）→
 *    store.appendMediaBlockToJournal（DB 级块追加，读 DB 权威 blocks、绕过
 *    一切屏本地态）**落回发起笔记**——无论停止发生在哪个页面、owner 屏是否
 *    挂载。owner 屏挂载时经 subscribeRecordingSessionPersist 收到 persist
 *    事件（媒体行建立后、DB 块写入前）先把媒体块合并进本地 blocksRef（到达
 *    序合并，applyBlocks 唯一写入口），其后的防抖/收笔保存天然携带该块。
 *
 * 合并冲突口径（owner 屏有未保存本地编辑时，见报告）：
 * - persist 事件先于 DB 块写入发出 → 本地合并先发生，此后任何屏级保存的
 *   快照都包含媒体块；DB 追加侧幂等（mediaId 已引用即跳过），不产生重复块。
 * - 残余窗口：事件发出后、applyBlocks 执行前的同一 JS tick 内，若恰有一个
 *   「快照早于合并」的防抖保存已入队且后于 DB 追加落库，会以旧快照覆盖——
 *   SQLite 写队列 FIFO（早入队必早落库）下窗口为毫秒级，与旧「离开屏追加」
 *   同源的已知取舍（报告注明）。
 *
 * 层级与 viewer 的互斥核对：覆盖层 scrim（absolute inset-0，不接管点击但
 * 拦截触摸）与根层级绘制顺序保证——覆盖层展开时 viewer 透明路由无法被打开
 * （媒体点按全被 scrim 吞掉）；反向（最小化会话 + viewer 打开）chip 悬浮于
 * viewer 之上，点按重开覆盖层（scrim 覆盖 viewer），关闭后回到 viewer，
 * 交互天然隔离，无层级穿透路径。
 *
 * 麦克风竞争：录音与录像互斥——startCaptureSession 在已有会话时拒绝并返回
 * reason（B 屏 + 菜单行各行仍有可见反馈，不静默吞点按）；编辑页并行上传
 * （pendingUploadsRef）与本会话零交互。
 *
 * web：录音走 MediaRecorder（hook 全局化同构成立，SPA 路由切换不重启）；
 * 录像 recordAsync 无 web 实现（isVideoCaptureSupported 恒 false，+ 菜单已
 * 裁剪视频行），全局相机会在 web 上仅承担拍照。
 *
 * 相机流常驻耗电说明：录像会话存续期 CameraView 常驻（最小化时为 1×1dp
 * opacity 0 隐形保活槽——原生录制管线与预览可见性解耦，但取景帧仍在采集），
 * 后台录制期间耗电/发热高于普通页面，属「跨页面后台录制」特性的固有代价，
 * 由悬浮 chip 的红点常亮提示用户会话在跑（报告注明）。
 */

/* ------------------------------------------------------------------ */
/* 会话状态（zustand：单一事实源，控制器/覆盖层/chip/状态行全部订阅它）  */
/* ------------------------------------------------------------------ */

export type CaptureKind = 'audio' | 'video';
export type CapturePhase = 'idle' | 'preparing' | 'recording' | 'stopping';

interface RecordingSessionState {
    /** 会话种类：null = 空闲（一次至多一个采集会话——录音/录像互斥）。 */
    kind: CaptureKind | null;
    phase: CapturePhase;
    /** 【归属铁律】发起时的编辑上下文：停止产物固定落回这本笔记。 */
    ownerJournalId: string | null;
    /** owner 笔记的展示名（归属提示「停止后保存到 X」用，发起时冻结）。 */
    ownerLabel: string | null;
    /** 相机会的初始模式（audio 会话恒 'photo'，占位不消费）。 */
    cameraMode: 'photo' | 'video';
    startedAt: number | null;
    /** 已录秒数（录音 120ms / 录像 1s 节拍上收，chip 与 + 菜单状态行消费）。 */
    elapsedSec: number;
    metering: number | undefined;
    error: string | null;
    /** 覆盖层展开态；false = 最小化（录音继续，chip 承接）。 */
    overlayOpen: boolean;
    begin(input: {
        kind: CaptureKind;
        ownerJournalId: string;
        ownerLabel: string | null;
        cameraMode: 'photo' | 'video';
    }): void;
    setPhase(phase: CapturePhase): void;
    tick(elapsedSec: number, metering?: number): void;
    setOverlayOpen(open: boolean): void;
}

export const useRecordingSessionStore = create<RecordingSessionState>((set) => ({
    kind: null,
    phase: 'idle',
    ownerJournalId: null,
    ownerLabel: null,
    cameraMode: 'video',
    startedAt: null,
    elapsedSec: 0,
    metering: undefined,
    error: null,
    overlayOpen: false,

    begin: (input) =>
        set({
            kind: input.kind,
            phase: 'preparing',
            ownerJournalId: input.ownerJournalId,
            ownerLabel: input.ownerLabel,
            cameraMode: input.cameraMode,
            startedAt: Date.now(),
            elapsedSec: 0,
            metering: undefined,
            error: null,
            overlayOpen: true,
        }),
    setPhase: (phase) => set({ phase }),
    tick: (elapsedSec, metering) => set({ elapsedSec, metering }),
    setOverlayOpen: (overlayOpen) => set({ overlayOpen }),
}));

/* ------------------------------------------------------------------ */
/* 硬件句柄登记表（控制器挂载时注册、卸载时摘除；编排层经此驱动硬件）    */
/* ------------------------------------------------------------------ */

/** 硬件停录产物：uri null = 无产物（未开录即收场）；error = 停录失败。 */
export type CaptureHardwareProduct = { uri: string | null; durationMs?: number } | { error: string };

interface CaptureHardware {
    /** 外部停止（stopCaptureSession 编排）：停录并返回产物。 */
    stop?(): Promise<CaptureHardwareProduct>;
    /** 外部取消：停录并丢弃。 */
    cancel?(): void | Promise<void>;
}

const captureHardware: { audio?: CaptureHardware; video?: CaptureHardware } = {};

function setCaptureHardware(kind: CaptureKind, handlers: CaptureHardware | null): void {
    captureHardware[kind] = handlers ?? undefined;
}

/* ------------------------------------------------------------------ */
/* persist 事件（owner 屏本地合并通道；中立层模式，同 data-revision）    */
/* ------------------------------------------------------------------ */

/**
 * 产物持久化事件：媒体行已建立（attachJournalMedia 成功）、DB 块追加**之前**
 * 发出。owner 屏（ownerJournalId 匹配且挂载中）据此把媒体块合并进本地
 * blocksRef——先本地后 DB 的顺序保证此后屏幕保存快照必含该块（见文件头注
 * 冲突口径）。非 owner 屏必须忽略（归属铁律：B 的编辑状态与 A 的会话零耦合）。
 */
export interface RecordingSessionPersistEvent {
    ownerJournalId: string;
    mediaId: string;
    kind: JournalMediaKind;
    durationMs?: number;
}

type PersistListener = (event: RecordingSessionPersistEvent) => void;

const persistListeners = new Set<PersistListener>();

function emitPersist(event: RecordingSessionPersistEvent): void {
    for (const listener of persistListeners) listener(event);
}

export function subscribeRecordingSessionPersist(listener: PersistListener): () => void {
    persistListeners.add(listener);
    return () => {
        persistListeners.delete(listener);
    };
}

/* ------------------------------------------------------------------ */
/* 会话编排（对外 API：屏层/根层级调这里，不直接碰硬件）                 */
/* ------------------------------------------------------------------ */

export type CaptureStartOutcome = { ok: true } | { ok: false; reason: string };

export type CaptureStopOutcome =
    | { ok: true; ownerJournalId: string; kind: CaptureKind }
    | { ok: false; message: string };

function toMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

/** 会话终结（内部）：状态清零；error 非空时保留在会话状态上（spec 字段）。 */
function endCaptureSession(error: string | null): void {
    useRecordingSessionStore.setState({
        kind: null,
        phase: 'idle',
        ownerJournalId: null,
        ownerLabel: null,
        startedAt: null,
        elapsedSec: 0,
        metering: undefined,
        overlayOpen: false,
        error,
    });
}

/** 失败终结：文案同步上浮 archive store.error（各屏错误横幅展示）。 */
function failSession(message: string): void {
    useArchiveStore.setState({ error: message });
    endCaptureSession(message);
}

/**
 * 发起会话（屏层 + 菜单入口）：已有会话 → 拒绝并给 reason（可见反馈）。
 * ownerJournalId 必须是发起时编辑上下文的 journal id——编辑屏经 ensureJournal
 * 保证写前有 id（journal state 就绪才渲染 + FAB），此处兜底空 id 拒绝。
 */
export function startCaptureSession(
    kind: CaptureKind,
    ownerJournalId: string,
    opts?: { cameraMode?: 'photo' | 'video'; ownerLabel?: string | null },
): CaptureStartOutcome {
    if (!ownerJournalId) return { ok: false, reason: '笔记尚未就绪，稍后再试。' };
    const state = useRecordingSessionStore.getState();
    if (state.kind) {
        const busy =
            state.kind === 'audio' ? '录音' : state.phase === 'recording' ? '录像' : '相机';
        return { ok: false, reason: `已有${busy}在进行中（素材将保存到发起的笔记），不能同时开始。` };
    }
    state.begin({
        kind,
        ownerJournalId,
        ownerLabel: opts?.ownerLabel ?? null,
        // audio 会话不消费 cameraMode；video 会话默认录像、+ 菜单「拍照」行传 photo
        cameraMode: kind === 'video' ? (opts?.cameraMode ?? 'video') : 'photo',
    });
    return { ok: true };
}

/**
 * 停止会话（真停止 → 归属落库）：硬件停录 → attachJournalMedia（媒体行）→
 * persist 事件（owner 屏本地合并）→ appendMediaBlockToJournal（DB 级追加，
 * 产物落回 ownerJournalId——无论当前哪个页面/哪个编辑器在前台、owner 屏是否
 * 挂载）。返回 outcome 供「完成收笔」等同步链路判定。
 */
export async function stopCaptureSession(): Promise<CaptureStopOutcome> {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || !state.ownerJournalId) {
        return { ok: false, message: '当前没有进行中的录制会话。' };
    }
    if (state.phase === 'stopping') {
        return { ok: false, message: '正在停止录制，请稍候。' };
    }
    const { kind, ownerJournalId } = state;
    const wasRecording = state.phase === 'recording';
    const hardware = captureHardware[kind];
    if (!hardware?.stop) {
        failSession('录制控制器不可用，会话已结束。');
        return { ok: false, message: '录制控制器不可用，会话已结束。' };
    }
    useRecordingSessionStore.setState({ phase: 'stopping' });
    let product: CaptureHardwareProduct;
    try {
        product = await hardware.stop();
    } catch (caught) {
        const message = `停止录制失败：${toMessage(caught)}`;
        failSession(message);
        return { ok: false, message };
    }
    if ('error' in product) {
        failSession(product.error);
        return { ok: false, message: product.error };
    }
    if (!product.uri) {
        if (wasRecording) {
            failSession('录制未能生成文件，素材没有保存。');
            return { ok: false, message: '录制未能生成文件，素材没有保存。' };
        }
        // 未真正开录（prepare/取景阶段被收场）：无产物、不阻塞调用方
        endCaptureSession(null);
        return { ok: true, ownerJournalId, kind };
    }
    return persistCaptureProduct({
        ownerJournalId,
        sessionKind: kind,
        mediaKind: kind,
        uri: product.uri,
        // 硬件停录产物无尺寸（音频不适用；视频 recordAsync 不回尺寸——与旧
        // 屏层口径一致）；拍照产物走 handleCameraProduct（带尺寸）
        width: null,
        height: null,
        durationMs: product.durationMs,
    });
}

/**
 * 产物持久化核心（停录/拍照产物共用）：attach 媒体行 → persist 事件（owner
 * 屏先本地合并）→ DB 级块追加（归属落库）→ 会话终结。
 */
async function persistCaptureProduct(input: {
    ownerJournalId: string;
    sessionKind: CaptureKind;
    mediaKind: JournalMediaKind;
    uri: string;
    width: number | null;
    height: number | null;
    durationMs?: number;
}): Promise<CaptureStopOutcome> {
    useRecordingSessionStore.setState({ phase: 'stopping' });
    const mediaId = await useArchiveStore
        .getState()
        .attachJournalMedia(input.ownerJournalId, input.mediaKind, input.uri, input.width, input.height);
    if (!mediaId) {
        // attach 失败文案已由 store 上浮（store.error）；会话收场，素材弃置
        // cache 由系统清理
        endCaptureSession(null);
        return { ok: false, message: '媒体上传失败，素材未能保存。' };
    }
    // 先本地合并（owner 屏）、后 DB 追加：此后屏幕保存快照必含媒体块（头注口径）
    emitPersist({
        ownerJournalId: input.ownerJournalId,
        mediaId,
        kind: input.mediaKind,
        durationMs: input.durationMs,
    });
    const appended = await useArchiveStore.getState().appendMediaBlockToJournal(input.ownerJournalId, {
        mediaId,
        kind: input.mediaKind,
        durationMs: input.durationMs,
    });
    const outcome: CaptureStopOutcome = appended
        ? { ok: true, ownerJournalId: input.ownerJournalId, kind: input.sessionKind }
        : { ok: false, message: '素材已上传，但媒体块落库失败，请重新保存笔记。' };
    endCaptureSession(appended ? null : '媒体块落库失败，素材未能写入笔记。');
    return outcome;
}

/** 取消会话（丢弃）：硬件停录丢弃，无落库义务。 */
export async function cancelCaptureSession(): Promise<void> {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || state.phase === 'stopping') return;
    const hardware = captureHardware[state.kind];
    useRecordingSessionStore.setState({ phase: 'stopping' });
    try {
        await hardware?.cancel?.();
    } catch {
        // 取消路径尽力而为：停不掉的硬件随控制器卸载释放
    }
    endCaptureSession(null);
}

/** 会话收场（相机视图内部已自行停录/无产物后的纯状态清理；stopping 中忽略）。 */
export function clearCaptureSession(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || state.phase === 'stopping') return;
    endCaptureSession(null);
}

/** 收起覆盖层（录音/录像继续后台执行，chip 承接）。 */
export function minimizeCaptureOverlay(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || state.phase === 'stopping') return;
    state.setOverlayOpen(false);
}

/** 重开覆盖层（任意页面；会话状态一直在，重开零重启动）。 */
export function restoreCaptureOverlay(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || state.phase === 'stopping') return;
    state.setOverlayOpen(true);
}

/** 开录回执（录音 prepare+record 完成 / 相机快门进入录制态）。 */
export function markCaptureRecording(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || state.phase === 'stopping') return;
    state.setPhase('recording');
}

/** 进度上收（录音 120ms / 录像 1s 节拍；stopping 后忽略迟到 tick）。 */
export function tickCaptureProgress(elapsedSec: number, metering?: number): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || state.phase === 'stopping') return;
    state.tick(elapsedSec, metering);
}

/* ------------------------------------------------------------------ */
/* 相机硬件桥（CameraCaptureOverlay 经 props 登记，本模块持有引用）       */
/* ------------------------------------------------------------------ */

function registerCameraHardware(handlers: CameraCaptureHardware | null): void {
    setCaptureHardware('video', handlers);
}

/** 相机视图产物入口（拍照即时产物 / 快门停录产物）：按会话归属落库。 */
function handleCameraProduct(capture: CameraCapture): void {
    const state = useRecordingSessionStore.getState();
    if (!state.ownerJournalId || state.kind !== 'video') return;
    void persistCaptureProduct({
        ownerJournalId: state.ownerJournalId,
        sessionKind: 'video',
        mediaKind: capture.kind,
        uri: capture.uri,
        width: capture.width,
        height: capture.height,
    });
}

/**
 * 相册导入兜底（相机权限拒绝态的「从相册导入」）：先收场相机会话（无产物），
 * 再在根层级拉起相册选取，产物仍按会话归属（ownerJournalId）DB 级落库——
 * 归属铁律不因兜底通道改变（绝不落当前页面的笔记）。
 */
let libraryFallbackInFlight = false;

export async function requestCaptureLibraryFallback(): Promise<void> {
    const ownerJournalId = useRecordingSessionStore.getState().ownerJournalId;
    if (!ownerJournalId || libraryFallbackInFlight) return;
    libraryFallbackInFlight = true;
    try {
        await cancelCaptureSession();
        const permission = await imagePicker.getMediaLibraryPermissionAsync();
        if (!permission.granted) {
            const requested = await imagePicker.requestMediaLibraryPermissionAsync();
            if (!requested.granted) {
                useArchiveStore.setState({ error: '没有相册权限，去系统设置里开一下。' });
                return;
            }
        }
        const result = await imagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 1,
            exif: false,
        });
        if (result.canceled || result.assets.length === 0) return;
        const asset = result.assets[0];
        await persistCaptureProduct({
            ownerJournalId,
            sessionKind: 'video',
            mediaKind: 'image',
            uri: asset.uri,
            width: asset.width ?? null,
            height: asset.height ?? null,
        });
    } catch (caught) {
        useArchiveStore.setState({ error: `相册导入失败：${toMessage(caught)}` });
    } finally {
        libraryFallbackInFlight = false;
    }
}

/* ------------------------------------------------------------------ */
/* 录音控制器（原屏层 AudioRecordingSession 上收；hook 实例挂根层级）     */
/* ------------------------------------------------------------------ */

/**
 * 录音会话控制器（根层级挂载，录音无视图依赖全局成立）：持有 recorder 实例
 * 与 120ms 轮询状态，挂载即 prepare + record；覆盖层展开时渲染
 * RecordingOverlay（纯视图），收起时渲染 null（进度照常上收，chip 由宿主
 * 渲染）。停止/取消经全局编排（stopCaptureSession/cancelCaptureSession）→
 * 硬件句柄 → 归属落库链。
 *
 * 竞态防线（沿用旧口径）：prepare 未完成时停止钮禁用（Android MediaRecorder
 * 未 start 即 stop 产出无效文件）；stop/uri 读取全体 try 包裹（控制器在
 * stopping 阶段可能被会话终结卸载，recorder 随 hook release 后访问会抛——
 * 以最后一次轮询快照兜底）。
 */
function AudioCaptureController({ ownerHint }: { ownerHint: string | null }) {
    const overlayOpen = useRecordingSessionStore((s) => s.overlayOpen);
    // HIGH_QUALITY 预设（.m4a）+ 打开 metering（声纹条真数据）；web 走
    // MediaRecorder（audio/webm，落库时按字节头核对扩展名——store 既有口径）
    const recorder = useAudioRecorder({
        ...RecordingPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
    });
    // 轮询间隔 120ms：计时器跳动与声纹刷新共用一个源（避免双定时器漂移）
    const state = useAudioRecorderState(recorder, 120);
    // 轮询状态快照（硬件 stop 的兜底数据源：会话终结后 recorder 访问可能抛）
    const stateRef = useRef(state);
    stateRef.current = state;

    // 启动录音（一次性；prepare 失败 → 全局失败终结，文案上浮 store.error）
    useEffect(() => {
        let active = true;
        void (async () => {
            try {
                await recorder.prepareToRecordAsync();
                if (!active) return;
                recorder.record();
                markCaptureRecording();
            } catch (error) {
                if (active) {
                    failSession(`录音启动失败：${error instanceof Error ? error.message : String(error)}`);
                }
            }
        })();
        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- recorder 实例稳定（hook 契约），按 id 订立
    }, [recorder.id]);

    // 进度上收（chip / + 菜单状态行计时；120ms 节拍与声纹同源）
    useEffect(() => {
        tickCaptureProgress(state.durationMillis / 1000, state.metering);
    }, [state.durationMillis, state.metering]);

    // 硬件句柄登记（stop/cancel 由全局编排调用）；卸载摘除
    useEffect(() => {
        setCaptureHardware('audio', {
            stop: async () => {
                if (!stateRef.current.isRecording) {
                    // 未真正开录（prepare 在途即被外部收场）：尽力停掉，按无产物收场
                    try {
                        await recorder.stop();
                    } catch {
                        // 未开录的 stop 失败不阻塞收场
                    }
                    return { uri: null };
                }
                let stopStatus: { durationMillis?: number; url?: string } | undefined;
                try {
                    // stop() resolve 值按平台分流（JS 类型标注 Promise<void>，运行时：
                    // Android = 最终 status Bundle{ durationMillis, url }——以停止时刻
                    // 为准，胜过 120ms 轮询快照；web/iOS resolve undefined，走快照兜底）。
                    // recorder 已 release 的卸载竞态会在此抛——catch 后走快照兜底
                    stopStatus = (await recorder.stop()) as
                        | { durationMillis?: number; url?: string }
                        | undefined;
                } catch {
                    stopStatus = undefined;
                }
                if (stopStatus != null && typeof stopStatus === 'object' && stopStatus.url == null) {
                    // Android 停止失败路径（MediaRecorder.stop 抛错时 Bundle 不带
                    // url，recorder.uri 仍指向无效文件——不可落库）
                    return { error: '录音停止失败，本次录音没有保存。' };
                }
                let uri: string | null = null;
                try {
                    uri = stopStatus?.url ?? recorder.uri ?? null;
                } catch {
                    uri = null; // released SharedObject：读属性抛，走快照
                }
                uri = uri ?? stateRef.current.url ?? null;
                if (!uri) return { error: '录音未生成文件，本次录音没有保存。' };
                const finalDurationMs =
                    stopStatus?.durationMillis != null && stopStatus.durationMillis > 0
                        ? stopStatus.durationMillis
                        : stateRef.current.durationMillis;
                return { uri, durationMs: Math.round(finalDurationMs) };
            },
            cancel: async () => {
                // 丢弃路径：cache 临时文件随系统清理，停止失败不阻塞收场
                try {
                    await recorder.stop();
                } catch {
                    // 忽略
                }
            },
        });
        return () => setCaptureHardware('audio', null);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上：recorder 实例稳定（hook 契约），按 id 订立
    }, [recorder.id]);

    if (!overlayOpen) return null;

    return (
        <RecordingOverlay
            elapsedSec={state.durationMillis / 1000}
            metering={state.metering}
            isRecording={state.isRecording}
            ownerHint={ownerHint}
            onClose={minimizeCaptureOverlay}
            onStop={() => void stopCaptureSession()}
            onCancel={() => void cancelCaptureSession()}
        />
    );
}

/* ------------------------------------------------------------------ */
/* 根层级宿主（app/_layout.tsx 渲染；会话空闲时渲染 null 零成本）        */
/* ------------------------------------------------------------------ */

/** 悬浮 chip 悬挂基线：编辑器路由（无 tabBar）贴底 32；tab 页等抬高越过
 *  tabBar 条带（49dp + 余量），避免压住 tab 导航。 */
function chipBottomInset(pathname: string, bottomInset: number): number {
    const isEditorRoute =
        pathname === '/write' ||
        pathname.startsWith('/journal/') ||
        /\/write(\/|$)/.test(pathname);
    return bottomInset + (isEditorRoute ? 32 : 96);
}

/**
 * 全局录制会话宿主：根层级条件渲染三件套——录音控制器（hook 常驻）、拍摄
 * 会话（CameraView 常驻：展开 = 全屏取景卡 / 最小化 = 隐形保活槽，stop/cancel
 * 后随会话卸载）、收起态悬浮 chip（任意页面重开入口）。空闲（kind null）时
 * 整体渲染 null，零布局挤占、零监听成本。
 */
export function RecordingSessionHost() {
    const kind = useRecordingSessionStore((s) => s.kind);
    const phase = useRecordingSessionStore((s) => s.phase);
    const overlayOpen = useRecordingSessionStore((s) => s.overlayOpen);
    const cameraMode = useRecordingSessionStore((s) => s.cameraMode);
    const ownerLabel = useRecordingSessionStore((s) => s.ownerLabel);
    const elapsedSec = useRecordingSessionStore((s) => s.elapsedSec);
    const insets = useSafeAreaInsets();
    const pathname = usePathname();

    if (!kind) return null;

    return (
        <>
            {kind === 'audio' ? <AudioCaptureController ownerHint={ownerLabel} /> : null}
            {kind === 'video' ? (
                <CameraCaptureOverlay
                    initialMode={cameraMode}
                    minimized={!overlayOpen}
                    ownerHint={ownerLabel}
                    registerHardware={registerCameraHardware}
                    onRecordStart={markCaptureRecording}
                    onTick={tickCaptureProgress}
                    onProduct={handleCameraProduct}
                    onClosed={clearCaptureSession}
                    onDiscarded={clearCaptureSession}
                    onMinimize={minimizeCaptureOverlay}
                    onLibraryFallback={() => void requestCaptureLibraryFallback()}
                />
            ) : null}
            {/* 收起态承接面（phase recording 才出现——prepare 窗口不闪空 chip）：
                「● 录音中/录像中 0:32」，点按重开覆盖层（无缝恢复） */}
            {!overlayOpen && phase === 'recording' ? (
                <RecordingChip
                    label={kind === 'audio' ? '录音中' : '录像中'}
                    elapsedSec={elapsedSec}
                    bottomInset={chipBottomInset(pathname, insets.bottom)}
                    onPress={restoreCaptureOverlay}
                />
            ) : null}
        </>
    );
}
