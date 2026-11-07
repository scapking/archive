import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import {
    FullscreenImageViewer,
    FullscreenVideoViewer,
    notifyViewerMounted,
    safeBack,
    useViewerRequest,
} from '@/features/archive';

/**
 * 全屏媒体查看路由（透明模态）：root Stack 上的 transparentModal 屏——
 * 渲染在 (tabs) 之上的窗口级容器，根治「tab 屏内全屏层盖不住 tabBar 条带」
 * （BottomTabView screens 容器裁剪 + tabBar 后绘，屏内覆盖层无解，Android 尤甚）。
 *
 * 载荷经 viewer-request 中立层传递而非路由参数：fileKey 等结构化字段 URL 化
 * 会制造「可直达但无上下文」的查看器深链，且 blob 解析前的 key 无路由语义。
 * 手势缩放/双击/下滑关闭由复用的 fullscreen-viewer 组件承担；关闭统一
 * router.back()（关闭钮 / 下滑 / Android 返回键三条路同源，见 closingRef）。
 */
export default function ViewerRoute() {
    const router = useRouter();
    const request = useViewerRequest();
    // 关闭幂等闸：下滑关闭与返回键 / 关闭钮竞态时只 pop 一层——透明模态下
    // 第二次 back 会把下层屏一起弹走，这里把重复 onClose 变成无害空操作
    const closingRef = useRef(false);

    useEffect(() => {
        // 挂载回执：解除 requestViewer 的 push 去重握手（连点防护窗口收口）
        notifyViewerMounted();
    }, []);

    // 无请求到达（深链直连 /viewer）：立即返回，不留空黑屏
    useEffect(() => {
        if (!request) safeBack();
    }, [request]);

    if (!request) return null;

    const close = () => {
        if (closingRef.current) return;
        closingRef.current = true;
        router.back();
    };

    return request.kind === 'video' ? (
        <FullscreenVideoViewer fileKey={request.fileKey} onClose={close} />
    ) : (
        <FullscreenImageViewer fileKey={request.fileKey} onClose={close} />
    );
}
