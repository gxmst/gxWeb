// ============ 全局瞬时提示与可撤销通知 ============
// 左上角按钮、阅读撤销、备份状态等共用同一条 toast，避免各自维护定时器与 DOM 查询。
let toastTimer = null;

export function showControlToast(text, durationOrOptions = 1400) {
    const toast = document.getElementById('controlToast');
    if (!toast) return;
    const opts = typeof durationOrOptions === 'object' && durationOrOptions !== null
        ? durationOrOptions
        : { duration: durationOrOptions };
    const hasAction = Boolean(opts.actionLabel && typeof opts.onAction === 'function');
    const duration = Number.isFinite(Number(opts.duration))
        ? Number(opts.duration)
        : (hasAction ? 4500 : 1400);

    toast.replaceChildren();
    const labelSpan = document.createElement('span');
    labelSpan.className = 'control-toast-text';
    labelSpan.textContent = String(text || '');
    toast.appendChild(labelSpan);

    toast.classList.toggle('has-action', hasAction);
    if (hasAction) {
        const actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'control-toast-action';
        actionBtn.textContent = String(opts.actionLabel);
        actionBtn.addEventListener('click', () => {
            window.clearTimeout(toastTimer);
            toast.classList.remove('show', 'has-action');
            opts.onAction();
        });
        toast.appendChild(actionBtn);
    }

    toast.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        toast.classList.remove('show', 'has-action');
    }, duration);
}
