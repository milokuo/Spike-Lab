# 測試 — 清單、如何跑、latency-bot 探針、除錯教義

## 0. 核心教義（血淚）

- **運動／方向／抖動類 bug：先數值復現，再修**。推理修法會治錯層——jitter 樓梯抖動被在錯的層
  修過兩次，直到實測 15cm/30Hz 才對症。用既有 harness：`jitter.ts`（走路平滑）、
  `cameraBasis.test.ts`（四 artifact 螢幕方向真值表）。
- **headless 測試必涵蓋殘留狀態**（stale yaw、上一局殘留、rejoin listener 重註冊），只測乾淨狀態會漏。
- 症狀在 A 不代表病根在 A：鏡像類 bug 常是兩層符號互補，禁局部翻符號。
- **改 netcode → 跑 latency-bot 全套；改視覺 → build + 逐項肉眼看**。

---

## 1. Shared 單元測試（Vitest）— `packages/shared/test/*.ts`

跑法：根目錄 `npm test`（＝`npm test -w @spike/shared`）或 `cd packages/shared && npm test`
（＝`vitest run --coverage`）。**這是唯一的 Vitest 套件**。11 檔，靜態約 152 個 it/test
（viewSpace/serveSweep 有迴圈生成，執行時略多；CLAUDE.md 寫「161+」是概數）。

| 檔 | 主題 |
|---|---|
| ballistics.test.ts | `ballPosition/ballVelocity` 決定性、閉式拋物線、`firstEvent` ground/net/out/none、`buildBallLaunch` 純度 |
| dig.test.ts | `digDistanceQuality`（1.0/0.7→1.5→2.2 折點）、`diveSuccessProbability`（0.8→0.2）|
| direction.test.ts | `resolveIntent` J/K/L：self-set、2v2 隊友瞄準、per-side 鏡像、unit 長度 |
| facing.test.ts | `initialFacing`(A→0,B→π)、`computeFacing` 優先序 |
| jump.test.ts | `startJump/stepJump`（boost 窗、gravity mult）、tap vs full-hold apex、`isLanded`、`jumpHoldStaminaCost` |
| net.test.ts | 接觸時間 t=−z0/vz、tape vs face、`NET_MIN_REBOUND_SPEED` floor、anti-jitter 不自碰、連鎖 |
| quality.test.ts | `fDistance`（0.5/1.2/1.8）、`fTiming`（60/150/300）、`chargeDistanceMult`、`overchargeQualityMult`（1→0.75→0.5）|
| reach.test.ts | `isWithinVerticalReach`（standing reach+margin、jumpY 延伸）|
| serveRotation.test.ts | first server A0、同分同發、首possession 不進位、side-out 進位、worked example、leaver 修正 3 例 |
| serveSweep.test.ts | `sweepAngleDeg` 三角波：週期 1600/800-800、端點 −90/+90、中相、真 modulo、界 [−90,90] |
| viewSpace.test.ts | `viewToWorld` per-side、`moveToWorld` yaw 四象限+yaw獨立+非有限退回、`wrapYaw` 範圍 |

## 2. Client 測試（Vitest）— `packages/client/test/cameraBasis.test.ts`（14 測）

跑法：`npm test -w @spike/client`（＝`vitest run`）。**相機/瞄準/揮擊 螢幕方向真值表守門**。
方法＝四 artifact 螢幕方向鏈，A/B 兩側、每 sweep 角：
1. **FPV 相機基底**：邏輯右→NDC x>0、邏輯左→x<0、pitch(±0.8) 不影響。驅動真正的
   `fpvForward` + `camera.lookAt`（與 `setFirstPerson` 同碼）。
2. **發球方向鏈（面網）**：`serveHorizontalDir`（世界真值）↔ 世界 protractor ↔ HUD 針
   （真正的 `needleVector`）↔ FPV 球 ↔ 第三人稱球，四者同螢幕側。用 `screenXSign`
   （相機 matrixWorld 第 0 欄）取號。
3. **yaw-aware 針**：±45/±90/±180°（殘留最壞）轉頭下，針與 FPV 球同側，且 `needle.x ≈ 真實
   camera-space x`（永不鏡像）。
4. **viewmodel 手臂 swing**：`armCameraSpaceDir(mirrorX=false)` 同球螢幕側；`mirrorX=true`
   （舊 buggy）反側（守門「鏡像須保持 OFF」）。

**動任一環先擴充此表。**

## 3. Server 測試 — `packages/server/test/*.ts`（tsx，非 vitest）

全用 **tsx** 啟動（不是 `node --loader`，CLAUDE.md 的 `node --loader tsx` 寫法不精確）。
手搓 `assert`/`failures` harness，`process.exit(failures===0?0:1)`。
**Wire 型測試讀 `SPIKE_ENDPOINT`（預設 `ws://127.0.0.1:2567`），不讀 `SPIKE_PORT`。**

| 檔 | script | 需 live server? | 涵蓋 |
|---|---|---|---|
| serve.ts | `npm run serve` | 否（純 in-process） | 10 測：地面vs跳發、角度決定性、弱發球判罰、網 face/tape、反彈保留 pre-bounce 歷史、yaw 移動、發球地面 clamp、過蓄品質、wire charge clamp |
| smoke.ts | `npm run smoke` | **是**（先起 2567） | lobby/start/clock、facing、charging、jump apex、發球速度、TouchResult 廣播、回球、計分模組 |
| integration.ts | `npm run integration` | **是** | 7 部：方向 e2e、WP2（mode-switch/dive）、1v1 lag-comp 決定性(ε1e-6)+laggy PERFECT、2v2 隊友 dig+觸球 cap、slots/rotation/mode 持久、map/captain、illegal_double |
| jitter.ts | `npx tsx test/jitter.ts` | 否（**自起** in-process 於 port 2599） | 走路平滑復現+回歸 |

- smoke/integration 先起 server（`npm run dev:server` 或 `cd packages/server && npm start`）。
  覆寫端點：`SPIKE_ENDPOINT=ws://host:port`。
- **jitter.ts**：自 boot 真 `MatchRoom`（port 2599 hardcoded），跑真 `LocalPlayer` 預測迴圈，
  穩定後退（move.y=−1）於 0ms 與 100ms RTT 各量 `MEASURE_MS=1200`。度量
  `maxBacktrackCm / perpMaxCm / stutterZeroFrames` 等。**`JITTER_ASSERT=1`** 時兩 RTT 皆檢：
  `maxBacktrackCm>0.5cm`、`perpMaxCm>0.5cm`、`stutterZeroFrames > frames×0.5` 任一違反即 `exit(1)`；
  否則印 `PASS steady-move smoothness`。無此環境變數則永遠 `exit(0)`。

## 4. latency-bot — `tools/latency-bot`（無頭驗證機器人）

跑法（**需 live server**，`--self-test` 除外）：`cd tools/latency-bot && npm install &&
npm run latency-test -- <flags>`（script＝`tsx src/index.ts`）。預設 `--url ws://0.0.0.0:2567`。
任一探針失敗 → `process.exitCode=1`。

**旗標**：`--url`、`--players 2|4`（4＝2v2）、`--probe all|matrix|jump-arc|dive|weak-serve|angle`、
`--latency/--latencies`（預設 [0,50,100,150]）、`--offset/--offsets`（預設 [0,50,120]）、
`--samples`(5)、`--timeout`(12000)、`--short-jump-frames`(2)、`--full-jump-hold-ms`、`--self-test`。

**探針**：
- **matrix**：latencies × offsets 表。rooms[1]（對側，發球後自觸會被判 illegal_double 故用對側）
  追可達接觸後 `planTouch(idealServerTime, offset)`，pass＝`accepted ∧ 實際 grade === gradeOf(effectiveDelta)`。
- **jump-arc**：短 tap vs full hold，`assertJumpArc` 拒絕 <6 樣本/teleport/rise<0.1/apex 在邊界/
  非單調；full apex 須 > short apex + `0.15`。
- **dive**：對側追到 ~`2.8u` off contact（落 `(DIG_REACH_MAX, DIVE_REACH_MAX]`），
  pass＝outcome dive_success|dive_fail。
- **weak-serve**：`WEAK_SERVE_CHARGE=0.05`，等 DeathEvent，pass＝`scoringSide === receiverSide`
  （弱發球自方落地→對手得分）。
- **angle**：`expectedAngle = sweepAngleDeg(release − phaseStart)`，比對 `serveHorizontalDir`
  （**故意用 serveAim 系，不是 `viewToWorld`**——見 pitfalls #6），pass＝角差 ≤ `6°`。
- **`--self-test`**（無 server）：本地驗 planTouch/clock offset/jump arc 驗收/dive outcome/
  發球方向（A→+Z, B→−Z; A +45°→+X, B +45°→−X）/`sweepAngleDeg(0)===−90`。

`--probe all`＝matrix + jump-arc + dive + weak-serve + angle 依序。

## 5. 收工驗證閘（全綠才算完成）

```
npm run dev                                    # server + client
npm test -w @spike/shared                      # shared vitest
npm test -w @spike/client                      # 真值表守門
npm run smoke|integration -w @spike/server     # 需先起 server (live)
npx tsx packages/server/test/serve.ts          # 純 in-process
JITTER_ASSERT=1 npx tsx packages/server/test/jitter.ts   # 走路平滑
cd tools/latency-bot && npm run latency-test -- --probe all   # netcode 改動後必跑
typecheck ×3 (shared/server/client) + vite build
```
收工必殺自己起的 server（埠 2567 留空）。主機 LAN IP＝192.168.10.121（避開 Radmin 26.x）。
