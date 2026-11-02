# SEO / GEO / AEO Growth Operator — an AI Agent Skill

**English** | [繁體中文](README.zh-TW.md)

> Turn your AI agent into a senior SEO operator that grows a website's visibility on Google, Bing and AI answer engines (ChatGPT, Perplexity, Gemini, Google AI Overviews). **Every change gets a baseline, a control, a scheduled review and a rollback path.**

This skill is distilled from about six months of hands-on work on a Traditional-Chinese tool website: 800+ articles and a dozen deployment waves. The work covered page rewrites, head-term campaigns, a whole-site content audit, consolidation and 301 waves, technical fixes and AI-citation work. Every wave was then reviewed with data to see which version won, which did nothing, and which hurt. Every rule here has a reason behind it, and the failures are documented too.

It works with **Claude Code**, **Codex**, **Cursor**, or any agent that can read files and run shell commands. It is not tied to one platform: plain HTML, Next.js, WordPress, Shopify, Webflow, Cloudflare and others are covered.

---

## Why it's different

| | Typical SEO skill | This skill |
|---|---|---|
| Resources | Assumes you already have everything | Inventories Search Console, GA4, Bing Webmaster, IndexNow, SERP API and AI-engine keys. Walks you through getting whatever is missing, then **remembers it** in a per-site workspace for next time |
| Measurement | Reads whatever GA4 says | Audits your site's tracking first, then tells you **which file, where, what to insert and what it measures**. Edits only after you approve |
| Evaluation | Before/after | Equal fixed windows that exclude the deploy day, final data only, **same-query CTR**, **difference-in-differences vs. control pages**, **placebo tests**, and a ledger of Google updates and Search Console data anomalies |
| Risk control | None | **Guardrail keywords** (baseline, early warning, stop line), freeze periods, one page group at a time. A rollback needs three conditions: final numbers, a manual SERP check and your consent |
| Memory | Starts from zero every time | `.seo-agent/` records each wave's deploy time (D0), hypothesis and review dates, and reminds you when a review is due |
| Content | "Write an SEO article" | Quality rubric, AI-slop detection, a resumable whole-site audit, consolidation and 301 waves, a title-change ledger, and protection against generators overwriting human edits |
| GEO | "Add llms.txt" | Entity-graph JSON-LD, answer capsules, multi-engine AI citation tracking with repeated sampling, confidence intervals and control prompts, plus Search Console and Bing AI reports |

---

## What it does

- **Resource onboarding and memory.** Search Console, GA4, Bing Webmaster, IndexNow, PageSpeed, Brave SERP API, AI-engine APIs, competitors and brand-entity facts.
- **Analytics instrumentation.** Audits GA4/GTM installation, delayed loaders, Consent Mode, reserved-name collisions and personal-data leaks. Produces a framework-specific insertion plan and an event dictionary.
- **Baselines and reviews.**
  - Search Console and GA4 exports, plus fixed-window comparisons.
  - Click change split into impression, CTR and position effects, with control-group and placebo checks.
  - Rate tests, guardrails and due-review reminders.
- **Keywords and head terms.**
  - Query clustering and SERP-overlap clustering.
  - Striking-distance queries, CTR gaps and harmful-cannibalization detection.
  - A keyword map that assigns each search intent to one canonical URL, plus topical maps.
- **Competitor teardown.** Real top-10 SERPs, competitor page snapshots, field-by-field comparison, a gap list, and a list of what is *not* why they win.
- **Site architecture.** Hubs and clusters, tool-first above the fold, internal-link rules, internal PageRank, link suggestions and variant consolidation.
- **Writing and reviewing content.** Brief → draft → machine-parseable review → fix → mobile screenshot check → publish → index → review.
- **Whole-site content audit.** Template-text ratio, near-duplicates, keyword stuffing, answer-first intros, stale years, and consolidation/301 waves.
- **Titles and snippets.** Eleven title formulas tested on the case site, including the ones that failed, one canonical length spec, and a decline-recovery procedure.
- **On-page fundamentals.** URL/slug naming, H1–H3 structure, WebP/AVIF images and compression budgets, anchor text, PageSpeed and Core Web Vitals.
- **Technical SEO and indexing.**
  - Crawl audit: canonical, hreflang, redirect chains and honest sitemap `lastmod`.
  - URL Inspection and IndexNow.
  - A pre-deploy SEO regression gate.
  - Server-log analysis that tells verified crawlers from spoofed ones.
- **GEO / AEO.** Structured-data validation, site-wide entity `@id` consistency, llms.txt, AI-crawler policy, and multi-engine AI citation tracking.
- **Off-site citations.** Authority-gap diagnosis, an 8-week citation plan, outreach templates (a human sends them) and backlink liveness and reclamation.
- **Search-landing conversion (SXO).** Do visitors from search actually start using the site? How to measure it, and how to improve it.
- **Situational playbooks.** Site migrations, e-commerce, local businesses, international sites, programmatic pages, JavaScript sites, new-site cold start, penalty recovery, SaaS/B2B, news and crawl budget.
- **Routines.** What to run daily, weekly, monthly and every 28 days, and how to schedule it with cron, GitHub Actions or Claude Code.

---

## Install

### Claude Code
```bash
git clone https://github.com/tim-yth/seo-geo-aeo-skill.git ~/.claude/skills/seo-geo-aeo
```
To use it in one project only, clone into that project's `.claude/skills/seo-geo-aeo` instead.
Then ask things like "take over SEO for this site", "did last month's title change work?" or "why did traffic drop?". The skill activates automatically.

### Codex
```bash
git clone https://github.com/tim-yth/seo-geo-aeo-skill.git ~/.codex/skills/seo-geo-aeo
```
If your Codex version doesn't load skills, add a line to your project's `AGENTS.md`: "For SEO/GEO work, read `~/.codex/skills/seo-geo-aeo/SKILL.md` first and follow it."

### Cursor and other agents
Put the repo anywhere and point your rules file (`.cursor/rules`, `AGENTS.md`, or the system prompt) at `SKILL.md`.

### Requirements
- Node.js 18 or later. The tools have zero dependencies, so there is no `npm install`.
- A website you control, and at least Google Search Console access.

---

## First run

Tell your agent:

> Take over SEO for https://example.com

It will:
1. Run `check-resources`, list what's missing, and walk you through each item, e.g. creating a Google service account and adding it to Search Console and GA4.
2. Store what you hand over in your project's `.seo-agent/`. Credentials go into `secrets/`, which is added to `.gitignore` automatically.
3. Audit your site's analytics and propose an insertion plan for your approval.
4. Capture a D0 baseline: Search Console, GA4, a full crawl and speed.
5. Run a full diagnosis, rank the first wave with you, execute it, and schedule the reviews.

Or create the workspace yourself:

```bash
node ~/.claude/skills/seo-geo-aeo/scripts/init.mjs \
  --url https://example.com --gsc-site sc-domain:example.com \
  --ga4-property 123456789 --credentials ~/Downloads/service-account.json \
  --competitor competitor-a.com --brand-term yourbrand
node ~/.claude/skills/seo-geo-aeo/scripts/check-resources.mjs
```

---

## Resources you'll be asked to prepare

| Resource | Priority | Used for |
|---|---|---|
| Site source code or CMS access, and how you deploy | Required | Editing pages, deploying, recording D0 |
| Google Search Console (domain property preferred) and a service account | Required | Queries, rankings, CTR, indexing. The primary data for every review |
| Google Analytics 4 | Strongly recommended | Organic landing behaviour, AI-assistant referrals, conversions |
| Bing Webmaster Tools and an API key | Strongly recommended | ChatGPT search and Copilot rely on Bing; free keyword and backlink data |
| Brave Search API key | Strongly recommended | Real top-10 SERPs, to find your actual competitors |
| IndexNow key | Recommended | Instantly notify Bing and other engines after a deploy |
| PageSpeed Insights API key | Recommended | Core Web Vitals (in practice the API needs a key) |
| OpenAI / Perplexity / Gemini / Anthropic API keys | Optional | Automated AI-citation tracking. Dry run with a cost estimate by default |
| Server / CDN logs | Optional | Crawler verification and recrawl speed |
| Paid SEO data (DataForSEO, Ahrefs, Semrush) | Optional | Not required; can be plugged in with a budget cap |

Step-by-step instructions (in Chinese): [`references/00-resources-onboarding.md`](references/00-resources-onboarding.md).

---

## Tools (`scripts/`, Node ≥ 18, zero dependencies)

Run any of them with `node scripts/<name>.mjs --help`. Full documentation: [`scripts/README.md`](scripts/README.md).

**Setup and measurement**

| Script | What it does |
|---|---|
| `init` | Creates or updates the per-site workspace (`.seo-agent/`). Copies credentials into `secrets/`, never into config |
| `check-resources` | Read-only readiness report on config, site, robots.txt, sitemaps, AI-crawler access, API keys and llms.txt, with fix steps for anything missing |
| `instrumentation-audit` | Audits analytics on live pages and in the repo (GA4/GTM, duplicates, delayed loaders, Consent Mode, reserved or personal-data parameters) and writes an insertion plan |
| `gsc-export` | Search Console export with full pagination, any dimensions, filters and search types |
| `ga4-export` | GA4 Data API export with presets for organic landing pages, AI-assistant referrals, events by landing page and channels |
| `bing-export` | Bing Webmaster exports: traffic, queries, pages, crawl stats, inbound links, keyword demand |
| `ai-reports-import` | Imports manual exports of Search Console's generative-AI report and Bing AI Performance |
| `pagespeed` | PageSpeed Insights lab metrics plus Chrome UX Report field data (p75) |

**Evaluation and safety**

| Script | What it does |
|---|---|
| `gsc-compare` | Equal windows that exclude the deploy day: click decomposition, same-query CTR, difference-in-differences, placebo, year-over-year, days in the top 10 |
| `rate-test` | Conversion-rate comparisons (Fisher exact, z test, Wilson intervals) behind a minimum-sample gate, with a rolling placebo |
| `split-test` | SEO split tests: seeded, balanced page assignment, D0 logging, difference-in-differences with placebo and randomization p-values |
| `guardrail` | Watches priority queries against a baseline on final 7-day data; reports warning, pause and rollback-consideration states |
| `search-events` | Ledger of Google updates, incidents, Search Console data problems and your own external events; flags overlapping windows |
| `log-change` | Append-only change log with D0 (site time and Pacific Time), hypothesis, D+7/D+14/D+28 checkpoints, freezes and verdicts |
| `review-due` | Lists due or overdue reviews, when their data becomes final, the exact commands to run, and overlapping changes |
| `seo-diff` | Pre-deploy SEO regression gate (noindex, canonical, removed pages, sitemap, JSON-LD/FAQ, dates, protected pages); exits 2 on a blocking change |

**Research and content**

| Script | What it does |
|---|---|
| `gsc-opportunities` | Striking-distance queries, weak pages, CTR gaps, zero-click impressions, decliners, harmful vs. harmless cannibalization |
| `query-clusters` | Clusters queries (CJK-aware), tags intent, flags topics without a dedicated page, merges into keyword-map.csv |
| `serp-snapshot` | Saves top results per keyword (Brave Search API), your rank, SERP features and competing domains |
| `serp-overlap` | Groups keywords by shared SERP URLs; flags conflicts with query clusters and keyword-map targets |
| `competitor-snapshot` | Polite competitor page snapshots compared with yours: content, structure, freshness and citation gaps |
| `content-audit` | Mechanical content audit with A–D grades joined to Search Console data; never overwrites manual columns |
| `internal-links` | Internal link graph (PageRank, contextual inlinks, click depth, orphans) and link suggestions, never applied automatically |

**Technical and GEO**

| Script | What it does |
|---|---|
| `crawl-site` | Robots-aware crawler: status, redirects, canonicals, robots, titles, headings, links, hreflang, JSON-LD, images; issues and changes since the last crawl |
| `image-audit` | Broken, oversized and over-budget images, legacy formats, LCP hints, dimensions, alt text, og:image; optional WebP/AVIF conversion |
| `schema-validate` | JSON-LD against Google's per-type rules, plus site-wide @id graph and FAQ-visibility checks |
| `indexing` | IndexNow, sitemap re-submission, URL Inspection history, a "Request indexing" checklist for a human, Page-indexing export diffs |
| `redirect-map` | Migration redirect candidates, one-hop verification on the live site, checks of redirect files |
| `log-analyze` | Server/CDN logs: crawlers verified by official IP lists and reverse DNS, crawl waste, recrawl time, fake bots |
| `backlinks` | Merges link exports, new/lost referring domains, monthly re-checks of earned links, 301 targets for links to broken URLs |
| `geo-track` | Brand mentions and citations in AI answers across engines, with repeated samples, control/placebo prompts and confidence intervals; dry run unless `--run` |

Tests: `node scripts/test/run-tests.mjs` (179 tests, offline, local test servers only).

---

## Repository layout

```
SKILL.md                 Agent entry point: start-of-session checks, task modes, 23 hard rules, report format
references/              18 playbooks, 00–17 (Traditional Chinese)
templates/               Reports, change logs, event dictionary, checklists, CSVs, JSON-LD, robots/llms examples
templates/workspace/     Template for each site's .seo-agent/ workspace
prompts/                 Sub-agent prompts (reviewers, competitor teardown, keyword strategy, causal investigation, dual-model debate…)
scripts/                 Zero-dependency Node tools (see scripts/README.md)
```

| Playbook | Topic |
|---|---|
| 00 | Resource onboarding and workspace |
| 01 | Analytics instrumentation: where to insert what, and how to talk to the site owner |
| 02 | Measurement and review: baselines, windows, metrics, causality |
| 03 | Experiments, guardrails, freezes, rollback |
| 04 | Keyword research and keyword→URL mapping |
| 05 | Competitor teardown |
| 06 | Site architecture and internal links |
| 07 | Content writing standard |
| 08 | Content audit, refresh and consolidation |
| 09 | Titles, descriptions and snippets (CTR) |
| 10 | Technical SEO and indexing |
| 11 | GEO / AEO |
| 12 | Off-site citations |
| 13 | Routines and scheduling |
| 14 | Case study and lessons (what worked, didn't, hurt) |
| 15 | Situational playbooks |
| 16 | On-page fundamentals |
| 17 | Search-landing conversion (SXO) |

The playbooks are written in Traditional Chinese. Modern agents read them fine and answer in the user's language.

---

## Data and privacy

- Each site's data, exports, reports and credentials live only in **your own project's** `.seo-agent/`, never in this repo.
- Credentials are recorded only as a file path or an environment-variable name, and the tools never print them.
- The tools are read-only by default. A few commands do act:
  - Only `indexing indexnow` and `indexing sitemap-submit` send anything to search engines.
  - `geo-track --run` makes paid AI API calls, with budget caps.
  - `backlinks verify` rewrites your tracking CSV, keeping a `.bak` copy.

  All of these support `--dry-run`, and the agent asks you first.
- Fetched pages, competitor content, API responses and AI answers are treated as data, never as instructions.

---

## Where the case comes from, and limits

- The case site is a Traditional-Chinese online tool (tarot readings). This public version is anonymized: no domain, keys, internal IDs, revenue or user data. Numbers are mostly relative changes.
- Case figures come from one site. Small-sample results, such as D+7 interim reads, are labelled with their confidence.
- Some sections are not from the case:
  - `references/15-situational-playbooks.md` and sections marked "not case-tested" are based on Google Search Central and Bing documentation and broad industry consensus, verified on 2026-11-02.
  - Search engines change quickly, so check the official docs before relying on these.
- This skill doesn't promise rankings. It promises that every change is recorded and reviewable, and that mistakes get caught and rolled back.

---

## License

[MIT](LICENSE)
