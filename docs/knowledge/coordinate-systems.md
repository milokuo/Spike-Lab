# 座標系統 — 地雷區（動任何移動／瞄準／相機／FPV／鏡像前必讀）

本檔是全專案最危險的一區：歷史上四個「鏡像 bug」全部出在這裡。核心鐵律寫在最後，
先看完約定再看歷史。**永遠不要靠局部翻某個符號來「修好」畫面——鏡像 bug 幾乎都是
兩層符號互相補償，翻一層只是把病灶推到另一處。要改，先擴充 `cameraBasis.test.ts`
真值表，找出偏離的那一條連結再修它。**

---

## 0. 世界座標與場地

- `Side = 'A' | 'B'`。**A = z<0 半場，B = z>0 半場**（`types/state.ts`）。網＝z=0 平面。
- 場地：`COURT_LEN=18`（Z: −9..+9）、`COURT_WIDTH=9`（X: −4.5..+4.5）、`NET_HEIGHT=2.43`。
- up = 世界 +Y。所有繞 Y 軸旋轉都用 three.js `rotation.y` 慣例（右手系）。

---

## 1. 唯一的移動轉換入口：`shared/src/intent/viewSpace.ts`

鍵盤／`InputFrame.move`／`TouchIntent.dirInput` **一律是「玩家視角本地座標」**：
`x=+1`＝畫面右、`y=+1`＝朝網（forward）。轉世界只有兩條路，共用同一函式：

### 1a. 第三人稱（yaw = null）：`viewToWorld(input, side)` — 鏡像 per side
追隨相機每側鏡像（A/B 差 180° yaw），所以世界移動也必須鏡像，否則某側輸入會反：
```
forwardZ(side): A → +1, B → −1   // 「朝網」的世界 Z 方向
rightX(side):   A → −1, B → +1   // 「畫面右」的世界 X 方向
worldX = input.x * rightX(side),  worldZ = input.y * forwardZ(side)
```
> 由來的血淚：曾經 A 的左右反、B 的上下反（現場對戰 bug），就是世界移動沒跟著鏡像。

### 1b. 第一人稱（yaw = 有限值）：`moveToWorld(move, side, yaw)` — heading 相對
FPV 時 `InputFrame.yaw` 是世界朝向（弧度）。**yaw 約定（整個 codebase 通用）**：
```
yaw = 0            → forward = +Z
forward(yaw) = (sin yaw, cos yaw)   // +Z 繞 +Y 轉 yaw
right(yaw)   = cross(forward, up) = (−cos yaw, sin yaw)
W(move.y=+1) 沿 forward,  D(move.x=+1) 沿 right
```
`side` 在 yaw 有值時**不使用**（heading 已完整編碼朝向）。yaw=null 或非有限 → 退回 1a。
`wrapYaw(yaw)`：非有限→`null`（＝第三人稱語意）；否則 wrap 到 `[−π, π]`。

### 1c. 朝向 `intent/facing.ts`
- `initialFacing(side)`：A→`0`（面 +Z），B→`Math.PI`（面 −Z）＝面網。與 FPV yaw 初始一致。
- `computeFacing(prev, side, move, yaw)`：優先序 **顯式 yaw > 移動方向 > 前一朝向**。
  移動方向＝`atan2(world.x, world.z)`（注意是 `atan2(x, z)`，配合 yaw 約定）。
- server 是 facing 唯一寫入者；本地玩家即時算、遠端玩家用 snapshot 值 slerp（見 §6）。

---

## 2. 發球瞄準是**另一套**約定：`server/src/sim/serveAim.ts`

**瞄準與移動是兩套獨立約定，禁止混用。**（latency-bot 曾用 `viewToWorld` 去對發球期望值，
靜默失敗——見 pitfalls.md #6。）
```
serveHorizontalDir(side, angleDeg):
  fz = forwardZ(side)                 // +1(A) / −1(B)
  return { x: fz*sin(rad), z: fz*cos(rad) }   // 「朝網」繞 +Y 轉 angle
```
- angle 0 = 直指網；**+angle 掃向 server 的 +X**。angle ∈ [−90, +90]。
- 掃描角＝純函式 `sweepAngleDeg(elapsedMs)`（`shared/kinematics/serveSweep.ts`，三角波，
  週期 `SERVE_SWEEP_PERIOD_MS=1600`，t=0→−90、t=800→+90）。角度本身**不上線**，
  只傳 `servePhaseStartServerTime`，雙端各自用同步時鐘代入同一函式。
- `serveUnitDir(side, angle, loft)` 疊加垂直分量；`solveJumpLoft(...)` 解跳發平坦弧。

---

## 3. 地面「量角器」protractor：`client/src/scene/protractor.ts`

世界 3D 半盤，發球期所有人都渲染（可讀性）。與 serveAim 同一套約定，關鍵是**整組 yaw**：
```
groupYawForSide(side): forwardZ(side)===1 ? 0 : Math.PI   // B 整組轉 π，本地 +Z → 世界 −Z
needle: 一條沿本地 +Z 的線, needle.rotation.y = needleDeg(弧度)
        → rotateY(+Z, θ) = (sinθ, 0, cosθ)，重現 serveHorizontalDir
```
`needleDeg` 來自 `sweepAngleDeg`；為 null（尚無 phaseStart）時盤面顯示、針隱藏。

---

## 4. FPV 相機基底：`client/src/scene/renderer.ts`

**檔頭有一整段權威註解 "FPV CAMERA HORIZONTAL CONVENTION"，改任何相機前先讀它。**
```
fpvForward(yaw, pitch) = (sin yaw · cosPitch, sin pitch, cos yaw · cosPitch)
  // pitch=0 時 == shared forward(yaw)
setFirstPerson(pos, yaw, pitch): 相機置於頭高 (PLAYER_HEIGHT * FPV_CAMERA_HEIGHT_MULT=0.9)
  lookAt(eye + fpvForward)  // 直接設，不 lerp，滑鼠即時
```
three.js 由此 look 方向導出的 camera-right == shared `right(yaw)`。所以**玩家邏輯右的世界點，
對任何 yaw 都投影到 NDC x>0（畫面右）**——這正是 `cameraBasis.test.ts` 斷言的。
FPV 與第三人稱（面網時）共用同一水平基底，故同一顆球在兩視角讀到同一側。

第三人稱追隨相機（`followPlayer`）：每側鏡像（`backSign = A?−1:1`），相機在玩家後方
`CAMERA_BACK_OFFSET=6`、高 `CAMERA_HEIGHT=3.4`、看向網、俯角 `CAMERA_PITCH_DEG=18`，
以 `CAMERA_FOLLOW_LERP=0.12` 平滑。

## 5. 滑鼠轉頭符號：`client/src/view/viewController.ts`

```
this.yaw = wrapYaw(this.yaw − movementX * FPV_MOUSE_SENSITIVITY)   // 減號！
```
**由來**：increasing yaw 使 forward 轉向畫面**左**（`d(forward)/dyaw == −right(yaw)`），
所以「滑鼠右＝視角右」必須**減** movementX。這是基底的正確導數，**不是補償**。同理
serveArc 針的 `−sin` 也是正確導數。翻掉任一個都會重新引入不一致（renderer 檔頭已明示）。
pitch：`−movementY`，clamp ±`FPV_PITCH_CLAMP_RAD`(60°)。`FPV_MOUSE_SENSITIVITY=0.0022`。

## 6. FPV 發球開始時重新播種 yaw：`ViewController.faceNetForServe()`

本地發球一開始，`gameSession` 呼叫 `faceNetForServe()` 把 FPV yaw 重設回面網
（`netFacingYaw(side)`: A→0, B→π）。**其他任何地方都不會在發球期重設 yaw**。
若不重設，上一 rally 累積的滑鼠轉向會殘留，讓 FPV 相機轉著、但 HUD 針仍假設面網→
只在 FPV 把球投到反側（第三人稱與對手正常）。這是「殘留狀態」類 bug 的經典案例。

## 7. HUD 發球弧（螢幕 overlay）：`client/src/hud/serveArc.ts` — yaw-aware

FPV 底部 2D 半盤，只在「FPV + 輪到你發球」顯示。針方向**每幀重新把世界瞄準投影過
當前相機基底**（不是假設面網——玩家可在蓄力中轉頭）：
```
needleVector(deg, side, yaw):
  aim = (fz·sin(θ), fz·cos(θ))            // 世界瞄準, fz=forwardZ(side)
  forward=(sin yaw, cos yaw); right=(−cos yaw, sin yaw)
  screenRight = aim·right = fz·sin(yaw−θ)
  return { x: fz·sin(yaw−θ), y: −fz·cos(yaw−θ) }   // canvas y 向下故 −forward
```
面網時（yaw=0/π 兩側都）化簡為 `x=−sinθ, y=−cosθ`＝舊固定映射，故種好的姿態不變。
`needleVector` 被匯出，讓 `cameraBasis.test.ts` 斷言**真正的 HUD 映射**而非副本。

## 8. FPV viewmodel 手臂：唯一允許的鏡像

`characterConstants.ts` `FPV_VM_GROUP_YAW = Math.PI`：viewmodel host group 轉 180°，
把姿勢機的角色本地 +Z（「朝球前方」）指進相機視野（−Z）。**這是整條鏈唯一的鏡像。**
`PlayerCharacter.updateViewmodel` 曾**額外**再把 aim.x 取負（號稱「保持慣用手」）→
雙重鏡像，瞄左手臂揮右。修正＝拿掉那個 x 取負，只留 group yaw。
`cameraBasis.test.ts` 有守門：`armCameraSpaceDir(..., mirrorX=false)` 必須與球同螢幕側，
且 `mirrorX=true`（舊 buggy）必須落到反側（證明鏡像要保持 OFF）。

---

## 9. 四個鏡像 bug 全史（M2.8 playtest 收斂）

1. **第三人稱移動反向**（現場）：世界移動沒跟相機每側鏡像 → §1a 的 `viewToWorld` 補上。
2. **FPV 相機疑似水平鏡像**：懷疑 yaw 用成 −yaw、且兩個「符號修正」（§5 滑鼠、§7 針）
   是疊上去的補償。`cameraBasis.test.ts` 第一組證明 FPV 基底**沒有**鏡像，兩個符號是
   正確導數。→ 不動它們。
3. **發球方向在 FPV 反側**：根因是**殘留 yaw**（上一 rally 的滑鼠轉向）配上舊的**固定
   面網**針映射。兩修：`faceNetForServe`（§6 重播種）＋ yaw-aware 針（§7）。
4. **viewmodel 手臂反揮**：球飛向已修正後，手臂仍反——`updateViewmodel` 的 aim.x 取負
   與 §8 的 group yaw 雙重鏡像。→ 拿掉 x 取負。

---

## 10. 真值表守門：`client/test/cameraBasis.test.ts`（14 測）

方法＝**四 artifact 螢幕方向鏈**，兩側都測：
- FPV 相機基底：邏輯右→NDC x>0、邏輯左→x<0、pitch 不影響（±0.8）。
- 發球方向鏈（面網）：`serveHorizontalDir`（＝世界真值）→ 世界 protractor、HUD 針、
  FPV 球、第三人稱球，四者**同螢幕側**（每個 sweep 角、A/B 兩側）。用
  `screenXSign`（相機 matrixWorld 第 0 欄＝world right 點積）取號，避開近眼投影退化。
- yaw-aware 針：轉了的 yaw（±45°/±90°/±180° 殘留最壞）下，針與 FPV 球同側、且
  `needle.x ≈ 真實 camera-space x`（proportional，永不鏡像）。
- viewmodel 手臂 swing：camera-space x 號＝球螢幕側（mirror OFF）；mirror ON 反側。

**改動任一環，先在此表新增／延伸斷言，再改實作。** 別靠推理翻符號。
