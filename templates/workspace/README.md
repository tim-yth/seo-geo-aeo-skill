# SEO agent workspace

Per-site working directory used by the `seo-geo-aeo` scripts. Created by `scripts/init.mjs`.
Everything here is plain files, so history accumulates and later runs can diff against earlier ones.

```
.seo-agent/
  config.json            non-secret settings (see config.example.json for every field, with comments)
  config.example.json    annotated reference; not read by the scripts
  secrets/               gitignored, chmod 700; files chmod 600 (service-account JSON, IndexNow key)
  .gitignore             ignores secrets/ and data/raw/
  data/<source>/         <YYYY-MM-DD>-<name>.{json,csv,jsonl,md} outputs per source:
    gsc/                 Search Console exports, comparisons, guardrail, query clusters
    gsc/ai-features/     generative-AI performance report imports (drop raw UI exports in inbox/)
    bing/                Bing Webmaster exports (traffic, queries, pages, crawl, links, keywords)
    bing/ai-performance/ Bing AI Performance imports (drop raw exports in inbox/)
    ga4/ crawl/ content/ competitors/ serp/ pagespeed/ indexing/ instrumentation/
    geo/                 AI-answer tracking runs (answers, summaries, manual checklists)
    backlinks/ bots/ images/ migration/ diff/ experiments/
    events/              Google Search Status Dashboard incidents fetched by search-events.mjs refresh
    content/             content audit outputs and the audit working files below
      title-changes.csv  ONE title ledger for every title change (slug, old, new, who, round)
      leftovers.tsv      open issues that are out of scope for the current round (cross-round)
      generators.md      generator risk register: scripts that can overwrite pages, and how to stop them
      cta-map.md         the single CTA routing table used by writers, fixers and generators
      facts.md           fact sheet (prices, limits, names) that copy must match
      <date>-audit/pre_review/  originals saved before a reviewer edits a page directly
  logs/changes.md        append-only change log: one entry per deployed change wave
  logs/experiments.json  machine-readable waves (dates, URLs, hypothesis, metric, acceptance checkpoints, reviews),
                         external events and split tests
  logs/spend.csv         metered API calls and estimated cost per provider (geo-track and other paid calls)
  logs/reviews/          markdown review reports (comparisons, opportunities, plans, audits)
  keyword-map.csv        keyword -> intent, cluster, target URL, current ranking URL, metrics, status, notes,
                         synonyms (optional, "|"-separated other spellings; internal-links.mjs uses them as anchors)
  geo-prompts.csv        AI-answer visibility log, one row per engine x prompt x locale x run date x repetition:
                         run_date, engine, locale, intent, prompt, mentioned, rank, cited_url, reason, accuracy,
                         pricing_claim, competitors, action_needed, notes (manual minimum) + prompt_id,
                         portfolio_version, cohort, arm, variant_group, branded, topic, country, method, k, searched,
                         retrieved, cited, recommended, cited_domains (sampling, controls and the citation funnel)
  content-inventory.csv  one row per page: machine columns (title, grade, x_flags, 28-day metrics, index/HTTP status,
                         template_ratio, audited_at) and manual columns (slug, page_type, intent_key, action, target_url,
                         cluster_id, wave, notes, review_grade, review_x, review_action, review_target, value_tier, protected)
  outreach-tracking.csv  optional: link-building tracking table (see templates/outreach-emails.md); backlinks.mjs verify
                         fills link_checked_on and link_status
```

Conventions

- Secrets are never stored in `config.json`. Credentials are referenced by file path (inside `secrets/`)
  or by environment variable name (`apiKeyEnv`, `providers.<name>.apiKeyEnv`).
- Search Console dates are Pacific Time days. Deploy and acceptance dates use `site.timezone`.
- `keyword-map.csv` and `content-inventory.csv` mix machine columns (refreshed by scripts) and manual
  columns. Scripts only fill manual columns when they are empty, never delete columns, and never overwrite your
  edits; columns you add yourself are never touched. Human review verdicts go in `review_*`, not in `grade`.
- `protected=true` in content-inventory.csv (and `config.protect`) marks pages people fixed by hand: generators must
  not overwrite them, and `seo-diff.mjs` blocks a deploy that changes them.
- Log every deployed change with `log-change.mjs` before measuring it, and review it with
  `review-due.mjs` + `gsc-compare.mjs` on the acceptance dates (D+7, D+14, D+28). Log things outside your control
  (a viral mention, an outage, a competitor launch) as `--type external-event`; Google updates and Search Console
  data anomalies are already known to the scripts (`search-events.mjs list`).
