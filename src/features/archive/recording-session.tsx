import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { useAudioRecorder, useAudioRecorderState, RecordingPresets } from 'expo-audio';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { useArchiveStore, aggregateSaveProgress } from './store';
import { usePalette } from './ui/theme';
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
 * 2. **归属铁律**：会话绑定发起时的编辑上下文 owner（v6.1 泛化：journal 笔记
 *    或 event 工单，见 CaptureOwner）；停止产物走 persistCaptureProduct →
 *    store.attachJournalMedia / attachEventMedia（媒体行）→
 *    store.appendMediaBlockToJournal / appendMediaBlockToEvent（DB 级块追加，
 *    读 DB 权威 blocks、绕过一切屏本地态）**落回发起上下文**——无论停止发生
 *    在哪个页面、owner 屏是否挂载。owner 屏挂载时经
 *    subscribeRecordingSessionPersist 收到 persist 事件（媒体行建立后、DB 块
 *    写入前）先把媒体块合并进本地 blocksRef（到达序合并，applyBlocks 唯一
 *    写入口），其后的防抖/收笔保存天然携带该块。
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
 *
 * 停止链路（会话级，**不依赖覆盖层挂载状态**——最小化后停止失败的修复口径）：
 * 外部停止（完成收笔编排）与本地快门停止统一走 stopCaptureSession——会话层
 * 先挂产物等待槽（videoStopIntake），再经硬件句柄（stopRecording，绑
 * CameraView ref）触发原生停录，覆盖层只是 UI 消费方（控制行可整段卸载，
 * 最小化保活槽态的 ref 照常可达，产物经 onProduct 回流会话层结算）。
 * 停止语义两段式（用户口径：点停止 = 关窗即返回，保存后台自动完成）：
 * **硬件停录段**（5s 护栏——拿到产物文件或超时失败；这一步必须同步等，否则
 * 不知道有无产物）完成后**立即终结 UI 会话**（卡片 ~160ms 淡出关闭、chip
 * 消失，无 spinner 停留）；**落库段转后台**（无进度增量护栏——连续 30s 无进度
 *  拍点才判超时，web 大文件流式落盘不再被固定总时长误杀；任务注册进会话级
 * 后台落库注册表，收敛时成功静默（媒体块出现在笔记即反馈，2026-11-09 用户
 * 口径）/失败文案上浮）。后台落库
 * 期间允许立即开新会话（落库是 IO+DB、录制是相机/麦克风，零资源冲突；
 * persisting 相位只作收笔等待痕迹，不渲染任何 UI）。「完成收笔」经
 * stopCaptureSession 等待同归属后台任务 allSettled 再收笔（FAB 等待口径
 * 保留——这是收笔动作，不是录制 UI）。双护栏兜底：停录 5s + 落库 30s 无增量，任何
 * 路径不得把会话永久留在 stopping/persisting。护栏超时强制收场（错误上浮
 * 「停止超时」）并为已落盘的迟到产物开 15s 抢救窗口（尽力按原归属入库，
 * 过窗/失败给明确丢弃提示，绝不静默）；sessionToken（startedAt）防串会话，
 * 迟到产物绝不误归属新会话。
 */

/* ------------------------------------------------------------------ */
/* 会话状态（zustand：单一事实源，控制器/覆盖层/chip/状态行全部订阅它）  */
/* ------------------------------------------------------------------ */

export type CaptureKind = 'audio' | 'video';

/**
 * 录制会话归属（v6.1 泛化，拍照/录像/录音接入事件工单的前提）：
 * - { kind: 'journal', id } = 笔记（journal-edit-screen 发起，旧口径）；
 * - { kind: 'event', id } = 事件工单（event-detail-screen 发起）。
 * 停止产物按 kind 分派落库链（attach/append 的 journal/event 双侧）；
 * persist 事件与 zustand 状态上的 ownerJournalId 为 journal 归属的兼容投影
 * （见各自注）。
 */
export type CaptureOwner = { kind: 'journal' | 'event'; id: string };

/** CaptureOwner → 兼容投影（journal-edit-screen 未迁移消费面）：journal 归属
 *  返回其 id，事件归属返回 null——旧消费点的 `=== 本篇 id` 判定对事件归属
 *  天然为 false（不会误合并/误提示），兼容零改动。 */
function ownerJournalIdCompat(owner: CaptureOwner | null): string | null {
    return owner && owner.kind === 'journal' ? owner.id : null;
}

/** startCaptureSession 归属参数归一：裸 string = journal 归属（旧口径——
 *  journal-edit-screen 的调用点保持 `startCaptureSession(kind, row.id)` 不动），
 *  CaptureOwner = 显式归属（事件屏传 { kind: 'event', id }）。 */
function normalizeCaptureOwner(owner: CaptureOwner | string): CaptureOwner {
    return typeof owner === 'string' ? { kind: 'journal', id: owner } : owner;
}
/**
 * 会话相位：
 * - stopping = 硬件停录段在途（卡片淡出关闭中，5s 护栏兜底）；
 * - persisting = UI 会话已终结、落库在后台（零 UI；kind/owner/startedAt 仅作
 *   收笔等待与防串会话的痕迹，新会话可立即发起）。
 */
export type CapturePhase = 'idle' | 'preparing' | 'recording' | 'stopping' | 'persisting';

interface RecordingSessionState {
    /** 会话种类：null = 空闲（一次至多一个采集会话——录音/录像互斥）。 */
    kind: CaptureKind | null;
    phase: CapturePhase;
    /** 【归属铁律】发起时的编辑上下文：停止产物固定落回该归属（journal 或 event）。 */
    owner: CaptureOwner | null;
    /**
     * ownerJournalId（兼容投影，journal-edit-screen 未迁移消费面专用——
     * persist 订阅 / + 菜单归属提示 / 收笔 owner 判定三处读它）：journal 归属
     * = 该笔记 id；事件归属 = null（旧消费点的 `=== 本篇 id` 判定天然为
     * false，归属铁律不被破坏）。新消费点一律读 owner。
     */
    ownerJournalId: string | null;
    /** owner 上下文的展示名（归属提示「停止后保存到 X」用，发起时冻结）。 */
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
        owner: CaptureOwner;
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
    owner: null,
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
            owner: input.owner,
            // 兼容投影同帧写入：journal-edit-screen 的三处旧消费点读
            // ownerJournalId（见接口注），事件归属投影为 null
            ownerJournalId: ownerJournalIdCompat(input.owner),
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
    /** 音频硬件停录（expo-audio 控制器）：停录并返回产物。 */
    stop?(): Promise<CaptureHardwareProduct>;
    /** 视频原生停录句柄（绑 CameraView ref——隐形保活槽态同样可达，不依赖
     *  覆盖层 chrome）：停掉原生录制，返回是否真有录制在停（false = 取景/
     *  未开录态，无产物）。停止的等待/护栏/落库都在会话层（见停止链路头注）。 */
    stopRecording?(): boolean;
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
 * 产物持久化事件：媒体行已建立（attachJournalMedia / attachEventMedia 成功）、
 * DB 块追加**之前**发出。owner 屏（owner 匹配且挂载中）据此把媒体块合并进本地
 * blocksRef——先本地后 DB 的顺序保证此后屏幕保存快照必含该块（见文件头注
 * 冲突口径）。非 owner 屏必须忽略（归属铁律：B 的编辑状态与 A 的会话零耦合）。
 */
export interface RecordingSessionPersistEvent {
    /** 泛化归属（v6.1）：新消费点按 kind + id 判定（事件屏比对 event id）。 */
    owner: CaptureOwner;
    /**
     * ownerJournalId（兼容投影，journal-edit-screen 未迁移消费面专用）：
     * journal 归属 = 该笔记 id（旧消费点 `event.ownerJournalId !== row.id`
     * 判定照常成立）；事件归属 = null（旧判定天然 false，不误合并）。
     */
    ownerJournalId: string | null;
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
    | { ok: true; owner: CaptureOwner; kind: CaptureKind }
    | { ok: false; message: string };

function toMessage(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
}

/** 会话链路错误上浮（archive store.error——各屏错误横幅展示，不静默）。 */
function surfaceSessionError(message: string): void {
    useArchiveStore.setState({ error: message });
}

/** 会话终结（内部）：状态清零；error 非空时保留在会话状态上（spec 字段）。 */
function endCaptureSession(error: string | null): void {
    cancelUiSessionClose(); // 收尾卫生：终结即作废在途的淡出收尾调度（幂等）
    useRecordingSessionStore.setState({
        kind: null,
        phase: 'idle',
        owner: null,
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
    surfaceSessionError(message);
    endCaptureSession(message);
}

/** 停止/取消在途（硬件停录段 + 后台落库期）：minimize/restore/mark/tick/cancel/clear 一律不响应。 */
function isSessionSettling(phase: CapturePhase): boolean {
    return phase === 'stopping' || phase === 'persisting';
}

/**
 * UI 会话终结的后台落库相位（persisting）：卡片/覆盖层/chip 已随淡出全部
 * 消失（宿主按相位不渲染采集 UI，CameraView/录音机随卸载释放——产物已
 * 到手，卸载即停不再伤及录制）；kind/ownerJournalId/startedAt 仅作落库期
 * 痕迹保留——「完成收笔」据此路由进 stopCaptureSession 的等待分支（防
 * 「停后立即收笔」以旧快照封存笔记的丢块竞态），新会话可立即发起
 * （startCaptureSession 对 persisting 放行，begin 原子顶替痕迹）。
 */
function enterPersistingPhase(): void {
    useRecordingSessionStore.setState({
        phase: 'persisting',
        overlayOpen: false,
        elapsedSec: 0,
        metering: undefined,
        ownerLabel: null,
    });
}

/**
 * 发起会话（屏层 + 菜单入口）：已有会话 → 拒绝并给 reason（可见反馈）；
 * **persisting（后台落库期）放行**——落库是 IO+DB、新录制是相机/麦克风，
 * 零资源冲突，begin() 原子顶替痕迹，旧会话的后台任务经注册表独立收敛
 * （token 防串）。owner 必须是发起时编辑上下文的归属（journal 笔记或事件
 * 工单，见 CaptureOwner；journal-edit-screen 传裸 id 走 journal 归属兼容），
 * 编辑屏经 ensureJournal / 详情页 event 行就绪保证写前有 id，此处兜底空 id
 * 拒绝。
 */
export function startCaptureSession(
    kind: CaptureKind,
    owner: CaptureOwner | string,
    opts?: { cameraMode?: 'photo' | 'video'; ownerLabel?: string | null },
): CaptureStartOutcome {
    const normalizedOwner = normalizeCaptureOwner(owner);
    if (!normalizedOwner.id) {
        return {
            ok: false,
            reason: normalizedOwner.kind === 'event' ? '事件尚未就绪，稍后再试。' : '笔记尚未就绪，稍后再试。',
        };
    }
    const state = useRecordingSessionStore.getState();
    if (state.kind && state.phase !== 'persisting') {
        const busy =
            state.kind === 'audio' ? '录音' : state.phase === 'recording' ? '录像' : '相机';
        return { ok: false, reason: `已有${busy}在进行中（素材将保存到发起的页面），不能同时开始。` };
    }
    state.begin({
        kind,
        owner: normalizedOwner,
        ownerLabel: opts?.ownerLabel ?? null,
        // audio 会话不消费 cameraMode；video 会话默认录像、+ 菜单「拍照」行传 photo
        cameraMode: kind === 'video' ? (opts?.cameraMode ?? 'video') : 'photo',
    });
    return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 停止链路（会话级停止桥 + 双护栏）：等待/护栏/落库编排全在会话层，      */
/* 覆盖层只是句柄宿主与 UI 消费方——最小化保活槽态停止照常工作            */
/* ------------------------------------------------------------------ */

/** 停录护栏（ms）：硬件停录超时即强制收场，会话绝不滞留 stopping。 */
const STOP_RESOLVE_TIMEOUT_MS = 5000;
/** 迟到产物抢救窗口（ms）：护栏超时后原生产物才落地（典型为会话终结卸载
 *  CameraView 强制收尾触发——文件实际已落盘），仍按原归属尽力入库；过窗
 *  给明确丢弃提示，绝不静默。 */
const SALVAGE_WINDOW_MS = 15000;
/**
 * 落库护栏（2026-11-08 改造：固定总时长 → 「无进度增量」判定）：连续
 * PERSIST_STALL_TIMEOUT_MS 无任何进度拍（进度回调/任务收敛均刷新活跃时刻）
 * 才判超时。理由：web 端大视频流式落盘合法耗时可达分钟级（旧 30s 固定护栏
 * 会对健康的慢任务弹假「保存超时」）；本地存储/DB 真挂死时同样先收场任务
 * 并给明确口径（落库链仍在后台继续，完成后媒体自然出现在笔记中，失败由
 * store 具体文案上浮）。
 */
const PERSIST_STALL_TIMEOUT_MS = 30000;
/** 落库活跃度巡检周期（ms）：护栏判定用轮询节拍。 */
const PERSIST_STALL_POLL_MS = 5000;
/** UI 收尾淡出缓冲（ms）：硬件停录段完成、产物去向已定后，等卡片淡出
 *  （覆盖层自驱动 ~160ms，见 camera-overlay/recorder-overlay）落地再切换
 *  相位/卸载——杜绝「半透明卡片瞬间消失」穿帮。落库任务注册不等缓冲。 */
const UI_CLOSE_FADE_MS = 180;

/** 停录产物等待槽：stopCaptureSession 挂上，覆盖层产物经 onProduct 回流结算。 */
interface VideoStopIntake {
    /** 发起停止的会话令牌（startedAt）：迟到产物只结算同代会话，防串会话。 */
    sessionToken: number;
    deliver(product: CaptureHardwareProduct): void;
}

let videoStopIntake: VideoStopIntake | null = null;

/** 抢救窗口槽：护栏超时后短暂等待迟到的原生产物（素材已落盘则尽力入库）。 */
interface VideoSalvageIntake {
    sessionToken: number;
    owner: CaptureOwner;
    timer: ReturnType<typeof setTimeout>;
}

let videoSalvageIntake: VideoSalvageIntake | null = null;

/**
 * 视频硬件停录（会话级，不依赖覆盖层挂载状态）：先挂产物等待槽，再经句柄
 * 触发原生停录（隐形保活槽态的 CameraView ref 同样可达），5s 护栏兜底——
 * 超时强制收场（错误上浮与相位释放由调用方 failSession 统一完成）并开迟到
 * 产物抢救窗口。返回产物与「是否真有录制在停」（句柄同步回执）。
 */
function stopVideoHardwareWithGuard(
    stopRecording: () => boolean,
    sessionToken: number,
    owner: CaptureOwner,
): Promise<{ product: CaptureHardwareProduct; wasRecording: boolean }> {
    return new Promise((resolve) => {
        let settled = false;
        // 硬件句柄（同步）：停掉原生录制并回执是否有录制在停。recordAsync 的
        // resolve 只发生在原生事件（Finalize），本同步块内先挂好等待槽再触发，
        // 产物经 onProduct 回流时必然命中等待槽，不丢产物
        const wasRecording = stopRecording();
        const guardTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            videoStopIntake = null;
            // 迟到产物抢救窗口：原生 finalize 晚于护栏时素材已落盘，仍按原
            // 归属尽力入库；窗口空过则明确丢弃提示（不静默）
            videoSalvageIntake = {
                sessionToken,
                owner,
                timer: setTimeout(() => {
                    if (videoSalvageIntake?.sessionToken === sessionToken) {
                        videoSalvageIntake = null;
                        surfaceSessionError('录制停止超时，迟到的录像素材未能保存。');
                    }
                }, SALVAGE_WINDOW_MS),
            };
            resolve({
                product: { error: '录制停止超时，素材可能未保存。' },
                wasRecording,
            });
        }, STOP_RESOLVE_TIMEOUT_MS);
        const deliver = (product: CaptureHardwareProduct) => {
            if (settled) return;
            settled = true;
            clearTimeout(guardTimer);
            videoStopIntake = null;
            resolve({ product, wasRecording });
        };
        videoStopIntake = { sessionToken, deliver };
        if (!wasRecording) {
            // 未开录（取景/准备阶段被收场）：无产物，立即干净收场
            deliver({ uri: null });
        }
    });
}

/**
 * 音频硬件停录（5s 护栏 + 迟到产物抢救）：expo-audio stop 在设备异常下可能
 * 挂死——超时强制收场（错误上浮与相位释放由调用方统一完成），晚于护栏
 * resolve 的产物若已生成仍尽力入库。
 */
async function stopAudioHardwareWithGuard(
    stop: () => Promise<CaptureHardwareProduct>,
    owner: CaptureOwner,
): Promise<CaptureHardwareProduct> {
    let timedOut = false;
    // 立即执行包装：同步抛错归一为 rejected promise（race 与迟到链统一语义）
    const stopPromise = (async () => stop())();
    void stopPromise
        .then((late) => {
            if (!timedOut) return;
            // 护栏已强制收场：迟到产物尽力入库（不触碰会话状态；成功静默，失败上浮）
            if ('error' in late) {
                surfaceSessionError('录音停止超时，素材未能保存。');
                return;
            }
            if (late.uri) {
                void salvageLateProduct({
                    owner,
                    kind: 'audio',
                    uri: late.uri,
                    durationMs: late.durationMs,
                    timeoutNoun: '录音停止超时',
                });
            }
        })
        .catch(() => undefined); // 护栏后的迟到失败：素材本就不确定，丢弃不打扰
    let guardTimer: ReturnType<typeof setTimeout> | null = null;
    try {
        return await Promise.race([
            stopPromise,
            new Promise<CaptureHardwareProduct>((resolve) => {
                guardTimer = setTimeout(() => {
                    timedOut = true;
                    resolve({ error: '录音停止超时，素材可能未保存。' });
                }, STOP_RESOLVE_TIMEOUT_MS);
            }),
        ]);
    } finally {
        // 竞速清理：停录先完成时撤掉护栏（迟到触发只是置位无消费者，属卫生问题）
        if (guardTimer) clearTimeout(guardTimer);
    }
}

/**
 * 媒体落库核心（不含会话状态写入）：attach 媒体行（按 owner.kind 分派
 * journal/event 双侧）→ persist 事件（owner 屏先本地合并）→ DB 级块追加
 * （归属落库）。停录/拍照产物与迟到抢救共用；attach/append 失败文案由 store
 * 上浮（store.error），本层不重复覆盖。taskId/onProgress 透传（进度注册表 +
 * 护栏活跃度跟踪；抢救路径可缺省）。
 */
async function persistMediaToOwner(input: {
    owner: CaptureOwner;
    sessionKind: CaptureKind;
    mediaKind: JournalMediaKind;
    uri: string;
    width: number | null;
    height: number | null;
    durationMs?: number;
    taskId?: string;
    onProgress?: () => void;
}): Promise<CaptureStopOutcome> {
    const owner = input.owner;
    // 媒体行落库按归属分派：journal 走 attachJournalMedia（taskId/moveSource/
    // onProgress 全量 opts）；event 走 attachEventMedia（v6.1 补齐同款 opts）。
    // 录像/录音产物 = cache 临时件 → move 直迁（原件移走零残留）；拍照产物为
    // image，不走 move 分支（相册兜底通道已删，纯化轮）
    const attachOpts = {
        taskId: input.taskId,
        moveSource: true,
        onProgress: input.onProgress,
    };
    const mediaId =
        owner.kind === 'journal'
            ? await useArchiveStore
                  .getState()
                  .attachJournalMedia(owner.id, input.mediaKind, input.uri, input.width, input.height, attachOpts)
            : await useArchiveStore
                  .getState()
                  .attachEventMedia(owner.id, input.mediaKind, input.uri, input.width, input.height, input.durationMs ?? null, attachOpts);
    if (!mediaId) {
        // attach 失败文案已由 store 上浮（store.error）；素材弃置 cache 由系统清理
        return { ok: false, message: '媒体上传失败，素材未能保存。' };
    }
    // 先本地合并（owner 屏）、后 DB 追加：此后屏幕保存快照必含媒体块（头注口径）
    emitPersist({
        owner,
        // 兼容投影：journal 归属 = 笔记 id，事件归属 = null（旧消费点判定天然 false）
        ownerJournalId: ownerJournalIdCompat(owner),
        mediaId,
        kind: input.mediaKind,
        durationMs: input.durationMs,
    });
    // DB 级块追加按归属分派（双侧同为 DB 权威读-改-写 + 幂等 + revision bump）
    const appended =
        owner.kind === 'journal'
            ? await useArchiveStore.getState().appendMediaBlockToJournal(owner.id, {
                  mediaId,
                  kind: input.mediaKind,
                  durationMs: input.durationMs,
              })
            : await useArchiveStore.getState().appendMediaBlockToEvent(owner.id, {
                  mediaId,
                  kind: input.mediaKind,
                  durationMs: input.durationMs,
              });
    return appended
        ? { ok: true, owner, kind: input.sessionKind }
        : { ok: false, message: '素材已上传，但媒体块落库失败，请重新保存记录。' };
}

/**
 * 迟到产物抢救入库（护栏超时后素材才落地）：按原归属走落库核心，**不触碰
 * 会话状态**（会话已被护栏收场，槽位可能被新会话占用）；成功静默（2026-11-09
 * 用户口径：「已补充保存」不再写横幅——素材出现在笔记即反馈），失败横幅明确
 * 反馈（store 已给出更具体的失败文案时不覆盖）。
 */
async function salvageLateProduct(input: {
    owner: CaptureOwner;
    kind: CaptureKind;
    uri: string;
    durationMs?: number;
    timeoutNoun: string;
}): Promise<void> {
    const errorBefore = useArchiveStore.getState().error;
    const outcome = await persistMediaToOwner({
        owner: input.owner,
        sessionKind: input.kind,
        mediaKind: input.kind,
        uri: input.uri,
        width: null,
        height: null,
        durationMs: input.durationMs,
    });
    // 成功静默（2026-11-09 用户口径）：媒体块出现在笔记即反馈，不再写横幅；
    // 失败仍保留红字（store 侧已有更具体文案时不覆盖）
    if (outcome.ok) return;
    if (useArchiveStore.getState().error === errorBefore) {
        surfaceSessionError(`${input.timeoutNoun}，素材未能保存。`);
    }
}

/* ------------------------------------------------------------------ */
/* 后台落库任务注册表（会话级独立注册，口径对齐编辑页 pendingUploadsRef） */
/* ------------------------------------------------------------------ */

/**
 * 停止/拍照产物的落库一律后台化（用户口径：关窗即返回，保存自动
 * 完成）：任务注册进本进程内注册表（Map，任务收敛自摘除——与编辑页
 * pendingUploadsRef 同构。不复用其实例：那是屏组件内部的 useRef，会话层是
 * 跨页面根层级宿主，无法触达屏内注册表，取舍见报告）。「完成收笔」经
 * stopCaptureSession（persisting 相位分支 / 停止路径尾部）对同归属任务
 * allSettled，等待口径与屏内上传一致。任务本体不触碰会话状态（幂等闸由
 * 收尾协调器的 token 比对承担）。
 */
interface BackgroundPersistTask {
    owner: CaptureOwner;
    promise: Promise<CaptureStopOutcome>;
}

const backgroundPersists = new Map<number, BackgroundPersistTask>();
let backgroundPersistSeq = 0;

/** 会话落库任务在进度注册表里的 key 前缀（store.aggregateSaveProgress 聚合
 *  「保存中 N%」横幅用）；序号段与编辑器 pending 占位 id 空间隔离。 */
const CAPTURE_PROGRESS_PREFIX = 'capture:';

/** 同归属后台落库是否仍有在途任务（收尾协调的终结条件之一）。 */
function hasInflightPersists(owner: CaptureOwner): boolean {
    for (const task of backgroundPersists.values()) {
        if (task.owner.kind === owner.kind && task.owner.id === owner.id) return true;
    }
    return false;
}

/**
 * 等待同归属后台落库全部收敛（allSettled——单任务失败互不影响）：任一失败
 * 即回传该失败结果（收笔链据此中止，避免丢产物封存笔记）；全部成功回传
 * ok。任务 promise 已在注册处 catch 归一，rejected 分支纯防御。
 */
async function waitForOwnerPersists(
    owner: CaptureOwner,
    kind: CaptureKind,
): Promise<CaptureStopOutcome> {
    const tasks = Array.from(backgroundPersists.values()).filter(
        (task) => task.owner.kind === owner.kind && task.owner.id === owner.id,
    );
    if (tasks.length === 0) return { ok: true, owner, kind };
    const results = await Promise.allSettled(tasks.map((task) => task.promise));
    for (const result of results) {
        const outcome =
            result.status === 'fulfilled'
                ? result.value
                : { ok: false as const, message: toMessage(result.reason) };
        if (!outcome.ok) return outcome;
    }
    return { ok: true, owner, kind };
}

/**
 * 注册后台落库任务（不等待——返回任务 promise 供收笔链按需 await）：落库
 * 核心 + 无进度增量护栏（见 PERSIST_STALL_TIMEOUT_MS 注——挂死兜底：先给
 * 「保存超时」口径收场任务，底层链继续跑）+ 进度注册
 * （taskId 进 store.mediaUploadProgress，会话保存横幅按 capture: 前缀聚合
 * 百分比）+ 结果反馈（成功静默——媒体块出现在笔记即反馈，2026-11-09 用户
 * 口径；失败 = 保存失败文案，store 侧 attach/append 已给出更具体错误时不
 * 覆盖）。任务收敛自摘除并触发 UI 收尾协调（tryCloseUiSession）。
 */
function persistCaptureProduct(
    input: {
        owner: CaptureOwner;
        sessionKind: CaptureKind;
        mediaKind: JournalMediaKind;
        uri: string;
        width: number | null;
        height: number | null;
        durationMs?: number;
    },
    sessionToken: number | null,
): Promise<CaptureStopOutcome> {
    const taskId = ++backgroundPersistSeq;
    const progressTaskId = `${CAPTURE_PROGRESS_PREFIX}${taskId}`;
    const errorBefore = useArchiveStore.getState().error;
    const promise = (async (): Promise<CaptureStopOutcome> => {
        // 无进度增量护栏：活跃时刻 = 任务起点 / 最近一次进度拍；巡检周期轮询，
        // 连续 PERSIST_STALL_TIMEOUT_MS 无拍点才判超时（web 大文件流式落盘
        // 合法耗时可达分钟级，固定总时长护栏会误杀健康慢任务）
        let lastProgressAt = Date.now();
        let stallPoll: ReturnType<typeof setInterval> | null = null;
        try {
            const underlying = persistMediaToOwner({
                ...input,
                taskId: progressTaskId,
                onProgress: () => {
                    lastProgressAt = Date.now();
                },
            });
            const raced = await Promise.race([
                underlying,
                new Promise<'timeout'>((resolve) => {
                    stallPoll = setInterval(() => {
                        if (Date.now() - lastProgressAt > PERSIST_STALL_TIMEOUT_MS) {
                            resolve('timeout');
                        }
                    }, PERSIST_STALL_POLL_MS);
                }),
            ]);
            if (raced === 'timeout') {
                surfaceSessionError('素材保存超时，仍在后台继续保存，请稍后在笔记中确认。');
                // 护栏后的孤儿链：仍可能成功落库——成功静默（媒体块出现在笔记
                // 即反馈，2026-11-09 用户口径），失败由 store 侧 attach/append
                // 文案上浮；仅防 unhandled rejection
                void underlying.catch(() => undefined);
                return { ok: false, message: '素材保存超时，请稍后在笔记中确认。' };
            }
            // 成功静默（2026-11-09 用户口径）：不再写「已保存到笔记」系横幅，
            // 媒体块出现即反馈；失败横幅保留（store 侧 attach/append 已给出
            // 更具体文案时不覆盖）
            if (!raced.ok && useArchiveStore.getState().error === errorBefore) {
                surfaceSessionError(raced.message || '保存失败');
            }
            return raced;
        } finally {
            // 竞速清理：落库先完成（或失败）时撤掉巡检（迟到触发不再弹假超时）
            if (stallPoll) clearInterval(stallPoll);
        }
    })()
        .catch((caught) => ({ ok: false as const, message: `保存失败：${toMessage(caught)}` }))
        .finally(() => {
            // 任务收敛即自摘除（pendingUploadsRef 口径）+ 触发 UI 收尾协调
            backgroundPersists.delete(taskId);
            tryCloseUiSession();
        });
    backgroundPersists.set(taskId, { owner: input.owner, promise });
    return promise;
}

/* ------------------------------------------------------------------ */
/* UI 会话收尾协调（淡出缓冲 × 后台任务收敛，双条件才终结）               */
/* ------------------------------------------------------------------ */

interface UiSessionClose {
    owner: CaptureOwner;
    /** 发起收尾的代会话令牌（startedAt）：被新会话顶替/终结即作废。 */
    sessionToken: number;
    /** 终结时写入会话状态的错误（失败收场口径；null = 干净收场）。 */
    endError: string | null;
    fadeDone: boolean;
    timer: ReturnType<typeof setTimeout>;
}

let uiSessionClose: UiSessionClose | null = null;

/**
 * 调度 UI 会话收尾（**必须在硬件停录段完成、产物去向已定之后调用**——录像
 * 产品的 CameraView 必须存活到产物回流，绝不能提前）：等卡片淡出落地后，
 * 若同归属后台落库仍在跑则转入 persisting 相位（UI 已全部消失、允许立即开
 * 新会话），否则直接终结会话。淡出期间会话保持 stopping（重入/新会话闸
 * 照常），落库任务注册不等缓冲（立即开始）。
 */
function scheduleUiSessionClose(
    owner: CaptureOwner,
    sessionToken: number,
    endError: string | null,
): void {
    cancelUiSessionClose(); // 单例：同代会话重复调度幂等
    const close: UiSessionClose = {
        owner,
        sessionToken,
        endError,
        fadeDone: false,
        timer: setTimeout(() => {
            if (uiSessionClose !== close) return;
            close.fadeDone = true;
            tryCloseUiSession();
        }, UI_CLOSE_FADE_MS),
    };
    uiSessionClose = close;
}

function cancelUiSessionClose(): void {
    if (!uiSessionClose) return;
    if (uiSessionClose.timer) clearTimeout(uiSessionClose.timer);
    uiSessionClose = null;
}

/**
 * 收尾尝试（三条件才终结：淡出完成 + 同归属任务全部收敛 + 仍是本代会话）。
 * 时机入口两处：淡出计时器到点 / 落库任务收敛（finally），谁后到谁触发判定。
 */
function tryCloseUiSession(): void {
    const close = uiSessionClose;
    if (!close || !close.fadeDone) return;
    const state = useRecordingSessionStore.getState();
    if (state.startedAt !== close.sessionToken) {
        // 会话已被新会话顶替/终结：本代收尾作废（新会话自行管理生命周期）
        cancelUiSessionClose();
        return;
    }
    if (hasInflightPersists(close.owner)) {
        // 落库仍在后台：UI 已随淡出消失，会话转 persisting（仅 stopping 可
        // 进——preparing/recording 说明已被新会话顶替，绝不误伤）
        if (state.phase === 'stopping') enterPersistingPhase();
        return;
    }
    cancelUiSessionClose();
    endCaptureSession(close.endError);
}

/** 停止路径失败收场：文案上浮 + UI 会话按淡出缓冲终结（卡片不瞬移，横幅即反馈）。 */
function failStopSession(message: string, owner: CaptureOwner, sessionToken: number): void {
    surfaceSessionError(message);
    scheduleUiSessionClose(owner, sessionToken, message);
}

/**
 * 停止会话（两段式：硬件停录 → UI 终结 → 落库后台化）：硬件停录段（会话级
 * 句柄，不依赖覆盖层挂载状态——最小化保活槽态同样可达；5s 护栏）完成即终结
 * UI 会话（卡片淡出关闭、chip 消失，无 spinner 停留）；有产物时落库立即转
 * 后台任务注册表（30s 无进度增量护栏），收敛时成功静默、失败文案上浮。后台落库期间新会话可立即
 * 发起。返回 promise 在**同归属全部后台落库收敛后**才 resolve（收笔链据此
 * 判定中止并保证不丢块；快门路径 void 调用不受影响）。
 */
export async function stopCaptureSession(): Promise<CaptureStopOutcome> {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || !state.owner || state.startedAt == null) {
        return { ok: false, message: '当前没有进行中的录制会话。' };
    }
    const kind = state.kind;
    const owner = state.owner;
    const startedAt = state.startedAt;
    if (state.phase === 'persisting') {
        // 落库后台期的停止（「停后立即收笔」的路径）：硬件已无可停——等待
        // 该归属的全部后台落库任务收敛并回传聚合结果（persist 事件/
        // DB 追加既有链在任务内完成，等待保证收笔保存必带媒体块）
        return waitForOwnerPersists(owner, kind);
    }
    if (state.phase === 'stopping') {
        // 可见反馈（不静默）：硬件停录在途且有界（5s 护栏），拒绝重入
        surfaceSessionError('正在停止录制，请稍候。');
        return { ok: false, message: '正在停止录制，请稍候。' };
    }
    const audioStop = kind === 'audio' ? captureHardware.audio?.stop : undefined;
    const videoStopRecording = kind === 'video' ? captureHardware.video?.stopRecording : undefined;
    if (kind === 'audio' ? !audioStop : !videoStopRecording) {
        failSession('录制控制器不可用，会话已结束。');
        return { ok: false, message: '录制控制器不可用，会话已结束。' };
    }
    useRecordingSessionStore.setState({ phase: 'stopping' });
    let product: CaptureHardwareProduct;
    // 是否真有录制在停：视频取句柄同步回执（原生事实，胜过相位——自发性
    // 失败后相位可能僵尸 recording）；音频取相位（控制器内部另有未开录分流）
    let wasRecording = state.phase === 'recording';
    try {
        if (kind === 'video' && videoStopRecording) {
            // 会话级停录：等待槽先挂 → 句柄触发原生停录（覆盖层只是句柄宿主）
            const stopped = await stopVideoHardwareWithGuard(
                videoStopRecording,
                startedAt,
                owner,
            );
            product = stopped.product;
            wasRecording = stopped.wasRecording;
        } else if (kind === 'audio' && audioStop) {
            product = await stopAudioHardwareWithGuard(audioStop, owner);
        } else {
            // 不可达（上方已闸）：防御性收场，不让任何路径滞留 stopping
            failSession('录制控制器不可用，会话已结束。');
            return { ok: false, message: '录制控制器不可用，会话已结束。' };
        }
    } catch (caught) {
        const message = `停止录制失败：${toMessage(caught)}`;
        failStopSession(message, owner, startedAt);
        return { ok: false, message };
    }
    if ('error' in product) {
        failStopSession(product.error, owner, startedAt);
        return { ok: false, message: product.error };
    }
    if (!product.uri) {
        if (wasRecording) {
            failStopSession('录制未能生成文件，素材没有保存。', owner, startedAt);
            return { ok: false, message: '录制未能生成文件，素材没有保存。' };
        }
        // 未真正开录（prepare/取景阶段被收场）：无产物、无落库义务、不阻塞
        // 调用方——按淡出缓冲终结
        scheduleUiSessionClose(owner, startedAt, null);
        return { ok: true, owner, kind };
    }
    // 有产物：落库立即转后台任务（不等淡出），UI 会话按淡出缓冲终结——
    // 用户口径「关窗即返回，保存自动完成」。收笔等同步链路需要真实落库
    // 结果判定中止：等待同归属全部后台任务收敛（allSettled）后回传。
    void persistCaptureProduct(
        {
            owner,
            sessionKind: kind,
            mediaKind: kind,
            uri: product.uri,
            // 硬件停录产物无尺寸（音频不适用；视频 recordAsync 不回尺寸——
            // 与旧屏层口径一致）；拍照产物走 handleCameraProduct（带尺寸）
            width: null,
            height: null,
            durationMs: product.durationMs,
        },
        startedAt,
    );
    scheduleUiSessionClose(owner, startedAt, null);
    return waitForOwnerPersists(owner, kind);
}

/** 取消会话（丢弃）：硬件停录丢弃，无落库义务；卡片同样走淡出关闭语言
 *  （stopping 相位驱动，与停止一致）；取消护栏兜底（挂死不滞留——丢弃路径
 *  尽力而为，硬件随控制器卸载释放）。 */
export async function cancelCaptureSession(): Promise<void> {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || isSessionSettling(state.phase)) return;
    const hardware = captureHardware[state.kind];
    const owner = state.owner;
    const startedAt = state.startedAt;
    useRecordingSessionStore.setState({ phase: 'stopping' });
    let cancelGuardTimer: ReturnType<typeof setTimeout> | null = null;
    try {
        await Promise.race([
            Promise.resolve(hardware?.cancel?.()),
            new Promise<void>((resolve) => {
                cancelGuardTimer = setTimeout(resolve, STOP_RESOLVE_TIMEOUT_MS);
            }),
        ]);
    } catch {
        // 取消路径尽力而为：停不掉的硬件随控制器卸载释放
    } finally {
        // 竞速清理：取消先完成时撤掉护栏
        if (cancelGuardTimer) clearTimeout(cancelGuardTimer);
    }
    // 丢弃收场按淡出缓冲终结（无任务在途，淡出落地即终结）；痕迹缺失时
    // 防御性立即终结
    if (owner && startedAt != null) {
        scheduleUiSessionClose(owner, startedAt, null);
    } else {
        endCaptureSession(null);
    }
}

/** 会话收场（相机视图内部已自行停录/无产物后的纯状态清理；收尾期忽略）。 */
export function clearCaptureSession(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || isSessionSettling(state.phase)) return;
    endCaptureSession(null);
}

/** 收起覆盖层（录音/录像继续后台执行，chip 承接）。 */
export function minimizeCaptureOverlay(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || isSessionSettling(state.phase)) return;
    state.setOverlayOpen(false);
}

/** 重开覆盖层（任意页面；会话状态一直在，重开零重启动；收尾期已无 UI 可重开）。 */
export function restoreCaptureOverlay(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || isSessionSettling(state.phase)) return;
    state.setOverlayOpen(true);
}

/** 开录回执（录音 prepare+record 完成 / 相机快门进入录制态）。 */
export function markCaptureRecording(): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || isSessionSettling(state.phase)) return;
    state.setPhase('recording');
}

/** 进度上收（录音 120ms / 录像 1s 节拍；收尾期忽略迟到 tick）。 */
export function tickCaptureProgress(elapsedSec: number, metering?: number): void {
    const state = useRecordingSessionStore.getState();
    if (!state.kind || isSessionSettling(state.phase)) return;
    state.tick(elapsedSec, metering);
}

/* ------------------------------------------------------------------ */
/* 相机硬件桥（CameraCaptureOverlay 经 props 登记，本模块持有引用）       */
/* ------------------------------------------------------------------ */

function registerCameraHardware(handlers: CameraCaptureHardware | null): void {
    setCaptureHardware('video', handlers);
}

/**
 * 相机视图产物入口（拍照即时产物 / 快门停录产物 / 外部停录产物——recordAsync
 * continuation 统一经 onProduct 回流）：按停止桥/归属落库分派。
 *
 * sessionToken（宿主渲染覆盖层时以闭包冻结的本代会话 startedAt）防串会话：
 * - 停录等待在途且同代 → 产物交回 stopCaptureSession 的等待槽（停止桥结算）；
 * - 抢救窗口在途且同代 → 护栏超时后的迟到产物尽力入库（素材已落盘）；
 * - 非同代（会话已终结/被新会话顶替）→ 明确丢弃提示，绝不误归属新会话；
 * - 同代且无停止在途 → 自发性产物（拍照/系统收尾）：先入 stopping（卡片
 *   淡出驱动），落库转后台任务注册表 + 收尾协调终结（与停止同口径）。
 */
function handleCameraProduct(capture: CameraCapture, sessionToken: number | null): void {
    const intake = videoStopIntake;
    if (intake && intake.sessionToken === sessionToken) {
        intake.deliver({ uri: capture.uri });
        return;
    }
    const salvage = videoSalvageIntake;
    if (salvage && salvage.sessionToken === sessionToken) {
        clearTimeout(salvage.timer);
        videoSalvageIntake = null;
        void salvageLateProduct({
            owner: salvage.owner,
            kind: 'video',
            uri: capture.uri,
            timeoutNoun: '录制停止超时',
        });
        return;
    }
    const state = useRecordingSessionStore.getState();
    if (
        state.kind !== 'video' ||
        state.startedAt !== sessionToken ||
        state.startedAt == null ||
        !state.owner
    ) {
        // 非当前会话的迟到产物：素材未入库，明确反馈（不静默）
        if (sessionToken != null) surfaceSessionError('迟到的录像素材未能保存。');
        return;
    }
    // 自发性产物（拍照即完成/系统收尾）：先入 stopping（卡片淡出驱动），落库
    // 立即转后台任务，UI 会话按淡出缓冲终结——与停止同口径（关窗即返回，
    // 成功静默、失败横幅在任务收敛时反馈）
    const owner = state.owner;
    const startedAt = state.startedAt;
    useRecordingSessionStore.setState({ phase: 'stopping' });
    void persistCaptureProduct(
        {
            owner,
            sessionKind: 'video',
            mediaKind: capture.kind,
            uri: capture.uri,
            width: capture.width,
            height: capture.height,
        },
        startedAt,
    );
    scheduleUiSessionClose(owner, startedAt, null);
}

/**
 * 录像链路异常回执（recordAsync reject，覆盖层上报）：停录等待在途 → 立即
 * 结算（错误上浮，护栏不必空转 5s）；否则把相位从 recording 退回 idle——
 * 自发性录像失败不留僵尸 recording 相位（chip/状态行口径），取景态可重试。
 */
function handleVideoRecordFailed(): void {
    const intake = videoStopIntake;
    if (intake) {
        intake.deliver({ error: '录制失败，素材没有保存。' });
        return;
    }
    const state = useRecordingSessionStore.getState();
    if (state.kind === 'video' && state.phase === 'recording') {
        state.setPhase('idle');
    }
}

/**
 * （相册导入兜底已删，2026-11-09 纯化轮）：用户口径「相机内只有纯拍照/视频」
 * ——权限拒绝态出口收敛为重试/系统设置，相册取材只走 + 菜单既有
 * library-image 行（屏层自有上传链，不经过相机），本模块不再持有兜底编排。
 */

/* ------------------------------------------------------------------ */
/* 录音控制器（原屏层 AudioRecordingSession 上收；hook 实例挂根层级）     */
/* ------------------------------------------------------------------ */

/**
 * 录音会话控制器（根层级挂载，录音无视图依赖全局成立）：持有 recorder 实例
 * 与 120ms 轮询状态，挂载即 prepare + record；覆盖层展开时渲染
 * RecordingOverlay（纯视图），收起时渲染 null（进度照常上收，chip 由宿主
 * 渲染）。停止/取消经全局编排（stopCaptureSession/cancelCaptureSession）→
 * 硬件句柄 → 落库后台化（编排层带 5s 停录护栏 + 30s 无增量落库护栏——stop 挂死
 * 也不滞留 stopping，迟到产物走抢救入库）：停止 = 卡片淡出关闭 + 落库后台
 * 自动完成（成功静默、失败上浮），本控制器在 persisting 相位随宿主卸载、录音机释放。
 *
 * 竞态防线（沿用旧口径）：prepare 未完成时停止钮禁用（Android MediaRecorder
 * 未 start 即 stop 产出无效文件）；stop/uri 读取全体 try 包裹（控制器在
 * stopping 阶段可能被会话终结卸载，recorder 随 hook release 后访问会抛——
 * 以最后一次轮询快照兜底）。
 */
function AudioCaptureController({ ownerHint }: { ownerHint: string | null }) {
    const overlayOpen = useRecordingSessionStore((s) => s.overlayOpen);
    // stopping 相位投影（硬件停录段在途）：驱动卡片淡出关闭 + 停止/取消钮
    // 触摸闸（无 spinner/在途文案——关窗即反馈，双护栏兜底下必有界）
    const stopping = useRecordingSessionStore((s) => s.phase) === 'stopping';
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
            stopping={stopping}
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
 *  tabBar 条带（49dp + 余量），避免压住 tab 导航。事件详情（/events/[id]）
 *  与事件表单同属无 tabBar 的编辑面，v6.1 录制归属泛化后一并按编辑器口径
 *  （/events 前缀整体命中，新建页也可承载最小化 chip）。 */
function chipBottomInset(pathname: string, bottomInset: number): number {
    const isEditorRoute =
        pathname === '/write' ||
        pathname.startsWith('/journal/') ||
        pathname.startsWith('/events/') ||
        /\/write(\/|$)/.test(pathname);
    return bottomInset + (isEditorRoute ? 32 : 96);
}

/**
 * 会话级保存横幅（2026-11-08 进度可视化）：persisting 相位的「保存中 N%」
 * 非交互胶囊——落库已后台化，横幅是后台任务的唯一可见存在（任意页面可见，
 * 与悬浮 chip 同位同语言；phase 回 idle（任务收敛）或进度注册表摘除即消失，
 * 不做退场动画）。百分比 = capture: 前缀任务的平均进度（100ms 节流帧，
 * store.aggregateSaveProgress）；web 无总量时任务不进注册表 → 横幅不出现
 * （诚实降级：无可靠总量不伪造百分比，任务结果反馈 = 媒体块出现在笔记
 * （成功静默）/失败横幅）。
 */
function PersistProgressChip({ bottomInset }: { bottomInset: number }) {
    const palette = usePalette();
    const progress = useArchiveStore((s) => s.mediaUploadProgress);
    const fraction = aggregateSaveProgress(progress, CAPTURE_PROGRESS_PREFIX);
    if (fraction == null) return null;
    return (
        <View
            pointerEvents="none"
            className="absolute left-6 z-20"
            style={{ bottom: bottomInset }}
        >
            <View
                className="h-9 flex-row items-center gap-2 rounded-full px-4"
                style={{ backgroundColor: palette.primaryBtn }}
                accessibilityLabel={`素材保存中，已完成 ${Math.round(fraction * 100)}%`}
            >
                <Text
                    className="text-[13px] font-medium"
                    style={{ color: palette.onPrimaryBtn, fontVariant: ['tabular-nums'] }}
                >
                    {`保存中 ${Math.round(fraction * 100)}%`}
                </Text>
            </View>
        </View>
    );
}

/**
 * 相机覆盖层挂载门控超时（ms）：insets 长时间未就绪的强制放行兜底——防极端
 * ROM/形态（insets 全零是合法上报值，如异形全屏设备）把相机永久锁死。该分支
 * 下挂载用的全零就是设备的真实口径而非陈旧值，挂载即正确。正常路径
 * （safe-area 指标随首个原生事件送达）下门控先于任何用户交互放行，兜底不触发。
 */
const INSETS_GATE_TIMEOUT_MS = 300;

/**
 * 全局录制会话宿主：根层级条件渲染三件套——录音控制器（hook 常驻）、拍摄
 * 会话（CameraView 常驻：展开 = 全屏取景卡 / 最小化 = 隐形保活槽，stop/cancel
 * 后随会话卸载）、收起态悬浮 chip（任意页面重开入口）。空闲（kind null）时
 * 渲染 null/空，零布局挤占、零监听成本；persisting（UI 会话已终结、落库在
 * 后台）采集 UI 整体不渲染（CameraView/录音机随卸载释放，产物已到手），仅
 * 保留「保存中 N%」会话级保存横幅（有 capture 进度在途才出现，见其注）。
 */
export function RecordingSessionHost() {
    const kind = useRecordingSessionStore((s) => s.kind);
    const phase = useRecordingSessionStore((s) => s.phase);
    const overlayOpen = useRecordingSessionStore((s) => s.overlayOpen);
    const cameraMode = useRecordingSessionStore((s) => s.cameraMode);
    const ownerLabel = useRecordingSessionStore((s) => s.ownerLabel);
    const elapsedSec = useRecordingSessionStore((s) => s.elapsedSec);
    // 会话令牌：产物回流闭包按渲染冻结本代 startedAt——停止桥/抢救槽/归属
    // 落库都只认同代产物，跨会话迟到产物绝不误归属（见 handleCameraProduct）
    const startedAt = useRecordingSessionStore((s) => s.startedAt);
    const insets = useSafeAreaInsets();
    const pathname = usePathname();

    /* 相机覆盖层门控挂载（首帧陈旧修复）：insets 未就绪（native 全零）时不
     * 挂载覆盖层/保活槽（渲染 null，会话状态零触碰），真 insets 经 context
     * 送达（宿主随 context 重渲）后才以正确几何一次性挂载——挂载即正确。
     *
     * 取证基础（2026-11-09 首帧陈旧排查）：
     * - 真机表现「相机 UI 首开不正确，切主题才正确」的机制 = 仓库已登记的
     *   Android 链路：colorScheme.set → AppCompatDelegate.setDefaultNightMode
     *   → Activity 重建 → React 树整体重挂（见 audio-player.tsx v3 主题注，
     *   RN 0.88 源码核实）——切主题是「重挂级修复」，等价冷重启；故修复姿态
     *   必须保证**首挂即正确**，而非指望后续重渲重算原生首帧结构。
     * - insets 传导链本身干净（本次逐点核实）：safe-area-context 5.11.1 的
     *   SafeAreaProvider 在 insets==null 时不渲染 children（SafeAreaContext
     *   .tsx:131），native 下 expo-router 不传 initialMetrics（ExpoRoot.js
     *   AppWrapper）——App 树不可能以全零挂载；宿主→覆盖层无 memo/ref 冻结，
     *   context 变化自动全链重渲。故本门控在正常路径零触发，属 belt-and-
     *   suspenders 防线：覆盖「首次 insets 上报即为全零、真值后到」的设备态，
     *   杜绝覆盖层以 0 几何挂进原生首帧。
     * - 门控窗口语义：窗口内覆盖层未挂载 → registerHardware 未执行（硬件
     *   句柄空缺），此窗口内外部 stop 会落「控制器不可用」收场；窗口有界
     *   （INSETS_GATE_TIMEOUT_MS 兜底 + 正常路径先于任何用户交互就绪），
     *   会话状态不受影响（begin 已落库，覆盖层只是延后一拍出现）。
     * - RecordingChip / PersistProgressChip 不参与门控：它们只在 phase
     *   recording/persisting（远晚于 insets 就绪）出现，bottomInset 仅作
     *   悬挂偏移，无首帧几何风险。 */
    const insetsReady =
        Platform.OS === 'web' ||
        insets.top > 0 ||
        insets.bottom > 0 ||
        insets.left > 0 ||
        insets.right > 0;
    // 强制放行闩（一次性）：门控窗口超时即放行并保持，后续会话直接以当前
    // 真实口径挂载（全零设备上全零就是正确值；不重置避免每会话重复等待）
    const [gateTimedOut, setGateTimedOut] = useState(false);
    useEffect(() => {
        if (insetsReady || kind !== 'video' || phase === 'persisting') return;
        const timer = setTimeout(() => setGateTimedOut(true), INSETS_GATE_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [insetsReady, kind, phase]);
    // 门控窗口内不渲染相机覆盖层（含隐形保活槽——同一组件承载两种几何）
    const captureOverlayMountOpen = insetsReady || gateTimedOut;

    if (!kind) return null;
    // persisting = UI 会话已终结（后台落库中）：采集 UI 全部不渲染（零 UI、
    // 允许立即开新会话）；stopping = 淡出关闭中，覆盖层仍挂载（自驱动淡出）
    const captureUiAlive = phase !== 'persisting';

    return (
        <>
            {kind === 'audio' && captureUiAlive ? (
                <AudioCaptureController ownerHint={ownerLabel} />
            ) : null}
            {kind === 'video' && captureUiAlive && captureOverlayMountOpen ? (
                <CameraCaptureOverlay
                    initialMode={cameraMode}
                    minimized={!overlayOpen}
                    stopPending={phase === 'stopping'}
                    ownerHint={ownerLabel}
                    registerHardware={registerCameraHardware}
                    onRecordStart={markCaptureRecording}
                    onTick={tickCaptureProgress}
                    onProduct={(capture) => handleCameraProduct(capture, startedAt)}
                    onRecordFailed={handleVideoRecordFailed}
                    onStopRequest={() => void stopCaptureSession()}
                    onClosed={clearCaptureSession}
                    onMinimize={minimizeCaptureOverlay}
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
            {/* 会话级保存横幅（persisting 相位 + capture 进度在途）：「保存中 45%」
                ——后台落库的唯一可见存在，任务收敛即消失（见 PersistProgressChip 注）；
                与 RecordingChip 不同相位渲染，无同位共存窗口 */}
            {phase === 'persisting' ? (
                <PersistProgressChip bottomInset={chipBottomInset(pathname, insets.bottom)} />
            ) : null}
        </>
    );
}
