import type { EventRow, EventStatus, EventSubjectKind } from './db';
// 运行时依赖只取同域纯函数（journal-logic，R8 允许域内纯函数互调）与 schema 常量；
// 禁止 import react / react-native / './db'（index 会拖入整个 SQL 出口）。
import { newParagraphBlock, parseBlocks, previewText, serializeBlocks, type JournalBlock } from './journal-logic';

/**
 * 事件纯逻辑（R8，v6 事件实体）：状态派生与展示文案、输入校验、对象（subject）
 * 词表与归一化、时间线文案、正文摘要。禁止 import react / react-native（可独立单测）。
 *
 * 时间线排序口径：事件列表/搜索统一 `updated_at DESC`（db.listEvents /
 * db.searchEvents 已按此排序）——「最近活动在前」，工单式条目按最近被处理的时间
 * 回看；本模块只负责 created/updated 的展示文案与「是否有过编辑」派生，不负责排序。
 * 终态口径（第四态 failed 加入后）：done/failed 同属终态，但排序不做终态沉底、
 * 仍按最近活动单一口径——工单列表展示的是「最近被处理」，不是按结果分箱。
 */

export type { EventRow, EventStatus, EventSubjectKind } from './db';

// ─── 状态（open | done | failed）：派生与展示文案 ───────────────────────────

/** 状态展示文案（需求口径：进行中 / 已完成 / 已失败）。 */
export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
    open: '进行中',
    done: '已完成',
    failed: '已失败',
};

export function eventStatusLabel(status: EventStatus): string {
    return EVENT_STATUS_LABELS[status];
}

/** 是否已完成（'done' 字面量比较的唯一入口，对齐 isTripOpenEnded 的纪律）。 */
export function isEventDone(row: Pick<EventRow, 'status'>): boolean {
    return row.status === 'done';
}

/** 是否已失败（'failed' 字面量比较的唯一入口，对齐 isEventDone 纪律）。 */
export function isEventFailed(row: Pick<EventRow, 'status'>): boolean {
    return row.status === 'failed';
}

/** 状态枚举守卫（store 落库前防脏值 + UI 读旧数据兜底）。 */
export function isEventStatus(value: unknown): value is EventStatus {
    return value === 'open' || value === 'done' || value === 'failed';
}

// ─── 对象（subject）：词表与展示映射 ────────────────────────────────────────

/** subject 类型词表（与 schema.EventSubjectKind 一一对应，展示顺序即词表顺序）。 */
export const EVENT_SUBJECT_KINDS = ['custom', 'phone', 'email', 'address', 'gps'] as const;

/** subject 类型展示文案：custom = 自由文本（展示仅值，label 空）；其余为历史
    词表兼容（旧数据既有 kind 仍按原文案显示）。 */
export const EVENT_SUBJECT_KIND_LABELS: Record<EventSubjectKind, string> = {
    custom: '',
    phone: '手机',
    email: '邮箱',
    address: '地址',
    gps: 'GPS',
};

export function eventSubjectKindLabel(kind: EventSubjectKind): string {
    return EVENT_SUBJECT_KIND_LABELS[kind];
}

/** subject 类型守卫（自由输入 / 旧数据防脏值）。 */
export function isEventSubjectKind(value: unknown): value is EventSubjectKind {
    return (EVENT_SUBJECT_KINDS as readonly unknown[]).includes(value);
}

/** 对象值长度上限（展示性元数据，截断优于让保存失败——对齐 normalizeJournalTitle 口径）。 */
export const EVENT_SUBJECT_VALUE_MAX = 200;

/** 归一化后的对象对：kind 与 value 成对出现，任一侧缺失即双双为 null（原子对）。 */
export interface EventSubject {
    kind: EventSubjectKind | null;
    value: string | null;
}

/**
 * 对象对归一化（所有写入口的单一清洗点）：trim 值、非法 kind 剥除、空值剥除；
 * 原子对约束——kind/value 任一侧无效，整个对置空（读侧不必防「有值无类型」）。
 */
export function normalizeEventSubject(
    kind: EventSubjectKind | null | undefined,
    value: string | null | undefined,
): EventSubject {
    const validKind = isEventSubjectKind(kind) ? kind : null;
    const trimmed = value?.trim() ?? '';
    if (validKind === null || trimmed.length === 0) return { kind: null, value: null };
    return { kind: validKind, value: trimmed.slice(0, EVENT_SUBJECT_VALUE_MAX) };
}

// ─── 可选文本字段归一化（处理人 / 短描述）────────────────────────────────────

/** 处理人（自由文本）长度上限。 */
export const EVENT_HANDLED_BY_MAX = 60;

/** 短描述长度上限（description 定位是摘要行，正文细节在 blocks）。 */
export const EVENT_DESCRIPTION_MAX = 200;

/** 手机号长度上限（自由文本口径：容纳国际区号 + 空格/横线排版）。 */
export const EVENT_PHONE_MAX = 40;

/** 邮箱长度上限。 */
export const EVENT_EMAIL_MAX = 120;

/**
 * 可选文本字段归一化：trim 后空串视为清除（返回 null）；超长钳制。
 * 对齐 normalizeJournalTitle 的「截断优于失败」口径（UI maxLength 只是第一道闸）。
 */
export function normalizeEventText(value: string | null | undefined, max: number): string | null {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, max);
}

/**
 * 邮箱归一化（写入口单一清洗点）：邮箱地址不含空白字符——本地自由文本哲学
 * 下不做格式校验拒绝，值内出现明显空白（手滑多敲的空格/换行）直接剥掉再走
 * normalizeEventText 口径（trim 兜底 + 长度钳制 + 空串清除）。手机号不走这里
 * （号码排版空格/横线是合法书写习惯，按原样入库）。
 */
export function normalizeEventEmail(value: string | null | undefined, max: number): string | null {
    return normalizeEventText(value?.replace(/\s+/g, ''), max);
}

// ─── GPS ────────────────────────────────────────────────────────────────────

/** 经纬度合法性（WGS-84 值域）：定位失败/未填允许无 GPS，但填了必须是真坐标。 */
export function isValidGpsCoordinate(lat: number, lng: number): boolean {
    return (
        Number.isFinite(lat) &&
        Number.isFinite(lng) &&
        lat >= -90 &&
        lat <= 90 &&
        lng >= -180 &&
        lng <= 180
    );
}

/** 定位精度（米）合法性：非负有限数；缺省/无效由调用方落 null。 */
export function isValidGpsAccuracy(accuracy: number | null | undefined): boolean {
    return accuracy == null || (Number.isFinite(accuracy) && accuracy >= 0);
}

// ─── 输入校验 ───────────────────────────────────────────────────────────────

export interface EventInput {
    title: string;
    /** GPS 注入不在 store：UI 层经 core/location 取好后传参（store 不取定位）。 */
    gps?: { lat: number; lng: number; accuracy?: number } | null;
    handledBy?: string;
    subjectKind?: EventSubjectKind;
    subjectValue?: string;
    /** 手机号（v7，可选独立联系方式；自由文本，不做格式校验）。 */
    phone?: string;
    /** 邮箱（v7，可选；值内明显空白由 normalizeEventEmail 在 store 剥除）。 */
    email?: string;
    description?: string;
}

/** 事件标题长度上限（输入框 maxLength 与此同源；validate 拒绝，不静默截断）。 */
export const EVENT_TITLE_MAX = 60;

/**
 * 建事件输入校验（title 必填非空，其余可选）：返回错误文案；null = 通过。
 * 对齐 validateTripInput 风格——错误文案直接进 store 的 error 通道展示。
 */
export function validateEventInput(input: EventInput): string | null {
    const title = input.title.trim();
    if (title.length === 0) return '给事件起个名字';
    if (title.length > EVENT_TITLE_MAX) return `事件名最多 ${EVENT_TITLE_MAX} 个字`;
    if (input.subjectKind !== undefined && input.subjectKind !== null && !isEventSubjectKind(input.subjectKind)) {
        return '对象类型不合法';
    }
    const hasKind = input.subjectKind != null;
    const hasValue = input.subjectValue != null && input.subjectValue.trim().length > 0;
    if (hasKind && !hasValue) return '对象值不能为空';
    if (!hasKind && hasValue) return '对象类型不能为空';
    if (input.gps && !isValidGpsCoordinate(input.gps.lat, input.gps.lng)) return 'GPS 经纬度不合法';
    if (input.gps && !isValidGpsAccuracy(input.gps.accuracy)) return '定位精度不合法';
    if (input.handledBy != null && input.handledBy.trim().length > EVENT_HANDLED_BY_MAX) {
        return `处理人最多 ${EVENT_HANDLED_BY_MAX} 个字`;
    }
    // 手机号/邮箱（v7，可选）：长度校验口径与入库归一化同源——手机号 trim 后
    // 计长、邮箱剥净空白后计长（邮箱地址本就不含空白）
    if (input.phone != null && input.phone.trim().length > EVENT_PHONE_MAX) {
        return `手机号最多 ${EVENT_PHONE_MAX} 个字`;
    }
    if (input.email != null && input.email.replace(/\s+/g, '').length > EVENT_EMAIL_MAX) {
        return `邮箱最多 ${EVENT_EMAIL_MAX} 个字`;
    }
    if (input.description != null && input.description.trim().length > EVENT_DESCRIPTION_MAX) {
        return `描述最多 ${EVENT_DESCRIPTION_MAX} 个字`;
    }
    return null;
}

// ─── 表单 placeholder（大厂风固定文案：一字段一条，可选字段「（选填）」后缀）──

/**
 * 事件表单 / 事件设置卡共用 placeholder 常量（单一常量源，禁止屏内散落字面量）：
 * 2026-11 收敛口径——随机话术池全删（useState 掷签一并移除），每字段固定一条；
 * 名词短语、≤8 字为主、可选字段统一「（选填）」后缀（Apple/Material 惯例），
 * 不写「留空清除 / 方便联系」类行为解释句（清空即清除的语义由 blur 保存
 * 交互自说明）。
 */
export const EVENT_TITLE_PLACEHOLDER = '事件名称';
export const EVENT_HANDLED_BY_PLACEHOLDER = '负责人（选填）';
export const EVENT_SUBJECT_PLACEHOLDER = '相关人员（选填）';
export const EVENT_PHONE_PLACEHOLDER = '手机号（选填）';
export const EVENT_EMAIL_PLACEHOLDER = '邮箱（选填）';
export const EVENT_DESCRIPTION_PLACEHOLDER = '补充说明（选填）';

// ─── /events 页头副标池（本轮保留：收敛范围是输入框描述，页头不在其列）───────

/** /events 页头副标池（事件/工单语义的轻文案，每次进页固定一条）。 */
export const EVENTS_HEADER_TAGLINES: readonly string[] = [
    '要跟的事，记成工单。',
    '挂着的事，别让它烂尾。',
    '办完一件，勾掉一件。',
    '办砸了也是结果，记下来。',
    '最近动过的，排在最前。',
];

/** 池内均匀随机取一条（纯函数；调用方负责「每挂载固定一次」纪律）。 */
export function pickEventCopy(pool: readonly string[]): string {
    return pool[Math.floor(Math.random() * pool.length)];
}

// ─── 正文块（复用 journal 块模型）───────────────────────────────────────────

/**
 * 新事件的正文初始化：单个空文本段（对齐 ensureJournal 的初始化口径——
 * 编辑器至少留一个可落笔段；serialize 后落 events.blocks 列）。
 */
export function newEventBlocks(): JournalBlock[] {
    return [newParagraphBlock()];
}

export function newEventBlocksJson(): string {
    return serializeBlocks(newEventBlocks());
}

/**
 * 正文摘要（复用 journal previewText 口径：文本段取前 N 字、媒体块 '[媒体]'
 * 占位）。入口吃 events.blocks 的 JSON 原串（坏 JSON → parseBlocks 降级空容器），
 * 供列表卡/搜索结果直接喂行数据。
 */
export function eventBlocksPreview(blocksJson: string, max = 80): string {
    return previewText(parseBlocks(blocksJson), max);
}

/** 正文媒体块计数（卡片角标）。 */
export function eventBlocksMediaCount(blocksJson: string): number {
    return parseBlocks(blocksJson).filter((block) => block.t === 'media').length;
}

// ─── 时间线（created / updated）文案 ────────────────────────────────────────

/** 编辑判定容差：updated_at 晚于 created_at ≥ 1 分钟才视为「有过编辑」（秒级抖动不报）。 */
export const EVENT_EDIT_TOLERANCE_MS = 60_000;

function pad2(n: number): string {
    return String(n).padStart(2, '0');
}

/**
 * epoch ms → 本地时区 'YYYY-MM-DD HH:mm'（日期归属用本地时间的域纪律，
 * 不走 toISOString 的 UTC 转换）。
 */
export function formatEventDateTime(epochMs: number): string {
    const d = new Date(epochMs);
    return (
        `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
        `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    );
}

export interface EventTimeline {
    /** 创建时间文案。 */
    createdText: string;
    /** 最后更新时间文案。 */
    updatedText: string;
    /** true = 有过编辑（UI 才展示 updatedText，未编辑过只展示创建时间）。 */
    edited: boolean;
}

/**
 * 事件时间线文案（created/updated 口径的单一实现）：排序在 db 层
 * （updated_at DESC），本函数只产出展示文案与编辑派生位。
 */
export function eventTimeline(row: Pick<EventRow, 'created_at' | 'updated_at'>): EventTimeline {
    return {
        createdText: formatEventDateTime(row.created_at),
        updatedText: formatEventDateTime(row.updated_at),
        edited: row.updated_at - row.created_at >= EVENT_EDIT_TOLERANCE_MS,
    };
}

// ─── 展示装饰（列表卡 / 详情头的单一装饰口径）──────────────────────────────

/** 装饰后的事件：查询结果恒为未删除行，故不含 deleted_at。 */
export type Event = Omit<EventRow, 'deleted_at'> & {
    statusLabel: string;
    /** subject 类型文案（未设置 = null）。 */
    subjectKindLabel: string | null;
    /** 正文摘要（journal previewText 口径）。 */
    preview: string;
    /** 正文媒体块数。 */
    mediaCount: number;
    /** 时间线文案（created/updated + 是否编辑过）。 */
    timeline: EventTimeline;
};

/** EventRow → 展示装饰（列表与搜索共用，避免两处漂移）。 */
export function decorateEvent(row: Omit<EventRow, 'deleted_at'>): Event {
    return {
        ...row,
        statusLabel: eventStatusLabel(row.status),
        subjectKindLabel: row.subject_kind ? eventSubjectKindLabel(row.subject_kind) : null,
        preview: eventBlocksPreview(row.blocks),
        mediaCount: eventBlocksMediaCount(row.blocks),
        timeline: eventTimeline(row),
    };
}
