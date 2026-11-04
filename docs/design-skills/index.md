# UI 设计技能索引（Design Skills Index）

10 个 UI 设计类 agent skills 的仓库内登记处。**使用方式**：任何 UI 开发/改版/动效任务开工前，按"选用规则"挑 1–3 个，先读对应目录的 `SKILL.md` 再动手。技能目录保留原 SKILL.md 形态（含 frontmatter，可直接被 agent 工具链发现）。

## 索引

| 技能 | 一句话 | 什么时候读 | 上游仓库 |
|---|---|---|---|
| [frontend-design](frontend-design/SKILL.md) | Anthropic 官方打底：排版、层级、色彩、反 AI 默认审美 | **所有 UI 任务必读** | [anthropics/skills](https://github.com/anthropics/skills)（skills/frontend-design） |
| [design-taste-frontend](design-taste-frontend/SKILL.md) | anti-slop：从 247 个获奖站点提炼的艺术方向与 no-slop 风格约束 | 想要"有个性、不模板化"的界面 | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) |
| [design-linear](design-linear/SKILL.md) | Linear 设计系统：暗色、Inter、4px 网格 | 工具类/开发者向界面参考 | [ihlamury/design-skills](https://github.com/ihlamury/design-skills)（skills/linear） |
| [design-stripe](design-stripe/SKILL.md) | Stripe 设计系统：亮色、文档型布局 | 表格/仪表盘/支付类界面参考 | [ihlamury/design-skills](https://github.com/ihlamury/design-skills)（skills/stripe） |
| [design-apple](design-apple/SKILL.md) | Apple 设计系统：HIG 式亮色、系统字体 | 消费级/系统感界面参考 | [ihlamury/design-skills](https://github.com/ihlamury/design-skills)（skills/apple） |
| [design-vercel](design-vercel/SKILL.md) | Vercel 设计系统：极简黑白、工程感 | 极简工程风界面参考 | [ihlamury/design-skills](https://github.com/ihlamury/design-skills)（skills/vercel） |
| [animate-expo](animate-expo/SKILL.md) | Expo 动效方法论：是否该动/哪条线程/spring vs timing/手势交接/降级 | **任何 Expo 动效/手势/转场任务必读** | [emilkowalski/skills](https://github.com/emilkowalski/skills)（skills/animate-expo） |
| [mobile-native](mobile-native/SKILL.md) | 让 web/app 在手机上"像装出来的"：100vh、点击高亮、安全区等细节 | 移动端手感排查 | [emilkowalski/skills](https://github.com/emilkowalski/skills)（skills/mobile-native） |
| [animation-vocabulary](animation-vocabulary/SKILL.md) | 动效术语反查（"回弹的那个效果叫什么"） | 描述/检索动效时 | [emilkowalski/skills](https://github.com/emilkowalski/skills)（skills/animation-vocabulary） |
| [improve-animations](improve-animations/SKILL.md) | 以动效顾问视角审计代码库动画并出改进路线图 | "把动效整体变好"类任务 | [emilkowalski/skills](https://github.com/emilkowalski/skills)（skills/improve-animations） |

## 选用规则

1. **UI 新建/改版**：frontend-design（打底）+ design-taste-frontend（辨识度），再按目标风格读一个 design-*（四选一，不要混用）。
2. **动效**：animate-expo（Expo 内必读）；"整体变好"类需求用 improve-animations。
3. **移动端手感问题**：mobile-native。
4. 与本仓库规范的关系：这些技能管"好不好看"，`docs/standards/` 管"放哪里/叫什么/怎么分层"——冲突时**仓库规范优先**（目录/命名/分层不允许为设计效果破坏）。

## 更新流程

1. 重新 shallow clone 上游仓库（上表"上游仓库"列）；
2. 对比技能内容（上游可能改名/新增——1.64 的 lucide 教训：先确认文件存在）；
3. 覆盖本目录对应技能文件夹，并在本索引登记变更；
4. 提交信息带 `docs(design-skills):` 前缀。
