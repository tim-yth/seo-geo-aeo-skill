# 事件字典（範本）

> 每新增或修改一個事件就更新這張表，並在 `logs/changes.md` 記「量測 D0」。
> 「不代表什麼」欄是必填：它防止半年後有人把事件名稱望文生義。
> 「上線後檢查」欄寫隔天查到的非空比例、unknown 占比與對帳結果；沒查過就寫「未查」，不能把「量測完成」打勾（`references/01` 第 1 節）。

| 事件名稱（≤40 字元） | 語意（什麼時候觸發） | 不代表什麼 | 參數白名單（列舉值） | 送出位置（檔案／後端） | 上線 D0 | 上線後檢查 | GA4 已註冊自訂維度 | 關鍵事件 |
|---|---|---|---|---|---|---|---|---|
| `seo_landing_view` | 頁面載入一次，標記頁型 | 使用者有閱讀 | `surface`=home/seo_tool/blog_article/blog_category/hub/entity；`page_type`；`page_language`（例：zh-TW、en） | 共用 layout JS | | 非空比例：<…>；unknown：<…> | ☐ | 否 |
| `tool_start` | 主要動作請求送出 | 使用者看到按鈕 | `surface`、`page_type`、`page_language`、`placement`=opening_box/hub_hero/sticky_bar/end_cta/direct | | | | ☐ | 否 |
| `tool_completed` | 成功結果開始呈現 | 使用者讀完／滿意 | `surface`、`page_type`、`page_language` | | | | ☐ | 是 |
| `tool_failed` | 請求失敗 | 所有離站原因 | 同上＋`failure_code`=auth/validation/quota/upstream/internal/client | | | | ☐ | 否 |
| `<流程>_started`／`_completed`／`_failed`／`_return_failed` | 跳到站外再回來的流程（第三方登入、付款）各階段 | 使用者放棄的原因 | `method`、`failure_code` | | | 開始數 = 完成＋失敗＋返回失敗？差額就是查不到的人 | ☐ | 否 |
| `sign_up` | 帳號建立成功 | 信箱已驗證 | `method` | | | | ☐ | 是 |
| `checkout_start` | 開始結帳；同時把瀏覽器的 GA4 client_id、session_id 存進訂單 | 會付款 | `purchase_type` | 前端＋後端訂單 | | | ☐ | 否 |
| `purchase` | 伺服器確認收款 | 前端按下付款 | `value`、`currency`、`transaction_id`、`purchase_type` | 後端 Measurement Protocol（帶回原工作階段的 client_id、session_id） | | 逐筆對帳：<N 筆中 M 筆在 GA4、重複 <n>、孤兒 <n>>；購買吻合率 <…> | ☐ | 是 |

## 禁止送出
- 使用者輸入文字、email、UID、姓名、電話、答案內容、requestId、原始錯誤訊息、完整 URL query。
- 和 gtag 內建欄位或 GA4 保留欄位同名的參數：`language`（頁面語系一律用 `page_language`；或 `content_language`，全站擇一）、`source`、`medium`、`campaign`、`term`、`content`、`page_location`、`page_referrer`、`page_title`…。案例送了 `language`，值被寫進 `device.language`，`event_params` 裡 0 筆；送了 `source`，報表冒出假的推薦來源。
- 網址本身也會被送出：回跳網址上的 session、token、email 參數，要在分析腳本載入前清掉；使用者輸入不經網址傳遞（`references/06` 第 3b 步）。

## 計算規則
- 漏斗：依序到達（GA4 Funnel）或 BigQuery 以 `user_pseudo_id + ga_session_id` 聚合；不得用事件總數相除。
- 失敗用暴露率；失敗與成功不互斥。
- D0 前的空值不是 0 使用。
- 語系值只在一個共用函式裡對應（例：`zh-Hant`、`zh-Hant-TW` → `zh-TW`），每個送事件的模組都呼叫它；上線後逐事件看 unknown 占比。
- 上線隔天逐一查每個自訂參數的非空比例；任何一個是 0，先懷疑撞名，改名後重記量測 D0。
- 購買吻合率＝GA4 找得到（BigQuery 與 Data API 都有）的伺服器付款筆數 ÷ 伺服器付款筆數；另查重複與孤兒。
- 同時觸發的兩個事件（例：解鎖完成、回站恢復結果）只取一個或去重，不能相加。
- 新增事件後，另算一個只用舊事件的同口徑版本，不要把新事件的計數當成提升。
