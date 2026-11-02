# 16 · 頁面基本功：網址命名、title、H1–H3、圖片、錨文字、速度與頁面基本盤

> 這一章處理「每一頁都該做對、做對一次就一直有效」的基本功。它們很少單獨讓排名大漲；做錯的時候，卻會讓 Google 讀錯頁面（英文 H1、兩頁同一個 title）、讓使用者等太久（首屏圖延後載入、字型太大），或讓網址一改再改。
> 案例站（繁中塔羅占卜工具站）在這些地方的實際經驗：
> - 語言自動偵測讓 Googlebot 看到英文 H1，首頁和工具頁的 title＋H1 又一字不差。修好之後，大字才第一次有曝光（和首頁改定位同批上線，只能算整體效果，見 `04`、`14`）。
> - 全站 5,401 個 `<img>` 有 93% 是 WebP、0 個缺 alt；首屏圖統一 `fetchpriority="high"`、其餘延後載入，而且寫成每次部署都會跑的檢查。
> - 828 個文章網址全是小寫英文加連字號，但產生器曾吐出 30 個帶亂碼片段、10 個帶年份的 slug。
> - 真實使用者的手機 LCP p75 約 1.5 秒，實驗室卻量到 17.9 秒：判斷速度要看真實使用者資料。
>
> 三個原則：
> 1. **基本功的驗收看「規則通過率」和使用者指標**（CrUX、轉換），不宣稱排名效果；要談排名，照 `02` 用對照組。
> 2. **修模板和產生器，不要一頁一頁修**。每條規則都要有部署前（原始碼、產生器）與部署後（正式站）兩道檢查（`10`）。
> 3. **已上線的網址不為了好看而改**。

## 何時使用

- 使用者問：「圖片要不要壓縮、轉 WebP？」「網址怎麼取？」「H1、H2、H3 怎麼排？」「PageSpeed 分數很低怎麼辦？」「連結文字怎麼寫？」
- 新站、新模板、新頁型上線前；換框架、換佈景主題、換 CDN 之後。
- `crawl-site` 出現 title、H1、alt、尾斜線、連到轉址網址的問題；`pagespeed` 或 GSC 的 Core Web Vitals 報表出現「不良」。
- 產生器要開始批次產頁之前：slug、title、圖片、alt 這時都由程式決定，錯一次就錯幾百頁。

本章不重複下列內容，需要時直接去讀：

| 主題 | 去哪裡 |
|---|---|
| title 公式、同查詢 CTR、改標題的波次與判讀 | `09` |
| hub／內鏈架構、錨文字比例、變體整併 | `06` |
| canonical、轉址鏈、sitemap、hreflang、robots、爬蟲語言 | `10` |
| 結構化資料、答案膠囊、TL;DR | `11`；各型別目前的狀態見 `15` 第 15 節 |
| 圖片搜尋、影片、Discover | `15` 第 7 節 |
| Core Web Vitals 情境與排優先序 | `15` 第 14 節 |
| 文章品質、FAQ、手機表格寫法 | `07`、`templates/pre-launch-checklist.md` |
| 第一屏要放什麼、CTA、搜尋進站後的轉換 | `17`（SXO） |
| gtag 延後載入、量測斷點 | `01`、`02` |

## 怎麼用這一章：一次頁面健檢的順序

1. **抽樣**：每種頁型（首頁、工具頁、hub、文章、商品、分類…）抽 3 頁：流量最大的、內容最長的、最新的。基本功的問題幾乎都出在模板，抽樣比逐頁看快。
2. **跑工具**（參數以 `--help` 為準）：

   ```bash
   node scripts/crawl-site.mjs --max-pages 2000         # title、H1–H3、alt、尾斜線、連到轉址、錨文字
   node scripts/content-audit.mjs --from-crawl .seo-agent/data/crawl/<日期>-crawl-text.jsonl   # 標題跳級、重複、堆字
   node scripts/image-audit.mjs --help                   # 圖片格式、大小、原始與顯示尺寸、寬高、alt、首屏 lazy、fetchpriority
   node scripts/pagespeed.mjs --top-pages 10             # 實驗室數字＋CrUX 真實使用者資料
   node scripts/instrumentation-audit.mjs                # 第三方標籤、延後載入的分析碼
   ```

3. **分級**：
   - 先修「讓 Google 讀錯」：原始 HTML 沒有 H1、H1 被 JS 換掉、語言不對、title 重複、canonical 錯。
   - 再修「讓使用者等」：LCP 圖延後載入、圖檔過大、版面跳動、手機橫向捲動。
   - 再做衛生：alt、檔名、錨文字、og:image、favicon。
   - 網址：只修新頁和產生器；舊網址除非有害，不改（第 1 節）。
4. **一次一個頁型上線**，用 `log-change.mjs` 記 D0（模板改動用 `--kind template` 或 `--kind technical`，全站共用的加 `--site-wide`）。效能改動的驗收方式見第 6 節。

---

## 1. 網址與 slug 命名

### 何時使用

開新頁或新頁群、規劃目錄結構、寫產生器的 slug 規則、改版或搬家、發現亂碼 slug 或兩個 slug 搶同一個意圖。

### 規則

| # | 規則 | 門檻／做法 |
|---|---|---|
| 1 | 全小寫 | 路徑不出現大寫。Google 把網址路徑當成區分大小寫，`/About` 和 `/about` 是兩個網址；大寫版 301 到小寫版，內鏈只用小寫 |
| 2 | 用連字號分詞 | 用 `-`，不用底線 `_`、空白、`+`、`%20`；不要連續 `--`，也不要以 `-` 開頭或結尾 |
| 3 | 短 | slug 3–5 個字、60 字元以內（案例站中位數 30 字元）；7 個字以上就要重想 |
| 4 | 描述這頁 | 用這頁主字的英文（或你選定的語言），看網址就知道內容；不要把同義字全塞進去 |
| 5 | 不放填充字 | complete、ultimate、best、guide-to、the、a 這類拿掉也不影響意思的字，就拿掉；會改變意思的（`is-…-accurate` 的 is）保留 |
| 6 | 不放日期與年份 | 長青內容的年份放 title，不放網址。例外：內容本身就綁年份（年度運勢、年度報告、某年的活動），每年開新網址（`06` 第 7 步） |
| 7 | 不用 ID、雜湊、參數當內容網址 | `?id=123`、`/p/4137`、`-a1b2-` 這種都不行；平台強制的格式照平台，但不要自己再加 |
| 8 | 層級反映 hub | 穩定的分類放路徑（`/guides/`、`/products/`、`/docs/`），會變動的分類和標籤不放；內容頁離根目錄 3 層以內 |
| 9 | 尾斜線一致 | 一種頁型一種寫法，另一種寫法 301 一跳到正式寫法；canonical、sitemap、內鏈都用同一種。案例站：目錄型頁加斜線，文章與單一實體頁不加（`10` 規則 6） |
| 10 | 副檔名一致 | 建議無副檔名；`.html` 版 301 到無副檔名版。全站都用 `.html` 也可以，重點是只有一種 |
| 11 | 一個意圖一個網址 | 開新 slug 前查 `keyword-map.csv` 和現有 slug；單複數、多一個字、換個連字號，都算同一個 slug |
| 12 | 已上線的網址不改 | 除非有害（亂碼、錯語言、錯意圖、洩漏內部資訊）；要改就照下面的「改網址 SOP」 |

**例**
- 好：`/guides/pour-over`、`/blog/pour-over-ratio`、`/{主題}/2027/`（內容本身綁年份的年度頁）。
- 壞：`/Blog/Pour_Over_Ratio`、`/blog/2026-complete-pour-over-ratio-ultimate-guide`、`/blog/pour-over-a1b2`、`/blog/?p=4137`。
- 電商：`/products/trail-running-shoes-wide`，不要 `/products/12345` 或 `/collections/sale/products/trail-running-shoes-wide`（後者見下方 Shopify）。
- SaaS：`/features/gantt-chart`、`/docs/api/authentication`，不要 `/features.php?id=7`。

### 中日韓網站：英文 slug、中文 slug，還是拼音？

先知道 Google 的兩個說法：
- 網址建議用**讀者的語言**（必要時用音譯）；非 ASCII 的字在連結的 `href` 裡要做百分比編碼。Google 文件把 `/%E6%9D%82%E8%B4%A7/…` 這種編碼過的寫法列為建議，直接寫中文的 `/杂货/…` 列為不建議。
- 網址裡的關鍵字，除了出現在搜尋結果的麵包屑之外，**幾乎沒有作用**（SEO 入門指南；2026-10 的官方影片也說它是極小的訊號）。

所以這是可讀性和工程維護的選擇，不是排名的選擇。

| | 英文 slug（`/guides/pour-over`） | 中文 slug（`/指南/手沖`） | 拼音（`/zhinan/shouchong`） |
|---|---|---|---|
| Google 能不能處理 | 能 | 能，而且最接近 Google「用讀者語言」的建議；連結要寫成百分比編碼 | 能（Google 文件提到的音譯） |
| 讀者看不看得懂 | 看讀者的英文程度 | 最直覺 | 台灣讀者不習慣漢語拼音 |
| 分享、複製 | 乾淨 | 貼到通訊軟體、Email、試算表時，常變成一長串 `%E6%8C%87…`（一個中文字變 9 個字元） | 乾淨 |
| 工程風險 | 低 | 繁簡字形各成一個網址；Unicode 正規化不一致；轉址規則和日誌要同時比對編碼前、編碼後兩種形式；部分工具處理不好 | 低；但同音字多，容易撞 slug |
| 適合 | 多數繁中網站、工具站、之後要做多語的網站 | 純中文內容站、讀者大量從網址判斷內容、團隊管得好編碼 | 以簡中讀者為主的網站 |

決策：
- **選一種慣例，寫進產生器和寫作規範**；同一種頁型不要混用。多語子目錄可以各自選，但同一個語系內要一致。
- **語言子目錄**用小寫代碼，全站同一種寫法：`/en/`、`/ja/`、`/zh-cn/`。語系結構和 hreflang 見 `10` 步驟 5、`15` 第 4 節。
- **不要事後把整站 slug 從英文翻成中文（或反過來）「為了 SEO」**：那等於全站搬家（`15` 第 1 節），而網址裡的字對排名的影響很小。
- 中文 slug 完全合法；選它就要管好編碼：產生器輸出統一用 NFC、繁簡只留一種、轉址與日誌規則同時處理編碼前後兩種形式。
- 案例站選英文 slug：828 個文章網址全是小寫英文連字號，沒有大寫、底線或中文。

### 參數、分頁與片段

- **追蹤參數**（`utm_`、`fbclid`）不產生新內容：canonical 指向乾淨網址；**站內連結不要帶 `utm_`**，會汙染 GA4 的來源歸因（`01`）。
- **篩選、排序參數**：電商見 `15` 第 2 節；不要讓每種排序都變成可索引的網址。GSC 的「網址參數」工具已在 2022 年停用，參數只能靠 canonical、robots 和「內鏈不連參數網址」自己管。
- **Session ID** 不要放進網址，用 cookie。
- **分頁**：`/blog/page/2/` 這類網址各自 canonical 指向自己，不要全部指回第 1 頁；第 1 頁的分頁網址 301 回列表根網址（`10` 常見錯誤 15）。
- **`#片段`** 不是另一頁：Google 一般不處理網址片段，不要用它切換不同內容（`15` 第 6 節）；目錄錨點（第 3 節）可以用。

### 改網址 SOP（真的必要時）

1. **確認值得改**：舊網址有害，而且 `gsc-export --dimensions page` 看 16 個月內點擊很少。有點擊的網址，改 title、不改網址。
2. **新網址一次定案**：照上表，不要二改。
3. **301 一跳**：所有形式（大寫、尾斜線、`.html`、舊參數）都直接到新網址；伺服器或邊緣的轉址表也要加（`10` 步驟 4）。
4. **同步所有引用**：canonical、`og:url`、JSON-LD 的 `url`／`mainEntityOfPage`／麵包屑、hreflang 叢集、sitemap（移除舊、加入新）、llms 文件、站內連結（指向 3xx 的內鏈必須是 0）、站內搜尋，以及你能控制的外部連結（社群、商家檔案、廣告）。
5. **上線後**：`crawl-site --urls-file` 檢查新舊網址；`indexing.mjs indexnow` 送新網址與舊網址；`indexing.mjs sitemap-submit`；`log-change.mjs add --kind redirect`；D+7 用 `indexing.mjs inspect` 看 Google 選的 canonical。
6. **預期**：舊網址曝光逐步歸零、由新網址接手；判讀時新舊網址合計（`02`、`06`）。

### 怎麼檢查

- `crawl-site`：`trailing-slash-variants`（同一頁兩種寫法都有人用）、`internal-link-to-redirect`、sitemap 裡的轉址或非 canonical 網址。
- 網址規則掃描（`crawl-site` 沒有這一項，用下面這段；sitemap 是索引檔時，先展開子 sitemap）：

  ```bash
  curl -s https://www.example.com/sitemap.xml | grep -o '<loc>[^<]*' | sed 's/<loc>//' | node -e '
  const urls = require("fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
  for (const u of urls) {
    const { pathname, search } = new URL(u);
    let decoded = pathname; try { decoded = decodeURIComponent(pathname); } catch {}
    const segs = decoded.split("/").filter(Boolean);
    const slug = (segs.at(-1) || "").replace(/\.(html?|php)$/, "");
    const words = slug.split("-").filter(Boolean);
    const out = [];
    if (/[A-Z]/.test(decoded)) out.push("大寫");
    if (pathname.includes("_")) out.push("底線");
    if (/[^\x00-\x7f]/.test(decoded)) out.push("非 ASCII（選了中文 slug 慣例就忽略）");
    if (/\.(html?|php)$/.test(pathname)) out.push("副檔名");
    if (search) out.push("參數");
    if (segs.length > 3) out.push(`${segs.length} 層`);
    if (words.length > 6) out.push(`${words.length} 個字`);
    if (slug.length > 60) out.push(`${slug.length} 字元`);
    if (words.some((w) => /^(19|20)\d\d$/.test(w))) out.push("年份（年度頁是刻意的例外）");
    if (words.some((w) => (w.length >= 4 && /\d/.test(w) && /[a-z]/.test(w)) || (/^\d{4,}$/.test(w) && !/^(19|20)\d\d$/.test(w)))) out.push("疑似亂碼或流水號（人工確認）");
    if (/--|^-|-$/.test(slug)) out.push("連字號");
    if (out.length) console.log(`${u}\t${out.join("、")}`);
  }'
  ```

- 各種寫法是否一跳到正式網址：

  ```bash
  BASE=https://www.example.com
  for p in /guides/pour-over /Guides/Pour-Over /guides/pour-over/ /guides/pour-over.html; do
    printf '%-28s ' "$p"; curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "$BASE$p"
  done   # 期望：正式寫法 200；其他都是 301 直接到正式寫法（大寫版也可以是 404）
  ```

- 改網址前：`gsc-export --dimensions page` 和 `ga4-export --preset organic-landing` 看這個網址有沒有流量；`gsc-export --type image` 看圖片網址有沒有圖片搜尋流量。

### 怎麼修

| 平台 | 做法 |
|---|---|
| 純 HTML／一般主機 | 檔名就是 slug：`pour-over.html` 對應 `/pour-over`，或用資料夾 `pour-over/index.html` 對應 `/pour-over/`；伺服器規則把另一種寫法 301 到正式寫法；產生器保證小寫 |
| Next.js | 路由 `app/blog/[slug]/page.tsx`，slug 由資料層產生並在建置時驗證；`next.config.js` 的 `trailingSlash` 設 true 或 false 擇一；轉址寫在 `redirects()`，`permanent: true` 會回 308，Google 和 301 一樣看待 |
| WordPress | 「設定 → 永久連結」選「文章名稱」；中文標題會自動產生中文 slug，發布前在「網址代稱」欄改成英文；改 slug 後 WordPress 會試著轉址文章的舊網址，但不要依賴它，用轉址外掛或伺服器規則明確寫 301 |
| Shopify | `/products/`、`/collections/`、`/pages/`、`/blogs/` 前綴固定不能改；在「搜尋引擎清單」改網址代稱時，勾選「建立網址轉址」；佈景主題的商品連結用 `{{ product.url }}`，不要用 `within: collection`，那會產生大量 `/collections/x/products/y` 的重複網址 |
| 靜態產生器 | Hugo：front matter 的 `slug`、設定檔的 `[permalinks]`；Astro：`trailingSlash` 和 `build.format` 要一起設；Eleventy：`permalink`；Jekyll：`permalink: pretty` |
| Cloudflare Pages／Workers | `_redirects` 寫 `/old /new 301`；Pages 會自動把 `/x.html` 308 到 `/x`，舊網址要由你的規則先接住、一次到最終網址，不然會兩跳（`10` 步驟 4）；大小寫正規化寫在 Worker |

產生器的 slug 防呆（任何框架都要有，而且寫成單元測試）：
- slug 只能是 `^[a-z0-9]+(?:-[a-z0-9]+)*$`。
- 拒絕亂碼片段與流水號（上面掃描的規則）；產不出好 slug 時，**這一頁就不要產**，交給人，而不是產一個 fallback slug 先上線。
- 和現有 slug、轉址來源、`keyword-map.csv` 比對，撞到就停。

### 常見錯誤

- 產生器用 AI 或查詢詞產 slug，失敗時回傳亂碼或流水號（`-topic-4137`），而且上線了（`10` 常見錯誤 14）。
- 中文標題自動變成很長的百分比編碼 slug，和英文 slug 的頁混在同一個頁型。
- 年份放進長青內容的網址，隔年只能轉址，或看起來過期。
- 同一個意圖兩個 slug（`○○-beginners-guide` 和 `○○-beginner-guide-light`），各自被收錄、互搶。
- 改了網址，但內鏈、sitemap、canonical 還指向舊網址：GSC「頁面會重新導向」越積越多（案例 796 筆，`10`）。
- 把有點擊的網址改成「比較好看」的網址。
- 站內連結帶 `utm_`。

### 案例站經驗

- **網址現況**：828 個文章網址全是小寫英文連字號；中位數 30 字元；但有 30 個帶產生器的亂碼片段（例：`○○-card-a1b2-love-reading`）、10 個帶年份、69 個長達 7 個字以上。
- **處置**：亂碼和年份 slug 大多是同意圖的空殼（D 級），排進整併、301 到有描述性網址的主文（`08`）。其中一個「亂碼＋年份」的 slug 卻是該意圖的 B 級主文，有實際點擊（審稿時的 GSC 數字：116 次曝光、12 次點擊）：**保留網址，只把 title 裡的年份拿掉**。這就是「不為了網址好看，把有流量的網址轉走」（`06` 第 10 步）。
- **近似 slug**：`○○-beginners-guide` 301 到 `○○-beginner-guide-light`；亂碼 slug `○○-topic-4137-reading` 301 到描述性的 `is-{子市場}-accurate`。兩個都從 sitemap 移除。
- **產生器防呆**：加了 fallback slug 的正則與單元測試；從 GSC 查詢詞選題時，產不出乾淨英文 slug 的中文查詢直接丟棄，不給它一個 fallback slug。
- **副檔名**：清理前每篇文章都有「無副檔名＋`.html`」兩份檔（1,654 個檔案，`14`）；正式網址統一為無副檔名，`.html` 一跳 301 過去，canonical、sitemap、內鏈、JSON-LD 全部同一種寫法。
- **年度頁**：刻意用「/{年份}/」開年度頁，下一年照同一個模板開新網址，上線當天就有曝光（`06` 第 7 步）。

---

## 2. title 與 meta description

### 何時使用

新頁、新模板；`crawl-site` 標出重複、過長、缺少；Google 搜尋結果顯示的標題和你寫的不一樣。要改一批既有頁的 title 來提升 CTR，照 `09` 的波次做，不要只看本節。

### 規則

- **每個可索引頁都有唯一的 `<title>` 和 meta description**，寫在原始 HTML 的 `<head>` 前段。
- **長度：全 skill 只有一套規範，以 `09` 第 3.1 步為準**（這裡只是摘錄，要改只改 `09`）：

| 欄位 | 中日韓文字 | 英文等半形文字 | `crawl-site` 的顯示寬度（全形字算 2、半形字算 1） |
|---|---|---|---|
| title（含品牌） | ≤32 個全形字 | 約 ≤60 字元（桌機約 600px 寬） | >65 標為過長、<15 標為過短 |
| meta description | 50–80 個全形字 | 約 120–155 字元 | >170 標為過長 |

  計算單位照 `09`：中日韓字與全形標點算 1，半形英數、空格、半形標點算 0.5，也就是 `crawl-site` 的顯示寬度除以 2。Google 沒有字數上限，是依裝置寬度截斷；上表是截斷風險的上限，不是 Google 的規則。
- **前段放意圖**：中文前 12 字、英文前 30–40 字元放主要意圖詞，取該頁 page×query 裡最大宗的寫法（`07`、`09`）。
- **品牌放尾端**，用 `｜` 或 ` - ` 分隔，全站同一種；首頁可以把品牌放前面。Google 文件的建議也是網站名稱放開頭或結尾、用連字號、冒號或直線分隔。網站名稱另外用 WebSite 結構化資料宣告（`11`）。
- **不要全站加同一句後綴**（例：「｜完整解析與重點整理」）。Google 文件明列「避免重複或樣板文字」；每頁看起來一樣，讀者分不出差別，Google 也比較會改寫（`09`）。
- **title 和 H1 對齊，但不必一字不差**：主字和意思一致；title 可以多放同義字和品牌，H1 可以更口語。**兩個頁面的 title＋H1 不能相同**。
- **description 答案先行**，每一句都要在頁面上找得到；免費條件、價格要和產品一致（`09`）。
- **分頁**：第 2 頁起 title 加「第 N 頁」。
- **年份**：長青內容的 title 不放年份；放了就要每年更新（`content-audit` 會抓過期年份）。

### Google 什麼時候會改寫

- 標題連結可能取自 `<title>`、H1 等頁面主要標題、og:title、指向這頁的錨文字，或 WebSite 結構化資料。
- 常見的觸發：太長、堆關鍵字、全站同樣的模板字、title 和頁面主標題不符、資訊過期、空白或「首頁」這種沒資訊的 title。
- description 常被換成頁面裡更符合查詢的段落，這是正常的，不必追。
- 怎麼知道被改：人工看 Google 的搜尋結果（`serp-snapshot` 用的是 Brave，看不到 Google 的改寫）；或 GSC 某頁某查詢的 CTR 明顯低於同排名的其他頁。

### 怎麼檢查

- `crawl-site` 的 issues：`title-missing`、`title-too-long`、`title-too-short`、`description-missing`、`description-too-long`、`title-duplicate`、`description-duplicate`。
- `-pages.csv` 的 `title`、`title_width`、`meta_description`、`h1` 欄：按 `h1` 排序，找出 H1 相同、或 title 和 H1 主字對不上的頁。
- 改寫狀況：挑曝光最大的 10 頁，人工搜一次，記下 Google 顯示的標題。

### 怎麼修

| 平台 | 做法 |
|---|---|
| 純 HTML／靜態產生器 | 模板統一輸出 `<title>`、`<meta name="description">`；front matter 必填 `title`、`description`，建置時檢查空值、重複和長度 |
| Next.js | `metadata` 的 `title: { default: '…', template: '%s - 品牌' }`、`description`；動態頁用 `generateMetadata`；設定 `metadataBase` 為正式網域 |
| WordPress | SEO 外掛（Yoast、Rank Math）的標題模板只放「標題＋分隔符＋網站名稱」；需要時逐頁覆寫；不要開「自動加關鍵字」這類功能 |
| Shopify | 每個商品、系列、頁面的「搜尋引擎清單」欄位；確認佈景主題的 `<title>` 沒有重複加上商店名稱 |
| Cloudflare | 不要用 Worker 在邊緣改寫 title 當長期做法；改來源檔或產生器 |

### 常見錯誤

- 兩頁的 title＋H1 一字不差（通常是首頁和最重要的工具頁）。
- 自動 CTR 工具替每頁加同一句後綴。
- 同時存在好幾套長度規範，沒有寫明單位。
- 只改 `<title>`，忘了 og:title、twitter:title、JSON-LD headline、麵包屑最後一項（改標題時 9 處要一致，見 `templates/pre-launch-checklist.md`）。

### 案例站經驗

- 首頁和 AI 工具頁的 title＋H1 一字不差：一組字在 79 天內換了 21 次排名網址，全站沒有任何一頁在宣稱大字。首頁改用自己的主字之後，大字才開始有曝光（和爬蟲語言修正同批，`04`、`14`）。
- 自動 CTR 優化器替每頁加同一句後綴、description 也套同一個模板，結果每頁的搜尋摘要都長得一樣（`09`）。
- 同時存在三套長度規範（≤30／≤80、22–32／120–155、20–70／60–170），有的以全形字計、有的以英文字元計；後來統一成 `09` 第 3.1 步那一份。

---

## 3. 標題層級：H1、H2、H3

### 何時使用

新模板、新文章；`crawl-site` 或 `content-audit` 標出缺 H1、多個 H1、跳級、重複；換多語或前端框架之後；要讓 AI 引擎與摘要能抽出答案時。

### 規則

| 規則 | 做法 |
|---|---|
| 一頁一個 H1 | 用一句話說出這頁的主要意圖。Google 不會因為多個 H1 處罰，也說過標題順序亂了對搜尋影響不大；但一個 H1 對讀者、螢幕閱讀器和 AI 擷取最清楚，本 skill 的檢查以一個為準 |
| H1 在原始 HTML | 不靠 JS 產生或改寫；一般 UA、Googlebot UA、JS 執行前後都是同一個 H1；語言和 `<html lang>` 一致（`10` 步驟 6） |
| H1 和 title 對齊 | 主字相同；H1 不放品牌後綴；手機上不超過 2–3 行 |
| H2＝子意圖 | 每個 H2 只負責一件事；題目來自 GSC 長尾查詢、「其他人也問了」、競品標題；長文 6–8 個（`07`） |
| H2 底下先回答 | 第一句直接回答這個 H2（長度可照 `09` 第 3.1 步的 TL;DR），再展開（AEO，`11`） |
| H3 只放在 H2 底下 | 不跳級（H1 後直接 H3）；字要大一點或小一點用 CSS 調，不要換標題層級 |
| 標題不是裝飾 | 選單、側欄、頁尾、「熱門文章」「訂閱電子報」不要用 H1；首頁以外，logo 不要包在 H1 裡 |
| 寫給人看 | 具體、不堆字（同一個詞出現在 ≥60% 的 H2 會被 `content-audit` 標記）、不重複、沒有「heading」這種佔位字 |
| FAQ | 一個 H2「常見問題」，每題一個 H3（或 `<details><summary>`），題目寫成讀者真的會搜的問句；畫面和 FAQPage 結構化資料要一致（`11`、`15` 第 15 節） |
| 目錄 | 4 個 H2 以上的長文放目錄，連到 H2 的 `id`；`id` 用短英文、不隨標題改字而變；有固定頂部導覽列時加 `scroll-margin-top` |

**範例骨架（實體頁）**

```html
<h1>寶劍七牌義：正位、逆位在感情與工作的意思</h1>
<p class="tldr">寶劍七正位常指有人沒把話說完、暗中替自己打算；逆位則是藏著的事慢慢被看見，判斷時要回到看得到的言行，別讓一張牌替你做決定。</p>
<nav aria-label="目錄">
  <ol><li><a href="#upright">正位</a></li><li><a href="#reversed">逆位</a></li><li><a href="#faq">常見問題</a></li></ol>
</nav>
<h2 id="upright">寶劍七正位是什麼意思？</h2>
<p>（先用一兩句直接回答，再展開。）</p>
<h3 id="upright-love">感情</h3>
<h3 id="upright-career">工作</h3>
<h2 id="reversed">寶劍七逆位是什麼意思？</h2>
<h2 id="faq">常見問題</h2>
<h3>抽到寶劍七，代表對方劈腿嗎？</h3>
```

非塔羅示意例：
- SaaS 定價頁：H1「方案與價格」；H2「免費方案可以做什麼？」「10 人團隊適合哪個方案？」「怎麼取消或降級？」。
- 電商分類頁：H1「女生寬楦跑鞋」；H2「寬楦跑鞋怎麼挑」「扁平足適合哪幾雙」；商品卡片的名稱用一般文字加連結就好（幾十個 H2 會讓大綱失去意義）。

### 怎麼檢查

- `crawl-site`：`h1-missing`、`h1-multiple`；`-pages.csv` 的 `h1`、`h2`、`h3` 欄。
- `content-audit`：`heading-skip`（跳級）、`heading-duplicate`、`headings-stuffed:{詞}`；問句標題後面有沒有接短答案（GEO 區塊）。
- **渲染比對**：照 `10` 步驟 6，用無頭瀏覽器、Googlebot 手機 UA＋`en-US`＋美國時區開頁，比對原始 H1、渲染後 H1、`html lang`。快速看原始 HTML：

  ```bash
  UA='Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
  curl -s -A "$UA" -H 'Accept-Language: en-US' https://www.example.com/ | grep -o -E '<html[^>]*lang="[^"]*"|<h1[^>]*>[^<]*'
  # 渲染後的樣子：同樣的 UA、英文、美國時區，截第一屏看 H1 是什麼語言
  npx playwright screenshot --user-agent "$UA" --lang en-US --timezone America/Los_Angeles \
    --viewport-size "412, 732" https://www.example.com/ googlebot-env.png
  ```

  改 UA 不等於真的 Googlebot；Google 實際看到什麼，最後以 GSC 網址檢查為準（人工看「已檢索的網頁」或即時測試的截圖）。

### 怎麼修

| 平台 | 做法 |
|---|---|
| 純 HTML／靜態產生器 | 模板輸出唯一的 H1；layout 已經把標題輸出成 H1 時，Markdown 內文從 `##` 開始；建置時檢查 H1 數量與跳級 |
| Next.js | H1 寫在 Server Component；不要在 `useEffect` 裡依瀏覽器語言或登入狀態換 H1；語言由路由（`/en/`）決定 |
| WordPress | 文章標題是 H1，編輯器裡的標題區塊從 H2 開始（預設就是 H2）；檢查佈景主題在內頁是不是把網站名稱也輸出成 H1、側欄小工具標題是不是用了一堆 H2，用佈景主題設定或子佈景主題修 |
| Shopify | 商品名、系列名是 H1；首頁以外，header 的 logo 不要是 H1；區塊標題用 H2 |
| Cloudflare | 不要在邊緣改 H1；改來源 |

### 常見錯誤

- 原始 HTML 的 H1 被 JS 換成別的字（例如品牌名），或依瀏覽器語言換成英文。
- 用 H3、H4 做「小字」，造成跳級；用 H2 做卡片標題，一頁幾十個 H2。
- 每篇文章都有同一個 H2（例：「老師說了實話」），或 H2 全部塞同一個關鍵字（`07`）。
- 改了 H1 卻沒同步 title 和麵包屑，或兩頁 H1 相同。

### 案例站經驗

- **跳級與缺 H2**（2026-05 稽核）：首頁 H1 後直接接 H3、沒有 H2；全頁只有 `nav` 一個區塊標記，沒有 `main`。後來補上 `<main>` 和 H2 分區；改定位後的首頁是 1 個 H1＋4 個 H2。
- **原始 H1 和渲染後 H1 不同**：原始 HTML 的 H1 是含主字的工具名稱，JS 執行後被換成品牌名。修成固定單一 H1。
- **爬蟲看到英文 H1**：前端依「網址前綴 → 訪客國家 → 瀏覽器語言」決定介面語言；Googlebot 從美國、用英文瀏覽器抓，繁中首頁的 H1 變成英文，title、schema、hreflang 卻都說這頁是 zh-TW。修法是已知搜尋爬蟲在沒有語系前綴的網址上固定拿預設語言，並替 132 個載入共用腳本的頁換快取版號（`10` 步驟 6）。之後用 Googlebot＋美國英文環境開首頁，看到的 H1 是中文。同批還有首頁改定位，大字每日曝光約 1.7→230 次，只能算整體效果（`04`、`14`）。
- **title＋H1 一字不差**：見第 2 節。

---

## 4. 圖片：格式、壓縮、尺寸、延後載入、檔名與 alt

### 何時使用

新模板、新頁型；圖片多的頁（文章封面、商品、教學）；PSI 或 `image-audit` 指出圖檔過大、LCP 慢、版面跳動；要做圖片搜尋或 Discover（流量面的做法見 `15` 第 7 節）。

### 規則

**格式**

| 用途 | 格式 | 備註 |
|---|---|---|
| 照片、插畫、封面 | WebP 為基本；流程或 CDN 支援時用 AVIF（同畫質通常更小，編碼較慢） | WebP 2023 年起、AVIF 2026-07 起都已是所有主流瀏覽器長期支援的格式（Baseline 廣泛可用）；Google 圖片支援 BMP、GIF、JPEG、PNG、WebP、SVG、AVIF |
| 圖示、logo、線條圖 | SVG（先用 SVGO 壓縮） | 不要用點陣圖做圖示 |
| 要透明或無損的截圖 | WebP 無損或 PNG | 照片不要存 PNG |
| 動畫 | 影片（MP4、WebM）或動態 WebP | GIF 動輒數 MB |
| JPEG、PNG 後備 | 只有要支援很舊的瀏覽器或特殊管道（某些 Email）才需要 | 用 `<picture>` 提供，不要整站降級 |

**檔案大小（實務目標，不是 Google 規則）**

| 圖的角色 | 顯示寬度（約） | 檔案寬度 | 目標大小 | 案例站實際 |
|---|---|---|---|---|
| 首屏主圖、文章封面（多半就是 LCP） | 手機滿版；桌機 700–1200px | 1200–1600px，另備 640–800px 給手機 | ≤150–200KB；手機版 ≤100KB | 封面 1280×720 WebP：中位數 93KB、p90 99KB |
| 內文圖 | 手機滿版；桌機 ≤800px | 800–1200px | ≤100KB | — |
| 縮圖、列表卡片 | 120–400px | 顯示寬度 ×2 | 1× ≤30KB；2× ≤50KB | 640px 寬、品質 72：中位數 35KB、p90 52KB |
| 圖示 | — | SVG | 幾 KB | — |
| 分享圖（og:image） | 社群預覽 | 1200×630 | 盡量小，幾百 KB 內 | 1200×630 的後備分享圖 |

**品質設定**：WebP 照片 75–82；圖上有文字的圖（標題卡、資訊圖）85–90 或無損；AVIF（sharp、avifenc 的 0–100 尺度）約 50–65；JPEG（mozjpeg）75–82。輸出時去掉 EXIF：省位元組，也避免外洩拍攝地點。

**尺寸與響應式**
- 檔案寬度 ≈ 顯示寬度 × 裝置像素比。準備 1× 與 2× 兩種就夠，3× 多半不值得。不要把 3000px 原圖塞進 300px 的卡片。
- 寬度會隨版面變的圖用 `srcset`＋`sizes`，而且 `sizes` 要照實際版面寫；寫錯，瀏覽器就會挑太大的檔。
- **每張 `<img>` 都寫 `width`、`height`**（原始比例），CSS 加 `height:auto`（或 `aspect-ratio`）：先預留空間，避免版面跳動，也不會變形。iframe、廣告、地圖也要預留高度。

**載入**
- 首屏以外的圖用 `loading="lazy"`；**首屏的圖，尤其 LCP 圖，不要延後載入**（web.dev：永遠不要延後載入 LCP 圖）。
- LCP 圖加 `fetchpriority="high"`，一頁 1 張、最多 2 張；圖要直接寫在 HTML 的 `<img>` 裡。LCP 是 CSS 背景圖、輪播或 JS 插入的圖時，先改成 `<img>`；做不到才用 `<link rel="preload" as="image" fetchpriority="high" imagesrcset="…" imagesizes="…">`。`fetchpriority` 在 Chrome／Edge 101、Safari 17.2、Firefox 132 起支援（2024-10 起所有主流瀏覽器都有）。
- 圖放在另一個網域（圖片 CDN）時，加 `<link rel="preconnect">` 到那個網域。
- `decoding="async"` 可以加在一般圖上，但它不是 LCP 的修法：官方沒有針對 LCP 圖的規則，Chrome 團隊成員也說不要期待它讓圖變快。
- 延後載入的圖可以寫 `sizes="auto, (max-width: 720px) 100vw, 720px"`：支援的瀏覽器（Chrome／Edge 126、Firefox 150 起；Safari 27 部分支援）會用實際顯示寬度挑檔，其他瀏覽器用後面的值。還不是所有瀏覽器都支援，後面的值一定要留。
- 不要用舊式 JS 延後載入（只有 `data-src`、沒有 `src`）：不執行 JS 的爬蟲和工具看不到圖。
- 列表頁：第一屏看得到的前幾張卡片（依版面，通常 2–4 張）不要 lazy。

**檔名與 alt**
- **檔名**：跟網址用同一種慣例，描述圖的內容。英文 slug 的網站用小寫英文連字號：`gooseneck-kettle-pouring.webp`、`trail-running-shoes-wide-toe-box.webp`；不要 `IMG_0023.jpg`、`封面-最終版(2).png`，也不要一百張都叫 `hero.webp`。不同尺寸用同一個主名加寬度：`gooseneck-kettle-pouring-640.webp`。用中文 slug 的網站也可以用中文檔名，但和網址一樣要百分比編碼；多語網站的圖片檔名要跟著翻譯（Google 圖片文件）。
- **alt 寫給看不到圖的人**：圖裡有什麼、在這裡做什麼用；一句話（中文約 10–40 字、英文約 125 字元內）；實體名稱自然帶到，不要列關鍵字。
  - 好：「錢幣王后塔羅牌：坐在王座上、雙手捧著金幣的女人」。
  - 壞：「塔羅 塔羅牌 占卜 免費塔羅 錢幣王后」。
  - 圖本身就是文字（標題卡、資訊圖）：alt 寫圖上的字。
  - 連結或按鈕圖：寫它的動作或目的地（「回到首頁」「搜尋」）。
  - 純裝飾：`alt=""`（空字串，不是不寫 alt）。
  - 不要全站同一句，不要用「圖片：」開頭。
- 重要的圖用 `<img>`（可以包在 `<picture>` 裡），CSS 背景圖不會被 Google 圖片收錄；圖片旁邊要有相關文字或 `<figcaption>`。

**分享圖、Discover、結構化資料**
- `og:image`：1200×630（約 1.91:1；Meta 的下限 600×315、上限 8MB）、絕對網址，加 `og:image:width`、`og:image:height`、`og:image:alt`；`twitter:card` 用 `summary_large_image`。
- **偏好圖片**（Google 2026-03 文件更新）：用 `primaryImageOfPage` 結構化資料或 `og:image` 指定這頁最有代表性的圖；避開通用圖（例如網站 logo）、文字圖、極端長寬比。
- 想在 Discover 或搜尋結果顯示大圖：robots meta 加 `max-image-preview:large`；主圖寬 1200px 以上、總像素超過 30 萬、建議 16:9；同樣避開 logo 和文字很多的圖（`15` 第 7 節）。
- Article、Product 結構化資料的 `image`：提供 16:9、4:3、1:1 多種比例，每張至少 5 萬像素（寬×高）。
- 圖片 sitemap 只需要 `image:loc`（標題、說明等其他標籤已停用）；圖片由 JS 載入、或想讓 Google 找到更多圖時才需要。
- 社群會快取分享預覽：**上線前就把 og:image 定好**。Facebook 可用 Sharing Debugger 重新抓取；LINE 的 Page Poker 工具在 2025-06 關閉（業界說法），目前沒有官方的清快取工具。

**換圖就是換網址**：換格式或檔名時，有圖片搜尋流量的圖（`gsc-export --type image`）舊網址要 301 到新圖；同步 og:image、JSON-LD 的 image、圖片 sitemap。

### 怎麼檢查

- `node scripts/image-audit.mjs`：格式、位元組、原始尺寸與顯示尺寸、缺 `width`／`height`、alt、首屏圖 lazy、`fetchpriority`（參數以 `--help` 為準）。
- `crawl-site`：`img-missing-alt` 只抓「沒有 alt 屬性」；`alt=""` 不算錯。`crawl-site` 看的是原始 HTML；alt 會不會被 JS 改寫，要在渲染後再看一次（第 3 節的 Playwright 指令，或瀏覽器開發者工具）。
- `pagespeed.mjs` 只記 LCP 時間，不記 LCP 是哪個元素：打開 PSI 或 Lighthouse 報告，看「最大內容繪製元素」和圖片相關的建議。
- 單張圖：

  ```bash
  curl -sI -H 'Accept: image/avif,image/webp,*/*' https://www.example.com/img/hero-1280.webp \
    | grep -i -E '^(content-type|content-length|cache-control)'
  find site/ -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.webp' \) -size +200k   # 找大檔
  ```

- 瀏覽器開發者工具：滑過 `<img>` 看「顯示尺寸」和「原始尺寸」差多少。

### 怎麼修

**HTML 寫法**

```html
<!-- 首屏 LCP 圖：不 lazy、高優先 -->
<img src="/img/hero-1280.webp"
     srcset="/img/hero-640.webp 640w, /img/hero-1280.webp 1280w"
     sizes="(max-width: 720px) 100vw, 720px"
     width="1280" height="720" alt="……" fetchpriority="high">

<!-- 首屏以下 -->
<img src="/img/step-2-800.webp"
     srcset="/img/step-2-400.webp 400w, /img/step-2-800.webp 800w"
     sizes="(max-width: 720px) 100vw, 400px"
     width="800" height="600" alt="……" loading="lazy" decoding="async">

<!-- AVIF 優先、WebP 後備 -->
<picture>
  <source type="image/avif" srcset="/img/hero-640.avif 640w, /img/hero-1280.avif 1280w" sizes="(max-width: 720px) 100vw, 720px">
  <img src="/img/hero-1280.webp" srcset="/img/hero-640.webp 640w, /img/hero-1280.webp 1280w"
       sizes="(max-width: 720px) 100vw, 720px" width="1280" height="720" alt="……" fetchpriority="high">
</picture>
```

```css
img { max-width: 100%; height: auto; }
```

**批次轉檔**

```bash
# cwebp（libwebp）：品質 78、寬度 1280、去掉 metadata。注意 -resize 會把小圖放大，先挑出寬度夠的圖
for f in src/*.jpg; do cwebp -q 78 -m 6 -resize 1280 0 -metadata none "$f" -o "out/$(basename "${f%.*}")-1280.webp"; done

# avifenc（libavif 1.x）：-q 是 0–100 的品質、-s 是速度（0 最慢）
avifenc -q 60 -s 6 src/hero.png out/hero.avif

# ImageMagick 7：寬度大於 1280 才縮小，去掉 metadata
magick mogrify -path out/ -format webp -resize '1280x>' -quality 78 -strip src/*.jpg
```

```js
// sharp（Node）：每張圖產 640／1280 兩種寬度的 WebP 與 AVIF。npm i sharp；node make-images.mjs src out
// 檔名請先改成描述性的英文（見上方規則），這裡只把空白和底線換成連字號
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const [src, out] = process.argv.slice(2);
await fs.mkdir(out, { recursive: true });
for (const name of await fs.readdir(src)) {
  if (!/\.(jpe?g|png|webp)$/i.test(name)) continue;
  const base = path.parse(name).name.toLowerCase().replace(/[\s_]+/g, '-');
  for (const width of [640, 1280]) {
    const img = sharp(path.join(src, name)).rotate().resize({ width, withoutEnlargement: true }); // rotate()：依 EXIF 轉正
    await img.clone().webp({ quality: 78 }).toFile(path.join(out, `${base}-${width}.webp`));
    await img.clone().avif({ quality: 55 }).toFile(path.join(out, `${base}-${width}.avif`));
  }
}
```

單張手動調參可以用 squoosh.app（網頁版）；它的命令列版已經不維護，不要寫進流程。

**各平台**

| 平台 | 做法 |
|---|---|
| Next.js | `next/image` 會產生 srcset、預設延後載入；一定要寫 `sizes`；首屏圖在 Next.js 16 用 `preload`（`priority` 已標為淘汰；官方也說多數情況用 `loading="eager"` 或 `fetchPriority="high"` 即可），15 以前用 `priority`；`images.formats: ['image/avif', 'image/webp']`；16 起 `quality` 必須在 `images.qualities` 清單內 |
| WordPress | 編輯器插入的圖自動有多種尺寸與 srcset；6.3 起會自動替它判斷的 LCP 圖加 `fetchpriority="high"`、前幾張圖不延後載入，但常被佈景主題或頁面建構器帶偏，要用 PSI 確認；5.8 起可上傳 WebP、6.5 起可上傳 AVIF（主機的影像函式庫要支援）；大量轉檔用外掛或 CDN |
| Shopify | 用 `image_url` 搭 `image_tag`（自動帶寬高，可給 `widths`、`sizes`）；CDN 依瀏覽器自動給 WebP 或 AVIF；首屏區塊的圖 `loading: 'eager'`、`fetchpriority: 'high'`，其餘 `loading: 'lazy'`；寫死的圖片網址、CSS 背景圖、App 自己插入的圖不會自動轉格式 |
| 靜態產生器 | Astro：`astro:assets` 的 `<Image>`、`<Picture>`；Hugo：圖片處理（例 `.Resize "1280x webp q78"`）；Eleventy：`@11ty/eleventy-img` |
| Cloudflare | Image Transformations：`/cdn-cgi/image/width=640,quality=78,format=auto/<原圖路徑>`，免費方案每月 5,000 個不重複轉換；或像案例站在建置時用 sharp 產好 |

### 常見錯誤

- 首屏主圖延後載入，或 LCP 圖是 CSS 背景圖。
- 原圖直接上線；列表頁一頁幾百張圖（案例 1.2MB HTML、819 張圖，改成每頁 50 筆後約 100KB，`10` 常見錯誤 15）。
- 沒寫寬高，版面跳動；寫了寬高但 CSS 沒有 `height:auto`，圖被拉變形。
- `src=""` 空字串，或 `src` 指向首頁網址（瀏覽器會多抓一次整頁 HTML）。
- 全站 alt 同一句，或堆關鍵字；裝飾圖不寫 alt 屬性（螢幕閱讀器會唸出檔名）。
- 每張圖都 `fetchpriority="high"`，等於沒有優先。
- 照片存成 PNG、動畫用 GIF。
- 換了圖卻沿用同一個網址，又設了長快取，訪客一直看到舊圖（快取規則見第 6 節）。

### 案例站經驗

- **2026-05 稽核**：首頁圖片缺 width／height／loading、有空的 `src`、有 `src` 直接指向首頁網址、沒有 srcset、LCP 圖沒有 fetchpriority。做法是寫一支可重跑的稽核腳本，`--fix` 只做安全的修補：
  - 從已知的圖片 CDN 尺寸，或直接讀圖檔，補上寬高；
  - 牌義頁的主牌圖、文章封面這兩種首屏圖改成 `loading="eager"`＋`fetchpriority="high"`；
  - 其餘補 `loading="lazy"`、`decoding="async"`；
  - 之後全站 957 個 HTML 檔 0 問題，並放進部署前檢查。
- **10/07 一批效能修正**：牌義頁主圖 eager＋high，並 preconnect 到圖片 CDN；821 篇文章封面加 `height:auto`（寬高屬性保留空間、不變形）；牌圖抽到才載入；抽牌事件延後送出。**目前尚未驗收**：10 月的 CrUX 月表（約 11/10 發布）涵蓋 10 月最後 28 天，其中約 3 天在改動之前，只能先看方向；整段都在改動之後的是 11 月的表（約 12/8 發布）。
- **列表頁縮圖**：1280px 的封面另外產生 640px、品質 72 的縮圖，給約 300px 寬的卡片用：`sizes="(max-width: 720px) calc(100vw - 40px), 320px"`。
- **現況**：5,401 個 `<img>` 中 93% 是 WebP，JPG 只剩放在圖片 CDN 上的牌圖；853 個有 srcset；0 個缺 alt；4 個是 `alt=""` 的裝飾圖。
- **缺封面的備援**：自動產生 1280×720 的文字封面（漸層底加標題，WebP 品質 88）。文字很多的圖不適合當分享圖或主圖（`15` 第 7 節），只當暫時備援。
- **渲染後被改寫的 alt**：語言切換程式把大全頁每張牌圖的 alt 全部換成同一個字；原始 HTML 是對的，渲染後才壞（`10` 常見錯誤 16）。alt、title、aria-label 都要在渲染後再檢查一次。
- **引用不存在的圖**：品牌 Organization 的 logo 指向一個不存在的檔，約 590 個檔案都帶著它；圖片 sitemap 也曾列出不存在的封面（`10` 常見錯誤 20）。結構化資料、og:image、圖片 sitemap 裡的每張圖都要確認回 200。
- `max-image-preview:large` 只出現在約 1/4 的頁面；圖片搜尋與 Discover 都不是案例站的流量來源，**沒有驗證過效果**。

---

## 5. 連結命名與錨文字

### 何時使用

寫文章、做模板（卡片、按鈕、選單、麵包屑）、做站內連結批次；`crawl-site` 出現斷鏈、連到轉址、錨文字分裂。架構面的內鏈規則（hub、比例、數量）見 `06`；本節只講每一條連結本身怎麼寫。

### 規則

| 規則 | 做法 |
|---|---|
| 錨文字說出目的地 | 只看錨文字就知道點了會去哪：「寶劍七牌義」「跑鞋尺寸換算」；不用「點這裡」「這篇」「更多」「閱讀更多」（Google 的連結文件也把 Click here、Read more 列為太籠統） |
| 長度 | 幾個字到一個短句（中文約 4–20 字）；Google 的說法是「有描述性、合理簡潔」，不要整段文字都是連結 |
| 自然變化 | 正文的情境連結可以有變化（比例見 `06`）；選單、麵包屑固定用同一個名稱 |
| 卡片與按鈕 | 列表卡片讓「標題」本身成為連結；圖片連結的 alt 就是它的錨文字 |
| 放在正文 | 情境連結放在正文段落裡（每篇 3–5 條，`07`）；頁尾、側欄的全站連結少而精（`06`） |
| 連到最終網址 | 不經轉址、不帶 `utm_` 等追蹤參數、不連 `.html` 變體，尾斜線和 canonical 一致；`internal-link-to-redirect` 必須是 0 |
| 爬得到 | 導覽一律用 `<a href="/path">`；不用 `onclick`、`href="#"`、`javascript:`；按鈕做動作，連結做導覽 |
| rel 屬性 | 付費、贊助、聯盟連結用 `rel="sponsored"`；使用者產生的內容（留言、論壇）用 `rel="ugc"`；不想背書用 `rel="nofollow"`；可以並用。Google 一般不會跟隨帶這些屬性的連結（2019 年起當作提示，不是絕對指令） |
| 站內連結不加 nofollow | 不要用 nofollow 調整站內權重；不想被收錄的頁用 noindex 或 robots 處理（`10`） |
| 外部連結 | 連到可查證、和主題相關的來源（`07`）；要不要開新分頁是體驗決定，對 SEO 沒差；`target="_blank"` 時現代瀏覽器已預設 noopener |
| 斷鏈 | 站內 4xx／5xx 連結 0 條；外部連結每月抽查 |
| 麵包屑 | 可見麵包屑的每一層都連到正式 hub，和 BreadcrumbList 一致（`06` 第 4 步） |
| 語言切換 | 連到另一個語系的「對應頁」，不是那個語系的首頁（`10`） |

| 不好 | 好 |
|---|---|
| 想知道每張牌的意思，[點這裡] | 每張牌的意思都整理在[塔羅牌義大全] |
| 卡片底部一個[閱讀更多] | 卡片標題本身就是連結 |
| [免費塔羅占卜 塔羅牌 線上占卜] | [開始免費塔羅占卜] |
| 電商：尺寸請看[這裡] | 對照[跑鞋尺寸換算表] |
| SaaS：[了解更多] | [看甘特圖怎麼匯出 PDF] |

### 怎麼檢查

- `crawl-site` 的 `-anchors.csv`（欄位 `anchor`、`target`、`links`），以及 issues 的 `internal-link-broken`、`internal-link-to-redirect`、`anchor-split`。
- 找泛用錨文字：

  ```bash
  node -e '
  const text = require("fs").readFileSync(process.argv[1], "utf8");
  const rows = []; let row = [], cell = "", q = false;            // 簡單的 CSV 解析（處理引號與逗號）
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\"" && text[i + 1] === "\"") { cell += "\""; i++; } else if (c === "\"") q = false; else cell += c; }
    else if (c === "\"") q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  const GENERIC = /^(點這裡|按這裡|這裡|此處|更多|看更多|閱讀更多|了解更多|詳情|連結|click here|here|read more|more|learn more|link)$/i;
  for (const [anchor, target, links] of rows.slice(1)) if (anchor && GENERIC.test(anchor.trim())) console.log(`${links}\t${anchor}\t${target}`);
  ' .seo-agent/data/crawl/<日期>-crawl-anchors.csv
  ```

- 找帶追蹤參數的站內連結、用 onclick 導覽的元素（在原始碼或建置輸出上跑）：

  ```bash
  grep -rn -o -E 'href="/[^"]*utm_[^"]*"' site/ | head
  grep -rn -E 'onclick="[^"]*(location|href)' site/ | head
  ```

- `content-audit`：單篇裡連到同一個目標 ≥3 次；`--check-links` 檢查不存在的目標。

### 怎麼修

| 平台 | 做法 |
|---|---|
| Next.js | 一般導覽用 `<Link href="/path">`（會輸出 `<a>`），不要用 `router.push` |
| WordPress | 選單在「外觀 → 選單」或網站編輯器；麵包屑用 SEO 外掛；改網址後要更新內文連結時，先備份，用完整網址比對取代 |
| Shopify | 選單在後台「導覽」；商品卡片用 `{{ product.url }}` |
| 靜態產生器 | Hugo 用 `ref`／`relref` 寫站內連結，目標不存在時建置失敗；建置時跑斷鏈檢查 |
| Cloudflare | `_redirects` 只是保險，站內連結仍要改成最終網址 |

### 常見錯誤

- 錨文字和目的地不符（「○○占卜」其實連到牌義總覽）。
- 卡片只有「閱讀更多」是連結，標題不是。
- 導覽用 onclick，爬蟲和輔助工具都看不到。
- 站內連結帶 `utm_`，或連到會轉址的舊網址。
- 為了「集中權重」替站內連結加 nofollow。

### 案例站經驗

- 810 條「○○占卜」其實連到知識總覽，改成「○○牌義大全」；79 條「立即體驗 AI ○○占卜」其實連到首頁，改成「開始○○占卜」（`06`）。
- 2026-05 稽核找到 3 個用 onclick 導覽的元素，改成真正的連結。
- sitemap、列表頁、內鏈還指向轉址來源，GSC「頁面會重新導向」累積到 796 筆（`10`）。
- 519 篇文章的 CTA 連到站上不存在的功能（`07`）。
- 反例：把文章裡「帶著問題開始」的按鈕改成先經過 hub，多一次頁面載入，手機從按鈕到送出 2.96→3.47 秒，所以功能入口維持原樣（`06`）。連結要服務讀者的下一步，不是只為了 SEO；CTA 與按鈕怎麼接到轉換見 `17`。

---

## 6. PageSpeed 與 Core Web Vitals

### 何時使用

GSC 的 Core Web Vitals 報表出現「不良」；轉換率可能和速度有關；換框架、換主題、大改模板；使用者拿著 PageSpeed 分數來問；要判斷「速度值不值得先做」。

### 規則：門檻

| 指標 | 良好 | 需改善 | 不良 | 量的是什麼 |
|---|---|---|---|---|
| LCP | ≤2.5 秒 | 2.5–4 秒 | >4 秒 | 主要內容（最大的圖或文字區塊）出現的時間 |
| INP | ≤200 毫秒 | 200–500 毫秒 | >500 毫秒 | 點擊、輸入到畫面更新的延遲（2024-03-12 取代 FID） |
| CLS | ≤0.1 | 0.1–0.25 | >0.25 | 版面跳動 |
| TTFB（輔助，不是 Core Web Vitals） | ≤0.8 秒 | 0.8–1.8 秒 | >1.8 秒 | 伺服器開始回應的時間 |

以頁面載入的第 75 百分位（p75）判斷，手機、桌機分開看，主要國家也分開看。

### 規則：欄位資料 vs 實驗室資料

| | 欄位資料（CrUX：真實 Chrome 使用者） | 實驗室資料（Lighthouse、PSI 上半部） |
|---|---|---|
| 量法 | 真實使用者在真實裝置、網路上的體驗 | 一次模擬載入：固定的裝置、網速、機房 |
| 指標 | LCP、INP、CLS、FCP、TTFB 的 p75 | LCP、CLS、TBT（INP 的替代品）、FCP、Speed Index、分數 |
| 期間 | 過去 28 天滾動 | 就那一次 |
| 用途 | **判斷有沒有問題、驗收** | **找原因** |
| 限制 | 流量小的網址沒有資料，會退回整個網域的資料；改動要 28 天才完全反映 | 雜訊大；沒有真實的快取、裝置、網路；量不到真實互動 |

為什麼用欄位資料下決定：GSC 的 Core Web Vitals 報表看的是真實使用者資料（CrUX），使用者感受到的也是。實驗室數字可能離真實很遠：案例站一張牌義頁在美國機房的實驗室 LCP 是 17.9 秒，同期真實使用者的手機 LCP p75 是 1.6 秒。

**`pagespeed.mjs` 記錄的欄位**（`data/pagespeed/<日期>-pagespeed.csv`）：
- 實驗室：`score`、`lab_lcp_ms`、`lab_cls`、`lab_tbt_ms`、`lab_fcp_ms`、`lab_si_ms`。
- 欄位：`field_lcp_ms`、`field_inp_ms`、`field_cls`、`field_fcp_ms`、`field_ttfb_ms`（都是 p75，附「良好／需改善／不良」分類）。
- `field_source`：`url`＝這個網址自己的資料；`origin`＝這個網址資料不足，退回整個網域，**不能當成這頁的數字**；`none`＝沒有資料，只能先用實驗室找問題，或自己收真實使用者資料（例如用 web-vitals 程式庫把數值送進 GA4，這是量測變更，要記 D0）。
- 不帶金鑰：官方說「可以不帶，但建議帶」；實際上匿名配額常常是 0，整天回 429（案例站與本章查證時都是如此）。請使用者準備 `PAGESPEED_API_KEY`（`00`）。

### 規則：先修什麼（依序）

1. **先定位**：GSC 報表或 CrUX 看哪個頁群、哪種裝置、哪個指標落在「不良」或「需改善」；只修有問題的模板。
2. **LCP 拆四段**，看時間花在哪裡：
   - 伺服器回應（TTFB）長 → HTML 靜態化或在 CDN 快取、減少轉址、減少伺服器端查詢。
   - 資源開始載入得晚 → LCP 圖不在 HTML、被延後載入、沒有優先 → 第 4 節。
   - 資源下載得久 → 圖太大、格式舊 → 第 4 節。
   - 下載完卻遲遲沒畫出來 → 阻擋算繪的 CSS／JS、字型、A/B 測試的「防閃爍」程式（它會把整頁先藏起來）；或第一屏被登入、同意、彈窗元件佔住，LCP 變成那些元件。H1 與主要內容要排在這些元件之前，元件本身預留高度（`10` 常見錯誤 21）。
3. **阻擋算繪的資源**：關鍵 CSS 內嵌（要小），其餘延後；JS 用 `defer` 或 `type="module"`；移除沒用到的 CSS／JS；建置時就壓縮（minify）。
4. **第三方標籤**：先盤點（`instrumentation-audit`）→ 移除沒在用的 → 其餘非同步載入 → 客服聊天、熱點圖這類延到使用者互動後。分析碼是例外，延後可能少算（見下面「分析碼延後載入的取捨」）。
5. **字型**：見下面的「中日韓字型」。
6. **INP**：拆開長任務（>50 毫秒）；事件處理先更新畫面，送分析事件、存資料這類工作延後做；減少 DOM 數量；避免一次改動大量版面。
7. **CLS**：圖片、嵌入、廣告預留空間；同意橫幅用覆蓋的方式，不要把內容往下推；調整後備字型的尺寸；不要在已經顯示的內容上方插入東西。
8. **快取與壓縮**（`10` 規則 15）：HTML 用 `max-age=0, must-revalidate`；檔名有雜湊的資產用 `max-age=31536000, immutable`；沒有版本號的 JS／CSS 不可以 immutable；文字資源用 Brotli 或 gzip；靜態資源走 CDN。
9. **頁面重量**：HTML 太大會拖慢解析（Googlebot 每個網址只抓前 2MB，`15` 第 6 節）；列表頁分頁，不要一頁塞幾百筆。

### 中日韓字型

- **為什麼特別重**：繁中字型要涵蓋幾千到上萬個字，一個字重常是好幾 MB；拉丁字型通常只有幾十 KB。就算用 Google Fonts 的切片，字型 CSS 本身也很大，而且放在 `<head>` 用一般方式載入會阻擋轉譯。案例站一頁的字型 CSS 就有 750KB、648 個 `@font-face`，阻擋轉譯約 2.9 秒，每頁還要下載 1.6–2.9MB 字型（`10` 常見錯誤 21）。
- **選項（由快到慢）**：
  1. **系統字型**，不用下載：`font-family: system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;`。
  2. **只有標題或 logo 用網頁字型**：Google Fonts 的 `text=` 參數只下載指定的字（固定標語、品牌字樣適用），或自己做只含標題用字的子集；字重 1–2 個。
  3. **Google Fonts**：中日韓字型會被切成很多個 `unicode-range` 小檔，瀏覽器只下載頁面用到的部分；網址加 `display=swap`；字重最多 2 個；字型 CSS 用非阻擋方式載入（見下方範例）。字多的頁面仍可能下載好幾 MB。
  4. **自己托管子集**：用 fonttools 的 `pyftsubset` 依全站實際用到的字產生 woff2，搭配 `unicode-range`；內容新增常用字以外的字時要重產。
- `font-display: swap`：先用後備字型顯示，字型到了再換。文字不會隱形，但可能跳動。`optional`：字型來得及才用，跳動最少。
- 只預載（preload）首屏一定用到、而且很小的字型檔；**不要預載整套中日韓字型**。
- 後備字型用 `size-adjust`、`ascent-override` 調到和網頁字型接近，減少換字型時的跳動（Next.js 的 `next/font` 會自動做）。
- 字型載入方式寫在模板與產生器裡；只改頁面，下次重產會把阻擋載入帶回來（`06` 第 11 步）。

```html
<!-- 字型 CSS 非阻擋載入：先預載，載完才套用；不執行 JS 時用 noscript 後備 -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@700&display=swap"
      onload="this.onload=null;this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@700&display=swap"></noscript>
```

```css
/* 標題用自托管的子集字型，內文用系統字型 */
@font-face {
  font-family: "Brand Serif TC";
  src: url("/fonts/brand-serif-tc-700-subset.woff2") format("woff2");
  font-weight: 700;
  font-display: swap;
  unicode-range: U+3000-303F, U+4E00-9FFF, U+FF00-FFEF;
}
body { font-family: system-ui, -apple-system, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
h1, h2 { font-family: "Brand Serif TC", serif; }
```

```bash
# 從爬蟲輸出收集標題實際用到的字，再產子集（pip install fonttools brotli）
node -e '
const fs = require("fs"); const chars = new Set();
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!line) continue;
  const p = JSON.parse(line);
  for (const ch of [p.title || "", ...(p.h1 || []), ...(p.headings || []).map((h) => h.text)].join("")) chars.add(ch);
}
fs.writeFileSync("used-chars.txt", [...chars].join(""));
' .seo-agent/data/crawl/<日期>-crawl-text.jsonl
pyftsubset NotoSerifTC-Bold.otf --text-file=used-chars.txt --flavor=woff2 --output-file=brand-serif-tc-700-subset.woff2
```

### 分析碼延後載入的取捨

- 把 gtag 延到「第一次互動後」或「載入 N 秒後」：主執行緒的工作少一點，但 N 秒內離開的人可能不會被記到 → session 變少、參與率與轉換率虛高（只記到留下來的人，`01`）。
- **規則**：預設不延後（gtag.js 本來就是非同步載入）。真的要延後：
  1. 先量延後前的基準；
  2. 記成量測變更：`log-change.mjs add --type measurement`；
  3. 用獨立來源校正：GA4 page_view ÷ CDN 或伺服器的 HTML 瀏覽數；GA4 自然 session ÷ GSC 點擊。**按頁群、在改動前後各算一次**，比的是同一個比值的變化；單一時點的比值（點擊本來就不等於 session）不能當成延後載入造成的量（`01`）；
  4. 比值有下降，就在之後每份報告加註漏記比例。
- **案例站**：9/29 改成「第一次互動或載入後 3.5 秒才載入」。改動前後，全站的兩個比值都沒有下降（GA4 page_view ÷ 一般瀏覽器的 HTML 瀏覽 0.317→0.359；GA4 自然 session ÷ GSC 點擊 1.065→1.078），沒有量到可測的漏算。首頁單頁的 GA4 只記到 GSC 點擊的 42–73%，但那是水準比值，不能拿來證明延後載入少算（`01`）。結論：沒有量到傷害，不代表沒有風險；這個改動仍要記成量測斷點，跨過這一天的 GA4 比較都要標註。

### 什麼時候值得先做速度

| 情況 | 優先度 |
|---|---|
| 高流量或高轉換的頁群落在「不良」 | 高 |
| 互動工具的 INP 不良 | 高：直接影響使用 |
| 全站模板就能修好的（圖片屬性、字型、快取標頭） | 中：便宜，當技術衛生排進一波 |
| 只是「需改善」，瓶頸在內容或權威 | 低 |
| 為了 Lighthouse 拿 100 分 | 不做 |

依據（Google 頁面體驗文件，2026-09-22 版）：
- Core Web Vitals 有被排名系統使用，但分數好不保證排在最前面。
- Google 一律優先顯示最相關的內容，即使頁面體驗不佳；只是很多查詢有大量有用的內容，這時好的頁面體驗可能有幫助。
- Core Web Vitals 以外的頁面體驗面向，不會直接幫助排名。

所以實務上把它當成「同分時的加分」：先把「不良」修到「良好」，比把「良好」再修得更好重要（`15` 第 14 節）。速度對轉換的影響，通常比對排名大。

### 前後比較：固定窗

- **CrUX 是 28 天滾動**：涵蓋部署日的任何一個 28 天窗都混了改前、改後的資料。
  - 改前：最後一個結束在 D−1 的 28 天窗。
  - 改後：第一個從 D+1 開始的 28 天窗。CrUX API 每天約 UTC 04:00 更新、落後約 2 天，所以要到 D+30 左右才拿得到。
- **CrUX History API**：每週一更新，每點是一個 28 天窗；預設回 25 週、最多 40 週。最適合畫部署前後的趨勢（需要 API 金鑰）。
- **CrUX 月資料（BigQuery）**：每月第二個星期二發布上個月的表（例：9 月的表 10/13 出現；10 月的表預計 11/10），每張表只包含**該月最後 28 天**。部署日落在那 28 天裡，那個月就是混合的；要比「部署前最後一個完整的月」和「第一個整段都在部署後的月」。部署在月初（每月前 3 天左右）約 5–6 週後能驗收，月中部署要等到再下一個月的表，約 8–9 週。
- **想快一點**：用 CrUX API 或 History API 的 28 天窗，約 D+30 就有第一個完全在改動後的窗。
- **GSC 的 Core Web Vitals 報表**也是 28 天的資料，而且會延遲。
- **實驗室數字**：同一個網址、同樣的裝置設定、同一個地點，每次跑 5 次取中位數；記下條件（是否已壓縮、是否擋掉分析碼）。
- **效能改動單獨成一波**，不和內容、title 同批：`log-change.mjs add --kind technical --checkpoints 7,14,28,42`。
- **驗收看 CrUX p75 與轉換**；排名變化干擾太多，不能當主要證據（`15` 第 14 節）。

### 怎麼檢查

```bash
node scripts/pagespeed.mjs --top-pages 10       # 首頁＋前 10 大落地頁，手機與桌機

# 本機 Lighthouse：擋掉分析碼與廣告像素（不擋，測試流量會灌進 GA4，見 `10` 常見錯誤 18），只看效能，同一條件跑 5 次取中位數
npx lighthouse https://www.example.com/ --only-categories=performance --form-factor=mobile \
  --blocked-url-patterns='*googletagmanager.com*' --blocked-url-patterns='*google-analytics.com*' \
  --blocked-url-patterns='*connect.facebook.net*' --output=json --output-path=./lh-home.json

# CrUX History API：每週一點的趨勢（要 Google Cloud 的 API 金鑰；不帶金鑰會被拒）
curl -s "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord?key=$CRUX_API_KEY" \
  -H 'Content-Type: application/json' -d '{"origin":"https://www.example.com","formFactor":"PHONE","collectionPeriodCount":40}'

# 伺服器回應時間、HTML 大小、壓縮與快取標頭
curl -s -o /dev/null -w 'TTFB %{time_starttransfer}s  傳輸 %{size_download} bytes\n' --compressed https://www.example.com/
curl -sI -H 'Accept-Encoding: br, gzip' https://www.example.com/ | grep -i -E '^(content-encoding|cache-control)'
```

```sql
-- 沒有 CrUX 金鑰時：BigQuery 公開資料集（月資料、整個網域、依裝置）
SELECT yyyymm, device, p75_lcp, p75_inp, p75_cls, p75_ttfb
FROM `chrome-ux-report.materialized.device_summary`
WHERE origin = 'https://www.example.com' AND date >= '2026-01-01'
ORDER BY yyyymm, device;
-- 依國家：chrome-ux-report.materialized.country_summary（加 country_code = 'tw'）
```

- `instrumentation-audit`：第三方標籤清單、延後載入的分析碼。
- 瀏覽器開發者工具的「效能」面板：本機即時看 LCP、INP、CLS，也能看 LCP 是哪個元素。INP 要真的去點，實驗室的單次載入量不到。

### 怎麼修

| 平台 | 做法 |
|---|---|
| 純 HTML／靜態產生器 | 預先產好 HTML，放 CDN；關鍵 CSS 內嵌、JS 加 `defer`；圖片照第 4 節；字型照上面 |
| Next.js | 盡量靜態產生或用快取（ISR）；`next/image`（第 4 節）；`next/font` 自托管字型，預設 `display: swap` 並自動調整後備字型，中日韓字型不要整套預載；`next/script` 的 `strategy` 依用途選，分析碼不要用 `lazyOnload`（可能少算） |
| WordPress | 整頁快取（外掛或主機）；減少外掛與頁面建構器的腳本；圖片照第 4 節；用 Performance Lab 這類官方團隊的外掛前先在測試站試 |
| Shopify | 移除不用的 App（很多 App 移除後還留著程式碼）；圖片用 `image_url`／`image_tag`；字型在佈景主題設定裡選，`font_face` 加 `font_display: 'swap'`；後台有網站效能報告（以 Core Web Vitals 呈現）可以對照 |
| Cloudflare | HTML 用快取規則在邊緣快取；Brotli 預設開啟；Auto Minify 已在 2024-08-05 停用，改在建置時壓縮；Rocket Loader 會改寫腳本載入順序，可能弄壞分析碼與同意橫幅，要先測；Early Hints 開了要看日誌（案例站因此出現大量內部 504 雜訊） |

### 常見錯誤

- 用 Lighthouse 分數或一次測試下結論；把實驗室 LCP 當成使用者體驗。
- `field_source=origin` 的數字被寫成「這頁的 LCP」。
- 驗收窗跨過部署日：28 天窗混了改前改後，就宣布「沒效果」或「有效」。
- 同一窗內又改了別的東西（介面改版、壓縮方式、分析碼載入方式），結果無法歸因。
- 為了分數把分析碼延後，量測從此偏掉卻沒有記錄。
- 只修首頁，沒修流量最大的模板。
- 為了速度把重要內容延後載入，結果爬蟲看不到（`15` 第 6 節）。

### 案例站經驗

- **真實使用者（CrUX，整個網域）**：手機 p75 的 LCP 1.4–1.6 秒、CLS 0，一直良好；INP 6–7 月是 75 毫秒，8–9 月升到 150 毫秒（仍在良好內，但目標是回到 100 毫秒以下）。
- **新發現的退步**：9 月桌機 CLS p75 從 0 升到 0.1，「良好」比例 95.4%→74.5%；台灣桌機 0.15，已落在「需改善」。桌機約占 9 月載入的 41%。原因還在查，屬於技術修正，不和 SEO 內容波次混在一起（`13` 的 CWV 退步警報就是用這個案例訂的）。
- **實驗室 vs 真實**：美國機房的實驗室數字：牌義頁 LCP 17.9 秒、首頁 LCP 3.4 秒、TBT 863 毫秒、「開始抽牌」按鈕 INP 中位數 360 毫秒（最差 1,000 毫秒）；同期真實使用者手機 LCP p75 1.6 秒、INP 150 毫秒。實驗室用來找原因，判斷用真實資料。
- **混窗**：9/29 同時上線介面改版、JS／CSS 壓縮與分析碼延後載入；之後的實驗室分數要標「壓縮後」，跨過這天的 28 天 CrUX 窗混了改版前後的資料。
- **中日韓字型**：一頁的字型 CSS 750KB、648 個 `@font-face`，阻擋轉譯約 2.9 秒，每頁下載 1.6–2.9MB 字型；首頁第一屏還是登入視窗的文字。真實使用者的 LCP 一直良好，問題只出現在實驗室數據，所以照「什麼時候值得先做速度」排在內容與權威之後（`10` 常見錯誤 21）。
- **工具限制**：PSI 不帶金鑰整天回 429；CrUX API 要 API 金鑰（用 OAuth token 呼叫失敗）；最後改用 BigQuery 公開資料集（3 次查詢約 2.2GB）。
- **伺服器回應**：首頁 TTFB 約 0.50–0.63 秒，主要競品約 0.23–0.48 秒；兩邊都在 0.8 秒的良好門檻內，所以沒有把它當優先項目。
- **10/07 的效能修正還沒驗收**（第 4 節）：10 月的月表（約 11/10 發布）有約 3 天在改動之前，先看方向；乾淨的比較要等 11 月的表（約 12/8 發布），或改用 History API 的 28 天窗。

---

## 7. 其他頁面基本盤

### 何時使用

新模板上線前、換框架或佈景主題後、每季一次全站抽查；`crawl-site` 出現 `lang-missing`、`canonical-missing`、`jsonld-parse-error`、`thin-content`、`js-rendered`。

### 規則

| 項目 | 規則 |
|---|---|
| `<html lang>` | 等於這頁 hreflang 用的代碼（例：都用 `zh-TW`）；JS 執行前後不變。Google 判斷語言看可見內容，但 Bing、螢幕閱讀器和驗證工具會看它 |
| `<meta charset="utf-8">` | 放在 `<head>` 最前面 |
| viewport | `<meta name="viewport" content="width=device-width, initial-scale=1">`；不要加 `maximum-scale=1` 或 `user-scalable=no`（會擋使用者放大） |
| canonical | 絕對網址、自我指向、每頁一個、寫在原始 HTML；和 `og:url`、JSON-LD 的 `url`、麵包屑最後一項相同（`10` 規則 5） |
| robots meta | 預設就是 index、follow，不必寫；noindex 只用在刻意的頁；想要大圖和完整摘要就加 `max-image-preview:large`（`max-snippet:-1` 可選）；PDF 等非 HTML 用 `X-Robots-Tag` 標頭 |
| Open Graph／Twitter | `og:title`、`og:description`、`og:url`（＝canonical）、`og:image`（第 4 節）、`og:type`、`og:site_name`、`og:locale`（例 `zh_TW`）；`twitter:card`＝`summary_large_image`，其餘欄位 Twitter／X 會讀 og |
| favicon | `/favicon.ico` 要回 200（瀏覽器會自動抓）；另放方形 SVG 或 PNG 圖示，Google 搜尋要求方形、建議大於 48×48px；加 `apple-touch-icon`（180×180） |
| 結構化資料 | 依頁型放最少必要的型別，能解析、和畫面一致；全站一個 Organization `@id`（`11`）；哪些型別還有效見 `15` 第 15 節 |
| 語意區塊 | `<header>`、`<nav>`、`<main>`（一頁一個）、`<article>`、`<aside>`、`<footer>`；輸入框有 `<label>`，按鈕有可讀的名稱 |
| 手機可讀 | 390px 與 320px 寬沒有橫向捲動；表格包 `overflow-x:auto` 容器、5 欄以上給最小寬度、首欄短標籤不換行（`07` 第 8 步）；內文字 ≥16px（輸入框小於 16px 時，iPhone 點進去會自動放大）；中文行高 1.6–1.8 |
| 點擊區 | 按鈕與連結 ≥48×48 CSS px（Android 的建議）、彼此留間距；無障礙標準 WCAG 2.2 AA 的最低是 24×24。Lighthouse 12 起，這項檢查從 SEO 分類移到無障礙分類（target-size） |
| 彈窗 | 從搜尋進來的第一眼，不要被蓋住主要內容的彈窗擋住；法律要求的同意橫幅、年齡確認、小型橫幅可以；促銷彈窗等使用者有互動後再出現 |
| 第一屏 | 看得到 H1 和這頁的主要動作；工具頁第一屏就是工具，輸入框前的說明 ≤約 100 字（`06` 第 3 步）；第一屏放什麼、CTA 怎麼寫、進站後怎麼接到轉換，見 `17` |
| HTTPS | 全站 HTTPS、沒有混合內容；http 一跳到 https |
| 頁面大小 | 原始 HTML 遠小於 2MB（Googlebot 只抓前 2MB）；meta、canonical、JSON-LD 放在前面；不要內嵌巨大的 base64 圖 |
| 日期 | 文章顯示發布與更新日期，和 `datePublished`／`dateModified` 一致；不做假更新（`06`、`09`） |
| 404 | 不存在的網址回真的 404（不是 200 回首頁），頁面上給幾個有用的連結（`10` 規則 2） |

**最小的 `<head>` 範本**

```html
<!doctype html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>寶劍七牌義：正位、逆位在感情與工作的意思｜品牌</title>
  <meta name="description" content="寶劍七正位常指有人沒把話說完，逆位是藏著的事慢慢被看見。本頁說明感情、工作與是非題怎麼讀，並整理常見的誤解。">
  <link rel="canonical" href="https://www.example.com/cards/swords-7">
  <meta name="robots" content="max-image-preview:large">
  <meta property="og:type" content="article">
  <meta property="og:title" content="寶劍七牌義：正位、逆位在感情與工作的意思">
  <meta property="og:description" content="寶劍七正位常指有人沒把話說完，逆位是藏著的事慢慢被看見。本頁說明感情、工作與是非題怎麼讀，並整理常見的誤解。">
  <meta property="og:url" content="https://www.example.com/cards/swords-7">
  <meta property="og:image" content="https://www.example.com/img/swords-7-og.webp">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="寶劍七塔羅牌：一個人抱著五把劍躡手躡腳離開營地">
  <meta property="og:site_name" content="品牌">
  <meta property="og:locale" content="zh_TW">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <script type="application/ld+json">{ "…": "見 11 的實體圖譜" }</script>
</head>
```

### 怎麼檢查

- `crawl-site`：`lang-missing`、`canonical-missing`、`canonical-multiple`、`noindex`、`jsonld-parse-error`、`faq-schema-not-visible`、`thin-content`、`js-rendered`；`-pages.csv` 的 `bytes`（HTML 大小）、`response_ms`。
- `instrumentation-audit`：canonical 與 JSON-LD 的覆蓋率、GSC／Bing 驗證碼。
- `check-resources`：首頁是否被 noindex、robots.txt、AI 爬蟲的存取。
- 手機截圖（有 Playwright 時）：

  ```bash
  npx playwright screenshot --viewport-size "390, 844" --full-page https://www.example.com/cards/swords-7 m390-full.png
  npx playwright screenshot --viewport-size "1280, 800" https://www.example.com/cards/swords-7 d1280-first.png
  ```

  再用瀏覽器檢查 `document.documentElement.scrollWidth` 是否等於視窗寬度。改前、改後各拍一組（`templates/pre-launch-checklist.md`）。
- 分享預覽：Facebook Sharing Debugger；Rich Results Test 抽查結構化資料。

### 怎麼修

| 平台 | 做法 |
|---|---|
| Next.js | 根 layout 寫 `<html lang="zh-TW">`；`metadata` 的 `alternates.canonical`、`openGraph`、`twitter`、`robots`、`icons`；`app/icon.png`、`app/opengraph-image.png` 這類檔案慣例；`viewport` 預設就是 `width=device-width, initial-scale=1` |
| WordPress | 佈景主題用 `language_attributes()` 輸出 lang；canonical、OG、robots 交給一個 SEO 外掛（不要兩個外掛同時輸出）；「網站圖示」設定 favicon |
| Shopify | `theme.liquid` 用 `{{ canonical_url }}`、`<html lang="{{ request.locale.iso_code }}">`；社群分享圖在「偏好設定」；佈景主題的 `meta-tags` 片段負責 OG |
| 靜態產生器 | 放在共用的 base layout；建置時檢查每頁都有 lang、canonical、title、description、og:image |
| Cloudflare | `_headers` 或 Transform Rules 加安全與快取標頭、預覽網域的 `X-Robots-Tag`（`10` 步驟 7；注意：用了 Pages Functions 或 `_worker.js` 時，`_headers` 不會套用到程式產生的回應，要在程式裡加，見 `10` 規則 15、17 的陷阱）；不要用邊緣改寫來補 canonical 或 lang，改來源 |

### 常見錯誤

- `html lang` 和 hreflang 寫法不一致（`zh-Hant` 對 `zh-TW`）。
- viewport 禁止縮放。
- 兩個外掛各輸出一組 canonical 或 OG。
- favicon.ico 不存在，瀏覽器和爬蟲每天打出幾百個 404。
- 手機上表格把整頁撐寬；輸入框字太小，一點就自動放大。
- 一進站就跳出蓋住內容的促銷彈窗。

### 案例站經驗

- 7 個工具頁寫 `lang="zh-Hant"`，hreflang 卻是 `zh-TW`（`10`）。
- `favicon.ico` 不存在，CDN 日誌每天數百次 404（`10`）。
- 2026-05 稽核：15 個互動元素沒有可讀名稱、15 個輸入框沒有 label、部分手機文字小於 12px；首頁只有 `nav` 區塊標記。
- 手機表格：某一組修正就有 24 個檔漏包捲動容器（`07`）；之後每次改版都拍 390×844 與 1280×800 的改前改後截圖。
- 第一屏：競品工具頁輸入框前的說明 66–144 字，案例站原本 207–234 字，改成約 100 字內並附範例問題按鈕；「第一屏放提問框」是案例站少數被證明有效的三類改動之一（`06`、`14`；轉換面的做法見 `17`）。
- 首頁的促銷彈窗：判斷是「沒有證據影響排名」，只在效能或體驗有實測收益時另外處理，沒有為了 SEO 先動它。
- 只有約 1/4 的頁面有 `max-image-preview:large`；`og:image` 宣告寬高的只有少數頁，後備分享圖固定 1200×630。

---

## 決策規則與門檻（總表）

| 主題 | 規則／門檻 |
|---|---|
| slug | 小寫、連字號、3–5 個字、≤60 字元；不放年份（除非內容綁年份）、ID、亂碼、追蹤參數；離根目錄 ≤3 層 |
| 改網址 | 有點擊就不改；真的要改：301 一跳＋所有引用同步＋D0 |
| CJK slug | 選一種慣例並寫進產生器；中文 slug 的連結要百分比編碼 |
| title | 中文 ≤32 全形字（寬度 ≤64；`crawl-site` 超過 65 才標過長；英文約 ≤60 字元）、前 12 字放意圖、品牌在尾端、全站唯一（規範以 `09` 為準） |
| description | 中文 50–80 字（英文約 120–155 字元）、答案先行、每句在頁面上找得到 |
| H1 | 一頁一個、在原始 HTML、和 title 主字一致、語言正確；兩頁不能相同 |
| H2／H3 | H2＝子意圖、第一段先回答；不跳級；不當裝飾 |
| 圖片格式 | WebP 基本、AVIF 可選、SVG 給圖示 |
| 圖片大小 | 首屏主圖 ≤150–200KB；內文 ≤100KB；縮圖 1× ≤30KB、2× ≤50KB |
| 圖片載入 | 全部有寬高；LCP 圖不 lazy＋`fetchpriority="high"`（每頁 1–2 張）；其餘 lazy |
| alt | 描述內容與作用；文字圖寫圖上的字；裝飾圖 `alt=""` |
| 錨文字 | 說出目的地；不用「點這裡」；0 條連到轉址；0 條站內 utm |
| CWV | p75：LCP ≤2.5 秒、INP ≤200 毫秒、CLS ≤0.1；TTFB ≤0.8 秒（輔助） |
| 速度判斷 | 用欄位資料；`field_source=origin` 不能當單頁數字；實驗室只找原因 |
| 速度驗收 | 效能改動單獨成波；CrUX 28 天窗不跨部署日（History API 約 D+30 有乾淨的改後窗）；月表只含每月最後 28 天，比「部署前最後一個完整月」和「第一個整段在部署後的月」（月初部署約 5–6 週、月中部署約 8–9 週） |
| 分析碼 | 預設不延後；延後就記量測變更，按頁群在改動前後各算一次校正比值（`01`） |
| 頁面基本盤 | lang＝hreflang；viewport 不禁縮放；canonical 自我指向；favicon.ico 回 200；390px 無橫向捲動；點擊區 ≥48px |

## 對應腳本

| 腳本 | 在本章的用途 |
|---|---|
| `node scripts/crawl-site.mjs` | title／描述長度與重複、H1–H3、缺 alt、lang、canonical、尾斜線變體、連到轉址與斷鏈、錨文字（`-anchors.csv`）、HTML 大小（`bytes`） |
| `node scripts/content-audit.mjs` | 標題跳級、重複、堆字；問句標題後的短答案；過期年份；重複內鏈 |
| `node scripts/image-audit.mjs` | 圖片格式、位元組、原始與顯示尺寸、寬高、alt、首屏 lazy、fetchpriority |
| `node scripts/pagespeed.mjs` | 實驗室＋CrUX 欄位資料（含 `field_source`）；首頁、前幾大落地頁、各模板代表頁 |
| `node scripts/instrumentation-audit.mjs` | 第三方標籤、延後載入的分析碼、canonical 與 JSON-LD 覆蓋率 |
| `node scripts/indexing.mjs` | 改網址後的 indexnow、sitemap-submit、inspect（Google 選的 canonical） |
| `node scripts/gsc-export.mjs` | 改網址或換圖前，確認頁面與圖片的流量（`--dimensions page`、`--type image`） |
| `node scripts/log-change.mjs` | 模板、效能、轉址、量測變更都記 D0（`--kind template`／`technical`／`redirect`、`--type measurement`） |

每支腳本都可以加 `--help` 看參數。腳本沒涵蓋的檢查（slug 規則、泛用錨文字、手機截圖、CrUX 歷史），用本章各節附的指令補。

## 範本

- `templates/on-page-checklist.md`：每頁（或每個模板抽 3 頁）的基本功檢查表，可直接複製使用。
- `templates/pre-launch-checklist.md`：文章內容與上線流程（和本章的檢查表互補）。
- `templates/technical-audit-report.md`：全站技術稽核報告（第 10、12 節放渲染與 CWV 結果）。

## 查證日期與來源

以下皆於 **2026-11-02** 查證。未標註的是官方一手文件（Google Search Central、web.dev、Chrome、W3C、各框架與平台的官方文件）；標「業界」的是第三方說法，只當旁證。括號內是頁面標示的最後更新日。

**1 網址**
- URL structure best practices（2026-10-21；變更紀錄 2026-10-23 補充連字號與底線）：https://developers.google.com/search/docs/crawling-indexing/url-structure
- Search Central 文件更新紀錄：https://developers.google.com/search/updates
- To slash or not to slash（2010-04-21）：https://developers.google.com/search/blog/2010/04/to-slash-or-not-to-slash
- SEO Starter Guide（2025-12-10；網址關鍵字、標題順序）：https://developers.google.com/search/docs/fundamentals/seo-starter-guide
- Google Search Central 影片（2026-10-14，網址裡的字是極小的訊號）：https://www.youtube.com/watch?v=Mfvw43BbHy0
- URL Parameters 工具停用（2022-03-28）：https://developers.google.com/search/blog/2022/03/url-parameters-tool-deprecated
- 分頁與漸進載入（2025-12-10）：https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading
- Site moves with URL changes（2026-08-20）：https://developers.google.com/search/docs/crawling-indexing/site-move-with-url-changes
- （業界）Shopify `within: collection` 造成的重複網址：https://www.amsive.com/insights/seo/resolving-shopify-duplicate-content-between-collection-product-pages/

**2 title 與描述**
- Influencing title links（2025-12-10）：https://developers.google.com/search/docs/appearance/title-link
- Control your snippets（2026-04-20）：https://developers.google.com/search/docs/appearance/snippet

**3 標題層級**
- SEO Starter Guide（同上）
- Google Search Central 影片：多個 H1 沒有問題（2019-10-03）：https://www.youtube.com/watch?v=zyqJJXWk0gk

**4 圖片**
- Image SEO best practices（2026-03-02，含偏好圖片的新增說明）：https://developers.google.com/search/docs/appearance/google-images
- Image sitemaps（2025-12-10）：https://developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps
- Get on Discover（2026-03-09）：https://developers.google.com/search/docs/appearance/google-discover
- Article 結構化資料（圖片比例與像素）：https://developers.google.com/search/docs/appearance/structured-data/article
- Optimize LCP（web.dev，2025-03-31）：https://web.dev/articles/optimize-lcp
- Image performance（web.dev，decoding 屬性）：https://web.dev/learn/performance/image-performance
- 瀏覽器支援（webstatus.dev）：fetchpriority https://api.webstatus.dev/v1/features/fetch-priority ；AVIF https://api.webstatus.dev/v1/features/avif ；WebP https://api.webstatus.dev/v1/features/webp ；sizes=auto https://api.webstatus.dev/v1/features/sizes-auto
- Meta：Images in Link Shares：https://developers.facebook.com/docs/sharing/webmasters/images/
- Next.js Image（16 起 `priority` 改為 `preload`）：https://nextjs.org/docs/app/api-reference/components/image
- WordPress 6.3 圖片效能改進：https://make.wordpress.org/core/2023/07/13/image-performance-enhancements-in-wordpress-6-3/
- Shopify `image_url`（自動選擇 WebP／AVIF）：https://shopify.dev/docs/api/liquid/filters/image_url
- Cloudflare Images 計價（免費每月 5,000 個不重複轉換）：https://developers.cloudflare.com/images/pricing/
- avifenc 說明：https://github.com/AOMediaCodec/libavif/blob/main/doc/avifenc.1.md
- `@squoosh/cli` 不再維護：https://www.npmjs.com/package/@squoosh/cli
- （業界，Chrome 團隊成員的個人文章）decoding 屬性實際做了什麼：https://www.tunetheweb.com/blog/what-does-the-image-decoding-attribute-actually-do/
- （業界）LINE Page Poker 於 2025-06-02 關閉：https://iseeu.tw/line-page-poker/

**5 連結**
- Link best practices（2025-12-10）：https://developers.google.com/search/docs/crawling-indexing/links-crawlable
- Qualify outbound links（2025-12-10）：https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links
- nofollow 改為提示（2019-09）：https://developers.google.com/search/blog/2019/09/evolving-nofollow-new-ways-to-identify

**6 速度**
- Core Web Vitals 門檻（web.dev，2025-05-07）：https://web.dev/articles/defining-core-web-vitals-thresholds
- INP 成為 Core Web Vitals（2024-03-12）：https://web.dev/blog/inp-cwv-launch
- TTFB（web.dev）：https://web.dev/articles/ttfb
- Understanding page experience（2026-09-22）：https://developers.google.com/search/docs/appearance/page-experience
- CrUX BigQuery（2026-10-13）：https://developer.chrome.com/docs/crux/bigquery
- CrUX 方法說明（2025-09-09，月表只含每月最後 28 天）：https://developer.chrome.com/docs/crux/methodology/tools
- CrUX API（2026-10-13）：https://developer.chrome.com/docs/crux/api
- CrUX History API（2025-04-11）：https://developer.chrome.com/docs/crux/history-api
- CrUX 發布紀錄：https://developer.chrome.com/docs/crux/release-notes
- PageSpeed Insights API：https://developers.google.com/speed/docs/insights/v5/about ；https://developers.google.com/speed/docs/insights/v5/get-started
- Google Fonts CSS2 API（`display`、`text=`）：https://developers.google.com/fonts/docs/css2
- Google Fonts 切片載入說明：https://developers.googleblog.com/google-fonts-launches-japanese-support/
- Next.js Font（`display` 預設 swap）：https://nextjs.org/docs/app/api-reference/components/font
- Cloudflare 停用清單（Auto Minify 2024-08-05）：https://developers.cloudflare.com/fundamentals/api/reference/deprecations/

**7 頁面基本盤**
- Favicon in Search：https://developers.google.com/search/docs/appearance/favicon-in-search
- Interstitials and dialogs：https://developers.google.com/search/docs/appearance/avoid-intrusive-interstitials
- WCAG 2.2（2.5.8 目標尺寸最低標準）：https://www.w3.org/TR/WCAG22/
- Android 無障礙（48dp 點擊區）：https://developer.android.com/guide/topics/ui/accessibility/apps
- Lighthouse 12.0.0（tap-targets 改為無障礙的 target-size）：https://github.com/GoogleChrome/lighthouse/releases/tag/v12.0.0
