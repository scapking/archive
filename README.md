# Archive

行程 × 日记 的 local-first 移动应用（商业版形态）。纯前端工具，无后端依赖：所有数据落本地（expo-sqlite + OPFS/file-storage），结构自第一天按「将来可加云同步」预留（UUID 主键 + updated_at + 软删除）。Expo SDK 58 + React Native + expo-router + NativeWind v4 + zustand，复制自 `/workspace/mobile` 模板（Hatch Mobile）。

- **Expo 项目根在 `src/`**：`cd src && pnpm typecheck`
- **工程规范（强制）**：先读 [AGENTS.md](AGENTS.md)（硬规则 H1–H11），全文见 [docs/standards/](docs/standards/README.md)
- **UI 设计技能**：[docs/design-skills/index.md](docs/design-skills/index.md)（10 个 agent 设计技能 + 选用规则）；本仓库 UI 基线 = action panel 纪律 + app-screens 房规
- **service 层协议文档**（模板继承的基础设施，当前业务未接后端）：[docs/core-api.md](docs/core-api.md) / [docs/service-api.md](docs/service-api.md)

## 产品形态

**两个导航：Archive / Me**（≥1024px 桌面侧栏，窄屏底部标签栏；三端一致）。

- **Archive**：首页三卡恒显——行程与当前日记两张重叠卡（左右若隐若现，点前卡直接进内容，点后卡交换）+ 事件入口卡，无需先建内容。`+` 号选择「今天的日记 / 新的行程 / 新建事件」。**长按操作**（web 桌面双击）：行程卡 → 关闭行程 / 新建行程 / 编辑行程 / 删除行程；笔记卡 → 重命名 / 完成收笔 / 删除笔记（删除均二次确认）。
- **日记 = 连续容器**：一天一篇、块结构（文本 + 行内图片/视频混排），想到什么写什么；800ms 防抖自动保存；**当天 24:00（本地时区）自动收笔**，或手动「完成」提前结束；收笔后只读。
- **行程（持续性容器）**：名称选填（空名显示「未命名行程」）、出发日期默认今天、**默认无固定结束（持续进行）**；逐日卡从出发日到今天**逐日自动生成**（每天自动长出新一格），长按行程卡「关闭行程」= 结束于今天（明日起进入回忆）；行程状态由日期派生（计划中 / 进行中 / 回忆）。新建表单描述为默认展开的输入框。
- **Me**：连续记录 streak / 日记天数 / 累计字数 / 行程进行中数，最近 30 天写作量曲线（SVG），内容入口（搜索 / 事件 / 行程 / 设置）。**设置页**：外观（主题三档 + 图片对齐）、安全（App 锁：面容/指纹/设备凭据，退后台重锁）、备份与恢复（**导出全量备份 zip**——全部行 + 图片/视频/音频二进制；**导入自动恢复**——合并语义无缝续用；导出文稿 PDF，web 降级 HTML 下载）。

**设计令牌**：`ink`（浅色灰白，默认类名）+ `inkd`（深色，`dark:` 变体，对齐 action panel 纪律）；唯一强调色 = 冷蓝渐变（`#2563EB→#3B82F6` / 深色 `#2E6FD9→#5B9DFF`），只用于主行动与品牌标记；绿色已全面退场。

## 结构

```
src/
├── app/                路由层（tabs: archive/me + trip/[id] + trip/new + trip/[id]/edit
│                       + write + trip/[id]/write/[date] + journal/[id]）
├── features/archive/   业务域（db/ 自建表 v2、logic 纯逻辑、store、五屏、ui 原子组件）
├── service/            服务层（通用网络传输：post / socket，URL 与鉴权外部注入）
├── config/             配置层（每业务域一目录：archive；含 ui.theme 主题偏好）
├── core/               基础设施层（18 个通用能力，见 docs/standards/glossary.md §3；
│                       file-storage web 底座 = OPFS 直连）
└── assets/             静态资产（fonts / images）
```

## 数据模型（schema v2，`features/archive/db/`，R9）

- `trips`：图标 / 封面视频 / 描述 / 起止日期（状态由日期派生，不落库）
- `journals`：一天一篇的连续容器（blocks JSON、open/closed、word_count 冗余指标）
- `journal_media`：行内媒体（图/视频 → file-storage key，二进制不进库）
- `day_plans`：每日计划（勾选）
- v1 碎片流（entries/photos）为灰度前形态，v2 迁移直接重置（无生产数据）

## 运行

```bash
cd src
pnpm install
pnpm start            # Expo Go 扫码即跑 Android / iOS（开发客户端）
pnpm android / pnpm ios / pnpm web
pnpm exec expo export --platform web   # web 生产静态包（SPA；桌面侧栏 / 窄屏底栏自适应）
```

## 产品规划（里程碑）

- **M1 已交付（2026-11-05）**：天骨架行程 + 碎片日记时间线（已被 v2 形态取代）
- **M2 商业版已交付（2026-11-05）**：双导航 IA、连续日记容器 + 24:00 自动收笔、共享块编辑器、行程图标/视频/描述、Me 指标曲线检索、灰白/深色双主题、桌面响应式、OPFS web 文件底座
- **M3 大部分已交付（2026-11-17）**：expo-haptics 触感（点按/长按/终态确认）、App 锁（面容/指纹/设备凭据 + 退后台重锁 + Me→设置开关）、**数据备份与恢复**（设置页导出/导入全量 zip：全部行 + 媒体二进制，导入合并语义无缝续用；PDF 文稿导出，web 降级 HTML 下载）、**视频转 GIF**（笔记视频块长按 → 前 4 秒抽帧 → GIF89a 纯 JS 编码 → 存相册）；**待办**：真机手感验收（按压回弹 / modal 转场 / 键盘避让）、行程封面图。备份传输面 = 系统分享面板（AirDrop/网盘/IM 传同一个 zip）；局域网设备直传依赖常驻 HTTP 服务，Expo Go 运行时无此能力，未实现。
- **M4 云同步**：UUID + updated_at + 软删除已预留，届时只补传输层
