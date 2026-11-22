import { safeStorageGet, safeStorageSet } from './storage.js?v=workspace-20261122b';

const KEY = 'gxNewsReadingV1';
export const BOOKMARK_LIMIT = 200;
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 180 && !['__proto__','constructor','prototype'].includes(key);
const TECH_DOT_COLORS = new Set(['bg-purple-400', 'bg-amber-400', 'bg-sky-400']);

function sanitizeTechData(value) {
    if (!value || typeof value !== 'object') return null;
    const rawSections = Array.isArray(value.sections) ? value.sections.slice(0, 6) : [];
    const sections = rawSections.map(section => ({
        label: String(section?.label || '').slice(0, 80),
        compact: Boolean(section?.compact),
        items: (Array.isArray(section?.items) ? section.items.slice(0, 30) : []).map(item => ({
            rank: String(item?.rank || '').slice(0, 12),
            title: String(item?.title || '').slice(0, 300),
            url: String(item?.url || '').slice(0, 2000),
            ...(item?.stars !== undefined ? { stars: String(item.stars).slice(0, 20) } : {}),
            ...(item?.raw_stars !== undefined ? { raw_stars: Number(item.raw_stars) || 0 } : {}),
            ...(item?.desc_en ? { desc_en: String(item.desc_en).slice(0, 300) } : {}),
            ...(item?.desc_zh ? { desc_zh: String(item.desc_zh).slice(0, 300) } : {}),
        })),
    }));
    return {
        brand: String(value.brand || '').slice(0, 80),
        dot_color: TECH_DOT_COLORS.has(value.dot_color) ? value.dot_color : 'bg-sky-400',
        sections,
    };
}

export function sanitizeReadingState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const read = Object.fromEntries(Object.entries(source.read || {}).filter(([key, timestamp]) => validKey(key) && Number.isFinite(timestamp) && timestamp > 0).sort((a,b) => b[1]-a[1]).slice(0,10000));
    const saved = {};
    for (const [key, entry] of Object.entries(source.saved || {}).slice(0,BOOKMARK_LIMIT)) {
        if (!entry || typeof entry !== 'object' || !validKey(key) || !entry.content) continue;
        const format = entry.format === 'html' ? 'html' : entry.format === 'tech' ? 'tech' : 'text';
        const techData = format === 'tech' ? sanitizeTechData(entry.tech_data) : null;
        saved[key] = {
            _clientKey: key, id: String(entry.id || '').slice(0,160),
            content: String(entry.content).slice(0,60000), summary: String(entry.summary || '').slice(0,3000),
            display_content: String(entry.display_content || '').slice(0,60000), importance_reason: String(entry.importance_reason || '').slice(0,300),
            source: String(entry.source || '').slice(0,80), category: String(entry.category || 'news').slice(0,30),
            raw_time: Number(entry.raw_time) || 0, time: String(entry.time || '').slice(0,30),
            url: String(entry.url || '').slice(0,2000), format,
            ...(techData ? { tech_data: techData } : {}),
            forum_category: String(entry.forum_category || '').slice(0,100), is_important: Boolean(entry.is_important),
        };
    }
    return {read,saved};
}

let state;
try { state = sanitizeReadingState(JSON.parse(safeStorageGet(KEY,'{}'))); }
catch { state = sanitizeReadingState({}); }

function persist(key, kind) {
    state = sanitizeReadingState(state);
    safeStorageSet(KEY,JSON.stringify(state));
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gx:reading-changed',{detail:{key,kind}}));
}
export const isRead = key => Object.hasOwn(state.read,key);
export const isSaved = key => Object.hasOwn(state.saved,key);
export const countSavedMatching = predicate => Object.values(state.saved).reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);
export const savedNews = () => Object.values(state.saved).map(item=>({...item})).sort((a,b)=>b.raw_time-a.raw_time);
export const getReadSnapshot = () => ({ ...state.read });
export function restoreReadSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    state.read = sanitizeReadingState({ read: snapshot, saved: {} }).read;
    persist('', 'read');
}
export function exportReadingState() {
    return {
        read: { ...state.read },
        saved: Object.fromEntries(Object.entries(state.saved).map(([k, v]) => [k, { ...v }])),
    };
}
export function importReadingState(payload) {
    const clean = sanitizeReadingState(payload);
    state = {
        read: { ...state.read, ...clean.read },
        saved: { ...state.saved, ...clean.saved },
    };
    persist('', 'saved');
    return { readCount: Object.keys(state.read).length, savedCount: Object.keys(state.saved).length };
}
export function markRead(key, read=true) {
    if (!validKey(key)) return;
    if (isRead(key) === read) return;
    if (read) state.read[key] = Date.now();
    else delete state.read[key];
    persist(key,'read');
}
export function markAllRead(items) {
    for(const item of items) if(validKey(item._clientKey)) state.read[item._clientKey] = Date.now();
    persist('', 'read');
}
export function toggleSaved(news) {
    const key = news._clientKey;
    if (!validKey(key)) return false;
    if (isSaved(key)) delete state.saved[key];
    else {
        if (Object.keys(state.saved).length >= BOOKMARK_LIMIT) return false;
        state.saved[key] = {...news};
    }
    persist(key,'saved');
    return true;
}
if (typeof window !== 'undefined') {
    window.addEventListener('storage',event=>{
        if(event.key !== KEY) return;
        try {state=sanitizeReadingState(JSON.parse(event.newValue||'{}'));window.dispatchEvent(new CustomEvent('gx:reading-changed',{detail:{key:'',kind:'saved'}}));} catch { /* Keep current reading state if another tab writes invalid data. */ }
    });
}
