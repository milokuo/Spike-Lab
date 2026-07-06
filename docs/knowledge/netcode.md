# Netcode — 預測、對帳、延遲補償、ring buffer、wire 協定

架構鐵律：**球不進 Colyseus schema**。schema 只裝低頻權威狀態（players/score/phase/serving）。
球＝`BallLaunch` 參數包＋經過時間，雙端各自用純函式演算（`shared/ballistics/trajectory.ts`）。
碰網／反彈＝伺服器生成新 `BallLaunch` 廣播。破壞協定完全允許（無既有部署，不做相容）。

---

## 1. 時鐘同步（ping/pong EMA）

**Client**（`client/src/net/clockSync.ts`）：每 `CLOCK_SYNC_PING_INTERVAL_MS=1000` 送 ping，
收 pong 算 `rtt = now − clientTime`，`oneWay = rtt/2`，
`offsetSample = serverTime + oneWay − now`。EMA α=`CLOCK_SYNC_OFFSET_EMA_ALPHA=0.15`，
離群丟棄 `rtt > rttEma * CLOCK_SYNC_OUTLIER_RTT_MULT(2)`。`serverTimeNow() = performance.now() + offset`。

**Server**（`server/src/sim/clockSync.ts`）：per-session EMA of `serverRecv − clientTime`，
α=`0.2`，離群 `> 3×|offset| + 100ms` 丟棄。`toServerTime(sessionId, clientTime)` 把
`TouchIntent.clientTime` 映回權威時鐘做延遲補償。

---

## 2. Ring buffer + 回溯裁決：`server/src/sim/lagComp.ts` + `ballRingBuffer.ts`

- 容量 `RING_BUFFER_TICKS=45`（~1.5s @30Hz）。`BallRingBuffer`（pos+vel）與 per-player
  `PlayerHistory`（pos，含 y）。`query(serverTime)` 在 bracketing 兩樣本間**線性內插**。
- `adjudicateTouch`（`lagComp.ts`）流程：
  1. `clientTime → serverTime`，clamp 進 `[windowStart, windowEnd]`。
  2. rewind 球＋玩家到該時刻。
  3. reach gate（mode-aware）：非 dig → 水平 `REACH_MAX` + 垂直 `isWithinVerticalReach`；
     dig → 水平 `DIVE_REACH_MAX` + 垂直 `DIG_VERTICAL_MAX+margin`（dive 段的球在此被放行，
     由上層 dive 裁決擲骰）。
  4. **理想觸球時刻 t\***：掃描窗內軌跡找「球與玩家水平距離最小」的樣本
     （`findIdealTime`，步長 `EVENT_STEP_MS=4ms`）。`deltaMs = |touchTime − t*|`。
  5. quality = `clamp01(distanceQuality(mode,d) × fTiming(deltaMs))`；grade 由 Δt band。
- **判定時刻＝出手時刻**：`TouchIntent.clientTime` 在放開 H（或 FPV LMB）的瞬間取樣。

---

## 3. 反彈保留歷史：`MatchSim.installRebound`（`rooms/matchSim.ts`）

碰網不是死球（M2.7）。`resolveNet()` 用 `resolveNetCollision`（見 gameplay-rules.md）
生成新 `BallLaunch`（起點＝精確接觸點/時刻，`isNetTouch:true`），再 `installRebound`：
1. `ballBuffer.dropFrom(contactTime)` 丟掉舊軌跡本 tick 記錄的**穿網過衝樣本**（球從未真正到那）；
2. 在接觸時刻**回填一顆精確樣本**（rebound origin/velocity），讓跨越反彈的 rewind 內插到對段；
3. append 現時樣本，保持時間有序。
> 不 wipe 歷史的原因：延遲的觸球其 `clientTime` 可能映到反彈**之前**，必須仍能對前一段裁決。

一 tick 內連鎖：`tick()` 迴圈 `while due==='net'`（上限 `MAX_NET_RESOLVES_PER_TICK=8`），
`resolveNet` → 廣播 → `pollDueEvent`（re-check 已反彈球是否同 tick 又有事件），
關閉「在已死軌跡上接受觸球」的 sub-tick 窗（finding #1/#2/#3）。

---

## 4. 輸入 30Hz：`InputFrame`

`InputFrame`（`shared/types/messages.ts`）每幀送（client `INPUT_SEND_HZ=30`，
與 server `TICK_HZ=30` 1:1）：
```
seq(單調遞增), clientTime, move{x,y ∈ −1|0|1}, jumpHeld:boolean,
touchMode('dig'|'set'|'spike'), isCharging:boolean, dtMs, yaw:number|null
```
server 每 tick 消費：`seq <= lastProcessedSeq` 丟棄（stale/replay）。`touchMode`、`isCharging`
每幀寫成權威狀態；`jumpHeld` 上升緣觸發跳（見 §6）。yaw 由 `wrapYaw` 驗證/包裹，非法當 null。

---

## 5. Client 預測 + 對帳：`client/src/player/localPlayer.ts`

- **每 render-frame 積分**（非每輸入 tick）。`groundPos` 只在 30Hz input-send 前進；
  `position` 每 60fps 幀讀。若不補償，mesh 在送出之間凍結、每 30Hz 跳一整步——
  **實測 ~15cm/30Hz 樓梯抖動**（M2.5 stair-step，世界空間看不出，但對著平滑 lerp 的追隨相機
  是明顯抖動）。修法＝**between-tick motion lead**：`position = groundPos + errorOffset +
  moveVelWorld × min(stepElapsed, lastStepDt)`。純視覺 lead，不進 groundPos，跨對帳自抵消。
- **jump 同理**：`tickJump(dtMs, held)` 每 render-frame 用共用 `stepJump` 積分（與 server 同碼）。
- **對帳 `reconcile(snapshot)`**：不 teleport mesh（那 30Hz 硬拉正是抖動源）。先記當前 render 位置，
  用 `snapshot.pos + 重放未 ack 輸入`（`seq > lastProcessedSeq`）重建預測基底，把差存成
  `errorOffset`，由 `decayError` 以 `RECONCILE_ERROR_DECAY_RATE=12/s` 指數衰減。
  差 > `RECONCILE_SNAP_THRESHOLD=1.5u` ＝真 teleport（dive 撲救／發球歸位）→ 直接 snap（歸零 offset＋lead）。
- **jump 預測 grace**：`startJumpPrediction()` 先做 grounded gate + 本地 stamina 預檢
  （`lastStamina >= JUMP_STAMINA_BASE`），設 `jumpPredictedUntilMs = now + JUMP_PREDICTION_GRACE_MS(300)`。
  此窗內仍顯示 grounded 的 snapshot 視為 server-lag，不把剛起跳拉回地面（否則發球跳不起來）。
  垂直只在確認落地（snapshot.y≈0）硬同步，空中小分歧自癒。
- `beginDiveLock()`：收到 dive TouchResult 後 `DIVE_LOCK_S` 內停用本地 WASD，不與權威 lunge 打架。

## 6. 變動跳（jump）server 側：`MatchRoom` + `shared/kinematics/jump.ts`

- `jumpHeld` **上升緣** + grounded + `stamina >= JUMP_STAMINA_BASE(6)` → `startJump()`（即時 `JUMP_V0=4.2`），
  扣 6 一次（`tryStartJump`）。
- 每 tick `stepJump`：boosting（held ∧ 上升 ∧ `airborneS <= JUMP_BOOST_MAX_S(0.3)`）時重力
  ×`JUMP_HOLD_GRAVITY_MULT(0.45)`，每秒扣 `JUMP_STAMINA_HOLD_PER_S(10)`（全窗 ~3）。stamina 0 → boost 中止。
- 落地（`isLanded`: y<=0 ∧ vy<0）→ 回 grounded（null state）。

## 7. Snapshot 與遠端內插

`StateSnapshot`（`CH.SNAPSHOT`, 30Hz, `wire.ts buildSnapshot`）欄位：
`serverTime, players[], score, phase, servingId, servePhaseStartServerTime`。
`PlayerSnapshot`：`id, side, name, pos, stamina, mode, isCharging, lastProcessedSeq, facing`。
- `servePhaseStartServerTime`：**只在 serve phase 非 null**，其餘 null。protractor 針＝
  `sweepAngleDeg(renderTime − 此值)` 純函式（角度不上線）。
- `facing`/`mode`/`isCharging` 皆權威，讓任一 client 能渲染任一玩家的朝向/模式/蓄力。
- 遠端玩家（`remotePlayer.ts`）：緩衝樣本，內插 `renderTime = serverTimeNow − REMOTE_INTERP_DELAY_MS(100)`
  的 bracketing 兩樣本。facing 用最短弧 slerp（`FACING_LERP_RATE=12/s`），本地即時不 slerp。

## 8. TouchResult 廣播（M2.8 起）

`TouchResult`（`CH.TOUCH_RESULT`）**廣播全房**（曾經只送 toucher，連錯三輪——見 pitfalls #9），
帶 `playerId`，讓每 client 能演該玩家的角色反應（開心/囧臉、dive lunge），本地與遠端皆可。
**HUD 文字回饋仍 local-only**：client 用 `playerId === 自己 sessionId` 閘。
欄位：`playerId, accepted, quality, grade, serverTime, outcome?`。
`outcome` ∈ `dive_success | dive_fail | illegal_double | illegal_count`（普通觸球時 absent）。

## 9. Wire 通道與 schema

- 通道常數集中在 `shared/src/channels.ts` `CH`（唯一真源，勿硬編字串）。room name `'match'`。
- Colyseus **@colyseus/schema v3 functional `schema()` API**（`MatchState.ts`/`PlayerState.ts`）：
  **不可用 class field 初始化**（會 shadow accessor、掉 `$childType`、壞編碼），也不用 decorator。
  scalar 預設為 undefined，必須在 `onCreate`/`onJoin` 明確 seed（見 pitfalls #5）。
- Colyseus 0.16 配 schema ^3（npm ERESOLVE 教訓，見 pitfalls #5）。room code＝Colyseus 原生
  `room.roomId`，只有 `create()` 與 `joinById()` 兩條路（`connection.ts`）。

## 10. 死球與計分（netcode 面）

`DeathEvent`（`CH.DEATH`）：`cause ('ground'|'out'), landing, scoringSide, score, nextServerId, serverTime`。
碰網與犯規**不**結束 rally（見 gameplay-rules.md）。`nextServerId` 由 server 端輪換引擎
（`onPoint`）解出後覆寫進 DeathEvent。deadball 後 `RESET_DELAY_MS=3000` 進下一發球期。
