# 球飛行模型 v2 — 軌跡／旋轉／fidelity／阻力（M3.0a）

動到球的飛行、旋轉（Magnus）、fidelity（觸球噪聲）、阻力任何一處前必讀。**架構鐵律不變**：
球仍不進 Colyseus schema，一切球運動由 `BallLaunch`（現含 `omega`）+ 經過時間唯一決定，
雙端各自算、零漂移。本檔記 M3.0a（P0/P1/WP-7/WP-8）加的第二代飛行模型。

---

## 1. 架構：純函數分層

`packages/shared/src/physics/{flight,events,spin,spinPresets,fidelity}.ts`：

- **flight.ts**：`FlightLaunch{origin,velocity,omega,startMs}` + `advance(s,params,decayStep)`
  單步積分。**240Hz 定步長**（`PHYSICS_DT=1/240`）。積分序＝**先更新 v，再用梯形（新舊 v 平均）
  更新位置**（`p += 0.5·(v+v')·dt`）——spec 字面寫「semi-implicit Euler」但**字面版本在 T=1.5s
  累積 ~3cm 垂直誤差，過不了 §3 精度閘**（vs 解析拋物線 <1e-9、vs RK4 <2cm 兩道），梯形版本對
  純重力等於解析解、對 drag/Magnus 這類速度相依項是二階精度。決策依據是**實測數字，不是規格字面**
  （除錯鐵則的另一實例）。
- **flightStateAt(launch, tMs, params?)**：單槽模組級快取（`gridCache`），只在同一 launch 物件
  上單調遞增查詢時才增量步進，否則（launch 身分不符、`step > nSteps` 倒退）整個重建。**快取
  「錯不了只會慢」**：任何非法快取命中都會被身分/步數檢查擋掉，退化只是變慢，不會出錯資料。
  另有 `MAX_ELAPSED_S=60` clamp，防止一個帶著極舊 `startMs` 的查詢把積分器卡死在數十億步。
- **events.ts firstFlightEvent(launch, bounds, params?)**：定步長掃描抓「跨越」的那一格區間，
  再用**固定 `BISECT_ITERS=20` 次二分**收斂精確事件時刻（確定性——不是 tolerance-based 迴圈，
  位元級可重現）。三事件 `ground|net|out`；**同一格內 landing 與 net 同時（`TIE_EPS_MS` 內）→
  landing 勝**（球到地板判定優先於半空中網物理）；落點**壓線＝界內**（`|x|≤half` 用 `≤`不是`<`）。

---

## 2. 符號約定：ω 世界座標右手系

`spin.ts spinIntentToWorld(intent, side, yaw)` 是**唯一鏡像入口**（moveToWorld 的旋轉版）——
下游任何函式拿到世界 ω 後**禁止再鏡像**。

- **推導錨點**：一顆沿世界 +Z 飛行、帶 topspin 的球，其頂面朝 +Z 方向轉 ⇒ `ω=+X̂`；此時
  Magnus = ω×v = (0,−vz,0) 把球往下壓。即「+Z 飛上旋 ⇒ ω=+X̂ ⇒ Magnus 下壓」。
- 視角空間定義（`SpinKind`）：`top`(下扎)⟂forward、`back`(飄浮)⟂forward、`side-R`(往打者螢幕右彎)
  ω=−up、`side-L`(往螢幕左彎) ω=+up。
- `yaw=null`（第三人稱）用 `forwardZ(side)` 鏡像（複用 viewSpace.ts 同一函式）；有限 yaw（FPV）
  用 `(sin yaw, cos yaw)`，`side` 不使用（heading 已完整編碼朝向——這正是**殘留 yaw**也能正確
  解算的原因，見 coordinate-systems.md §9 系列教訓）。
- **24-cell 真值表**在 `physicsSpin.test.ts` 是此約定的守門員（4 SpinKind × side × yaw 模式等
  組合）。改任何 spin 方向公式前先擴充這張表，**禁止繞過**（同 cameraBasis.test.ts 的方法論）。

---

## 3. Touch Fidelity（意圖／執行分離，使用者哲學拍板）

`fidelity.ts applyFidelity(velocity, omega, f, seed)`：f=1 是嚴格 identity（PERFECT/未蓄力觸球
完全不擾動）。f<1 時**固定三步順序、只加噪聲不糾正意圖**（打歪了就忠實地歪飛，不會自動吸回準心）：

1. **方向錐**：在隨機方位角 φ 上、以 `(1−f)·ERR_CONE_MAX_RAD(18°)·η` 偏轉速度方向（η∈[−1,1]）。
2. **力量 floor**：`|v| ×= POWER_FLOOR(0.55) + (1−POWER_FLOOR)·f`——最差時機仍保底 55% 力量
   （可玩性 floor，不會完全打不動）。
3. **旋轉**：`ω ×= f^SPIN_FIDELITY_EXP(1.5)`——旋轉比方向/力量掉得更快（乾淨觸球才給得出旋轉）。

`f = fidelityOf(deltaMs) × overchargeQualityMult(charge)` 的通用形式；`fidelityOf`（PERFECT 窗
內=1，衰減到 `FIDELITY_WINDOW_MS`=OK 窗邊緣歸零）。**發球** f 只吃過蓄乘項（`overchargeQualityMult`），
**不吃 fidelityOf**——發球沒有「理想接觸時機」，量角器才是精準機制，準頭來自玩家操作而非時機評分。
**dive** f 恆 `DIVE_QUALITY(0.35) × overchargeQualityMult(charge)`（撲救本就無乾淨時機窗）。
決定論來源：`hashSeed(playerId, serverTime)` 餵 mulberry32，任何機器重放位元相同。

`quality` 欄位（`BallLaunch.quality`，`ballistics/launch.ts buildBallLaunch`）**已改為純資訊性**
——P1 之前 quality 會同時：(a) 產生水平散射角、(b) 用 `heightFactor=sqrt(0.5+0.5·quality)` 壓低
垂直速度；P1 後**兩者都刪了**，quality 只留給 HUD/client 視覺與 `TouchResult`。所有噪聲改由上面
的 fidelity 三步模型統一負責。**舊機制刪除時，任何還在算 heightFactor/散射相關的下游公式都是死
引用**（見 pitfalls.md 的 solveJumpLoft 案例）。

---

## 4. 調參：速度補償（阻力校準）

flight v2 加了二次阻力（`a_drag = −DRAG_K·|v|·v`），同樣發射速度現在飛得比舊（無阻力）模型短。
為了保留每一輪已經調好的手感，兩個 POWER base speed 上調（**唯一被批准動 base speed 的理由**，
其他任何調參都走 quality/fidelity/scatter 層）：

- `SERVE_BASE_SPEED`: 8 → 9.0（`shared/constants.ts`）——舊模型落點 15.51u，新 base 9.0 落點
  15.38u，比值 0.991。
- `SPIKE_BASE_SPEED`: 9 → 10.0——舊模型落點 16.06u，新 base 10.0 落點 15.84u，比值 0.986。
- dig/set **刻意不**補償（spec 只 scope 到 SERVE/SPIKE），短距落點略短屬可接受。
- **守門測試**：`serveAnchor.test.ts`（無旋、平發射 vs 舊解析拋物線，容差 ±5%）——這條測試錨的
  是**無旋直發**，任何跳發弧度（`solveJumpLoft`）或旋轉相關改動都不應該動到它的結果。
- §5 常數表已併入 `shared/constants.ts`（unified single source，不再散在獨立
  physics/constants.ts）。
- **已知待驗**：基速補償後，時機窗（timing window）手感可能相對變窄——僅記錄待驗，非本輪修復
  範圍。

---

## 5. 驗證：latency-bot curve probe（M3.0a WP-8）

`tools/latency-bot/src/index.ts` `--probe curve`（併入 `--probe all`）：

- **雙端一致性**：server 權威 launch vs bot 本地重算同一 launch 在同一 tMs 的位置，容差
  `CURVE_POS_TOLERANCE=0.05`(5cm)。
- **ω=0 孿生防假過**：`runCurveServeCase`/`landingShiftVsStraightTwin` 拿同一 launch 的 `{...launch,
  omega:0}` 版本比落點，位移須 ≥`CURVE_MIN_LANDING_SHIFT`(0.15u/15cm)——否則「彎球」測試可能在
  根本沒彎的情況下假通過。
- **彎球 vs 直球 lag-comp 對照**：`CURVE_LAGCOMP_LATENCIES=[0,100,150]` 下，帶旋（彎）與不帶旋
  （直，sweep 角 0）發球的理想時刻評級須逐延遲相等——證明彎曲不破壞既有 lag-comp 評級邏輯。
- **drag 上線曾暴露探針既有缺陷**（WP-8 commit 218ea25）：dive probe 的**顯式站位點假設**與
  TouchResult 廣播的 playerId 過濾，在阻力縮短飛行距離後失準才被抓出來。**教訓**：任何新增/
  修改探針時，凡涉及「球會飛多遠/多久」的距離或時間假設，模型改動後都要重新驗算，不能沿用舊
  drag-free 直覺數字。

---

## 6. Client 視覺

- **縫線紋理**：`scene/ballTexture.ts ballSeamTexture()`——模組生命週期單例（`cache`，同
  `faceTextures.ts` 手法，不 dispose），equirectangular 2:1、3 條 S 曲線縫線＋±w wraparound 副本
  防經線接縫斷裂。
- **依 ω 自轉**：`scene/ball.ts`，每幀用 `spinDeltaQuat`（THREE.Quaternion）算本幀增量旋轉，
  `mesh.quaternion.premultiply(spinDeltaQuat)`——**premultiply 而非 multiply**，因為增量要套在
  世界座標軸上，不是網格本地軸（否則轉軸會跟著網格自己歷史旋轉漂移）。角速率 =
  `|omega|·SPIN_VISUAL_RATE_MULT`（client `config.ts`，純視覺 tunable，**不進 shared**，調視覺
  不動判定鐵律的延伸）；`|omega|≤SPIN_VISUAL_EPSILON_RAD_S(0.01)` 時跳過（避免對近零向量單位化）。
- **freezeAtMs**：`ball.ts` 用 `firstEvent(launch, MAX_FLIGHT_MS).atMs` 算出事件時刻，渲染時
  `elapsedMs` 被 `Math.min(..., freezeAtMs)` 夾住——球到達事件（落地/觸網）後自然停在那個時間點的
  姿態繼續轉（`dtSec` 變 0 則自轉增量為 0），不需要額外的「停止旋轉」特判。

---

參見：coordinate-systems.md（座標/鏡像鐵律總覽）、gameplay-rules.md §3（quality/fidelity 玩法
數值）、testing.md（測試總表）、pitfalls.md #12（本輪新增的死引用教訓）。
