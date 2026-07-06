# 玩法規則 — 品質函數、發球、輪換、犯規、網子物理、蓄力、體力

所有玩法常數在 `shared/src/constants.ts`（唯一真源）。**玩法常數（判定門檻）與視覺常數
嚴格分離**——調視覺不得動判定（見 pitfalls #8）。

---

## 1. 觸球品質：`quality = clamp01(f_distance(d) × f_timing(Δt))`

`shared/quality/quality.ts computeQuality(d, deltaMs)`。兩子函式相乘（狠懲罰：位置**或**時機任一
差都大砍品質）。

**f_timing**（`fTiming.ts`，`|Δt|`）：≤`PERFECT_WINDOW_MS(60)`→1.0；≤`GOOD(150)`→0.8；
≤`OK(300)`→0.5；否則 0.2。`gradeOf` 同 band 給 PERFECT/GOOD/OK/WHIFF。

**f_distance**（`fDistance.ts`，set/spike 用）：d≤`SWEET_SPOT(0.5)`→1.0；0.5–`1.2`線性 1.0→0.5；
1.2–`REACH_MAX(1.8)`線性 0.5→0.1；>1.8→0（`REACH_MAX` 是水平 reach gate）。

**dig 專用曲線**（`dig.ts digDistanceQuality`，只有 mode='dig'）：d≤`DIG_SWEET(0.7)`→1.0；
0.7–`DIG_DECAY_END(1.5)`線性 1.0→0.5；1.5–`DIG_REACH_MAX(2.2)`線性 0.5→0.1；>2.2→0（進 dive 領域）。

**垂直 reach**（`reach.ts isWithinVerticalReach`）：`ballY ≤ playerY + STANDING_REACH(2.55) + jumpY + TOUCH_VERTICAL_MARGIN(0.3)`。
dig 垂直 gate 放寬到 `DIG_VERTICAL_MAX(=STANDING_REACH)+margin`。

---

## 2. Dive（撲救，dig 專屬、伺服器權威擲骰）

球距 ∈ `(DIG_REACH_MAX(2.2), DIVE_REACH_MAX(3.4)]` 且 mode='dig' → dive attempt（非確定觸球）。
`shared/dig.ts diveSuccessProbability(d)`：`DIVE_REACH_MAX` 端線性 **0.8→0.2**（d=2.2→3.4）。
`MatchSim.resolveDive`：
- 前提 `canAffordDive = stamina >= DIVE_STAMINA(15)`；不足 → 純 whiff，不觸發 dive。
- 成功與否都：向球點 lunge（`DIVE_LUNGE_MAX(2.0)` 上限、clamp 不過網不出界）、
  鎖移動 `DIVE_LOCK_S(0.8)s`、扣 `DIVE_STAMINA(15)`。
- 擲骰＝deterministic mulberry32（touchServerTime XOR salt，與 launch scatter seed 獨立），廣播權威結果。
- 成功 → 固定低品質 `DIVE_QUALITY(0.35)`，從球點朝最近隊友（1v1 退回 self-set）。
- TouchResult `outcome: dive_success | dive_fail`。

---

## 3. 過蓄（overcharge, red zone）

`CHARGE_RATE=0.8/s`，蓄到 `OVERCHARGE_MAX(1.3)`（超過 1.0 約再 0.375s）。
- **距離**：`chargeDistanceMult(c) = 1 + 0.6×clamp(c, 0, 1.3)`（`charge.ts`）。c>1 持續吃距離（「更多力」）。
- **品質**：`overchargeQualityMult(c)`（`overcharge.ts`）c≤1→1；1.0–1.3 線性降到
  `1 − OVERCHARGE_QUALITY_PENALTY(0.5)` = 0.5。**套用所有觸球（含 dive、含發球）**，
  在餵進 `buildBallLaunch` 的 scatter/height pipeline **之前**乘上。
- wire 入口 `parseTouch` 把 charge clamp 進 [0, `OVERCHARGE_MAX`]（負→0，>1.3→1.3）。

`buildBallLaunch`（`ballistics/launch.ts`）：velocity = dir × baseSpeed × chargeDistanceMult；
scatter＝角度擾動，magnitude `BASE_SCATTER(3.0)×(1−quality)`，上限 `π/6`（30°），mulberry32 seed；
低品質降高度：`heightFactor = sqrt(0.5 + 0.5×quality)`。

---

## 4. 變動跳（variable jump）

`kinematics/jump.ts`。`JUMP_V0=4.2`（press 即時），boost 窗 `JUMP_BOOST_MAX_S(0.3)s` 內按住＋上升時
重力 ×`JUMP_HOLD_GRAVITY_MULT(0.45)`（浮更久），`JUMP_GRAVITY=18`。stamina：press 扣
`JUMP_STAMINA_BASE(6)` 一次 + boost 期 `JUMP_STAMINA_HOLD_PER_S(10)/s`（全窗 ~3）。
`jumpHeld` 上升緣起跳（server `tryStartJump`），落地 `isLanded`（y≤0 ∧ vy<0）。

---

## 5. 發球（angle-sweep serve）：`MatchSim.serve` + `sim/serveAim.ts`

- **掃描針三角波**：`sweepAngleDeg(elapsed)` 純函式，`SERVE_SWEEP_PERIOD_MS=1600`
  （t=0→−90, t=800→+90），只吃 `servePhaseStartServerTime`。水平瞄準見 coordinate-systems.md §2。
- **蓄力從 0**（`SERVE_MIN_CHARGE` floor 已移除）：弱發球自然失敗（碰網/自方落地，依死球規則判給對手）。
- **跳發（airborne release）**：lag-comp 後 release 高度 `> AIRBORNE_EPS(0.05)` → jump serve：
  origin 加高度、速度 ×`SERVE_JUMP_SPEED_MULT(1.25)`、品質 `SERVE_QUALITY_JUMP(0.95)`（vs 地面
  `SERVE_QUALITY_GROUND(0.8)`，scatter 更緊）、`solveJumpLoft` 解平坦（可下壓）弧、**體力 ×2**。
  `BallLaunch.isJumpServe:true`（client 用來變色球+trail 直到下次觸球/死球）。
- 地面發球者發球前**被 clamp 在場外**（`serveClampAbsZ = COURT_HALF_LENGTH`，movement.ts；
  跳過線合法），發球站 spawn `SERVE_SPAWN_Z = ±9.8`（`serveSpawn`）。
- `SERVE_BASE_SPEED=8`（與 spike 解耦）。發球後 phase 離開 'serve'，clamp 解除。

---

## 6. 發球輪換：`shared/rotation/serveRotation.ts`（FIVB-adapted, 純/immutable）

- `initRotation(orderA, orderB)`：order＝slot-index 升序；**A idx0 先發**（A 標 gained，B 未）。
- `onPoint(rot, scoringSide)`：發球方再得分 → **同一發球員**（不進位）；side-out（非發球方得分並取得發球權）
  → 該隊 `idx=(idx+1)%size` 再發，**唯該隊本局首次持發球權例外**（不進位、從 idx0 發）。
- `removePlayer`：中途離場移出 order、修 idx（盡量保住當前發球員），1 人隊永遠發那一人。
- room（`MatchRoom`）持有 order，`onPoint` 後解出 `currentServerId` 覆寫 `servingId` 與 `DeathEvent.nextServerId`。

---

## 7. 犯規（M2.7 §2）＝拒絕觸球，非死球

`game/rally.ts classifyTouch`：
- `illegal_double`：同一玩家做了本隊上一次觸球（1v1 self-set 允許鏈 dig→set→spike，
  但同隊連兩下仍算 double）。
- `illegal_count`：該側已達 `MAX_TOUCHES_PER_SIDE(3)` 上限。
- 犯規 → TouchResult `accepted:false, outcome: illegal_*`，**不產 launch、球續飛、其落點決定得分**。
  client 顯示紅色回饋、不鎖鍵。過網時觸球數重置（`crossNet`）。

---

## 8. 網子＝軟障礙（M2.7 §1）：`shared/ballistics/net.ts`

網不再是死球。網＝z=0 平面、|x|≤4.5、y∈[0, `NET_TOP(2.43)`]。軌跡穿越平面且低於 tape → 接觸，
伺服器 `resolveNetCollision(contactPos, incomingVel)` 生成新 `BallLaunch`（`isNetTouch:true`），
起點＝精確接觸點/時刻。**每次接觸都是新 BallLaunch**。兩區：
- **tape**（y∈[`NET_TOP − NET_TAPE_H(0.15)`, NET_TOP]）：過網、damped。各分量 ×`NET_TAPE_DAMP(0.5)`，
  vy 再 −`NET_TAPE_VY_DROP(0.5)`（拖落對面）＝「觸網過網 let serve」。
- **face**（y < NET_TOP−0.15）：軟反彈。vz 反向 ×`NET_RESTITUTION(0.15)`（彈回打者側）、
  vx ×`NET_FACE_HORIZ_DAMP(0.5)`、vy 不變（重力續拉）。反彈 vz floor 於 `NET_MIN_REBOUND_SPEED(0.5)`
  避免貼網數值停滯。
- 接觸時間**閉式解**（z 無加速度，t=−z0/vz），origin 沿出向 nudge `NET_CONTACT_EPS(0.02)` 離平面防重測。
- **發球 let 自由**：發球觸 tape 過網照樣續打（不特判）。net contact 不計為觸球（觸球數不變）。
- 觸網時軌跡連續，client 只需消費新封包（net-shake VFX 為 bonus）。

---

## 9. 死球與計分

`DeathCause` 只剩 `ground | out`（碰網、犯規都不再結束 rally）。`game/rally.ts resolveDeath`：
- `ground`：落在誰半場誰輸，對手得分（A 擁 z<0、B 擁 z>0）。
- `out`：最後觸球方失分。
計分 rally-point（`game/scoring.ts`）：每 rally 得 1 分，`RALLY_TARGET(15)`、`WIN_BY(2)`、
硬上限 `RALLY_CAP(21)`（即使 1 分差也判勝）。`winnerOf`/`isGameOver` 純函式。
中途某側清空 → `forfeit`（存活側決定性獲勝）。

---

## 10. 練習模式（practice sandbox，M2.9 §2）

單人沙盒房：client `client.create(ROOM_NAME, {mode:'practice'})` → server
`MatchRoom.onCreate` 用 `parsePracticeMode(options)` 防禦式解析（非物件／非
`{mode:'practice'}` 字面值一律當 versus，絕不 throw）。`isPractice=true` 時
`maxClients=1`＋`setPrivate(true)`（房碼 joinById 自然失效，朋友不會誤入）。

- **autostart**：`onJoin` 後 `clock.setTimeout(startPractice, PRACTICE_AUTOSTART_MS=300)`
  （必須晚於 `LOBBY_BROADCAST_DELAY_MS=60`，讓 client 先收到 lobby snapshot、掛好 handler，
  再跳進 serve phase）。`startPractice()`＝`startMatch` 變體：**不建 rotation
  （`this.rotation` 維持 `null`）**、不查 `canStart`、`servingId=` 唯一玩家。**guard**：
  `only=anyPlayerId()` 為空或 `phase!=='lobby'` 就整個 no-op——防孤兒 timer 誤觸發已清空
  或已經在跑的房。
- **rotation 恆 null 的所有解參考點都帶 guard**，不是假設 non-null：`onLeave` 的
  `removePlayer`／`currentServerId` 用 `if (this.rotation)`；`finishRally` 用
  `if (!this.isPractice && !result.gameover && this.rotation)`——**練習房這條件恆
  false，rotation 分支整段跳過**，next-server 邏輯改走下面 endRally 的 frozen 分支。
- **計分凍結（frozen）切口在 `MatchSim.endRally(state, cause, landing, side, serverTime,
  frozen)`**（`matchSim.ts`，`MatchRoom.finishRally` 傳入 `this.isPractice`）：死球偵測與
  DeathEvent 廣播（cause／`resolveDeath`／scoringSide 算法）**與 versus 完全同源**，只有
  `applyPoint`/`isGameOver` 兩處被繞過——`frozen` 時 score 原地不動、`gameover` 恆
  `false`、`nextServerId` 恆＝自己（不查 `playerIdForSide`）。**versus 等價性守則**：這是
  唯一分岔點，禁止在 `resolveDeath`/cause 判定本身另開 practice 分支。
- **觸球放寬（bypassLegality）切口在 `MatchSim.rallyTouch(..., bypassLegality)`**
  （`MatchRoom.handleRallyTouch` 傳入 `this.isPractice`）：包住 `classifyTouch` 呼叫本身，
  `illegal_double`／`illegal_count` 兩種犯規**同一處**一起繞過（非分別開關）。**玩法常數
  （`MAX_TOUCHES_PER_SIDE` 等）一個都不動**，只是不呼叫檢查——可自接連擊 juggle。
- **onLeave 早退**：`isPractice` 時 `onLeave` 提早 `return`（在 forfeit 分支之前），孤身
  離場永不觸發 `sim.forfeit`；房間空了靠 Colyseus `autoDispose` 收掉，不必手動清理。
- **測試**：`packages/server/test/practice.ts`（tsx 自起 server 於埠 2601，同 jitter.ts 手法，
  真 colyseus.js 連線）三斷言：autostart≤1000ms 且無 START_MATCH／死球循環（score 恆 0:0＋
  RESET_DELAY 後回 serve）／versus 房完全不受影響（`canStart` 照舊）。**serve 本身也算一次
  觸球**這個細節會影響「同人連擊」斷言的寫法，見 pitfalls.md。

---

## 11. 觸球模式與體力

- **模式持久**（M2.6）：`mode ∈ dig(J)|set(K)|spike(L)`，只由 `InputFrame.touchMode` 改，
  **死球不重置**（舊 resetModes 已移除）。server 端權威 mode 為準（client intent.mode 不符時忽略）。
- **意圖方向** `resolveIntent`（`intent/direction.ts`）：
  - dig(J)：2v2 loft 向最近隊友；1v1 退回 self-set（向自方半場上內側 loft，可一人鏈接）。
  - set(K)：預設直上；有 dirInput → 打者視角方向（`viewToWorld`）。base `SET_BASE_SPEED(5.5)`。
  - spike(L)：預設對方場中心；左右 dirInput 瞄對方底線角（打者視角 `rightX`）。base `SPIKE_BASE_SPEED(9)`。
  - dig base `DIG_BASE_SPEED(4.5)`。
- **體力經濟**（§7）：`STAMINA_MAX=100`。移動 `−2/s`、衝刺 `−5/s`、idle `+4/s`（`movement.ts`）；
  觸球 `TOUCH_STAMINA_COST=5`（dive 改扣 15，跳發 ×2）；jump base 6 + hold 10/s；
  死球回復 `STAMINA_DEADBALL_RECOVER=25`。低體力（<30）移速 ×0.7，空（0）×0.5。
