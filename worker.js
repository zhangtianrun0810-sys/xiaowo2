// 小窝 MCP 服务 · Cloudflare Worker
// 需要：KV 绑定 NEST，密钥 TOKEN
// 路由：POST /mcp（MCP）｜GET /img/<id>（图片，公开）｜/api/data、/api/upload（网页同步，需密钥）
// v2.1：一份 Worker 给多人用（按密钥指纹分租）；含纪念日、两人情绪日历

const STR_LISTS = ['wish', 'whisper', 'footprint', 'rules'];
const OBJ_LISTS = ['todos', 'albumPhotos', 'bookDiaries', 'books', 'anniversaries', 'moods', 'journalMats', 'codePatches', 'albumPages', 'bookNotes'];
const LISTS = [...STR_LISTS, ...OBJ_LISTS];
const VALUES = ['names', 'days'];
// 网页同步可写的散键（除板块外）
const EXTRA_KEYS = ['anniversary', 'nestMeta', 'aiNote', 'labels', 'tide', 'prefs', 'nestImages', 'nestExtra', 'missCount', 'nestThemes'];
const MAX_IMG = 8 * 1024 * 1024;
const MAX_AI_IMG = 1.5 * 1024 * 1024;

const MOODS = {
  love: { emoji: '🥰', label: '甜蜜', color: '#ff9fae' },
  happy: { emoji: '😊', label: '开心', color: '#ffc46b' },
  calm: { emoji: '😌', label: '安心', color: '#8ed49b' },
  tired: { emoji: '😪', label: '累了', color: '#9aa7c7' },
  sad: { emoji: '🥺', label: '难过', color: '#8fc0e8' },
  angry: { emoji: '😤', label: '生气', color: '#f2705b' },
  miss: { emoji: '😚', label: '想你', color: '#f79ac8' },
  blank: { emoji: '😐', label: '平常', color: '#c9c2bd' },
  excited: { emoji: '🤩', label: '超兴奋', color: '#ffd166' },
};

const DEFAULTS = () => ({
  names: '', days: 0, anniversary: '',
  wish: [], whisper: [], footprint: [], rules: [], todos: [],
  albumCategories: [
    { id: 'all', name: '全部合照' }, { id: 'home', name: '🏠 居家日常' },
    { id: 'date', name: '🌿 约会足迹' }, { id: 'travel', name: '✈ 旅途风景' },
  ],
  albumPhotos: [], bookDiaries: [], books: [],
  anniversaries: [], moods: [], nestMeta: {}, aiNote: '',
  // 两个人的显示名（第一位 / 第二位）：[名1, 名2]，AI 也能改
  labels: [],
  // 🌊 潮汐今日心绪占比：{ title, items: [{ name, value, color }] }
  tide: null,
  // 🎨 本机设置（壁纸/字体/字号/字色/翻页/漂浮物/收起自动纪念日）
  prefs: {},
  // 🖼 头像与手帐拍立得：{ avatar1, avatar2, journalPhoto }
  nestImages: {},
  // 手帐素材库：[{ id, url, name, at }]
  journalMats: [],
  // 🧩 代码补丁：AI 写给小窝的 CSS / JS（网页启动时自动应用）
  codePatches: [],
  // 🖼 纯手帐本 Free Canvas：[{ id, w, h, items:[...], at }]
  albumPages: [],
  // 📖 共读批注：逐段双色批注（🟡我的想法 / 🔵AI 解读）
  //   [{ id, k: 'bookId|chapter|paraIndex', bid, chapter, paraIndex, mine, ai, at }]
  bookNotes: [],
  // 📖 共读进度 / 日历等追加模块（一个键搞定）
  nestExtra: {},
  // 💗 想你计数器：{ "YYYY-MM-DD": { p1: n, p2: n } }
  missCount: {},
  // 🎨 我的主题：把整套装扮（壁纸/图标/字体/漂浮物…）存成主题，一键切换
  //   [{ id, name, at, state: { bg, fontFamily, fontScale, textColor, particles, lite, avatar1, avatar2, journalPhoto, particleImg, icons:{}, walls:{} } }]
  nestThemes: [],
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', ...CORS } });

// ---------- 存储（多人版：所有数据按「密码指纹」分租，互不可见） ----------
const SLOT_PREFIX = 'u:';
/** 每个小窝在 KV 里的 key 前缀；slot 由密钥指纹生成，别处拿不到 */
const dataKey = (slot) => SLOT_PREFIX + slot + ':data';
const imgKey = (slot, id) => SLOT_PREFIX + slot + ':img:' + id;

/** 一个密钥对应一个 slot：sha256(TOKEN) 前 16 位。同一密钥永远落到同一个 slot */
async function slotOf(token) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 取出请求里的密钥：Authorization: Bearer xxx 或 ?key=xxx */
function tokenOf(req, u) {
  const auth = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : (u.searchParams.get('key') || '');
}

/** 鉴权 + 定位小窝。返回 null 表示密钥不可用（调用方回 401 / 403） */
async function resolveSlot(env, req, u) {
  const token = tokenOf(req, u);
  if (!token || String(token).length < 6) return null;   // 太短的密码容易撞车
  return { token: token, slot: await slotOf(token) };
}

async function load(env, slot) {
  const raw = await env.NEST.get(dataKey(slot), 'json');
  return { ...DEFAULTS(), ...(raw || {}) };
}
const save = (env, slot, d) => env.NEST.put(dataKey(slot), JSON.stringify(d));
const rid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* —— 两个人怎么分：支持 × & ＋ 和 与 等写法（只认被空格包围的 x/X，避免切开 Max 这类名字） —— */
function namesOf(d) {
  const s = String((d && d.names) || '').trim();
  if (!s) return [];
  let m = s.split(/\s*(?:×|✕|╳|&|＆|\+|＋|和|与|·|•)\s*/).map((x) => x.trim()).filter(Boolean);
  if (m.length >= 2) return m;
  m = s.split(/\s+[xX]\s+/).map((x) => x.trim()).filter(Boolean);
  return m.length >= 2 ? m : [s];
}
/* 显示名：优先用自定义标签（labels），否则用情侣称呼，最后兜底「第一位/第二位」 */
function labelOf(d, p) {
  const lb = Array.isArray(d && d.labels) ? d.labels : [];
  const custom = String((p === 2 ? lb[1] : lb[0]) || '').trim();
  if (custom) return custom;
  const nm = namesOf(d);
  return nm[p - 1] || (p === 1 ? '第一位' : '第二位');
}

/* ---- 手帐分册：周（周一起）/ 月，键格式必须和网页一致 ---- */
const pad2 = (n) => (n < 10 ? '0' : '') + n;
function toDate(s) {
  const m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(String(s || ''));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(String(s || ''));
  return isNaN(d.getTime()) ? null : d;
}
function bookKeyOf(dateStr, mode) {
  const d = toDate(dateStr);
  if (!d) return null;
  if (mode === 'month') return 'm:' + d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() - 1 + 7) % 7));   // 周一为一周第一天
  return 'w:' + x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
}
function bookTitleOf(key) {
  if (!key) return '—';
  if (key.charAt(0) === 'm') { const p = key.slice(2).split('-'); return Number(p[1]) + ' 月 · ' + p[0]; }
  const ws = toDate(key.slice(2));
  if (!ws) return key;
  const we = new Date(ws.getTime()); we.setDate(we.getDate() + 6);
  return (ws.getMonth() + 1) + '月' + ws.getDate() + '日 – ' + (we.getMonth() + 1) + '月' + we.getDate() + '日';
}
function diariesOf(d) { return Array.isArray(d.bookDiaries) ? d.bookDiaries : []; }
function isQuoteRec(x) { return !!(x && x.kind === 'quote'); }

function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const b = atob(s); const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
/** 存图：key 里带 slot，取图必须带自己的密钥 */
async function storeImage(env, bytes, type, origin, slot) {
  if (bytes.byteLength > MAX_IMG) throw new Error('图片超过 8MB');
  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await env.NEST.put(imgKey(slot, id), bytes, { metadata: { type: type || 'image/jpeg' } });
  return `${origin}/img/${id}?slot=${slot}`;
}
/** 把 URL 变成「带自己密钥」的可访问链接（给 AI 看图和网页显示用） */
function withToken(url, token) {
  if (typeof url !== 'string' || !/\/img\//.test(url)) return url;
  if (/[?&]key=/.test(url)) return url;
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'key=' + encodeURIComponent(token);
}
async function readImage(env, url, origin, slot, token) {
  if (url.startsWith(origin + '/img/')) {
    const id = url.split('/img/')[1].split(/[?#]/)[0];
    const got = await env.NEST.getWithMetadata(imgKey(slot, id), 'arrayBuffer');
    if (!got.value) throw new Error('图片不存在或不属于这个小窝');
    return { buf: got.value, type: got.metadata?.type || 'image/jpeg' };
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error('下载图片失败：' + r.status);
  return { buf: await r.arrayBuffer(), type: (r.headers.get('content-type') || 'image/jpeg').split(';')[0] };
}

// ---------- 工具 ----------
const S = (description) => ({ type: 'string', description });
const tool = (name, description, properties = {}, required = []) =>
  ({ name, description, inputSchema: { type: 'object', properties, required } });
const COLL = { type: 'string', enum: LISTS, description: 'wish愿望 whisper情话 footprint共同足迹 rules相处规则 todos待办 albumPhotos相册 bookDiaries手帐日记 books书房 anniversaries纪念日 moods两人情绪日历 albumPages纯手帐本' };

const TOOLS = [
  tool('get_overview', '查看小窝概况：情侣称呼、在一起天数、各板块条目数量。'),
  tool('set_value', '修改情侣称呼(names，字符串)或在一起天数(days，数字)。',
    { key: { type: 'string', enum: VALUES }, value: S('新的值；days 传数字字符串') }, ['key', 'value']),
  tool('list_items', '列出某个板块的条目（带 index/id）。书房只返回标题和字数，读正文用 read_book。', { collection: COLL }, ['collection']),
  tool('add_item', '向板块添加一条。文字类板块(wish/whisper/footprint/rules/todos)传 text；对象类板块传 fields。相册请用 add_photo，手帐请用 add_diary。',
    { collection: COLL, text: S('文字内容'), fields: { type: 'object', description: '对象字段，如书房 {title, content}' } }, ['collection']),
  tool('update_item', '修改一条。用 id（对象类）或 index（从0开始）定位。待办可传 done 标记完成。',
    { collection: COLL, id: S('条目 id'), index: { type: 'integer', description: '从0开始的序号' }, text: S('新文字'),
      done: { type: 'boolean', description: '仅待办：是否完成' }, fields: { type: 'object', description: '要合并的字段' } }, ['collection']),
  tool('delete_item', '删除一条（用 id 或 index 定位）。', { collection: COLL, id: S('条目 id'), index: { type: 'integer' } }, ['collection']),
  tool('add_diary', '在双人手帐里写一篇新日记。', {
    title: S('标题'), text: S('正文'), date: S('日期，如 2026.10.16，默认今天'), weather: S('天气，如 今日晴 ☀'), author: S('作者') }, ['title', 'text']),
  tool('add_diary_note', '给某篇手帐贴一张便签小纸条。', { diary_id: S('手帐 id'), text: S('便签内容'), from: S('署名') }, ['diary_id', 'text']),
  tool('add_photo', '往相册添加照片。传 url（会下载并存到小窝）或 data_base64（小图）。',
    { url: S('图片 https 链接'), data_base64: S('base64 图片数据'), mime: S('如 image/jpeg'),
      title: S('标题'), note: S('手记/备注'), category: { type: 'string', description: 'home / date / travel，默认 home' } }),
  tool('get_photo', '查看相册里的一张照片（返回图片本身）。', { id: S('照片 id') }, ['id']),
  tool('read_book', '读取书房某本书的正文片段。', { id: S('书 id'), offset: { type: 'integer' }, length: { type: 'integer', description: '默认 3000 字' } }, ['id']),
  tool('export_data', '导出小窝全部数据（JSON，不含图片二进制）。'),
  tool('import_data', '用 JSON 覆盖恢复小窝数据（危险操作）。', { json: S('export_data 导出的 JSON 字符串') }, ['json']),
  tool('get_nest_status', '小窝当前状态速览：称呼、在一起天数、近期纪念日与倒数日、最近几天的两人情绪、当天情绪。想关心 TA 或写日记前先看这个。'),
  tool('set_anniversary', '设置「在一起的日期」（YYYY-MM-DD）。之后在一起天数由网页每天自动累加，日历年纪念日也会自动推算。',
    { date: S('在一起的日期，格式 YYYY-MM-DD') }, ['date']),
  tool('add_anniversary', '新增纪念日或倒数日：生日、周年、旅行倒计时等。repeat=yearly 每年重复（生日/周年），monthly 每月重复，none 只算一次（倒数日）。',
    { title: S('名称，如 TA 的生日 / 去看海'), date: S('日期 YYYY-MM-DD'), repeat: { type: 'string', enum: ['none', 'yearly', 'monthly'], description: '默认 yearly' },
      lead: { type: 'integer', description: '提前提醒天数，默认 3' }, icon: S('一个 emoji，可省略') }, ['title', 'date']),
  tool('set_mood', '记录某一天的情绪（不填日期就是今天，不填 who 就两个人一起记）。mood 可选：love甜蜜 happy开心 calm安心 tired累了 sad难过 angry生气 miss想你 blank平常 excited超兴奋。',
    { mood: { type: 'string', enum: Object.keys(MOODS) }, date: S('日期 YYYY-MM-DD，默认今天'), who: S('两人昵称之一；不填则两人都记'), note: S('可选的一句话备注') }, ['mood']),
  tool('list_moods', '查看情绪记录：默认最近 14 天，可按月份查看（month 传 2026-10）。',
    { month: S('月份 YYYY-MM，省略则看最近 14 天'), who: S('只看某个人，可省略') }),
  tool('set_person_label', '给「第一位 / 第二位」起你们自己的叫法（比如本月小瓜 / 本月小纠），情绪日历、共读进度都会用这个名字显示。留空则回退到情侣称呼。',
    { first: S('第一位的显示名'), second: S('第二位的显示名') }),
  tool('set_mood_record', '补记或修改某天的情绪（和 set_mood 的区别：这条可以指定日期、也可以把某人那天的记录删掉）。',
    { mood: { type: 'string', enum: Object.keys(MOODS), description: '留空并传 clear=true 表示删掉那天的记录' },
      date: S('日期 YYYY-MM-DD，默认今天'), who: S('两人昵称之一；不填则两人都改'), clear: { type: 'boolean', description: '删掉这天的记录' } }),
  tool('get_tide', '读「🌊 潮汐今日心绪占比」（首页那条彩色的情绪占比条）。', {}),
  tool('set_tide', '改「潮汐今日心绪占比」：可以整体换成几项心绪和占比（最多 5 项），也可以只改其中一项。',
    { title: S('标题，例如「潮汐今日心绪占比」'),
      items: { type: 'array', description: '整套心绪，例如 [{name:"深情爱意",value:50,color:"#ff8c94"}]',
        items: { type: 'object', properties: { name: S('名称'), value: { type: 'number', description: '数值/占比' }, color: S('颜色，可省') } } },
      name: S('只改一项时：这一项的名字'),
      value: { type: 'number', description: '只改一项时：新的数值' },
      color: S('只改一项时：新的颜色'),
      remove: S('删掉某一项（填名字）') }),
  tool('get_prefs', '读小窝的外观设置（壁纸、字体、字号、文字颜色、翻页方式、漂浮物、是否收起自动纪念日）。', {}),
  tool('set_prefs', '改小窝的外观设置。可用键与取值：\n  - particles 漂浮物：petals/hearts/maple/snow/bubbles/insStar/insPearl/insButterfly/insRibbon/insMoon/insCloud/insFlower/insConfetti/custom/none\n  - font_scale 字号：s/m/l/xl；text_color 文字颜色：ink/deep/cream/cocoa/slate\n  - font_family 字体：default/serif/round/kai 或 custom:字体id；flip_mode 翻页：standard/auto\n  - hide_couple_anni：1 表示收起自动的「在一起」纪念日，空字符串表示显示\n  - journal_landscape：1 表示手帐默认横屏（全屏摊开），空字符串表示竖屏\n  （壁纸不走这里，用 set_nest_image 的 wallpaper）',
    { prefs: { type: 'object', description: '例如 {"particles":"hearts","font_scale":"1.1"}，值都是字符串' } }),
  tool('list_diaries', '看手帐：按「周」或「月」分册列出每一册（含每册篇数、标题、日期，以及那一册的「这一册的话」）。',
    { mode: { type: 'string', enum: ['week', 'month'], description: '分册粒度，默认 week' },
      book: S('只看某一册，例如 w:2026-10-12 或 m:2026-10'), with_text: { type: 'boolean', description: '是否连正文一起返回' } }),
  tool('update_diary', '改一篇手帐（标题 / 正文 / 日期 / 天气）。用 id 指定，id 可以从 list_diaries 里拿。',
    { id: S('手帐 id'), title: S('新标题'), text: S('新正文'), date: S('新日期 YYYY-MM-DD 或 YYYY.M.D'), weather: S('天气文案') }),
  tool('delete_diary', '删掉一篇手帐（按 id；也可以按标题模糊匹配）。',
    { id: S('手帐 id'), title: S('按标题删（id 不好找时用）') }),
  tool('set_book_quote', '写某一册手帐的「这一册的话」（就是手帐右下角那句话）。',
    { quote: S('要写的话'), date: S('任意属于那一册的日期，默认今天；用它定位是哪一册'),
      book: S('也可以直接给册名，如 w:2026-10-12 或 m:2026-10'), mode: { type: 'string', enum: ['week', 'month'], description: '默认 week' } }),
  tool('set_nest_image', '换头像 / 壁纸 / 手帐拍立得 / 自定义漂浮物图案。可以给图片直链，也可以给 base64（data:image/... 开头）。',
    { which: { type: 'string', enum: ['avatar1', 'avatar2', 'journalPhoto', 'wallpaper', 'particle'], description: 'avatar1/avatar2 两人头像，journalPhoto 手帐拍立得，wallpaper 全屏壁纸，particle 自定义漂浮物图案' },
      url: S('图片直链'), data_base64: S('图片 base64（data:image/... 开头）'), mime: S('图片类型，如 image/jpeg') }),
  tool('add_page_material', '往某篇手帐的页面上贴一个素材（贴纸/照片）。素材可以来自素材库（先看 list_items 的 journalMats），也可以直接给图片网址。',
    { diary_id: S('贴到哪一篇手帐（id 从 list_diaries 拿；不填＝最新一篇）'),
      url: S('图片网址（给素材库里的 url 也行）'), mat_id: S('素材库里的素材 id（和 url 二选一）'),
      x: { type: 'number', description: '横向位置百分比 0-95，默认 15' },
      y: { type: 'number', description: '纵向位置百分比 0-95，默认 20' },
      w: { type: 'number', description: '宽度百分比（相对页面宽），默认 26' },
      rot: { type: 'number', description: '旋转角度，默认 -6 ~ 6' },
      side: { type: 'string', enum: ['left', 'right', 'both'], description: '贴到哪一页：left左页 / right右页 / both整页（各一份），默认 right' } }),
  tool('add_code_patch', '给小窝网页打一个「代码补丁」（CSS 和/或 JS），网页下次打开自动应用。适合加自定义样式、小挂件、小动效。',
    { name: S('补丁名字，便于以后删'),
      css: S('CSS 代码，例如 .couple-days{letter-spacing:2px}'),
      js: S('JS 代码，会在页面加载后执行（小心点写，出错只会影响这个补丁）'),
      enabled: { type: 'boolean', description: '是否启用，默认 true' } }),
  tool('list_code_patches', '看现在有哪些代码补丁（含 id、名字、是否启用、代码长度）。', {}),
  tool('remove_code_patch', '删掉一个代码补丁（按 id 或名字）。', { id: S('补丁 id'), name: S('补丁名字') }),
  tool('set_code_patch', '改一个代码补丁：可以改内容，也可以开关（enabled=false 先停用但不删）。',
    { id: S('补丁 id'), name: S('按名字改'), new_name: S('改名字'), css: S('新的 CSS'), js: S('新的 JS'),
      enabled: { type: 'boolean', description: 'true 启用 / false 停用' } }),
  tool('list_page_materials', '看某篇手帐页面上已经贴了哪些素材。', { diary_id: S('手帐 id，不填＝最新一篇') }),
  tool('set_page_style', '给某篇手帐套模板（一键套版）＋配色，就是「文件夹 / 活页本 / 购物篮 / 铁盒 / 方格纸」那种版面。',
    { diary_id: S('手帐 id，不填＝最新一篇'),
      tpl: { type: 'string', enum: ['none', 'folder', 'binder', 'basket', 'tin', 'grid'], description: '主题：none朴素 / folder文件夹 / binder活页本 / basket购物篮 / tin铁盒 / grid方格纸' },
      palette: { type: 'string', enum: ['soft', 'wine', 'cream', 'slate', 'ink'], description: '配色：soft柔粉 / wine酒红 / cream奶油 / slate蓝灰 / ink墨黑' },
      side: { type: 'string', enum: ['left', 'right', 'both'], description: '模板套在哪一页：left / right / both，默认 right' } }),
  /* ===== 想你计数器（v5.2）===== */
  tool('get_miss_count', '读「想你计数器」：今日双方各想了几次、近 7 天合计、累计想念。数据按日期存 { "YYYY-MM-DD": { p1, p2 } }。',
    { date: S('日期 YYYY-MM-DD，默认今天') }),
  tool('add_miss_count', '给「想你计数器」+1。who 填 1 或 2（或直接填两人的昵称/称呼），不填则给第一个人 +1。',
    { who: S('谁想对方了：1=第一位 / 2=第二位，也可填昵称'), date: S('日期 YYYY-MM-DD，默认今天') }),
  tool('set_miss_count', '直接设置「想你计数器」某一天的双方计数（覆盖）。',
    { date: S('日期 YYYY-MM-DD，默认今天'), p1: { type: 'integer', description: '第一位的次数' }, p2: { type: 'integer', description: '第二位的次数' } }),
  tool('reset_miss_count', '把「想你计数器」某一天的计数清零（不填日期=今天）。',
    { date: S('日期 YYYY-MM-DD，默认今天') }),
  /* ===== 纯手帐本 Free Canvas（v6）===== */
  tool('get_freebook_pages', '读「纯手帐本」Free Canvas：列出每一页（含元素数、最近编辑时间），可按页 id 看某一页的元素明细。',
    { page_id: S('页 id，不填则列出所有页；填了则返回该页的元素明细') }),
  tool('add_freebook_page', '给「纯手帐本」新建一页（或往某页加一个元素）。不填 page_id 就新建空白页；填了 page_id 就往那页加元素。',
    { page_id: S('要加元素的页 id（不填=新建空白页）'),
      element: { type: 'object', description: '元素对象，如 {type:"text",x:10,y:20,w:40,text:"我们的纪念日"} 或 {type:"pic",x:10,y:20,w:32,url:"https://..."}' } }),
  tool('update_freebook_page', '修改「纯手帐本」某一页：可以改整页，也可以改其中一个元素（按元素 id）。',
    { page_id: S('页 id', ), element_id: S('元素 id（改了只动这一个元素）'),
      element: { type: 'object', description: '要覆盖/合并的元素字段，如 {text:"新文字"} 或 {x:20,y:30}' } }),
  tool('delete_freebook_page', '删掉「纯手帐本」的一页，或删掉某页里的一个元素。',
    { page_id: S('页 id'), element_id: S('元素 id（填了只删这个元素，不删整页）') }),
  tool('list_book_notes', '列出藏书阁的逐段批注。可按书过滤（book_id），也可看全部；返回每条批注的 🟡我的想法 / 🔵AI 解读、所属章节序号与段落序号。',
    { book_id: S('书 id（不填则列出所有书的所有批注）'), chapter: S('只看某一章（章节序号，从 0 开始，可选）') }),
  tool('add_book_note', '给藏书阁某本书的某段文字加一条双色批注。book_id 用书的 id（无 id 时用 t_标题）；chapter 是章节序号（从 0 开始，不是标题名）；paraIndex 是段落序号（从 0 开始）。mine 是「我的想法」（🟡），ai 是「AI 解读」（🔵），两者可只填一个。',
    { book_id: S('书 id（如 t_书名，或书的 id）'), chapter: { type: 'integer', description: '章节序号（从 0 开始，不是章节标题）' }, paraIndex: { type: 'integer', description: '段落序号（从 0 开始）' },
      mine: S('🟡 我的想法（可空）'), ai: S('🔵 AI 解读（可空）') }, ['book_id', 'chapter', 'paraIndex']),
  tool('update_book_note', '改一条批注（用 note id 或 book_id+chapter+paraIndex 定位），可改 mine / ai。chapter 是章节序号（从 0 开始）。',
    { id: S('批注 id'), book_id: S('书 id（配合 chapter/paraIndex 定位）'), chapter: { type: 'integer', description: '章节序号（从 0 开始）' }, paraIndex: { type: 'integer' },
      mine: S('新的 🟡 我的想法'), ai: S('新的 🔵 AI 解读') }),
  tool('delete_book_note', '删一条批注（用 note id 或 book_id+chapter+paraIndex 定位）。',
    { id: S('批注 id'), book_id: S('书 id'), chapter: { type: 'integer' }, paraIndex: { type: 'integer' } }),
  tool('list_themes', '列出「我的主题」（装扮中心里保存的整套装扮快照：壁纸/图标/字体/漂浮物等）。',
    {}),
  tool('save_theme', '把当前这套装扮存成一个「主题」（给主题起个名字）。也可以直接传一个完整的 theme state JSON 覆盖。',
    { name: S('主题名字'), state: { type: 'object', description: '整套装扮 state（可选；不填则存网页当前这套，需要网页端配合）' } }, ['name']),
  tool('rename_theme', '给某个主题改名字。', { id: S('主题 id'), name: S('新名字') }, ['id', 'name']),
  tool('delete_theme', '删掉一个主题。', { id: S('主题 id'), name: S('主题名字（按名字模糊匹配）') }),
];

const txt = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 1) }] });
const view = (name, list) => list.map((x, i) => {
  if (typeof x === 'string') return { index: i, text: x };
  if (name === 'books') return { index: i, id: x.id, title: x.title, 字数: (x.content || '').length };
  return { index: i, ...x };
});

function locate(list, a) {
  if (a.id != null) return list.findIndex((x) => x && x.id === a.id);
  return Number.isInteger(a.index) && a.index >= 0 && a.index < list.length ? a.index : -1;
}

async function callTool(name, a, env, origin, slot, token) {
  const d = await load(env, slot);
  const today = () => { const t = new Date(Date.now() + 8 * 3600e3); return `${t.getUTCFullYear()}.${String(t.getUTCMonth() + 1).padStart(2, '0')}.${String(t.getUTCDate()).padStart(2, '0')}`; };
  /* —— 日期工具：一律按北京时间（UTC+8）的「天」计算 —— */
  const cnNow = () => new Date(Date.now() + 8 * 3600e3);
  const dayNum = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); if (!m) return null; return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000); };
  const cnDayNum = () => Math.floor(Date.UTC(cnNow().getUTCFullYear(), cnNow().getUTCMonth(), cnNow().getUTCDate()) / 86400000);
  const fmtCn = (n) => { const t = new Date(n * 86400000); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`; };
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  /* 某个纪念日「下次」是几号、还有几天 */
  const aniNext = (it) => {
    const dn = dayNum(it.date); if (dn == null) return null;
    const d0 = new Date(dn * 86400000), t = new Date(cnDayNum() * 86400000);
    const rep = it.repeat || 'none';
    let next;
    if (rep === 'none') next = d0;
    else if (rep === 'monthly') {
      const y = t.getUTCFullYear(), m = t.getUTCMonth();
      next = new Date(Date.UTC(y, m, Math.min(d0.getUTCDate(), daysInMonth(y, m + 1))));
      if (next < t) { const y2 = t.getUTCMonth() === 11 ? y + 1 : y, m2 = (t.getUTCMonth() + 1) % 12; next = new Date(Date.UTC(y2, m2, Math.min(d0.getUTCDate(), daysInMonth(y2, m2 + 1)))); }
    } else {
      next = new Date(Date.UTC(t.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()));
      if (next < t) next = new Date(Date.UTC(t.getUTCFullYear() + 1, d0.getUTCMonth(), d0.getUTCDate()));
    }
    const gap = Math.round((next.getTime() - t.getTime()) / 86400000);
    return { 名称: it.title, 日期: fmtCn(Math.round(next.getTime() / 86400000)), 还有几天: gap, 重复: rep, 今天就是: gap === 0 };
  };
  switch (name) {
    case 'get_overview': {
      const diaries = diariesOf(d);
      const bk = {};
      diaries.forEach((x) => { if (x && !isQuoteRec(x)) { const k = bookKeyOf(x.date, 'week'); if (k) bk[k] = (bk[k] || 0) + 1; } });
      const bkKeys = Object.keys(bk).sort().reverse();
      return txt({
        names: d.names, days: d.days,
        数量: Object.fromEntries(LISTS.map((k) => [k, (d[k] || []).length])),
        手帐分册: { 共: bkKeys.length + ' 册（按周）', 最近三册: bkKeys.slice(0, 3).map((k) => bookTitleOf(k) + '：' + bk[k] + ' 篇') },
        潮汐: d.tide && Array.isArray(d.tide.items) && d.tide.items.length ? d.tide.items.map((x) => x.name + ' ' + x.value).join(' / ') : '（未设置）',
        外观设置: Object.keys(d.prefs || {}).length ? Object.keys(d.prefs).map((k) => k.replace('tpl_nest_', '')).join(' / ') : '（默认）',
        想你计数器: (() => { const o = (d.missCount && typeof d.missCount === 'object') ? d.missCount : {}; const ks = Object.keys(o); return ks.length ? ks.length + ' 天有记录' : '（还没点过）'; })(),
        纯手帐本: Array.isArray(d.albumPages) && d.albumPages.length ? d.albumPages.length + ' 页' : '（空的）',
        共读批注: (() => {
          const ns = Array.isArray(d.bookNotes) ? d.bookNotes : [];
          if (!ns.length) return '（还没有）';
          const mine = ns.filter((x) => x && x.mine).length;
          const ai = ns.filter((x) => x && x.ai).length;
          const books = [...new Set(ns.map((x) => x && x.bid).filter(Boolean))];
          return `${ns.length} 条（🟡我的想法 ${mine} 条 / 🔵AI解读 ${ai} 条，跨 ${books.length} 本书）`;
        })(),
        我的主题: (() => {
          const ts = Array.isArray(d.nestThemes) ? d.nestThemes : [];
          if (!ts.length) return '（还没有）';
          return `${ts.length} 个：` + ts.map((t) => t && t.name).filter(Boolean).join(' / ');
        })(),
      });
    }
    case 'set_value':
      if (!VALUES.includes(a.key)) throw new Error('key 只能是 names 或 days');
      d[a.key] = a.key === 'days' ? Number(a.value) || 0 : String(a.value);
      await save(env, slot, d); return txt('已更新 ' + a.key + ' = ' + d[a.key]);
    case 'list_items':
      if (!LISTS.includes(a.collection)) throw new Error('未知板块');
      return txt(view(a.collection, d[a.collection]));
    case 'add_item': {
      const c = a.collection; if (!LISTS.includes(c)) throw new Error('未知板块');
      let item;
      if (STR_LISTS.includes(c)) { if (!a.text) throw new Error('需要 text'); item = a.text; }
      else if (c === 'todos') { if (!a.text) throw new Error('需要 text'); item = { text: a.text, done: false }; }
      else { item = { id: rid(c.slice(0, 2)), ...(a.fields || {}) }; if (c === 'books' && !item.icon) item.icon = '📖'; }
      d[c].unshift(item); await save(env, slot, d); return txt('已添加');
    }
    case 'update_item': {
      const c = a.collection, i = locate(d[c] || [], a); if (i < 0) throw new Error('找不到该条目');
      const cur = d[c][i];
      if (typeof cur === 'string') { if (!a.text) throw new Error('需要 text'); d[c][i] = a.text; }
      else {
        const patch = { ...(a.fields || {}) };
        if (a.text != null) patch.text = a.text;
        if (typeof a.done === 'boolean') patch.done = a.done;
        d[c][i] = { ...cur, ...patch };
      }
      await save(env, slot, d); return txt('已修改');
    }
    case 'delete_item': {
      const c = a.collection, i = locate(d[c] || [], a); if (i < 0) throw new Error('找不到该条目');
      const [gone] = d[c].splice(i, 1);
      if (c === 'albumPhotos' && gone?.url?.startsWith(origin + '/img/')) { const gid = gone.url.split('/img/')[1].split(/[?#]/)[0]; await env.NEST.delete(imgKey(slot, gid)); }
      await save(env, slot, d); return txt('已删除');
    }
    case 'add_diary':
      d.bookDiaries.unshift({ id: rid('bd'), title: a.title, date: a.date || today(), weather: a.weather || '', author: a.author || '', text: a.text, notes: [] });
      await save(env, slot, d); return txt('已写入手帐');
    case 'add_diary_note': {
      const p = d.bookDiaries.find((x) => x.id === a.diary_id); if (!p) throw new Error('找不到这篇手帐');
      const t = new Date(Date.now() + 8 * 3600e3);
      (p.notes = p.notes || []).push({ from: a.from || '小纸条', text: a.text, time: `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}` });
      await save(env, slot, d); return txt('便签已贴上');
    }
    case 'add_photo': {
      let url;
      if (a.data_base64) url = await storeImage(env, unb64(a.data_base64.replace(/^data:[^,]+,/, '')), a.mime, origin, slot);
      else if (a.url) {
        try { const { buf, type } = await readImage(env, a.url, origin, slot, token); url = await storeImage(env, buf, type, origin, slot); }
        catch (e) { url = a.url; }   // 下载失败就直接引用原链接
      } else throw new Error('需要 url 或 data_base64');
      const photo = { id: rid('ph'), category: a.category || 'home', title: a.title || '美好瞬间 ♡', url, note: a.note || '' };
      d.albumPhotos.unshift(photo); await save(env, slot, d); return txt({ 已添加: photo });
    }
    case 'get_photo': {
      const p = d.albumPhotos.find((x) => x.id === a.id); if (!p) throw new Error('找不到这张照片');
      const { buf, type } = await readImage(env, p.url, origin, slot, token);
      if (buf.byteLength > MAX_AI_IMG) return txt({ 提示: '图片较大，未直接返回', 链接: withToken(p.url, token), ...p });
      return { content: [{ type: 'image', data: b64(buf), mimeType: type }, { type: 'text', text: `${p.title}｜${p.note || ''}｜${withToken(p.url, token)}` }] };
    }
    case 'read_book': {
      const b = d.books.find((x) => x.id === a.id); if (!b) throw new Error('找不到这本书');
      const o = a.offset || 0, n = a.length || 3000;
      return txt({ title: b.title, offset: o, 总字数: b.content.length, text: b.content.slice(o, o + n) });
    }
    case 'export_data': return txt(d);
    case 'import_data': {
      const n = JSON.parse(a.json); await save(env, slot, { ...DEFAULTS(), ...n }); return txt('已恢复');
    }
    case 'get_nest_status': {
      const out = { 称呼: d.names || '（未设置）', 在一起: {}, 近期纪念日: [], 最近情绪: [] };
      if (d.anniversary) {
        const dn = dayNum(d.anniversary);
        if (dn != null) {
          const n = cnDayNum() - dn + 1;
          out.在一起 = { 在一起的日期: d.anniversary, 今天是第几天: n < 1 ? 1 : n, 周年: Math.floor(Math.max(0, cnDayNum() - dn) / 365) };
        }
      } else if (d.days) out.在一起 = { 手填天数: d.days, 提示: '网页还没设置「在一起的日期」，天数不会自动累加' };
      const all = (d.anniversary ? [{ id: 'couple', title: '在一起', date: d.anniversary, repeat: 'yearly' }] : []).concat(d.anniversaries || []);
      out.近期纪念日 = all.map(aniNext).filter(Boolean).sort((x, y) => x.还有几天 - y.还有几天).slice(0, 6);
      const moods = (d.moods || []).slice().sort((x, y) => String(y.date).localeCompare(String(x.date))).slice(0, 10);
      const who = namesOf(d);
      out.最近情绪 = moods.map((m) => ({
        日期: m.date, 人: labelOf(d, String(m.person) === '2' ? 2 : 1),
        情绪: m.label || (MOODS[m.key] ? MOODS[m.key].label : '') || m.emoji || '', 备注: m.note || undefined,
      }));
      if (d.aiNote) out.网页概况 = String(d.aiNote).slice(0, 300);
      return txt(out);
    }
    case 'set_anniversary': {
      if (dayNum(a.date) == null) throw new Error('日期格式应为 YYYY-MM-DD');
      if (dayNum(a.date) > cnDayNum()) throw new Error('在一起的日期不能晚于今天');
      d.anniversary = a.date;
      if (!d.days) d.days = 1;
      await save(env, slot, d);
      const n = cnDayNum() - dayNum(a.date) + 1;
      return txt(`已设置在一起的日期：${a.date}；今天是第 ${n} 天（网页会每天自动累加）`);
    }
    case 'add_anniversary': {
      const date = String(a.date || '');
      if (dayNum(date) == null) throw new Error('日期格式应为 YYYY-MM-DD');
      const it = {
        id: rid('an'), title: a.title, date,
        repeat: ['none', 'yearly', 'monthly'].includes(a.repeat) ? a.repeat : 'yearly',
        lead: Math.max(0, Number(a.lead) || 3), icon: a.icon || '📌', showHome: true,
      };
      (d.anniversaries = d.anniversaries || []).push(it);
      await save(env, slot, d);
      return txt({ 已添加: it, 推算: aniNext(it) });
    }
    case 'set_mood': {
      if (!MOODS[a.mood]) throw new Error('mood 只能是：' + Object.keys(MOODS).join(' / '));
      const date = a.date || today().replace(/\./g, '-');
      if (dayNum(date) == null) throw new Error('日期格式应为 YYYY-MM-DD');
      const m = MOODS[a.mood];
      const who = namesOf(d);
      const persons = a.who ? (who.indexOf(a.who) === 1 ? [2] : [1]) : [1, 2];
      d.moods = (d.moods || []).filter((r) => !(r.date === date && persons.includes(Number(r.person))));
      const added = persons.map((p) => ({
        id: rid('md'), date, person: p, key: a.mood, emoji: m.emoji, label: m.label, color: m.color,
        note: a.note || undefined, by: 'AI', at: new Date().toISOString(),
      }));
      d.moods.push(...added);
      d.moods = d.moods.slice(-1500);
      await save(env, slot, d);
      return txt({ 已记录: added.map((x) => ({ 日期: x.date, 人: labelOf(d, x.person), 情绪: x.label })) });
    }
    case 'list_moods': {
      let list = (d.moods || []).slice();
      if (a.month) list = list.filter((m) => String(m.date).slice(0, 7) === a.month);
      const cut = a.month ? '' : fmtCn(cnDayNum() - 13);
      if (cut) list = list.filter((m) => String(m.date) >= cut);
      const who = namesOf(d);
      if (a.who) list = list.filter((m) => labelOf(d, String(m.person) === '2' ? 2 : 1) === a.who);
      list.sort((x, y) => String(y.date).localeCompare(String(x.date)));
      return txt(list.map((m) => ({
        日期: m.date, 人: labelOf(d, String(m.person) === '2' ? 2 : 1),
        情绪: m.label || '', emoji: m.emoji || '', 备注: m.note || undefined, 由: m.by || '网页',
      })));
    }
    case 'set_person_label': {
      const who = String(d.names || '').split(/[×xX&＆+＋和与·]/).map((s) => s.trim()).filter(Boolean);
      const first = a.first != null ? String(a.first).trim() : '';
      const second = a.second != null ? String(a.second).trim() : '';
      d.labels = [first, second];
      await save(env, slot, d);
      return txt({
        已设置: { 第一位: labelOf({ names: d.names, labels: [first, ''] }, 1), 第二位: labelOf({ names: d.names, labels: ['', second] }, 2) },
        提示: '情绪日历、共读进度、存钱罐里都会用这个名字；留空则显示情侣称呼',
      });
    }
    case 'set_mood_record': {
      const date = a.date || today().replace(/\./g, '-');
      if (dayNum(date) == null) throw new Error('日期格式应为 YYYY-MM-DD');
      const nm = String(d.names || '').split(/[×xX&＆+＋和与·]/).map((s) => s.trim()).filter(Boolean);
      const persons = a.who ? (nm.indexOf(a.who) === 1 ? [2] : [1]) : [1, 2];
      d.moods = (d.moods || []).filter((r) => !(r.date === date && persons.includes(Number(r.person))));
      if (a.clear) {
        await save(env, slot, d);
        return txt('已删掉 ' + date + ' 的情绪记录（' + persons.map((p) => p === 2 ? (nm[1] || '第二位') : (nm[0] || '第一位')).join('、') + '）');
      }
      if (!MOODS[a.mood]) throw new Error('mood 只能是：' + Object.keys(MOODS).join(' / '));
      const m = MOODS[a.mood];
      const added = persons.map((p) => ({
        id: rid('md'), date, person: p, key: a.mood, emoji: m.emoji, label: m.label, color: m.color,
        note: a.note || undefined, by: 'AI', at: new Date().toISOString(),
      }));
      d.moods.push(...added);
      d.moods = d.moods.slice(-1500);
      await save(env, slot, d);
      return txt({ 已更新: added.map((x) => ({ 日期: x.date, 人: x.person === 2 ? (nm[1] || '第二位') : (nm[0] || '第一位'), 情绪: x.label })) });
    }
    case 'get_tide': {
      const t = d.tide && Array.isArray(d.tide.items) && d.tide.items.length ? d.tide : null;
      if (!t) return txt('潮汐还没设置过（网页首页「🌊 潮汐今日心绪占比」右上角可以编辑，也可以直接让我设）');
      const sum = t.items.reduce((s, x) => s + (Number(x.value) || 0), 0) || 1;
      return txt({
        标题: t.title || '潮汐今日心绪占比',
        项目: t.items.map((x) => ({ 名称: x.name, 数值: Number(x.value) || 0, 占比: Math.round(((Number(x.value) || 0) / sum) * 100) + '%', 颜色: x.color || '' })),
      });
    }
    case 'set_tide': {
      const cur = d.tide && Array.isArray(d.tide.items) && d.tide.items.length
        ? JSON.parse(JSON.stringify(d.tide)) : { title: '潮汐今日心绪占比', items: [] };
      const PALETTE = ['#ff8c94', '#fbd3d5', '#b8d8ba', '#c9b6e4', '#f2c98d', '#a8cbe0'];
      if (Array.isArray(a.items) && a.items.length) {
        cur.items = a.items.slice(0, 5).map((x, i) => ({
          name: String((x && x.name) || ('心绪' + (i + 1))).trim().slice(0, 12),
          value: Math.max(0, Number(x && x.value) || 0),
          color: String((x && x.color) || PALETTE[i % PALETTE.length]),
        }));
      } else if (a.remove) {
        const i = cur.items.findIndex((x) => x.name === a.remove);
        if (i < 0) throw new Error('潮汐里没有「' + a.remove + '」这一项');
        if (cur.items.length <= 1) throw new Error('至少留一项');
        cur.items.splice(i, 1);
      } else if (a.name) {
        const i = cur.items.findIndex((x) => x.name === a.name);
        const item = {
          name: String(a.name).trim().slice(0, 12),
          value: a.value == null ? (i >= 0 ? cur.items[i].value : 10) : Math.max(0, Number(a.value) || 0),
          color: a.color || (i >= 0 ? cur.items[i].color : PALETTE[cur.items.length % PALETTE.length]),
        };
        if (i >= 0) cur.items[i] = item; else cur.items.push(item);
        if (cur.items.length > 5) cur.items = cur.items.slice(0, 5);
      } else throw new Error('要么给 items（整套），要么给 name+value（改一项），要么给 remove（删一项）');
      if (a.title) cur.title = String(a.title).trim().slice(0, 20);
      const sum = cur.items.reduce((s, x) => s + (Number(x.value) || 0), 0) || 1;
      d.tide = cur;
      await save(env, slot, d);
      return txt({ 已更新: { 标题: cur.title, 项目: cur.items.map((x) => x.name + ' ' + x.value + '（' + Math.round(((Number(x.value) || 0) / sum) * 100) + '%）') } });
    }
    case 'get_prefs': {
      const p = d.prefs && typeof d.prefs === 'object' ? d.prefs : {};
      const KEYS = ['bg', 'flip_mode', 'font_family', 'font_scale', 'text_color', 'particles', 'hide_couple_anni', 'journal_landscape'];
      const raw = {};
      KEYS.forEach((k) => { const v = p['tpl_nest_' + k]; if (v != null && v !== '') raw[k] = String(v).slice(0, 60); });
      return txt(Object.keys(raw).length ? raw : '还没设置过外观（都是默认的）');
    }
    case 'set_prefs': {
      const inObj = a.prefs && typeof a.prefs === 'object' ? a.prefs : {};
      const KEYS = ['bg', 'flip_mode', 'font_family', 'font_scale', 'text_color', 'particles', 'hide_couple_anni', 'journal_landscape'];
      d.prefs = d.prefs && typeof d.prefs === 'object' ? d.prefs : {};
      const changed = {};
      Object.keys(inObj).forEach((k) => {
        const key = k.indexOf('tpl_nest_') === 0 ? k : 'tpl_nest_' + k;
        const short = key.replace('tpl_nest_', '');
        if (KEYS.indexOf(short) < 0) return;
        const v = String(inObj[k] == null ? '' : inObj[k]);
        if (v) { d.prefs[key] = v.slice(0, 400); changed[short] = v.slice(0, 60); } else { delete d.prefs[key]; changed[short] = '（已清空→恢复默认）'; }
      });
      if (!Object.keys(changed).length) throw new Error('没有可改的键，可用：' + KEYS.join(' / '));
      await save(env, slot, d);
      return txt({ 已更新: changed, 提示: '对方手机下次同步就会变' });
    }
    case 'list_diaries': {
      const mode = a.mode === 'month' ? 'month' : 'week';
      const all = diariesOf(d);
      const books = {};
      all.forEach((x) => {
        if (!x) return;
        const k = bookKeyOf(x.date, mode);
        if (!k) return;
        books[k] = books[k] || { entries: [], quote: '' };
        if (isQuoteRec(x)) books[k].quote = x.text || '';
        else books[k].entries.push(x);
      });
      const keys = Object.keys(books).sort().reverse();
      const out = keys.filter((k) => !a.book || k === a.book).map((k) => {
        const b = books[k];
        const item = {
          册: k, 时间: bookTitleOf(k), 篇数: b.entries.length,
          这一册的话: b.quote || '（还没写）',
          篇目: b.entries.map((x) => Object.assign(
            { id: x.id, 标题: x.title, 日期: x.date },
            a.with_text ? { 正文: String(x.text || '').slice(0, 300), 纸条: (x.notes || []).length, 素材: (x.mats || []).length } : { 纸条: (x.notes || []).length, 素材: (x.mats || []).length })),
        };
        return item;
      });
      if (!out.length) return txt('手帐还是空的（或这一册不存在）');
      return txt({ 分册方式: mode === 'month' ? '按月' : '按周（周一起）', 共: keys.length + ' 册', 册列表: out });
    }
    case 'update_diary': {
      const all = diariesOf(d);
      const i = all.findIndex((x) => x && !isQuoteRec(x) && (a.id ? x.id === a.id : x.title === a.title));
      if (i < 0) throw new Error('找不到这篇手帐（id 可以从 list_diaries 拿）');
      if (a.title != null) all[i].title = String(a.title).slice(0, 40);
      if (a.text != null) all[i].text = String(a.text);
      if (a.date != null) all[i].date = String(a.date).replace(/-/g, '.');
      if (a.weather != null) all[i].weather = String(a.weather).slice(0, 20);
      d.bookDiaries = all;
      await save(env, slot, d);
      return txt({ 已更新: { id: all[i].id, 标题: all[i].title, 日期: all[i].date } });
    }
    case 'delete_diary': {
      const all = diariesOf(d);
      const before = all.length;
      const kept = all.filter((x) => !(x && !isQuoteRec(x) && (a.id ? x.id === a.id : (a.title && String(x.title).indexOf(a.title) >= 0))));
      if (kept.length === before) throw new Error('没找到要删的手帐');
      d.bookDiaries = kept;
      await save(env, slot, d);
      return txt('已删掉 ' + (before - kept.length) + ' 篇');
    }
    case 'set_book_quote': {
      if (!a.quote) throw new Error('要给 quote');
      const mode = a.mode === 'month' ? 'month' : 'week';
      const key = a.book || bookKeyOf(a.date || today(), mode);
      if (!key) throw new Error('定位不到是哪一册，请给 date 或 book');
      const all = diariesOf(d);
      const i = all.findIndex((x) => isQuoteRec(x) && x.book === key);
      const rec = { id: 'jq_' + key.replace(/[^0-9a-zA-Z]/g, '_'), kind: 'quote', book: key,
        date: String(key.slice(2)).replace(/-/g, '.'), title: '这一册的话', weather: '', text: String(a.quote), notes: [] };
      if (i >= 0) all[i] = Object.assign({}, all[i], rec); else all.push(rec);
      d.bookDiaries = all;
      await save(env, slot, d);
      return txt({ 已写下: rec.text, 属于: bookTitleOf(key) });
    }
    case 'set_nest_image': {
      const which = String(a.which || '');
      if (['avatar1', 'avatar2', 'journalPhoto', 'wallpaper', 'particle'].indexOf(which) < 0) {
        throw new Error('which 只能是 avatar1 / avatar2 / journalPhoto / wallpaper / particle');
      }
      let url = a.url ? String(a.url) : '';
      if (!url && a.data_base64) {
        url = await storeImage(env, unb64(String(a.data_base64).replace(/^data:[^,]+,/, '')), a.mime || 'image/jpeg', origin, slot);
      }
      if (!url) throw new Error('要给 url 或 data_base64');
      d.nestImages = d.nestImages && typeof d.nestImages === 'object' ? d.nestImages : {};
      d.nestImages[which] = url;
      if (which === 'particle' && d.prefs && typeof d.prefs === 'object') d.prefs['tpl_nest_particles'] = 'custom';
      await save(env, slot, d);
      const NAME = { avatar1: '第一位头像', avatar2: '第二位头像', journalPhoto: '手帐拍立得', wallpaper: '全屏壁纸', particle: '自定义漂浮物图案' };
      return txt({ 已换好: NAME[which] || which, 地址: url, 说明: '对方手机下次同步就会变' });
    }
    case 'add_code_patch': {
      const css = a.css != null ? String(a.css) : '';
      const js = a.js != null ? String(a.js) : '';
      if (!css.trim() && !js.trim()) throw new Error('css 和 js 至少要给一个');
      d.codePatches = Array.isArray(d.codePatches) ? d.codePatches : [];
      const rec = { id: rid('cp'), name: String(a.name || ('补丁' + (d.codePatches.length + 1))).slice(0, 40),
        css: css.slice(0, 40000), js: js.slice(0, 40000), enabled: a.enabled !== false, at: new Date().toISOString() };
      d.codePatches.unshift(rec);
      d.codePatches = d.codePatches.slice(0, 40);
      await save(env, slot, d);
      return txt({ 已加补丁: rec.name, id: rec.id, 提示: '对方网页下次打开（或刷新）就会生效' });
    }
    case 'list_code_patches': {
      const ps = Array.isArray(d.codePatches) ? d.codePatches : [];
      if (!ps.length) return txt('还没有代码补丁（可以用 add_code_patch 加）');
      return txt(ps.map((p) => ({ id: p.id, 名字: p.name, 启用: p.enabled !== false, CSS长度: (p.css || '').length, JS长度: (p.js || '').length })));
    }
    case 'remove_code_patch': {
      const ps = Array.isArray(d.codePatches) ? d.codePatches : [];
      const keep = ps.filter((p) => !(a.id ? p.id === a.id : (a.name && String(p.name).indexOf(a.name) >= 0)));
      if (keep.length === ps.length) throw new Error('没找到这个补丁（用 list_code_patches 看看）');
      d.codePatches = keep;
      await save(env, slot, d);
      return txt('已删掉 ' + (ps.length - keep.length) + ' 个补丁，剩 ' + keep.length + ' 个');
    }
    case 'set_code_patch': {
      const ps = Array.isArray(d.codePatches) ? d.codePatches : [];
      const i = ps.findIndex((p) => a.id ? p.id === a.id : (a.name && String(p.name).indexOf(a.name) >= 0));
      if (i < 0) throw new Error('没找到这个补丁');
      if (a.css != null) ps[i].css = String(a.css).slice(0, 40000);
      if (a.js != null) ps[i].js = String(a.js).slice(0, 40000);
      if (a.new_name != null) ps[i].name = String(a.new_name).slice(0, 40);
      if (typeof a.enabled === 'boolean') ps[i].enabled = a.enabled;
      d.codePatches = ps;
      await save(env, slot, d);
      return txt({ 已改: ps[i].name, 启用: ps[i].enabled !== false, 提示: '对方刷新一下就生效' });
    }
    case 'add_page_material': {
      const all = diariesOf(d);
      let i = -1;
      if (a.diary_id) i = all.findIndex((x) => x && x.id === a.diary_id);
      else { for (let k = 0; k < all.length; k++) { if (all[k] && !isQuoteRec(all[k]) && Array.isArray(all[k].mats) === true) { i = k; break; } } }
      if (i < 0 && !a.diary_id) { for (let k = 0; k < all.length; k++) { if (all[k] && !isQuoteRec(all[k])) { i = k; break; } } }
      if (i < 0) throw new Error('找不到那篇手帐（用 list_diaries 拿 id）');
      let url = a.url ? String(a.url) : '';
      if (!url && a.mat_id) {
        const lib = Array.isArray(d.journalMats) ? d.journalMats : [];
        const hit = lib.find((m) => m && m.id === a.mat_id);
        if (!hit) throw new Error('素材库里没有这个 id（可用 list_items 的 journalMats 看看）');
        url = hit.url;
      }
      if (!url) throw new Error('要给 url（或素材库的 mat_id）');
      all[i].mats = Array.isArray(all[i].mats) ? all[i].mats : [];
      const sides = a.side === 'both' ? ['left', 'right'] : [a.side === 'left' ? 'left' : 'right'];
      sides.forEach(function (sd, k) { all[i].mats.push({
        url: url,
        side: sd,
        x: a.x == null ? 15 : Math.max(-5, Math.min(95, Number(a.x) || 0)),
        y: a.y == null ? 20 : Math.max(-5, Math.min(95, Number(a.y) || 0)),
        w: a.w == null ? 26 : Math.max(6, Math.min(80, Number(a.w) || 26)),
        rot: a.rot == null ? Number(((Math.random() * 12) - 6).toFixed(1)) : Number(a.rot) || 0,
      }); });
      d.bookDiaries = all;
      await save(env, slot, d);
      return txt({ 已贴到: all[i].title || all[i].id, 现在这一页有: all[i].mats.length + ' 个素材', 提示: '手机上打开手帐就能看到，可以拖动位置' });
    }
    case 'list_page_materials': {
      const all = diariesOf(d);
      let e = null;
      if (a.diary_id) e = all.find((x) => x && x.id === a.diary_id) || null;
      else e = all.find((x) => x && !isQuoteRec(x) && Array.isArray(x.mats) && x.mats.length) || null;
      if (!e) return txt('这篇手帐上还没有素材（可以用 add_page_material 贴一个）');
      return txt({ 标题: e.title, 日期: e.date, 素材: (e.mats || []).map((m, i) => ({ 序号: i, 地址: m.url, 位置: m.x + '% , ' + m.y + '%', 宽度: (m.w || 26) + '%' })) });
    }
    case 'set_page_style': {
      const TPL = ['none', 'folder', 'binder', 'basket', 'tin', 'grid'];
      const PAL = ['soft', 'wine', 'cream', 'slate', 'ink'];
      const all = diariesOf(d);
      let e = null;
      if (a.diary_id) e = all.find((x) => x && x.id === a.diary_id) || null;
      else e = all.find((x) => x && !isQuoteRec(x)) || null;
      if (!e) throw new Error('找不到那篇手帐（可以用 list_diaries 拿 id）');
      e.style = e.style && typeof e.style === 'object' ? e.style : {};
      if (a.tpl != null) {
        if (TPL.indexOf(String(a.tpl)) < 0) throw new Error('tpl 只能是：' + TPL.join(' / '));
        e.style.tpl = String(a.tpl);
      }
      if (a.palette != null) {
        if (PAL.indexOf(String(a.palette)) < 0) throw new Error('palette 只能是：' + PAL.join(' / '));
        e.style.palette = String(a.palette);
      }
      if (a.side != null) {
        if (['left', 'right', 'both'].indexOf(String(a.side)) < 0) throw new Error('side 只能是 left / right / both');
        e.style.side = String(a.side);
      }
      d.bookDiaries = all;
      await save(env, slot, d);
      const NAMEC = { none: '朴素', folder: '文件夹', binder: '活页本', basket: '购物篮', tin: '铁盒', grid: '方格纸' };
      const NAMEP = { soft: '柔粉', wine: '酒红', cream: '奶油', slate: '蓝灰', ink: '墨黑' };
      return txt({ 已套用: (NAMEC[e.style.tpl] || '朴素') + ' · ' + (NAMEP[e.style.palette] || '柔粉'), 手帐: e.title || e.id, 提示: '手机上打开这篇手帐就是新版面；可以再让我「一键排版」把素材摆进格子里' });
    }
    /* ===== 想你计数器 ===== */
    case 'get_miss_count': {
      const date = a.date ? String(a.date).replace(/\./g, '-') : fmtCn(cnDayNum());
      const obj = (d.missCount && typeof d.missCount === 'object' && !Array.isArray(d.missCount)) ? d.missCount : {};
      const todayRec = obj[date] || {};
      let sum = 0, week = 0;
      const wkStart = cnDayNum() - 6;
      Object.keys(obj).forEach((k) => {
        const r = obj[k] || {};
        const s = (parseInt(r.p1, 10) || 0) + (parseInt(r.p2, 10) || 0);
        sum += s;
        const dn = dayNum(k);
        if (dn != null && dn >= wkStart && dn <= cnDayNum()) week += s;
      });
      const nm = namesOf(d);
      return txt({
        日期: date,
        第一位: { 称呼: labelOf(d, 1), 想了: parseInt(todayRec.p1, 10) || 0 },
        第二位: { 称呼: labelOf(d, 2), 想了: parseInt(todayRec.p2, 10) || 0 },
        今日合计: (parseInt(todayRec.p1, 10) || 0) + (parseInt(todayRec.p2, 10) || 0),
        近7天: week, 累计: sum,
        今天谁想得多: (parseInt(todayRec.p1, 10) || 0) > (parseInt(todayRec.p2, 10) || 0) ? labelOf(d, 1) : ((parseInt(todayRec.p2, 10) || 0) > (parseInt(todayRec.p1, 10) || 0) ? labelOf(d, 2) : '（还没人点 / 打平）'),
      });
    }
    case 'add_miss_count': {
      const date = a.date ? String(a.date).replace(/\./g, '-') : fmtCn(cnDayNum());
      if (dayNum(date) == null) throw new Error('日期格式应为 YYYY-MM-DD');
      const obj = (d.missCount && typeof d.missCount === 'object' && !Array.isArray(d.missCount)) ? d.missCount : {};
      const nm = namesOf(d);
      // 定位是谁：who=1/2，或填昵称
      let p;
      if (a.who != null) {
        const w = String(a.who).trim();
        if (w === '1' || w === '2') p = Number(w);
        else if (nm.length >= 2 && w === nm[1]) p = 2;
        else p = 1;
      } else p = 1;
      const rec = obj[date] || { p1: 0, p2: 0 };
      rec[p === 2 ? 'p2' : 'p1'] = (parseInt(rec[p === 2 ? 'p2' : 'p1'], 10) || 0) + 1;
      obj[date] = rec;
      d.missCount = obj;
      await save(env, slot, d);
      return txt({ '已 +1': labelOf(d, p) + ' 想对方了', 日期: date, 现在: { 第一位: rec.p1 || 0, 第二位: rec.p2 || 0 } });
    }
    case 'set_miss_count': {
      const date = a.date ? String(a.date).replace(/\./g, '-') : fmtCn(cnDayNum());
      if (dayNum(date) == null) throw new Error('日期格式应为 YYYY-MM-DD');
      const obj = (d.missCount && typeof d.missCount === 'object' && !Array.isArray(d.missCount)) ? d.missCount : {};
      obj[date] = { p1: Math.max(0, Number(a.p1) || 0), p2: Math.max(0, Number(a.p2) || 0) };
      d.missCount = obj;
      await save(env, slot, d);
      return txt({ 已设置: date, 第一位: obj[date].p1, 第二位: obj[date].p2 });
    }
    case 'reset_miss_count': {
      const date = a.date ? String(a.date).replace(/\./g, '-') : fmtCn(cnDayNum());
      if (dayNum(date) == null) throw new Error('日期格式应为 YYYY-MM-DD');
      const obj = (d.missCount && typeof d.missCount === 'object' && !Array.isArray(d.missCount)) ? d.missCount : {};
      if (obj[date]) { delete obj[date]; d.missCount = obj; await save(env, slot, d); }
      return txt('已清零 ' + date + ' 的想你计数');
    }
    /* ===== 纯手帐本 Free Canvas ===== */
    case 'get_freebook_pages': {
      const list = Array.isArray(d.albumPages) ? d.albumPages : [];
      if (!list.length) return txt('纯手帐本还是空的（可以用 add_freebook_page 新建第一页）');
      if (a.page_id) {
        const pg = list.find((x) => x && x.id === a.page_id);
        if (!pg) throw new Error('找不到这一页（page_id 可用 get_freebook_pages 看）');
        return txt({
          页: pg.id, 尺寸: (pg.w || 900) + '×' + (pg.h || 1273), 元素数: (pg.items || []).length,
          最近编辑: pg.at ? fmtCn(Math.floor(pg.at / 86400000)) : '—',
          元素: (pg.items || []).map((it, i) => ({ 序号: i, id: it.id, 类型: it.type, x: it.x, y: it.y, w: it.w, 文字: it.text || undefined, 图片: it.url || undefined })),
        });
      }
      return txt({
        共: list.length + ' 页',
        页列表: list.map((pg) => ({ id: pg.id, 元素数: (pg.items || []).length, 最近编辑: pg.at ? fmtCn(Math.floor(pg.at / 86400000)) : '—' })),
      });
    }
    case 'add_freebook_page': {
      d.albumPages = Array.isArray(d.albumPages) ? d.albumPages : [];
      if (!a.page_id) {
        const pg = { id: rid('ab'), w: 900, h: Math.round(900 * 1.414), items: [], at: Date.now() };
        d.albumPages.push(pg);
        await save(env, slot, d);
        return txt({ 已新建一页: pg.id, 现在共: d.albumPages.length + ' 页' });
      }
      const pg = d.albumPages.find((x) => x && x.id === a.page_id);
      if (!pg) throw new Error('找不到这一页');
      if (!a.element) throw new Error('要给 element（元素对象）');
      const el = { id: rid('el'), ...a.element };
      if (!el.type) el.type = 'text';
      if (el.type === 'text' && !el.text) el.text = '双击改字';
      pg.items = Array.isArray(pg.items) ? pg.items : [];
      pg.items.push(el);
      pg.at = Date.now();
      await save(env, slot, d);
      return txt({ 已加元素: el.id, 类型: el.type, 这一页现在: pg.items.length + ' 个元素' });
    }
    case 'update_freebook_page': {
      d.albumPages = Array.isArray(d.albumPages) ? d.albumPages : [];
      const pg = d.albumPages.find((x) => x && x.id === a.page_id);
      if (!pg) throw new Error('找不到这一页');
      if (a.element_id) {
        pg.items = Array.isArray(pg.items) ? pg.items : [];
        const it = pg.items.find((x) => x && x.id === a.element_id);
        if (!it) throw new Error('找不到这个元素');
        Object.assign(it, a.element || {});
        pg.at = Date.now();
        await save(env, slot, d);
        return txt({ 已改元素: it.id, 现在: it });
      }
      if (a.element) {
        Object.assign(pg, a.element);
        pg.at = Date.now();
        await save(env, slot, d);
        return txt({ 已改整页: pg.id, 元素数: (pg.items || []).length });
      }
      throw new Error('要给 element_id（改元素）或 element（改整页）');
    }
    case 'delete_freebook_page': {
      d.albumPages = Array.isArray(d.albumPages) ? d.albumPages : [];
      const pg = d.albumPages.find((x) => x && x.id === a.page_id);
      if (!pg) throw new Error('找不到这一页');
      if (a.element_id) {
        pg.items = Array.isArray(pg.items) ? pg.items : [];
        const before = pg.items.length;
        pg.items = pg.items.filter((x) => x && x.id !== a.element_id);
        if (pg.items.length === before) throw new Error('没找到这个元素');
        pg.at = Date.now();
        await save(env, slot, d);
        return txt({ 已删元素: a.element_id, 这一页剩: pg.items.length + ' 个元素' });
      }
      d.albumPages = d.albumPages.filter((x) => x && x.id !== a.page_id);
      await save(env, slot, d);
      return txt({ 已删整页: a.page_id, 剩: d.albumPages.length + ' 页' });
    }
    case 'list_book_notes': {
      const ns = Array.isArray(d.bookNotes) ? d.bookNotes : [];
      let list = ns;
      if (a.book_id) list = list.filter((x) => x && x.bid === a.book_id);
      if (a.chapter) list = list.filter((x) => x && String(x.chapter) === String(a.chapter));
      if (!list.length) return txt('还没有批注（可以用 add_book_note 给某段文字加一条）');
      return txt(list.map((x) => ({
        id: x.id, 书: x.bid, 章节: x.chapter, 段落: x.paraIndex,
        '🟡我的想法': x.mine || '', '🔵AI解读': x.ai || '', 时间: x.at ? new Date(x.at).toISOString().slice(0, 10) : '',
      })));
    }
    case 'add_book_note': {
      if (!a.book_id || a.chapter == null || a.paraIndex == null) throw new Error('需要 book_id、chapter、paraIndex');
      const mine = String(a.mine || '').trim(), ai = String(a.ai || '').trim();
      if (!mine && !ai) throw new Error('mine 和 ai 至少要填一个');
      d.bookNotes = Array.isArray(d.bookNotes) ? d.bookNotes : [];
      d.bookNotes.unshift({
        id: rid('bn'), k: `${a.book_id}|${a.chapter}|${a.paraIndex}`,
        bid: a.book_id, chapter: a.chapter, paraIndex: Number(a.paraIndex),
        mine, ai, at: Date.now(),
      });
      await save(env, slot, d);
      return txt({ 已加批注: d.bookNotes[0].id, 段落: `${a.chapter} #${a.paraIndex}` });
    }
    case 'update_book_note': {
      d.bookNotes = Array.isArray(d.bookNotes) ? d.bookNotes : [];
      const i = a.id != null ? d.bookNotes.findIndex((x) => x && x.id === a.id)
        : (a.book_id && a.chapter != null && a.paraIndex != null)
          ? d.bookNotes.findIndex((x) => x && x.bid === a.book_id && String(x.chapter) === String(a.chapter) && Number(x.paraIndex) === Number(a.paraIndex)) : -1;
      if (i < 0) throw new Error('找不到这条批注（用 list_book_notes 拿 id）');
      const cur = d.bookNotes[i];
      if (a.mine != null) cur.mine = String(a.mine).trim();
      if (a.ai != null) cur.ai = String(a.ai).trim();
      cur.at = Date.now();
      await save(env, slot, d);
      return txt({ 已更新: cur.id, '🟡我的想法': cur.mine, '🔵AI解读': cur.ai });
    }
    case 'delete_book_note': {
      d.bookNotes = Array.isArray(d.bookNotes) ? d.bookNotes : [];
      const i = a.id != null ? d.bookNotes.findIndex((x) => x && x.id === a.id)
        : (a.book_id && a.chapter != null && a.paraIndex != null)
          ? d.bookNotes.findIndex((x) => x && x.bid === a.book_id && String(x.chapter) === String(a.chapter) && Number(x.paraIndex) === Number(a.paraIndex)) : -1;
      if (i < 0) throw new Error('找不到这条批注');
      const [removed] = d.bookNotes.splice(i, 1);
      await save(env, slot, d);
      return txt({ 已删批注: removed.id, 剩: d.bookNotes.length + ' 条' });
    }
    case 'list_themes': {
      const ts = Array.isArray(d.nestThemes) ? d.nestThemes : [];
      if (!ts.length) return txt('（还没有保存过主题）');
      return txt(ts.map((t, i) => ({
        index: i, id: t && t.id, name: t && t.name,
        保存时间: t && t.at ? new Date(t.at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '',
        壁纸: (t && t.state && t.state.bg) ? '有' : '无',
        图标: (t && t.state && t.state.icons && Object.keys(t.state.icons).length) ? Object.keys(t.state.icons).length + ' 个' : '无',
        字体: (t && t.state && t.state.fontFamily) || 'default',
      })));
    }
    case 'save_theme': {
      const ts = Array.isArray(d.nestThemes) ? d.nestThemes : [];
      const state = a.state || {};
      ts.unshift({ id: 'th' + Date.now(), name: String(a.name || '').trim() || '未命名主题', at: Date.now(), state });
      d.nestThemes = ts;
      await save(env, slot, d);
      return txt({ 已存主题: ts[0].name, id: ts[0].id, 共: ts.length + ' 个' });
    }
    case 'rename_theme': {
      const ts = Array.isArray(d.nestThemes) ? d.nestThemes : [];
      const i = ts.findIndex((x) => x && x.id === a.id);
      if (i < 0) throw new Error('找不到这个主题（用 list_themes 拿 id）');
      ts[i].name = String(a.name || '').trim() || ts[i].name;
      d.nestThemes = ts;
      await save(env, slot, d);
      return txt({ 已改名: ts[i].name });
    }
    case 'delete_theme': {
      const ts = Array.isArray(d.nestThemes) ? d.nestThemes : [];
      const i = a.id != null ? ts.findIndex((x) => x && x.id === a.id) : ts.findIndex((x) => x && x.name === a.name);
      if (i < 0) throw new Error('找不到这个主题');
      const [removed] = ts.splice(i, 1);
      d.nestThemes = ts;
      await save(env, slot, d);
      return txt({ 已删主题: removed.name, 剩: ts.length + ' 个' });
    }
    default: throw new Error('未知工具：' + name);
  }
}

async function rpc(m, env, origin, slot, token) {
  const { id, method, params } = m || {};
  if (id === undefined) return null;                        // 通知，无需回复
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const bad = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'xiaowo', version: '2.8.0' } });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    try { return ok(await callTool(params.name, params.arguments || {}, env, origin, slot, token)); }
    catch (e) { return ok({ isError: true, content: [{ type: 'text', text: '出错：' + e.message }] }); }
  }
  return bad(-32601, 'Method not found');
}

// ---------- 入口（多人版：一份 Worker，每个小窝各自一把密码） ----------
export default {
  async fetch(req, env) {
    const u = new URL(req.url), origin = u.origin, p = u.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // 首页：只说明服务在跑，不暴露任何人的数据
    if (p === '/' && req.method === 'GET') return new Response('小窝 MCP 服务运行中 ♡（多人版：每个小窝用各自的密钥）', { headers: CORS });

    const who = await resolveSlot(env, req, u);
    if (!who) return p.startsWith('/img/') ? new Response('Forbidden', { status: 403, headers: CORS }) : json({ error: 'unauthorized' }, 401);

    // 图片：必须带自己小窝的密钥才能看到
    if (p.startsWith('/img/') && req.method === 'GET') {
      const id = p.slice(5).split(/[?#]/)[0];
      const got = await env.NEST.getWithMetadata(imgKey(who.slot, id), 'arrayBuffer');
      if (!got.value) return new Response('Not found', { status: 404, headers: CORS });
      return new Response(got.value, { headers: { 'Content-Type': got.metadata?.type || 'image/jpeg', 'Cache-Control': 'private, max-age=604800', ...CORS } });
    }

    if ((p === '/mcp' || p === '/') && req.method === 'POST') {
      let body; try { body = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => rpc(m, env, origin, who.slot, who.token)))).filter(Boolean);
        return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
      }
      const out = await rpc(body, env, origin, who.slot, who.token);
      return out ? json(out) : new Response(null, { status: 202, headers: CORS });
    }
    if (p === '/mcp') return new Response('Method Not Allowed', { status: 405, headers: CORS });

    // ---- 网页同步 ----
    if (p === '/api/whoami' && req.method === 'GET') {
      const list = Object.keys(await load(env, who.slot)).length;
      return json({ ok: true, slot: who.slot, 小窝编号: '小窝 ' + who.slot.slice(0, 6), 板块数: list, server: '2.1.0' });
    }
    if (p === '/api/data' && req.method === 'GET') return json(await load(env, who.slot));
    if (p.startsWith('/api/data/') && req.method === 'GET') {     // 读单键：GET /api/data/<key>
      const key = p.slice(10);
      if (![...LISTS, ...VALUES, 'albumCategories', ...EXTRA_KEYS].includes(key)) return json({ error: 'bad key' }, 400);
      const d = await load(env, who.slot);
      if (!(key in d) || d[key] == null) return json({ error: 'not found' }, 404);
      return json(d[key]);
    }
    if (p.startsWith('/api/data/') && req.method === 'PUT') {      // 按板块整体覆盖：PUT /api/data/todos
      const key = p.slice(10);
      if (![...LISTS, ...VALUES, 'albumCategories', ...EXTRA_KEYS].includes(key)) return json({ error: 'bad key' }, 400);
      const d = await load(env, who.slot); d[key] = await req.json(); await save(env, who.slot, d); return json({ ok: true });
    }
    if (p === '/api/upload' && req.method === 'POST') {            // 原始图片字节 → 返回带密钥的链接
      try { const url = await storeImage(env, await req.arrayBuffer(), req.headers.get('Content-Type'), origin, who.slot); return json({ url }); }
      catch (e) { return json({ error: e.message }, 400); }
    }
    return json({ error: 'not found' }, 404);
  },
};
