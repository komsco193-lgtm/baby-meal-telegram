import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'cloud-data', 'recipes.ndjson');
const SEASONAL = path.join(ROOT, 'cloud-data', 'seasonal.json');
const MENU_DIR = path.join(ROOT, 'menus', 'weekly');
const BOARD_URL = 'https://www.eunpyeongcenter.co.kr/sub02/sub01.php';

function localDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const result = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: Number(result.year), month: Number(result.month), day: Number(result.day) };
}

function dateOnly(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`날짜 형식이 잘못되었습니다: ${value}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

function iso(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return d; }
function nextMondayKst() {
  const now = localDateParts();
  const today = dateOnly(`${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`);
  // JavaScript UTC noon is used only as a date container; the weekday is stable.
  const weekday = today.getUTCDay(); // Sunday 0 ... Saturday 6
  const daysUntilMonday = (8 - weekday) % 7 || 7;
  return iso(addDays(today, daysUntilMonday));
}

function norm(value) { return String(value || '').replace(/\s+/g, '').toLowerCase(); }
function koreanDate(date) {
  const d = dateOnly(date);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${weekday})`;
}
function safeJson(value) { return JSON.stringify(value, null, 2) + '\n'; }

const prohibited = /소금|간장|된장|액젓|설탕|꿀|후추|양념장|데리야끼|소스|조미료|맛술|가염|김치|고추|고춧|다시다|육수/;
const snackOnly = /과자|차$|주스|주스$|스틱|칩|김치|양념|소스|떡/;
const sourceDateCutoff = localDateParts().year;
const inventory = ['쌀', '밥', '양파', '대파', '돼지', '안심', '소고기', '가자미', '고구마', '우유', '요거트'];

function loadRecords() {
  if (!fs.existsSync(DATA)) throw new Error(`레시피 색인이 없습니다: ${DATA}`);
  const records = [];
  for (const line of fs.readFileSync(DATA, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (!row.sourceDate || row.dateIssues?.length) continue;
    row.postTitle ||= '';
    row.meal ||= '';
    row.name ||= '';
    row.ingredients ||= [];
    row.method ||= [];
    records.push(row);
  }
  return records;
}

function isBabySource(row) { return /이유식/.test(row.postTitle); }
function isToddlerSource(row) { return /1-2세|1~2세/.test(row.postTitle); }
function mealIs(row, pattern) { return pattern.test(norm(row.meal)); }
function hasMainName(row) { return /죽|진밥|덮밥|볶음밥|밥/.test(row.name) && !snackOnly.test(row.name); }
function ingredientNames(row) { return row.ingredients.map(i => String(i.name || '')).filter(n => n && n !== '-'); }
function latestByName(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = norm(row.name);
    if (!key) continue;
    const prior = map.get(key);
    if (!prior || String(row.sourceDate) > String(prior.sourceDate) || (isBabySource(row) && !isBabySource(prior))) map.set(key, row);
  }
  return [...map.values()];
}

function chooseCandidates(records, month, year) {
  const monthRows = records.filter(r => Number(String(r.sourceDate).slice(5, 7)) === month && Number(String(r.sourceDate).slice(0, 4)) <= year);
  if (!monthRows.length) throw new Error(`${month}월 출처 레시피가 색인에 없습니다.`);
  const availableYears = [...new Set(monthRows.map(r => Number(String(r.sourceDate).slice(0, 4))))].sort((a, b) => b - a);
  const preferredYear = availableYears[0];
  const preferred = monthRows.filter(r => Number(String(r.sourceDate).slice(0, 4)) === preferredYear);
  const breakfasts = latestByName(preferred.filter(r => isBabySource(r) && mealIs(r, /오전간식|오전/))
    .filter(r => /죽|진밥|밥/.test(r.name) && !snackOnly.test(r.name)));
  const mainsBaby = latestByName(preferred.filter(r => isBabySource(r) && mealIs(r, /중식|점심|저녁/)).filter(hasMainName));
  const mainsToddler = latestByName(preferred.filter(r => isToddlerSource(r) && mealIs(r, /저녁|점심|중식/)).filter(hasMainName));
  const mains = mainsBaby.length >= 5 ? mainsBaby : [...mainsBaby, ...mainsToddler];
  if (breakfasts.length < 2) throw new Error(`${preferredYear}년 ${month}월 아침 후보가 부족합니다.`);
  if (mains.length < 4) throw new Error(`${preferredYear}년 ${month}월 주식 후보가 부족합니다.`);
  return { preferredYear, breakfasts, mains };
}

function recipeScore(row, seasonalNames, usedNames, offset) {
  const names = ingredientNames(row).map(norm);
  let score = 0;
  score += names.filter(n => inventory.some(x => n.includes(norm(x)) || norm(x).includes(n))).length * 5;
  score += names.filter(n => seasonalNames.some(x => n.includes(norm(x)) || norm(x).includes(n))).length * 4;
  score += /죽|진밥/.test(row.name) ? 4 : 0;
  score -= Math.max(0, names.length - 5) * 1.5;
  score -= usedNames.has(norm(row.name)) ? 100 : 0;
  const hash = crypto.createHash('sha256').update(`${row.name}|${row.sourceDate}`).digest().readUInt32BE(0);
  score += ((hash + offset) % 1000) / 10000;
  return score;
}

function chooseDistinct(rows, count, seasonalNames, offset) {
  const chosen = [];
  const used = new Set();
  const pool = [...rows];
  while (chosen.length < count && pool.length) {
    pool.sort((a, b) => recipeScore(b, seasonalNames, used, offset) - recipeScore(a, seasonalNames, used, offset));
    const row = pool.shift();
    if (used.has(norm(row.name))) continue;
    chosen.push(row); used.add(norm(row.name));
  }
  return chosen;
}

function cleanMethod(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .split(/[\n。]/)
    .map(s => s.trim())
    .filter(s => s && !prohibited.test(s))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedIngredient(row, item) {
  const name = String(item.name || '').trim();
  const amount = item.grams;
  if (!name || name === '-' || prohibited.test(name)) return null;
  const n = norm(name);
  if (n === '쌀' || n.includes('불린쌀')) return { name: '지은 밥(원문 쌀 대체)', amount: Number(amount || 0) * 2.5, unit: 'g' };
  if (n.includes('우유(두유)') || n === '두유') return { name: '살균 우유', amount: Number(amount || 0), unit: 'mL' };
  if (n.includes('요구르트')) return { name: '무가당 플레인 요거트', amount: Number(amount || 0), unit: 'g' };
  return { name, amount: Number(amount || 0), unit: 'g' };
}

function makeRecipe(row, id, usedDates) {
  const ingredients = row.ingredients.map(i => normalizedIngredient(row, i)).filter(Boolean);
  const ingredientText = ingredients.length
    ? ingredients.map(i => `${i.name} ${Number.isFinite(i.amount) ? Math.round(i.amount * 10) / 10 : i.amount}${i.unit}`).join(', ')
    : '원문 재료를 확인하되 가정용 무염 기준으로 조정';
  const raw = cleanMethod(row.method?.join(' '));
  const protein = ingredientNames(row).some(n => /고기|소고기|돼지|닭|생선|가자미|달걀|계란|두부|콩/.test(n));
  const steps = [
    '재료를 씻고 3~5mm 정도로 잘게 썹니다. 고기·생선은 질긴 부분과 잔가시를 다시 확인합니다.',
    protein ? '고기·생선·달걀·두부를 물에 넣어 속까지 완전히 익힙니다. 달걀은 흰자와 노른자가 모두 굳을 때까지 익힙니다.' : '채소를 물에 넣고 젓가락으로 눌렀을 때 부드러워질 때까지 익힙니다.',
    '지은 밥과 물을 넣고 약불에서 8~12분 저어 재료가 충분히 부드러워지게 합니다.',
    '소금·간장·된장·액젓·설탕·꿀·후추·가염 육수는 넣지 않고, 미지근하게 식혀 아기의 씹는 능력에 맞게 제공합니다.'
  ];
  return {
    id,
    row,
    ingredients,
    usedDates,
    raw,
    steps,
    name: row.name.replace(/\s+/g, ' ').trim(),
    adaptation: '원문 재료와 흐름을 바탕으로 쌀은 지은 밥으로 바꾸고, 가정용 무염 원칙에 따라 금지 양념을 제외했습니다. 분량과 질감은 12개월 아기의 섭취 능력에 맞춰 조정합니다.'
  };
}

function buildPlan(weekStart, candidates, seasonalInfo) {
  const start = dateOnly(weekStart);
  const end = addDays(start, 6);
  const seasonalNames = seasonalInfo?.ingredients || [];
  const weekHash = crypto.createHash('sha256').update(weekStart).digest().readUInt32BE(0);
  const breakfasts = chooseDistinct(candidates.breakfasts, Math.min(3, candidates.breakfasts.length), seasonalNames, weekHash);
  const mains = chooseDistinct(candidates.mains, Math.min(5, candidates.mains.length), seasonalNames, weekHash + 17);
  if (breakfasts.length < 2 || mains.length < 4) throw new Error('주간 레시피 후보가 부족합니다.');
  const usage = new Map();
  const addUse = (row, date, meal) => {
    const key = `${row.postId}|${row.range}|${row.name}`;
    if (!usage.has(key)) usage.set(key, { row, dates: [] });
    usage.get(key).dates.push({ date, meal });
  };
  const rows = [];
  for (let day = 0; day < 7; day++) {
    const date = iso(addDays(start, day));
    const b = breakfasts[day % breakfasts.length];
    const l = mains[(day + Math.floor(day / 3)) % mains.length];
    let d = mains[(day + 2) % mains.length];
    if (norm(d.name) === norm(l.name)) d = mains[(day + 3) % mains.length];
    rows.push({ date, breakfast: b, lunch: l, dinner: d });
    addUse(b, date, '아침'); addUse(l, date, '점심'); addUse(d, date, '저녁');
  }
  const recipes = [...usage.values()].map((u, i) => makeRecipe(u.row, `R${i + 1}`, u.dates));
  const recipeByKey = new Map(recipes.map(r => [`${r.row.postId}|${r.row.range}|${r.row.name}`, r]));
  const menuRows = rows.map(r => ({
    date: r.date,
    breakfast: recipeByKey.get(`${r.breakfast.postId}|${r.breakfast.range}|${r.breakfast.name}`).id,
    lunch: recipeByKey.get(`${r.lunch.postId}|${r.lunch.range}|${r.lunch.name}`).id,
    dinner: recipeByKey.get(`${r.dinner.postId}|${r.dinner.range}|${r.dinner.name}`).id
  }));
  return { start, end, recipes, menuRows, seasonalInfo, preferredYear: candidates.preferredYear };
}

function totalsForPlan(plan) {
  const totals = new Map();
  const add = (name, amount, unit) => {
    const key = `${name}|${unit}`;
    totals.set(key, (totals.get(key) || 0) + (Number(amount) || 0));
  };
  for (const recipe of plan.recipes) {
    const uses = recipe.usedDates.length;
    for (const item of recipe.ingredients) add(item.name, item.amount * uses, item.unit);
  }
  return [...totals.entries()].map(([key, amount]) => {
    const [name, unit] = key.split('|');
    return { name, amount: Math.round(amount * 10) / 10, unit };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

function purchaseLine(item) {
  const n = norm(item.name);
  const have = inventory.some(x => n.includes(norm(x)) || norm(x).includes(n));
  let pack = '';
  if (/버섯/.test(item.name)) pack = '1팩';
  else if (/당근/.test(item.name)) pack = '1~2개';
  else if (/애호박|호박/.test(item.name)) pack = '1개';
  else if (/양배추/.test(item.name)) pack = '1/4통';
  else if (/두부/.test(item.name)) pack = '무가염 두부 1모/1팩';
  else if (/달걀|계란/.test(item.name)) pack = '2개 이상';
  else if (/우유/.test(item.name)) pack = '살균 우유 1팩';
  else if (/요거트/.test(item.name)) pack = '무가당 플레인 1통';
  else pack = `필요량 약 ${Math.ceil(item.amount)}${item.unit}`;
  return `• ${have ? '보유 재료(부족하면 보충)' : '추가 구매'}: ${item.name} ${pack} — 주간 사용량 약 ${Math.ceil(item.amount * 10) / 10}${item.unit}`;
}

function render(plan, weekStart) {
  const end = iso(plan.end);
  const recipeMap = new Map(plan.recipes.map(r => [r.id, r]));
  const lines = [];
  lines.push(`${weekStart.slice(0, 4)}년 ${Number(weekStart.slice(5, 7))}월 ${Number(weekStart.slice(8, 10))}일~${Number(end.slice(8, 10))}일 주간 식단`);
  lines.push('12개월 아기 · 무염 가정용 구성 · 아침·점심·저녁 21끼');
  lines.push('');
  lines.push('은평구 어린이·사회복지급식관리지원센터의 공개 원문 레시피를 바탕으로 가정용으로 다시 구성했습니다. 센터가 검수한 가정용 주간 식단이 아니며, 각 원문과 변경 사항을 아래에 따로 적었습니다.');
  lines.push('');
  lines.push('이번 주 장보기 목록');
  for (const item of totalsForPlan(plan)) lines.push(purchaseLine(item));
  lines.push('');
  lines.push('재료 기준: 밥은 조리 후 무게로 환산한 근사치, 고기·생선·채소·두부는 손질 후 조리 전, 달걀은 껍질 제외입니다. 보유량은 확인 전이므로 부족하면 보충합니다.');
  lines.push('');
  lines.push('주간표');
  for (const row of plan.menuRows) {
    const day = `${koreanDate(row.date)} 아침 ${recipeMap.get(row.breakfast).name} / 점심 ${recipeMap.get(row.lunch).name} / 저녁 ${recipeMap.get(row.dinner).name}`;
    lines.push(day);
  }
  lines.push('');
  lines.push('모든 끼니 공통');
  lines.push('소금·간장·된장·액젓·가염 육수·설탕·꿀·후추는 넣지 않습니다. 식재료 자체 나트륨까지 0이라는 뜻은 아닙니다. 순살 생선도 잔가시를 다시 확인하고, 음식은 부드럽고 작게 잘라 옆에서 지켜보며 먹입니다.');
  lines.push('');
  for (const recipe of plan.recipes) {
    const dates = recipe.usedDates.map(u => `${koreanDate(u.date)} ${u.meal}`).join(', ');
    lines.push(`레시피 ${recipe.id} | ${recipe.name} (사용: ${dates})`);
    lines.push(`재료: ${recipe.ingredients.map(i => `${i.name} ${Math.round(i.amount * 10) / 10}${i.unit}`).join(', ') || '원문 표를 확인'}.`);
    recipe.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    if (recipe.raw) lines.push(`원문 조리 흐름 요지: ${recipe.raw}`);
    const r = recipe.row;
    lines.push(`원문: 은평구센터 「${r.postTitle}」, 게시일 ${r.posted}, ${r.filename}, ${r.sheet} ${r.range}, 원문 날짜 ${r.sourceDate} ${r.meal} ‘${r.name}’ (날짜 셀 ${r.dateCell}).`);
    lines.push(`변경: ${recipe.adaptation}`);
    lines.push('');
  }
  lines.push('손질·보관');
  lines.push('장본 날 뒤쪽 날짜 분량은 1~2회분씩 손질해 냉동하고, 먹기 전날 필요한 만큼 해동합니다. 밥은 1시간 안에 식혀 냉장·냉동하고 냉장 밥은 24시간 안에 사용합니다. 조리한 음식은 한 번만 충분히 재가열하고 먹다 남긴 것은 재사용하지 않습니다.');
  lines.push('');
  lines.push('제철 확인');
  if (plan.seasonalInfo?.ingredients?.length) {
    lines.push(`${Number(weekStart.slice(5, 7))}월 제철 근거로 확인한 재료: ${plan.seasonalInfo.ingredients.join(', ')}.`);
    lines.push(`자료: ${plan.seasonalInfo.title}, ${plan.seasonalInfo.page}쪽, ${plan.seasonalInfo.url}`);
  } else {
    lines.push('현재 보관한 자료에서 해당 월 제철 원문을 확인하지 못해 제철이라고 임의로 단정하지 않았습니다. 다음 자료 확인 때 보완합니다.');
  }
  lines.push('');
  lines.push(`출처 게시판: ${BOARD_URL}`);
  lines.push('원문 날짜와 이번 제공 날짜는 다를 수 있습니다. 원문 양념·분량·재료를 가정용 무염 기준으로 바꾼 부분은 각 레시피에 표시했습니다.');
  return lines.join('\n').trim() + '\n';
}

function writeOutput(name, content) {
  fs.mkdirSync(MENU_DIR, { recursive: true });
  fs.writeFileSync(path.join(MENU_DIR, `${name}.txt`), content, 'utf8');
}

const weekStart = process.env.WEEK_START?.trim() || nextMondayKst();
const start = dateOnly(weekStart);
const month = start.getUTCMonth() + 1;
const year = start.getUTCFullYear();
const existing = path.join(MENU_DIR, `${weekStart}.txt`);
fs.mkdirSync(MENU_DIR, { recursive: true });
if (fs.existsSync(existing) && fs.statSync(existing).size > 0) {
  console.log(`기존 검증 식단을 유지합니다: ${existing}`);
} else {
  const seasonal = fs.existsSync(SEASONAL) ? JSON.parse(fs.readFileSync(SEASONAL, 'utf8')) : {};
  const candidates = chooseCandidates(loadRecords(), month, year);
  const plan = buildPlan(weekStart, candidates, seasonal[String(month)] || null);
  const text = render(plan, weekStart);
  writeOutput(weekStart, text);
  const provenance = {
    generatedAt: new Date().toISOString(),
    weekStart,
    weekEnd: iso(plan.end),
    sourceBoard: BOARD_URL,
    preferredSourceYear: plan.preferredYear,
    seasonalSource: plan.seasonalInfo || null,
    meals: plan.menuRows,
    recipes: plan.recipes.map(r => ({ id: r.id, name: r.name, usedDates: r.usedDates, source: {
      sourceDate: r.row.sourceDate, meal: r.row.meal, name: r.row.name, posted: r.row.posted,
      postTitle: r.row.postTitle, postUrl: r.row.postUrl, filename: r.row.filename,
      sheet: r.row.sheet, range: r.row.range, dateCell: r.row.dateCell
    }})),
    note: '공개 원문 색인에서 추출한 출처를 가정용 무염 기준으로 재구성한 자동 생성 기록입니다.'
  };
  fs.writeFileSync(path.join(MENU_DIR, `${weekStart}.sources.json`), safeJson(provenance), 'utf8');
  console.log(`새 식단을 작성했습니다: ${existing}`);
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `week_start=${weekStart}\n`);
