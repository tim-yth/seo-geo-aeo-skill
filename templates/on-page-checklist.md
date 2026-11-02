# 頁面基本功檢查表｜{網址或模板名稱}

> 用法：新模板、新頁型上線前，換框架或佈景主題後，或每季健檢時，複製這份到 `.seo-agent/logs/reviews/<日期>-onpage-<頁型>.md` 逐項打勾。單篇文章上線用 `templates/pre-launch-checklist.md`。
> 一個模板抽 3 頁（流量最大、內容最長、最新）就夠；三頁結果不同時，問題多半在內容而不是模板。
> 門檻與理由見 `references/16-on-page-fundamentals.md`（下文的「16-1」＝第 1 節）；title、描述的長度規範以 `references/09-ctr-titles-snippets.md` 第 3.1 步為準。
> 打不了勾的項目寫進最後的「需決定」，不要硬上線。

- 網址：{https://www.example.com/...}
- 頁型：{首頁／工具頁／hub／文章／商品／分類／其他}　模板檔：{原始碼路徑}
- 檢查日期：{YYYY-MM-DD}　檢查者：{代理名稱或人名}　對應波次：{W-…，沒有就留空}
- 使用的資料：crawl `{data/crawl/<日期>-crawl-pages.csv}`、pagespeed `{data/pagespeed/<日期>-pagespeed.csv}`、image-audit `{輸出檔}`

```bash
node scripts/crawl-site.mjs --urls-file onpage-urls.txt --name onpage
node scripts/content-audit.mjs --from-crawl .seo-agent/data/crawl/<日期>-onpage-text.jsonl
node scripts/image-audit.mjs --help
node scripts/pagespeed.mjs --from-file onpage-urls.txt
```

## A. 網址（16-1）

- [ ] 全小寫；用連字號分詞；沒有底線、空白、`--`
- [ ] slug 3–5 個字、≤60 字元，描述這頁的主字
- [ ] 沒有年份（內容本身綁年份的除外）、流水號、亂碼片段、追蹤參數、Session ID
- [ ] 層級反映 hub；離根目錄 ≤3 層；會變動的分類、標籤不在路徑裡
- [ ] 尾斜線、副檔名符合本站規則：{目錄型頁加斜線／文章不加／無副檔名}
- [ ] 大寫版、另一種尾斜線、`.html` 版都一次 301 到這個網址（指令結果貼在「證據」）
- [ ] 站內沒有另一個同意圖的 slug（查過 `keyword-map.csv` 與 sitemap）
- [ ] slug 慣例和全站一致：{英文／中文（已百分比編碼）／拼音}
- [ ] （只在改網址時）舊網址 GSC 16 個月點擊很少；canonical、og:url、JSON-LD、麵包屑、hreflang、sitemap、llms 文件、站內連結都已換新；舊網址一跳 301；已記 D0（`--kind redirect`）

## B. title 與描述（16-2）

- [ ] title 全站唯一；中文含品牌 ≤32 個全形字（`crawl-site` 寬度 ≤64；它超過 65 才標過長）；英文約 ≤60 字元
- [ ] title 前 12 字（英文前 30–40 字元）有主要意圖詞；品牌在尾端、分隔符和全站一致
- [ ] 沒有全站共用的後綴；長青內容沒有年份；分頁第 2 頁起有「第 N 頁」
- [ ] 描述全站唯一；中文 50–80 個全形字（英文約 120–155 字元）；答案先行
- [ ] 描述的每一句都在頁面上找得到；免費條件、價格和產品一致
- [ ] title 和 H1 主字一致（不必一字不差）；站內沒有另一頁的 title＋H1 和這頁相同
- [ ] og:title、twitter:title、JSON-LD headline、麵包屑最後一項已同步

## C. 標題層級（16-3）

- [ ] 原始 HTML 恰好 1 個 H1，說出這頁的主要意圖
- [ ] 一般 UA、Googlebot UA、JS 執行後的 H1 相同；語言和 `<html lang>` 一致
- [ ] 每個 H2 只負責一個子意圖；H2 底下第一段先用 1–2 句回答
- [ ] H3 都在 H2 底下；沒有跳級（`content-audit` 的 `heading-skip`＝0）
- [ ] 選單、側欄、頁尾、logo（首頁以外）沒有用 H1；卡片標題沒有用一堆 H2
- [ ] 標題不堆字、不重複、沒有佔位字（`headings-stuffed`、`heading-duplicate`＝0）
- [ ] FAQ（有的話）：一個 H2「常見問題」＋每題 H3；和 FAQPage 結構化資料逐字一致
- [ ] 長文（≥4 個 H2）有目錄；錨點 `id` 是短英文；固定導覽列有 `scroll-margin-top`

## D. 圖片（16-4）

- [ ] 照片、封面用 WebP（或 AVIF）；圖示用 SVG；沒有 PNG 照片、GIF 動畫
- [ ] 檔案大小：首屏主圖 ≤150–200KB（手機版 ≤100KB）、內文圖 ≤100KB、縮圖 1× ≤30KB／2× ≤50KB
- [ ] 檔案寬度不超過顯示寬度的 2 倍；寬度會變的圖有 `srcset`＋照實際版面寫的 `sizes`
- [ ] 每張 `<img>` 都有 `width`、`height`；CSS `height:auto`；iframe、廣告、嵌入有預留高度
- [ ] LCP 圖：寫在 HTML 的 `<img>`、沒有 `loading="lazy"`、有 `fetchpriority="high"`；全頁 high 的圖 ≤2 張
- [ ] LCP 圖在其他網域時，有 `preconnect`；LCP 是 CSS 背景或 JS 插入的圖時，已改成 `<img>` 或加了 preload
- [ ] 首屏以外的圖都是 `loading="lazy"`；沒有只有 `data-src`、沒有 `src` 的圖
- [ ] 沒有 `src=""`，也沒有 `src` 指向網頁網址
- [ ] 檔名和網址同一種慣例、描述內容；不同尺寸同一個主名加寬度
- [ ] alt：內容圖描述內容與作用；文字圖寫圖上的字；連結圖寫目的地；裝飾圖 `alt=""`；沒有全站同一句、沒有堆字；渲染後的 alt 和原始 HTML 一樣（沒被 JS 改寫）
- [ ] og:image：1200×630、絕對網址、有寬高與 alt；不是 logo、不是滿滿文字的圖
- [ ] 結構化資料（logo、image）、og:image、圖片 sitemap 引用的圖都回 200
- [ ] 需要大圖預覽的頁有 `max-image-preview:large`；Article／Product 的 `image` 有 16:9、4:3、1:1
- [ ] 換過的圖：有圖片搜尋流量的舊網址已 301；og:image、JSON-LD image、圖片 sitemap 已同步

## E. 連結與錨文字（16-5）

- [ ] 沒有「點這裡」「這裡」「更多」「閱讀更多」這類錨文字；卡片的標題本身是連結
- [ ] 正文有 3–5 條情境連結，錨文字說出目的地、長度適中
- [ ] 站內連結都連到最終網址：0 條經過轉址、0 條帶 `utm_`、0 條 `.html` 變體、尾斜線一致
- [ ] 導覽都是 `<a href>`；沒有 `onclick`、`href="#"`、`javascript:` 的導覽
- [ ] 付費、贊助、聯盟連結 `rel="sponsored"`；使用者內容 `rel="ugc"`；站內連結沒有 nofollow
- [ ] 站內斷鏈 0 條；外部連結可查證、和主題相關
- [ ] 可見麵包屑每一層都連到正式 hub，和 BreadcrumbList 一致
- [ ] 語言切換連到另一語系的對應頁

## F. 速度（16-6）

| 裝置 | 資料來源（`field_source`） | LCP p75 | INP p75 | CLS p75 | TTFB p75 | 判定 |
|---|---|---|---|---|---|---|
| 手機 | {url／origin／none} | | | | | {良好／需改善／不良} |
| 桌機 | {url／origin／none} | | | | | |

- [ ] 判定用欄位資料；`field_source=origin` 已註明「整個網域的數字，不是這頁」
- [ ] 門檻（p75）：LCP ≤2.5 秒、INP ≤200 毫秒、CLS ≤0.1；TTFB ≤0.8 秒（輔助）
- [ ] 實驗室數字只用來找原因，記下條件：{機房／裝置設定／是否壓縮／是否擋分析碼／5 次中位數}
- [ ] HTML 回應有 Brotli 或 gzip；快取標頭符合規則（HTML `max-age=0, must-revalidate`；有雜湊的資產 `immutable`）
- [ ] 沒有阻擋算繪的大型 CSS／JS；JS 有 `defer` 或 `type="module"`；沒有用不到的大型程式庫
- [ ] 第三方標籤都有在用、都非同步載入；沒有會把整頁藏起來的 A/B 測試防閃爍程式
- [ ] 字型：中日韓字型沒有整套預載；字型 CSS 非阻擋載入（preload＋onload，附 noscript）；有 `font-display`；字重 ≤2；或內文直接用系統字型
- [ ] 第一屏的 H1 與主要內容排在登入、同意、彈窗元件之前；這些元件有預留高度
- [ ] 跑 Lighthouse 時擋掉分析碼與廣告像素，測試流量沒有進 GA4
- [ ] 分析碼沒有被延後載入；若有：已記 `--type measurement`，並按頁群在改動前後各算一次「GA4 page_view ÷ 伺服器或 CDN 的 HTML 瀏覽」與「GA4 自然 session ÷ GSC 點擊」（`01`）
- [ ] 原始 HTML 大小：{KB}（遠小於 2MB）；列表頁有分頁

## G. 頁面基本盤（16-7）

- [ ] `<html lang>` 等於 hreflang 用的代碼；JS 執行前後不變
- [ ] `<meta charset="utf-8">` 在 `<head>` 最前面；viewport 是 `width=device-width, initial-scale=1`，沒有禁止縮放
- [ ] canonical：絕對網址、自我指向、只有一個、在原始 HTML；和 og:url、JSON-LD url、麵包屑最後一項相同
- [ ] robots：該被收錄的頁沒有 noindex；沒有兩個外掛各輸出一組 canonical 或 OG
- [ ] og:title、og:description、og:url、og:image、og:type、og:site_name、og:locale、twitter:card 齊全
- [ ] `/favicon.ico` 回 200；有方形、大於 48×48 的圖示；有 apple-touch-icon
- [ ] 結構化資料能解析、和畫面一致；型別仍有效（`11`、`15` 第 15 節）
- [ ] 有 `<main>`（一個）、`<nav>`、`<footer>`；輸入框有 label、按鈕有可讀的名稱
- [ ] 390px 與 320px 寬沒有橫向捲動；表格有捲動容器；內文字 ≥16px（輸入框也是）
- [ ] 按鈕與連結點擊區 ≥48×48（至少 24×24），彼此有間距
- [ ] 第一屏看得到 H1 和主要動作（工具頁：輸入框）；沒有蓋住主要內容的彈窗（第一屏與 CTA 的轉換面檢查見 `references/17-sxo-search-landing-conversion.md`）
- [ ] 全站 HTTPS、沒有混合內容
- [ ] 文章的發布、更新日期和 `datePublished`／`dateModified` 一致，沒有假更新
- [ ] 截圖已存：改前／改後 390×844 整頁、1280×800 第一屏

## 證據

| 項目 | 結果 | 證據（指令與輸出、檔案路徑、截圖） |
|---|---|---|
| 網址各種寫法 | | `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' …` |
| crawl-site issues | | `data/crawl/<日期>-onpage-issues.csv` |
| content-audit 標題層級 | | |
| image-audit | | |
| pagespeed／CrUX | | `data/pagespeed/<日期>-pagespeed.csv` |
| 原始 H1 與渲染後 H1 | | Googlebot UA 的 curl 結果、截圖 |
| 手機截圖 | | |

## 需決定

| 項目 | 為什麼打不了勾 | 選項 | 建議 | 誰決定 |
|---|---|---|---|---|
| | | | | |

## 上線後

- [ ] 正式站重跑 A、C、D、E 的檢查（部署前檢查過不等於正式站正確）
- [ ] `node scripts/log-change.mjs add` 記 D0：模板改動 `--kind template`（全站共用加 `--site-wide`）；效能改動 `--kind technical --checkpoints 7,14,28,42`；轉址 `--kind redirect`；分析碼載入方式改變 `--type measurement`
- [ ] 有新網址或改網址：`node scripts/indexing.mjs indexnow`、`node scripts/indexing.mjs sitemap-submit`；D+7 用 `indexing.mjs inspect` 看 Google 選的 canonical
- [ ] 效能改動：在 `logs/changes.md` 寫下 CrUX 的改前窗（結束於 D−1）與改後窗（從 D+1 起 28 天），以及預計可以驗收的日期
