# Cloudflare price agent demo

A private, single-owner demo using **Cloudflare Agents SDK + Browser Run + DeepSeek Flash**. It is independent of the OpenMuse Docker computer and does not deploy E2B or Cloudflare Sandbox containers.

- Multiple saved conversations and follow-up questions, persisted in an Agent's SQLite storage.
- A browser reused across turns, navigation/search/input tools, and Cloudflare Live View links.
- Price cards retain the exact observed text, currency, source URL and observation time. Recording rejects a product name, amount or source absent from the latest page read. This is an evidence check, not a guarantee that two occurrences on a page refer to the same offer.
- Stop/close controls, a five-minute turn limit, a ten-step agent loop capped at sixteen tool actions, a two-minute browser idle timeout and a twenty-minute scheduled close. Browser expiry loses cookies/tabs; chat history remains.
- A clearly labelled, fictitious product catalogue at `/demo-catalog` for reproducible browser tests. The UI also offers a real-web search prompt. CAPTCHA/login/access restrictions are reported rather than bypassed.

## Setup

Node.js 22 or newer and a Cloudflare account with Workers, SQLite Durable Objects and Browser Run access are required. The model is an external DeepSeek API call; Workers AI is not used.

```sh
cd examples/cloudflare-price-agent
npm ci
npm run types
npm run check
npm test
npm run build
```

`wrangler types` generates ignored `worker-configuration.d.ts`. For local development, create ignored `.dev.vars` with `DEEPSEEK_API_KEY` and a random `DEMO_ACCESS_TOKEN` of at least 32 characters, then run `npm run dev`. Local Browser Run is not a substitute for verification on the deployed binding.

## Deploy and open

Select the intended account with Wrangler authentication and `CLOUDFLARE_ACCOUNT_ID`. Set secrets through the interactive prompts; do not place them in source or command arguments:

```sh
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put DEMO_ACCESS_TOKEN
npm run deploy
```

Open the deployed `workers.dev` URL and enter the demo access token. The token is held in tab-scoped session storage; the model API key remains server-side. This capability grants access to the owner's entire demo, not separate tenant accounts. Changing it selects a new owner namespace. There is no public `/agents/*` routing.

Alternatively, keep the token out of the frontend using the loopback proxy. Create `~/.config/openmuse-cloudflare-demo/settings.json` outside Git, with file mode `0600`:

```json
{
  "url": "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",
  "accessToken": "YOUR-RANDOM-DEMO-TOKEN-AT-LEAST-32-CHARACTERS"
}
```

Run `npm run local` and open `http://127.0.0.1:8791`. `OPENMUSE_CF_SETTINGS` can select another settings file. `OPENMUSE_CF_PORT` changes the local port. The proxy only accepts loopback Host/Origin values, forwards to the configured Worker and adds demo authorization server-side. It respects `https_proxy` for outbound access. It does not execute the model or host a local browser.

## Boundaries

This is a private demo, not a multitenant service. Navigation rejects IP literals, local/internal hostnames, nonstandard ports and embedded credentials, including browser subrequests. This hostname policy is not DNS pinning or a replacement for Cloudflare's network isolation. No browser receives the DeepSeek key or the Cloudflare account token. Live View URLs are temporary bearer credentials: fetched only after authentication, never included in model messages, persisted or logged.

Live View embeds when the browser permits it; the same panel always provides a separate authenticated viewing link. Screenshots are captured after agent actions, not a substitute for the live stream. Opening a Live View can keep a browser active and billable; close it when finished. Actual target websites, billing/account limits, browser interruptions and price extraction must be verified on the deployed service. Placement is Cloudflare-managed and this demo does not guarantee Tokyo residency.

The root project's server/mobile/browser worker dependencies are unchanged. This example has its own npm lockfile and CI check; it does not deploy from CI.

## Verified on a deployed Worker

The following acceptance checks ran against the actual Cloudflare deployment on 2026-10-19, using `deepseek-flash`:

- A first turn remembered a JPY 10,000 budget without launching a browser. A second turn entered “耳机” into the demo catalogue search, clicked search, visited two detail pages, and recorded JPY 6,500 and JPY 9,800. A third turn reused the same browser session and correctly answered that JPY 200 remained. These are fictitious demonstration prices.
- Retrying the original request ID returned the saved answer with `replay: true`.
- A real-web turn invoked Bing search, received no useful search results, then read Cloudflare's official Browser Run pricing page and recorded two exact page quotations with source URLs. Search availability remains dependent on the search engine and network; the agent reported this limitation.
- An authenticated Live View request returned a temporary `live.browser.run` URL. Its frontend responded HTTP 200 with `frame-ancestors *`. This verifies URL issuance and embed headers; interactive streaming and the complete chat UI have not received a manual browser acceptance pass.
- Stopping an active cloud turn after its browser launched returned a cancelled turn and left both the running task and browser state empty. Explicit browser close also retained the conversation's two recorded prices.
- Eleven core tests, TypeScript checks, a deployment dry run and thirteen local HTTP checks passed. The local HTTP checks covered authentication, SQLite conversation persistence and malformed/cross-origin requests. The main OpenMuse application test suite was not run for this isolated example.

![Cloudflare browser screenshot captured after the agent opened a fictional product detail page](docs/browser-demo.jpg)

The screenshot above is from the actual remote browser, not a screenshot of the chat interface. No account identifiers, access credentials or signed Live View URLs are included in this example.
