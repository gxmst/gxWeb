// ============ 壁纸收藏夹持久层（IndexedDB） ============
// 为什么不只存路径：后端 bg_0..bg_4.jpg 是「今日必应前 5 张」的滚动窗口，
// 文件名固定但内容每天整体前移，5 天后彻底消失。存路径等于收藏了一个格子而不是一张图。
// 所以收藏时把图片字节整份留在本地，收藏夹从此与服务器解耦、永久有效。
//
// 两个 store 分工：
//   meta —— 缩略图(dataURL)、尺寸、取色、来源、时间。列表/设置页只读它，几百 KB 级。
//   blob —— 原图字节。只有真正要显示那一张时才按 id 取，避免把十几 MB 全拉进内存。
// 两者同 id、同事务写入，保证不会出现「有元数据没图」。

const DB_NAME = 'gxWallpapers';
const DB_VERSION = 1;
const META_STORE = 'meta';
const BLOB_STORE = 'blob';

export const FAVORITE_LIMIT = 24;

let dbPromise = null;
let available = true;

function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB 不可用'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
            if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
        request.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
    }).catch(error => {
        available = false;
        dbPromise = null;
        throw error;
    });
    return dbPromise;
}

// 隐私模式 / 禁用存储的浏览器里整个收藏夹功能静默降级，不影响壁纸轮换本身。
export function favoritesAvailable() {
    return available;
}

function runTransaction(storeNames, mode, work) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
        const transaction = db.transaction(storeNames, mode);
        let outcome;
        transaction.oncomplete = () => resolve(outcome);
        transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务中止'));
        try {
            outcome = work(transaction);
        } catch (error) {
            transaction.abort();
            reject(error);
        }
    }));
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// 列出全部收藏元数据，最近收藏的排在前面。
export async function listFavorites() {
    try {
        // runTransaction 用 resolve(outcome) 交出结果；outcome 是 promise 时外层自动 adopt，
        // 所以这里 await 一次拿到的就是数组本身。
        const items = await runTransaction([META_STORE], 'readonly', transaction =>
            requestResult(transaction.objectStore(META_STORE).getAll()));
        return (Array.isArray(items) ? items : [])
            .filter(item => item && item.id)
            .sort((a, b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
    } catch {
        return [];
    }
}

export async function getFavoriteBlob(id) {
    try {
        const blob = await runTransaction([BLOB_STORE], 'readonly', transaction =>
            requestResult(transaction.objectStore(BLOB_STORE).get(String(id))));
        return blob instanceof Blob ? blob : null;
    } catch {
        return null;
    }
}

// 写入一张收藏。id 用图片指纹（见 wallpaper.js 的 fingerprint），天然去重：
// 同一张图无论出现在 bg_1 还是 bg_3、被收藏几次，都只占一条。
export async function putFavorite(meta, blob) {
    if (!meta?.id || !(blob instanceof Blob)) throw new Error('收藏参数不完整');
    const record = {
        id: String(meta.id),
        thumbnail: String(meta.thumbnail || ''),
        width: Number(meta.width) || 0,
        height: Number(meta.height) || 0,
        bytes: blob.size,
        type: blob.type || 'image/jpeg',
        theme: meta.theme && typeof meta.theme === 'object' ? meta.theme : null,
        origin: String(meta.origin || ''),
        addedAt: Date.now(),
    };
    await runTransaction([META_STORE, BLOB_STORE], 'readwrite', transaction => {
        transaction.objectStore(META_STORE).put(record);
        transaction.objectStore(BLOB_STORE).put(blob, record.id);
    });
    return record;
}

export async function deleteFavorite(id) {
    const key = String(id);
    await runTransaction([META_STORE, BLOB_STORE], 'readwrite', transaction => {
        transaction.objectStore(META_STORE).delete(key);
        transaction.objectStore(BLOB_STORE).delete(key);
    });
}

export async function clearFavorites() {
    await runTransaction([META_STORE, BLOB_STORE], 'readwrite', transaction => {
        transaction.objectStore(META_STORE).clear();
        transaction.objectStore(BLOB_STORE).clear();
    });
}

// 预热连接：启动时调用一次，让首次收藏不必等建库。失败即标记不可用。
export async function initFavorites() {
    try {
        await openDatabase();
        return true;
    } catch {
        return false;
    }
}
