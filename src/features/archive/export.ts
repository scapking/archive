import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { haptics } from '@/core/haptics';
import { print } from '@/core/print';
import { fileStorage, readUriBytes } from '@/core/file-storage';
import { createZip, readZip } from '@/core/migration';
import { sharing } from '@/core/sharing';
import * as db from './db';
import { decorateEvent, eventTimeline } from './event-logic';
import { parseBlocks, wordCount } from './journal-logic';
import { formatTripSpan, tripDisplayTitle } from './trip-logic';

/**
 * 数据导出/导入编排（M3）：三条交付链共用一次全量读取面——
 *
 * ① **备份 JSON**（轻量文本备份）：全量行 → JSON → 分享面板（媒体只含
 *    file_key 引用，二进制不内嵌）；
 * ② **全量备份 zip（设置页「导出备份」）**：manifest.json（全量行 JSON）+
 *    files/<mediaKey>（图片/视频/音频二进制原样打包，复用 core/migration 的
 *    zip 原语与条目名白名单/CRC32 校验）→ 分享面板。导入设备经「导入备份」
 *    选包自动恢复：媒体落回 file-storage（已存在的文件跳过——合并语义）+
 *    行在一个事务内 INSERT OR IGNORE（UUID 主键 / journals 同日唯一 / 日卡
 *    指针主键冲突跳过），导入后与既有数据无缝共存继续使用；
 *    - **内存口径（已知限制）**：zip 组包把媒体字节整体读进 JS（与
 *      migration.export 同款取舍）——超大媒体库（数百 MB 级视频）可能触发
 *      低内存杀进程；备份前请留意设备余量；
 *    - **传输面**：包经系统分享面板交付（AirDrop/网盘/IM 任选），导入侧用
 *      本页「导入备份」选文件恢复；**局域网设备直传依赖常驻 HTTP 服务，
 *      Expo Go 运行时无此能力，未实现**——同网络场景请用分享面板的
 *      局域网分享通道（如 AirDrop/局域网网盘）传递同一个 zip 包；
 * ③ **文稿 PDF**：native 走 core/print（HTML→PDF）；web 无打印实现，降级为
 *    HTML 文件下载（经 sharing 下载回退，mime 保真 .html 扩展名）；
 *
 * 失败语义：所有异常原样 throw——调用方（设置页）catch 后进 store.error 通道
 * （对齐 trip-detail 的背景设置失败口径）；成功静默（分享面板拉起即反馈，
 * 对齐「保存到手机」成功静默口径），成功时 haptics.success 终态确认。
 */

/** 分享中转目录名（cache 下，导出交付后随文件一并清理）。 */
const SHARE_STAGE_DIR = 'archive-export';

/**
 * 导出交付统一通道（2026-11-19 修复 Android「备份失败：Not allowed to read
 * file under given URL」）：file-storage 落盘目录（document/almightydb）不在
 * expo-sharing Android FileProvider 的可读白名单内，file:// 直分享被系统拒绝
 * ——native 统一先把字节写到 cache 中转目录（白名单覆盖 cacheDir）再分享，
 * 分享面板关闭后尽力清理中转；web 走 blob: URL（浏览器下载回退，不经
 * FileProvider）。PDF 的 printToFileAsync 产物本就在 cache，无需中转。
 */
async function shareExportBytes(
    bytes: Uint8Array,
    fileName: string,
    mimeType: string,
    dialogTitle: string,
): Promise<void> {
    if (Platform.OS === 'web') {
        if (!globalThis.Blob || !globalThis.URL?.createObjectURL) {
            throw new Error('当前环境不支持文件下载');
        }
        // Uint8Array<ArrayBufferLike> 与 BlobPart 的 ArrayBuffer 泛型不符（TS 6
        // 严格化）；运行时字节均来自 TextEncoder/createZip 的独立 ArrayBuffer，
        // 桥接 cast 安全
        const blobUrl = globalThis.URL.createObjectURL(
            new Blob([bytes as unknown as BlobPart], { type: mimeType }),
        );
        try {
            await sharing.shareAsync(blobUrl, { mimeType, dialogTitle });
        } finally {
            globalThis.URL.revokeObjectURL(blobUrl);
        }
        return;
    }
    const stage = new Directory(Paths.cache, SHARE_STAGE_DIR);
    stage.create({ idempotent: true, intermediates: true });
    const staged = new File(stage, fileName);
    staged.write(bytes);
    try {
        await sharing.shareAsync(staged.uri, { mimeType, dialogTitle });
        haptics.success();
    } finally {
        // 分享面板关闭（成功或取消）后清理中转：一次性交付物不常驻 cache；
        // delete 是同步 API（expo-file-system next），try/catch 收口——清理失败
        // 只浪费存储（console.warn 留痕不静默）
        try {
            staged.delete();
        } catch (error) {
            console.warn('[archive-export] 分享中转清理失败：', error);
        }
        try {
            stage.delete();
        } catch (error) {
            console.warn('[archive-export] 分享中转目录清理失败：', error);
        }
    }
}

/** 备份包内媒体二进制的前缀白名单（与 GC_MEDIA_PREFIXES 同源口径；导入只认这四个前缀，杜绝任意路径写入）。 */
const BACKUP_MEDIA_PREFIXES = ['journal-media/', 'trip-media/', 'trip-video/', 'event-media/'] as const;

/** 备份包媒体 key 校验：前缀白名单 + file-storage key 字符集（段内 [a-zA-Z0-9._-]，防路径穿越）。 */
const BACKUP_MEDIA_KEY_PATTERN = /^(journal-media|trip-media|trip-video|event-media)\/[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;

/** 媒体块的文稿占位（不区分 kind 的统一标记，与 previewText 的「[媒体]」同口径）。 */
const MEDIA_PLACEHOLDER = '[媒体]';

/** 行转义：块正文里的 `<`/`&` 等进 HTML 前统一转义（文稿渲染防注入面）。 */
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** 备份文件名时间戳：'20261117-193045'（本地时区，文件名友好）。 */
function exportTimestamp(): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = new Date();
    return (
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    );
}

/** 块 → 纯文本行（文稿用）：文本段直出，媒体段统一占位。 */
function blocksToPlainText(blocksJson: string): string[] {
    return parseBlocks(blocksJson).map((block) =>
        block.t === 'p' ? block.text : MEDIA_PLACEHOLDER,
    );
}

/** 全量行集（JSON 备份体）。 */
interface ExportPayload {
    meta: {
        app: 'archive';
        exportedAt: string;
        schemaVersion: 'v7';
        mediaEmbedded: false;
        /** 媒体文件寻址说明（备份工具据此在 file-storage 落盘目录找二进制）。 */
        mediaNote: string;
    };
    trips: db.TripRow[];
    journals: db.JournalRow[];
    journalMedia: db.JournalMediaRow[];
    dayPlans: db.DayPlanRow[];
    tripMedia: db.TripMediaRow[];
    tripDayMeta: db.TripDayMetaRow[];
    tripItems: db.TripItemRow[];
    events: db.EventRow[];
    eventMedia: db.EventMediaRow[];
}

/** 全量读取（JSON 与文稿共用同一读取面，口径不漂移）。 */
async function collectPayload(): Promise<ExportPayload> {
    const [
        trips,
        journals,
        journalMedia,
        dayPlans,
        tripMedia,
        tripDayMeta,
        tripItems,
        events,
        eventMedia,
    ] = await Promise.all([
        db.listTrips(),
        db.listAllJournals(),
        db.listAllJournalMediaForExport(),
        db.listAllDayPlansForExport(),
        db.listAllTripMediaForExport(),
        db.listAllTripDayMetaForExport(),
        db.listAllTripItemsForExport(),
        db.listAllEventsForExport(),
        db.listAllEventMediaForExport(),
    ]);
    return {
        meta: {
            app: 'archive',
            exportedAt: new Date().toISOString(),
            schemaVersion: 'v7',
            mediaEmbedded: false,
            mediaNote:
                '媒体二进制不内嵌：file_key 即 file-storage 落盘 key（journal-media/ trip-media/ trip-video/ event-media/ 前缀），完整二进制备份请用迁移包（migration 能力）。',
        },
        trips,
        journals,
        journalMedia,
        dayPlans,
        tripMedia,
        tripDayMeta,
        tripItems,
        events,
        eventMedia,
    };
}

/** JSON 备份：全量行 → 统一交付通道（native cache 中转 / web blob）分享。 */
export async function exportAllAsJson(): Promise<void> {
    const payload = await collectPayload();
    const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));
    await shareExportBytes(
        bytes,
        `archive-backup-${exportTimestamp()}.json`,
        'application/json',
        'Archive 备份（JSON）',
    );
}

/** 全量数据 → 文稿 HTML（native 转 PDF；web 直接下载同源 HTML）。 */
async function buildDocumentHtml(): Promise<string> {
    const payload = await collectPayload();
    const tripRows = payload.trips
        .map((trip) => {
            const lines = [
                `<h2>${escapeHtml(tripDisplayTitle(trip.title))}</h2>`,
                `<p class="meta">${escapeHtml(formatTripSpan(trip))}</p>`,
            ];
            if (trip.description.trim()) lines.push(`<p>${escapeHtml(trip.description)}</p>`);
            return lines.join('\n');
        })
        .join('\n');
    const journalRows = payload.journals
        .map((journal) => {
            const textLines = blocksToPlainText(journal.blocks)
                .filter((line) => line.trim() !== '')
                .map((line) => `<p>${escapeHtml(line)}</p>`)
                .join('\n');
            const head = journal.title ? escapeHtml(journal.title) : '未命名';
            const words = wordCount(parseBlocks(journal.blocks));
            return [
                `<h2>${head}</h2>`,
                `<p class="meta">${escapeHtml(journal.local_date)} · ${journal.trip_id ? '行程计划' : '日记'} · ${words} 字</p>`,
                textLines,
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n');
    const eventRows = payload.events
        .map((row) => {
            const event = decorateEvent(row);
            const textLines = blocksToPlainText(event.blocks)
                .filter((line) => line.trim() !== '')
                .map((line) => `<p>${escapeHtml(line)}</p>`)
                .join('\n');
            return [
                `<h2>${escapeHtml(event.title)}</h2>`,
                `<p class="meta">${escapeHtml(event.statusLabel)} · ${escapeHtml(eventTimeline(event).createdText)}</p>`,
                event.description ? `<p>${escapeHtml(event.description)}</p>` : '',
                textLines,
            ]
                .filter(Boolean)
                .join('\n');
        })
        .join('\n');

    return `<!doctype html>
<html><head><meta charset="utf-8" /><title>Archive 导出</title><style>
  body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; color: #1a1a1a; margin: 40px auto; max-width: 680px; line-height: 1.7; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 4px; }
  p { margin: 4px 0; font-size: 14px; white-space: pre-wrap; }
  p.meta { color: #8a8a8a; font-size: 12px; }
  hr { border: 0; border-top: 1px solid #e5e5e5; margin: 28px 0; }
</style></head><body>
<h1>Archive 导出</h1>
<p class="meta">${escapeHtml(new Date().toLocaleString())} · 全量文稿（媒体以占位标注，二进制见 JSON 备份）</p>
${tripRows ? `<hr />\n${tripRows}` : ''}
${journalRows ? `<hr />\n${journalRows}` : ''}
${eventRows ? `<hr />\n${eventRows}` : ''}
</body></html>`;
}

/** 文稿导出：native = HTML→PDF 分享；web = HTML 下载降级（print 能力无实现）。 */
export async function exportAllAsPdf(): Promise<void> {
    const html = await buildDocumentHtml();
    if (print.isSupported()) {
        const { uri } = await print.printToFileAsync(html);
        await sharing.shareAsync(uri, {
            mimeType: 'application/pdf',
            dialogTitle: 'Archive 文稿（PDF）',
        });
        haptics.success();
        return;
    }
    // web 降级：同统一交付通道（blob URL → 浏览器下载，mime 保真 .html 扩展名）
    await shareExportBytes(
        new TextEncoder().encode(html),
        `archive-document-${exportTimestamp()}.html`,
        'text/html',
        'Archive 文稿（网页版）',
    );
}

// ─── 全量备份（zip：行 + 媒体二进制）─────────────────────────────────────────

export interface FullBackupResult {
    /** 包文件名（分享面板展示用）。 */
    fileName: string;
    /** 打包的媒体文件数。 */
    mediaFiles: number;
}

/**
 * 全量备份导出：manifest.json（全量行 JSON）+ files/<mediaKey>（媒体二进制）
 * 组成单个 zip → 分享面板交付。包布局复用 core/migration 的条目名白名单
 * （manifest.json + files/<key>），导入端 readZip 的 zip-slip/CRC32 校验
 * 原样生效。
 */
export async function exportFullBackup(): Promise<FullBackupResult> {
    const payload = await collectPayload();
    const entries: Array<{ name: string; data: Uint8Array }> = [
        { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(payload)) },
    ];
    // 媒体二进制：四个媒体前缀全量打包（软删行的文件仍在落盘目录，一并带走——
    // 行不进包，导入后行不可见但文件留着不碍事；GC 下次冷启自会回收孤儿）。
    // 单个文件读取失败跳过（不阻塞整包；恢复侧按 manifest 行对账，缺文件的
    // 行渲染时走 useFileUrlState 的 missing 降级）。
    let mediaFiles = 0;
    const listings = await Promise.all(BACKUP_MEDIA_PREFIXES.map((prefix) => fileStorage.list(prefix)));
    for (const info of listings.flat()) {
        const data = await fileStorage.get(info.key).catch(() => null);
        if (!data) continue;
        entries.push({ name: `files/${info.key}`, data });
        mediaFiles += 1;
    }
    const zip = createZip(entries);
    const fileName = `archive-backup-${exportTimestamp()}.zip`;
    await shareExportBytes(zip, fileName, 'application/zip', 'Archive 全量备份');
    return { fileName, mediaFiles };
}

export interface FullImportResult extends db.BackupRestoreCounts {
    /** 恢复落盘的媒体文件数。 */
    mediaFiles: number;
}

/**
 * 全量备份导入：选包字节 → zip 解包（zip-slip/CRC32 校验在 readZip 内）→
 * manifest 校验 → 媒体落盘（已存在跳过）→ 行事务恢复（INSERT OR IGNORE）。
 * uri 来自 document-picker（native file:// / web blob:，统一走 readUriBytes）。
 */
export async function importFullBackup(uri: string): Promise<FullImportResult> {
    const zipBytes = await readUriBytes(uri);
    const entries = readZip(zipBytes);
    const manifestEntry = entries.find((entry) => entry.name === 'manifest.json');
    if (!manifestEntry) {
        throw new Error('这不是 Archive 备份包（缺少 manifest.json）');
    }
    let payload: ExportPayload;
    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(manifestEntry.data));
        if (typeof parsed !== 'object' || parsed === null) throw new Error('manifest 不是对象');
        const candidate = parsed as { meta?: { app?: unknown } };
        if (candidate.meta?.app !== 'archive') throw new Error('meta.app 不是 archive');
        payload = parsed as ExportPayload;
    } catch (error) {
        throw new Error(
            `备份包内容无法识别：${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const rows = assertPayloadArrays(payload);
    // 媒体落盘先于落库（失败即中断，无半恢复态；已存在的文件跳过——合并语义，
    // 本机内容不被包内旧版本覆盖）
    let mediaFiles = 0;
    for (const entry of entries) {
        if (!entry.name.startsWith('files/')) continue;
        const key = entry.name.slice('files/'.length);
        if (!BACKUP_MEDIA_KEY_PATTERN.test(key)) continue;
        if (await fileStorage.exists(key)) continue;
        await fileStorage.put(key, entry.data);
        mediaFiles += 1;
    }
    try {
        const counts = await db.restoreBackupData(rows);
        return { ...counts, mediaFiles };
    } catch (error) {
        // 行事务整体回滚（restoreBackupData 保证）；已落盘的新媒体文件只是
        // 无行引用的孤儿字节（GC 冷启回收），不阻塞失败上浮
        throw error;
    }
}

/** manifest 行集最小校验：缺数组字段按空集处理（旧版本包兼容），非数组整体拒绝。 */
function assertPayloadArrays(payload: ExportPayload): db.BackupRestorePayload {
    const take = <T>(value: unknown, label: string): T[] => {
        if (value === undefined || value === null) return [];
        if (!Array.isArray(value)) throw new Error(`备份包 ${label} 不是数组`);
        return value as T[];
    };
    return {
        trips: take<db.TripRow>(payload.trips, 'trips'),
        journals: take<db.JournalRow>(payload.journals, 'journals'),
        journalMedia: take<db.JournalMediaRow>(payload.journalMedia, 'journalMedia'),
        dayPlans: take<db.DayPlanRow>(payload.dayPlans, 'dayPlans'),
        tripMedia: take<db.TripMediaRow>(payload.tripMedia, 'tripMedia'),
        tripDayMeta: take<db.TripDayMetaRow>(payload.tripDayMeta, 'tripDayMeta'),
        tripItems: take<db.TripItemRow>(payload.tripItems, 'tripItems'),
        events: take<db.EventRow>(payload.events, 'events'),
        eventMedia: take<db.EventMediaRow>(payload.eventMedia, 'eventMedia'),
    };
}
