// ============ 控制中心瞬时提示 ============
// 左上角按钮（滤镜 / 壁纸收藏）共用同一条 toast，避免各自维护定时器与 DOM 查询。
let toastTimer = null;

export function showControlToast(text, duration = 1400) {
    const toast = document.getElementById('controlToast');
    if (!toast) return;
    toast.textContent = text;
    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('show'), duration);
}
