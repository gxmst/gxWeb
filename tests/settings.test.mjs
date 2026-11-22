import test from 'node:test';
import assert from 'node:assert/strict';

const values = new Map([['gxSettingsV1', JSON.stringify({search: {engine: 'google'}, news: {autoRefresh: false}, appearance: {ripple: true}})]]);
globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
globalThis.window = new EventTarget();
window.localStorage = globalThis.localStorage;
const settings = await import('../public/js/modules/settings-store.js');
const panel = await import('../public/js/modules/news-panel.js');
const reading = await import('../public/js/modules/news-state.js');
const forecast = await import('../public/js/modules/forecast.js');
const weatherPhysics = await import('../public/js/modules/weather-physics.js');

test('existing preferences survive addition of widget and forum settings', () => {
    const initial = settings.getSettings();
    assert.equal(initial.search.engine, 'google');
    assert.equal(initial.news.autoRefresh, false);
    assert.equal(initial.widgets.news, true);
    assert.deepEqual(initial.news.hiddenSources, []);
    assert.deepEqual(initial.typography, { interfaceFont: 'modern', newsFont: 'inherit', clockFont: 'mono' });
    assert.equal(initial.layout.newsPanelMode, 'compact');
});

test('screen saver suppresses visibility and effects without persisting over preferences', () => {
    settings.updateSettings('widgets', { weather: false });
    const before = settings.getSettings();
    const stored = values.get('gxSettingsV1');
    settings.setScreenSaver(true);
    assert.equal(settings.isWidgetVisible('news'), false);
    assert.equal(settings.getEffectiveAppearance().ripple, false);
    assert.equal(settings.getEffectiveAppearance().powerSaving, true);
    assert.deepEqual(settings.getSettings(), before);
    assert.equal(values.get('gxSettingsV1'), stored);
    settings.setScreenSaver(false);
    assert.equal(settings.isWidgetVisible('weather'), false);
    assert.equal(settings.isWidgetVisible('news'), true);
    assert.equal(settings.getEffectiveAppearance().ripple, true);
});

test('all widgets off gives quiet scene, and restoring one exits it', () => {
    settings.updateSettings('widgets', Object.fromEntries(Object.keys(settings.DEFAULT_SETTINGS.widgets).map(key => [key, false])));
    assert.equal(settings.isQuietScene(), true);
    settings.updateSettings('widgets', { search: true });
    assert.equal(settings.isQuietScene(), false);
});

test('community preferences validate sources and persist separately from widget choices', () => {
    settings.updateSettings('news', { category: 'community', hiddenSources: ['nodeseek', 'nodeseek', 'invalid'] });
    assert.equal(settings.getSettings().news.category, 'community');
    assert.deepEqual(settings.getSettings().news.hiddenSources, ['nodeseek']);
    assert.equal(JSON.parse(values.get('gxSettingsV1')).widgets.weather, false);
});

test('forum source persists independently of the general news source and rejects unknown forums', () => {
    settings.updateSettings('news', { source: 'BBC', communitySource: 'linuxdo' });
    assert.equal(settings.getSettings().news.source, 'BBC');
    assert.equal(settings.getSettings().news.communitySource, 'linuxdo');
    assert.equal(JSON.parse(values.get('gxSettingsV1')).news.communitySource, 'linuxdo');
    settings.updateSettings('news', { communitySource: 'unknown' });
    assert.equal(settings.getSettings().news.communitySource, 'all');
    assert.equal(settings.getSettings().news.source, 'BBC');
    settings.updateSettings('news', { source: 'nodeseek', communitySource: 'unknown' });
    assert.equal(settings.getSettings().news.communitySource, 'all');
});

test('legacy community source migrates without filtering unrelated categories', async () => {
    const original = values.get('gxSettingsV1');
    try {
        values.set('gxSettingsV1', JSON.stringify({ news: { category: 'community', source: 'linuxdo' } }));
        const migrated = await import('../public/js/modules/settings-store.js?legacy-forum-source');
        assert.equal(migrated.getSettings().news.communitySource, 'linuxdo');
        assert.equal(migrated.getSettings().news.source, 'all');
    } finally {
        values.set('gxSettingsV1', original);
    }
});

test('typography choices persist and reject unknown font identifiers', () => {
    settings.updateSettings('typography', { interfaceFont: 'serif', newsFont: 'wenkai', clockFont: 'system' });
    assert.equal(JSON.parse(values.get('gxSettingsV1')).typography.newsFont, 'wenkai');
    settings.updateSettings('typography', { newsFont: 'url(unsafe)', clockFont: 'unknown' });
    assert.deepEqual(settings.getSettings().typography, { interfaceFont: 'serif', newsFont: 'inherit', clockFont: 'mono' });
});

test('saved width adapts to smaller screens while full mode covers the viewport', () => {
    assert.equal(panel.panelWidth({newsPanelMode: 'wide', newsPanelWidth: 1400}, 900), 852);
    assert.equal(panel.panelWidth({newsPanelMode: 'full'}, 390), 390);
    assert.equal(panel.panelWidth({newsPanelMode: 'compact'}, 1440), 450);
    settings.updateSettings('layout', {
        newsPanelMode: 'invalid',
        newsPanelWidth: 99999,
        fullScreenLayout: 'bogus',
        splitLeft: 'cat:invalid',
        splitRight: 'src:nodeseek',
        communitySplitLeft: 'cat:news',
        communitySplitRight: 'src:linuxdo',
    });
    assert.deepEqual(settings.getSettings().layout, {
        newsPanelMode: 'compact',
        newsPanelWidth: 10000,
        fullScreenLayout: 'split',
        splitLeft: 'cat:news',
        splitRight: 'src:nodeseek',
        communitySplitLeft: 'src:linuxdo',
        communitySplitRight: 'src:linuxdo',
    });
    settings.updateSettings('layout', { fullScreenLayout: 'single' });
    assert.equal(settings.getSettings().layout.fullScreenLayout, 'single');
});

test('pointer resize snaps to compact, wide and full reading', () => {
    assert.deepEqual(panel.finishPanelDrag(470,1440), {newsPanelMode:'compact',newsPanelWidth:null});
    assert.deepEqual(panel.finishPanelDrag(930,1440), {newsPanelMode:'wide',newsPanelWidth:930});
    assert.deepEqual(panel.finishPanelDrag(1280,1440), {newsPanelMode:'full',newsPanelWidth:null});
});

test('keyboard resize expands immediately and can return from full mode', () => {
    const next = panel.stepPanelWidth({newsPanelMode:'compact'},1440,40);
    assert.deepEqual(next,{newsPanelMode:'wide',newsPanelWidth:490});
    assert.deepEqual(panel.stepPanelWidth(next,1440,-40),{newsPanelMode:'compact',newsPanelWidth:null});
    assert.deepEqual(panel.stepPanelWidth({newsPanelMode:'full'},1440,-100),{newsPanelMode:'wide',newsPanelWidth:1340});
});

test('hero geometry derives responsive layout tier from available width', () => {
    const normal = panel.heroGeometry(1440, 450);
    const compact = panel.heroGeometry(1440, 930);
    const minimal = panel.heroGeometry(1440, 1100);
    assert.equal(normal.tier, 'normal');
    assert.equal(compact.width, 486);
    assert.equal(compact.tier, 'compact');
    assert.equal(minimal.tier, 'minimal');
    assert.equal(panel.heroGeometry(1440, 930, false).tier, 'normal');
    assert.equal(panel.heroGeometry(1440, 930, false).width, 1440);
});

test('density and panel opacity validate independently',()=>{
    settings.updateSettings('news',{density:'relaxed'});
    settings.updateSettings('appearance',{panelOpacity:1000});
    assert.equal(settings.getSettings().news.density,'relaxed');assert.equal(settings.getSettings().appearance.panelOpacity,95);
    settings.updateSettings('news',{density:'unknown'});
    settings.updateSettings('appearance',{panelOpacity:'bad'});
    assert.equal(settings.getSettings().news.density,'standard');assert.equal(settings.getSettings().appearance.panelOpacity,60);
});

test('read state persists and bookmarks retain a snapshot independently of the feed',()=>{
    const news={_clientKey:'id-reading-test',content:'A saved article',source:'linuxdo',category:'community',raw_time:123};
    reading.markRead(news._clientKey);assert.equal(reading.isRead(news._clientKey),true);
    reading.toggleSaved(news);news.content='Changed upstream';
    assert.equal(reading.savedNews()[0].content,'A saved article');
    assert.equal(JSON.parse(values.get('gxNewsReadingV1')).read[news._clientKey]>0,true);
    reading.markRead(news._clientKey,false);assert.equal(reading.isRead(news._clientKey),false);
    reading.toggleSaved(news);assert.equal(reading.isSaved(news._clientKey),false);
});

test('bookmark snapshots are bounded and invalid entries are discarded',()=>{
    const saved=Object.fromEntries(Array.from({length:250},(_,i)=>[`id-${i}`,{content:'x'.repeat(61000)}]));
    const clean=reading.sanitizeReadingState({read:{bad:'invalid'},saved});
    assert.equal(Object.keys(clean.saved).length,200);assert.equal(clean.saved['id-0'].content.length,60000);assert.deepEqual(clean.read,{});
    const special=reading.sanitizeReadingState(JSON.parse('{"read":{"__proto__":123,"constructor":123},"saved":{"__proto__":{"content":"unsafe"}}}'));
    assert.deepEqual(special,{read:{},saved:{}});assert.equal(reading.isRead('constructor'),false);
});

test('seven-day forecast accepts complete data and rejects missing temperatures',()=>{
    const daily={time:Array.from({length:7},(_,i)=>`2026-11-${String(i+8).padStart(2,'0')}`),weather_code:[0,1,3,61,95,71,45],temperature_2m_max:[20,21,22,23,24,25,26],temperature_2m_min:[8,8,9,10,11,12,13],precipitation_probability_max:[0,10,null,70,80,50,20]};
    assert.equal(forecast.normalizeForecast({daily}).length,7);assert.equal(forecast.normalizeForecast({daily})[2].rain,null);
    daily.temperature_2m_max[0]=null;assert.throws(()=>forecast.normalizeForecast({daily}));
});

test('rain stays sparse on desktop and mobile, with a bounded storm increase',()=>{
    assert.equal(weatherPhysics.particleBudget('rain',1440,900),41);
    assert.equal(weatherPhysics.particleBudget('rain',390,844),10);
    assert.ok(weatherPhysics.particleBudget('rain',3840,2160,true)<90);
});

test('snow builds local hills, survives geometry changes, and caps depth',()=>{
    const pack=weatherPhysics.createSnowpack(320);
    for(let i=0;i<10;i++)weatherPhysics.depositSnow(pack,160,2);
    const height=weatherPhysics.snowHeightAt(pack,160);
    assert.ok(height>5);assert.equal(weatherPhysics.snowHeightAt(pack,30),0);
    const resized=weatherPhysics.createSnowpack(640,pack);
    assert.ok(Math.abs(weatherPhysics.snowHeightAt(resized,320)-height)<0.01);
    for(let i=0;i<100;i++)weatherPhysics.depositSnow(resized,320,3);
    assert.equal(weatherPhysics.snowHeightAt(resized,320),18);
    assert.equal(weatherPhysics.snowHeightAt(resized,0),0);
});

test('relaxSnowpack spreads steep mounds horizontally and settles gently without negatives', () => {
    const pack = weatherPhysics.createSnowpack(320);
    for (let i = 0; i < 12; i++) weatherPhysics.depositSnow(pack, 160, 2, 16);
    const peakBefore = weatherPhysics.snowHeightAt(pack, 160);
    const shoulderBefore = weatherPhysics.snowHeightAt(pack, 136);
    for (let step = 0; step < 12; step++) weatherPhysics.relaxSnowpack(pack, 0.05, 16);
    const peakAfter = weatherPhysics.snowHeightAt(pack, 160);
    const shoulderAfter = weatherPhysics.snowHeightAt(pack, 136);
    assert.ok(peakAfter < peakBefore);
    assert.ok(shoulderAfter > shoulderBefore);
    assert.ok(pack.depth.every(value => value >= 0 && value <= 18));
});

test('rain impacts throw short lived droplets to both sides',()=>{
    const droplets=weatherPhysics.splashDroplets(100,200,()=>0.5);
    assert.equal(droplets.length,5);
    assert.ok(droplets[0].vx<0 && droplets[4].vx>0);
    assert.ok(droplets.every(p=>p.vy<0 && p.maxLife<0.6));
});

test('findSnowSegments isolates local snow patches instead of spanning bare surface', () => {
    const empty = weatherPhysics.createSnowpack(320);
    assert.deepEqual(weatherPhysics.findSnowSegments(empty.depth), []);

    weatherPhysics.depositSnow(empty, 80, 1.8, 8, 0.35);
    const singleSegs = weatherPhysics.findSnowSegments(empty.depth);
    assert.equal(singleSegs.length, 1);
    assert.ok(singleSegs[0].start > 0);
    assert.ok(singleSegs[0].end < empty.depth.length - 1);

    weatherPhysics.depositSnow(empty, 240, 1.8, 8, 0.35);
    const twoSegs = weatherPhysics.findSnowSegments(empty.depth);
    assert.equal(twoSegs.length, 2);
});

test('disturbSnowpack brushes snow, spawns clumps, and stepSnowWave damps jiggle cleanly', () => {
    const pack = weatherPhysics.createSnowpack(320);
    for (let i = 0; i < 14; i++) weatherPhysics.depositSnow(pack, 160, 2.2, 12, 0.9);
    const before = weatherPhysics.snowHeightAt(pack, 160);

    const shake = weatherPhysics.disturbSnowpack(pack, 160, 0, -100, { shakeOnly: true, random: () => 0.2 });
    assert.ok(shake.clumps.length > 0);
    assert.ok(pack.vel.some(v => v !== 0));

    weatherPhysics.stepSnowWave(pack, 0.016);
    assert.ok(pack.offset.some(o => o !== 0));
    assert.equal(pack.offset[0], 0);

    for (let step = 0; step < 120; step++) weatherPhysics.stepSnowWave(pack, 0.025);
    assert.ok(Math.abs(pack.offset[Math.floor(pack.offset.length / 2)]) < 0.05);

    const brush = weatherPhysics.disturbSnowpack(pack, 160, 480, 60, { strength: 1.2, random: () => 0.1 });
    assert.ok(brush.removed > 0);
    assert.ok(brush.clumps.length > 0);
    assert.ok(weatherPhysics.snowHeightAt(pack, 160) < before);
});

test('exportSettingsBackup and importSettingsBackup validate and restore preferences safely', () => {
    const backup = settings.exportSettingsBackup();
    backup.appearance.panelOpacity = 80;
    backup.search.engine = 'duck';
    const restored = settings.importSettingsBackup(backup);
    assert.equal(restored.appearance.panelOpacity, 80);
    assert.equal(restored.search.engine, 'duck');
    assert.throws(() => settings.importSettingsBackup(null));
    assert.throws(() => settings.importSettingsBackup([]));
});
