import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  BookOpenCheck,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  Search,
  Settings2,
  ShoppingCart,
  Sparkles,
} from 'lucide-react';
import type { BudgetKitResponse, BudgetLine, MallSource, Product, SortOption } from './types';

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

function App() {
  const [grade, setGrade] = useState('6학년');
  const [purpose, setPurpose] = useState('체육교육');
  const [budget, setBudget] = useState(1_000_000);
  const [source, setSource] = useState<MallSource>('all');
  const [sort, setSort] = useState<SortOption>('relevance');
  const [query, setQuery] = useState('6학년 체육 교구');
  const [results, setResults] = useState<Product[]>([]);
  const [kit, setKit] = useState<BudgetKitResponse | null>(null);
  const [selected, setSelected] = useState<BudgetLine[]>([]);
  const [naturalPrompt, setNaturalPrompt] = useState('6학년 체육교육에 100만원 예산으로 반응 좋은 교구를 추천하고 구매 링크까지 알려줘');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('조건을 입력하고 검색을 시작하세요.');
  const [activeTab, setActiveTab] = useState<'search' | 'budget' | 'report'>('search');

  const totals = useMemo(() => {
    const selectedTotal = selected.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return {
      selectedTotal,
      remaining: budget - selectedTotal,
    };
  }, [budget, selected]);

  async function runSearch(nextQuery = query) {
    setLoading(true);
    setStatus('두 몰의 상품 데이터를 검색하고 있습니다.');
    try {
      const params = new URLSearchParams({
        query: nextQuery,
        source,
        sort,
        limit: '18',
      });
      const response = await fetch(`/api/search?${params.toString()}`);
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as { items: Product[] };
      setResults(data.items);
      setStatus(`${data.items.length}개 상품을 찾았습니다. 구매 링크와 가격을 함께 확인하세요.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function buildKit() {
    setLoading(true);
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
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as BudgetKitResponse;
      setKit(data);
      setSelected(data.items);
      setResults(data.allCandidates);
      setStatus(`예산안 ${formatWon(data.totalCost)}을 구성했습니다. 남은 예산은 ${formatWon(data.remaining)}입니다.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function runNaturalPrompt() {
    setLoading(true);
    setStatus('자연어 요청을 검색 조건과 예산안으로 해석하고 있습니다.');
    try {
      const response = await fetch('/api/intent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: naturalPrompt }),
      });
      if (!response.ok) throw new Error(await response.text());
      const data = await response.json() as {
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
      };

      setGrade(data.intent.grade || grade);
      setPurpose(data.intent.purpose);
      setBudget(data.intent.maxBudget);
      setSource(data.intent.source);
      setSort(data.intent.sort);
      setQuery(data.query);
      setResults(data.items);
      if (data.budgetKit) {
        setKit(data.budgetKit);
        setSelected(data.budgetKit.items);
        setActiveTab('budget');
        setStatus(`요청을 해석해 ${formatWon(data.budgetKit.totalCost)} 예산안을 만들었습니다.`);
      } else {
        setActiveTab('search');
        setStatus(`요청을 해석해 ${data.items.length}개 상품을 찾았습니다.`);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
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
      '',
      '## 구매 목록',
      '',
      ...selected.map((item, index) => [
        `### ${index + 1}. ${item.goods_name}`,
        `- 몰: ${item.mall_name}`,
        `- 단가: ${formatWon(item.price)}`,
        `- 수량: ${item.quantity}`,
        `- 소계: ${formatWon(item.price * item.quantity)}`,
        `- 활용: ${item.useCase}`,
        `- 구매 링크: ${item.shop_url}`,
        '',
      ].join('\n')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `readywater-${grade}-${purpose}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  useEffect(() => {
    void runSearch('6학년 체육 교구');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mallCounts = useMemo(() => selected.reduce<Record<string, number>>((acc, item) => {
    acc[item.mall_name] = (acc[item.mall_name] || 0) + 1;
    return acc;
  }, {}), [selected]);

  return (
    <div className="app-shell">
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
          <button className={activeTab === 'report' ? 'active' : ''} onClick={() => setActiveTab('report')}>
            <FileText size={16} /> 리포트
          </button>
        </nav>
      </header>

      <main className="workspace">
        <aside className="filter-panel">
          <div className="panel-title">
            <Settings2 size={17} />
            <span>검색 조건</span>
          </div>

          <label>
            학년
            <select value={grade} onChange={event => setGrade(event.target.value)}>
              <option>3학년</option>
              <option>4학년</option>
              <option>5학년</option>
              <option>6학년</option>
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
              value={naturalPrompt}
              onChange={event => setNaturalPrompt(event.target.value)}
              rows={2}
              placeholder="예: 6학년 체육교육에 100만원 예산으로 반응 좋은 교구를 추천하고 구매 링크까지 알려줘"
            />
            <button onClick={() => void runNaturalPrompt()} disabled={loading}>
              {loading ? <Loader2 className="spin" size={17} /> : <Sparkles size={17} />}
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

          <div className="product-grid">
            {results.map(product => (
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
                  <p>{line.useCase}</p>
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
            <button disabled title="rhwp/HWPX 연동 예정"><FileText size={16} /> HWPX</button>
            <button disabled>PDF</button>
          </div>
        </aside>
      </main>
    </div>
  );
}

export default App;
