# SPIKE LAB（妖球排球）— 每輪必讀

2–8 人網頁排球對戰。TypeScript monorepo（npm workspaces）：`packages/shared`（同構純函數＋wire 型別）、`packages/server`（Colyseus 0.16 權威伺服器）、`packages/client`（Vite + Three.js）、`tools/latency-bot`（無頭驗證機器人）。設計書＝`spike_lab_spec_v0.2.md`；每輪迭代規格在 `docs/m2.*_spec.md`（最新編號＝現況權威）。

## 開發協作模式（使用者指定，恆常有效）
- 主迴圈（Fable）只當 orchestrator：親寫規格拍板設計 → 派工 subagent → 整合裁決。不親自實作。
- 推理型任務 → Opus；機械型任務 → Sonnet；codex（GPT）＝peer，用於對抗式審查與獨立第二意見（尤其物理/netcode 改動後）。
- 每輪流程：orchestrator 寫 `docs/m2.X_spec.md`（含精確 wire 契約，使 server/client 代理可並行）→ WP 分包 → 整合驗證代理跑全套 → 必要時 codex 唯讀審查 → 修 confirmed 缺陷。
- Subagent 回報限 6–10 行。破壞舊協定完全允許（無既有部署），不做向後相容。

## 架構鐵律（違反必產 bug，全部有測試守門）
1. **球軌跡＝純函數**：球不進 Colyseus schema。一切球運動由 `BallLaunch` 參數包＋經過時間唯一決定；碰網/反彈＝伺服器生成新參數包廣播。雙端各自演算、零漂移。
2. **座標轉換只有一個入口**：移動＝shared `moveToWorld(move, side, yaw)`（yaw=null 第三人稱 side 鏡像；有值＝FPV）。發球瞄準＝server `serveAim.ts serveHorizontalDir`（+θ→+X 系）。**瞄準與移動是兩套約定，禁止混用**；渲染鏡像只准存在渲染層。詳見 knowledge/coordinate-systems.md。
3. **判定時刻＝出手時刻**：TouchIntent.clientTime＝放開 H 的瞬間，伺服器延遲補償回溯裁決。
4. 常數一律進 `shared/constants.ts` 或 client `config.ts`／`characterConstants.ts`，禁止魔法數字；檔案 <400 行。
5. 玩法常數（判定門檻）與視覺常數（如 VISUAL_BALL_RADIUS）嚴格分離，調視覺不得動判定。

## 指令與驗證閘（每輪收工前全綠才算完成）
```
npm run dev                         # server + client（LAN: client 開 --host，朋友連 http://<LAN-IP>:5173）
npm test -w @spike/shared           # shared vitest（11 檔，~150+ 測試）
npm run serve|smoke|integration -w @spike/server  # tsx 執行；smoke/integration 需 live server（SPIKE_ENDPOINT 可覆寫，預設 ws://127.0.0.1:2567）
npx tsx packages/server/test/jitter.ts            # 自起 server 於 2599；JITTER_ASSERT=1 啟用平滑斷言
npm test -w @spike/client           # 相機/瞄準/揮擊 真值表守門（cameraBasis.test.ts，14 測試）
cd tools/latency-bot && npm run latency-test -- --probe all   # netcode 改動後必跑
typecheck ×3 + vite build
```
收工必殺自己起的 server 程序（埠 2567 留空）。主機 LAN IP＝192.168.10.121（避開 Radmin 26.x 介面卡）。

## 除錯鐵則（血淚教訓）
- **運動/抖動/方向類 bug：先數值復現再修**。推理修法會治錯層（已發生兩次）。用既有 harness：jitter.ts（走路平滑）、cameraBasis.test.ts（四 artifact 螢幕方向真值表）。
- headless 測試必須涵蓋「殘留狀態」（stale yaw、上一局殘留），只測乾淨狀態會漏。
- 症狀在 A 不代表病根在 A：鏡像類 bug 常是兩層符號互相補償，禁止局部翻符號了事。

## 情境知識庫
每輪開工先讀 **`docs/knowledge/INDEX.md`**，依當輪任務類型從索引挑對應知識檔讀取（座標系、netcode、玩法規則、視覺、測試、慣犯清單）。新知識一律寫進 docs/knowledge/ 並登錄於 INDEX.md，不要回頭加長本檔。
