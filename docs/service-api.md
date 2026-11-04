# service 接口调用文档

通用网络传输层，与业务无关——**URL 与鉴权由外部注入，连接/关闭由外部驱动**。全部 Promise/事件驱动、三端一致；错误契约见 [standards/error-handling.md](standards/error-handling.md)。统一从 `@/service` 入口导入。

## post — 通用 POST 封装

JSON 收发 + 超时（默认 15s）；非 2xx 抛 `post/http`，网络失败/超时抛 `post/network`（retryable）。响应体优先 JSON.parse，非 JSON 保留原始文本。

```ts
import { post } from '@/service';
const { status, data } = await post<Resp>('https://api.example.com/channels/', body, {
    headers: { key: '…' },   // 鉴权头由调用方注入
    timeoutMs: 15_000,
});
```

## socket — 通用 WebSocket（ws/wss）

工厂式创建：URL 与鉴权头由调用方注入；`connect()`/`close()` 由外部驱动（幂等）。断线自动重连（0.4s 起指数退避，封顶 1–4s 随机）；连接中 `send` 进有界离箱队列（100 条）自动冲刷；未建立连接时 `send` 抛 `socket/closed`。接收统一 JSON.parse。

```ts
import { createSocket } from '@/service';
const socket = createSocket({ url: 'wss://…', headers: { key: '…' } });
socket.onMessage((message) => {…});   // 收到的 JSON（已 parse）
socket.onState((state) => {…});       // 'connecting' | 'open' | 'closed'
socket.connect();
socket.send({ action: 'chat.send', … });  // 任意 JSON
socket.close();                        // 出口：停止重连、清空队列
```

> 平台差异：native 走 WebSocket 自定义头；web 不允许自定义头，`headers` 被忽略——需要鉴权时调用方把凭据拼入 URL（见 [platform-parity.md](platform-parity.md)）。
