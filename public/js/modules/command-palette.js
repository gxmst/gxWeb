// ================== 全局命令面板（Ctrl/Cmd + K 或 ?） ==================
import {
    getSettings,
    isScreenSaver,
    isWidgetVisible,
    setScreenSaver,
    updateSettings,
} from './settings-store.js?v=workspace-20261122b';
import { loadNewsArchive, setFilter } from './news.js?v=workspace-20261122b';
import { toggleWallpaper } from './wallpaper.js?v=workspace-20261122b';

export function initCommandPalette() {
    const overlay = document.getElementById('commandPaletteOverlay');
    const dialog = document.getElementById('commandPaletteDialog');
    const input = document.getElementById('commandPaletteInput');
    const list = document.getElementById('commandPaletteList');
    if (!overlay || !dialog || !input || !list) return;

    let closeTimer = null;
    let activeIndex = 0;
    let filteredCommands = [];
    let previousFocus = null;

    function buildCommands() {
        const settings = getSettings();
        const isFull = settings.layout.newsPanelMode === 'full';
        const isSplit = (settings.layout.fullScreenLayout || 'split') === 'split';
        const saver = isScreenSaver();
        const powerSaving = Boolean(settings.appearance.powerSaving);

        return [
            {
                id: 'cat-all',
                label: '切换资讯分类：全部',
                group: '资讯',
                keywords: 'all news 全部 快讯',
                run: () => setFilter('all'),
            },
            {
                id: 'cat-news',
                label: '切换资讯分类：国内',
                group: '资讯',
                keywords: 'domestic sina 国内 财经',
                run: () => setFilter('news'),
            },
            {
                id: 'cat-foreign',
                label: '切换资讯分类：外媒',
                group: '资讯',
                keywords: 'foreign rss world 外媒',
                run: () => setFilter('foreign'),
            },
            {
                id: 'cat-tech',
                label: '切换资讯分类：科技',
                group: '资讯',
                keywords: 'tech github hn v2ex 科技',
                run: () => setFilter('tech'),
            },
            {
                id: 'cat-community',
                label: '切换资讯分类：社区订阅',
                group: '资讯',
                keywords: 'community forum nodeseek linuxdo 社区',
                run: () => setFilter('community'),
            },
            {
                id: 'toggle-full',
                label: isFull ? '还原资讯侧边栏' : '进入全屏阅读模式',
                group: '布局',
                shortcut: 'Enter',
                keywords: 'fullscreen reader 全屏 还原',
                run: () => {
                    if (!isWidgetVisible('news')) updateSettings('widgets', { news: true });
                    updateSettings('layout', isFull
                        ? { newsPanelMode: 'compact', newsPanelWidth: null }
                        : { newsPanelMode: 'full', newsPanelWidth: null });
                },
            },
            {
                id: 'toggle-split',
                label: isSplit ? '全屏布局：切换单栏居中' : '全屏布局：切换双栏对比',
                group: '布局',
                keywords: 'split single column 双栏 单栏',
                run: () => updateSettings('layout', {
                    newsPanelMode: 'full',
                    fullScreenLayout: isSplit ? 'single' : 'split',
                }),
            },
            {
                id: 'load-archive',
                label: '加载历史归档资讯',
                group: '资讯',
                keywords: 'archive history 历史 归档 昨天',
                run: () => loadNewsArchive(),
            },
            {
                id: 'focus-news-search',
                label: '搜索与筛选快讯 / 历史时间范围',
                group: '资讯',
                keywords: 'filter search date 搜索 筛选 历史',
                run: () => window.dispatchEvent(new CustomEvent('gx:focus-news-search')),
            },
            {
                id: 'focus-web-search',
                label: '聚焦网络搜索框',
                group: '导航',
                shortcut: '/',
                keywords: 'web search 搜索框',
                run: () => {
                    if (!isWidgetVisible('search')) updateSettings('widgets', { search: true });
                    document.getElementById('searchInput')?.focus();
                },
            },
            {
                id: 'next-wallpaper',
                label: '切换下一张壁纸',
                group: '视觉',
                keywords: 'wallpaper bg 壁纸 切换',
                run: () => toggleWallpaper(),
            },
            {
                id: 'fav-wallpaper',
                label: '收藏 / 取消收藏当前壁纸',
                group: '视觉',
                keywords: 'favorite heart 收藏 壁纸',
                run: () => document.getElementById('favoriteBtn')?.click(),
            },
            {
                id: 'cycle-filter',
                label: '切换天气氛围滤镜',
                group: '视觉',
                keywords: 'weather filter rain snow sun 滤镜 天气 雪 雨',
                run: () => document.getElementById('filterBtn')?.click(),
            },
            {
                id: 'toggle-power',
                label: powerSaving ? '关闭省电模式' : '开启省电模式',
                group: '视觉',
                keywords: 'power saving 省电 性能',
                run: () => updateSettings('appearance', { powerSaving: !powerSaving }),
            },
            {
                id: 'toggle-saver',
                label: saver ? '退出一键屏保' : '进入一键屏保',
                group: '工作台',
                keywords: 'screensaver quiet 屏保 极简',
                run: () => setScreenSaver(!saver),
            },
            {
                id: 'open-settings',
                label: '打开设置中心',
                group: '工作台',
                shortcut: 'S',
                keywords: 'settings preferences 设置 备份',
                run: () => {
                    setScreenSaver(false);
                    window.dispatchEvent(new CustomEvent('gx:open-settings'));
                },
            },
        ];
    }

    function renderList() {
        const query = input.value.trim().toLocaleLowerCase('zh-CN');
        const all = buildCommands();
        filteredCommands = query
            ? all.filter(cmd => `${cmd.label} ${cmd.group} ${cmd.keywords}`.toLocaleLowerCase('zh-CN').includes(query))
            : all;
        if (activeIndex >= filteredCommands.length) activeIndex = Math.max(0, filteredCommands.length - 1);

        list.replaceChildren();
        if (!filteredCommands.length) {
            const empty = document.createElement('div');
            empty.className = 'command-palette-empty';
            empty.textContent = '没有匹配的命令';
            list.appendChild(empty);
            return;
        }
        const fragment = document.createDocumentFragment();
        filteredCommands.forEach((cmd, idx) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'command-palette-item';
            btn.setAttribute('role', 'option');
            btn.setAttribute('aria-selected', String(idx === activeIndex));

            const left = document.createElement('span');
            left.className = 'command-palette-meta';
            const title = document.createElement('span');
            title.className = 'truncate';
            title.textContent = cmd.label;
            left.appendChild(title);

            const right = document.createElement('span');
            right.className = 'command-palette-meta';
            const group = document.createElement('span');
            group.className = 'command-palette-group';
            group.textContent = cmd.group;
            right.appendChild(group);
            if (cmd.shortcut) {
                const kbd = document.createElement('kbd');
                kbd.className = 'command-palette-kbd';
                kbd.textContent = cmd.shortcut;
                right.appendChild(kbd);
            }

            btn.append(left, right);
            btn.addEventListener('mouseenter', () => {
                activeIndex = idx;
                syncSelection();
            });
            btn.addEventListener('click', () => execute(cmd));
            fragment.appendChild(btn);
        });
        list.appendChild(fragment);
        syncSelection();
    }

    function syncSelection() {
        const items = list.querySelectorAll('.command-palette-item');
        items.forEach((item, idx) => {
            const selected = idx === activeIndex;
            item.setAttribute('aria-selected', String(selected));
            if (selected) item.scrollIntoView({ block: 'nearest' });
        });
    }

    function execute(cmd) {
        if (!cmd) return;
        close(false);
        cmd.run();
    }

    function open() {
        window.clearTimeout(closeTimer);
        previousFocus = document.activeElement;
        input.value = '';
        activeIndex = 0;
        overlay.hidden = false;
        renderList();
        requestAnimationFrame(() => {
            overlay.classList.add('open');
            input.focus();
        });
    }

    function close(restoreFocus = true) {
        if (overlay.hidden && !overlay.classList.contains('open')) return;
        window.clearTimeout(closeTimer);
        overlay.classList.remove('open');
        closeTimer = window.setTimeout(() => { overlay.hidden = true; }, 190);
        if (restoreFocus && previousFocus instanceof HTMLElement && previousFocus.getClientRects().length) {
            previousFocus.focus();
        }
    }

    input.addEventListener('input', () => {
        activeIndex = 0;
        renderList();
    });
    input.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (filteredCommands.length) {
                activeIndex = (activeIndex + 1) % filteredCommands.length;
                syncSelection();
            }
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (filteredCommands.length) {
                activeIndex = (activeIndex - 1 + filteredCommands.length) % filteredCommands.length;
                syncSelection();
            }
        } else if (event.key === 'Enter') {
            event.preventDefault();
            execute(filteredCommands[activeIndex]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close(true);
        }
    });

    overlay.addEventListener('click', event => {
        if (event.target === overlay) close(true);
    });

    document.addEventListener('keydown', event => {
        const isModK = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
        if (isModK) {
            event.preventDefault();
            if (overlay.hidden) open();
            else close(true);
            return;
        }
        const editing = event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]');
        if (!editing && event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            if (overlay.hidden) open();
        }
    });
}
