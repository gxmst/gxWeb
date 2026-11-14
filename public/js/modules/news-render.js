// ================== 新闻流 DOM 渲染构造 ==================
import {
    formatCommunityTime,
    newsRenderSignature,
    normalizeNewsDisplayText,
    sanitizeHttpUrl,
    sourceLabel,
} from './news-logic.js?v=workspace-20261114b';

const MARKET_MOVE_REGEX = /([+-]\d+(?:\.\d+)?%|(?:上涨|下跌|涨超|跌超|涨幅|跌幅)\s*\d+(?:\.\d+)?%)/g;
const TECH_DOT_COLORS = new Set(['bg-purple-400', 'bg-amber-400', 'bg-sky-400']);

export function emptyMessage(text) {
    const empty = document.createElement('div');
    empty.className = 'text-center text-white/30 mt-10 text-sm';
    empty.textContent = text;
    return empty;
}

export function createGroupSeparator(label, count) {
    const row = document.createElement('div');
    row.className = 'news-group-sep';
    row.dataset.groupSep = label;
    const text = document.createElement('span');
    text.textContent = label;
    row.appendChild(text);
    if (count > 0) {
        const badge = document.createElement('span');
        badge.className = 'news-group-count';
        badge.textContent = String(count);
        row.appendChild(badge);
    }
    return row;
}

export function createLoadMoreButton(total, visibleLimit, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'news-load-more mx-auto mt-4 mb-2 min-h-10 rounded-lg border border-white/10 bg-white/5 px-4 text-xs text-white/70 transition-colors hover:bg-white/10 hover:text-white';
    button.textContent = `显示更多（剩余 ${Math.max(0, total - visibleLimit)} 条）`;
    button.addEventListener('click', onClick);
    return button;
}

export function appendFormattedNewsText(target, text) {
    const str = String(text || '');
    let lastIndex = 0;
    MARKET_MOVE_REGEX.lastIndex = 0;
    let match;
    while ((match = MARKET_MOVE_REGEX.exec(str)) !== null) {
        if (match.index > lastIndex) {
            target.appendChild(document.createTextNode(str.slice(lastIndex, match.index)));
        }
        const token = match[0];
        const isDown = token.startsWith('-') || token.includes('跌');
        const span = document.createElement('span');
        span.className = isDown ? 'news-num-down' : 'news-num-up';
        span.textContent = token;
        target.appendChild(span);
        lastIndex = MARKET_MOVE_REGEX.lastIndex;
    }
    if (lastIndex < str.length) {
        target.appendChild(document.createTextNode(str.slice(lastIndex)));
    }
}

export function createTechContentElement(techData) {
    const fragment = document.createDocumentFragment();
    const header = document.createElement('div');
    header.className = 'tech-block-header';
    const dot = document.createElement('span');
    const dotColor = TECH_DOT_COLORS.has(techData.dot_color) ? techData.dot_color : 'bg-sky-400';
    dot.className = `tech-brand-dot ${dotColor}`;
    const brand = document.createElement('span');
    brand.textContent = String(techData.brand || '');
    header.append(dot, brand);
    fragment.appendChild(header);

    const sections = Array.isArray(techData.sections) ? techData.sections : [];
    for (const section of sections) {
        if (section.label) {
            const label = document.createElement('div');
            label.className = 'tech-section-label';
            label.textContent = String(section.label);
            fragment.appendChild(label);
        }
        const list = document.createElement('div');
        list.className = 'tech-card-list';
        const items = Array.isArray(section.items) ? section.items : [];
        const compact = Boolean(section.compact);

        for (const item of items) {
            const card = document.createElement('div');
            card.className = compact ? 'tech-card-item tech-card-compact' : 'tech-card-item';

            const top = document.createElement('div');
            top.className = 'tech-card-top';
            const rank = document.createElement('span');
            rank.className = 'tech-rank';
            rank.textContent = String(item.rank || '');
            top.appendChild(rank);

            const href = sanitizeHttpUrl(item.url);
            const linkClass = compact ? 'tech-title-link font-normal' : 'tech-title-link';
            if (href) {
                const link = document.createElement('a');
                link.href = href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.className = linkClass;
                link.textContent = String(item.title || '');
                top.appendChild(link);
            } else {
                const title = document.createElement('span');
                title.className = linkClass;
                title.textContent = String(item.title || '');
                top.appendChild(title);
            }

            if (item.stars) {
                const stars = document.createElement('span');
                stars.className = 'tech-star-pill';
                const rawStars = Number(item.raw_stars);
                if (Number.isFinite(rawStars) && rawStars >= 0) {
                    stars.title = `${rawStars} Stars`;
                }
                stars.textContent = `★ ${item.stars}`;
                top.appendChild(stars);
            }

            card.appendChild(top);
            if (item.desc_en) {
                const descEn = document.createElement('div');
                descEn.className = 'tech-desc-en';
                descEn.textContent = String(item.desc_en);
                card.appendChild(descEn);
            }
            if (item.desc_zh && item.desc_zh !== item.desc_en) {
                const descZh = document.createElement('div');
                descZh.className = 'tech-desc-zh';
                descZh.textContent = String(item.desc_zh);
                card.appendChild(descZh);
            }
            list.appendChild(card);
        }
        fragment.appendChild(list);
    }
    return fragment;
}

export function createNewsElement(news, {
    isNew = false,
    fontSize = 'sm',
    shouldReveal = true,
    observeReveal = null,
    onMarkRead = null,
    onToggleSave = null,
    summaryExpanded = false,
} = {}) {
    const isCommunity = news.category === 'community';
    const fs = fontSize === 'sm' ? 'text-sm' : (fontSize === 'base' ? 'text-base' : 'text-lg');
    const item = document.createElement('div');
    const header = document.createElement('div');
    const body = document.createElement('div');
    const displayText = normalizeNewsDisplayText(news);
    const safeUrl = sanitizeHttpUrl(news.url);
    const importantClass = news.is_important ? ' is-important' : '';

    item.className = `news-feed-item${importantClass} py-2` + (isCommunity ? ' community-item' : '')
        + (isNew ? ' animate-slide-down' : '');
    item.dataset.newsKey = news._clientKey;
    item.dataset.newsSignature = newsRenderSignature(news, fontSize);
    if (shouldReveal && observeReveal) observeReveal(item);
    else item.classList.add('in-view');

    header.className = 'text-[11px] text-white/45 font-mono mb-0.5 flex flex-wrap items-center gap-1.5';
    const time = document.createElement('span');
    time.textContent = isCommunity ? formatCommunityTime(news) : news.time || '';
    if (time.textContent) header.appendChild(time);
    if (news.source) {
        const source = document.createElement('span');
        source.className = 'news-source-badge';
        source.textContent = sourceLabel(news.source);
        header.appendChild(source);
    }
    if (news.is_important) {
        const badge = document.createElement('span');
        const reason = String(news.importance_reason || '').trim();
        badge.className = 'news-important-badge';
        badge.textContent = reason ? `重要 · ${reason}` : '重要';
        const score = Number(news.importance_score);
        badge.title = Number.isFinite(score) && score > 0 ? `重要性 ${score} 分` : '重要快讯';
        header.appendChild(badge);
    }

    body.className = `${fs} leading-relaxed text-white/90 drop-shadow-sm tech-content news-readable`;
    if (news.format === 'tech' && news.tech_data) {
        body.appendChild(createTechContentElement(news.tech_data));
    } else if (news.format === 'html') {
        const rawHtml = String(news.content || '').replace(
            /^HN Trends(?=<div)/,
            '<div class="tech-block-header"><span class="tech-brand-dot bg-amber-400"></span><span>Hacker News</span></div>'
        );
        body.innerHTML = DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target', 'rel'] });
        // 兼容旧版缓存：消除旧 HTML 块里的 group-hover 手风琴折叠，防止悬停高度抖动
        body.querySelectorAll('.max-h-0.opacity-0').forEach(el => {
            el.classList.remove('overflow-hidden', 'max-h-0', 'opacity-0', 'group-hover:max-h-24', 'group-hover:max-h-20', 'group-hover:opacity-100');
            el.classList.add('tech-desc-zh');
        });
        body.querySelectorAll('a').forEach(a => {
            const href = sanitizeHttpUrl(a.getAttribute('href'));
            if (!href) {
                a.removeAttribute('href');
                a.removeAttribute('target');
                a.removeAttribute('rel');
                return;
            }
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
        });
    } else if (safeUrl) {
        const link = document.createElement('a');
        link.href = safeUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'news-link';
        appendFormattedNewsText(link, displayText);
        body.appendChild(link);
    } else {
        appendFormattedNewsText(body, displayText);
    }

    if (news.forum_category) {
        const category = document.createElement('span');
        category.className = 'news-source-badge';
        category.textContent = news.forum_category;
        header.appendChild(category);
    }

    const actions = document.createElement('span');
    actions.className = 'news-item-actions';
    const readButton = document.createElement('button');
    readButton.type = 'button';
    readButton.dataset.markRead = '';
    readButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
    readButton.addEventListener('click', () => onMarkRead?.(news));
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.dataset.saveNews = '';
    saveButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/></svg>';
    saveButton.addEventListener('click', () => onToggleSave?.(news));
    actions.append(readButton, saveButton);
    header.appendChild(actions);

    item.append(header, body);
    if (isCommunity && news.summary) {
        const summary = document.createElement('p');
        summary.className = 'community-summary';
        summary.textContent = news.summary;
        let hoverTimer;
        const syncSummary = expanded => {
            summary.classList.toggle('is-expanded', expanded);
            summary.setAttribute('aria-expanded', String(expanded));
        };
        syncSummary(summaryExpanded);
        const toggleSummary = () => {
            if (summary.dataset.summaryTruncated !== 'true') return;
            clearTimeout(hoverTimer);
            syncSummary(!summary.classList.contains('is-expanded'));
        };
        summary.addEventListener('pointerenter', event => {
            if (event.pointerType !== 'mouse' || summary.dataset.summaryTruncated !== 'true') return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                if (summary.isConnected) syncSummary(true);
            }, 150);
        });
        summary.addEventListener('pointerleave', event => {
            if (event.pointerType !== 'mouse' || summary.dataset.summaryTruncated !== 'true') return;
            clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                if (summary.isConnected) syncSummary(false);
            }, 150);
        });
        summary.addEventListener('pointerup', event => {
            if (event.pointerType === 'touch' || event.pointerType === 'pen') toggleSummary();
        });
        summary.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggleSummary();
        });
        // 屏幕阅读器的按钮激活通常没有 pointer 事件。
        summary.addEventListener('click', event => { if (event.detail === 0) toggleSummary(); });
        item.append(summary);
    }
    return item;
}

// 短摘要保持普通文本；长摘要可悬停、触摸或通过键盘展开。
export function refreshCommunitySummaries(root) {
    root?.querySelectorAll('.community-summary').forEach(summary => {
        const expanded = summary.classList.contains('is-expanded');
        const truncated = expanded || summary.scrollHeight > summary.clientHeight + 1;
        summary.dataset.summaryTruncated = String(truncated);
        if (truncated) {
            summary.setAttribute('role', 'button');
            summary.tabIndex = 0;
            summary.setAttribute('aria-expanded', String(expanded));
        } else {
            summary.removeAttribute('role');
            summary.removeAttribute('tabindex');
            summary.removeAttribute('aria-expanded');
        }
    });
}
