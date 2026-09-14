import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'cloud-data', 'recipes.ndjson');
const SEASONAL = path.join(ROOT, 'cloud-data', 'seasonal.json');
const KOREAN_SOURCES = path.join(ROOT, 'cloud-data', 'korean-sources.json');
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
function hasProtein(row) { return /소고기|쇠고기|돼지|돈육|닭|가자미|생선|임연수|달걀|계란|두부|콩/.test(ingredientNames(row).join(' ')); }
function hasHighSodiumProcessedFood(row) { return /어묵|맛살|햄|소시지|베이컨|김치|젓갈|참치|멸치/.test(ingredientNames(row).join(' ')); }
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

function chooseCandidates(records, month, year, weekStart = '', weekEnd = '') {
  const monthRows = records.filter(r => Number(String(r.sourceDate).slice(5, 7)) === month && Number(String(r.sourceDate).slice(0, 4)) <= year);
  if (!monthRows.length) throw new Error(`${month}월 출처 레시피가 색인에 없습니다.`);
  const availableYears = [...new Set(monthRows.map(r => Number(String(r.sourceDate).slice(0, 4))))].sort((a, b) => b - a);
  const preferredYear = availableYears[0];
  const preferred = monthRows.filter(r => Number(String(r.sourceDate).slice(0, 4)) === preferredYear);
  const breakfastFilter = r => /죽|진밥|밥/.test(r.name) && !snackOnly.test(r.name);
  const mainFilter = r => hasMainName(r) && hasProtein(r) && !hasHighSodiumProcessedFood(r);
  const buildPools = rows => {
    const breakfastsToddler = latestByName(rows.filter(r => isToddlerSource(r) && mealIs(r, /오전간식|오전/)).filter(breakfastFilter));
    const breakfastsBaby = latestByName(rows.filter(r => isBabySource(r) && mealIs(r, /오전간식|오전/)).filter(breakfastFilter));
    const breakfasts = breakfastsToddler.length >= 2 ? breakfastsToddler : [...breakfastsToddler, ...breakfastsBaby];
    const mainsToddler = latestByName(rows.filter(r => isToddlerSource(r) && mealIs(r, /저녁|점심|중식/)).filter(mainFilter));
    const mainsBaby = latestByName(rows.filter(r => isBabySource(r) && mealIs(r, /중식|점심|저녁/)).filter(mainFilter));
    // Use 1~2세 menus as the main pool, while retaining baby recipes so that
    // iron/protein sources such as egg, tofu and fish can rotate into the week.
    return { breakfasts, mains: [...mainsToddler, ...mainsBaby] };
  };
  const weekRows = preferred.filter(r => (!weekStart || String(r.sourceDate) >= weekStart) && (!weekEnd || String(r.sourceDate) <= weekEnd));
  let pools = buildPools(weekRows);
  // Three distinct main dishes are sufficient to rotate lunch/dinner across
  // the week. Keeping that threshold low avoids pulling a later date from the
  // same month merely to manufacture a fourth source recipe.
  let sourceWindow = weekRows.length && pools.breakfasts.length >= 2 && pools.mains.length >= 3
    ? { kind: 'week', start: weekStart, end: weekEnd }
    : { kind: 'month', year: preferredYear, month };
  if (sourceWindow.kind === 'month') pools = buildPools(preferred);
  if (pools.breakfasts.length < 2) throw new Error(`${preferredYear}년 ${month}월 아침 후보가 부족합니다.`);
  if (pools.mains.length < 3) throw new Error(`${preferredYear}년 ${month}월 주식 후보가 부족합니다.`);
  return { preferredYear, ...pools, sourceWindow };
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

function proteinKey(row) {
  const text = ingredientNames(row).join(' ');
  return text.match(/소고기|돼지|닭|가자미|임연수|생선|달걀|계란|두부|콩/)?.[0] || '식물성';
}
function sharesIngredient(name, selected) {
  const n = norm(name);
  return [...selected].some(s => n.includes(s) || s.includes(n));
}
function chooseDistinct(rows, count, seasonalNames, offset, diversifyProtein = false) {
  const chosen = [];
  const used = new Set();
  const selectedIngredients = new Set();
  const selectedProteins = new Set();
  const pool = [...rows];
  const addChosen = row => {
    if (!row || used.has(norm(row.name))) return false;
    chosen.push(row); used.add(norm(row.name));
    ingredientNames(row).map(norm).forEach(n => selectedIngredients.add(n));
    selectedProteins.add(proteinKey(row));
    return true;
  };
  // Rotate distinct protein groups before filling the remaining slots. This
  // prevents an ingredient-rich week from becoming beef-only or chicken-only.
  if (diversifyProtein) {
    const targetProteins = ['달걀', '두부', '닭', '가자미', '임연수', '생선', '소고기', '돼지'];
    for (const target of targetProteins) {
      if (chosen.length >= count) break;
      const candidates = pool.filter(row => proteinKey(row).includes(target) && !used.has(norm(row.name)));
      if (!candidates.length) continue;
      candidates.sort((a, b) => recipeScore(b, seasonalNames, used, offset) - recipeScore(a, seasonalNames, used, offset));
      const row = candidates[0];
      const index = pool.indexOf(row);
      if (index >= 0) pool.splice(index, 1);
      addChosen(row);
    }
  }
  while (chosen.length < count && pool.length) {
    pool.sort((a, b) => {
      const score = row => {
        const base = recipeScore(row, seasonalNames, used, offset);
        const names = ingredientNames(row).map(norm);
        const shared = names.filter(n => sharesIngredient(n, selectedIngredients)).length;
        const fresh = names.filter(n => !sharesIngredient(n, selectedIngredients)).length;
        const protein = proteinKey(row);
        const proteinBonus = diversifyProtein
          ? (selectedProteins.has(protein) ? -3 : (selectedProteins.size ? 8 : 0))
          : 0;
        return base + shared * 6 - fresh * 1.5 + proteinBonus;
      };
      return score(b) - score(a);
    });
    const row = pool.shift();
    if (used.has(norm(row.name))) continue;
    addChosen(row);
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
  // The source workbooks often label plain rice as "멥쌀, 백미, 생것".
  // The household plan is written for cooked rice, so convert those plain-rice
  // entries with the same 2.5x cooking-yield assumption used for the exact
  // "쌀"/"불린쌀" labels. Leave millet and other grains as their own items.
  if (n === '쌀' || n.includes('불린쌀') || n.includes('멥쌀') || n.includes('백미')) {
    return { name: '지은 밥(원문 쌀 대체)', amount: Number(amount || 0) * 2.5, unit: 'g' };
  }
  if (n.includes('우유(두유)') || n === '두유') return { name: '살균 우유', amount: Number(amount || 0), unit: 'mL' };
  if (n.includes('요구르트')) return { name: '무가당 플레인 요거트', amount: Number(amount || 0), unit: 'g' };
  // Food-composition source rows may carry descriptors such as ", 생것",
  // ", 뿌리" or ", 구근". They are useful in the provenance record but
  // splitting them would make the shopping list look like duplicate foods.
  const displayName = name
    .replace(/\s*,\s*생것/g, '')
    .replace(/\s*,\s*(뿌리|구근)\s*$/g, '')
    .trim();
  return { name: displayName || name, amount: Number(amount || 0), unit: 'g' };
}

function adaptedMenuName(value) {
  let name = String(value || '').replace(/간장/g, '').replace(/데리야끼/g, '');
  name = name.replace(/제육/g, '돼지고기').replace(/소불고기/g, '소고기');
  name = name.replace(/\s+/g, ' ').trim();
  return `${name || '가정용 메뉴'} (무염)`;
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
    name: adaptedMenuName(row.name),
    adaptation: '원문 재료와 흐름을 바탕으로 쌀은 지은 밥으로 바꾸고, 가정용 무염 원칙에 따라 금지 양념을 제외했습니다. 분량과 질감은 12개월 아기의 섭취 능력에 맞춰 조정합니다.'
  };
}

function buildPlan(weekStart, candidates, seasonalInfo) {
  const start = dateOnly(weekStart);
  const end = addDays(start, 6);
  const seasonalNames = seasonalInfo?.ingredients || [];
  const weekHash = crypto.createHash('sha256').update(weekStart).digest().readUInt32BE(0);
  const breakfasts = chooseDistinct(candidates.breakfasts, Math.min(3, candidates.breakfasts.length), seasonalNames, weekHash);
  const mains = chooseDistinct(candidates.mains, Math.min(5, candidates.mains.length), seasonalNames, weekHash + 17, true);
  if (breakfasts.length < 2 || mains.length < 3) throw new Error('주간 레시피 후보가 부족합니다.');
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
  return { start, end, recipes, menuRows, seasonalInfo, preferredYear: candidates.preferredYear, sourceWindow: candidates.sourceWindow };
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

function render(plan, weekStart, koreanSources) {
  const end = iso(plan.end);
  const recipeMap = new Map(plan.recipes.map(r => [r.id, r]));
  const lines = [];
  lines.push(`${weekStart.slice(0, 4)}년 ${Number(weekStart.slice(5, 7))}월 ${Number(weekStart.slice(8, 10))}일~${Number(end.slice(8, 10))}일 주간 식단`);
  lines.push('12개월 아기 · 무염 가정용 구성 · 아침·점심·저녁 21끼');
  lines.push('');
  lines.push('은평구 어린이·사회복지급식관리지원센터의 공개 원문 레시피를 바탕으로 가정용으로 다시 구성했습니다. 센터가 검수한 가정용 주간 식단이 아니며, 각 원문과 변경 사항을 아래에 따로 적었습니다.');
  if (plan.sourceWindow?.kind === 'week') {
    lines.push(`원문 선택 범위: ${plan.sourceWindow.start}~${plan.sourceWindow.end}에 게시된 월별 원문을 우선 사용했습니다.`);
  } else if (plan.sourceWindow?.kind === 'month') {
    lines.push(`원문 선택 범위: 해당 주간 자료가 부족해 ${plan.sourceWindow.year}년 ${plan.sourceWindow.month}월 원문으로 보완했습니다.`);
  }
  lines.push('');
  lines.push('대한민국 기준 참고 출처');
  for (const source of koreanSources) lines.push(`• ${source.name}: ${source.purpose} — ${source.url}`);
  lines.push('');
  lines.push('영양·섭취량 기준');
  lines.push('질병관리청의 12~23개월 이유기보충식 기준(평균적인 수유량을 전제로 한 하루 약 550kcal, 하루 3~4회, 1회량은 열량 밀도에 따라 250mL 컵 3/4 정도에서 점차 1컵)을 참고합니다. 이는 참고 범위이며 모유·분유 섭취량, 실제 먹은 양, 성장 상태에 따라 달라지므로 억지로 먹이지 않습니다.');
  lines.push('한국인 영양소 섭취기준과 국가표준식품성분표로 주간 식품군·철분·단백질·지방·채소 구성을 점검하지만, 개인의 과다·부족 섭취나 성장 문제를 식단만으로 진단하지 않습니다.');
  lines.push('');
  lines.push('이번 주 장보기 목록');
  for (const item of totalsForPlan(plan)) lines.push(purchaseLine(item));
  lines.push('');
  lines.push('재료 기준: 밥은 조리 후 무게로 환산한 근사치, 고기·생선·채소·두부는 손질 후 조리 전, 달걀은 껍질 제외입니다. 보유량은 확인 전이므로 부족하면 보충합니다.');
  lines.push('');
  lines.push('주간표');
  lines.push('| 날짜 | 아침 | 점심 | 저녁 |');
  lines.push('|---|---|---|---|');
  for (const row of plan.menuRows) {
    lines.push(`| ${koreanDate(row.date)} | ${recipeMap.get(row.breakfast).name} | ${recipeMap.get(row.lunch).name} | ${recipeMap.get(row.dinner).name} |`);
  }
  lines.push('');
  lines.push('날짜별 레시피');
  lines.push('각 날짜 표의 재료는 아기 1회 제공 기준의 근사치이며, 실제 먹은 양은 식욕과 수유량에 맞춥니다.');
  for (const row of plan.menuRows) {
    lines.push('');
    lines.push(`[${koreanDate(row.date)}]`);
    lines.push('| 끼니 | 메뉴 | 1회분 재료 | 조리 |');
    lines.push('|---|---|---|---|');
    for (const [meal, id] of [['아침', row.breakfast], ['점심', row.lunch], ['저녁', row.dinner]]) {
      const recipe = recipeMap.get(id);
      const ingredients = recipe.ingredients.map(i => `${i.name} ${Math.round(i.amount * 10) / 10}${i.unit}`).join(', ') || '원문 표 확인';
      const method = recipe.steps.join(' ');
      lines.push(`| ${meal} | ${recipe.name} (${recipe.id}) | ${ingredients} | ${method} |`);
    }
  }
  lines.push('');
  lines.push('모든 끼니 공통');
  lines.push('소금·간장·된장·액젓·가염 육수·설탕·꿀·후추는 넣지 않습니다. 식재료 자체 나트륨까지 0이라는 뜻은 아닙니다. 순살 생선도 잔가시를 다시 확인하고, 음식은 부드럽고 작게 잘라 옆에서 지켜보며 먹입니다.');
  lines.push('');
  lines.push('원문 출처·가정용 변경 기록');
  for (const recipe of plan.recipes) {
    const dates = recipe.usedDates.map(u => `${koreanDate(u.date)} ${u.meal}`).join(', ');
    lines.push(`레시피 ${recipe.id} | ${recipe.name} (사용: ${dates})`);
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
  lines.push('국내 기준 참고 출처는 위에 적은 질병관리청·대한소아청소년과학회·식품의약품안전처·한국영양학회·농촌진흥청 자료를 우선했습니다. 월령·성장·알레르기·실제 섭취량은 아기의 진료 내용과 제품 표시를 함께 확인합니다.');
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
const revision = /^(1|true)$/i.test(String(process.env.REVISION || process.env.RUN_REVISION || ''));
const forceRegenerate = /^(1|true)$/i.test(String(process.env.FORCE_REGENERATE || ''));
const outputStem = revision ? `${weekStart}.revised` : weekStart;
const existing = path.join(MENU_DIR, `${outputStem}.txt`);
fs.mkdirSync(MENU_DIR, { recursive: true });
const existingText = fs.existsSync(existing) ? fs.readFileSync(existing, 'utf8') : '';
// Keep the already sent first week unchanged. A revision writes a separate
// file and uses a separate idempotency key so the original receipt remains intact.
const keepExisting = !forceRegenerate && fs.existsSync(existing) && fs.statSync(existing).size > 0 &&
  (revision || weekStart === '2026-09-14' || (existingText.includes('| 날짜 | 아침 |') && existingText.includes('대한민국 기준 참고 출처')));
if (keepExisting) {
  console.log(`기존 검증 식단을 유지합니다: ${existing}`);
} else {
  const seasonal = fs.existsSync(SEASONAL) ? JSON.parse(fs.readFileSync(SEASONAL, 'utf8')) : {};
  const koreanSources = fs.existsSync(KOREAN_SOURCES) ? JSON.parse(fs.readFileSync(KOREAN_SOURCES, 'utf8')) : [];
  const candidates = chooseCandidates(loadRecords(), month, year, weekStart, iso(addDays(start, 6)));
  const plan = buildPlan(weekStart, candidates, seasonal[String(month)] || null);
  const text = render(plan, weekStart, koreanSources);
  writeOutput(outputStem, text);
  const provenance = {
    generatedAt: new Date().toISOString(),
    weekStart,
    weekEnd: iso(plan.end),
    revision,
    outputFile: `menus/weekly/${outputStem}.txt`,
    sourceBoard: BOARD_URL,
    koreanSources,
    preferredSourceYear: plan.preferredYear,
    sourceWindow: plan.sourceWindow,
    seasonalSource: plan.seasonalInfo || null,
    meals: plan.menuRows,
    recipes: plan.recipes.map(r => ({ id: r.id, name: r.name, usedDates: r.usedDates, source: {
      sourceDate: r.row.sourceDate, meal: r.row.meal, name: r.row.name, posted: r.row.posted,
      postTitle: r.row.postTitle, postUrl: r.row.postUrl, filename: r.row.filename,
      sheet: r.row.sheet, range: r.row.range, dateCell: r.row.dateCell
    }})),
    note: '공개 원문 색인에서 추출한 출처를 가정용 무염 기준으로 재구성한 자동 생성 기록입니다.'
  };
  fs.writeFileSync(path.join(MENU_DIR, `${outputStem}.sources.json`), safeJson(provenance), 'utf8');
  console.log(`새 식단을 작성했습니다: ${existing}`);
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT,
  `week_start=${weekStart}\nmenu_file=menus/weekly/${outputStem}.txt\nsend_key=week-${weekStart}${revision ? '-revised' : ''}\n`);
