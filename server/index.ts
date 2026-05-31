import express from 'express';

type MallSource = 'all' | 'teachermall' | 'iscream';
type SortOption = 'relevance' | 'price_low' | 'price_high' | 'popular' | 'newest';

interface SearchOptions {
  page?: number;
  limit?: number;
  sort?: SortOption;
  minPrice?: number;
  maxPrice?: number;
  source?: MallSource;
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

const app = express();
const PORT = Number(process.env.PORT || 5191);

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
  return /체육|운동|스포츠|피구|공\b|원마커|마커|팀조끼|조끼|라바콘|삼각콘|고깔|플라잉디스크|디스크|뉴스포츠|구기|놀이체육/.test(productText(item));
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

  score += Math.min(item.purchase_count || 0, 1000) * 0.25;
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
      const aPopularity = (a.purchase_count || 0) + (a.wish_count || 0) + (a.review_count || 0) * 5;
      const bPopularity = (b.purchase_count || 0) + (b.wish_count || 0) + (b.review_count || 0) * 5;
      return bPopularity - aPopularity;
    }
    if (sort === 'newest') return new Date(b.regist_date || 0).getTime() - new Date(a.regist_date || 0).getTime();
    return keywordScore(b, query) - keywordScore(a, query);
  });
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...commonHeaders,
      ...(init.headers || {}),
    },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} ${url}`);
  return response.json() as Promise<T>;
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
    purchase_count: parseNumber(item.purchase_ea_total || item.purchase_ea) || undefined,
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
  });
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

  const raw = await fetchJson<any>(`${iscreamApiUrl}/api/goods/v1/search/product`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'site_no=312; lang_cd=ko; mall_no=1;',
      Origin: iscreamSiteUrl,
      Referer: `${iscreamSiteUrl}/`,
    },
    body: JSON.stringify(body),
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
  const queries = expandBroadQuery(query);
  const jobs: Promise<Product[]>[] = [];

  for (const searchQuery of queries) {
    if (source === 'all' || source === 'teachermall') {
      jobs.push(searchTeachermall(searchQuery, { ...options, limit: fetchLimit }).catch(() => []));
    }
    if (source === 'all' || source === 'iscream') {
      jobs.push(searchIscream(searchQuery, { ...options, limit: fetchLimit }).catch(() => []));
    }
  }

  const merged = (await Promise.all(jobs)).flat();
  const scoped = isSportsQuery(query) ? merged.filter(isSportsProduct) : merged;
  const deduped = Array.from(new Map(scoped.map(item => [`${item.mall}:${item.goods_seq}`, item])).values());
  return sortProducts(deduped, sort, query).slice(0, limit);
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
      const aValue = keywordScore(a, baseNeeds.join(' ')) / Math.max(a.price, 500);
      const bValue = keywordScore(b, baseNeeds.join(' ')) / Math.max(b.price, 500);
      return bValue - aValue;
    });

  const lines: BudgetLine[] = [];
  let totalCost = 0;

  for (const item of unique) {
    if (lines.length >= params.itemCount) break;
    const remaining = params.maxBudget - totalCost;
    if (item.price > remaining) continue;
    const targetQuantity = item.price < 3000 ? 20 : item.price < 12000 ? 8 : item.price < 35000 ? 4 : 1;
    const quantity = Math.max(1, Math.min(targetQuantity, Math.floor(remaining / item.price)));
    const lineCost = item.price * quantity;
    if (lineCost <= remaining) {
      lines.push({ ...item, quantity, useCase: useCaseForProduct(item, params.purpose) });
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

function numberParam(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'readywater-web', time: new Date().toISOString() });
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
    const intent = parseNaturalPrompt(prompt);
    const query = [intent.grade, intent.purpose, '교구'].filter(Boolean).join(' ');
    const [items, budgetKit] = await Promise.all([
      searchProducts(query, {
        source: intent.source,
        sort: intent.sort,
        limit: 18,
        maxPrice: intent.maxBudget,
      }),
      intent.shouldBuildBudget
        ? buildBudgetKit({
          purpose: intent.purpose,
          grade: intent.grade,
          maxBudget: intent.maxBudget,
          itemCount: 12,
          source: intent.source,
          needs: intent.needs,
        })
        : Promise.resolve(null),
    ]);

    res.json({
      prompt,
      intent,
      query,
      items,
      budgetKit,
    });
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Readywater API listening on http://127.0.0.1:${PORT}`);
});
