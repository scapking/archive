/**
 * 媒体堆叠有界预载调度（v0.5.2 用户令 6「图片以及视频堆叠每次切换都会刷新
 * 一下，改成预先加载但有上限，到上限后不再预载，但切换超过 50% 后重新预载」
 * 的纯调度面）。
 *
 * 本文件**禁止 import react / react-native / expo***：状态机全部纯函数化，
 * node 测试直接覆盖（tests/v052-journal-input.test.ts）；平台执行（expo-image
 * prefetch / blob 预热 / 隐藏 video 头字节）收口在 ui/use-file-url.ts 的
 * `prefetchDeckMedia`，分组比较（deckItemsEqual）也在此保持纯函数。
 *
 * ── 参数论证（写进注释，改常数必须过闸测试）──
 * - PREFETCH_LOOKAHEAD = 3：从当前位置沿「下一张」方向预热 3 张。理由：
 *   deck 静止态可见位 = 中卡 + 左右相纸（≤3 张同屏），转场提交前用户能
 *   到达的最远新卡 = 连滑 2~3 张的短爆发节奏（v0.4.6 实测 ~450ms/张），
 *   3 档窗口覆盖「滑到手停之前」的全部落点；再深则首屏批量 I/O 撞
 *   转场 raster 预算（v0.4.6 红线），收益递减。
 * - PREFETCH_SET_MAX = 6：已预载集合上限（防内存账）。6 = 2×窗口：从窗口
 *   起点到「过半重启」之间最多前进 ⌈total/2⌉ 张、每拍新增 ≤1 张，6 档
 *   对常见堆叠规模（2~12）足以撑到重启线；超过上限后**停止预载**（用户
 *   明令），直到索引越过 50% 触发窗口重启（清空集合、以新位置重开窗口）。
 * - 50% 重启线：`index >= Math.ceil(total / 2)`——total=9 时半程=5（4 不
 *   触发、5 恰好过半触发）；回退（index 变小）不触发重启；重启后集合清空
 *   重新累计（LRU 语义下旧条目由 urlCache 的引用计数 + 延迟撤销层回收，
 *   本层不再补 revoke，见 use-file-url 生命周期注）。
 */

/** 沿「下一张」方向的预载窗口深度（张）。 */
export const PREFETCH_LOOKAHEAD = 3;

/** 已预载位置集合上限（越线停载，等 50% 重启）。 */
export const PREFETCH_SET_MAX = 6;

/** 过半重启线（含）：index ≥ half 即触发窗口重启。total=1/2 的退化见下。 */
export function prefetchRestartLine(total: number): number {
    return Math.ceil(total / 2);
}

export type PrefetchWindow = {
    /** true = 本拍触发 50% 重启：调用方先清空集合，再以当前位重新记账。 */
    cleared: boolean;
    /** 需要新增预载的堆内位置（已按集合去重、受上限裁剪），沿前进方向排列。 */
    indices: number[];
};

/**
 * 下一拍预载窗口（纯函数，无副作用）：
 * - `index` 当前中卡位置（调用方已 clamp 到 [0, total-1]）；
 * - `total` 堆叠成员数；≤1 不构成堆叠 → 空窗口；
 * - `prefetched` 已预载位置集合（插入序，含当前位置的「已见即已热」记账）；
 * - 越过半程线（`index >= ceil(total/2)`）→ cleared=true，集合清零后以
 *   新位置为窗口起点重新预载；回退不过半不重启；
 * - 未重启且集合已满（≥ PREFETCH_SET_MAX）→ 不再预载（返回空窗口）。
 */
export function nextPrefetchWindow(
    index: number,
    total: number,
    prefetched: readonly number[],
): PrefetchWindow {
    if (total <= 1) return { cleared: false, indices: [] };
    const clamped = Math.min(Math.max(index, 0), total - 1);
    const cleared = clamped >= prefetchRestartLine(total);
    // 重启拍视同空集合：当前位置 + 前瞻窗口全部重记
    const done = new Set(cleared ? [] : prefetched);
    const indices: number[] = [];
    // 未重启时先扣预算：集合越满可加名额越少（到上限即 0 → 停载）
    const budget = PREFETCH_SET_MAX - (cleared ? 0 : Math.min(prefetched.length, PREFETCH_SET_MAX));
    for (let step = 0; step <= PREFETCH_LOOKAHEAD && indices.length < budget; step++) {
        // step=0 = 当前位置：重启拍把「当前卡」记进集合（它正在屏上，天然是
        // 已热集合的一员，不记账会让下一拍的预算虚高）；未重启拍它通常已在
        // 集合里（上一拍的前瞻命中或已见记账），此处去重跳过
        const position = (clamped + step) % total;
        if (done.has(position)) continue;
        done.add(position);
        indices.push(position);
    }
    return { cleared, indices };
}

/**
 * deck 渲染单元浅比较（memo 相等器，纯函数）：两次 buildRenderUnits 产物的
 * 「内容等价」判定——单元数量一致，且每个 item 的 block 引用、media 引用、
 * 全局 index、deckKind 逐项相等即视为同一组。buildRenderUnits 对未变更的块
 * 透传原对象引用（journal-logic 的纯函数更新只换代被改块），所以文本块的
 * 每次防抖提交都不会击穿这里的相等——deck（图片/视频堆叠）在文字编辑期间
 * 零重渲、零换图，「切堆叠时画面被重刷」的重渲源之一就此断掉。
 */
export function deckItemsEqual(
    a: readonly { block: unknown; media: unknown; index: number; deckKind: string }[],
    b: readonly { block: unknown; media: unknown; index: number; deckKind: string }[],
): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x.block !== y.block || x.media !== y.media || x.index !== y.index || x.deckKind !== y.deckKind) {
            return false;
        }
    }
    return true;
}
