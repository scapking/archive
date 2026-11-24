import type { JournalRow, PlanStatus } from './db';

/**
 * 计划纯逻辑（R8，v11 计划状态机 + 建页向导）：状态派生与展示文案、
 * /plan/new 分步向导的字段词表与步进状态机。对齐 event-logic /
 * event-form-screen 的交互解剖（一次一个字段、「直接创建」随时可用已填内容、
 * 标题必填门槛、终态离堆）——**逻辑复制而非调用事件代码**：事件字段集
 * （GPS/处理人/对象/手机号/邮箱）与计划（标题/描述）不同，强行共用会产生
 * 第二套参数化表单；本模块是 plan 域内的同款实现（AGENTS.md「不能抽就照
 * 事件模式在域内实现」口径，步进动画壳 StepPane 同理由屏层持有）。
 *
 * 运行时零依赖：只 type-only import './db'（node --test 直接 import 本文件，
 * 上限常量等运行时值留在 store / 屏层取 journal-logic——防把 db/index 的
 * expo 依赖拖进测试链）。
 *
 * 状态事实源：journals.status 列（kind='note' 行），值域 open/closed/failed
 * （v11，schema.ts 注）。「完成」沿用 'closed' 与 2026-11-19 存量已完成计划
 * 兼容，语义对应事件的 done。
 */

export type { PlanStatus } from './db';

// ─── 状态（open | closed | failed）：派生与展示文案 ──────────────────────────

/** 状态展示文案（对齐事件口径 EVENT_STATUS_LABELS：进行中 / 已完成 / 已失败）。 */
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
    open: '进行中',
    closed: '已完成',
    failed: '已失败',
};

export function planStatusLabel(status: PlanStatus): string {
    return PLAN_STATUS_LABELS[status];
}

/** 是否已完成（'closed' 字面量比较的唯一入口，对齐 isEventDone 纪律）。 */
export function isPlanDone(row: Pick<JournalRow, 'status'>): boolean {
    return row.status === 'closed';
}

/** 是否已失败（'failed' 字面量比较的唯一入口，对齐 isEventFailed 纪律）。 */
export function isPlanFailed(row: Pick<JournalRow, 'status'>): boolean {
    return row.status === 'failed';
}

/** 是否进行中（在堆口径的正面判定；首页 deck 与 /plans 计划堆只显此档）。 */
export function isPlanOpen(row: Pick<JournalRow, 'status'>): boolean {
    return row.status === 'open';
}

/**
 * 是否已离堆（终态 = 完成/失败，对齐事件终态口径）：终态计划离开首页 deck
 * 与计划堆，仅搜索可见（「历史在搜索」用户指令延续）。排序不做终态沉底——
 * 堆只收 open，无需再排。
 */
export function planLeavesPile(status: PlanStatus): boolean {
    return status !== 'open';
}

/** 状态枚举守卫（store 落库前防脏值 + UI 读旧数据兜底；同 isEventStatus 形）。 */
export function isPlanStatus(value: unknown): value is PlanStatus {
    return value === 'open' || value === 'closed' || value === 'failed';
}

// ─── 建页向导（/plan/new 分步揭示，节奏照抄事件向导）─────────────────────────

/**
 * 计划表单字段顺序（一次只揭示一个）：标题 → 描述。事件向导的其余步骤
 * （位置/处理人/对象/手机号/邮箱）是事件专属字段集，计划无工单语义，
 * 不照搬——刻意不对齐项，见交付报告对照表。
 */
export const PLAN_FORM_STEPS = ['title', 'description'] as const;

export type PlanFormStep = (typeof PLAN_FORM_STEPS)[number];

/** 分步总数（步骤指示「X / 2」的分母，与事件「X / 7」、deck 页码同语言）。 */
export const PLAN_FORM_STEP_TOTAL = PLAN_FORM_STEPS.length;

/** 步进字段题（字段上方 13px 小标，对应事件向导「标题/位置/…」行）。 */
export const PLAN_FORM_STEP_LABELS: Record<PlanFormStep, string> = {
    title: '标题',
    description: '描述',
};

/** 步序号 → 字段键（越界夹取到首/末步：状态竞态下渲染不越界、不崩）。 */
export function planFormStepAt(step: number): PlanFormStep {
    const clamped = Math.max(0, Math.min(PLAN_FORM_STEPS.length - 1, step));
    return PLAN_FORM_STEPS[clamped];
}

/** 标题是否可创建（「直接创建」/「继续填写」双钮的门槛，同事件 titleValid）。 */
export function planTitleValid(title: string): boolean {
    return title.trim().length > 0;
}

/** 是否最后一步（末步主钮文案从「继续填写」切「创建计划」，同事件节奏）。 */
export function isPlanFormLastStep(step: number): boolean {
    return step >= PLAN_FORM_STEPS.length - 1;
}

/**
 * 可否前进（下一步）：标题未填不得前进（创建门槛同源，事件 goNext 同款），
 * 末步不再前进（末步主钮即创建）。
 */
export function canAdvancePlanStep(step: number, titleValid: boolean): boolean {
    return titleValid && !isPlanFormLastStep(step);
}

/** 下一步序号（夹取到末步，事件 setStep(prev => min(prev+1, TOTAL-1)) 同款）。 */
export function advancePlanStep(step: number): number {
    return Math.min(step + 1, PLAN_FORM_STEPS.length - 1);
}

// ─── 表单 placeholder / 门槛文案（单一大厂风常量源，同 EVENT_*_PLACEHOLDER）──

export const PLAN_TITLE_PLACEHOLDER = '计划名称';
export const PLAN_DESCRIPTION_PLACEHOLDER = '计划描述';

/** 标题缺失的门槛文案（同事件「给事件起个名字」句式，store.createPlan 同源）。 */
export const PLAN_TITLE_REQUIRED_ERROR = '给计划起个名字';
