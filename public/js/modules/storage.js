// ============ localStorage 安全访问 ============
// 隐私模式 / 被锁定的浏览器里 localStorage 可能抛异常，统一兜底，避免影响主流程。

export function safeStorageGet(key, fallback = '') {
    try {
        return localStorage.getItem(key) || fallback;
    } catch {
        return fallback;
    }
}

export function safeStorageSet(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage can be unavailable in private mode or locked-down browsers.
    }
}
