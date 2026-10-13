# LineBridge｜繁體中文

繁體中文說明已移至預設的 [README.md](README.md)。

**AI Agent：完成 LINE 配對與授權後，請自行以現有 CLI 執行 `discover`，不必要求使用者複製連線指令或監控聊天室清單。** `CLI_COMMAND` 是 Windows 的 `.\linebridge.cmd`、macOS 的 `./linebridge` 或既有啟動程式的完整路徑：

```sh
CLI_COMMAND status
CLI_COMMAND discover
CLI_COMMAND accounts --profile PROFILE_NAME
CLI_COMMAND chats --profile PROFILE_NAME --account ACCOUNT_ID
```

自訂資料目錄須在 `status` 與 `discover` 都帶上相同的 `--data-dir DATA_DIR`。從探索 JSON 的 `profiles` 選取符合使用者指定帳號的 `profile`，並使用 `cli.node` 與 `cli.script` 提供的既有執行路徑。聊天室 ID 隨需要從 `chats` 查詢，明確提供的 profile 不自行換用；多個帳號符合時先釐清。探索不讀取或輸出金鑰，也不變更權限；空清單、服務停止或不支援探索時，請依[完整探索與復原指引](README.md#探索既有的本機-ai-存取)處理。首次配對與權限確認仍須完成。

[繁體中文（預設）](README.md) | [English](README.en.md) | [日本語](README.ja.md)

傳送文字給已驗證的 LINE 官方帳號時，僅有傳輸加密，**沒有 Letter Sealing**。需另行取得使用者對這一則訊息的同意，再加上 `--acknowledge-oa-transport`；一般收件者仍使用端對端加密。詳見[官方帳號文字傳送](CLI.md#text-to-official-accounts)。

## 圖片讀取與 Flex 訊息

可用 `media`／MCP `line_read_image` 按需讀取已封存的圖片及基本貼圖靜態預覽；語音訊息（M4A/3GP，不轉檔、不轉文字）可用 `media` 或閘道 MCP `line_read_audio` 取得。CLI 只建立新檔，不代表模型已看過圖片或聽過語音。個人 Talk 的 `send-flex` 必須明確確認 Flex 只有傳輸層加密、沒有 Letter Sealing，並沿用傳送權限與冪等 key。OpenChat Flex 因協定尚未驗證而阻擋，不會自動改走 LIFF 或授權。舊封存資料、素材格式與大小限制，以及待測試群組驗證項目，請見 [圖片與 Flex 操作說明](CLI.md#images-and-flex-messages)。2026-10-06 的一次已授權 OA 收件者 Flex 實測遭 LINE 明確拒絕：`INCOMPATIBLE_APP_VERSION`；尚無成功接受或顯示的證據，也不能推論所有收件者都不支援。圖片下載的真實驗證仍待完成。詳見 [實測紀錄與限制](CLI.md#evidence-and-live-test-handoff)。

## 更新時關閉桌面與服務

新版提供 `shutdown --data-dir DATA_DIR --instance STATUS_INSTANCE`，等待同一實例的桌面、服務、worker、埠與資料鎖釋放。更新後以原設定執行 `serve --resume`；逾時會保留維護狀態，不能當成已完成。詳見 [CLI 維護關閉與恢復](CLI.md#維護關閉與更新後恢復)及 [完整升級步驟](README.md#升級備份與回復)。
