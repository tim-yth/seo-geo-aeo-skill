# 00 · 資源盤點與交接（第一次使用必跑）

> 沒有數據的 SEO 只是猜。這個 skill 的每個決策都要能回到 GSC／GA4 的固定區間數字。
> 所以第一次使用時，先把「調查流量、記錄流量」需要的資源備齊，交給 skill 記在工作區，之後每次都能直接接著用。
> 有些資料只從開通那天開始累積、事後補不回來（1.1 節）。這些要在第一天就請使用者開好。

## 0. 工作區：skill 的記憶放在哪裡

所有資料都放在網站專案根目錄的 `.seo-agent/`（沒有專案就用 `~/.seo-agent/<網域>/`，以 `--workspace` 指定）：

```
.seo-agent/
  config.json          非機密設定：網址、GSC 資源、GA4 屬性、競品、品牌詞、頁面分組、護欄查詢
  secrets/             金鑰檔（自動 chmod 600、自動加入 .gitignore；永不提交、永不印出）
  data/                每次匯出都依日期存檔：gsc/ ga4/ crawl/ competitors/ indexing/ geo/ pagespeed/
  logs/changes.md      每一次改動的部署紀錄（D0、改了哪些 URL、假設、驗收日）
  logs/experiments.json 每一波（wave）的結構化紀錄，review-due 依此提醒驗收
  logs/reviews/        每次驗收報告
  keyword-map.csv      關鍵字 → 唯一目標 URL 對照表
  geo-prompts.csv      AI 引擎引用追蹤
  content-inventory.csv 全站內容盤點與評等
```

規則：
- 金鑰只存「檔案路徑」或「環境變數名稱」到 config.json，金鑰本體只放 `secrets/`。
- 使用者在對話中直接貼出金鑰內容時：寫進 `secrets/` 對應檔案、提醒對方這段對話紀錄裡已有金鑰（必要時建議輪替），config 只記路徑。
- 原始資料、抓下來的 HTML、可以重跑的分析腳本，一律存進 `.seo-agent/data/<來源>/`，不要放在系統暫存目錄（`/tmp`）。案例站（繁中塔羅占卜工具站）有一次全站稽核，101 頁原始 HTML 和重跑腳本都只放在 `/tmp`，報告只能註明「重開機可能被清掉」。
- 每次開工先跑 `node scripts/check-resources.mjs`，它會列出哪些資源已就緒、哪些缺、缺的要怎麼補。

## 1. 資源清單（依重要度）

| # | 資源 | 必要性 | 用途 | 記在哪 |
|---|---|---|---|---|
| 1 | 網站網址＋原始碼／CMS 存取＋部署方式 | 必要 | 改頁面、改架構、上線、記 D0 | `site.url`、`repo.*` |
| 2 | Google Search Console（建議「網域資源」） | 必要 | 查詢、排名、CTR、索引、驗收的主資料 | `gsc.siteUrl`、`gsc.credentialsFile` |
| 3 | Google Analytics 4 | 強烈建議 | 自然流量落地頁行為、AI 來源流量、轉換 | `ga4.propertyId`、`ga4.credentialsFile` |
| 4 | Bing Webmaster Tools＋API key | 強烈建議（GEO） | ChatGPT 搜尋／Copilot 大量依賴 Bing 索引；AI Performance 報表看 Copilot 引用 | `bing.siteUrl`、`bing.apiKeyEnv` |
| 5 | IndexNow 金鑰 | 建議 | 改版後立即通知 Bing／Yandex／Naver 等 | `indexnow.keyFile`、`indexnow.keyLocation` |
| 6 | PageSpeed Insights API key | 選用，但實務上需要 key | CWV／LCP 實驗室量測。不帶 key（或 key 的每日配額是 0）會回 429，重試沒用（2.6） | `pagespeed.apiKeyEnv` |
| 7 | 競品清單（3–5 個）＋種子關鍵字＋品牌詞 | 必要 | 競品拆解、品牌／非品牌分流 | `competitors`、`seedKeywords`、`site.brandTerms` |
| 8 | 品牌實體資料 | 必要（GEO） | JSON-LD Organization／sameAs、llms.txt、AI 認得你是誰 | `brand.*`（官方名稱、別名、社群／目錄連結、作者） |
| 9 | 頁面分組規則 | 必要 | 首頁／工具頁／文章／分類分開驗收 | `pageGroups` |
| 10 | 護欄查詢（最在意的大字） | 必要 | 監測不能掉的關鍵字，觸線就暫停 | `guardrails` |
| 11 | SERP 查詢 API（Brave Search API） | 強烈建議 | 抓關鍵字實際前 10 名、找出真正的競品（Google 結果頁無法穩定自動抓） | `serp.provider`、`serp.apiKeyEnv` |
| 12 | AI 引擎查詢方式 | 選用 | GEO 追蹤：手動或 API（Perplexity／OpenAI web search 等） | `aiEngines` |
| 13 | GSC 與 GA4 的 BigQuery 匯出、CDN 分析、伺服器日誌 | 選用，但要第一天開（1.1） | 匿名查詢占比、同一 session 的漏斗、機器人比例、AI 爬蟲造訪 | 自訂 |

付費工具（Ahrefs／Semrush 等）不是必要的：這套方法以 GSC 真實查詢＋實際 SERP 觀察＋競品爬取為主。

### 1.1 第一天就要開、事後補不回來的資料

- **GSC → BigQuery 大量匯出**：沒有列數上限，看得到匿名查詢的占比。只從開通那天累積、不回補，首次匯出約 48 小時內；資料集位置在建立時選定；需要計費專案（有免費額度，但不保證零費用，先取得使用者同意）。案例開得晚，BigQuery 的 GSC 資料只從第一波上線前兩天開始，不能當任何基準，主比較只能靠 API。
- **GA4 → BigQuery**：先只開「每日」匯出；串流匯出與使用者資料匯出預設不開（成本與資料最小化）。同一 session 的漏斗、搜尋落地轉換（`17`）都要靠它。
- **CDN 分析或伺服器日誌**：只讀權杖就能拿每日 HTML 瀏覽數與 UA 分布（2.9）；多半以 UTC 切日，報告要註明。
- **只能人工匯出的 AI 報表**：GSC「生成式 AI」成效報表（資料從 2026-05-18 起）與 Bing「AI Performance」都沒有 API（查證日 2026-11-02）。每月請使用者匯出一次，自己累積歷史（`13` 的每月例行）。

### 1.2 每把憑證能做什麼（寫在 config 的備註）

- GSC 讀取（`webmasters.readonly`）不能提交 sitemap；提交要 `webmasters` 範圍＋資源「完整」權限。用途不同的服務帳號（例如網站後端的管理金鑰）沒加進 GSC 資源，打 GSC 會回 403。
- PageSpeed Insights 與 CrUX API 都只吃 API 金鑰，不接受 OAuth 權杖（2.6）。
- CDN 權杖只給「分析讀取」權限，範圍限這個網域（2.9）。
- GA4 服務帳戶給「檢視者」就夠；要用 Admin API 核對 Measurement Protocol 密鑰時，只輸出「一致／不一致」，不印密鑰（`01` 第 3.2 節）。

## 2. 逐項取得步驟（缺什麼就帶使用者補什麼）

### 2.1 Google 服務帳戶（GSC 與 GA4 共用一把）

1. 到 Google Cloud Console 建立（或選擇）一個專案。
2. 「API 和服務 → 程式庫」啟用：**Google Search Console API**、**Google Analytics Data API**（要看 GA4 設定時再加 **Google Analytics Admin API**）。
3. 「IAM 與管理 → 服務帳戶」建立服務帳戶，不需要任何 GCP 角色。
4. 進入服務帳戶 → 金鑰 → 新增金鑰 → JSON，下載。
5. 交給 skill：`node scripts/init.mjs --credentials /path/to/key.json`（會複製到 `.seo-agent/secrets/` 並設權限）。
6. 記下服務帳戶 email（`xxx@yyy.iam.gserviceaccount.com`），下面兩步要用。

> 組織政策禁止建立金鑰時：改用 `gcloud auth application-default login`（含 Search Console／Analytics 範圍），或對腳本加 `--access-token`。

### 2.2 Google Search Console

1. 優先使用「網域資源」（`sc-domain:example.com`）：涵蓋 http/https、www/非 www、所有子網域。只有網址前置字元資源時填 `https://example.com/`（結尾斜線不能少）。
2. GSC → 設定 → 使用者和權限 → 新增使用者 → 貼上服務帳戶 email。
   - 只讀報表：「受限」即可。
   - 要用 API 重新提交 sitemap：需要「完整」權限，且憑證要有 `webmasters`（非 readonly）範圍。
3. 確認 sitemap 已在 GSC 提交過，且 robots.txt 有 `Sitemap:` 行。
4. 記下：資源名稱 → `--gsc-site`。
5. 請使用者看一眼 GSC 設定裡的「Search generative AI」（生成式 AI）開關：預設是「納入」。設成排除不影響一般排名，但網站就不會出現在 AI Overviews、AI Mode 這類功能裡；有授權內容疑慮的網站，先看生成式 AI 成效報表再決定。把目前狀態記進 config 的備註（細節見 `15` 第 10 節）。

常見錯誤：`403 User does not have sufficient permission` = 服務帳戶沒加進該資源，或資源格式填錯（網域資源 vs 網址前置字元）。

### 2.3 Google Analytics 4

1. GA4 → 管理 → 資源存取權管理 → 新增服務帳戶 email，角色「檢視者」。
2. 管理 → 資源詳細資料 → 複製「資源 ID」（純數字，不是 `G-XXXX` 評估 ID）→ `--ga4-property`。
3. 記下資源時區（報告要對齊；GSC 用美國太平洋時間，GA4 用資源時區，這是比對時最常見的錯位來源）。
4. 建議設定：
   - **AI 來源先看預設管道「AI Assistant」**（2026-05-13 起新增、不回溯；細節見 `15` 第 10 節）。案例 90 天 65 次來自 AI 對話服務的工作階段全在這個管道，不在 Referral。但 Google 沒有公開完整清單，Perplexity 這類來源可能仍算 Referral，所以照樣補一個自訂管道群組「AI 推薦」，只收預設管道沒涵蓋的來源（例如來源符合 `perplexity|poe\.com`；先在 GA4 看預設管道實際收了哪些來源再決定），兩邊不要重複計算；跨 2026-05-13 比較時，把舊的 AI 參照網域手動併入。
   - 關鍵事件：把真正的轉換（註冊、購買、完成主要工具流程）標記為關鍵事件。
   - 事件只送白名單參數；絕不送使用者輸入內容、email、UID 或完整 URL query。
   - 不想要的參照連結（登入、金流網域）、在地搜尋引擎被記成參照、只收正式網域：照 `01` 第 3.4 節請使用者設定。
5. 注意：GA4 只從安裝那天起有資料、不回補；長期 SEO 趨勢以 GSC 為準。

### 2.4 Bing Webmaster Tools

1. 用 Microsoft 帳號登入 Bing Webmaster Tools → 從 GSC 匯入網站（最快）。
2. 設定 → API 存取 → 產生 API key。
3. 把 key 放環境變數（例如 `BING_WEBMASTER_API_KEY`），config 只記變數名稱。
4. 為什麼重要：ChatGPT 搜尋、Copilot、DuckDuckGo 等都用到 Bing 索引；Bing 沒收錄，AI 引擎很難引用你。
5. 介面裡的「AI Performance」報表（Copilot 與 Bing AI 摘要引用了你幾次、哪些頁、背後的 grounding 查詢）沒有 API，每月人工匯出（1.1）。`check-resources` 確認金鑰可用；`bing-export` 用同一把 key 匯出成效、爬取、關鍵字需求與外鏈（例：`node scripts/bing-export.mjs all`）。

### 2.5 IndexNow

1. 產生 32 位十六進位字串作為金鑰：`node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`。
2. 在網站根目錄放 `/<金鑰>.txt`，內容就是金鑰本身，確認公開可讀（200、純文字）。
3. 交給 skill：`--indexnow-key-file`（存到 secrets）與 `keyLocation`（完整網址）。
4. 每次上線後只提交「真的改過」的 URL；不要每天全站重送。

### 2.6 PageSpeed Insights 與 CrUX（實務上需要 key）

1. Google Cloud Console 啟用 **PageSpeed Insights API**（要看實測歷史再加 **Chrome UX Report API**）→ 憑證 → API 金鑰 → 存成環境變數 `PAGESPEED_API_KEY`（CrUX 可共用或另設）。
2. 到 Cloud Console 的「配額」頁確認 PageSpeed Insights API 的每日額度不是 0。2026-09 的第三方實測顯示：不帶 key 時每日上限是 0（官方頁仍寫 key 只是建議，所以這裡寫「實務上需要」；查證日 2026-11-02）。案例不帶 key 兩次都回 429，重試沒用。
3. CrUX API 只吃 API 金鑰，不接受 OAuth 權杖（案例用 OAuth 權杖呼叫回 400）。CrUX API 每天更新（落後約 2 天）；History API 每週一更新，最多回溯 40 期。
4. 兩者都拿不到時：
   - 改查 BigQuery 公開資料集 `chrome-ux-report`：月表在**次月第二個星期二**發布，需要有計費的 GCP 專案（案例三次查詢約掃描 2.2 GB）。
   - 或請使用者在 pagespeed.web.dev 手動跑，報告寫「未驗收」，不要拿舊分數充當現況。

### 2.7 SERP API（Brave Search）

1. 到 Brave Search API 申請帳號，選有 Web Search 的方案（有免費額度）。
2. 把 key 放環境變數 `BRAVE_SEARCH_API_KEY`，config 只記變數名稱；設定 `serp.country`（如 `TW`）與 `serp.lang`（如 `zh-hant`）。
3. 沒有 key 時，agent 可改用自己的網路搜尋工具，但要記下來源與日期；Bing、Yahoo、DuckDuckGo 結果同源，只算一個來源。

### 2.8 競品、關鍵字、品牌

向使用者問（或由 skill 從 GSC 與 SERP 先提出草案，再請使用者確認）：
- 3–5 個「在你的目標大字上排在你前面」的網站（不是你心中的大品牌，而是實際 SERP 上的對手）。
- 最想拿下的 5–20 個關鍵字，並標出其中不能掉的 1–3 個作為護欄查詢。
- 品牌詞與常見錯拼（用來分開品牌流量與非品牌流量）。
- 品牌實體：正式名稱、別名、創辦人／作者、成立時間、官方社群與目錄頁（sameAs）、聯絡方式、服務地區。

### 2.9 CDN 分析與日誌（選用：量機器人比例、校正 GA4 漏記、看 AI 爬蟲）

- Cloudflare：建立 API 權杖時只勾「Zone › Analytics › Read」，範圍限這個網域。沒有這個權限，就拿不到 HTML 瀏覽數、機器人比例、國家與裝置。
- 其他 CDN 或主機：至少能匯出依 UA、國家、路徑分的每日請求數。
- 拿不到原始日誌時（例如靜態平台沒有源站日誌）：可以在邊緣函式裡用非同步方式自己記一筆精簡紀錄（時間、UA 代號、平台的已驗證機器人類別、路徑、狀態碼），送到平台的日誌服務或物件儲存；或匯出平台的 AI 爬蟲面板，報告標「平台彙總，非原始日誌」。爬蟲 IP 要驗證才能當證據（`15` 第 13 節）；`log-analyze` 會做這件事（例：`node scripts/log-analyze.mjs --input <日誌檔或資料夾> --verify both`）。

## 3. 交接指令範例

```bash
node scripts/init.mjs \
  --url https://example.com \
  --gsc-site sc-domain:example.com \
  --ga4-property 123456789 \
  --credentials ~/Downloads/service-account.json \
  --competitor competitor-a.com --competitor competitor-b.com \
  --brand-term 品牌名 --brand-term brandname

node scripts/check-resources.mjs          # 人看的就緒表
node scripts/check-resources.mjs --json   # 給 agent 判斷下一步
```

之後新增任何資源（例如補上 Bing key），再跑一次 `init.mjs` 帶新參數即可；不加 `--force` 不會覆蓋既有值。

## 4. 資源就緒後立刻做的第一件事：建立 D0 基準

沒有基準就沒有驗收。資源一就緒，在動任何頁面之前：

1. 匯出最近 16 個月可得的 GSC 資料（`gsc-export.mjs`：date、page、query、query+page、country、device、searchAppearance），存成「基準快照」。
2. **先對外部事件帳本**（`02` 步驟 4）：基準期落在 GSC 官方公告的資料異常期時要標出來。2025-05-13～2026-04-27 的曝光記錄有誤，CTR 與平均排名也受影響，只有點擊可信；碰到這段的基準，曝光、CTR、名次只當參考。
3. 匯出 GA4 最近 90 天自然搜尋落地頁與 AI 來源：`ga4-export --preset organic-landing --days 90`、`ga4-export --preset ai-referrals --days 90`。
4. 全站爬取一次（`crawl-site.mjs`），存技術基準；`pagespeed.mjs` 跑首頁與前 5 大落地頁。
5. 請使用者匯出 GSC 生成式 AI 成效報表與 Bing AI Performance，存成 AI 曝光基準（1.1）：原始匯出檔放進 `data/gsc/ai-features/inbox/` 與 `data/bing/ai-performance/inbox/`，再跑 `node scripts/ai-reports-import.mjs`。
6. 在 `logs/changes.md` 寫下「基準日」與以上檔名。之後所有報告都只新增章節，**不覆寫原始基準數字**。
7. 跑 `instrumentation-audit.mjs`，把網站量測缺口整理成插入計畫給使用者確認（`01-instrumentation-plan.md`）。

量測與驗收方法詳見 `02-measurement-and-review.md`；搜尋進來的人有沒有開始使用，見 `17-sxo-search-landing-conversion.md`。
