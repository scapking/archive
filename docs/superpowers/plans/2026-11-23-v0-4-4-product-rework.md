# v0.4.4 Product Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.4.4: rename the 笔记 domain to 计划 (journal untouched), remove diary date/quote chrome from the plan editor, rework trip-item form/ordering/status, fix deck contrast, optimize the editor media stack, beautify small icons, and add native home-screen widgets (Android + iOS) plus system alarms (Android AlarmManager, iOS strong notification).

**Architecture:** Expo SDK 58 managed app under `src/`; native projects are generated per build by `expo prebuild` in CI, so native code must ship as an Expo local module (`src/modules/…`, autolinked via `file:` dependency) plus a config plugin (`src/plugins/…` referenced from `app.json`). Trip-item lifecycle becomes **derived** (phase computed from `local_date + time`, no background writer); only the user-driven 收尾 exit is persisted. Widget data is pushed from JS to the native layer; alarms are scheduled natively on Android and as time-sensitive local notifications on iOS.

**Tech Stack:** Expo SDK 58, React Native 0.88, Expo Router, expo-sqlite, expo-notifications, pnpm 10, GitHub Actions, Gradle, Xcode.

**Spec:** `AGENTS.md`, `docs/standards/`, the v0.4.4 brainstorming decisions in `.superpowers/sdd/2026-11-22-v0-4-0-release/progress.md`, and the user's 11-point request (2026-11-23).

## Global Constraints

- **Journal domain is frozen.** `journals.kind = 'daily'` rows, `/write`, `journal/[id]`, 日记 cards/menus/logic, and the 24:00 收笔 semantics must not change. Only `kind = 'note'` entities become 计划.
- **Zero data migration for the rename.** `journals.kind` keeps the literal `'note'` (DB values are not renamed); all TS symbols, routes, and user-facing strings become plan. Add one comment in `db/schema.ts` explaining why.
- **Version contract:** `src/app.json` version `0.4.4`, `android.versionCode` `8`, `ios.buildNumber` `"8"`, `src/package.json` version `0.4.4`, and `tests/release-metadata.test.ts` updated in the same commit.
- **One icon per function** (v0.4.3 rule): no glyph may serve two different functions; no function may keep two glyphs across screens.
- **Deck geometry iron laws** (`ui/deck.tsx` header): PEEK 76, STRIDE 24, static zIndex via state, RN `Animated` only (no reanimated for deck style), back-card content right-inset by PEEK, card pressables keep zero `className`.
- **No committed native projects.** `android/`, `ios/`, `build/` stay generated in CI. Native additions must survive `expo prebuild --clean`.
- **New core capability dirs must be registered in `docs/standards/glossary.md` §3 before creation** (H3). `src/modules/` and `src/plugins/` are outside `config/core/features`, so H1–H6 do not apply, but kebab-case (H2) does.
- **Secrets:** signing material only in GitHub Secrets or 0600 temp files; never in the repo, YAML, logs, artifacts, commits, or this plan.
- **Web is a read-only preview.** Every native path needs a web no-op branch; `core/file-storage` web=OPFS and SDK 58 web stubs stay as documented.
- **No new third-party dependency** unless Task 11's gate fails and the user approves one. Prefer local Expo modules and config plugins.
- **Gates before every commit:** `pnpm typecheck`, `pnpm test`, `pnpm assets:check`, `python3 -m unittest discover -s tests -p 'test_*.py'`.

## Review Focus

- **Legacy trip items** (`status` already `'done'`/`'failed'`, or times already past on upgrade) must map to sane phases — Task 5 owns the migration and the derivation tests.
- **Existing notes** must survive the rename untouched (no data loss, no journal bleed-through) — Task 1 owns the route/symbol rename and the source-scan test.
- **Denied alarm/notification permission** (Android 12+ exact-alarm, iOS notification) must never block trip-item creation — Tasks 9–10 own the best-effort contract.
- **Widget with no data / unsupported platform** (web, tablet without widget host, app force-stopped) must degrade silently — Tasks 10–11 own the no-op paths.
- **Rapid stack switching / mid-transition taps** must not tear the video player or flash a blank frame — Task 8 owns the cache-hit path and transition latch tests.

---

## Part A — 笔记 → 计划

### Task 1: Rename the note domain to 计划

**Files:**
- Rename: `src/app/notes.tsx` → `src/app/plans.tsx`; `src/app/note/new.tsx` → `src/app/plan/new.tsx`; `src/app/note/[id].tsx` → `src/app/plan/[id].tsx`; `src/features/archive/note-form-screen.tsx` → `src/features/archive/plan-form-screen.tsx`
- Modify: `src/app/_layout.tsx:413-430`, `src/features/archive/archive-screen.tsx`, `library-screen.tsx`, `me-screen.tsx`, `search-screen.tsx`, `search-results-screen.tsx`, `store.ts`, `db/index.ts`, `db/schema.ts` (comment only), `ui/editor.tsx` labels if any
- Test: `tests/plan-domain.test.ts`

**Interfaces:**
- Produces: `store.createPlan(input: { title: string; description: string }): Promise<JournalRow | null>`, `store.updatePlanMeta(id, { title?, description? }): Promise<boolean>`, `db.listPlans(): Promise<JournalRow[]>`, route strings `/plan/new`, `/plan/[id]`, `/plans`.
- Consumed by: Tasks 2, 7, 12.

- [ ] **Step 1: Write the failing test** `tests/plan-domain.test.ts`
  - Asserts `src/app/plans.tsx`, `src/app/plan/new.tsx`, `src/app/plan/[id].tsx`, `src/features/archive/plan-form-screen.tsx` exist.
  - Asserts `src/app/notes.tsx` and `src/app/note/` do not exist.
  - Scans `src/**/*.ts(x)`, drops lines whose trimmed form starts with `//`, `*`, `/*`, `{/*`, or `*/`, and asserts no remaining line contains `笔记` or `createNote`.
- [ ] **Step 2: Run it and confirm it fails** — `pnpm test` shows the new test failing on the missing files.
- [ ] **Step 3: Rename files and symbols**
  - `git mv` the four files; update `Stack.Screen` names and all `router.push('/note/...')` / `href` usages.
  - Rename store/db symbols: `createNote`→`createPlan`, `updateNoteMeta`→`updatePlanMeta`, `listNotes`→`listPlans`, `NOTE_DESCRIPTION_MAX`→`PLAN_DESCRIPTION_MAX`; keep `kind === 'note'` literals and their comments.
  - Rename local symbols: `isNote`→`isPlan`, `noteMenu`→`planMenu`, `NoteCard`→`PlanCard`, `noteForm`→`planForm`.
  - Replace every user-facing `笔记` with `计划` (menus, empty states, accessibility labels, search placeholders, error strings, route titles). Journal copy stays `日记`.
- [ ] **Step 4: Run the test and gates** — `pnpm test`, `pnpm typecheck`.
- [ ] **Step 5: Commit** — `fix(plan): rename the note domain to plans`

### Task 2: Strip the diary date/quote chrome from the plan editor

**Files:**
- Modify: `src/features/archive/journal-edit-screen.tsx:1195-1260` (header block), `:764` (capture label)
- Test: none (UI-only); verified by `pnpm typecheck` + manual note in the commit body.

**Interfaces:**
- Consumes: `isPlan` from Task 1.
- Produces: header contract — plan mode renders back button + title + edit-title button only; date line, 进行中/已收笔 line, and comfort quote are not rendered.

- [ ] **Step 1: Gate the date row** — wrap the `monthDay` + status row in `{isPlan ? null : (…)}`.
- [ ] **Step 2: Gate the comfort quote** — render `{comfortQuote}` only when `!isPlan`; keep the chars/save-status line.
- [ ] **Step 3: Update the fallback label** — `captureOwnerLabel` returns `未命名计划` for plan mode.
- [ ] **Step 4: Verify** — `pnpm typecheck`, `pnpm test`; open a plan and a journal entry to confirm only plans lost the date chrome.
- [ ] **Step 5: Commit** — `fix(plan): drop diary date and quote chrome from the plan editor`

---

## Part B — Trip items: form, ordering, lifecycle, contrast, icons

### Task 3: One-card progressive form + smooth time wheel

**Files:**
- Create: `src/features/archive/trip-item-form-logic.ts`
- Modify: `src/features/archive/trip-day-screen.tsx` (`TripItemFormCard`, `TimeWheelColumn`, `StepEchoRow`)
- Test: `tests/trip-item-form-logic.test.ts`

**Interfaces:**
- Produces: `wheelOffsetForIndex(index: number, itemHeight: number): number`, `wheelIndexFromOffset(offset: number, itemHeight: number, count: number): number`, `normalizeWheelTime(hour: number, minute: number): string`.
- Form contract: one card, no step screens — time wheels and title input always visible; the note field is appended below on 「下一步」; 「添加」 submits.

- [ ] **Step 1: Write the failing test** — offsets round-trip (`wheelOffsetForIndex(wheelIndexFromOffset(y, 44, n), 44, n) === i`), out-of-range clamps, and `normalizeWheelTime(9, 5) === '09:05'`.
- [ ] **Step 2: Run and confirm failure** — `pnpm test`.
- [ ] **Step 3: Implement the helpers** in `trip-item-form-logic.ts`.
- [ ] **Step 4: Rewrite the wheel as `FlatList`** — padded rows (2 above, 2 below), `getItemLayout`, `initialScrollIndex = index + 2`, `snapToInterval` on iOS, manual snap on Android momentum end (`scrollToOffset({ offset: wheelOffsetForIndex(...), animated: true })`), `bounces={false}`, `decelerationRate="fast"`, `overScrollMode="never"`; highlight follows the settled index only (no per-frame state).
- [ ] **Step 5: Collapse the steps into one card** — remove `step === 'title' | 'note'` screen replacement and `StepEchoRow`; keep `time`/`title` inputs mounted; `step` becomes `noteOpen` only; primary button = 下一步 until note opens, then 添加.
- [ ] **Step 6: Verify** — `pnpm typecheck`, `pnpm test`; on a device confirm the wheel snaps and the note field appends in place.
- [ ] **Step 7: Commit** — `feat(trip): one-card progressive form with a snapping time wheel`

### Task 4: Trip-item phase + ordering pure logic

**Files:**
- Create: `src/features/archive/trip-item-logic.ts`
- Modify: `src/features/archive/trip-day-screen.tsx:110-135` (delete local `orderTripItems`/`byTime`)
- Test: `tests/trip-item-logic.test.ts`

**Interfaces:**
- Produces:
  - `type TripItemPhase = 'pending' | 'ongoing' | 'done' | 'wrap' | 'terminal'`
  - `TRIP_ITEM_PHASE_LABEL: Record<TripItemPhase, string>` = `{ pending: '待进行', ongoing: '进行中', done: '完成', wrap: '收尾', terminal: '已结束' }`
  - `tripItemDoneAt(dueAt: number, nextDueAt: number | undefined): number` = `Math.min(dueAt + 30 * 60_000, nextDueAt ?? Infinity)`
  - `tripItemPhase(item, now, nextDueAt): TripItemPhase`
  - `orderTripItems(items, now): TripItemRow[]` — ongoing first (earliest due), then future pending **time DESC**, then done/wrap by time ASC, terminal last by time ASC.
- Consumed by: Tasks 5, 10, 11.

- [ ] **Step 1: Write the failing test** covering: before due = pending; due ≤ now < doneAt = ongoing; `nextDueAt` earlier than +30 min truncates done; past doneAt = done; `completed_at` set = wrap; `wrap_closed_at` set = terminal; legacy `status === 'failed'` = terminal; ordering puts ongoing first, future newest-first, settled oldest-last.
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement** `trip-item-logic.ts`.
- [ ] **Step 4: Run the test** and `pnpm typecheck`.
- [ ] **Step 5: Commit** — `feat(trip): derive item phases and deck ordering in pure logic`

### Task 5: Status machine — migration v10, store, and deck UI

**Files:**
- Modify: `src/features/archive/db/schema.ts` (`TripItemRow`, `TRIP_ITEMS_DDL` untouched), `src/features/archive/db/migrations.ts` (append v10), `src/features/archive/store.ts` (trip-item section), `src/features/archive/trip-day-screen.tsx` (action card, labels, media gating)
- Test: covered by `tests/trip-item-logic.test.ts` + `pnpm typecheck`.

**Interfaces:**
- Consumes: Task 4.
- Produces: `TripItemRow` gains `completed_at: number | null`, `wrap_closed_at: number | null`; store gains `startWrap(id): Promise<boolean>`, `closeWrap(id): Promise<boolean>`; `updateTripItemStatus` is removed; media attach allowed when phase ∈ `{done, wrap}`.

- [ ] **Step 1: Append migration v10** — `ALTER TABLE trip_items ADD COLUMN completed_at INTEGER`, `ADD COLUMN wrap_closed_at INTEGER`, then backfill `completed_at = updated_at` for legacy `done` and `wrap_closed_at = updated_at` for legacy `failed`.
- [ ] **Step 2: Extend `TripItemRow`** and the trip-item insert/select sites (`db/index.ts`, `store.createTripItem`).
- [ ] **Step 3: Replace `updateTripItemStatus`** with `startWrap` (sets `completed_at = now` when null) and `closeWrap` (sets `wrap_closed_at = now`); keep cancel/reschedule notification semantics.
- [ ] **Step 4: Rewire the deck UI** — remove 标记完成/标记失败 rows; rows = 进入收尾 (phase `done`), 结束收尾 (phase `wrap`), 添加图片/添加视频 (phase `done`/`wrap`), 删除此行程; card eyebrow and accessibility label use `TRIP_ITEM_PHASE_LABEL`.
- [ ] **Step 5: Verify** — `pnpm typecheck`, `pnpm test`; fresh install and an upgrade-from-v0.4.3 DB both open without migration errors.
- [ ] **Step 6: Commit** — `feat(trip): replace manual status with the derived pending→ongoing→done→wrap machine`

### Task 6: Deck contrast in light and dark mode

**Files:**
- Modify: `src/features/archive/ui/deck.tsx:355-380`
- Create: `tests/deck-contrast.test.ts`

**Interfaces:**
- Consumes: `usePalette()` tokens (`base`, `surface`, `raised`, `border`).
- Produces: shell contract — front card `bg-ink-surface`, back cards `bg-ink-raised`, every card gets a 1px `ink-border` ring drawn above the face, back-card opacity floor 0.92.

- [ ] **Step 1: Write the failing contrast test** — read `theme.ts`, extract light and dark `base` and `border`, compute WCAG contrast, and assert `border vs base ≥ 1.2` in both themes; additionally assert the deck shell uses `raised` for `depth > 0`. Do **not** assert `raised vs surface` token contrast — the legibility mechanism is the ring, and the global palette is out of this task's scope.
- [ ] **Step 2: Run and confirm failure** (current border/base ratios are below the threshold in at least one theme).
- [ ] **Step 3: Fix the shell** — conditional shell tone by depth, opacity floor, and the ring overlay; keep `overflow-hidden` + rounded-card.
- [ ] **Step 4: Verify** — test passes, `pnpm typecheck`; visually confirm stacked strips are readable on white and near-black pages.
- [ ] **Step 5: Commit** — `fix(ui): give stacked deck cards a readable edge in both themes`

### Task 7: Small-icon beauty pass

**Files:**
- Modify: `src/core/icons/lucide.tsx` (+`ListTodo`, `ListPlus`, `PanelLeftOpen`, `PanelLeftClose`), `src/features/archive/archive-screen.tsx:642-670`, `me-screen.tsx:298`, `ui/sidebar.tsx:51,111`, `ui/desktop-shell.tsx:165`, `ui/calendar.tsx:187`, `journal-edit-screen.tsx:1856`

**Interfaces:**
- Consumes: adapter exports from `core/icons`.
- Produces: the remap table below; no glyph shared across functions.

| Site | Now | After |
|---|---|---|
| 上个月 (calendar) | `LucideBack` (arrow-left, asymmetric with ChevronRight) | `LucideChevronLeft` |
| 收起侧栏 | `LucideBack` | `LucidePanelLeftClose` |
| 展开侧栏 | `LucideChevronRight` | `LucidePanelLeftOpen` |
| Me「计划」行 | `LucideNotebookPen` | `LucideListTodo` |
| 新建计划 | `LucideStickyNote` | `LucideListPlus` |
| 转成动图 | `LucideImagePlay` | `LucideRepeat2` |
| 新建日记 / 新建行程 / 新建事件 / 添加 / 删除 / 完成 / 关闭 / 设置背景 / 防截屏 / 相册视频 / 拍摄视频 | unchanged | unchanged |

- [ ] **Step 1: Add the five icons to the adapter** (deep-path imports, matching the existing per-icon pattern).
- [ ] **Step 2: Apply the remap** and update accessibility labels/strings.
- [ ] **Step 3: Re-run the icon collision audit** (JSX scan + nearby labels) and confirm every function has exactly one glyph.
- [ ] **Step 4: Verify** — `pnpm typecheck`, `pnpm test`, `pnpm assets:check`.
- [ ] **Step 5: Commit** — `fix(ui): beautify the small icons and finish the one-icon-per-function pass`

---

## Part C — Editor media-stack performance

### Task 8: Kill the reload/blank frame when switching stacked media

**Files:**
- Create: `src/features/archive/ui/file-url-state.ts` (pure state transition)
- Modify: `src/features/archive/ui/use-file-url.ts`, `src/features/archive/ui/editor.tsx` (`MediaDeckStack`, `DeckFrontCard`, `DeckBackCard`, `DeckVideoFrontCard`, `DeckVideoBackCard`)
- Test: `tests/file-url-state.test.ts`

**Interfaces:**
- Produces: `nextFileUrlState(prev: FileUrlState, key: string | null, peeked: string | null): FileUrlState` — returns `{status:'ready', uri: peeked}` synchronously when the new key is cached; otherwise `{status:'loading'}`; `null` key → `missing`.
- Card contract: each card is keyed by `media.id`; front/back cards are `React.memo` with primitive props.

- [ ] **Step 1: Write the failing test** — cached key switch stays `ready` with the new URI; uncached key → `loading`; null → `missing`; same key + same URI returns the previous object (referential stability).
- [ ] **Step 2: Run and confirm failure.**
- [ ] **Step 3: Implement the helper** and use it in `useFileUrlState` (adjust state during render when the key changes instead of a `LOADING` effect pass).
- [ ] **Step 4: Warm the neighbours** — in `MediaDeckStack`, `acquireFileUrl` for `leftItem`/`rightItem` media on mount/index change (release handles on unmount) so the next card is always a cache hit.
- [ ] **Step 5: Key + memo the cards** — `key={media.id}` on front/back cards, `memo()` around all four card components, and keep the single-player rule (`DeckVideoFrontCard` keeps its remount, now with a pre-warmed thumbnail).
- [ ] **Step 6: Verify** — test passes, `pnpm typecheck`; rapid left/right tapping on a 3+ item stack shows no blank frame and no player leak.
- [ ] **Step 7: Commit** — `perf(editor): resolve stacked media from cache so switching never reloads`

---

## Part D — Native home-screen widgets and system alarms

> Risk note for the reviewer: iOS widget extension targets and Android `AlarmManager` do not exist in Expo's managed API. Tasks 9–11 are gated: Task 9 proves the prebuild path before UI work builds on it. If the iOS extension cannot be stabilized after two CI attempts, stop and ship Android widget + strong notification, with the user's written approval to defer the iOS widget.

### Task 9: Native alarm module (`archive-alarm`)

**Files:**
- Create: `src/modules/archive-alarm/` (`expo-module.config.json`, `package.json`, `src/index.ts`, `android/src/main/java/…/ArchiveAlarmModule.kt`, `ArchiveAlarmReceiver.kt`, `AndroidManifest.xml`), `src/core/alarm/index.ts` (JS façade, registered in `glossary.md` §3 first)
- Modify: `src/app.json` (plugin registration if required), `src/package.json` (`"archive-alarm": "file:modules/archive-alarm"`), `.github/workflows/release.yml` only if prebuild needs an explicit step

**Interfaces:**
- Produces: `alarm.schedule(input: { id: string; at: number; title: string; body: string }): Promise<void>`, `alarm.cancel(id: string): Promise<void>`, `alarm.permission(): Promise<'granted' | 'denied' | 'unsupported'>`; web/stub = `unsupported`, never throws.

- [ ] **Step 1: Register the capability** in `docs/standards/glossary.md` §3 (`alarm` — OS-level exact alarms; native module + expo-notifications fallback).
- [ ] **Step 2: Implement the module** — Android `AlarmManager.setExactAndAllowWhileIdle` with a `BroadcastReceiver`, `BOOT_COMPLETED` reschedule, `POST_NOTIFICATIONS`/`SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` manifest entries, and a full-screen-intent notification tap-through; iOS no-op (`unsupported`).
- [ ] **Step 3: Wire JS** — `src/core/alarm/index.ts` calls the module when available, otherwise falls back to the existing `expo-notifications` schedule in `store.ts`.
- [ ] **Step 4: Prove prebuild** — run `pnpm exec expo prebuild --platform android --clean` locally (or in a CI branch) and confirm the module is autolinked and the receiver is merged into `AndroidManifest.xml`.
- [ ] **Step 5: Verify** — typecheck, tests, and the Android CI job must pass; no secret, no committed `android/`.
- [ ] **Step 6: Commit** — `feat(alarm): add an Android exact-alarm module with notification fallback`

### Task 10: Android home-screen widget

**Files:**
- Create: `src/modules/archive-widget/` (module + `ArchiveWidgetProvider.kt`, `res/layout/archive_widget.xml`, `res/xml/archive_widget_info.xml`), `src/plugins/with-archive-widget.ts`, `src/core/widget/index.ts`
- Modify: `src/app.json` (plugin), `src/features/archive/store.ts` (push snapshot after trip-item mutations), `glossary.md` §3

**Interfaces:**
- Produces: `widget.push(snapshot: WidgetSnapshot): void` where `WidgetSnapshot = { tripTitle: string; tripId: string; items: Array<{ time: string; title: string; phase: string }> }`; `widget.update()` on app foreground; widget tap → deep link `archive://trip/<id>`.
- Widget content rule (user decision): auto-select the newest ongoing/relevant trip, then list its items newest-relevant-first with the current one highlighted.

- [ ] **Step 1: Register `widget` in `glossary.md` §3.**
- [ ] **Step 2: Implement the provider** — `RemoteViews` list, `AppWidgetManager` update, `PendingIntent` deep link, 30-minute `updatePeriodMillis` plus explicit pushes; tolerate an empty snapshot with an explanatory empty layout.
- [ ] **Step 3: Push from JS** — after `createTripItem` / phase transitions / trip changes, call `widget.push(...)`; also on `AppState` → active.
- [ ] **Step 4: Verify** — CI Android build passes; widget appears on a device home screen, follows the newest trip, and updates without opening the app.
- [ ] **Step 5: Commit** — `feat(widget): add the Android home-screen trip widget`

### Task 11: iOS widget + strong reminder

**Files:**
- Create: `targets/archive-widget/` (Swift + `Info.plist` + `ArchiveWidget.swift`), `src/plugins/with-archive-widget-ios.ts`
- Modify: `src/app.json` (plugin + `ios.entitlements` app group), `store.ts` (push to App Group defaults)

**Interfaces:**
- Consumes: Task 9 (`alarm.schedule`) and Task 10's snapshot shape.
- Produces: a WidgetKit small/medium widget reading the app-group snapshot; iOS alarms = `UNNotificationRequest` with interruption level `timeSensitive` and a custom sound.

- [ ] **Step 1: Gate check** — confirm the CI iOS job can add and build a WidgetKit extension target (`expo prebuild` + `pod install` + `xcodebuild -scheme Archive`) with a minimal stub; if it fails twice, stop and escalate to the user.
- [ ] **Step 2: Add the extension** — app-group entitlement, shared snapshot file, widget timeline provider (no network), deep link.
- [ ] **Step 3: iOS alarm** — `alarm.schedule` posts a `timeSensitive` local notification with sound; document the platform limit (no system-clock entry, silent switch may still silence).
- [ ] **Step 4: Verify** — unsigned IPA still compiles and contains the extension; CI green.
- [ ] **Step 5: Commit** — `feat(widget): add the iOS widget extension and strong reminders`

### Task 12: Release v0.4.4

**Files:**
- Modify: `src/app.json`, `src/package.json`, `tests/release-metadata.test.ts`, `.superpowers/sdd/2026-11-22-v0-4-0-release/progress.md`

**Interfaces:**
- Consumes: all previous tasks.

- [ ] **Step 1: Bump** — app/package version `0.4.4`, `versionCode` `8`, `buildNumber` `"8"`, contract test updated.
- [ ] **Step 2: Gates** — `pnpm typecheck`, `pnpm test`, `pnpm assets:check`, `python3 -m unittest discover -s tests -p 'test_*.py'`.
- [ ] **Step 3: Commit** — `chore(release): bump version to 0.4.4 (versionCode 8)`.
- [ ] **Step 4: Tag and push** — annotated `v0.4.4`, push `release/v0-4-0` and the tag; fast-forward `main`.
- [ ] **Step 5: Watch CI** — `gh run watch <id> --exit-status --interval 30`; on proxy failure re-query `gh api repos/scapking/archive/actions/runs/<id>`.
- [ ] **Step 6: Verify** — `python3 /tmp/opencode/verify-archive-release.py verify v0.4.4` (APK ≤ 125829120 B, arm64-only, sha256, v0.4.0 intact, v1.0.0 still deleted).
- [ ] **Step 7: Record** — append the outcome to the progress ledger and remind the user to rotate the PAT.