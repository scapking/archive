# Archive

行程 × 日记 的 local-first 移动应用。纯前端工具，无后端依赖：所有数据落本地（expo-sqlite + 文件系统），数据结构自第一天按「将来可加云同步」预留（UUID 主键 + updated_at + 软删除）。Expo SDK 58 + React Native + expo-router + NativeWind + zustand，复制自 `/workspace/mobile` 模板（Hatch Mobile）。

- **Expo 项目根在 `src/`**：`cd src && pnpm typecheck`
- **工程规范（强制）**：先读 [AGENTS.md](AGENTS.md)（硬规则 H1–H11），全文见 [docs/standards/](docs/standards/README.md)
- **UI 设计技能**：[docs/design-skills/index.md](docs/design-skills/index.md)（10 个 agent 设计技能 + 选用规则）
- **三端差异矩阵**：[docs/platform-parity.md](docs/platform-parity.md)（core 能力的 iOS/Android/Web 行为差异与缓解）
- **service 层协议文档**（模板继承的基础设施，当前业务未接后端）：[docs/core-api.md](docs/core-api.md) / [docs/service-api.md](docs/service-api.md)

## 结构

```
src/
├── app/                路由层（expo-router 页面壳：tabs + trip/[id] + trip/new + write + trip/[id]/write/[date]）
├── features/archive/   业务域（db/ 自建表、logic 纯逻辑、store、屏与 UI 原子组件）
├── service/            服务层（通用网络传输：post / socket，URL 与鉴权外部注入）
├── config/             配置层（每业务域一目录：archive）
├── core/               基础设施层（18 个通用能力，见 docs/standards/glossary.md §3）
└── assets/             静态资产（fonts / images）
```

## 产品规划（里程碑）

- **M1 核心闭环（已交付 2026-11-05）**：数据模型（trips / entries / photos / day_plans，`features/archive/db/` 自建表 + migration）→ 建行程自动生成天骨架 → 每日计划勾选 → 碎片式写日记（文字 + 心情 + 图片，按日期自动聚合）→ 时间线 / 行程列表 / 行程详情
- **M2 媒体与组织**：图片压缩策略细化、行程封面、日历视图、碎片编辑/删除入口、On This Day
- **M3 体验与信任**：写作引导、App 锁（面容/指纹）、JSON / PDF 导出、触感反馈（expo-haptics）
- **M4 云同步**：schema 的 UUID + updated_at + 软删除已预留，届时只补传输层

## 运行

```bash
cd src
pnpm install
pnpm start            # Expo Go 扫码即跑 Android / iOS（开发客户端）
pnpm android          # Android
pnpm ios              # iOS
pnpm web              # web 开发
```
