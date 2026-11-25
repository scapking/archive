# v0.4.6 UI 重做方向 —「纸 × 墨 2.0」（2026-11-25 用户七条令）

用户痛点原话（编号=用户条目）：
1. 堆叠的卡片不要灰色相进、但是要可以区分的
2. 堆叠的图片视频切换卡片的时候会卡，连续切换会卡
3. 计划顶部导航栏要有计划名称，参考行程列表的顶部导航栏
4. 行程堆叠卡片区域的「未命名行程」删除，即使命名也不在那显示
5. Me 页面「我的内容」卡片容器信息负担太大，砍了
6. 真实使用设计 skills，以及走完整的视觉 CDP
7. 目前的 UI 太丑，大胆作出改动

基线截图（v0.4.5 @38dcee0，已 seed 数据）：`/tmp/shots/base-{home,plans,trips,tripnew,write,plannew,me,settings}-{light,dark}.png`。
灰板堆叠证据：base-home-light/dark 右侧一整块 deckEdge 灰绿板；base-plans-dark 同。Me 负担证据：base-me 行尾「进行 0 · 完成 0 · 失败 0」全零噪音 + 搜索/设置混排。

## 一、艺术方向（三个 agent 共用，保持一致）

1. **层次靠光影不靠色块**：卡面一律纸色（surface），堆叠用柔和投影（RN shadow* + Android elevation + RNW box-shadow 内联 style）+ 位移 + 轻缩放区分；**废掉 deckEdge 灰底语言**（用户明确否「灰色相进」）。
2. **字阶纪律**：屏题、eyebrow、正文、meta 各一档（建议 24/11/16/12 附近，agent 定后全组一致）；eyebrow 二字类型词 + 最小必要 meta；「更新于 2026-11-25 08:25」「0 字」这类冗余串一律删或重排。
3. **稀疏即罪**：屏的空区要么收进内容要么做设计过的空态；首页下半、计划堆、行程卡的大片死白都要处理（这是第 7 条「太丑」的主证据）。
4. **双主题等权**：dark 是夜读纸面（inkd 家族），每次视觉改动 light+dark 都要截图看。
5. **大胆 ≠ 特效堆**：accent 单色克制；白与字重是主要表达手段；参考 design-apple 或 design-linear 二选一（建议 apple：消费级日记），禁混用。
6. **CDP 自证**：改动→export→截图→对照基线→再迭代，至少两轮；报告必须附最终截图路径与一句话自评（哪里比基线好）。

## 二、CDP 工具用法

工作树 `/workspace/.wt/archive`（分支 `v0-4-6-rework`），Expo 根 `src/`。

端口与产物隔离（8961 主控保留）：
- A：port **8962** / outdir **/tmp/webout-a** / profile 自动 `/tmp/cdp-profile-8962`
- B：port **8963** / outdir **/tmp/webout-b**
- C：port **8964** / outdir **/tmp/webout-c**

```bash
export PATH="$HOME/.nvm/versions/node/v24.22.0/bin:$PATH"
# 1) 导出（2-3 分钟，等完成再截图）
cd /workspace/.wt/archive/src && NODE_ENV=production CI=1 EXPO_NO_GIT_STATUS=1 EXPO_NO_TELEMETRY=1 \
  pnpm exec expo export --platform web --output-dir /tmp/webout-a
# 2) 截图（首次带 --seed 建 3 条计划，profile 持久化后不用重 seed）
cd /workspace/.wt/tools && node shoot.mjs --dir=/tmp/webout-a --port=8962 \
  --route=/ --theme=light --out=/tmp/a-home-light.png --seed
# 卡死/「数据库被其他标签页占用」：pkill -f "cdp-profile-8962" 后重试
```

媒体夹具（性能/媒体卡验证）：`/tmp/media/shot1.jpg`、`/tmp/media/shot2.jpg`。web 插入图片走 file input：puppeteer `elementHandle.uploadFile('/tmp/media/shot1.jpg')` 注入（参考 shoot.mjs 的 evaluate 套路，agent 可写小脚本）。

## 三、性能红线（agent A）

- 先测后修：CDP `page.evaluate` 挂 `PerformanceObserver('longtask')` + rAF 间隔采样，模拟横拖翻卡（mouse down/move/up 序列），单帧 >33ms 记卡顿；连续翻 6 张无长任务才算修好。
- 候选手段（以实测取舍）：只给前卡+第一背卡渲染真实媒体、深层静态缩略；拖拽期视频 pause+poster 静帧；图片解码/缩放离交互帧（file-url-state 缓存命中，见 2480724 perf 提交）；拖拽通道不每帧 setState（native Animated 直驱）。

## 四、文件所有权（越界=返工）

- **A**：`ui/deck.tsx`、`ui/theme.ts`、`trip-day-screen.tsx`、`ui/media-view.tsx`、`ui/use-file-url.ts`、`ui/file-url-state.ts`、`ui/editor.tsx` + 新/改对应 tests
- **B**：`archive-screen.tsx`、`journal-edit-screen.tsx`、`plan-form-screen.tsx`、`me-screen.tsx`、`library-screen.tsx`、`search-results-screen.tsx`、`trip-detail-screen.tsx`（项 3/4/5 + 这些屏的大胆重样）
- **C**：`settings-screen.tsx`、`events-screen.tsx`、`event-detail-screen.tsx`、`event-form-screen.tsx`、`search-screen.tsx`、`ui/screen-header.tsx`、分段控件、chooser/菜单族、`src/app/(tabs)/*`、`+not-found`（项 6/7 的外围屏与壳层重样）
- 共享规则：`ui/index.ts` 只许加行并在注释标 agent 名；`store.ts`/`db/*`/`config` 谁都不动——要数据层配合写进报告由主控接；不 commit；不跑 `pnpm web:css`（集成时主控统一）；`AGENTS.md` H1–H11、中文注释英文标识符不变。

## 五、验收

typecheck 0 错 + `node --test tests/*.test.ts` 全过 + 每屏 light/dark CDP 截图对照基线的书面自评；主控逐路由复审，不合格带截图打回。
