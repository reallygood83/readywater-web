export type MallSource = 'all' | 'teachermall' | 'iscream';
export type SortOption = 'relevance' | 'price_low' | 'price_high' | 'popular' | 'newest';

export interface Product {
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

export interface BudgetLine extends Product {
  quantity: number;
  useCase: string;
  reason?: string;
  activities?: string[];
  risks?: string[];
  category?: string;
}

export interface BudgetKitResponse {
  items: BudgetLine[];
  totalCost: number;
  remaining: number;
  allCandidates: Product[];
  needs: string[];
}

export interface RecommendationResponse {
  parser: 'gemini' | 'rules';
  summary: string;
  strategy: string;
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
