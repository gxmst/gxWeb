import { safeStorageGet, safeStorageSet } from './storage.js';

const KEY = 'gxNewsReadingV1';
export const BOOKMARK_LIMIT = 200;
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 180 && !['__proto__','constructor','prototype'].includes(key);

export function sanitizeReadingState(value) {
    const source = value && typeof value === 'object' ? value : {};
    const read = Object.fromEntries(Object.entries(source.read || {}).filter(([key, timestamp]) => validKey(key) && Number.isFinite(timestamp) && timestamp > 0).sort((a,b) => b[1]-a[1]).slice(0,5000));
    const saved = {};
    for (const [key, entry] of Object.entries(source.saved || {}).slice(0,BOOKMARK_LIMIT)) {
        if (!entry || typeof entry !== 'object' || !validKey(key) || !entry.content) continue;
        saved[key] = {
            _clientKey: key, id: String(entry.id || '').slice(0,160),
            content: String(entry.content).slice(0,60000), summary: String(entry.summary || '').slice(0,3000),
            display_content: String(entry.display_content || '').slice(0,60000), importance_reason: String(entry.importance_reason || '').slice(0,300),
            source: String(entry.source || '').slice(0,80), category: String(entry.category || 'news').slice(0,30),
            raw_time: Number(entry.raw_time) || 0, time: String(entry.time || '').slice(0,30),
            url: String(entry.url || '').slice(0,2000), format: entry.format === 'html' ? 'html' : 'text',
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
    window.dispatchEvent(new CustomEvent('gx:reading-changed',{detail:{key,kind}}));
}
export const isRead = key => Object.hasOwn(state.read,key);
export const isSaved = key => Object.hasOwn(state.saved,key);
export const savedNews = () => Object.values(state.saved).map(item=>({...item})).sort((a,b)=>b.raw_time-a.raw_time);
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
window.addEventListener('storage',event=>{
    if(event.key !== KEY) return;
    try {state=sanitizeReadingState(JSON.parse(event.newValue||'{}'));window.dispatchEvent(new CustomEvent('gx:reading-changed',{detail:{key:'',kind:'saved'}}));} catch { /* Keep current reading state if another tab writes invalid data. */ }
});
