# Readywater Web

Readywater Web is a local browser UI for searching Teachermall and i-Scream Mall together. It is intentionally separate from the MCP server so the shopping agent, web UI, and future document-export layer can evolve independently.

## What It Does

- Natural-language prompt search in Korean.
- Gemini-backed intent parsing with rule-based fallback.
- Gemini-backed purchase curation from real retrieved product candidates.
- Search progress modal that explains the AI/search/validation stages while users wait.
- Unified product search across 티처몰 and 아이스크림몰.
- Budget kit generation with quantity, total, remaining budget, and purchase links.
- Product cards with mall badge, price, popularity signals, image, and direct purchase URL.
- Mall comparison summary and lesson-use idea panels.
- Markdown report download from the selected budget cart.
- Edufine-ready Excel estimate download using `/Users/moon/Downloads/에듀파인_견적양식_20260531.xlsx`.
- CSV estimate download with the same `내용, 규격, 수량, 단가` columns.
- Optional password gate for protecting free API usage.

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Set `READYWATER_PASSWORD` in `.env` to require a password before users can search or use AI/export APIs. Keep `GEMINI_API_KEY`, `READYWATER_PASSWORD`, and `READYWATER_SESSION_SECRET` out of GitHub.

Open:

```text
http://127.0.0.1:5190
```

The API runs on:

```text
http://127.0.0.1:5191
```

## API Surface

- `GET /api/health`
- `GET /api/auth/status`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/search?query=...&source=all&sort=relevance&limit=18`
- `GET /api/compare?query=...`
- `POST /api/budget-kit`
- `POST /api/intent`
- `POST /api/recommend`
- `POST /api/export/estimate.xlsx`
- `POST /api/export/estimate.csv`

`/api/intent` accepts a natural-language prompt such as:

```json
{
  "prompt": "6학년 체육교육에 100만원 예산으로 반응 좋은 교구를 추천하고 구매 링크까지 알려줘"
}
```

It uses Gemini when `GEMINI_API_KEY` is configured. If Gemini is unavailable, it falls back to the local rule-based parser. It extracts grade, purpose, budget, mall scope, sort intent, and need keywords, then returns search results plus a budget kit when the prompt asks for purchasing or recommendation.

For recommendation prompts, the server now performs a second grounded AI pass:

```text
prompt -> Gemini intent -> live mall candidates -> Gemini curation -> server validation
```

Gemini can only select from retrieved candidate products. The server validates mall, product id, price, budget, and purchase link before returning the final recommendation.

## Document Export Direction

The current app exports Markdown, CSV, and Edufine-ready Excel estimates. The intended next document step is:

1. Generate a structured report JSON from the selected cart.
2. Render Markdown/HTML preview in the web UI.
3. Add HWPX generation or preview through `edwardkim/rhwp` only when the export path is fully wired.
4. Keep PDF export as a server-side render path after the report structure is stable.

## Deployment Direction

The current local architecture is Vite plus an Express API. For hosted use:

- Vercel: move the Express API into a Vercel Node.js Function or split endpoints under `api/`, then set `GEMINI_API_KEY`, `READYWATER_PASSWORD`, and `READYWATER_SESSION_SECRET` as Vercel environment variables.
- Firebase: use Firebase Hosting for the web UI and Cloud Functions for the Express API.
- Firestore: use it for user accounts, password/member records, search logs, usage metering, saved carts, and subscription state. It is not a replacement for the server API that protects the Gemini key.

## Verification

```bash
npm run typecheck
npm run build
curl -sS http://127.0.0.1:5191/api/health
```
