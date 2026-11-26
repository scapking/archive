# v0.5.1 轮（2026-11-26）— 添加项表单 v2 / 闹钟真机纠错 / 事件表单容器化

用户四条令（编号照原清单）：

1. **添加行程项 v2**：边距不合理（对齐全 app 间距体系）；**删标题输入框**；
   「到点响铃」默认开且**删掉其容器**；**删备注入口**。时间选择「卡得太死」——
   参考 0.4.3 滚轮滚动交互（简化版，勿复杂化）。动作行学**新建事件**：
   「直接创建」即提交（无标题项），「下一步」进入标题+备注补填。
   → 数据语义变更：createTripItem 的 title 从必填放开为可空（存空串）；
   卡面空标题**不得**兜底出任何文字。withAlarm 恒 true（UI 删了但链路保留）。
2. **闹钟纠错（真机反馈）**：a) 后台触发未跳回 app、未响铃；b) 关闭后声音仍在；
   c) 全屏闹钟 UI 丑。查整条链：AlarmScheduler→AlarmFireReceiver→
   ongoingNotification(fullScreen?)→deepLink archive://alarm/<id>→
   alarm/[id] 路由→fullscreen 屏播放器生命周期→停止广播。
3. **彻底认真用设计 skills + CDP 验证**（每条令的观感都要实拍，不许代码自证）。
4. **新建事件表单重构**：输入框太丑——字段用**容器包裹**（FieldGroup 井），
   「直接创建/继续填写」按钮行**在容器外底部**不被包裹。新建行程（本令指
   trip/new 向导视觉）同步对齐最新事件语言。

## 设计契约（B/C 共同遵守，防漂移）

- 容器井：surface 底 + rounded-card 16 + PAPER_CARD 影（对齐 settings 卡解剖）；
  字段 label（eyebrow 11）在其内顶部；输入走 field-input canvas 档。
- 动作行：容器外底部单行，「继续填写」近黑主钮（primary-btn）+「直接创建」
  ghost 次级——照新建事件现行两钮语义，只是不再被容器包裹。
- 边距基线：屏体 px-6、卡内 p-4、区块 mt-4、行距节奏对齐 event/settings 实拍。

## 所有权

- **A（闹钟线）**：src/modules/archive-alarm/**（Kotlin+manifest）、
  alarm-fullscreen-screen.tsx、alarm-watcher.ts、alarm-ladder.ts、
  src/app/alarm/[id].tsx、assets/sounds、相关 tests。Kotlin 改动必须保守
  （CI 编译三轮前科）：不动类型/枚举面，只修意图构造、声音生命周期、
  fullScreen 传参路径；每处附注释与「无法本机验证」披露。
- **B（添加项线）**：trip-day-screen.tsx、ui/sheet.tsx、store.ts 仅
  createTripItem 校验放开 + 注释（其余语义冻结）、trip-item-logic 展示兜底、
  tests/trip-time-picker、sheet-keyboard、trip-submit 相关、新建 tests/trip-item-title-optional。
- **C（事件/行程表单线）**：event-form-screen.tsx、events 语言相关 tests、
  trip-form-screen.tsx（对齐新事件视觉；行程滚动时间选择如涉 trip/new 顺治）。
- 冻结：ui/deck.tsx、editor.tsx、field-input.tsx、segmented.tsx、
  paper-shadow.ts、theme.ts 旧值、app.json（控制器）。

## 验收

- typecheck 0 错；全测绿（含新契约）。
- CDP：添加项两态（滚轮时间/直接创建+下一步）、事件新表单、闹钟全屏 UI
  （web 可拍路由态）、trip/new 对齐态——双主题实拍逐图过。
- 真机清单（交用户）：后台到点跳回+响铃、停止即静音、锁屏呈现。
