import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  BookOpenCheck,
  Download,
  ExternalLink,
  FileSpreadsheet,
  List,
  Lock,
  Loader2,
  Lightbulb,
  LogOut,
  ShieldCheck,
  Search,
  Settings2,
  ShoppingCart,
  Sparkles,
  Wand2,
} from 'lucide-react';
import type { BudgetKitResponse, BudgetLine, MallSource, Product, RecommendationResponse, SortOption } from './types';

const formatWon = (value: number) => `${value.toLocaleString('ko-KR')}원`;

const sourceOptions: Array<{ value: MallSource; label: string }> = [
  { value: 'all', label: '통합' },
  { value: 'teachermall', label: '티처몰' },
  { value: 'iscream', label: '아이스크림몰' },
];

const sortOptions: Array<{ value: SortOption; label: string }> = [
  { value: 'relevance', label: '추천순' },
  { value: 'popular', label: '반응순' },
  { value: 'price_low', label: '낮은 가격' },
  { value: 'price_high', label: '높은 가격' },
  { value: 'newest', label: '최신순' },
];

const seedNeeds = ['피구공', '원마커', '팀조끼', '라바콘', '플라잉디스크'];

const loadingSteps = [
  '자연어 요청 해석',
  '티처몰 상품 후보 검색',
  '아이스크림몰 상품 후보 검색',
  'Gemini 큐레이션',
  '예산/구매 링크 검증',
];

function mallClass(mall: Product['mall']) {
  return mall === 'iscream' ? 'iscream' : 'teachermall';
}

function signalText(product: Product) {
  const signals = [
    product.purchase_count ? `구매 ${product.purchase_count.toLocaleString('ko-KR')}` : '',
    product.wish_count ? `찜 ${product.wish_count.toLocaleString('ko-KR')}` : '',
    product.review_count ? `리뷰 ${product.review_count.toLocaleString('ko-KR')}` : '',
    product.average_rating ? `평점 ${product.average_rating}` : '',
  ].filter(Boolean);
  return signals.length ? signals.join(' · ') : '반응 데이터 확인 중';
}

function productTags(product: Product) {
  const text = [product.goods_name, product.category_path || '', product.properties || ''].join(' ');
  const tags = new Set<string>();
  if (/체육|스포츠|운동|놀이체육/.test(text)) tags.add('체육');
  if (/피구|공\b|스펀지|솜털|빈백/.test(text)) tags.add('구기');
  if (/안전|소프트|말랑/.test(text)) tags.add('안전');
  if (/협동|팀|조끼/.test(text)) tags.add('협동');
  if (/뉴스포츠|스파이크볼|피클볼|디스크/.test(text)) tags.add('뉴스포츠');
  if (/기록|타이머|점수|스코어/.test(text)) tags.add('기록');
  if (/순발력|민첩|사다리/.test(text)) tags.add('훈련');
  return Array.from(tags).slice(0, 3);
}

function popularityValue(product: Product) {
  return product.purchase_count || product.wish_count || product.review_count || 0;
}

function compactNumber(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return value.toLocaleString('ko-KR');
}

function isSoldOut(product: Product) {
  return /sold|out|품절|판매종료|일시품절/i.test([product.sale_status || '', product.properties || ''].join(' '));
}

function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [grade, setGrade] = useState('6학년');
  const [purpose, setPurpose] = useState('체육교육');
  const [budget, setBudget] = useState(1_000_000);
  const [source, setSource] = useState<MallSource>('all');
  const [sort, setSort] = useState<SortOption>('relevance');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [kit, setKit] = useState<BudgetKitResponse | null>(null);
  const [recommendation, setRecommendation] = useState<RecommendationResponse | null>(null);
  const [selected, setSelected] = useState<BudgetLine[]>([]);
  const [naturalPrompt, setNaturalPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState<'search' | 'budget' | 'prompt' | null>(null);
  const [status, setStatus] = useState('조건을 입력하고 검색을 시작하세요.');
  const [activeTab, setActiveTab] = useState<'search' | 'budget'>('search');
  const [resultView, setResultView] = useState<'table' | 'card'>('table');
  const [hideSoldOut, setHideSoldOut] = useState(false);

  const modalSteps = loadingMode === 'prompt'
    ? loadingSteps
    : loadingMode === 'budget'
      ? ['조건 정리', '상품 후보 검색', '카테고리 균형 계산', '예산 검증']
      : ['검색 조건 확인', '티처몰 조회', '아이스크림몰 조회', '결과 정렬'];

  const totals = useMemo(() => {
    const selectedTotal = selected.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return {
      selectedTotal,
      remaining: budget - selectedTotal,
    };
  }, [budget, selected]);

  const stockFilteredResults = useMemo(() => (
    hideSoldOut ? results.filter(product => !isSoldOut(product)) : results
  ), [hideSoldOut, results]);

  const visibleResults = useMemo(() => (
    source === 'all' ? stockFilteredResults : stockFilteredResults.filter(product => product.mall === source)
  ), [source, stockFilteredResults]);

  const resultCounts = useMemo(() => ({
    all: stockFilteredResults.length,
    teachermall: stockFilteredResults.filter(product => product.mall === 'teachermall').length,
    iscream: stockFilteredResults.filter(product => product.mall === 'iscream').length,
  }), [stockFilteredResults]);

  useEffect(() => {
    async function checkAuth() {
      try {
        const response = await fetch('/api/auth/status');
        const data = await response.json() as { enabled: boolean; authenticated: boolean };
        setAuthEnabled(data.enabled);
        setAuthenticated(data.authenticated);
      } catch {
        setAuthError('인증 상태를 확인하지 못했습니다. 서버 실행 상태를 확인해 주세요.');
      } finally {
        setAuthChecked(true);
      }
    }
    void checkAuth();
  }, []);

  function handleUnauthorized(response: Response): boolean {
    if (response.status !== 401) return false;
    setAuthenticated(false);
    setAuthEnabled(true);
    setStatus('비밀번호 인증이 필요합니다.');
    return true;
  }

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) throw new Error(await response.text());
      setAuthenticated(true);
      setPassword('');
      setStatus('인증되었습니다. 검색을 시작하세요.');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAuthenticated(false);
    setPassword('');
  }

  async function runSearch(nextQuery = query) {
    const searchQuery = nextQuery.trim() || [grade, purpose, '교구'].filter(Boolean).join(' ');
    setLoading(true);
    setLoadingMode('search');
    setStatus('두 몰의 상품 데이터를 검색하고 있습니다.');
    try {
      const params = new URLSearchParams({
        query: searchQuery,
        source,
        sort,
        limit: '18',
      });
      const response = await fetch(`/api/search?${params.toString()}`);
      if (handleUnauthorized(response)) return;
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as { items: Product[] };
      setResults(data.items);
      setStatus(`${data.items.length}개 상품을 찾았습니다. 구매 링크와 가격을 함께 확인하세요.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      setLoadingMode(null);
    }
  }

  async function buildKit() {
    setLoading(true);
    setLoadingMode('budget');
    setActiveTab('budget');
    setStatus('예산에 맞는 조합을 구성하고 있습니다.');
    try {
      const response = await fetch('/api/budget-kit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purpose,
          grade,
          maxBudget: budget,
          itemCount: 12,
          source,
          needs: [[grade, purpose].join(' '), ...seedNeeds],
        }),
      });
      if (handleUnauthorized(response)) return;
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as BudgetKitResponse;
      setKit(data);
      setRecommendation(null);
      setSelected(data.items);
      setResults(data.allCandidates);
      setStatus(`예산안 ${formatWon(data.totalCost)}을 구성했습니다. 남은 예산은 ${formatWon(data.remaining)}입니다.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      setLoadingMode(null);
    }
  }

  async function runNaturalPrompt() {
    const prompt = naturalPrompt.trim();
    if (!prompt) {
      setStatus('찾고 싶은 수업 상황과 예산을 자연어로 입력해 주세요.');
      return;
    }
    setLoading(true);
    setLoadingMode('prompt');
    setStatus('자연어 요청을 검색 조건과 예산안으로 해석하고 있습니다.');
    try {
      const response = await fetch('/api/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      if (handleUnauthorized(response)) return;
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as {
        parser: 'gemini' | 'rules';
        intent: {
          grade?: string;
          purpose: string;
          maxBudget: number;
          source: MallSource;
          sort: SortOption;
        };
        query: string;
        items: Product[];
        budgetKit: BudgetKitResponse | null;
        recommendation: RecommendationResponse | null;
      };

      setGrade(data.intent.grade || grade);
      setPurpose(data.intent.purpose);
      setBudget(data.intent.maxBudget);
      setSource(data.intent.source);
      setSort(data.intent.sort);
      setQuery(data.query);
      setResults(data.items);
      setRecommendation(data.recommendation);
      if (data.budgetKit) {
        setKit(data.budgetKit);
        setSelected(data.budgetKit.items);
        setActiveTab('budget');
        setStatus(`${data.recommendation?.parser === 'gemini' ? 'Gemini AI' : data.parser === 'gemini' ? 'Gemini AI + 룰 보정' : '룰 기반'}로 실제 후보 상품만 검증해 ${formatWon(data.budgetKit.totalCost)} 추천안을 만들었습니다.`);
      } else {
        setActiveTab('search');
        setStatus(`${data.parser === 'gemini' ? 'Gemini AI' : '룰 기반'}로 요청을 해석해 ${data.items.length}개 상품을 찾았습니다.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      setLoadingMode(null);
    }
  }

  function addProduct(product: Product) {
    setSelected(current => {
      const found = current.find(item => item.mall === product.mall && item.goods_seq === product.goods_seq);
      if (found) {
        return current.map(item => item === found ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...current, { ...product, quantity: 1, useCase: `${purpose} 수업 활동에 활용` }];
    });
  }

  function quantityForProduct(product: Product) {
    return selected.find(item => item.mall === product.mall && item.goods_seq === product.goods_seq)?.quantity || 0;
  }

  function setProductQuantity(product: Product, quantity: number) {
    setSelected(current => {
      const found = current.find(item => item.mall === product.mall && item.goods_seq === product.goods_seq);
      if (!found && quantity <= 0) return current;
      if (!found) return [...current, { ...product, quantity, useCase: `${purpose} 수업 활동에 활용` }];
      return current
        .map(item => item === found ? { ...item, quantity } : item)
        .filter(item => item.quantity > 0);
    });
  }

  function updateQuantity(line: BudgetLine, quantity: number) {
    setSelected(current => current
      .map(item => item.mall === line.mall && item.goods_seq === line.goods_seq ? { ...item, quantity } : item)
      .filter(item => item.quantity > 0));
  }

  function downloadMarkdown() {
    const lines = [
      `# ${grade} ${purpose} 교구 구매 리포트`,
      '',
      `- 예산: ${formatWon(budget)}`,
      `- 구성 총액: ${formatWon(totals.selectedTotal)}`,
      `- 남은 예산: ${formatWon(totals.remaining)}`,
      recommendation ? `- 추천 요약: ${recommendation.summary}` : '',
      recommendation ? `- 구성 전략: ${recommendation.strategy}` : '',
      '',
      '## 구매 목록',
      '',
      ...selected.map((item, index) => [
        `### ${index + 1}. ${item.goods_name}`,
        `- 몰: ${item.mall_name}`,
        item.category ? `- 영역: ${item.category}` : '',
        `- 단가: ${formatWon(item.price)}`,
        `- 수량: ${item.quantity}`,
        `- 소계: ${formatWon(item.price * item.quantity)}`,
        item.reason ? `- 선정 이유: ${item.reason}` : '',
        `- 활용: ${item.useCase}`,
        item.activities?.length ? `- 활동 예시: ${item.activities.join(', ')}` : '',
        item.risks?.length ? `- 확인 사항: ${item.risks.join(', ')}` : '',
        `- 구매 링크: ${item.shop_url}`,
        '',
      ].filter(Boolean).join('\n')),
      recommendation?.rejected.length ? '## 제외한 후보' : '',
      ...(recommendation?.rejected.map(item => `- ${item.goods_name}: ${item.reason}`) || []),
    ].filter(Boolean);
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `readywater-${grade}-${purpose}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const mallCounts = useMemo(() => selected.reduce<Record<string, number>>((acc, item) => {
    acc[item.mall_name] = (acc[item.mall_name] || 0) + 1;
    return acc;
  }, {}), [selected]);

  const mallSummary = useMemo(() => {
    const rows = ['티처몰', '아이스크림몰'].map(mallName => {
      const items = selected.filter(item => item.mall_name === mallName);
      const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
      const averagePrice = items.length ? Math.round(items.reduce((sum, item) => sum + item.price, 0) / items.length) : 0;
      const signals = items.reduce((sum, item) => sum + (item.purchase_count || 0) + (item.wish_count || 0) + (item.review_count || 0), 0);
      return { mallName, count: items.length, total, averagePrice, signals };
    });
    const leader = [...rows].sort((a, b) => b.total - a.total)[0];
    return { rows, leader: leader?.count ? leader.mallName : '구성 전' };
  }, [selected]);

  const lessonIdeas = useMemo(() => {
    const categories = new Set(selected.map(item => item.category).filter(Boolean));
    const ideas = [];
    if (categories.has('팀구분') || selected.some(item => /조끼/.test(item.goods_name))) {
      ideas.push({ title: '팀 빌딩 활동', body: '팀조끼로 모둠을 나누고, 역할을 순환하며 협동 규칙을 연습합니다.' });
    }
    if (categories.has('공간표시') || selected.some(item => /마커|콘/.test(item.goods_name))) {
      ideas.push({ title: '순환 스테이션 수업', body: '원마커와 콘으로 코스를 나누어 던지기, 민첩성, 균형 활동을 동시에 운영합니다.' });
    }
    if (categories.has('뉴스포츠')) {
      ideas.push({ title: '뉴스포츠 리그', body: '플라잉디스크, 피클볼, 라켓형 교구로 짧은 리그전을 구성해 참여도를 높입니다.' });
    }
    if (categories.has('구기던지기')) {
      ideas.push({ title: '안전 피구 변형 게임', body: '부드러운 공을 활용해 표적 맞히기, 구역 피구, 협동 패스 미션을 진행합니다.' });
    }
    return ideas.slice(0, 4);
  }, [selected]);

  async function downloadEstimate(format: 'xlsx' | 'csv') {
    if (selected.length === 0) {
      setStatus('견적서를 만들 상품을 먼저 장바구니에 담아 주세요.');
      return;
    }
    setLoading(true);
    setLoadingMode('budget');
    setStatus(format === 'xlsx' ? '에듀파인 견적 엑셀 파일을 만들고 있습니다.' : 'CSV 견적 파일을 만들고 있습니다.');
    try {
      const response = await fetch(`/api/export/estimate.${format}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selected }),
      });
      if (handleUnauthorized(response)) return;
      if (!response.ok) throw new Error(await response.text());
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      anchor.download = `에듀파인_견적내역_${stamp}.${format}`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus(format === 'xlsx' ? '에듀파인 견적 엑셀 파일을 다운로드했습니다.' : 'CSV 견적 파일을 다운로드했습니다.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
      setLoadingMode(null);
    }
  }

  return (
    <div className="app-shell">
      {loading && loadingMode ? (
        <div className="loading-backdrop" role="status" aria-live="polite">
          <div className="loading-modal">
            <div className="loading-orbit">
              <Sparkles size={22} />
            </div>
            <div className="loading-copy">
              <strong>
                {loadingMode === 'prompt' ? 'AI가 구매안을 구성하고 있어요' : loadingMode === 'budget' ? '예산안을 계산하고 있어요' : '상품을 검색하고 있어요'}
              </strong>
              <p>
                {loadingMode === 'prompt'
                  ? 'Gemini가 요청을 해석하고, 실제 상품 후보만 골라 예산과 구매 링크를 다시 확인합니다.'
                  : '두 몰의 데이터를 모아 가격과 반응 신호를 정리합니다.'}
              </p>
            </div>
            <ol className="loading-steps">
              {modalSteps.map((step, index) => (
                <li key={step} style={{ animationDelay: `${index * 0.16}s` }}>
                  <span>{index + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </div>
      ) : null}

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={18} /></span>
          <div>
            <strong>Readywater</strong>
            <span>티처몰 + 아이스크림몰 통합 구매 워크벤치</span>
          </div>
        </div>
        <nav className="tabs" aria-label="주요 보기">
          <button className={activeTab === 'search' ? 'active' : ''} onClick={() => setActiveTab('search')}>
            <Search size={16} /> 통합검색
          </button>
          <button className={activeTab === 'budget' ? 'active' : ''} onClick={() => setActiveTab('budget')}>
            <ShoppingCart size={16} /> 예산구성
          </button>
        </nav>
        {authEnabled && authenticated ? (
          <button className="logout-button" onClick={() => void logout()}>
            <LogOut size={15} />
            로그아웃
          </button>
        ) : null}
      </header>

      {!authChecked ? (
        <main className="auth-screen">
          <div className="auth-card">
            <Loader2 className="spin" size={22} />
            <strong>접근 권한을 확인하고 있습니다</strong>
          </div>
        </main>
      ) : authEnabled && !authenticated ? (
        <main className="auth-screen">
          <form className="auth-card" onSubmit={login}>
            <span className="auth-mark"><Lock size={22} /></span>
            <div>
              <strong>Readywater 비밀번호</strong>
              <p>무료 API 사용량 보호를 위해 인증된 사용자만 검색할 수 있습니다.</p>
            </div>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoFocus
              aria-label="Readywater 비밀번호"
            />
            {authError ? <p className="auth-error">{authError}</p> : null}
            <button type="submit" disabled={!password.trim()}>입장하기</button>
          </form>
        </main>
      ) : (

      <main className="workspace">
        <aside className="filter-panel">
          <div className="panel-title">
            <Settings2 size={17} />
            <span>검색 조건</span>
          </div>

          <label>
            학년
            <select value={grade} onChange={event => setGrade(event.target.value)}>
              <optgroup label="초등">
                <option>초등 1학년</option>
                <option>초등 2학년</option>
                <option>초등 3학년</option>
                <option>초등 4학년</option>
                <option>초등 5학년</option>
                <option>6학년</option>
              </optgroup>
              <optgroup label="중등">
                <option>중등 1학년</option>
                <option>중등 2학년</option>
                <option>중등 3학년</option>
              </optgroup>
              <optgroup label="고등">
                <option>고등 1학년</option>
                <option>고등 2학년</option>
                <option>고등 3학년</option>
              </optgroup>
              <option>전학년</option>
            </select>
          </label>

          <label>
            활동/과목
            <input value={purpose} onChange={event => setPurpose(event.target.value)} />
          </label>

          <label>
            검색어
            <input value={query} onChange={event => setQuery(event.target.value)} />
          </label>

          <label>
            예산
            <input type="number" min={1000} step={10000} value={budget} onChange={event => setBudget(Number(event.target.value))} />
          </label>

          <div className="field">
            <span>검색 대상</span>
            <div className="segmented">
              {sourceOptions.map(option => (
                <button key={option.value} className={source === option.value ? 'active' : ''} onClick={() => setSource(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <label>
            정렬
            <select value={sort} onChange={event => setSort(event.target.value as SortOption)}>
              {sortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>

          <button className="primary-action" onClick={() => void runSearch()} disabled={loading}>
            {loading ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
            검색하기
          </button>
          <button className="secondary-action" onClick={() => void buildKit()} disabled={loading}>
            <BookOpenCheck size={17} />
            예산안 자동 구성
          </button>

          <div className="status">{status}</div>
        </aside>

        <section className="result-panel" aria-label="상품 결과">
          <div className="prompt-search">
            <div>
              <Sparkles size={18} />
              <span>자연어 AI 검색</span>
            </div>
            <textarea
              aria-label="자연어 검색"
              value={naturalPrompt}
              onChange={event => setNaturalPrompt(event.target.value)}
              rows={2}
            />
            <button onClick={() => void runNaturalPrompt()} disabled={loading}>
              {loading ? <Loader2 className="spin" size={17} /> : <Wand2 size={17} />}
              프롬프트로 찾기
            </button>
          </div>

          <div className="section-head">
            <div>
              <h1>{grade} {purpose} 교구 검색</h1>
              <p>가격, 반응 신호, 구매 링크를 한 화면에서 비교합니다.</p>
            </div>
            <div className="quick-prompts">
              {seedNeeds.map(need => (
                <button key={need} onClick={() => {
                  setQuery(need);
                  void runSearch(need);
                }}>{need}</button>
              ))}
            </div>
          </div>

          {recommendation ? (
            <section className="recommendation-panel" aria-label="AI 추천 요약">
              <div className="recommendation-title">
                <div>
                  <Sparkles size={18} />
                  <span>{recommendation.parser === 'gemini' ? 'Gemini 큐레이션' : '규칙 기반 큐레이션'}</span>
                </div>
                <strong>{formatWon(recommendation.totalCost)} / {formatWon(budget)}</strong>
              </div>
              <p className="recommendation-summary">{recommendation.summary}</p>
              <p className="recommendation-strategy">{recommendation.strategy}</p>
              <div className="coverage-list">
                {recommendation.coverage.map(item => <span key={item}>{item}</span>)}
              </div>
              {recommendation.rejected.length ? (
                <details className="rejected-list">
                  <summary>제외한 후보 {recommendation.rejected.length}개 보기</summary>
                  {recommendation.rejected.map(item => (
                    <p key={`${item.mall}:${item.goods_seq}`}>
                      <strong>{item.goods_name}</strong> - {item.reason}
                    </p>
                  ))}
                </details>
              ) : null}
            </section>
          ) : null}

          <div className="results-header">
            <div>
              <strong>검색 결과</strong>
              <span>총 {visibleResults.length}개 상품</span>
            </div>
            <div className="result-tools">
              <label className="stock-toggle">
                <input type="checkbox" checked={hideSoldOut} onChange={event => setHideSoldOut(event.target.checked)} />
                품절 제외
              </label>
              <div className="view-toggle" aria-label="결과 보기 방식">
                <button className={resultView === 'table' ? 'active' : ''} onClick={() => setResultView('table')}>
                  <List size={16} />
                  표 보기
                </button>
                <button className={resultView === 'card' ? 'active' : ''} onClick={() => setResultView('card')}>
                  카드 보기
                </button>
              </div>
              <select value={sort} onChange={event => setSort(event.target.value as SortOption)} aria-label="결과 정렬">
                {sortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </div>
          </div>

          <div className="result-pills">
            <button className={source === 'all' ? 'active' : ''} onClick={() => setSource('all')}>전체({resultCounts.all})</button>
            <button className={source === 'teachermall' ? 'active teachermall' : 'teachermall'} onClick={() => setSource('teachermall')}>티처몰({resultCounts.teachermall})</button>
            <button className={source === 'iscream' ? 'active iscream' : 'iscream'} onClick={() => setSource('iscream')}>아이스크림몰({resultCounts.iscream})</button>
          </div>

          {resultView === 'table' ? (
            <div className="product-table" role="table" aria-label="상품 검색 결과 표">
              <div className="product-table-head" role="row">
                <span>쇼핑몰</span>
                <span>상품 정보</span>
                <span>가격</span>
                <span>인기도</span>
                <span>평점</span>
                <span>구매</span>
                <span>수량</span>
              </div>
              {visibleResults.map(product => {
                const quantity = quantityForProduct(product);
                const popularity = popularityValue(product);
                return (
                  <article className="product-row" key={`${product.mall}:${product.goods_seq}`} role="row">
                    <div className="mall-cell">
                      <span className={`mall-icon ${mallClass(product.mall)}`}>{product.mall === 'teachermall' ? 'T' : 'i'}</span>
                      <strong>{product.mall_name}</strong>
                    </div>
                    <div className="info-cell">
                      <img src={product.image_url || '/placeholder.svg'} alt="" />
                      <div>
                        <h2>{product.goods_name}</h2>
                        <div className="tag-row">
                          {productTags(product).map(tag => <span key={tag}>{tag}</span>)}
                          {product.discount_rate ? <span>{product.discount_rate}% 할인</span> : null}
                        </div>
                        <p>{product.provider_name || product.category_path || `${purpose} 수업 활동에 활용`}</p>
                      </div>
                    </div>
                    <div className="table-price">{formatWon(product.price)}</div>
                    <div className="signal-cell">
                      <strong>{popularity ? compactNumber(popularity) : '-'}</strong>
                      <span>{popularity ? '반응 신호' : '확인 중'}</span>
                      {popularity ? <em>인기</em> : null}
                    </div>
                    <div className="rating-cell">
                      <strong>{product.average_rating ? product.average_rating.toFixed(1) : '-'}</strong>
                      <span>{product.review_count ? `(${product.review_count.toLocaleString('ko-KR')})` : ''}</span>
                    </div>
                    <a className="buy-button" href={product.shop_url} target="_blank" rel="noreferrer">
                      구매하기 <ExternalLink size={14} />
                    </a>
                    <div className="quantity-stepper">
                      <button onClick={() => setProductQuantity(product, Math.max(0, quantity - 1))}>-</button>
                      <span>{quantity}</span>
                      <button onClick={() => setProductQuantity(product, quantity + 1)}>+</button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="product-grid">
              {visibleResults.map(product => (
                <article className="product-card" key={`${product.mall}:${product.goods_seq}`}>
                  <img src={product.image_url || '/placeholder.svg'} alt="" />
                  <div className="product-body">
                    <div className="product-meta">
                      <span className={`mall-badge ${mallClass(product.mall)}`}>{product.mall_name}</span>
                      <span>{product.provider_name || '판매처 확인'}</span>
                    </div>
                    <h2>{product.goods_name}</h2>
                    <div className="price-row">
                      <strong>{formatWon(product.price)}</strong>
                      {product.discount_rate ? <span>{product.discount_rate}%</span> : null}
                    </div>
                    <p>{signalText(product)}</p>
                    <div className="card-actions">
                      <button onClick={() => addProduct(product)}>담기</button>
                      <a href={product.shop_url} target="_blank" rel="noreferrer">
                        구매 <ExternalLink size={14} />
                      </a>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="insight-grid">
            <section className="insight-card">
              <div className="insight-title">
                <BarChart3 size={17} />
                <span>쇼핑몰 비교 요약</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>구분</th>
                    <th>상품 수</th>
                    <th>금액</th>
                    <th>평균 단가</th>
                  </tr>
                </thead>
                <tbody>
                  {mallSummary.rows.map(row => (
                    <tr key={row.mallName}>
                      <td>{row.mallName}</td>
                      <td>{row.count}</td>
                      <td>{formatWon(row.total)}</td>
                      <td>{row.averagePrice ? formatWon(row.averagePrice) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>{mallSummary.leader === '구성 전' ? '예산안을 구성하면 몰별 비교가 표시됩니다.' : `${mallSummary.leader} 비중이 가장 큽니다. 가격과 배송/학교 구매 편의성을 함께 확인하세요.`}</p>
            </section>

            <section className="insight-card">
              <div className="insight-title">
                <Lightbulb size={17} />
                <span>수업 활용 아이디어</span>
              </div>
              {lessonIdeas.length ? (
                <div className="idea-list">
                  {lessonIdeas.map(idea => (
                    <div key={idea.title}>
                      <strong>{idea.title}</strong>
                      <p>{idea.body}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p>추천안을 구성하면 교구 조합에 맞춘 수업 활용 아이디어가 표시됩니다.</p>
              )}
            </section>
          </div>
        </section>

        <aside className="cart-panel">
          <div className="cart-top">
            <div>
              <span>예산 장바구니</span>
              <strong>{formatWon(totals.selectedTotal)}</strong>
            </div>
            <div className={totals.remaining >= 0 ? 'remaining good' : 'remaining over'}>
              남은 예산 {formatWon(totals.remaining)}
            </div>
          </div>

          <div className="progress-bar">
            <span style={{ width: `${Math.min(100, Math.max(0, (totals.selectedTotal / budget) * 100))}%` }} />
          </div>

          <div className="cart-lines">
            {selected.map(line => (
              <div className="cart-line" key={`${line.mall}:${line.goods_seq}`}>
                <div>
                  <span className={`mall-dot ${mallClass(line.mall)}`} />
                  <strong>{line.goods_name}</strong>
                  {line.reason ? <p className="line-reason"><ShieldCheck size={13} /> {line.reason}</p> : null}
                  <p>{line.useCase}</p>
                  {line.activities?.length ? <p>활동: {line.activities.slice(0, 2).join(' · ')}</p> : null}
                  {line.risks?.length ? <p>확인: {line.risks.join(' · ')}</p> : null}
                </div>
                <div className="qty-row">
                  <button onClick={() => updateQuantity(line, line.quantity - 1)}>-</button>
                  <span>{line.quantity}</span>
                  <button onClick={() => updateQuantity(line, line.quantity + 1)}>+</button>
                </div>
                <a href={line.shop_url} target="_blank" rel="noreferrer">구매 링크</a>
              </div>
            ))}
          </div>

          <div className="summary-box">
            <div>
              <BarChart3 size={16} />
              <span>몰별 구성</span>
            </div>
            <p>티처몰 {mallCounts['티처몰'] || 0}개 · 아이스크림몰 {mallCounts['아이스크림몰'] || 0}개</p>
            {kit ? <p>후보 {kit.allCandidates.length}개에서 예산 최적 후보를 골랐습니다.</p> : <p>자동 구성 후 비교 요약이 표시됩니다.</p>}
          </div>

          <div className="export-actions">
            <button onClick={downloadMarkdown}><Download size={16} /> Markdown</button>
            <button onClick={() => void downloadEstimate('xlsx')}><FileSpreadsheet size={16} /> Excel</button>
            <button onClick={() => void downloadEstimate('csv')}><Download size={16} /> CSV</button>
          </div>
        </aside>
      </main>
      )}
    </div>
  );
}

export default App;
