# SEO／GEO／AEO 成長操盤手 · AI Skill

[English](README.md) | **繁體中文**

> 讓 AI agent 像資深 SEO 操盤手一樣，長期經營你的網站在 Google、Bing，以及 ChatGPT、Perplexity、Gemini、Google AI 摘要（AI Overviews）上的曝光。**每一次改動都有基準、有對照、有驗收、能回退。**

這個 skill 來自一個繁體中文工具型網站約半年的實戰紀錄：800 多篇內容、十多波改動。做過的事包括改頁面、搶大字、全站逐篇審稿、合併轉址、技術修正、AI 引用優化。每一波事後都用數據驗收，分清楚哪一代最好、哪一代其實沒效、哪一代有害。所有規則都有來由，失敗也一併寫進去。

可搭配 **Claude Code**、**Codex**、**Cursor**，或任何能讀檔、跑指令的 AI agent 使用。不限網站平台：純 HTML、Next.js、WordPress、Shopify、Webflow、Cloudflare 等都有對應做法。

---

## 跟一般 SEO skill 有什麼不同

| | 一般 SEO skill | 這個 skill |
|---|---|---|
| 資源 | 假設你什麼都有 | 第一次使用先盤點 GSC、GA4、Bing Webmaster、IndexNow、SERP API、AI 引擎金鑰。缺什麼就一步一步帶你申請，交給它就**記在工作區**，下次直接沿用 |
| 量測 | 直接看 GA4 | 先稽核網站埋點，告訴你**在哪個檔案、哪個位置插入什麼、量什麼**，你同意後才改 |
| 驗收 | 前後比 | 固定等長窗、排除部署日、只用定稿資料、**同查詢 CTR**、**對照組差異（DiD）**、**安慰劑檢驗**，並比對 Google 更新與 GSC 資料異常的事件帳本 |
| 風險控制 | 無 | **護欄關鍵字**（基準、預警、停止線）、凍結期、一次只動一個頁群。回退要三個條件同時成立：定稿數字、人工看過 SERP、你同意 |
| 記憶 | 每次從零開始 | `.seo-agent/` 記錄每一波改動的部署時間（D0）、假設與驗收日，到期自動提醒 |
| 內容 | 「寫一篇 SEO 文章」 | 好文章評分標準、AI 垃圾文偵測、可中斷續跑的全站逐篇審稿、合併與 301 波次、標題帳本、防止產生器覆蓋人工內容 |
| GEO | 加一個 llms.txt | 實體圖譜 JSON-LD、答案膠囊、多引擎 AI 引用追蹤（重複取樣、信賴區間、對照題），以及 GSC 與 Bing 的 AI 報表 |

---

## 它會做什麼

- **資源盤點與記憶**：GSC、GA4、Bing Webmaster、IndexNow、PageSpeed、Brave SERP API、AI 引擎 API、競品、品牌實體資料。
- **網站量測埋點**：稽核 GA4／GTM 安裝、延遲載入、同意模式、參數撞到保留名稱、個資外洩；依網站框架給出插入計畫與事件字典。
- **基準與驗收**：
  - GSC、GA4 匯出與固定窗比較。
  - 把點擊變化拆成曝光、CTR、排名三部分，並做對照組與安慰劑檢驗。
  - 比率檢定、護欄監測、到期驗收提醒。
- **關鍵字與搶字**：
  - GSC 查詢分群，並用 SERP 重疊驗證分群。
  - 找出近排名機會、CTR 落差、有害的互搶。
  - 建立「一個意圖只對一個主網址」的關鍵字對照表與主題地圖。
- **競品逆向**：抓真實 SERP 前 10 名、爬競品頁面、逐欄對照、差距清單、「不是勝因」清單。
- **網站架構**：hub 與子頁群、工具放第一屏、內鏈規則與內部 PageRank、內鏈建議、變體整併。
- **寫文章與審稿**：brief → 初稿 → 可機器解析的審稿判定 → 修正 → 手機版截圖檢查 → 上線 → 索引 → 驗收。
- **全站內容稽核**：模板句比例、近重複、關鍵字堆砌、答案先行、過期年份；合併與 301 波次。
- **標題與摘要**：11 種在案例站實測過的 title 公式（含失敗的）、唯一一套長度規範、下滑復原流程。
- **頁面基本功**：網址與 slug 命名、H1–H3、圖片 WebP／AVIF 與壓縮目標、錨文字、PageSpeed 與 Core Web Vitals。
- **技術 SEO 與索引**：
  - 爬站稽核：canonical、hreflang、轉址鏈、誠實的 sitemap `lastmod`。
  - URL Inspection、IndexNow。
  - 部署前 SEO 回歸檢查。
  - 伺服器日誌分析，分辨真假爬蟲。
- **GEO／AEO**：結構化資料驗證、全站實體 `@id` 一致性、llms.txt、AI 爬蟲政策、多引擎 AI 引用追蹤。
- **站外引用**：權威差距診斷、8 週外部引用計畫、外聯信範本（由真人寄出）、外鏈存活檢查與失效回收。
- **搜尋落地轉換（SXO）**：搜尋進來的人有沒有開始使用、怎麼量、怎麼改。
- **情境手冊**：網站搬家、電商、在地商家、多語系、程式化大量頁面、JS 網站、新站冷啟動、懲罰復原、SaaS／B2B、新聞媒體、爬取預算。
- **例行節奏**：每日、每週、每月、每 28 天要跑什麼，以及怎麼用 cron、GitHub Actions 或 Claude Code 排程。

---

## 安裝

### Claude Code
```bash
git clone https://github.com/tim-yth/seo-geo-aeo-skill.git ~/.claude/skills/seo-geo-aeo
```
只想在單一專案使用的話，改成 clone 到該專案的 `.claude/skills/seo-geo-aeo`。
之後直接說「幫我接手這個網站的 SEO」「上個月改標題有沒有效」「流量為什麼掉了」，skill 就會自動啟用。

### Codex
```bash
git clone https://github.com/tim-yth/seo-geo-aeo-skill.git ~/.codex/skills/seo-geo-aeo
```
如果你的 Codex 版本不會載入 skills，在專案的 `AGENTS.md` 加一行：「做 SEO／GEO 工作時，先讀 `~/.codex/skills/seo-geo-aeo/SKILL.md` 並照做。」

### Cursor 與其他 agent
把 repo 放在任何位置，在規則檔（`.cursor/rules`、`AGENTS.md` 或系統提示）指向 `SKILL.md`。

### 需求
- Node.js 18 以上。工具不依賴任何套件，不用 `npm install`。
- 一個你有管理權的網站，至少要有 Google Search Console 的存取權。

---

## 第一次使用

對 agent 說：

> 幫我接手 https://example.com 的 SEO

它會：
1. 跑 `check-resources` 列出還缺哪些資源，一步一步帶你準備，例如建立 Google 服務帳戶、把它加進 GSC 與 GA4。
2. 把你交給它的資源記進網站專案的 `.seo-agent/`。金鑰放在 `secrets/`，並自動加入 `.gitignore`。
3. 稽核網站量測，給你一份「在哪裡插入什麼」的計畫，等你確認。
4. 建立 D0 基準：GSC、GA4、全站爬取、速度。
5. 做全面診斷，和你排出第一波優先順序，執行後記下驗收日。

也可以自己先建工作區：

```bash
node ~/.claude/skills/seo-geo-aeo/scripts/init.mjs \
  --url https://example.com --gsc-site sc-domain:example.com \
  --ga4-property 123456789 --credentials ~/Downloads/service-account.json \
  --competitor competitor-a.com --brand-term 你的品牌
node ~/.claude/skills/seo-geo-aeo/scripts/check-resources.mjs
```

---

## 需要準備的資源

| 資源 | 必要性 | 用途 |
|---|---|---|
| 網站原始碼或後台存取、部署方式 | 必要 | 改頁面、上線、記錄 D0 |
| Google Search Console（建議用網域資源）＋服務帳戶 | 必要 | 查詢、排名、CTR、索引；所有驗收的主資料 |
| Google Analytics 4 | 強烈建議 | 自然流量落地後的行為、AI 來源流量、轉換 |
| Bing Webmaster Tools＋API key | 強烈建議 | ChatGPT 搜尋與 Copilot 依賴 Bing；免費的關鍵字與外鏈資料 |
| Brave Search API key | 強烈建議 | 抓真實 SERP 前 10 名，找出真正的競品 |
| IndexNow 金鑰 | 建議 | 改版後立即通知 Bing 等搜尋引擎 |
| PageSpeed Insights API key | 建議 | Core Web Vitals（實務上 API 需要 key） |
| OpenAI／Perplexity／Gemini／Anthropic API key | 選用 | 自動追蹤 AI 引用；預設只試算呼叫次數與費用，不實際花錢 |
| 伺服器／CDN 日誌 | 選用 | 驗證爬蟲真偽、重抓速度 |
| 付費 SEO 資料（DataForSEO、Ahrefs、Semrush） | 選用 | 不是必要；有的話可以接入，並設預算上限 |

完整取得步驟見 [`references/00-resources-onboarding.md`](references/00-resources-onboarding.md)。

---

## 工具（`scripts/`，Node ≥ 18，零相依）

每支都可用 `node scripts/<名稱>.mjs --help` 查看用法。完整說明見 [`scripts/README.md`](scripts/README.md)（英文）。

**設定與量測**

| 工具 | 做什麼 |
|---|---|
| `init` | 建立或更新網站工作區 `.seo-agent/`；金鑰複製進 `secrets/`，不寫進設定檔 |
| `check-resources` | 只讀檢查設定、網站、robots.txt、sitemap、AI 爬蟲存取、各金鑰、llms.txt，缺的附補齊步驟 |
| `instrumentation-audit` | 稽核線上頁面與原始碼的分析埋點（GA4／GTM、重複安裝、延遲載入、同意模式、保留名稱或個資參數），產出插入計畫 |
| `gsc-export` | GSC 匯出，完整分頁，任意維度、篩選與搜尋類型 |
| `ga4-export` | GA4 Data API 匯出，內建自然落地頁、AI 助理來源、依落地頁的事件、管道等預設 |
| `bing-export` | Bing Webmaster 匯出：流量、查詢、頁面、爬取統計、反向連結、關鍵字需求 |
| `ai-reports-import` | 匯入手動下載的 GSC 生成式 AI 報表與 Bing AI Performance |
| `pagespeed` | PageSpeed Insights 實驗室數據，加上 Chrome 使用者體驗報告的實際數據（p75） |

**驗收與安全**

| 工具 | 做什麼 |
|---|---|
| `gsc-compare` | 排除部署日的等長窗比較：點擊拆解、同查詢 CTR、對照組差異、安慰劑、年同比、前 10 名天數 |
| `rate-test` | 轉換率比較（Fisher 精確檢定、z 檢定、Wilson 區間），樣本不足不下結論，附滾動安慰劑 |
| `split-test` | SEO 分組測試：可重現的平衡分組、記錄 D0、對照組差異加安慰劑與隨機化 p 值 |
| `guardrail` | 用定稿 7 天資料監看護欄關鍵字，回報預警、暫停、考慮回退三種狀態 |
| `search-events` | Google 更新、事故、GSC 資料問題與你自己的外部事件帳本；標出碰到哪些比較窗 |
| `log-change` | 只增不改的改動紀錄：D0（網站時區與太平洋時間）、假設、D+7／D+14／D+28 檢查點、凍結、判定 |
| `review-due` | 列出到期或逾期的驗收、資料何時定稿、該跑的指令、重疊的改動 |
| `seo-diff` | 部署前 SEO 回歸檢查（noindex、canonical、移除的頁、sitemap、JSON-LD／FAQ、日期、受保護頁），有阻擋項時以代碼 2 結束 |

**研究與內容**

| 工具 | 做什麼 |
|---|---|
| `gsc-opportunities` | 近排名查詢、弱頁、CTR 落差、高曝光零點擊、下滑頁、有害與無害的互搶 |
| `query-clusters` | 查詢分群（支援中日韓文），標意圖、找出缺專頁的主題，合併進 keyword-map.csv |
| `serp-snapshot` | 用 Brave Search API 存下每個關鍵字的前幾名、你的名次、SERP 版面元素與競爭網域 |
| `serp-overlap` | 依 SERP 共同網址替關鍵字分群，標出和查詢分群、關鍵字對照表衝突的地方 |
| `competitor-snapshot` | 禮貌地抓取競品頁面並與你的頁面並排比較：內容、結構、新鮮度、引用缺口 |
| `content-audit` | 機械式內容稽核，A–D 評等並接上 GSC 數據；不覆寫人工欄位 |
| `internal-links` | 內鏈圖（內部 PageRank、正文入鏈、點擊深度、孤兒頁）與內鏈建議，不會自動套用 |

**技術與 GEO**

| 工具 | 做什麼 |
|---|---|
| `crawl-site` | 遵守 robots 的爬蟲：狀態碼、轉址、canonical、robots、標題、H 標籤、連結、hreflang、JSON-LD、圖片；列出問題與上次以來的變化 |
| `image-audit` | 壞圖、過大、超出預算、舊格式、LCP 提示、尺寸、alt、og:image；可選擇批次轉 WebP／AVIF |
| `schema-validate` | 依 Google 各類型規則驗證 JSON-LD，並檢查全站 @id 圖與 FAQ 是否出現在畫面上 |
| `indexing` | IndexNow、重新提交 sitemap、URL Inspection 紀錄、給真人按「要求建立索引」的清單、索引報表差異 |
| `redirect-map` | 搬站轉址配對、正式站一跳驗證、轉址設定檔檢查 |
| `log-analyze` | 伺服器／CDN 日誌：用官方 IP 清單與反查 DNS 驗證爬蟲、爬取浪費、重抓時間、冒名爬蟲 |
| `backlinks` | 合併外鏈匯出、新增與流失的參照網域、每月複查已取得的連結、失效網址外鏈的 301 建議 |
| `geo-track` | 追蹤各 AI 引擎回答中的品牌提及與引用：重複取樣、對照與安慰劑題、信賴區間；不加 `--run` 只試算 |

測試：`node scripts/test/run-tests.mjs`（179 項，離線，只用本機測試伺服器）。

---

## 目錄

```
SKILL.md                 agent 的入口：開工檢查、任務模式、23 條鐵則、報告格式
references/              00–17 共 18 份操作手冊（繁中）
templates/               報告、改動紀錄、事件字典、檢查清單、CSV、JSON-LD、robots／llms 範本
templates/workspace/     每個網站 .seo-agent/ 工作區的樣板
prompts/                 給子代理的提示詞（審稿、競品、關鍵字、因果調查、雙模型辯證…）
scripts/                 零相依 Node 工具（說明見 scripts/README.md）
```

| 手冊 | 主題 |
|---|---|
| 00 | 資源盤點與工作區 |
| 01 | 網站量測埋點：在哪裡插什麼、怎麼跟網站主溝通 |
| 02 | 量測與驗收：基準、比較窗、指標、因果判斷 |
| 03 | 實驗、護欄、凍結、回退 |
| 04 | 關鍵字研究與關鍵字→網址對照 |
| 05 | 競品逆向 |
| 06 | 網站架構與內鏈 |
| 07 | 文章寫作標準 |
| 08 | 內容稽核、更新與整併 |
| 09 | 標題、描述與摘要（CTR） |
| 10 | 技術 SEO 與索引 |
| 11 | GEO／AEO |
| 12 | 站外引用 |
| 13 | 例行節奏與排程 |
| 14 | 案例與教訓（有效、無效、有害） |
| 15 | 情境手冊 |
| 16 | 頁面基本功 |
| 17 | 搜尋落地轉換（SXO） |

---

## 資料與隱私

- 每個網站的資料、匯出、報告與金鑰，都只存在**你自己專案**的 `.seo-agent/`，不會進這個 repo。
- 金鑰只以檔案路徑或環境變數名稱記錄，工具不會印出。
- 工具預設唯讀，只有少數指令會實際動作：
  - 只有 `indexing indexnow`、`indexing sitemap-submit` 會對搜尋引擎送出資料。
  - `geo-track --run` 會呼叫付費 AI API，有預算上限。
  - `backlinks verify` 會改寫追蹤表，並保留 `.bak` 備份。

  這些都支援 `--dry-run`，agent 也會先問你。
- 爬到的網頁、競品內容、API 回應、AI 回答一律當資料處理，不當指令執行。

---

## 案例來源與限制

- 案例站是一個繁體中文線上工具網站（塔羅占卜）。公開版已去識別化，不含網域、金鑰、內部 ID、營收或使用者資料，數字多以相對變化呈現。
- 案例數字來自單一網站。樣本小的結果（例如 D+7 只看方向的期中數字）都已標註信心。
- 有些內容不是來自案例站：
  - `references/15-situational-playbooks.md` 與標註「非案例實測」的段落，依 Google Search Central、Bing 官方文件與業界共識撰寫，查證日期 2026-11-02。
  - 搜尋引擎規則變動很快，使用前請以官方最新文件為準。
- 這個 skill 不保證排名。它保證的是：每一次改動都有紀錄、能被驗收，出錯能被發現並回退。

---

## 授權

[MIT](LICENSE)
