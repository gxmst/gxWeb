// ================== 数据管线健康状态 ==================
const STATUS_POLL_INTERVAL = 60000;
const JOB_LABELS = {
    heartbeat: '进程心跳',
    ticker: '行情',
    sina: '新浪快讯',
    finance_news: '资讯发布',
    wallpaper: '壁纸下载',
    weather: '天气',
    wallpaper_list: '壁纸列表',
    rss: '海外 RSS',
    tech: '科技聚合',
};

const sourceStates = { news: 'loading', ticker: 'loading', pipeline: 'loading' };
let statusPollTimer = null;

function relativeTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '尚无成功记录';
    const seconds = Math.max(0, Math.round(Date.now() / 1000 - value));
    if (seconds < 60) return '刚刚';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
}

function updateSummary() {
    const text = document.getElementById('systemStatusText');
    const dot = document.getElementById('systemStatusDot');
    if (!text || !dot) return;
    const states = Object.values(sourceStates);
    let kind = 'online';
    if (states.includes('offline')) kind = 'offline';
    else if (states.includes('degraded')) kind = 'degraded';
    else if (states.includes('loading')) kind = 'loading';
    else if (states.includes('paused')) kind = 'paused';
    const config = {
        online: { label: '运行正常', color: 'bg-green-500' },
        paused: { label: '刷新暂停', color: 'bg-amber-500' },
        loading: { label: '检查中', color: 'bg-amber-400' },
        degraded: { label: '部分降级', color: 'bg-amber-500' },
        offline: { label: '数据异常', color: 'bg-red-500' },
    }[kind];
    text.textContent = config.label;
    dot.className = `h-2 w-2 rounded-full ${config.color}`;
}

function jobState(job) {
    if (job?.running) return 'loading';
    if (job?.last_error) return 'offline';
    if (job?.last_success) return 'online';
    return 'loading';
}

function renderPipelineJobs(data) {
    const list = document.getElementById('pipelineJobList');
    if (!list) return;
    const jobs = data?.jobs && typeof data.jobs === 'object' ? data.jobs : {};
    const fragment = document.createDocumentFragment();
    Object.keys(JOB_LABELS).forEach(name => {
        const job = jobs[name] || {};
        const state = jobState(job);
        const card = document.createElement('div');
        card.className = 'pipeline-job';
        if (job.last_error) card.title = String(job.last_error);

        const heading = document.createElement('div');
        heading.className = 'flex items-center justify-between gap-2';
        const label = document.createElement('span');
        label.className = 'truncate text-white/75';
        label.textContent = JOB_LABELS[name];
        const dot = document.createElement('span');
        dot.className = `h-1.5 w-1.5 shrink-0 rounded-full ${state === 'online' ? 'bg-green-500' : state === 'offline' ? 'bg-red-500' : 'bg-amber-400'}`;
        heading.append(label, dot);

        const meta = document.createElement('div');
        meta.className = 'mt-1 truncate text-[9px] text-white/35';
        if (job.running) meta.textContent = '运行中';
        else if (job.last_error) meta.textContent = '最近运行失败';
        else meta.textContent = `${relativeTime(job.last_success)}${job.count ? ` · ${job.count} 条` : ''}`;
        card.append(heading, meta);
        fragment.appendChild(card);
    });
    list.replaceChildren(fragment);
}

async function fetchPipelineStatus() {
    try {
        const response = await fetch('./pipeline-status.json', { cache: 'no-cache' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const age = Number(data.updated_at) ? Date.now() / 1000 - Number(data.updated_at) : Infinity;
        const jobs = data.jobs && typeof data.jobs === 'object' ? Object.values(data.jobs) : [];
        sourceStates.pipeline = age > 600
            ? 'offline'
            : jobs.some(job => job?.last_error) ? 'degraded' : 'online';
        const updated = document.getElementById('pipelineUpdatedAt');
        if (updated) updated.textContent = `更新于 ${relativeTime(data.updated_at)}`;
        renderPipelineJobs(data);
    } catch {
        sourceStates.pipeline = 'offline';
        const updated = document.getElementById('pipelineUpdatedAt');
        if (updated) updated.textContent = '状态不可用';
        renderPipelineJobs({ jobs: {} });
    }
    updateSummary();
}

export function initStatus() {
    const button = document.getElementById('systemStatusButton');
    const popover = document.getElementById('systemStatusPopover');
    if (popover && popover.parentElement !== document.body) document.body.appendChild(popover);
    const positionPopover = () => {
        if (!button || !popover || popover.hidden) return;
        const rect = button.getBoundingClientRect();
        const width = Math.min(320, window.innerWidth - 24);
        const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
        popover.style.left = `${left}px`;
        const height = popover.offsetHeight;
        const below = rect.bottom + 8;
        const above = rect.top - height - 8;
        popover.style.top = `${below + height <= window.innerHeight - 12 ? below : Math.max(12, above)}px`;
    };
    const setOpen = open => {
        if (!button || !popover) return;
        popover.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
        if (open) requestAnimationFrame(positionPopover);
    };
    button?.addEventListener('click', event => {
        event.stopPropagation();
        setOpen(popover?.hidden ?? true);
    });
    popover?.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') setOpen(false);
    });
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    window.addEventListener('gx:status-change', event => {
        const source = event.detail?.source;
        if (source === 'news' || source === 'ticker') {
            sourceStates[source] = event.detail?.kind || 'offline';
            updateSummary();
        }
    });

    const poll = async () => {
        if (document.hidden) return;
        await fetchPipelineStatus();
        if (!document.hidden) statusPollTimer = window.setTimeout(poll, STATUS_POLL_INTERVAL);
    };
    document.addEventListener('visibilitychange', () => {
        window.clearTimeout(statusPollTimer);
        statusPollTimer = null;
        if (!document.hidden) poll();
    });
    updateSummary();
    poll();
}
