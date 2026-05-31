# Readywater Web

Readywater Web is a local browser UI for searching Teachermall and i-Scream Mall together. It is intentionally separate from the MCP server so the shopping agent, web UI, and future document-export layer can evolve independently.

## What It Does

- Natural-language prompt search in Korean.
- Unified product search across 티처몰 and 아이스크림몰.
- Budget kit generation with quantity, total, remaining budget, and purchase links.
- Product cards with mall badge, price, popularity signals, image, and direct purchase URL.
- Markdown report download from the selected budget cart.
- HWPX/PDF export buttons reserved for the next document pipeline.

## Local Development

```bash
npm install
npm run dev
```

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
- `GET /api/search?query=...&source=all&sort=relevance&limit=18`
- `GET /api/compare?query=...`
- `POST /api/budget-kit`
- `POST /api/intent`

`/api/intent` accepts a natural-language prompt such as:

```json
{
  "prompt": "6학년 체육교육에 100만원 예산으로 반응 좋은 교구를 추천하고 구매 링크까지 알려줘"
}
```

It extracts grade, purpose, budget, mall scope, sort intent, and need keywords, then returns search results plus a budget kit when the prompt asks for purchasing or recommendation.

## Document Export Direction

The current app exports Markdown. The HWPX button is intentionally present but disabled. The intended next step is:

1. Generate a structured report JSON from the selected cart.
2. Render Markdown/HTML preview in the web UI.
3. Add HWPX generation or preview through `edwardkim/rhwp`.
4. Keep PDF export as a server-side render path after HWPX structure is stable.

## Verification

```bash
npm run typecheck
npm run build
curl -sS http://127.0.0.1:5191/api/health
```
