const LABELS = {fast:'行情与财经快讯',nodeseek:'NodeSeek',linuxdo:'Linux DO',rss:'海外 RSS',tech:'科技聚合',weather:'天气缓存',wallpaper_list:'壁纸列表'};
let current = null;
let unlocked = false;
let enabled = false;
let busy = false;

async function request(path,payload) {
    const response = await fetch(`./api/admin/${path}`,payload ? {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-GXWeb-Request':'1'},body:JSON.stringify(payload)} : {cache:'no-store',credentials:'same-origin'});
    let result;
    try { result = await response.json(); } catch {throw new Error('管理接口暂不可用');}
    if(!response.ok) {if(response.status === 401) unlocked=false;throw new Error(result.error || '管理请求失败');}
    return result;
}

export function initAdminSettings() {
    const details = document.getElementById('crawlerAdmin');
    const status = document.getElementById('adminStatus');
    const fields = document.getElementById('crawlerIntervalFields');
    const login = document.getElementById('adminLoginForm');
    const save = document.getElementById('adminSave');
    const reload = document.getElementById('adminReload');
    const logout = document.getElementById('adminLogout');
    const password = document.getElementById('adminPassword');
    const unlock = document.getElementById('adminUnlock');
    function sync() {
        login.hidden = unlocked || !enabled;
        logout.hidden = !unlocked;
        save.disabled = !unlocked || busy;
        reload.disabled = busy;
        unlock.disabled = busy;
        fields.querySelectorAll('select').forEach(select=>{select.disabled = !unlocked || busy;});
    }
    function render(data) {
        fields.replaceChildren();
        for(const [key,label] of Object.entries(LABELS)) {
            const row = document.createElement('label'); row.className = 'settings-field-row';
            const text = document.createElement('span'); text.textContent = label;
            const select = document.createElement('select'); select.dataset.interval = key; select.id=`crawler-${key}`;
            select.setAttribute('aria-label',`${label}抓取间隔`);
            const [low,high] = data.bounds[key];
            const options = new Set([60,120,300,600,900,1800,3600,7200,21600,43200,86400,data.settings.intervals[key]]);
            for(const seconds of [...options].sort((a,b)=>a-b)) if(seconds>=low && seconds<=high) {
                const option=document.createElement('option');option.value=String(seconds);option.textContent = seconds>=3600 ? `${seconds/3600} 小时` : `${seconds/60} 分钟`;select.appendChild(option);
            }
            select.value=String(data.settings.intervals[key]);row.append(text,select);fields.appendChild(row);
        }
    }
    async function run(action) {
        if(busy) return;
        busy=true;sync();
        try {await action();} catch(error) {status.textContent=error.message;} finally {busy=false;sync();}
    }
    async function load() {
        status.textContent='读取中…';
        const data=await request('status');current=data.settings;unlocked=data.authenticated;enabled=data.enabled;render(data);
        status.textContent = !enabled ? '服务器尚未启用管理密码，当前只能查看频率。' : unlocked ? '已解锁，可修改服务器抓取频率。' : '输入管理密码后可修改频率。';
    }
    details.addEventListener('toggle',()=>{if(details.open) run(load);});
    reload.addEventListener('click',()=>run(load));
    login.addEventListener('submit',event=>{
        event.preventDefault();
        const value=password.value;password.value='';
        run(async()=>{await request('login',{password:value});await load();});
    });
    save.addEventListener('click',()=>run(async()=>{
        const intervals=Object.fromEntries([...fields.querySelectorAll('select')].map(select=>[select.dataset.interval,Number(select.value)]));
        const result=await request('settings',{intervals,revision:current.revision});current=result.settings;
        status.textContent='已保存。调度会在 30 秒内读取，按新间隔执行；正在运行的抓取会正常完成。';
    }));
    logout.addEventListener('click',()=>run(async()=>{await request('logout',{});unlocked=false;status.textContent='已锁定，继续修改需要管理密码。';}));
    sync();
}
