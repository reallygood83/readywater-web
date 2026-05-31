import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

type MallSource = 'all' | 'teachermall' | 'iscream';
type SortOption = 'relevance' | 'price_low' | 'price_high' | 'popular' | 'newest';

interface SearchOptions {
  page?: number;
  limit?: number;
  sort?: SortOption;
  minPrice?: number;
  maxPrice?: number;
  source?: MallSource;
  maxExpandedQueries?: number;
}

interface Product {
  goods_seq: string;
  goods_name: string;
  price: number;
  consumer_price?: number;
  image_url: string;
  shop_url: string;
  mall: 'teachermall' | 'iscream';
  mall_name: string;
  provider_name?: string;
  purchase_count?: number;
  wish_count?: number;
  review_count?: number;
  average_rating?: number;
  discount_rate?: number;
  category_path?: string;
  sale_status?: string;
  badges?: string[];
  properties?: string;
  regist_date?: string;
}

interface BudgetLine extends Product {
  quantity: number;
  useCase: string;
  reason?: string;
  activities?: string[];
  risks?: string[];
  category?: string;
}

interface ParsedPrompt {
  grade?: string;
  purpose: string;
  maxBudget: number;
  source: MallSource;
  sort: SortOption;
  needs: string[];
  shouldBuildBudget: boolean;
  shouldCompare: boolean;
}

interface GeminiIntentResponse {
  grade?: string;
  purpose?: string;
  maxBudget?: number;
  source?: MallSource;
  sort?: SortOption;
  needs?: string[];
  shouldBuildBudget?: boolean;
  shouldCompare?: boolean;
}

interface RecommendationResponse {
  parser: 'gemini' | 'rules';
  summary: string;
  strategy: string;
  rationale: string[];
  activityIdeas: string[];
  purchaseNotes: string[];
  items: BudgetLine[];
  rejected: Array<{
    goods_seq: string;
    mall: Product['mall'];
    goods_name: string;
    reason: string;
  }>;
  coverage: string[];
  totalCost: number;
  remaining: number;
}

interface EstimateExportItem {
  goods_name: string;
  mall_name?: string;
  provider_name?: string;
  category?: string;
  quantity: number;
  price: number;
  shop_url?: string;
}

interface GeminiRecommendationResponse {
  summary?: string;
  strategy?: string;
  rationale?: string[];
  activityIdeas?: string[];
  purchaseNotes?: string[];
  selected?: Array<{
    mall?: Product['mall'];
    goods_seq?: string;
    quantity?: number;
    reason?: string;
    activities?: string[];
    risks?: string[];
    category?: string;
  }>;
  rejected?: Array<{
    mall?: Product['mall'];
    goods_seq?: string;
    reason?: string;
  }>;
  coverage?: string[];
}

function loadEnvFiles(): void {
  for (const fileName of ['.env.local', '.env']) {
    const filePath = resolve(process.cwd(), fileName);
    if (!existsSync(filePath)) continue;

    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadEnvFiles();

const app = express();
const PORT = Number(process.env.PORT || 5191);
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const appPassword = process.env.READYWATER_PASSWORD || '';
const sessionSecret = process.env.READYWATER_SESSION_SECRET || (process.env.VERCEL ? hashSeed(appPassword) : randomBytes(32).toString('hex'));
const serverDir = dirname(fileURLToPath(import.meta.url));
const estimateTemplatePath = process.env.ESTIMATE_TEMPLATE_PATH || resolve(serverDir, 'templates/edufine-estimate-template.xlsx');
const isHosted = Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production');
const mallFetchTimeoutMs = envNumber('MALL_FETCH_TIMEOUT_MS', isHosted ? 3000 : 9000);
const teachermallFetchTimeoutMs = envNumber('TEACHERMALL_FETCH_TIMEOUT_MS', mallFetchTimeoutMs);
const iscreamFetchTimeoutMs = envNumber('ISCREAM_FETCH_TIMEOUT_MS', isHosted ? 7500 : Math.max(mallFetchTimeoutMs, 12000));
const geminiIntentTimeoutMs = envNumber('GEMINI_INTENT_TIMEOUT_MS', isHosted ? 4500 : 12000);
const geminiRecommendTimeoutMs = envNumber('GEMINI_RECOMMEND_TIMEOUT_MS', isHosted ? 2500 : 15000);
const broadQueryLimit = envNumber('BROAD_QUERY_LIMIT', isHosted ? 3 : 10);
const intentNeedsLimit = envNumber('INTENT_NEEDS_LIMIT', isHosted ? 2 : 8);
const intentSearchLimit = envNumber('INTENT_SEARCH_LIMIT', isHosted ? 8 : 12);
const intentCandidateLimit = envNumber('INTENT_CANDIDATE_LIMIT', isHosted ? 18 : 24);
const intentExpandedQueryLimit = envNumber('INTENT_EXPANDED_QUERY_LIMIT', isHosted ? 2 : 10);

app.use(express.json({ limit: '1mb' }));

const teacherBaseUrl = 'https://shop.teacherville.co.kr';
const iscreamSiteUrl = 'https://i-screammall.co.kr';
const iscreamApiUrl = 'https://gw.i-screammall.co.kr';
const iscreamCdnUrl = 'https://cdn.i-screammall.co.kr';

const commonHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

const cache = new Map<string, { expires: number; data: unknown }>();
const sessionTtlMs = 1000 * 60 * 60 * 12;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashSeed(value: string): string {
  return hashText(value || 'readywater-session-fallback');
}

function safeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(cookieHeader = ''): Record<string, string> {
  return Object.fromEntries(cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const separator = part.indexOf('=');
      if (separator === -1) return [part, ''];
      return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
    }));
}

function sessionToken(): string {
  const expires = Date.now() + sessionTtlMs;
  const signature = hashText(`${expires}:${sessionSecret}:${appPassword}`);
  return `${expires}.${signature}`;
}

function isValidSession(cookieHeader?: string): boolean {
  if (!appPassword) return true;
  const token = parseCookies(cookieHeader).readywater_session;
  if (!token) return false;
  const [expiresRaw, signature] = token.split('.');
  const expires = Number(expiresRaw);
  if (!Number.isFinite(expires) || expires < Date.now() || !signature) return false;
  const expected = hashText(`${expires}:${sessionSecret}:${appPassword}`);
  return safeEqualText(signature, expected);
}

function sessionCookie(token: string): string {
  const parts = [
    `readywater_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
  ];
  if (isHosted) parts.push('Secure');
  return parts.join('; ');
}

function cacheGet<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.data as T;
}

function cacheSet(key: string, data: unknown, ttlMs = 20 * 60 * 1000): void {
  cache.set(key, { data, expires: Date.now() + ttlMs });
}

function parseNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const cleaned = value.replace(/[^0-9.]/g, '');
  return cleaned ? Number(cleaned) || 0 : 0;
}

function formatServerWon(value: number): string {
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

function normalizePurchaseCount(value: unknown): number | undefined {
  const parsed = parseNumber(value);
  if (!parsed) return undefined;
  if (parsed > 100_000) return 5000;
  return parsed;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[()[\]{}'"“”‘’]/g, ' ').replace(/\s+/g, ' ').trim();
}

function productText(item: Product): string {
  return normalize([
    item.goods_name,
    item.category_path || '',
    item.provider_name || '',
    item.properties || '',
    item.mall_name,
  ].join(' '));
}

function meaningfulTokens(query: string): string[] {
  const generic = new Set(['교구', '준비물', '수업', '학급', '초등', '유치원', '학교']);
  return normalize(query)
    .split(/\s+/)
    .filter(token => token.length > 1)
    .filter(token => !generic.has(token))
    .filter(token => !/^\d+학년$/.test(token));
}

function expandBroadQuery(query: string): string[] {
  const normalized = normalize(query);
  const sportsTerms = ['피구공', '원마커', '팀조끼', '라바콘', '플라잉디스크', '뉴스포츠'];
  const hasSportsIntent = /체육|운동|놀이체육|스포츠/.test(normalized);
  const hasSpecificSportsTerm = sportsTerms.some(term => normalized.includes(term));

  if (hasSportsIntent && !hasSpecificSportsTerm) return sportsTerms;
  return [query];
}

function isSportsQuery(query: string): boolean {
  return /체육|운동|놀이체육|스포츠|피구|원마커|팀조끼|라바콘|플라잉디스크|뉴스포츠/.test(normalize(query));
}

function isSportsProduct(item: Product): boolean {
  const text = productText(item);
  if (/구명조끼|수영조끼|부력|팝업북|스티커|도서|dvd|금연|흡연|만들기|공책|노트/.test(text)) return false;
  return /체육|운동|스포츠|피구|원마커|마킹콘|팀조끼|띠조끼|게임용 조끼|라바콘|삼각콘|고깔|플라잉디스크|디스크|뉴스포츠|구기|놀이체육|빈백|피클볼|스파이크볼|배드민턴|민턴|호루라기|줄넘기/.test(text);
}

function parseNaturalPrompt(prompt: string): ParsedPrompt {
  const normalized = normalize(prompt);
  const gradeMatch = prompt.match(/(?:초등학교|초등)?\s*([1-6])\s*학년/);
  const budgetMatch = prompt.match(/(\d+(?:\.\d+)?)\s*(만원|천원|원)/);
  const millionBudget = /100\s*만\s*원|백\s*만\s*원/.test(prompt);
  const source: MallSource = /아이스크림몰만|아이스크림만/.test(normalized)
    ? 'iscream'
    : /티처몰만|티쳐몰만|티처만/.test(normalized)
      ? 'teachermall'
      : 'all';
  const sort: SortOption = /저렴|싼|가격 낮|가성비/.test(normalized)
    ? 'price_low'
    : /인기|반응|리뷰|평점|추천/.test(normalized)
      ? 'popular'
      : 'relevance';
  let maxBudget = 1_000_000;

  if (budgetMatch) {
    const amount = Number(budgetMatch[1]);
    const unit = budgetMatch[2];
    if (unit === '만원') maxBudget = amount * 10_000;
    else if (unit === '천원') maxBudget = amount * 1_000;
    else maxBudget = amount;
  } else if (millionBudget) {
    maxBudget = 1_000_000;
  }

  const topicMap: Array<[RegExp, string, string[]]> = [
    [/체육|운동|스포츠|놀이체육/, '체육교육', ['피구공', '원마커', '팀조끼', '라바콘', '플라잉디스크', '뉴스포츠']],
    [/과학|실험/, '과학교육', ['실험 키트', '관찰', '자석', '전기 회로', '현미경']],
    [/미술|만들기|공예/, '미술교육', ['색종이', '클레이', '물감', '도화지', '공예 키트']],
    [/학급|보상|선물/, '학급운영', ['학급 보상', '칭찬 스티커', '간식', '선물', '쿠폰']],
    [/안전|생활안전|교통안전/, '안전교육', ['안전교육', '교통안전', '응급처치', '생활안전']],
  ];
  const matchedTopic = topicMap.find(([pattern]) => pattern.test(normalized));
  const explicitNeeds = ['피구공', '원마커', '팀조끼', '라바콘', '플라잉디스크', '빈백', '피클볼', '스파이크볼', '호루라기']
    .filter(need => normalized.includes(normalize(need)));
  const purpose = matchedTopic?.[1] || prompt.replace(/\d+(?:\.\d+)?\s*(만원|천원|원)/g, '').slice(0, 24).trim() || '수업 준비';
  const needs = explicitNeeds.length > 0 ? explicitNeeds : matchedTopic?.[2] || [purpose, `${purpose} 교구`, `${purpose} 준비물`];

  return {
    grade: gradeMatch ? `${gradeMatch[1]}학년` : undefined,
    purpose,
    maxBudget,
    source,
    sort,
    needs,
    shouldBuildBudget: /예산|구입|구매|리스트|리스트업|추천|구성/.test(normalized),
    shouldCompare: /비교|둘 다|통합|티처몰|티쳐몰|아이스크림/.test(normalized),
  };
}

function parseJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Gemini response did not contain a JSON object');
  }
  return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
}

function toMallSource(value: unknown, fallback: MallSource): MallSource {
  return value === 'teachermall' || value === 'iscream' || value === 'all' ? value : fallback;
}

function toSortOption(value: unknown, fallback: SortOption): SortOption {
  return value === 'relevance' || value === 'price_low' || value === 'price_high' || value === 'popular' || value === 'newest'
    ? value
    : fallback;
}

function sanitizeGeminiIntent(raw: unknown, fallback: ParsedPrompt): ParsedPrompt {
  const data = (raw && typeof raw === 'object' ? raw : {}) as GeminiIntentResponse;
  const maxBudget = Number(data.maxBudget);
  const needs = Array.isArray(data.needs)
    ? data.needs.map(item => String(item).trim()).filter(Boolean).slice(0, 10)
    : fallback.needs;

  return {
    grade: data.grade ? String(data.grade).trim() : fallback.grade,
    purpose: data.purpose ? String(data.purpose).trim().slice(0, 40) : fallback.purpose,
    maxBudget: Number.isFinite(maxBudget) && maxBudget >= 1000 ? maxBudget : fallback.maxBudget,
    source: toMallSource(data.source, fallback.source),
    sort: toSortOption(data.sort, fallback.sort),
    needs: needs.length > 0 ? needs : fallback.needs,
    shouldBuildBudget: typeof data.shouldBuildBudget === 'boolean' ? data.shouldBuildBudget : fallback.shouldBuildBudget,
    shouldCompare: typeof data.shouldCompare === 'boolean' ? data.shouldCompare : fallback.shouldCompare,
  };
}

function strengthenIntent(intent: ParsedPrompt, prompt: string): ParsedPrompt {
  const sportsDefaults = ['피구공', '원마커', '팀조끼', '라바콘', '플라잉디스크', '뉴스포츠', '호루라기'];
  const isSports = /체육|운동|스포츠|놀이체육/.test(normalize(`${prompt} ${intent.purpose} ${intent.needs.join(' ')}`));
  if (!isSports) return intent;

  return {
    ...intent,
    needs: [...new Set([...intent.needs, ...sportsDefaults])],
    shouldBuildBudget: intent.shouldBuildBudget || /예산|구입|구매|리스트|리스트업|추천|구성/.test(normalize(prompt)),
  };
}

function categoryForProduct(item: Product): string {
  const text = productText(item);
  if (/팀조끼|띠조끼|게임용 조끼/.test(text)) return '팀구분';
  if (/콘|마커|라바콘|삼각콘|고깔/.test(text)) return '공간표시';
  if (/호루라기|펌프|타이머|스코어|점수|안전/.test(text)) return '안전운영';
  if (/스파이크볼|피클볼|라켓|민턴|인디아카|플라잉디스크|디스크|뉴스포츠/.test(text)) return '뉴스포츠';
  if (/피구|축구|농구|배구|공\b|볼\b|빈백|콩주머니/.test(text)) return '구기던지기';
  return '기타';
}

function popularitySignal(item: Product): number {
  const purchase = Math.min(item.purchase_count || 0, 5000);
  const wish = Math.min(item.wish_count || 0, 500);
  const review = Math.min(item.review_count || 0, 300);
  const rating = item.average_rating ? Math.min(item.average_rating, 5) * 30 : 0;
  return purchase * 0.15 + wish * 1.2 + review * 8 + rating;
}

function valueScore(item: Product, query: string): number {
  const categoryBoost: Record<string, number> = {
    구기던지기: 35,
    공간표시: 34,
    팀구분: 32,
    뉴스포츠: 30,
    안전운영: 24,
    기타: 0,
  };
  return keywordScore(item, query) + popularitySignal(item) + (categoryBoost[categoryForProduct(item)] || 0);
}

async function parsePromptWithGemini(prompt: string, fallback: ParsedPrompt): Promise<ParsedPrompt | null> {
  if (!geminiApiKey) return null;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`;
  const body = {
    system_instruction: {
      parts: [{
        text: [
          '너는 한국 초등교사용 쇼핑 검색 의도 분석기다.',
          '반드시 실제 상품/가격/링크를 지어내지 말고, 검색 조건 JSON만 만든다.',
          'source는 all, teachermall, iscream 중 하나다.',
          'sort는 relevance, price_low, price_high, popular, newest 중 하나다.',
          'maxBudget은 원 단위 숫자다.',
          'needs는 쇼핑몰 검색에 직접 쓸 구체 키워드 배열이다.',
          '응답은 마크다운 없이 JSON 객체 하나만 반환한다.',
        ].join('\n'),
      }],
    },
    contents: [{
      role: 'user',
      parts: [{
        text: [
          `사용자 요청: ${prompt}`,
          '',
          'JSON schema:',
          '{',
          '  "grade": "6학년",',
          '  "purpose": "체육교육",',
          '  "maxBudget": 1000000,',
          '  "source": "all",',
          '  "sort": "popular",',
          '  "needs": ["피구공", "원마커"],',
          '  "shouldBuildBudget": true,',
          '  "shouldCompare": true',
          '}',
        ].join('\n'),
      }],
    }],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json',
    },
  };

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': geminiApiKey,
    },
    body: JSON.stringify(body),
  }, geminiIntentTimeoutMs);

  if (!response.ok) {
    throw new Error(`Gemini intent parsing failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as any;
  const text = json.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Gemini returned an empty intent response');
  return sanitizeGeminiIntent(parseJsonObject(text), fallback);
}

function keywordScore(item: Product, query: string): number {
  const name = normalize(item.goods_name);
  const haystack = productText(item);
  const queryNorm = normalize(query);
  const tokens = queryNorm.split(/\s+/).filter(token => token.length > 1);
  let score = 0;

  if (name.includes(queryNorm)) score += 220;
  for (const token of tokens) {
    if (name.includes(token)) score += 80;
    else if (haystack.includes(token)) score += 35;
  }

  score += Math.min(item.purchase_count || 0, 5000) * 0.08;
  score += Math.min(item.wish_count || 0, 500) * 0.35;
  score += Math.min(item.review_count || 0, 100) * 3;
  score += (item.average_rating || 0) * 10;
  if (item.category_path) score += 20;
  if (item.shop_url) score += 10;
  if (item.mall === 'teachermall' && /수업|학급|교구|준비물|선생님|티처몰only/i.test(item.goods_name)) score += 35;

  return score;
}

function sortProducts(items: Product[], sort: SortOption, query: string): Product[] {
  return [...items].sort((a, b) => {
    if (sort === 'price_low') return a.price - b.price;
    if (sort === 'price_high') return b.price - a.price;
    if (sort === 'popular') {
      return popularitySignal(b) - popularitySignal(a);
    }
    if (sort === 'newest') return new Date(b.regist_date || 0).getTime() - new Date(a.regist_date || 0).getTime();
    return keywordScore(b, query) - keywordScore(a, query);
  });
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = mallFetchTimeoutMs): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...init,
    headers: {
      ...commonHeaders,
      ...(init.headers || {}),
    },
  }, timeoutMs);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} ${url}`);
  return response.json() as Promise<T>;
}

async function fetchJsonWithRetry<T>(url: string, init: RequestInit = {}, options: { timeoutMs: number; attempts: number; label: string }): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await fetchJson<T>(url, init, options.timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < options.attempts) {
        await new Promise(resolve => setTimeout(resolve, 180 * attempt));
      }
    }
  }
  throw new Error(`${options.label} failed after ${options.attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) controller.abort();
    else upstreamSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function mapTeachermallItem(item: any): Product {
  const goodsSeq = String(item.goods_seq || item._id || '');
  const imagePath = item.fm_goods_image_image || item.goods_img || '';
  return {
    goods_seq: goodsSeq,
    goods_name: item.goods_name || '',
    price: parseNumber(item.default_price ?? item.price),
    consumer_price: parseNumber(item.default_consumer_price ?? item.consumer_price) || undefined,
    image_url: imagePath ? `${teacherBaseUrl}${String(imagePath).startsWith('/') ? '' : '/'}${imagePath}` : '',
    shop_url: `${teacherBaseUrl}/goods/view?no=${goodsSeq}`,
    mall: 'teachermall',
    mall_name: '티처몰',
    provider_name: item.provider_name,
    purchase_count: normalizePurchaseCount(item.purchase_ea_total || item.purchase_ea),
    badges: item.image_badge ? (Array.isArray(item.image_badge) ? item.image_badge : [item.image_badge]) : undefined,
    properties: item.properties,
    regist_date: item.regist_date,
  };
}

function mapIscreamItem(item: any): Product {
  const goodsNo = String(item.goodsNo || '');
  const category = Array.isArray(item.dispCtgNo) && item.dispCtgNo.length > 0
    ? item.dispCtgNo[0]?.ctgFullPathNm
    : undefined;
  const imagePath = item.goodsRepImgPathNm || '';

  return {
    goods_seq: goodsNo,
    goods_name: item.goodsNm || '',
    price: parseNumber(item.aplyPrc || item.salePrc),
    consumer_price: parseNumber(item.rcntSalePrc) || undefined,
    image_url: imagePath.startsWith('http') ? imagePath : `${iscreamCdnUrl}/${imagePath.replace(/^\/+/, '')}`,
    shop_url: `${iscreamSiteUrl}/goods/detail/${goodsNo}`,
    mall: 'iscream',
    mall_name: '아이스크림몰',
    provider_name: item.mshopNm || item.brandNm,
    wish_count: parseNumber(item.wishListCnt) || undefined,
    review_count: parseNumber(item.goodsRevCnt) || undefined,
    average_rating: parseNumber(item.goodsRevStarscrAvgVal) || undefined,
    discount_rate: parseNumber(item.dcRate) || undefined,
    category_path: category,
    sale_status: item.saleStatCd,
    regist_date: item.goodsRegDtm || undefined,
    badges: [
      ...(item.brandNm ? [String(item.brandNm)] : []),
      ...((item.btmDispIconList || []).map((icon: any) => icon.iconNm).filter(Boolean)),
    ],
  };
}

async function searchTeachermall(query: string, options: SearchOptions): Promise<Product[]> {
  const { page = 1, limit = 12, sort = 'relevance', minPrice, maxPrice } = options;
  const cacheKey = `teachermall:${JSON.stringify({ query, page, limit, sort, minPrice, maxPrice })}`;
  const cached = cacheGet<Product[]>(cacheKey);
  if (cached) return cached;

  let sortField = '_score';
  let sortOrder = 'desc';
  if (sort === 'price_low') {
    sortField = 'default_price';
    sortOrder = 'asc';
  } else if (sort === 'price_high') {
    sortField = 'default_price';
  } else if (sort === 'popular') {
    sortField = 'purchase_ea_total';
  } else if (sort === 'newest') {
    sortField = 'regist_date';
  }

  const params = new URLSearchParams({
    page: String(page),
    goods_type: 'goods',
    'sorts[field]': sortField,
    'sorts[order]': sortOrder,
    'prices[start]': minPrice ? String(minPrice) : '0',
    'prices[end]': maxPrice ? String(maxPrice) : '0',
    search: query,
    filter_price_range: 'all',
  });

  const raw = await fetchJson<any>(`${teacherBaseUrl}/goods/api_retrieval?${params.toString()}`, {
    headers: { Referer: `${teacherBaseUrl}/` },
  }, teachermallFetchTimeoutMs);
  const items = raw?.success && raw.data?.items ? raw.data.items.map(mapTeachermallItem).slice(0, limit) : [];
  cacheSet(cacheKey, items);
  return items;
}

async function searchIscream(query: string, options: SearchOptions): Promise<Product[]> {
  const { page = 1, limit = 12, sort = 'relevance', minPrice, maxPrice } = options;
  const cacheKey = `iscream:${JSON.stringify({ query, page, limit, sort, minPrice, maxPrice })}`;
  const cached = cacheGet<Product[]>(cacheKey);
  if (cached) return cached;

  const body = {
    siteNo: 312,
    langCd: 'ko',
    size: Math.min(50, Math.max(limit * 3, limit)),
    from: page,
    searchWord: query,
    ctgNoList: [],
    filters: '',
    sortField: '',
    sort: '',
    researchWords: [],
    excludedSearchWords: [],
    excludedFilters: '',
    entrNo: '',
    icePbYn: '',
    researchWord: '',
    isbnYn: '',
    kcCertOnly: '',
  };

  const raw = await fetchJsonWithRetry<any>(`${iscreamApiUrl}/api/goods/v1/search/product`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'site_no=312; lang_cd=ko; mall_no=1;',
      Origin: iscreamSiteUrl,
      Referer: `${iscreamSiteUrl}/`,
    },
    body: JSON.stringify(body),
  }, {
    timeoutMs: iscreamFetchTimeoutMs,
    attempts: isHosted ? 2 : 1,
    label: `iscream search "${query}"`,
  });

  const items = (raw.payload?.searchDataList || [])
    .map(mapIscreamItem)
    .filter((item: Product) => {
      if (!item.goods_seq || !item.goods_name) return false;
      if (minPrice && item.price < minPrice) return false;
      if (maxPrice && item.price > maxPrice) return false;
      return true;
    })
    .slice(0, limit);

  cacheSet(cacheKey, sortProducts(items, sort, query));
  return sortProducts(items, sort, query);
}

async function searchProducts(query: string, options: SearchOptions): Promise<Product[]> {
  const { source = 'all', limit = 12, sort = 'relevance' } = options;
  const fetchLimit = Math.min(30, Math.max(limit * 2, limit));
  const queries = expandBroadQuery(query).slice(0, options.maxExpandedQueries || broadQueryLimit);
  const jobs: Promise<Product[]>[] = [];

  for (const searchQuery of queries) {
    if (source === 'all' || source === 'teachermall') {
      jobs.push(searchTeachermall(searchQuery, { ...options, limit: fetchLimit }).catch(error => {
        console.warn(`[Teachermall] search failed for "${searchQuery}":`, error instanceof Error ? error.message : String(error));
        return [];
      }));
    }
    if (source === 'all' || source === 'iscream') {
      jobs.push(searchIscream(searchQuery, { ...options, limit: fetchLimit }).catch(error => {
        console.warn(`[i-Scream Mall] search failed for "${searchQuery}":`, error instanceof Error ? error.message : String(error));
        return [];
      }));
    }
  }

  const merged = (await Promise.all(jobs)).flat();
  const scoped = isSportsQuery(query) ? merged.filter(isSportsProduct) : merged;
  const deduped = Array.from(new Map(scoped.map(item => [`${item.mall}:${item.goods_seq}`, item])).values());
  const sorted = sortProducts(deduped, sort, query);
  return source === 'all' ? balancedMallResults(sorted, limit) : sorted.slice(0, limit);
}

function balancedMallResults(items: Product[], limit: number): Product[] {
  const teachermall = items.filter(item => item.mall === 'teachermall');
  const iscream = items.filter(item => item.mall === 'iscream');
  if (teachermall.length === 0 || iscream.length === 0) return items.slice(0, limit);

  const result: Product[] = [];
  const seen = new Set<string>();
  const push = (item: Product | undefined) => {
    if (!item) return;
    const key = candidateKey(item);
    if (seen.has(key) || result.length >= limit) return;
    seen.add(key);
    result.push(item);
  };
  const rounds = Math.max(teachermall.length, iscream.length);
  for (let index = 0; index < rounds && result.length < limit; index += 1) {
    push(teachermall[index]);
    push(iscream[index]);
  }
  for (const item of items) push(item);
  return result;
}

function useCaseForProduct(item: Product, purpose: string): string {
  const text = productText(item);
  if (/피구|공\b|스펀지공|솜털공|빈백/.test(text)) return `${purpose}에서 던지기, 받기, 목표물 맞히기, 팀 대항 활동에 사용`;
  if (/콘|마커|라바콘|삼각콘/.test(text)) return `${purpose} 활동장 구획, 코스 설계, 순환 스테이션 표시`;
  if (/조끼|팀/.test(text)) return `${purpose} 팀 구분, 역할 배정, 경기 운영`;
  if (/라켓|민턴|피클볼|스파이크볼|디스크/.test(text)) return `${purpose} 네트형/필드형 게임과 협동 도전 과제`;
  if (/호루라기|전자/.test(text)) return `${purpose} 안전 신호, 시작/정지 신호, 이동 통제`;
  return `${purpose} 수업의 준비 운동, 기능 연습, 협동 게임에 활용`;
}

async function buildBudgetKit(params: {
  purpose: string;
  grade?: string;
  maxBudget: number;
  itemCount: number;
  source: MallSource;
  needs?: string[];
}): Promise<{ items: BudgetLine[]; totalCost: number; remaining: number; allCandidates: Product[]; needs: string[] }> {
  const baseNeeds = params.needs?.length
    ? params.needs
    : [
      [params.grade, params.purpose].filter(Boolean).join(' '),
      `${params.purpose} 교구`,
      `${params.purpose} 준비물`,
      '피구공 원마커 팀조끼 라바콘 플라잉디스크',
    ];
  const candidates = (await Promise.all(
    baseNeeds.map(need => searchProducts(need, {
      source: params.source,
      limit: 12,
      sort: 'relevance',
      maxPrice: params.maxBudget,
    })),
  )).flat();

  const tokens = meaningfulTokens(baseNeeds.join(' '));
  const unique = Array.from(new Map(candidates.map(item => [`${item.mall}:${item.goods_seq}`, item])).values())
    .filter(item => {
      if (item.price <= 0) return false;
      const haystack = productText(item);
      return tokens.length === 0 || tokens.some(token => haystack.includes(token));
    })
    .sort((a, b) => {
      const aValue = valueScore(a, baseNeeds.join(' ')) / Math.max(a.price, 500);
      const bValue = valueScore(b, baseNeeds.join(' ')) / Math.max(b.price, 500);
      return bValue - aValue;
    });

  const lines: BudgetLine[] = [];
  let totalCost = 0;
  const categoryTargets = ['구기던지기', '공간표시', '팀구분', '뉴스포츠', '안전운영'];
  const orderedCandidates = [
    ...categoryTargets.flatMap(category => unique.filter(item => categoryForProduct(item) === category).slice(0, 2)),
    ...unique,
  ];

  for (const item of orderedCandidates) {
    if (lines.length >= params.itemCount) break;
    if (lines.some(line => line.mall === item.mall && line.goods_seq === item.goods_seq)) continue;
    const remaining = params.maxBudget - totalCost;
    if (item.price > remaining) continue;
    const category = categoryForProduct(item);
    const targetQuantity = category === '팀구분'
      ? Math.min(30, Math.max(10, Math.floor(params.maxBudget / Math.max(item.price, 1) / 20)))
      : category === '공간표시'
        ? Math.min(24, item.price < 3000 ? 20 : 4)
        : category === '구기던지기'
          ? item.price < 4000 ? 12 : item.price < 20000 ? 6 : 3
          : category === '뉴스포츠'
            ? item.price < 12000 ? 8 : item.price < 40000 ? 4 : 1
            : item.price < 5000 ? 3 : 1;
    const quantity = Math.max(1, Math.min(targetQuantity, Math.floor(remaining / item.price)));
    const lineCost = item.price * quantity;
    if (lineCost <= remaining) {
      lines.push({ ...item, quantity, category, useCase: useCaseForProduct(item, params.purpose) });
      totalCost += lineCost;
    }
  }

  const fillCandidates = [...lines].sort((a, b) => b.price - a.price);
  let fillIndex = 0;
  while (fillCandidates.length > 0 && totalCost < params.maxBudget * 0.93 && fillIndex < 500) {
    const line = fillCandidates[fillIndex % fillCandidates.length];
    const liveLine = lines.find(item => item.mall === line.mall && item.goods_seq === line.goods_seq);
    if (liveLine && liveLine.quantity < 40 && totalCost + liveLine.price <= params.maxBudget) {
      liveLine.quantity += 1;
      totalCost += liveLine.price;
    }
    fillIndex += 1;
    if (fillCandidates.every(item => {
      const current = lines.find(lineItem => lineItem.mall === item.mall && lineItem.goods_seq === item.goods_seq);
      return !current || current.quantity >= 40 || totalCost + current.price > params.maxBudget;
    })) break;
  }

  return {
    items: lines,
    totalCost,
    remaining: params.maxBudget - totalCost,
    allCandidates: unique.slice(0, 30),
    needs: baseNeeds,
  };
}

function candidateKey(item: Pick<Product, 'mall' | 'goods_seq'>): string {
  return `${item.mall}:${item.goods_seq}`;
}

function sanitizeRecommendation(raw: unknown, candidates: Product[], prompt: string, intent: ParsedPrompt): RecommendationResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as GeminiRecommendationResponse;
  const candidateMap = new Map(candidates.map(item => [candidateKey(item), item]));
  const selected: BudgetLine[] = [];
  let totalCost = 0;

  for (const choice of data.selected || []) {
    const mall = choice.mall === 'teachermall' || choice.mall === 'iscream' ? choice.mall : undefined;
    const key = mall && choice.goods_seq ? `${mall}:${choice.goods_seq}` : '';
    const item = candidateMap.get(key);
    if (!item || selected.some(line => candidateKey(line) === key)) continue;
    const quantity = Math.max(1, Math.min(40, Math.floor(Number(choice.quantity) || 1)));
    const affordableQuantity = Math.min(quantity, Math.floor((intent.maxBudget - totalCost) / item.price));
    if (affordableQuantity <= 0) continue;
    totalCost += item.price * affordableQuantity;
    selected.push({
      ...item,
      quantity: affordableQuantity,
      category: choice.category || categoryForProduct(item),
      reason: String(choice.reason || '').trim() || '수업 목적과 예산 조건에 맞는 후보입니다.',
      activities: Array.isArray(choice.activities) ? choice.activities.map(String).filter(Boolean).slice(0, 4) : [],
      risks: Array.isArray(choice.risks) ? choice.risks.map(String).filter(Boolean).slice(0, 3) : [],
      useCase: Array.isArray(choice.activities) && choice.activities.length
        ? choice.activities.map(String).slice(0, 2).join(', ')
        : useCaseForProduct(item, intent.purpose),
    });
  }

  if (selected.length === 0) return null;

  const rejected = (data.rejected || []).flatMap(reject => {
    const mall = reject.mall === 'teachermall' || reject.mall === 'iscream' ? reject.mall : undefined;
    const item = mall && reject.goods_seq ? candidateMap.get(`${mall}:${reject.goods_seq}`) : undefined;
    if (!item) return [];
    return [{
      mall: item.mall,
      goods_seq: item.goods_seq,
      goods_name: item.goods_name,
      reason: String(reject.reason || '수업 목적 또는 예산 우선순위에서 밀렸습니다.').trim(),
    }];
  }).slice(0, 8);

  return enrichRecommendation({
    parser: 'gemini',
    summary: String(data.summary || `${intent.grade || ''} ${intent.purpose} 수업을 위한 구매안을 구성했습니다.`).trim(),
    strategy: String(data.strategy || '실제 검색 후보 안에서 수업 활용도, 반응 신호, 예산 균형을 함께 보았습니다.').trim(),
    rationale: Array.isArray(data.rationale) ? data.rationale.map(String).filter(Boolean).slice(0, 5) : [],
    activityIdeas: Array.isArray(data.activityIdeas) ? data.activityIdeas.map(String).filter(Boolean).slice(0, 5) : [],
    purchaseNotes: Array.isArray(data.purchaseNotes) ? data.purchaseNotes.map(String).filter(Boolean).slice(0, 5) : [],
    items: selected,
    rejected,
    coverage: Array.isArray(data.coverage) ? data.coverage.map(String).filter(Boolean).slice(0, 8) : [],
    totalCost,
    remaining: intent.maxBudget - totalCost,
  }, intent);
}

function maxUsefulQuantity(item: BudgetLine): number {
  const category = item.category || categoryForProduct(item);
  if (category === '팀구분') return 30;
  if (category === '공간표시') return item.price < 3000 ? 36 : 8;
  if (category === '구기던지기') return item.price < 5000 ? 20 : item.price < 15000 ? 10 : 6;
  if (category === '뉴스포츠') return item.price < 12000 ? 12 : item.price < 40000 ? 6 : 2;
  if (category === '안전운영') return 4;
  return 3;
}

function recalculateRecommendation(rec: RecommendationResponse, budget: number): RecommendationResponse {
  const totalCost = rec.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return { ...rec, totalCost, remaining: budget - totalCost };
}

function fillRecommendationBudget(rec: RecommendationResponse, candidates: Product[], intent: ParsedPrompt): RecommendationResponse {
  const selectedKeys = new Set(rec.items.map(candidateKey));
  const wantedCategories = ['공간표시', '팀구분', '구기던지기', '뉴스포츠', '안전운영'];
  let next = recalculateRecommendation(rec, intent.maxBudget);

  for (const category of wantedCategories) {
    if (next.totalCost >= intent.maxBudget * 0.92) break;
    if (next.items.some(item => (item.category || categoryForProduct(item)) === category)) continue;
    const candidate = candidates
      .filter(item => !selectedKeys.has(candidateKey(item)))
      .filter(item => categoryForProduct(item) === category)
      .sort((a, b) => valueScore(b, intent.needs.join(' ')) - valueScore(a, intent.needs.join(' ')))
      .find(item => item.price <= next.remaining);
    if (!candidate) continue;
    const quantity = Math.max(1, Math.min(
      maxUsefulQuantity({ ...candidate, quantity: 1, useCase: '', category }),
      Math.floor(next.remaining / candidate.price),
    ));
    if (quantity <= 0) continue;
    selectedKeys.add(candidateKey(candidate));
    next = recalculateRecommendation({
      ...next,
      items: [
        ...next.items,
        {
          ...candidate,
          quantity,
          category,
          reason: `${category} 영역 보강을 위해 실제 검색 후보에서 추가했습니다.`,
          activities: [useCaseForProduct(candidate, intent.purpose)],
          risks: [],
          useCase: useCaseForProduct(candidate, intent.purpose),
        },
      ],
      coverage: [...new Set([...next.coverage, category])],
    }, intent.maxBudget);
  }

  let guard = 0;
  while (guard < 200 && next.totalCost < intent.maxBudget * 0.94) {
    const target = [...next.items]
      .filter(item => item.quantity < maxUsefulQuantity(item))
      .filter(item => item.price <= next.remaining)
      .sort((a, b) => b.price - a.price)[0];
    if (!target) break;
    next = recalculateRecommendation({
      ...next,
      items: next.items.map(item => candidateKey(item) === candidateKey(target)
        ? { ...item, quantity: item.quantity + 1 }
        : item),
    }, intent.maxBudget);
    guard += 1;
  }

  const hasAmountInSummary = /총\s*예산|총액|잔액|[\d,]+\s*원/.test(next.summary);
  const coverage = next.coverage.length ? next.coverage.join(', ') : [...new Set(next.items.map(item => item.category || categoryForProduct(item)))].join(', ');
  return enrichRecommendation({
    ...next,
    summary: next.parser === 'rules'
      ? ruleSummary(next.items, intent, next.totalCost)
      : hasAmountInSummary
      ? next.summary
      : `${intent.grade || ''} ${intent.purpose} 수업을 위해 ${coverage} 영역을 중심으로 실제 구매 가능한 상품만 선별했습니다.`.trim(),
    strategy: `${next.strategy} 서버가 최종 단계에서 상품 ID, 가격, 구매 링크, 예산 초과 여부를 다시 검증했습니다.`,
  }, intent);
}

function fallbackRecommendation(candidates: Product[], intent: ParsedPrompt): RecommendationResponse {
  const grouped = new Map<string, Product[]>();
  for (const item of candidates) {
    const category = categoryForProduct(item);
    grouped.set(category, [...(grouped.get(category) || []), item]);
  }

  const ordered = ['구기던지기', '공간표시', '팀구분', '뉴스포츠', '안전운영', '기타']
    .flatMap(category => (grouped.get(category) || []).slice(0, category === '기타' ? 2 : 3));
  const selected: BudgetLine[] = [];
  let totalCost = 0;

  for (const item of ordered) {
    if (selected.length >= 10 || selected.some(line => candidateKey(line) === candidateKey(item))) continue;
    const category = categoryForProduct(item);
    const targetQuantity = category === '팀구분'
      ? 20
      : category === '공간표시'
        ? item.price < 3000 ? 20 : 4
        : category === '구기던지기'
          ? item.price < 12000 ? 8 : 4
          : category === '뉴스포츠'
            ? item.price < 15000 ? 6 : 2
            : 1;
    const quantity = Math.min(targetQuantity, Math.floor((intent.maxBudget - totalCost) / item.price));
    if (quantity <= 0) continue;
    totalCost += item.price * quantity;
    selected.push({
      ...item,
      quantity,
      category,
      reason: `${category} 영역을 채우기 위해 선택했습니다.`,
      activities: [useCaseForProduct(item, intent.purpose)],
      risks: [],
      useCase: useCaseForProduct(item, intent.purpose),
    });
  }

  return enrichRecommendation({
    parser: 'rules',
    summary: ruleSummary(selected, intent, totalCost),
    strategy: ruleStrategy(selected, intent),
    rationale: [],
    activityIdeas: [],
    purchaseNotes: [],
    items: selected,
    rejected: candidates
      .filter(item => !selected.some(line => candidateKey(line) === candidateKey(item)))
      .slice(0, 5)
      .map(item => ({ mall: item.mall, goods_seq: item.goods_seq, goods_name: item.goods_name, reason: '카테고리 중복 또는 예산 우선순위에서 제외' })),
    coverage: [...new Set(selected.map(item => item.category || categoryForProduct(item)))],
    totalCost,
    remaining: intent.maxBudget - totalCost,
  }, intent);
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    구기던지기: '공 조작/던지기',
    공간표시: '공간 표시/코스 구성',
    팀구분: '팀 구분/협동 활동',
    뉴스포츠: '뉴스포츠/전략 게임',
    안전운영: '안전 운영/수업 관리',
    기타: '보조 준비물',
  };
  return labels[category] || category;
}

function categoryPurpose(category: string): string {
  const purposes: Record<string, string> = {
    구기던지기: '던지기, 받기, 피하기, 목표물 맞히기처럼 신체 조절과 게임 이해를 함께 다룰 수 있습니다.',
    공간표시: '모둠별 활동 구역, 이동 동선, 출발선과 안전선을 빠르게 만들 수 있습니다.',
    팀구분: '팀 편성과 역할 교대가 명확해져 대기 시간을 줄이고 협동 활동을 운영하기 쉽습니다.',
    뉴스포츠: '기존 구기 종목보다 진입 장벽이 낮아 전략 수립, 의사소통, 페어플레이 지도가 쉽습니다.',
    안전운영: '점수, 시간, 호루라기, 안전 신호 등 수업 운영 품질을 안정적으로 받쳐줍니다.',
    기타: '주 활동을 보완하는 준비물로 반복 수업에서 활용 범위를 넓힐 수 있습니다.',
  };
  return purposes[category] || '수업 목표와 활동 흐름에 맞춰 보조 교구로 활용할 수 있습니다.';
}

function ruleSummary(items: BudgetLine[], intent: ParsedPrompt, totalCost: number): string {
  const coverage = [...new Set(items.map(item => categoryLabel(item.category || categoryForProduct(item))))];
  const mallCount = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.mall_name] = (acc[item.mall_name] || 0) + 1;
    return acc;
  }, {});
  const mallText = Object.entries(mallCount).map(([mall, count]) => `${mall} ${count}종`).join(', ');
  return `${intent.grade || ''} ${intent.purpose} 수업을 위해 ${coverage.join(', ')} 영역을 포함해 ${formatServerWon(totalCost)} 규모의 구매안을 구성했습니다. ${mallText ? `${mallText}을 함께 반영해 가격과 구매처를 비교할 수 있습니다.` : ''}`.trim();
}

function ruleStrategy(items: BudgetLine[], intent: ParsedPrompt): string {
  const categories = [...new Set(items.map(item => item.category || categoryForProduct(item)))];
  const categoryText = categories.map(category => `${categoryLabel(category)}는 ${categoryPurpose(category)}`).join(' ');
  return `규칙 기반 큐레이션은 검색 후보를 수업 기능별로 분류한 뒤, ${formatServerWon(intent.maxBudget)} 예산 안에서 중복 품목을 줄이고 반복 사용성이 높은 교구를 우선했습니다. ${categoryText}`;
}

function enrichRecommendation(rec: RecommendationResponse, intent: ParsedPrompt): RecommendationResponse {
  const categories = [...new Set(rec.items.map(item => item.category || categoryForProduct(item)))];
  const totalQuantity = rec.items.reduce((sum, item) => sum + item.quantity, 0);
  const mallSummary = rec.items.reduce<Record<string, number>>((acc, item) => {
    acc[item.mall_name] = (acc[item.mall_name] || 0) + 1;
    return acc;
  }, {});
  const mallText = Object.entries(mallSummary).map(([mall, count]) => `${mall} ${count}종`).join(', ');
  const budgetRate = intent.maxBudget > 0 ? Math.round((rec.totalCost / intent.maxBudget) * 100) : 0;

  const derivedRationale = [
    `${categories.map(categoryLabel).join(', ')} 영역을 포함해 한 차시 활동과 단원 반복 활동을 모두 고려했습니다.`,
    `${totalQuantity}개 단위로 구성되어 모둠 순환, 팀 경기, 전체 활동을 섞어 운영하기 좋습니다.`,
    mallText ? `${mallText}을 함께 담아 특정 쇼핑몰에만 편중되지 않도록 했습니다.` : '',
    `총액은 예산의 약 ${budgetRate}%이며, 남은 예산은 소모품 추가나 배송비 여유분으로 둘 수 있습니다.`,
  ].filter(Boolean);

  const derivedActivityIdeas = categories.slice(0, 5).map(category => {
    const sample = rec.items.find(item => (item.category || categoryForProduct(item)) === category);
    return `${categoryLabel(category)}: ${sample?.goods_name || '선정 교구'}를 활용해 ${categoryPurpose(category)}`;
  });

  const derivedPurchaseNotes = [
    '구매 전 상품 상세 페이지에서 현재 판매 상태, 배송비, 학교장터 또는 카드 결제 가능 여부를 확인하세요.',
    '학급 수, 모둠 수, 동시 활동 인원에 맞춰 수량을 조정하면 예산 낭비를 줄일 수 있습니다.',
    '공이나 원마커처럼 반복 사용 교구는 보관함, 이름표, 분실 관리 방식을 함께 정해두는 것이 좋습니다.',
  ];

  return {
    ...rec,
    rationale: uniqueTextList(rec.parser === 'rules' ? derivedRationale : [...derivedRationale, ...rec.rationale]).slice(0, 5),
    activityIdeas: uniqueTextList(rec.parser === 'rules' ? derivedActivityIdeas : [...derivedActivityIdeas, ...rec.activityIdeas]).slice(0, 5),
    purchaseNotes: uniqueTextList(rec.parser === 'rules' ? derivedPurchaseNotes : [...derivedPurchaseNotes, ...rec.purchaseNotes]).slice(0, 5),
    coverage: rec.coverage.length ? rec.coverage : categories,
  };
}

function uniqueTextList(items: string[]): string[] {
  const seen = new Set<string>();
  return items.flatMap(item => {
    const normalized = normalize(item);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [item];
  });
}

async function recommendWithGemini(prompt: string, intent: ParsedPrompt, candidates: Product[]): Promise<RecommendationResponse> {
  const cleanCandidates = candidates
    .filter(item => item.price > 0 && item.shop_url)
    .slice(0, 36);

  if (!geminiApiKey || cleanCandidates.length === 0) {
    return fillRecommendationBudget(fallbackRecommendation(cleanCandidates, intent), cleanCandidates, intent);
  }

  const candidatePayload = cleanCandidates.map(item => ({
    mall: item.mall,
    goods_seq: item.goods_seq,
    name: item.goods_name,
    price: item.price,
    mall_name: item.mall_name,
    category: categoryForProduct(item),
    provider: item.provider_name,
    purchase_count: Math.min(item.purchase_count || 0, 5000),
    wish_count: item.wish_count || 0,
    review_count: item.review_count || 0,
    rating: item.average_rating || 0,
    link: item.shop_url,
  }));

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`;
    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: [
              '너는 한국 초등교사를 돕는 교구 구매 큐레이터다.',
              '반드시 제공된 candidates 안에서만 추천한다. 상품명, 가격, 링크, goods_seq를 지어내지 않는다.',
              '예산을 넘기지 말고, 수업 활용 다양성을 위해 카테고리 균형을 맞춘다.',
              '부적합하거나 중복된 후보는 rejected에 이유를 적는다.',
              '응답은 JSON 객체 하나만 반환한다.',
            ].join('\n'),
          }],
        },
        contents: [{
          role: 'user',
          parts: [{
            text: [
              `사용자 요청: ${prompt}`,
              `해석된 조건: ${JSON.stringify(intent)}`,
              `후보 상품: ${JSON.stringify(candidatePayload)}`,
              '',
              'JSON schema:',
              '{',
              '  "summary": "교사용 구매안 한 문단",',
              '  "strategy": "왜 이 조합인지",',
              '  "rationale": ["선정 근거 1", "선정 근거 2"],',
              '  "activityIdeas": ["수업 활용 아이디어 1", "수업 활용 아이디어 2"],',
              '  "purchaseNotes": ["구매 전 확인 사항 1", "구매 전 확인 사항 2"],',
              '  "coverage": ["구기던지기", "공간표시"],',
              '  "selected": [',
              '    { "mall": "teachermall", "goods_seq": "123", "quantity": 4, "category": "구기던지기", "reason": "선정 이유", "activities": ["활동1"], "risks": ["확인사항"] }',
              '  ],',
              '  "rejected": [',
              '    { "mall": "iscream", "goods_seq": "456", "reason": "제외 이유" }',
              '  ]',
              '}',
            ].join('\n'),
          }],
        }],
        generationConfig: {
          temperature: 0.25,
          response_mime_type: 'application/json',
        },
      }),
    }, geminiRecommendTimeoutMs);

    if (!response.ok) throw new Error(`Gemini recommendation failed: ${response.status} ${response.statusText}`);
    const json = await response.json() as any;
    const text = json.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || '').join('').trim();
    if (!text) throw new Error('Gemini returned an empty recommendation response');
    const recommendation = sanitizeRecommendation(parseJsonObject(text), cleanCandidates, prompt, intent)
      || fallbackRecommendation(cleanCandidates, intent);
    return fillRecommendationBudget(recommendation, cleanCandidates, intent);
  } catch (error) {
    console.warn('[Gemini] Falling back to deterministic recommendation:', error instanceof Error ? error.message : String(error));
    return fillRecommendationBudget(fallbackRecommendation(cleanCandidates, intent), cleanCandidates, intent);
  }
}

function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'readywater-web',
    llm: geminiApiKey ? { provider: 'gemini', model: geminiModel } : { provider: 'rules' },
    auth: { enabled: Boolean(appPassword) },
    time: new Date().toISOString(),
  });
});

app.get('/api/auth/status', (req, res) => {
  res.json({
    enabled: Boolean(appPassword),
    authenticated: isValidSession(req.headers.cookie),
  });
});

app.post('/api/auth/login', (req, res) => {
  if (!appPassword) {
    res.json({ authenticated: true, enabled: false });
    return;
  }
  const password = String(req.body.password || '');
  if (!safeEqualText(hashText(password), hashText(appPassword))) {
    res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    return;
  }
  res.setHeader('Set-Cookie', sessionCookie(sessionToken()));
  res.json({ authenticated: true, enabled: true });
});

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'readywater_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ authenticated: false });
});

app.use('/api', (req, res, next) => {
  if (isValidSession(req.headers.cookie)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Readywater 비밀번호 인증이 필요합니다.' });
});

app.get('/api/search', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });
    const items = await searchProducts(query, {
      source: (req.query.source as MallSource) || 'all',
      sort: (req.query.sort as SortOption) || 'relevance',
      limit: numberParam(req.query.limit, 16),
      page: numberParam(req.query.page, 1),
      minPrice: req.query.minPrice ? numberParam(req.query.minPrice, 0) : undefined,
      maxPrice: req.query.maxPrice ? numberParam(req.query.maxPrice, 0) : undefined,
    });
    res.json({ query, items });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/compare', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    if (!query) return res.status(400).json({ error: 'query is required' });
    const limit = numberParam(req.query.limit, 6);
    const sort = (req.query.sort as SortOption) || 'relevance';
    const [teachermall, iscream] = await Promise.all([
      searchProducts(query, { source: 'teachermall', limit, sort }),
      searchProducts(query, { source: 'iscream', limit, sort }),
    ]);
    res.json({ query, teachermall, iscream, combined: sortProducts([...teachermall, ...iscream], sort, query) });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/intent', async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const fallbackIntent = strengthenIntent(parseNaturalPrompt(prompt), prompt);
    let parser: 'gemini' | 'rules' = 'rules';
    let intent = fallbackIntent;

    try {
      const geminiIntent = await parsePromptWithGemini(prompt, fallbackIntent);
      if (geminiIntent) {
        intent = strengthenIntent(geminiIntent, prompt);
        parser = 'gemini';
      }
    } catch (error) {
      console.warn('[Gemini] Falling back to rule parser:', error instanceof Error ? error.message : String(error));
    }

    const query = [intent.grade, intent.purpose, '교구'].filter(Boolean).join(' ');
    const searchNeeds = Array.from(new Set([query, ...intent.needs])).slice(0, intentNeedsLimit);
    const candidates = (await Promise.all(
      searchNeeds.map(need => searchProducts(need, {
        source: intent.source,
        sort: intent.sort,
        limit: intentSearchLimit,
        maxPrice: intent.maxBudget,
        maxExpandedQueries: intentExpandedQueryLimit,
      })),
    )).flat();
    const items = Array.from(new Map(candidates.map(item => [candidateKey(item), item])).values()).slice(0, intentCandidateLimit);
    const recommendation = intent.shouldBuildBudget
      ? await recommendWithGemini(prompt, intent, items)
      : null;
    const budgetKit = recommendation
      ? {
        items: recommendation.items,
        totalCost: recommendation.totalCost,
        remaining: recommendation.remaining,
        allCandidates: items,
        needs: searchNeeds,
      }
      : null;

    res.json({
      prompt,
      parser,
      intent,
      query,
      searchNeeds,
      items,
      budgetKit,
      recommendation,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/recommend', async (req, res) => {
  try {
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    const fallbackIntent = strengthenIntent(parseNaturalPrompt(prompt), prompt);
    const intent = strengthenIntent(await parsePromptWithGemini(prompt, fallbackIntent).catch(() => null) || fallbackIntent, prompt);
    const query = [intent.grade, intent.purpose, '교구'].filter(Boolean).join(' ');
    const searchNeeds = Array.from(new Set([query, ...intent.needs])).slice(0, intentNeedsLimit);
    const candidates = (await Promise.all(
      searchNeeds.map(need => searchProducts(need, {
        source: intent.source,
        sort: intent.sort,
        limit: intentSearchLimit,
        maxPrice: intent.maxBudget,
        maxExpandedQueries: intentExpandedQueryLimit,
      })),
    )).flat();
    const uniqueCandidates = Array.from(new Map(candidates.map(item => [candidateKey(item), item])).values());
    const recommendation = await recommendWithGemini(prompt, intent, uniqueCandidates);
    res.json({ prompt, intent, query, searchNeeds, candidates: uniqueCandidates.slice(0, 30), recommendation });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/api/budget-kit', async (req, res) => {
  try {
    const purpose = String(req.body.purpose || '').trim();
    if (!purpose) return res.status(400).json({ error: 'purpose is required' });
    const result = await buildBudgetKit({
      purpose,
      grade: req.body.grade ? String(req.body.grade) : undefined,
      maxBudget: numberParam(req.body.maxBudget, 1_000_000),
      itemCount: numberParam(req.body.itemCount, 10),
      source: (req.body.source as MallSource) || 'all',
      needs: Array.isArray(req.body.needs) ? req.body.needs.map(String).filter(Boolean) : undefined,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function sanitizeExportItems(input: unknown): EstimateExportItem[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const data = item as Record<string, unknown>;
    const goodsName = String(data.goods_name || '').trim();
    const quantity = Math.max(1, Math.floor(Number(data.quantity) || 0));
    const price = Math.max(0, Math.floor(Number(data.price) || 0));
    if (!goodsName || quantity <= 0 || price <= 0) return [];
    return [{
      goods_name: goodsName,
      mall_name: data.mall_name ? String(data.mall_name) : undefined,
      provider_name: data.provider_name ? String(data.provider_name) : undefined,
      category: data.category ? String(data.category) : undefined,
      quantity,
      price,
      shop_url: data.shop_url ? String(data.shop_url) : undefined,
    }];
  });
}

function exportSpec(item: EstimateExportItem): string {
  return [
    item.mall_name,
    item.category,
    item.provider_name,
  ].filter(Boolean).join(' / ');
}

function estimateFileName(ext: 'xlsx' | 'csv'): string {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return encodeURIComponent(`에듀파인_견적내역_${stamp}.${ext}`);
}

app.post('/api/export/estimate.csv', (req, res) => {
  const items = sanitizeExportItems(req.body?.items);
  if (items.length === 0) return res.status(400).json({ error: 'items are required' });
  const rows = [
    ['내용', '규격', '수량', '단가'],
    ...items.map(item => [item.goods_name, exportSpec(item), String(item.quantity), String(item.price)]),
  ];
  const csv = rows
    .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${estimateFileName('csv')}`);
  res.send(`\uFEFF${csv}`);
});

app.post('/api/export/estimate.xlsx', async (req, res) => {
  try {
    const items = sanitizeExportItems(req.body?.items);
    if (items.length === 0) return res.status(400).json({ error: 'items are required' });
    if (!existsSync(estimateTemplatePath)) {
      return res.status(500).json({ error: `estimate template not found: ${estimateTemplatePath}` });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(estimateTemplatePath);
    const worksheet = workbook.getWorksheet('품목내역') || workbook.worksheets[0];
    if (!worksheet) return res.status(500).json({ error: 'template worksheet not found' });

    const headerRow = worksheet.getRow(1);
    const templateRow = worksheet.getRow(2);
    const templateStyle = [1, 2, 3, 4].map(index => ({ ...templateRow.getCell(index).style }));
    const templateHeight = templateRow.height;

    if (worksheet.rowCount > 1) {
      worksheet.spliceRows(2, worksheet.rowCount - 1);
    }

    items.forEach((item, index) => {
      const row = worksheet.getRow(index + 2);
      row.getCell(1).value = item.goods_name;
      row.getCell(2).value = exportSpec(item);
      row.getCell(3).value = item.quantity;
      row.getCell(4).value = item.price;
      [1, 2, 3, 4].forEach(cellIndex => {
        row.getCell(cellIndex).style = { ...templateStyle[cellIndex - 1] };
      });
      row.height = templateHeight;
      row.commit();
    });

    headerRow.commit();
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${estimateFileName('xlsx')}`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Readywater API listening on http://127.0.0.1:${PORT}`);
  });
}
