# 常見陷阱 — 開工前掃一眼，遇怪 bug 先查有沒有前例

依復發頻率/危害排序。每條一句解藥。詳情連到對應知識檔。

---

## 1. 鏡像 bug 與符號補償堆疊（最高危）
四個鏡像 bug 全出在座標/相機/FPV（見 coordinate-systems.md §9）。病根幾乎都是**兩層符號互相
補償**，局部翻一層只把病灶推到別處。
> **解藥**：改任何移動/瞄準/相機/viewmodel 前，先擴充 `client/test/cameraBasis.test.ts` 四 artifact
> 真值表，找出偏離的那條連結再修它。永不靠肉眼翻符號。renderer.ts 檔頭有權威約定註解。

## 2. 運動類 bug 用推理去修 → 治錯層
jitter 樓梯抖動在錯的層被修過兩次，直到實測 15cm/30Hz 才對症。
> **解藥**：運動/方向/抖動先**數值復現**再修。用 `jitter.ts`（`JITTER_ASSERT=1`）、
> `cameraBasis.test.ts`。見 testing.md §0。

## 3. 殘留狀態（stale state）
- **FPV yaw 在發球期殘留**：上一 rally 累積的滑鼠轉向未重設 → 發球方向在 FPV 反側。
  解＝`ViewController.faceNetForServe()` 在本地發球上升緣重播種（coordinate-systems.md §6）。
- **lobby element 重用殺掉動畫**：需強制 reflow（`void offsetWidth`）動畫才重播；slot 用 diff-based
  `computeChangedSlotKeys` 只動變動的卡（client-visuals.md §4）。
- **rejoin 時 listener 重複註冊**：重進房前 `GameSession.reset()` → `keyboard.clearListeners()`。
> **解藥**：單一 teardown + 明確 reseed。headless 測試務必涵蓋殘留狀態，別只測乾淨狀態。

## 4. three.js 三雷
- **opaque vs transparent pass 排序**：opaque pass 一律先於所有 transparent 繪製，**renderOrder
  跨 pass 無效**。FPV 手臂要蓋透明網 → 手臂材質必須 `transparent:true` 才進 transparent pass，
  再靠高 `renderOrder(100)` + `depthTest:false` 畫在最後（client-visuals.md §1 fpvViewmodel）。
- **移除物件要 dispose 幾何/材質**：否則 GPU leak。`GameSession.reset()` / `PlayerCharacter.dispose()`
  / `BallView.reset()` 都有做；臉貼圖是模組單例故意不 dispose。
- **一效果一共用 rAF，不是 per-trigger 開新 loop**：網 wobble 若每次觸網開新 rAF 會疊加搶
  `rotation.z`；`createNetShaker` 共用一個 loop、重觸只重設 `shakeStart`（client-visuals.md §2）。

## 5. Colyseus schema v3 / 版本
- **只能用 functional `schema()` API**：class field 初始化會 shadow accessor、掉集合 `$childType`、
  壞編碼；也不用 decorator（`MatchState.ts`/`PlayerState.ts`）。
- **scalar 預設 undefined**：務必在 `onCreate`/`onJoin` 明確 seed（如 `scoreA=0`、`isCharging=false`）。
- **Colyseus 0.16 配 @colyseus/schema ^3**（npm ERESOLVE 教訓）。room code＝原生 `room.roomId`，
  只有 `create()`/`joinById()` 兩路（netcode.md §9）。

## 6. 兩套座標約定（移動 vs 瞄準）別混用
移動＝`shared moveToWorld/viewToWorld`（yaw=null 第三人稱 side 鏡像；有值 FPV heading）。
發球瞄準＝`server serveAim.ts serveHorizontalDir`（+θ→+X 系，另一套）。
latency-bot 曾用 `viewToWorld` 去對發球期望值 → 靜默失敗。
> **解藥**：瞄準對期望值用 `serveHorizontalDir`（bot 的 angle 探針已如此，testing.md §4）。
> 渲染鏡像只准存在渲染層。詳見 coordinate-systems.md §1/§2。

## 7. 蓄力狀態未在 click 被消費時取消 → 幽靈發球
pointer 重鎖的那次 click 若沒清蓄力，會殘留計時器在解鎖後放出一發鬼發球。
> **解藥**：ViewController 吞掉重鎖 mousedown 時呼叫 `keyboard.cancelPendingCharge()`；
> `setInputActive(false)` 也清。**注意欄位名是 `chargeKeyDownAtMs`，不是 `mouseDownAtMs`**
> （後者不存在，別 grep 錯，client-visuals.md §6）。

## 8. 玩法常數 vs 視覺常數混淆
`VISUAL_BALL_RADIUS(0.14)` ≠ gameplay `BALL_RADIUS(0.15)`；shadow/trail/mesh 用視覺半徑，
落地/判定用 gameplay 半徑。
> **解藥**：玩法門檻進 `shared/constants.ts`；視覺 tunable 進 client `config.ts` /
> `characterConstants.ts`。調視覺不得動判定（gameplay-rules.md 開頭、client-visuals.md 開頭）。

## 9. TouchResult 曾是「只送 toucher」連三輪
遠端看不到某玩家的臉/dive → 先查**線上實際傳了什麼**，別假設。TouchResult 現已廣播全房
並帶 `playerId`（HUD 文字仍 local-only 由 playerId 閘）。
> **解藥**：出現「遠端看不到 X」類 bug，先確認該資訊是否真的在 wire 上（netcode.md §8）。

## 10. 練習模式測試 insight：serve 本身算一次觸球
`MatchSim.serve()` 內部呼叫 `registerTouch`，把發球者記成該 rally 的「上一次觸球者」。故
practice 房自己接的**下一次**觸球，形狀上與 versus 的 `illegal_double`（同玩家連續兩次觸球）
完全一致——差別只在 practice 用 `bypassLegality` 繞過檢查（見 gameplay-rules.md §10）。
> **解藥**：寫這類測試時，發球後緊接著送出的 touch，斷言重點是「outcome 不是
> illegal_double/illegal_count」，而非「一定 accepted」（球是否真的在 reach 內是另一回事）。
> `packages/server/test/practice.ts` 的 (2c) 即如此斷言，且刻意先等發球自己的 TOUCH_RESULT
> 回來，確保下一筆結果不會跟 serve 的結果搞混序。

## 11. 預測樓梯抖動（input cadence 積分 vs frame rate 渲染）
任何**在 input cadence（30Hz）積分、卻在 frame rate（60fps）渲染**的量，都需要 visual lead
才不會每 30Hz 跳一格。`LocalPlayer` 的 `moveVelWorld × leadS`（between-tick motion lead）與
`tickJump` 每幀積分即此。lead 是純視覺、不進 `groundPos`，跨對帳自抵消。
> **解藥**：新增任何 input-cadence 積分量時，配一個 render-frame 的 visual lead（netcode.md §5）。

## 12. 舊機制刪除時，係數殘留成為死引用（幽靈耦合）
M3.0a P1 把 `buildBallLaunch` 的 quality→scatter/heightFactor 兩個效果都刪了（quality 改純資訊
性，噪聲改由 fidelity 模型統一負責），但 `serveAim.ts solveJumpLoft` 仍除以舊 heightFactor
（`sqrt(0.5+0.5·SERVE_QUALITY_JUMP)≈0.987`）去「預先抵消」一個下游已經不存在的乘回——沒有測試
把跳發 vy 的絕對量釘死，所以這條死引用活了一整輪才被對抗式審查抓到。
> **解藥**：刪除/改版任一舊機制（quality 管線、scatter、任何「pipeline」型公式）時，**全庫 grep
> 該機制的係數/中間變數名**（如本例的 `heightFactor`／`SERVE_QUALITY_JUMP`），確認每個引用點都
> 跟著更新或有明確理由保留。光看呼叫端測試綠燈不夠——绿灯可能只是沒人斷言那個量的絕對值
> （physics-flight.md §3）。
