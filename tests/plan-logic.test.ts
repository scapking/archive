import assert from 'node:assert/strict';
import test from 'node:test';
import {
    advancePlanStep,
    canAdvancePlanStep,
    isPlanDone,
    isPlanFailed,
    isPlanFormLastStep,
    isPlanOpen,
    isPlanStatus,
    PLAN_FORM_STEP_TOTAL,
    PLAN_FORM_STEPS,
    PLAN_STATUS_LABELS,
    planFormStepAt,
    planLeavesPile,
    planStatusLabel,
    planTitleValid,
    PLAN_TITLE_REQUIRED_ERROR,
} from '../src/features/archive/plan-logic.ts';

/**
 * 计划纯逻辑单测（v11 状态机 + /plan/new 分步向导）。预期来自需求口径
 * （对齐事件：进行/完成/失败、终态离堆、标题必填门槛），不是实现复读。
 */

// ─── 状态机 ──────────────────────────────────────────────────────────────────

test('plan status vocabulary matches the event copy (进行/完成/失败)', () => {
    assert.deepEqual(PLAN_STATUS_LABELS, {
        open: '进行中',
        closed: '已完成',
        failed: '已失败',
    });
    assert.equal(planStatusLabel('open'), '进行中');
    assert.equal(planStatusLabel('closed'), '已完成');
    assert.equal(planStatusLabel('failed'), '已失败');
});

test('isPlanStatus accepts only the three legal values', () => {
    for (const status of ['open', 'closed', 'failed']) {
        assert.ok(isPlanStatus(status), `must accept ${status}`);
    }
    // 事件侧的 'done' 不是计划值域（完成落 'closed'，兼容存量「完成计划」行）；
    // 日记词表的收笔文案、空值、任意脏值同样拒绝
    for (const dirty of ['done', '已失败', '', null, undefined, 0, {}]) {
        assert.ok(!isPlanStatus(dirty), `must reject ${String(dirty)}`);
    }
});

test('state predicates partition the three states', () => {
    assert.ok(isPlanOpen({ status: 'open' }));
    assert.ok(!isPlanDone({ status: 'open' }) && !isPlanFailed({ status: 'open' }));
    assert.ok(isPlanDone({ status: 'closed' }));
    assert.ok(!isPlanOpen({ status: 'closed' }) && !isPlanFailed({ status: 'closed' }));
    assert.ok(isPlanFailed({ status: 'failed' }));
    assert.ok(!isPlanOpen({ status: 'failed' }) && !isPlanDone({ status: 'failed' }));
});

test('pile membership: only open stays, done/failed leave the pile', () => {
    // 对齐事件口径：完成/失败即离堆（首页 deck 与 /plans 计划堆只显进行中）
    assert.ok(!planLeavesPile('open'));
    assert.ok(planLeavesPile('closed'));
    assert.ok(planLeavesPile('failed'));
});

// ─── 建页向导步进 ────────────────────────────────────────────────────────────

test('wizard field order is title then description, one field at a time', () => {
    assert.deepEqual(PLAN_FORM_STEPS, ['title', 'description']);
    assert.equal(PLAN_FORM_STEP_TOTAL, PLAN_FORM_STEPS.length);
    assert.equal(planFormStepAt(0), 'title');
    assert.equal(planFormStepAt(1), 'description');
});

test('step index clamps out of range without throwing', () => {
    assert.equal(planFormStepAt(-3), 'title');
    assert.equal(planFormStepAt(99), 'description');
    assert.equal(advancePlanStep(99), PLAN_FORM_STEP_TOTAL - 1);
});

test('create gate: title is required for both actions', () => {
    // 空串/纯空白不可创建、不可前进（事件「给事件起个名字」同款门槛）
    assert.ok(!planTitleValid(''));
    assert.ok(!planTitleValid('   '));
    assert.ok(planTitleValid('买机票'));
    assert.ok(!canAdvancePlanStep(0, false));
    assert.ok(canAdvancePlanStep(0, true));
    assert.equal(PLAN_TITLE_REQUIRED_ERROR, '给计划起个名字');
});

test('advance reveals exactly one step and stops at the last', () => {
    assert.equal(advancePlanStep(0), 1);
    // 末步（描述）不再前进——末步主钮即创建（事件节奏照抄）
    assert.ok(isPlanFormLastStep(1));
    assert.ok(!canAdvancePlanStep(1, true));
    assert.equal(advancePlanStep(1), 1);
    assert.ok(!isPlanFormLastStep(0));
});
