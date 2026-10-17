# LineBridge 社群（OpenChat）圖片取回與自動化指南

> 本文件為本 fork 的補充說明，**非 ryantsai/LineBridge 官方文件**。
> 內容以 LineBridge **v0.7.16**（Windows x64 可攜版）實測整理（測試日期：2026-10-17），
> 不含任何帳號、聊天室或訊息資料，可直接公開。

---

## 1. 動機：為什麼要用非官方路徑

LINE 官方 API（Messaging API 等）僅涵蓋官方帳號自身的對話，**沒有社群（OpenChat／Square）介面**，因此「用官方 API 抓社群圖片」不可行。

LineBridge 是模擬 LINE 用戶端登入的非官方橋接程式，社群圖片在 LINE 內部是一個 **OBS 物件**：

- 下載路徑：`https://obs.line-apps.com/r/g2/m/<訊息ID>`
  （**社群用 `g2`**；個人聊天用 `talk`，混用會取得 404）
- 必要條件：帶「該帳號登入後的 access token」發送請求（`x-line-access` header）
- 社群圖片**不需要** Letter Sealing／E2EE 金鑰（那是個人聊天圖片才需要）
- 這些 URL **不是公開網址**：沒有 token 一律被拒絕

LineBridge 已內建這條路（SDK 的 `obs.downloadMessageData({ messageId, isSquare: true })`），
對外由 CLI `media`、HTTP API 與 MCP `line_read_image` 提供。

## 2. 前置條件

1. LineBridge 服務執行中（`linebridge.cmd status` → `"status":"running"`）。
2. 目標社群已**啟用監聽**（被指定）：圖片訊息必須已被封存，`media` 才取得到。
3. 具備該聊天室的**讀取權限**（managed profile 或對應 read grant）。

## 3. 單張取回

### CLI

```powershell
.\linebridge.cmd media --profile PROFILE --account ACCOUNT --chat CHAT `
  --message MESSAGE_ID --output .\out\IMAGE_ID.bin
```

- `--output` 只會**建立新檔、絕不覆寫**；既有檔案會直接失敗，所以檔名建議直接用訊息 ID，即天然去重。
- 成功時輸出 JSON，含 `kind`、`mimeType`、`width`、`height`、`bytes`、`sha256`、`path`、`visionInvoked:false`。
- 依回傳 `mimeType`（`image/png`／`image/jpeg`）決定副檔名。
- 語音訊息（`kind:"audio"`，M4A/3GP）同指令可取，不轉檔、不轉文字。

### HTTP

```text
GET /api/v1/accounts/{id}/chats/{chatId}/messages/{messageId}/media
```

回應為 JSON（`data` 為 base64 與 metadata）。需帶 Bearer token；**不要把 token 寫進 URL、指令或版本庫**。

### MCP

`line_read_image`（`accountId`、`chatId`、`messageId`）：回傳 image content block 與 metadata，適合能看圖的模型；一次一張。

## 4. 自動化：批次抓取已封存的社群圖片

LineBridge **沒有**內建批次或自動下載（無伺服器端媒體快取、不自動重試）。
做法是在外部以「輪詢封存 → 逐張取回」組成迴圈，**不需要修改 LineBridge**：

1. 以 `events` 讀取本機封存（不會觸發 LINE 讀取、不送已讀；每頁上限 100 筆，cursor 續傳）：

```powershell
.\linebridge.cmd events --profile PROFILE --account ACCOUNT --after CURSOR --limit 100
```

2. 每筆事件含 `chatKind` 與 `message.media.kind`；篩出 `chatKind = "openchat"` 且 `kind = "image"`。
3. 對每張呼叫 `media`，輸出檔名用 `message.id`。
4. 保存回傳 `cursor`，下次以 `--after CURSOR` 續傳；首次回填時以 100 筆為一頁迴圈直到不滿一頁。
5. 以作業系統排程器（例如 Windows 工作排程器）定期執行；建議間隔縮短（例如 1–5 分鐘），
   因為 LINE 端 OBS 物件可能過期。

PowerShell 骨架（示意）：

```powershell
$lb      = 'PATH_TO_BUNDLE\linebridge.cmd'
$profile = 'PROFILE_NAME'
$account = 'ACCOUNT_ID'
$outDir  = 'OUTPUT_DIR'
$state   = Join-Path $outDir 'cursor.txt'
$cursor  = if (Test-Path $state) { [int](Get-Content $state) } else { 0 }

$events = & $lb events --profile $profile --account $account --after $cursor --limit 100 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'events failed; keep cursor and retry later' }

foreach ($e in $events.events) {
  $cursor = $e.sequence
  if ($e.chatKind -eq 'openchat' -and $null -ne $e.message.media -and $e.message.media.kind -eq 'image') {
    $file = Join-Path $outDir ($e.message.id + '.img')
    if (-not (Test-Path $file)) {
      & $lb media --profile $profile --account $account --chat $e.chatId `
        --message $e.message.id --output $file | Out-Null
    }
  }
}
Set-Content -Encoding ascii $state $cursor
```

> 實務請自行加上：錯誤重試策略、依 `mimeType` 改副檔名、多頁迴圈、
> 以及注意 `events` 輸出含私人對話文字（僅取 ID／類型欄位，避免落盤或外傳）。

## 5. 常見錯誤判讀

同一張社群圖片的實測對照：

| 嘗試方式 | 結果 | 說明 |
| --- | --- | --- |
| 直接開啟 OBS 原圖 URL（無 token） | `403` | 非公開資源；無權者被拒。**不代表圖片不存在** |
| 直接開啟 `object_info.obs`（無 token） | `403` | 同上 |
| 以 `talk` 路徑開啟社群圖片 | `404` | 路徑 namespace 錯誤；社群必須用 `g2` |
| 訊息 ID 錯／物件已被 LINE 清除 | `404` | 找不到物件 |
| 經 LineBridge `media`（帶帳號 token） | `200` 成功 | 正確做法 |

> 重點：**不能從雲端或另一台電腦直接抓 URL**。必須在「跑著 LineBridge、
> 且該 LINE 帳號已登入的電腦」上取回；token 由 LineBridge 保管。

LineBridge 自身的錯誤碼（與 OBS 無關）：

- `media_not_archived`（HTTP 404）：該訊息不在本機封存。確認圖片到達時服務是否在跑、聊天室是否已指定、account/chat 是否正確。
- `media_metadata_missing`（HTTP 409）：舊版封存的紀錄缺媒體描述子；不會自動補或重新抓取。
- `media_too_large`（HTTP 413）：超過 1 MiB。
- `media_unsupported`（HTTP 415）：非 PNG/JPEG，或動圖／影片等不支援格式。
- `media_unavailable`（HTTP 502）：LINE 端拒絕或物件已過期。

## 6. 已知限制

- 僅 **PNG/JPEG**：單張下載上限 **1 MiB**、邊長 ≤ 8192 px、≤ 16 MP；**GIF/WebP/動圖/影片不支援**；
  過大的原圖直接失敗（不會縮圖、不會改抓預覽）。
- 只有**已封存**的訊息可取回；未監聽期間的訊息能否補回取決於 LINE replay 與 reconciliation，不保證完整。
- 取回對象是 LINE 端 OBS 物件；**物件過期／被清除後即無法取回**（`media_unavailable`），建議即時抓取。
- 一次一張、無快取、無自動重試；同帳號操作在服務內序列化（佇列上限）。
- managed profile 有到期日（建立時 90 天）；排程自動化需處理續期（由設定精靈重新確認）。
- OpenChat 屬**實驗性**、非官方協定；LINE 端調整可能使其失效。

## 7. Windows 疑難排解：服務無法啟動（`listen EACCES`）

若 `serve` 啟動失敗並出現 `listen EACCES: permission denied 127.0.0.1:3210`，
通常是 Windows NAT 驅動（`winnat`，Hyper-V／WSL／Docker 使用）保留了服務埠段。

檢查：

```text
netsh interface ipv4 show excludedportrange protocol=tcp
```

若 3210/3211 落在保留範圍內，正確處理順序（需系統管理員權限）：

1. 提權執行 `net stop winnat`
2. 啟動 LineBridge 服務（先綁上埠）
3. 提權執行 `net start winnat`

**順序不可顛倒**：先重啟 `winnat` 再啟動 LineBridge，服務埠會再被保留。
（重開機後若 WSL／Hyper-V 較早啟動，問題可能重現，重複上述步驟即可。）

## 8. 隱私與安全提醒

- 取回的圖片是**私人聊天內容**：不要上傳到公開儲存庫、雲端硬碟或第三方服務。
- 不要把資料目錄（`bridge.sqlite`、`vault-key.*`、`service.json`）、CLI profile、
  token、日誌或任何下載的媒體檔提交到版本庫。
- 匯出的檔案用完即刪；本機檔案權限依 OS 帳號設定。
- `events`／`read`／`search` 的輸出含私人對話文字，自動化請只取必要欄位。

## 9. 實測摘要（v0.7.16, 2026-10-17）

- 社群圖片經 `media` 取回：**成功**（含 3 天前的舊圖），單張約 200 KB 的 JPEG 二進位完整、可正常解碼。
- 本機封存中的社群圖片全數具備媒體描述子（可逐張取回）；貼圖（sticker）亦可取靜態預覽。
- 無 token 直連 OBS：`403`；錯用 `talk` 路徑：`404`；經 LineBridge：成功——與第 5 節對照表一致。
