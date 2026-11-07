import { router } from 'expo-router';

/**
 * 守卫式返回：Expo Go reload / 深链可能把任意屏播种成单屏栈（无退路），
 * 裸 router.back() 会派发未处理的 GO_BACK。有栈则退，无栈 replace 回首页
 * （anchor 的运行时兜底；正常从 tab push 进来的流不受影响）。
 */
export function safeBack(): void {
    if (router.canGoBack()) router.back();
    else router.replace('/');
}

/** 同 safeBack，但保留 router 实例以便调用方后续导航（如 back 后再 replace）。 */
export { router };
