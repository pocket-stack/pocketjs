# SWF → TypeScript 리라이트 규칙 (OO레인저 Ver 1.0 → PocketJS .pocket, SF2000/UniFrog)

> 대상 SWF: 사용자가 합법적으로 제공한 `무개성전대 OO레인저 Ver 1.0.swf`
> 출력: PocketJS TypeScript `.pocket` 앱 (`apps/ranger/`, SF2000 타깃).
> 이 문서는 이후 코딩 에이전트가 의미론을 창작하지 않고 그대로 구현할 수 있는 실행 계약이다.
> 일반론·조언이 아니라 값·경로·순서·수식을 고정한다.
> 본 작업은 구현이 아니라 규격 작성이다. 게임 코드는 작성하지 않는다.

기준 사실(SW F 정적 분석, 팩트로 취급):
`FWS v6`, `AVM1(DoAction 있음, DoABC 없음)`, 스테이지 `600x330`, `24fps`,
루트 타임라인 `19프레임`, `DefineSprite 621개`, `ShowFrame 10,680`,
`PlaceObject2 55,100`, `RemoveObject2 2,513`, `DoAction 1,551블록`,
AVM1 액션 레코드 약 `100,512개`,
핵심 문자열 `_root/_parent/attachMovie/hitTest/gotoAndPlay/gotoAndStop/Key.isDown/Color/setTransform/Math.atan2/sqrt/random/동적멤버접근`,
`DefineSound 36개(MP3, 11025Hz 16-bit mono)`, 대부분 벡터/폰트, 무손실 비트맵 3개.

실측 저장소 계약(가정 금지, 아래 경로에서 확인됨):
`hosts/sf2000/src/lib.rs` — `WIDTH=320, HEIGHT=240, FPS=60.0`,
`globalThis.frame(buttons, analog)` 매 `retro_run` 1회 호출,
`globalThis.__simHz=60`, `globalThis.__pak` ArrayBuffer,
60Hz 로직/30Hz 제시(`tick_index & 1`이면 래스터 스킵),
DrawList 워드 동일 시 래스터 전체 스킵 후 이전 프레임 유지,
`raster::render_scaled_rgb565(ui, words, fb, 1)`.
`hosts/sf2000/src/ffi.rs` — `ui` 네임스페이스 연산:
`createNode/destroyNode/insertBefore/removeChild/setStyle/setProp/setPropBatch/`
`setText/replaceText/uploadTexture/setImage/setSprite/animate/cancelAnim/`
`setFocus/setActive/loadStyles/loadFontAtlas/measureText/loadTileTexture/`
`freeTexture/uploadImgEntry`, `__host="sf2000"`, `__hostAbi=1`,
`__textures/__sprites` 사전 공개, 뷰포트 `320x240`, `set_max_3d_subdiv(2)`,
**오디오 네임스페이스(`globalThis.audio`) 없음**.
`hosts/sf2000/src/pak.rs` — pak 키 규칙:
`ui:styles`, `ui:font.*`, `ui:img.*`, `ui:sprite.*`만 부트 피드.
`contracts/spec/spec.ts` — `BTN` 비트, `ANALOG_CENTER=0x8080`,
`FIXED_DT=1/60`, `TEX_MAX_DIM=512(pow2)`, `PSM{5650,4444,8888,T8}`,
`IMG_FLAG_RLE/LINEAR`+PackBits, `PAK_MAGIC/PAK_VERSION=1/HEADER=32/ENTRY=24`,
`MAX_TREE_DEPTH=64`, `ROOT_ID=1`.
`contracts/spec/platforms.ts` — `sf2000` 프로파일:
`hostAbi=1, takeover, 320x240 native, rasterDensity=1`,
`capabilities=["input.buttons","text.glyphs.baked"]` — 그 외 없음
(`audio.pcm`, `input.analog/cursor/touch` 미광고).
`contracts/spec/audio.ts` — `AUDIO_RATES=[44100,22050,11025]`,
`AUDIO_RING_FRAMES=16384`, `AUDIO_MAX_STREAMS=4`,
`audioFramesForTick(rate,tick)`, pak 접두 `audio:wav.`.
`framework/src/clock.ts` — `TICKS_PER_SECOND(기본 60)`,
`VALID_HZ`(약수만 허용), `normalizeHz`, `after(초,cb)`,
`virtualFrame/virtualNow/simulationHz`.
`framework/src/frame.ts` — `onFrame(cb)`,
`onButtonPress(mask,cb,{latched,allowWhenBlocked,active})`
(엣지=`buttons & ~prevButtons`), `createSpriteAnimation(frames,{frameStep})`.
`framework/src/host.ts` — 프레임 서명
`frame(buttons, analog?, touches?, hits?, touchSurfaces?)`,
`setPropBatch(Float64 [nodeId,propId,value] 반복)` = `setProp` 반복과 동일 의미,
`setSprite(id,atlas,frames,cols,step)`(코어가 vblank마다 자동 순환, JS 무개입).
`framework/src/audio-api.ts` — `decodeWav`(PCM16·1–2ch·허용레이트만, 위반 시 throw),
`createWavPlayer()`(크레딧 펌프, `globalThis.audio` 부재 시 전 호출 silent no-op,
픽셀 동일성 유지).
`framework/src/pak.ts` — `__pak/loadPack/get/entries`
(ASCII 키, QuickJS 안전).
`framework/src/primitives.ts` — `View/Text/Image/Sprite`
(`sprite` prop = `ui:sprite.<name>` 키, 코어 자동재생).
`apps/ranger/pocket.json` — `logical [320,240], presentation native`,
`requires ["input.buttons","text.glyphs.baked"]`,
`entry apps/ranger/main.tsx, output ranger`.
빌드 명령: `bun tools/pocket.ts build --target sf2000 --manifest apps/ranger/pocket.json --project-root .`
→ `dist/ranger.pocket`.
결정성: `docs/DETERMINISM.md` — `state[n+1]=F(state[n],input[n])`,
시간=`after()`·가상프레임, `Math.random/Date.now/setTimeout` 금지,
`hosts/sim/sim.ts runScenario({app,hz,seconds,script})`+해시 동등 어서션.
선행 구현체(패턴 재사용처, 의미 변경 금지):
`apps/ranger/battle.tsx`(스케일 `S=0.5/GX/GY`, 변형/아틀라스 JSON 분리,
`POSE` 1-based 맵, `DMG` 테이블), `apps/ranger/sheets.ts`(자동생성),
`tests/ranger-sim.test.ts`(시나리오→`treeHasText`→해시 재실행 동등).

---

## 1. 범위·비목표·저작권 경계

### 1.1 범위(반드시 수행)

1. SWF의 게임 의미(장면 전이, 전투 수치, 충돌, 입력 반응, 점수/콤보/HUD)를
   수작업으로 TypeScript에 재구현한다. 자동 디컴파일 출력을 그대로 복사하지 않는다.
2. 파생 에셋은 기본적으로 로컬·생성 경로에만 둔다. 원본 SWF 바이트·추출 원본·
   디컴파일러 중간출력은 커밋하지 않는다. 파생 PNG·WAV의 커밋·재배포는
   §1.3 제3항의 권리 조건을 만족할 때만 허용된다(§4.7).
3. 앱은 `apps/ranger/` 단일 앱으로, SF2000 계약(320x240, 버튼만, 베이크드 글리프) 안에서 동작한다.
4. 음향은 §9의 silent-first 순서를 따른다. M1까지는 무음 + 시각 동등이 합격 조건이다.

### 1.2 비목표(하지 않는다)

1. Flash VM/AVM1 인터프리터/DoAction 바이트코드 실행기를 런타임에 포함하지 않는다.
   AVM1은 분석 입력일 뿐이며, 실행은 §5의 매핑표에 따라 사람이 쓴 TS 코드다.
2. DOM·Canvas2D·WebGL·브라우저 전용 API를 사용하지 않는다.
   `document/window/canvas/getContext/WebGLRenderingContext/XMLHttpRequest/fetch` 직접 사용 금지.
   네트워크가 필요하면 `contracts/spec/net.ts`+`globalThis.net` 경로만 허용된다.
   단, 네트워크 필요 여부는 가정하지 않는다. M0에서 외부 통신 흔적
   (`getURL/loadVariables/XML/loadMovie` 등의 정적 인벤토리, §5.10 U-1, §10 M0)을
   먼저 확정하고, 흔적이 없으면 미사용으로 기록한다.
3. SF2000 호스트 Rust 코드(`hosts/sf2000/`) 수정, 오디오 모듈 호스트 구현,
   엔진 코어(`engine/core/`) 수정을 본 리라이트 이슈에서 하지 않는다.
   오디오 호스트 작업은 별도 이슈로 분리한다(§9.5).
4. SWF 19프레임 루트 전체·621개 스프라이트 전량을 1:1 복원하지 않는다.
   실제 게임에 도달 가능한 장면·클립만 이식하고, 미도달 분기는 명시적 스킵 목록으로 기록한다(§10 M0).

### 1.3 저작권 경계(강제)

1. 원본 SWF는 저장소 밖에 둔다. 저장소 안(어느 경로든)으로 복사·이동·커밋하지 않는다.
   쿡 스크립트와 코드는 `RANGER_SWF` 환경변수 또는 명령행 인자로 전달된 경로에서만 읽는다.
   코드에 절대경로나 한글 파일명을 하드코딩하지 않는다.
   이 문서 전문에 등장하는 절대경로는 연산자 측 원본 참조(예시)일 뿐이며 코드에 복사하지 않는다.
2. SWF에서 파생된 추출물(PNG·WAV·디컴파일러 중간 덤프 `*.as`/`*.xml`/`xfl/`·원본 바이너리 조각)은
   기본적으로 로컬·생성 경로에만 두고 커밋하지 않는다. 무시 범위는 추출·입력 경로에 한정한다:
   `tools/ranger-cook/out/**`, `tools/ranger-cook/in/**`, `ffdec-out/`, `*.xfl`.
   전역 `*.mp3` 무시는 사용하지 않는다(합성·라이선스 음원 등 정당한 MP3 커밋을 막지 않기 위함).
3. 파생 PNG·WAV를 저장소에 커밋하거나 재배포(개인 기기 패키징을 넘는 배포)하려면
   재배포 권리의 명시적 확인이 있거나, 권리 문제가 없는 오리지널·라이선스 에셋으로 교체해야 한다.
   확인 전에는 로컬 생성 + 개인 기기 패키징 용도로만 사용한다.
   `pak.json`이 가리키는 커밋 에셋은 권리 확인이 끝나지 않았다면 M5 수락을 통과할 수 없다.
   (권리 확인 절차 자체는 본 계약 범위 밖이며, 확인 사실을 `tests/ranger-assets-rights.test.ts`의
   명시 상수 `ASSET_RIGHTS_CONFIRMED: boolean`으로 기록한다. 기본값 `false`.)
4. 허용 커밋물(권리 확인 후 또는 파생물이 아닐 때): 손으로 쓴 `.ts/.tsx`,
   쿡(cook) 스크립트(`tools/ranger-cook/*.ts`), 쿡 산출 JSON
   (`anim.json/images.json/sprites.json`), 자동생성 `sheets.ts`,
   `pak.json`, 테스트·테이프·문서. 파생 PNG·WAV는 제3항의 조건을 만족할 때만 커밋한다.
5. 역어셈블/디컴파일 텍스트를 주석·문서·문자열로 붙여넣지 않는다.
   프레임 스크립트는 의미 단위로 재작성하고, 출처는
   `swf:<태그>#<id> frame <n>` 형태의 참조 ID로만 기록한다(원문 비포함).

---

## 2. 좌표계: 600x330 → 320x240 스케일·레터박스(정확 규격)

### 2.1 채택 변환(유일 정답)

- 균등 스케일(종횡비 유지, 레터박스):
  `S_NUM=8, S_DEN=15` (즉 `S=8/15=0.53333…`).
  근거: `min(320/600, 240/330)=min(8/15, 8/11)=8/15`.
- 내용 크기: `600*8/15=320`, `330*8/15=176`.
- 오프셋: `OX=0`, `OY=(240-176)/2=32`.
- 매핑(소수 금지, 정수 연산으로 고정):
  `GX(x) = OX + floor(x * 8 / 15)`,
  `GY(y) = OY + floor(y * 8 / 15)`,
  역매핑(디버그·히트 리포트용):
  `INV_GX(px) = ceil((px - OX) * 15 / 8)`,
  `INV_GY(py) = ceil((py - OY) * 15 / 8)`.
- 크기 매핑: `GW(w)=floor(w*8/15)`, `GH(h)=floor(h*8/15)`.
  최소 1px 보장 규칙: 원본 `w>0`인데 `GW(w)=0`이면 `1`로 올린다(0-폭 노드 금지).
  위치는 floor, 크기는 floor+최소1px를 사용한다. 반올림 혼용 금지.

### 2.2 금지 사항

1. `S=0.5` 근사 스케일을 신규 코드에 사용하지 않는다.
   (`apps/ranger/battle.tsx`의 `S=0.5/OX=10/OY=40`은 선행 슬라이스 한정이며,
   본 계약 이후의 정식 이식은 §2.1 값으로 통일한다. 기존 파일 수정은 본 이슈가 아니라
   후속 마일스톤에서 수행한다.)
2. `presentation: native` 외의 pocket.json 표현을 사용하지 않는다.
   호스트가 스케일하지 않으므로 레터박스는 앱이 직접 그린다.
3. 종횡비를 깨는 `stretch`(비균등 x/y 스케일) 금지.

### 2.3 레터박스·클리핑 규칙

1. 루트는 `320x240` 전체를 차지하는 `View` 1개이며,
   배경색은 SWF 스테이지 배경의 ABGR 값으로 고정한다(값은 M0에서 확정·상수화).
2. 게임 내용 노드는 `(0,32)` 원점의 `320x176` 컨테이너 안에만 배치한다.
   이 컨테이너에 `overflow: hidden`에 상당하는 클리핑을 적용한다.
   (PocketJS 계약상 `PROP.overflow=Overflow::Hidden` → draw 스키서.
   `spec.ts PROP.overflow=30`.)
3. 상하 각 32px 레터박스 바에는 게임 오브젝트·히트박스·텍스트를 배치하지 않는다.
   HUD가 SWF에서 스테이지 전역에 그려진 경우에도 Y에 `+OY`를 강제 적용해
   내용 컨테이너 안으로 끌어들인다.
4. 반투명 검정 바를 별도로 그려 덮지 않는다. 루트 배경이 곧 바이므로 추가 노드 금지.

### 2.4 텍스트·폰트 스케일

1. 폰트 크기는 `floor(원본pt * 8 / 15)`를 사용하되, 최소 `8px`로 올린다.
   베이크드 아틀라스 슬롯(`MAX_FONT_SLOTS=24`)에 없는 크기는
   가장 가까운 하위 슬롯으로 내림하고 자간(`tracking`)으로 보정하지 않는다.
   자간 보정은 레이아웃을 비결정적으로 만들므로 금지.
2. 텍스트 측정·개행은 `measureText`+엔진 개행에 위임하고,
   TS에서 픽셀폭을 재계산해 줄바꿈을 흉내 내지 않는다.

### 2.5 검증식(테스트에 그대로 사용)

```ts
// tests/ranger-coords.test.ts (신규, M1)
import { expect, test } from "bun:test";
const GX = (x: number) => Math.floor((x * 8) / 15);
const GY = (y: number) => 32 + Math.floor((y * 8) / 15);
test("stage mapping pins", () => {
  expect(GX(0)).toBe(0);
  expect(GX(600)).toBe(320);
  expect(GY(0)).toBe(32);
  expect(GY(330)).toBe(208); // 32+176
  expect(GY(300)).toBe(192); // 원본 지면선 300 → 192
});
```

---

## 3. 시간: 24Hz SWF 시뮬레이션 over 60Hz 호스트(무드리프트 정수 스케줄러)

### 3.1 클록 소유권

1. 호스트 틱은 `60Hz`로 고정된다(`hosts/sf2000/src/lib.rs FPS=60`,
   `globalThis.__simHz=60`, `tools/build.ts` 번들도 `--hz` 미지정 시 60).
   번들의 `--hz`를 24로 바꾸지 않는다. PocketJS 계약상 번들은
   호스트가 구동하는 레이트로만 정확히 동작하므로(`framework/src/host.ts assertNativeHostContract`),
   24Hz 월드와 60Hz 구동 레이트를 일치시키려는 시도는 금지다.
2. SWF 시간은 앱 내부의 가상 카운터 `swfFrame: i32`(0-based)와
   `swfTick: u64`(SWF 프레임이 전진한 횟수)로만 표현한다.
   `framework/src/clock.ts`의 `virtualFrame/virtualNow/after()`는
   UI 타이머(배너·콤보 만료 등)에만 사용하고, 게임 시뮬레이션 스텝에는 사용하지 않는다.
   두 클록을 혼용해 게임 상태를 전진시키지 않는다.

### 3.2 정수/유리 스케줄러(유일 구현)

호스트 `onFrame` 1회 = 호스트 틱 1개. SWF 프레임 전진량은 유리수 `24/60=2/5`이므로
부동소수 누적 없이 Bresenham 누산기로 분배한다:

```ts
// apps/ranger/sim/scheduler.ts (신규, 손작성)
export interface SwfScheduler {
  /** 다음 SWF 프레임까지 남은 호스트 틱이 아니라, 누적자 자체다. */
  acc: number; // 0 <= acc < 60 invariant
  swfFrame: number; // 현재 SWF 프레임 인덱스(루트 기준 0-based)
}
export function schedulerStep(s: SwfScheduler): number {
  // 이번 호스트 틱에서 전진할 SWF 프레임 수(0 또는 1)를 반환한다.
  // 24fps이므로 5틱당 정확히 2프레임: 반환값 패턴 [0,0,1,0,1]의 반복.
  s.acc += 24;
  if (s.acc >= 60) {
    s.acc -= 60;
    s.swfFrame += 1;
    return 1;
  }
  return 0;
}
```

1. `acc`는 정수만 취한다. 초기값 `0`. `+=24`, `>=60`이면 `-=60` 후 1프레임 전진.
   `0.4`, `2.5` 같은 부동소수 상수·`Math.round` 누적 금지.
2. 5호스트틱당 정확히 2 SWF프레임, 120호스트틱(2초)당 정확히 48 SWF프레임을 보장한다.
   드리프트 허용오차는 0이다(오차 누적 자체가 없도록 설계).
3. 실제 전진 패턴(검증용 고정값): `acc` 초기값 `0`에서 틱별 반환값은
   `[0,0,1,0,1]`의 반복이다. acc 추적: `0→24→48→12(전진)→36→0(전진)→24…`.
   처음 10개 반환값은 `[0,0,1,0,1,0,0,1,0,1]`이다.
   `tests/ranger-scheduler.test.ts`는 다음 세 가지를 모두 단언한다:
   (a) 처음 10개 반환값이 위 배열과 일치,
   (b) 틱 5개마다 누적 전진량이 정확히 2,
   (c) 120틱 누적 전진량이 정확히 48.
4. 일시정지(`stop()`된 클립·히트스톱·포즈)는 스케줄러를 멈추는 것이 아니라
   전진된 SWF 프레임의 *적용*을 건너뛰는 것으로 구현한다.
   `acc/swfFrame` 자체는 계속 전진해야 재개 시 위상이 어긋나지 않는다.
   단, 전체 게임 포즈(START 메뉴 등)는 `acc`도 함께 동결한다(재개 후 동일 위상).

### 3.3 SWF 프레임 적용 순서(1 SWF프레임당 파이프라인)

SWF 프레임이 1 전진할 때마다 다음 순서로 정확히 1회 실행한다.
호스트 틱에서 전진이 0이면 아무것도 하지 않는다(입력 수집 제외):

```
1. 입력 수집: 매 호스트 틱 §3.4의 호스트-레이트 엣지 누산 (전진 여부와 무관하게 항상 실행)
2. SWF 전진 판정 (schedulerStep)
3. 전진이 1이면 (M0 인벤토리 확정 전까지 c/d/e는 순서 없는 플레이스홀더다.
   확정 순서를 가정하지 않고, 같은 작업을 두 단계에 중복 기재하지 않는다):
   a. 입력 스냅샷: `const input = swfConsume()`를 정확히 1회 호출해
      불변 `{pressed, held}` 스냅샷을 만든다. `pendingPressed`는 이 순간
      정확히 1회 클리어된다. 같은 스텝에서 두 번째 소비를 하지 않는다.
   b. 표시 객체 갱신 (Place/Remove 적용, `input` 불필요 시 전달 생략 가능)
   c. 프레임 스크립트 실행 [실행 순서 미정 — M0 후 §5.6에 명시, `input` 전달]
   d. 클립 이벤트 핸들러 실행 [실행 순서 미정 — M0 후 §5.6에 명시, `input` 전달]
   e. 게임 상태 확정 (이동·충돌·점수) [실행 순서 미정 — M0 후 §5.6에 명시, `input` 전달]
   f. 사운드 트리거 수집 (발화만 기록, 실제 pump는 onFrame 말미에 1회)
4. 렌더 바인딩: 변경된 노드만 setProp/setSprite/setText (→ §8.4 배치 규칙)
```

c/d/e와 게임 로직 전체는 이 스텝의 `input` 스냅샷만 사용한다.
원시 `buttons` 인자를 직접 읽지 않고, 스텝 중간에 `swfConsume()`을 다시 호출하지 않는다.
끝부분 소비는 금지다. 끝에서 소비하면 프레임 스크립트·게임 로직이
오래된 입력(또는 원시 입력)으로 동작해 1 SWF프레임 지연이 생기기 때문이다.
사운드·렌더는 로직 확정 뒤에 따른다.
M0 인벤토리 확정 후 c/d/e를 하나의 명시 순서로 교체하고 원본과의 편차를 §5.6에 기록한다.
확정 전에는 어떤 순서도 고정된 것으로 취급하지 않는다.

### 3.4 입력 수집(호스트-레이트 엣지 누산 → SWF 스텝 소비)

호스트는 60Hz로 폴링하고 SWF는 24Hz로 소비하므로, 전진하지 않는 틱에서
일어났다 사라지는 press를 잃지 않도록 호스트 틱마다 엣지를 누산한다.
단순 OR 누산(`latch |= buttons`)은 릴리스를 추적하지 못해
press-release-press를 하나의 press로 합쳐 버리므로 사용하지 않는다.

```ts
// sketch (excluded from typecheck) — apps/ranger/sim/input.ts의 배선 모양.
// 완전한 컴파일 가능 본은 tests/ranger-doc-examples.test.ts에 둔다(§6.6).
let pendingPressed = 0; // 소비 대기 중인 엣지(OR 누적)
let lastHostButtons = 0; // 직전 호스트 틱의 원시 마스크
let latestHeld = 0; // 최신 호스트 틱의 원시 마스크
export function hostPoll(buttons: number): void {
  pendingPressed |= buttons & ~lastHostButtons;
  lastHostButtons = buttons;
  latestHeld = buttons;
}
export function swfConsume(): { pressed: number; held: number } {
  const out = { pressed: pendingPressed, held: latestHeld };
  pendingPressed = 0;
  return out;
}
/** 테스트 전용 접근자. 게임 로직에서 호출하지 않는다. */
export function pendingForTest(): number {
  return pendingPressed;
}
```

1. `onFrame((buttons) => hostPoll(buttons))`를 매 호스트 틱 실행한다(전진 여부 무관).
2. 전진이 1인 스텝의 맨 처음에 `swfConsume()`을 정확히 1회 호출해
   불변 `{pressed, held}` 스냅샷을 만든다(§3.3-3a).
   게임 로직·프레임 스크립트·이벤트 매핑은 이 스냅샷만 사용한다.
   원시 `buttons` 인자를 직접 소비하지 않고, 같은 스텝에서 두 번 소비하지 않는다.
3. `pendingPressed`는 스냅샷 생성 순간 `0`으로 클리어된다.
   held 지속은 `latestHeld`가 보장하므로 소비 후 되돌림이 필요 없다.
4. 테스트(`tests/ranger-input.test.ts`, M1): 스케줄러 패턴 `[0,0,1,0,1]`과 일치하는
   틱 위치에서 2개 전진 스텝에 걸친 2회 소비(스텝당 1회)로 검증한다. `C = BTN.CROSS`라 할 때:
   - 호스트 틱0: `hostPoll(0)` (전진 0)
   - 호스트 틱1: `hostPoll(C)` (전진 0, 첫 press)
   - 호스트 틱2: `hostPoll(C)` (전진 1) → 1차 소비:
     `pressed === C`, `held === C`, 소비 후 `pendingForTest() === 0`
   - 호스트 틱3: `hostPoll(0)` (전진 0, 릴리스)
   - 호스트 틱4: `hostPoll(C)` (전진 1, 재press) → 2차 소비:
     `pressed === C`(새 press), `held === C`, 소비 후 `pendingForTest() === 0`
   구 단순 OR 방식(`latch |= buttons` + `pressed = latch & ~prevLatch` + 소비 후
   `latch = held`)은 이 테스트를 통과할 수 없다:
   틱3에서 `latch`가 `C`로 유지되므로 2차 소비의 `pressed`가 `0`이 되기 때문이다.
   `pendingPressed` 모듈 내부 변수에 직접 접근하지 않는다.
   소비 후 상태 단언은 공개 테스트 전용 접근자 `pendingForTest()`로만 수행한다.
5. 동일 스텝 전달·단일 소비 테스트(`tests/ranger-input.test.ts`, M1):
   전진 틱에서 `const input = swfConsume()` 1회로 스냅샷을 만든 뒤,
   두 스텁 소비자(프레임 스크립트 대역·게임 로직 대역)에 같은 `input`을 전달하고
   양쪽이 동일한 `pressed/held`를 받았음을 단언한다.
   같은 스텝에서 `swfConsume()`을 즉시 재호출하면 `pressed === 0`이어야 하며
   (이미 클리어됨), 이를 단언한다. 스텝 끝부분 소비·원시 입력 직접 사용·
   스텝당 2회 소비는 모두 실패로 판정한다.

### 3.5 난수·시간 API

1. `random(n)` → `irandom(n)`: `0..n-1` 정수, 시드 RNG만 사용.
   구현은 `xorshift32`로 고정한다(초기 시드 `0xC0FFEE`, 리플레이 시나리오가 명시한 시드로 리셋 가능).
   `Math.random` 사용 금지(정적 검사 대상).
2. `getTimer()` → `swfGetTimerMs() = floor(swfFrame * 1000 / 24)`.
   `Date.now/performance.now` 사용 금지.
3. `Math.atan2/sqrt`는 게임 조준·거리 계산에만 사용하며,
   결과는 정수 픽셀·정수 각도(0–255 브리스)로 양자화한 뒤 사용한다.
   부동소수 누적 상태(위치·속도)를 `number` 소수로 유지하지 않는다.
   위치·속도는 `1/16px` 고정소수 정수(`i32`, 단위=subpx)로 유지한다(§6.1 `Fixed`).

---

## 4. 에셋 추출 매니페스트·안정 ID·래스터·시트 정책(원본 SWF 미커밋)

### 4.1 디렉터리·파일 배치(고정)

```
tools/ranger-cook/        손작성 쿡 스크립트만 (런타임 import 금지)
  cook.ts                 진입점: extract→raster→pack-manifest 생성
  ids.ts                  안정 ID 배정표 (§4.2)
  raster.ts               래스터 규칙 (§4.4)
apps/ranger/
  pak.json                빌드가 읽는 pak 선언 (손작성, §4.6)
  anim.json               생성물: 변형/타임라인/프레임 배치 (편집 금지)
  images.json             생성물: 비트맵 3종+배경 메타 (편집 금지)
  sprites.json            생성물: 스프라이트 아틀라스 메타 (편집 금지)
  sheets.ts               생성물: SHEET_NAMES (편집 금지)
  v*.png bg.png …         파생물: 래스터 PNG (기본 로컬·생성 경로, §1.3 제3항 조건 시에만 커밋)
  main.tsx battle.tsx sim/*  손작성 게임 코드 (§7)
tests/
  ranger-cook.test.ts     매니페스트·ID 안정성 테스트 (§10)
```

### 4.2 안정 ID 규칙(재생성해도 동일해야 함)

1. ID는 SWF 태그 ID에서 기계적으로 유도하며, 이름·순서에 의존하지 않는다:
   - 스프라이트(DefineSprite) 캐릭터: `v<characterId>` (예: `v328`, `v1144`).
     기존 `apps/ranger`의 `v1144.png/v328.png` 명명과 호환된다.
   - 스프라이트 내부 래스터 조각(PlaceObject 분해): `v<characterId>p<placeIndex>`.
     `placeIndex`는 해당 스프라이트의 PlaceObject 등장 순서(0-based)이며,
     프레임 번호가 아니라 등장 순서다. (예: `v1153p0/p1/p2`.)
   - 무손실 비트맵(DefineLossless): `b<bitmapId>`.
   - 사운드(DefineSound): `s<soundId>` (숫자) + 별칭 `s<soundId>_<slot>`
     (슬롯=용도별 재사용 구분. 예: `s12_hit`).
   - 폰트: `f<fontId>_<size>`.
2. `tools/ranger-cook/ids.ts`에 `characterId → 안정ID` 전수 매핑 테이블을 하드코딩한다.
   쿡은 이 테이블에 없는 ID를 만나면 실패한다(자동으로 새 ID를 발명하지 않는다).
   새 클립을 이식 범위에 추가할 때는 테이블에 행을 추가하는 커밋을 먼저 한다.
3. 파일명·JSON 키는 안정 ID와 1:1이다. 대소문자·확장자 변형 금지(소문자·`.png` 고정).

### 4.3 매니페스트 규칙(`pak.json`+3 JSON)

1. `apps/ranger/pak.json`은 빌드(`tools/build.ts`→`framework/compiler/pak.ts`)가 읽는
   유일한 선언이다. 런타임이 파일시스템을 탐색하지 않는다.
2. `anim.json` 스키마(생성물, §6.4 참조):
   `{ variants: Record<VariantId,{ax,ay,frames:VFrame[]}>, sheets: Record<SheetName,SheetMeta>, fighters: Record<FighterId,{labels:[frameNo,name][],frames:PLayer[][]}> }`.
   `VFrame={sheet,cell,ox,oy,w,h}`, `Sheet={cellW,cellH,cols,rows,frames}`.
   좌표는 모두 §2.1 매핑 후의 디바이스 px 정수다(소수 금지).
3. `images.json`: 무손실 비트맵 3종 + 배경의 `{id,w,h,psm,src}` 목록.
   `sprites.json`: 아틀라스별 `{name,frames,cols,step,psm}` 목록으로,
   SF2000 `ffi.rs register`의 `__sprites` 메타(`handle/frames/cols/step`)와 키가 일치해야 한다.
4. `sheets.ts`는 `SHEET_NAMES` 상수 하나만 export하며, 파일 선두에
   `// auto-generated by tools/ranger-cook/cook.ts — do not edit.`를 포함한다.
   앱(`battle.tsx`)은 모든 시트명에 대해 `SHEETS[name]` 존재를 assert한다(기존 패턴 유지).

### 4.4 래스터·스프라이트시트 정책

1. 래스터 밀도=1. SF2000 `rasterDensity=1`이므로 2x·3x 변형을 만들지 않는다.
   소스는 SWF 벡터를 디바이스 px(§2.1)로 직접 렌더한 것이다.
2. 셀 크기: 각 시트는 `cellW/cellH`가 2의 거듭제곱이 아니어도 되지만,
   시트 전체 텍스처(`w,h`)는 `TEX_MAX_DIM=512` 이하의 pow2여야 한다
   (`uploadTexture` 계약). 셀은 pow2 시트 안에 패킹하고 남은 영역은 투명으로 둔다.
3. 패킹: 한 변형(variant)=1개 행(row) 이상을 차지한다. 셀 경계를 가로지르는
   블리딩 방지를 위해 셀 간 1px 투명 개터(gutter)를 둔다. 회전·스케일 보간을 전제로 한 여유 패딩은 넣지 않는다
   (SF2000은 `IMG_FLAG_LINEAR` 사용을 기본으로 하지 않는다 — §4.5).
4. PSM 선택(고정 규칙):
   - 불투명 배경·타이틀: `PSM_5650`.
   - 256색 이하 + 1-bit 또는 4-bit 알파 스프라이트: `PSM_T8`(1024B 팔레트+인덱스).
   - 부드러운 알파(그림자·이펙트): `PSM_4444`.
   - `PSM_8888`은 HUD 숫자 등 소수 에셋에만 허용하고, 사용 시 `pak.json`에 사유 주석을 단다.
5. 팔레트: `PSM_T8`의 256색은 시트별 독립 팔레트이며 ABGR(`0xAABBGGRR`)로 저장한다.
   전역 공유 팔레트 금지(시트별 최적 양자화가 우선).
6. 애니메이션은 `setSprite(id,atlas,frames,cols,step)`의 코어 자동 순환을 우선 사용한다.
   `step`= SWF 프레임당 호스트틱 수(보통 2 또는 3, §3.2 패턴에서 도출).
   코어 자동 순환으로 표현 불가한 분기(히트 반응·콤보 분기)는 TS가 아틀라스를 교체한다.

### 4.5 투명·피벗·바운드 규칙

1. 투명: SWF shape의 알파는 PNG 알파로 보존한다. 컬러키(특정색 투명화) 금지.
   `uploadTexture` 시 알파 프리멀티플라이를 하지 않는다(코어가 기대하는 비프리멀티플라이 기준).
2. 피벗: 모든 셀의 기준점은 좌상단이다. SWF의 행렬 `tx/ty`는 셀 오프셋 `ox/oy`로 베이크한다:
   `ox = GX(tx) - minX`, `oy = GY(ty) - minY`
   (`minX/minY`는 해당 변형의 전체 AABB 최소점, 디바이스 px 정수).
   앵커 변형(`VARIANTS[v].ax/ay`)는 발바닥(캐릭터)·중심(이펙트) 중 하나로 통일하고,
   변형마다 JSON에 기록한다. 런타임에 피벗을 재계산하지 않는다.
3. 바운드: 충돌용 AABB는 렌더 AABB와 별개로 `anim.json`에 정수 rect로 기록한다
   (`{x,y,w,h}`, 디바이스 px, §2.1 매핑 후). 빈 rect(0폭) 금지 — 최소 1x1.
4. 회전·기울기(skew)된 원본은 회전된 채로 래스터한다(런타임 회전으로 복원하지 않는다).
   런타임 `PROP.rotate/scale` 사용은 HUD 펄스 등 비게임플레이 장식에만 허용한다.

### 4.6 pak 키 규칙

1. 스타일: `ui:styles`. 폰트: `ui:font.<f...>`. 이미지: `ui:img.<안정ID>`.
   스프라이트 아틀라스: `ui:sprite.<시트명>`.
   오디오(§9 이후): `audio:wav.<s...>`.
2. `hosts/sf2000/src/pak.rs feed`가 인식하는 접두와 정확히 일치해야 한다.
   그 외 접두(`swf:`, `raw:` 등) 금지.
3. `pak.json`의 raw-blob 경로는 쿡 산출물만 가리킨다. `tools/`·임시 경로 참조 금지.

### 4.7 원본·파생물 취급 규칙(강제, §1.3과 함께 읽는다)

1. 원본 SWF는 저장소 밖에 둔다. 쿡은 `RANGER_SWF` 환경변수 또는 명령행 인자로
   전달된 로컬 경로에서만 읽는다. 코드에 경로를 하드코딩하지 않는다.
2. SWF 파생 추출물(PNG·WAV·쿡 중간출력)은 기본적으로 무시되는 로컬·생성 경로에만 둔다
   (`tools/ranger-cook/out/`, `tools/ranger-cook/in/`, `ffdec-out/`).
   커밋·재배포는 §1.3 제3항의 권리 조건을 만족할 때만 허용된다.
3. `tests/ranger-cook.test.ts`는 SWF 없이 실행 가능해야 한다.
   SWF가 필요한 추출 테스트는 `RANGER_SWF`가 있을 때만 실행하고,
   없으면 `skip`한다. 코드에 파일명을 하드코딩하지 않는다.

---

## 5. AVM1 → TypeScript 매핑(전량 표)

### 5.1 타임라인·프레임

| SWF 개념 | TS 표현 | 규칙 |
|---|---|---|
| 루트 19프레임 | `ROOT_TIMELINE: RootFrame[19]` 배열(0-based 인덱스, 1-based 프레임번호 병기) | 프레임번호 `n` ↔ 인덱스 `n-1`. `labels: [frameNo,name][]` 별도 맵 |
| 프레임 레이블 | `Map<string,number>`(레이블→1-based 번호) | 중복 레이블은 빌드 에러. `gotoAndPlay("x")`는 맵 조회, 미존재 시 no-op+카운터(§5.10) |
| Sprite 타임라인 | `Variant`(§6.4)+`PLayer`(부모 프레임별 레이어 배치) | `apps/ranger`의 `FIGHTERS` 구조를 그대로 사용. 부모 프레임은 `gotoAndStop` 타깃(1-based `POSE` 맵) |
| ShowFrame | `schedulerStep` 반환 1일 때 1회 적용(§3.2) | ShowFrame 수(10,680)와 무관하게 24Hz로 샘플링. 중간 ShowFrame은 병합(Place/Remove 넷효과만 적용) |
| 중첩 타임라인 위상 | 각 클립 인스턴스가 독립 `frameIdx` 보유 | 부모 정지(`stop`)해도 자식 `play` 클립(루프 이펙트)은 계속 전진 — `apps/ranger/battle.tsx`의 "부모 HOLD+자식 루프" 모델 |

### 5.2 MovieClip 생명주기·깊이

| SWF | TS | 규칙 |
|---|---|---|
| `PlaceObject2(depth, characterId, matrix, cxform, name?)` | `placeClip(slot, variantId, gx, gy, z)` | `depth` → 같은 부모 내 `zIndex`(작은 depth가 뒤). `zIndex`는 `PROP.zIndex`로 바인딩. depth 충돌(같은 depth에 Place)은 교체(replace)이며 노드 재사용 |
| `RemoveObject2(depth)` | `removeClip(slot)` | `removeChild` 후 풀에 반납. `destroyNode`는 풀 고갈·장면 전환 시에만 |
| 인스턴스명(`name`) | `slotPath: string`(예: `root/p1/body`) | 이름 없는 인스턴스는 `depth` 기반 합성명 `d<depth>`. 런타임에 이름 변경 금지 |
| 빈 프레임(해당 depth에 배치 없음) | 노드 숨김(`display:none`에 상당, `PROP.display`) | 노드를 제거하지 않고 숨긴다(풀 재사용). 제거는 장면 전환 시 |
| 최대 깊이 | 풀 크기 고정(전투 장면: 플레이어 레이어 8 + 적 2×8 + FX 16 + 투사체 8 + HUD 8 = 64 슬롯) | `MAX_TREE_DEPTH=64`를 초과하는 중첩을 만들지 않는다. 슬롯 초과 시 쿡 에러 |

노드 재사용 풀(필수):
```ts
// 풀은 장면당 1회 할당, 프레임당 alloc 0 (§8.4)
interface ClipSlot { node: NodeMirror; inUse: boolean; variant: string; }
```

### 5.3 `_root`·`_parent` 경로 해결

1. `_root` = 루트 클립 싱글톤(`ROOT`). `_parent` = 소유자 체인의 직상위.
   `this` = 스크립트가 속한 클립 인스턴스.
2. 경로는 컴파일 타임에 슬롯 경로로 해석한다. 런타임 문자열 탐색(`root["p"+i]`)은
   허용하되 키는 §4.2 안정 ID 집합으로 제한한다. 임의 문자열 연결로 존재하지 않는
   경로를 만들면 no-op + 미해결 카운터 증가(§5.10).
3. `_root.gotoAndPlay(n)` / `_root.score` 같은 절대 접근은 `RootApi` 인터페이스(§6.2)의
   명시 메서드로만 허용한다. `RootApi`에 없는 멤버 접근은 타입 에러로 만든다
   (타입 단언·`any` 경유 금지).

### 5.4 변수·프로퍼티

| SWF | TS | 규칙 |
|---|---|---|
| 클립 변수(`this.hp`, `/:score`) | 클립별 `vars: Record<string,VarValue>` + 루트 `GameState`(§6.2) | `VarValue = number \| string \| boolean`. 객체·함수 값 금지(§5.10 U-4) |
| `_x/_y/_xscale/_yscale/_alpha/_rotation/_visible` | `PROP.translateX/translateY/scaleX/scaleY/opacity/display` | `_x/_y`는 §2.1 매핑 후 정수. `_xscale`은 `scaleX=원본/100`. `_alpha`는 `opacity=원본/100`. `_rotation`은 장식(HUD) 외 게임플레이에 사용 금지(§4.5-4) |
| `_width/_height` 읽기 | `anim.json`의 baked `w/h` 읽기 | 런타임 측정 금지. 쓰기(`_width=` 스케일)는 금지 — 스케일이 필요하면 변형 교체 |
| `_currentframe/_totalframes` | `clip.frameIdx+1`, `timeline.length` | 읽기 전용 |
| `_name`, `_target` | `slotPath` 읽기 | 쓰기 금지 |
| 동적 멤버(`clip["hp"+i]`, `this[k]`) | `vars[key]` + 허용 키 화이트리스트 | 화이트리스트는 클립별 `ALLOWED_KEYS: readonly string[]`로 선언. 외부는 no-op+카운터 |

### 5.5 `attachMovie/removeMovieClip`

1. `attachMovie(linkageId, newName, depth)` → `spawn(linkageId, slotPath, depth)`:
   `linkageId`는 쿡 테이블(`LINKAGE: Record<string,VariantId>`)에 있어야 하며,
   미등록 ID는 스폰하지 않고 카운터 증가.
2. `removeMovieClip()` → `despawn(slotPath)`: 풀 반납. 존재하지 않는 슬롯은 no-op.
3. 깊이(`depth`)는 `zIndex`로 변환한다. 음수 depth(Flash의 최상위 교체 의미)는
   `z = 1000 + depth`로 고정 매핑한다(규칙 하나로 통일).

### 5.6 `play/stop/goto`·프레임 스크립트·클립 이벤트

1. `play()` = `clip.playing=true`, `stop()` = `clip.playing=false`.
   기본값: 루트 `playing=true`, 자식 이펙트 `playing=true`, 전투 포즈 클립 `playing=false`(HOLD).
2. `gotoAndPlay(n|label)` = `frameIdx=resolve(n)-1; playing=true; runFrameScriptOnce`.
   `gotoAndStop(n|label)` = `frameIdx=resolve(n)-1; playing=false; runFrameScriptOnce`.
   `nextFrame/prevFrame` = ±1 이동 후 `playing=false`.
3. 실행 순서는 창작하지 않는다. M0에서 다음 인벤토리를 먼저 확정한다:
   DoAction 블록 1,551개의 소속(프레임 스크립트 vs 버튼/클립 핸들러),
   PlaceObject2 ClipActions의 존재·종류(keyPress/load/unload/enterFrame 등),
   DoAction에서 대입된 `onEnterFrame/onLoad/onUnload` 핸들러의 전체 목록.
   AVM1은 `MovieClip.onEnterFrame`과 ClipActions를 지원하므로,
   어떤 핸들러가 존재하는지는 분석으로 증명한다. 부재를 단정하지 않는다.
4. 인벤토리 확정 후, 수작업 대응물의 실행 순서를 §3.3의 b/c/d 자리에
   하나의 명시 순서로 기록하고 원본과의 편차를 함께 기록한다.
   확정 전까지는 순서를 가정하지 않는다(예시 순서의 잠정 기재도 금지).
   같은 프레임에 재진입(`goto`로 자기 자신을 가리킴)해도 스크립트는 1회만 실행한다
   (수작업 규칙: 재진입 가드 `scriptRunMark: u32`).
5. DoAction 블록은 위 순서의 대응 위치로 편입한다.
   블록 경계·바이트코드 순서는 보존하지 않고 의미 단위로 재작성한다.
   단, `if/loop` 조건식은 원본 의미를 주석이 아닌 코드 분기로 보존한다.

### 5.7 `Color/setTransform`

PocketJS 코어에는 임의 색행렬이 없으므로 다음 3단계 규칙으로만 처리한다:

1. 순수 알파(`ra=rb=ga=gb=ba=bb=0 아님, aa만 변경`) → `PROP.opacity`로 매핑.
2. 플래시·피격 깜빡임(덧셈 오프셋 `rb/gb/bb` 사용) → 쿡 타임에 틴트 변형을 미리 래스터한다.
   예: `hurt` 틴트(적색 +40), `guard` 틴트(청색 +30). 런타임은 변형 교체로만 표현한다.
3. 그 외 임의 행렬(대비·채도 변경 등)은 미지원(§5.10 U-3)으로 분류하고,
   가장 가까운 틴트 변형으로 대체 + `UNSUPPORTED.colorMatrix` 카운터.
   런타임에 픽셀 단위 틴트를 계산하지 않는다(soft-float 금지).

### 5.8 `hitTest` 두 모드

1. `hitTest(target)` (바운드 모드, shapeFlag 생략/false):
   양쪽 AABB(§4.5-3, 디바이스 px 정수) 교차 여부. 경계 접촉은 충돌으로 본다(포함 경계).
2. `hitTest(x, y, true)` (셰이프 모드):
   점이 대상의 AABB 안에 있는지로 근사한다. 픽셀 퍼펙트 판정 금지.
   단, 판정을 관대하게 하지 않기 위해 AABB를 렌더 rect가 아니라
   §4.5의 충돌 rect(수축된 rect)로 사용한다.
3. 모든 충돌 판정은 시뮬레이션 정수 좌표(§2.1 매핑 후)에서 수행한다.
   코어의 `hitTest/hitTestBounds` op(포인터용)는 게임플레이 판정에 사용하지 않는다.
   (코어 hitTest는 페인트 순서·스타일 변형에 의존하므로 결정적 게임 판정과 분리한다.)

### 5.9 `Key` 입력 매핑(잠정 — M0 키 인벤토리 확정 전까지 최종이 아님)

BTN 비트 값은 `contracts/spec/spec.ts`에서 확인된 고정값이며,
SF2000 물리 매핑은 `hosts/sf2000/src/lib.rs`에서 확인된다:
libretro X→`TRIANGLE`, A→`CIRCLE`, B→`CROSS`, Y→`SQUARE`,
D-pad→`UP/RIGHT/DOWN/LEFT`, L/R→`LTRIGGER/RTRIGGER`, START/SELECT 그대로.

| BTN (값 확인됨) | 잠정 용도 | 비고 |
|---|---|---|
| `LEFT 0x0080/RIGHT 0x0020/UP 0x0010/DOWN 0x0040` | 이동·가드·점프 | 방향키는 원본 `Key.LEFT/RIGHT/UP/DOWN` 대응으로 추정, 인벤토리에서 확정 |
| `CROSS 0x4000` (물리 B) | 약공격(콤보 1타) | 잠정. 원본 키 상수 추출 전이므로 변경 가능 |
| `CIRCLE 0x2000` (물리 A) | 강공격(킥) | 잠정 |
| `SQUARE 0x8000` (물리 Y) | 헤비 | 잠정 |
| `TRIANGLE 0x1000` (물리 X) | 필살기 | 잠정 |
| `START 0x0008` | 타이틀→전투, 재시작 | 잠정 |
| `SELECT 0x0001` | 일시정지·부정(데모 패턴) | 잠정 |
| `LTRIGGER 0x0100/RTRIGGER 0x0200` | 보조 입력(대시 등) | 원본에 대응 키가 있을 때만. 없으면 미배정 |

1. M0에서 `Key.isDown` 인자와 키코드 상수(예: 방향키·Space·Enter로 추정되는 값)의
   전수 인벤토리를 먼저 확정한다. 위 표의 Z/X/C/V·Space·Enter·Shift 대응은
   실제 AVM1 상수 추출 전의 잠정치이며, 인벤토리와 다르면 인벤토리가 이긴다.
2. `Key.isDown(code)` → 인벤토리 확정 후 고정된 코드→BTN 변환표를 거쳐
   `swfConsume()`의 `held`로 구현한다. 변환표에 없는 코드는 no-op+카운터.
   게임 내 키 엣지(눌림 순간)는 전진 스텝 맨 처음의 단일 스냅샷(`swfConsume()` 1회)의
   `pressed`로만 검출한다. 스텝 끝부분 소비·원시 입력 직접 사용·스텝당 2회 소비는 금지다.
   `onButtonPress` 콜백에서 게임 상태를 직접 바꾸지 않는다(§6.3 배선 규칙).
3. 동시입력 우선순위(잠정, M3에서 확정): `LEFT+RIGHT` 동시 = 정지,
   `UP` 점프는 지상에서만, 공격 중 이동 입력은 버퍼(최대 6 SWF프레임) 후 콤보로 승격.
4. 아날로그(`ANALOG_CENTER`)·터치·커서는 사용하지 않는다. SF2000 미지원이므로 참조도 금지.

### 5.10 사운드 트리거·난수·시간·미지원

| SWF | TS | 규칙 |
|---|---|---|
| `DefineSound s<id>` (36개 내장) | 도달 가능한 것만 `audio:wav.s<id>` (11025Hz mono s16, §9.3) | 36개 전량을 변환하지 않는다. M0 도달 가능성·사용 인벤토리를 먼저 확정하고 범위 내 것만 로컬에서 변환한다. M1까지는 매니페스트만, 재생은 M5 |
| `startSound/stopSound` | `SoundBank.fire(id, policy)` 수집 → `pump()` 1회(§9.2) | 무음 마일스톤에서는 수집만 하고 버린다(시각 동등 보장) |
| `random(n)` | `irandom(n)` (§3.5) | `Math.random` 금지 |
| `getTimer()` | `swfGetTimerMs()` (§3.5) | wall-clock 금지 |
| `Math.atan2/sqrt` | 조준·거리용, 정수 양자화 후 사용(§3.5) | 누적 상태에 소수 침투 금지 |
| `loadMovie/loadVariables/XML/SharedObject/fscommand/print` | 미지원 U-1 | M0에서 사용 인벤토리를 먼저 확정한다(§10 M0). 인벤토리에 있으면 범위·대체 여부를 별도 결정하고, 없으면 미사용으로 기록한다. 무단 대체 구현 금지 |
| `_droptarget/Select/Call` 드래그 | 미지원 U-2 | 컴파일 에러 |
| 임의 색행렬·`createEmptyMovieClip`(빈 캔버스 그리기)·`drawing API(lineTo/curveTo)` | 미지원 U-3 | 틴트 변형 대체(§5.7) 또는 쿡타임 래스터로 해소. 런타임 벡터 그리기 금지 |
| `eval/Function.apply/arguments.callee/prototype` 체인 | 미지원 U-4 | 평탄한 함수·테이블로 재작성. `any`·동적 디스패치 금지 |
| `try/catch` 제어흐름 | 미지원 U-5 | 정상 분기로 재작성. 예외를 게임 로직에 사용 금지 |

미지원 집계(필수 계측):
```ts
// apps/ranger/sim/unsupported.ts (신규)
export const unsupportedCounters: Record<string, number> = {};
export function markUnsupported(code: "U-1"|"U-2"|"U-3"|"U-4"|"U-5"|"colorMatrix"|"unresolvedPath"|"unknownLinkage"|"unknownLabel", detail = ""): void {
  const k = detail ? `${code}:${detail}` : code;
  unsupportedCounters[k] = (unsupportedCounters[k] ?? 0) + 1;
}
```
`sim` 테스트 종료 시 `unsupportedCounters`가 비어 있지 않으면 실패가 아니라
리포트로 출력하되, `U-1/U-2/U-4`는 0이어야 통과다(게임플레이 경로에 잔존 금지).

---

## 6. 타입 런타임 인터페이스·데이터 스키마(짧은 TS 예제, PocketJS 접지)

### 6.1 고정소수·좌표 기본형

```ts
// checked mirror of tests/ranger-doc-examples.test.ts §fixed — keep in sync.
// 1px = 16 subpx. 모든 게임 좌표·속도는 i32 subpx 정수다.
export const SUB = 16;
export type Subpx = number; // i32 invariant (정수만 대입)
export const toSub = (px: number): Subpx => Math.floor(px) * SUB;
export const toPx = (s: Subpx): number => Math.floor(s / SUB);
export const GX = (x: number): number => Math.floor((x * 8) / 15); // §2.1
export const GY = (y: number): number => 32 + Math.floor((y * 8) / 15);
```

### 6.2 게임 상태·루트 API

```ts
// checked mirror of tests/ranger-doc-examples.test.ts §state — keep in sync.
// 값 import는 실제 공개 export 키(`@pocketjs/framework/*`, package.json `exports`)만 사용한다.
import type { Subpx } from "./fixed.ts";
export type Phase = "title" | "fight" | "clear" | "over";
export interface FighterState {
  x: Subpx; y: Subpx; vx: Subpx; vy: Subpx;
  facing: 1 | -1; hp: number; maxHp: number;
  pose: number; // 1-based 부모 프레임 (§5.1 POSE)
  state: "idle"|"walk"|"jump"|"guard"|"hurt"|"attack"|"dead";
  stateT: number; // SWF 프레임 단위 경과
  atkId: number; hitDone: boolean; atkCd: number;
}
export interface GameState {
  phase: Phase; score: number; combo: number; comboT: number;
  hitstop: number; swfFrame: number;
  player: FighterState; enemies: FighterState[];
}
// _root 접근은 이 인터페이스로만:
export interface RootApi {
  gotoAndPlay(label: string): void;
  gotoAndStop(frame: number): void;
  addScore(n: number): void;
}
```

### 6.3 클립·스케줄러·RNG·입력·사운드 인터페이스

```ts
// checked mirror of tests/ranger-doc-examples.test.ts §clip — keep in sync.
// NodeMirror는 실제 공개 API다: framework/src/renderer-solid.ts에서
// `export { … type NodeMirror }`로 재export되며, 기존 apps/ranger/battle.tsx도
// `@pocketjs/framework/renderer`에서 import한다. 아래 예제는 그 경로를 그대로 쓴다.
import type { NodeMirror } from "@pocketjs/framework/renderer";
export interface ClipInstance {
  slotPath: string; variant: string; node: NodeMirror;
  frameIdx: number; playing: boolean;
  vars: Record<string, number | string | boolean>;
  scriptRunMark: number;
}
export function gotoAndStop(c: ClipInstance, frame1Based: number): void {
  c.frameIdx = frame1Based - 1; c.playing = false;
}
```

```ts
// checked mirror of tests/ranger-doc-examples.test.ts §rng — keep in sync.
// §3.5 xorshift32 고정
export interface Rng { next(n: number): number; reset(seed: number): void; }
export function createRng(seed = 0xc0ffee): Rng {
  let s = seed >>> 0 || 1;
  return {
    next(n: number): number {
      s ^= (s << 13) >>> 0; s >>>= 0;
      s ^= s >>> 17; s ^= (s << 5) >>> 0; s >>>= 0;
      return (s % n + n) % n;
    },
    reset(seed2: number): void { s = seed2 >>> 0 || 1; },
  };
}
```

```ts
// sketch (excluded from typecheck) — 배선 모양만 보인다.
// 완전한 컴파일 가능 본은 tests/ranger-doc-examples.test.ts에 둔다(§6.6).
import { onFrame } from "@pocketjs/framework/lifecycle";
import { hostPoll } from "./input.ts";
onFrame((buttons: number) => hostPoll(buttons));
// 게임 조작(START 포함)은 전진 스텝 맨 처음의 단일 `swfConsume()` 스냅샷에서만 처리한다.
// onFrame 콜백이나 onButtonPress 콜백에서 게임 상태를 직접 바꾸지 않는다.
// onButtonPress는 24Hz 에뮬레이션 바깥의 호스트·시스템 관심사에만 사용할 수 있고,
// 그 경우에도 에뮬레이션 상태를 읽거나 쓰지 않는다.
```

```ts
// sketch (excluded from typecheck) — 배선 모양만 보인다.
// 완전한 컴파일 가능 본은 tests/ranger-doc-examples.test.ts에 둔다(§6.6).
// 사운드: silent-first 수집기 (§9.2)
import { createWavPlayer } from "@pocketjs/framework/audio";
const bgm = createWavPlayer(); // globalThis.audio 부재 시 no-op
// onFrame 말미에 1회: bgm.pump();
```

### 6.4 데이터 스키마 예제(생성물 형태 고정)

```jsonc
// apps/ranger/anim.json (생성물 — 손으로 고치지 않는다)
{
  "variants": {
    "v328_idle": { "ax": 12, "ay": 28, "frames": [
      { "sheet": "v328p0.png", "cell": 0, "ox": 4, "oy": 2, "w": 24, "h": 30 }
    ] },
    "hitbox": {}
  },
  "sheets": {
    "v328p0.png": { "cellW": 32, "cellH": 32, "cols": 8, "rows": 8, "frames": 4 }
  },
  "fighters": {
    "player1": { "labels": [[1, "idle"], [6, "walk"], [36, "atk1"]], "frames": [] }
  }
}
```

### 6.5 렌더 바인딩 예제(실 API만 사용)

```tsx
// sketch (excluded from typecheck) — JSX 호스트 변환과 생략된 앱 상태가 있어
// 그대로 복사해 컴파일할 수 없다. 배선 모양만 보인다.
// apps/ranger/battle.tsx 흐름 (신규 코드는 이 모양을 따른다)
import { Image, Text, View } from "@pocketjs/framework/solid/components";
import { prop as hotProp } from "@pocketjs/framework/hot";
import { after } from "@pocketjs/framework/clock";
// 코어 자동 순환이 가능한 루프 이펙트:
<Image src="v1153p0.png" style={{ width: 24, height: 30 }} />
// 위치 갱신은 setPropBatch에 상당하는 경로(hot 경유 또는 renderer mirror),
 // 텍스트는 setText:
<Text>Score {score()}</Text>
```

### 6.6 예제 타입검사 방법

1. 마크다운 펜스 자체는 `tsc`로 검사되지 않는다. 타입검사의 대상은
   M1에서 만드는 `tests/ranger-doc-examples.test.ts`다. 이 파일은
   전용의 완전한 컴파일 가능 예제(정확한 import·정의 포함)를 담으며,
   `tsconfig.json`의 `include`가 `tests/`를 포함하므로 저장소 타입검사에 포함된다.
2. 검증 명령(읽기 전용, 이 체크아웃에서 동작 확인됨):
   `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`.
   이 명령은 예제 파일 추가 전 기준선에서 exit 0임을 확인했다.
   이 환경에는 `bun`이 없으므로 `bunx` 표기를 사용하지 않는다.
3. `// checked mirror … keep in sync` 표시 펜스(§6.1·§6.2·clip·rng)는
   테스트 파일 대응 절과 바이트 동일을 유지해야 하며, 다르면 테스트가 이긴다.
   미러가 허용하는 import 표면은 `tsconfig.json` `paths`에 실재하는 키
   (`@pocketjs/framework/input|lifecycle|renderer` 등)와
   `.ts` 확장자 상대 import뿐이다(`allowImportingTsExtensions`).
   그 밖의 키(`clock|audio|hot` 등)는 `tsconfig paths`에 없어 미검증이므로
   미러에 사용하지 않는다.
4. `// sketch (excluded from typecheck)` 표시 펜스(§3.4·§6.3 배선·사운드·§6.5)는
   그대로 복사해 컴파일할 수 없으며, 타입검사 대상이 아니다.
   스케치를 미러로 승격하려면 먼저 테스트 파일에 완전 본을 넣고
   제2항 명령으로 통과시킨 뒤 표시를 바꾼다.

---

## 7. 생성 데이터 vs 손작성 게임플레이 분리

1. 생성물(쿡 출력, 편집 금지, 헤더 필수):
   `anim.json/images.json/sprites.json/sheets.ts`.
   파생 PNG·WAV는 기본적으로 로컬·생성 경로에 두며, 커밋은 §1.3 제3항 조건 시에만 허용된다.
   각 JSON 선두에 `{ "_generatedBy": "tools/ranger-cook/cook.ts", "_swfRef": "swf:fws6:root19f", "_doNotEdit": true }`를 포함한다.
2. 손작성(사람이 의미를 소유):
   `main.tsx/battle.tsx/sim/*.ts(scheduler/state/clip/rng/input/sound/flow/ai/collide/unsupported)`
   `pak.json`(선언만 손작성, 경로는 생성물만 가리킴).
3. 쿡 스크립트(`tools/ranger-cook/*.ts`)는 손작성이지만 런타임이 import하지 않는다.
   `apps/ranger/**`에서 `tools/`를 import하면 빌드 에러로 만든다
   (`tests/ranger-cook.test.ts`에서 import 그래프 단언).
4. 재생성 검증: 동일 `RANGER_SWF`에서 쿡을 2회 실행하면
   `anim/images/sprites.json+sheets.ts`가 바이트 동일해야 한다.
   PNG는 픽셀 해시(FNV-1a) 동등으로 판정한다(인코더 메타 편차 허용).

---

## 8. SF2000 성능·메모리 잠정 게이트·금지 할당 패턴

이 장의 수치는 공식·실증 예산이 아니다. `package.json` 설명문의 8MB는 제품 태그라인이며
SF2000 실측치가 아니다. 아래 값은 M1 측정으로 비준(ratify)할 때까지의 잠정 프로젝트 게이트다.
M1에서 실측 후 값을 확정하고, 잠정치를 초과하면 에셋 축소·시트 병합으로 해소한다
(로직 복잡도 증가로 해소하지 않는다).

측정 단위를 구분한다(합산 금지):
압축 pak 크기(전송·저장) vs 디코드 상주 텍스처 메모리(픽셀 바이트) vs
JS 힙 측정치 vs 실기·sim 측정 피크. 각 게이트는 해당 단위로만 판정한다.

현행 기준점(2026-09-04 실측, `apps/ranger/`):
디렉터리 합계 약 1.4MB, PNG 합계 약 1.06MB, `anim.json` 47KB,
`sprites.json` 약 10KB, `images.json` 104B, `sheets.ts` 약 1.7KB.
M1은 동일 명령으로 재측정하고 증가분을 기록한다.

### 8.1 잠정 게이트(측정 단위별, M1 비준 전)

1. 압축 pak(배포물): 잠정 상한 `4MB`. 현행 PNG 합계 약 1.06MB 대비 여유이나,
   틴트 변형(§5.7)·신규 시트 추가 시 재측정한다.
2. 디코드 상주 텍스처: 잠정 상한 `3MB`. PSM별 바이트로 계산한다:
   5650=2B/px, 4444=2B/px, 8888=4B/px, T8=약 1B/px+시트당 1KB 팔레트.
   한 변 `≤512`·pow2(`TEX_MAX_DIM`, `contracts/spec/spec.ts` 계약), 총 텍스처 수 잠정 `≤64`.
3. JS 힙: 잠정 상한 `2MB`(sim 측정). 노드 동시 마운트 잠정 `≤160`개,
   깊이 잠정 `≤16`(계약 상한 `MAX_TREE_DEPTH=64`와 별개). 전투 풀은 §5.2의 64슬롯을 초과하지 않는다.
4. 프레임 비용(잠정, sim 측정): 로직+바인딩 호스트틱당 `4ms` 상당,
   SWF프레임당 바인딩 `setProp 계열 48회 + setSprite 8회 + setText 4회` 이내.
   M1 측정에서 초과 시 시트 병합·배치화로 해소한다.

### 8.2 제시율 상호작용(30Hz 제시의 의미)

1. 호스트는 60Hz로 `frame()`을 구동하되 2틱당 1회만 제시한다.
   SWF 24Hz 스케줄러(§3.2)는 제시와 무관하게 호스트틱 기준으로 전진한다.
   제시 스킵틱과 SWF 전진틱이 어긋나는 것은 정상이며 동기화 시도 금지.
2. 정적 화면(DrawList 워드 동일)은 제시가 생략된다.
   타이틀·포즈 화면은 노드를 매 프레임 만지지 않는다(변경 없으면 바인딩 호출 0).
   "깜빡임"을 위해 매 프레임 opacity를 토글하는 패턴 금지 — 필요하면
   `animate()` op 1회로 코어에 위임한다.

### 8.3 soft-float·MIPS 금지 연산

1. 호스트틱당 `Math.atan2/sqrt/sin/cos` 호출 상한: 전진 SWF프레임당 합계 `≤8회`.
   조준각은 256분할 LUT(손작성 상수 배열)로 대체하는 것을 우선한다.
2. 프레임당 정규식·`JSON.parse/stringify`·`decodeWav`·텍스처 업로드 금지(콜드 패스 전용).
3. `measureText`는 장면 진입 시 1회만(콜드). 프레임당 호출 금지.

### 8.4 프레임당 할당 금지(정적·동적 검사)

1. `onFrame` 콜백·SWF 적용 파이프라인(§3.3) 안에서
   객체·배열 리터럴 생성, 클로저 생성, 문자열 연결, `Array.map/filter`,
   박싱(`{...spread}`)을 금지한다. 풀·재사용 버퍼·사전할당 배열만 사용한다.
2. 텍스트 갱신은 값이 바뀔 때만 `setText`한다(매 프레임 동일 문자열 설정 금지).
3. 다수 prop 갱신은 `setPropBatch` 1회로 합친다(예약 형식: Float64 `[nodeId,propId,value]` 반복).
4. 검사: `tests/ranger-perf.test.ts`(M3)가 600호스트틱(10초) 구간에서
   (a) 바인딩 호출 잠정 상한(§8.1-4), (b) 동일 텍스트 중복 설정 0회,
   (c) SWF 미전진 틱의 바인딩 0회를 단언한다. 상한은 M1 비준값으로 교체한다.

---

## 9. 오디오 이관 계획·silent-first 마일스톤

### 9.1 현황(팩트)

SF2000 호스트는 오디오를 구현하지 않는다(`hosts/sf2000/README.md`:
"Audio … not yet implemented", `ffi.rs`에 audio 네임스페이스 없음,
`platforms.ts` sf2000에 `audio.pcm` 없음).
SWF의 36 MP3(11025Hz mono)는 PocketJS 오디오 계약과 레이트가 일치한다
(`AUDIO_RATES`에 11025 포함 — §9.3의 유일한 행운).

### 9.2 silent-first 규칙(M1–M4 강제)

1. `apps/ranger/pocket.json`의 `requires`에 `audio.pcm`을 추가하지 않는다.
   `enhances`에도 적지 않는다(호스트 미지원 상태에서 admission 실패를 방지).
2. 모든 사운드 호출은 `createWavPlayer()`를 경유하며,
   `globalThis.audio` 부재 시 silent no-op가 되어 픽셀 해시가 변하지 않아야 한다
   (`docs/AUDIO.md` golden-safety).
3. 게임 로직은 오디오 이벤트(`credit/underrun/ended`)에 의존하지 않는다.
   트랙 위치·효과음 타이밍은 SWF프레임 카운터에서 도출한다.
   `poll()` 결과를 읽어 게임 상태를 바꾸는 코드 금지.
4. `onFrame` 말미에 `player.pump()`를 최대 1회 호출한다(존재 여부 무관, no-op 안전).

### 9.3 WAV 변환 규칙(범위 내 사운드만, 기본 로컬)

1. 36개 전량을 변환하지 않는다. M0 사용 인벤토리(도달 가능한 장면에서 실제로
   발화되는 사운드)에서 범위 내로 확정된 것만 변환한다. 미사용 사운드는 변환하지 않는다.
2. 변환 형식 고정: `RIFF/WAVE, PCM16, mono, 11025Hz`.
   `decodeWav`가 throw하는 형식을 만들지 않는다(`contracts/spec/audio.ts` 수용 형상).
3. pak 키: `audio:wav.s<soundId>` (+ 용도 별칭은 `anim.json`이 아니라
   손작성 `sim/sound.ts`의 `SOUND_ALIAS` 테이블에 둔다).
4. 길이는 효과음 `≤2초`, BGM 루프 `≤8초`로 편집한다(링 `16384프레임≈1.5초@11025` 대비
   스트리밍 여유. 초과분은 루프 절단, 페이드 50ms).
5. MP3→WAV 변환은 로컬 쿡(`tools/ranger-cook/audio.ts`, `RANGER_SWF` 또는
   인자 경로 입력)에서만 수행하고, 산출 WAV는 기본적으로 로컬에만 둔다.
   커밋·재배포는 §1.3 제3항의 권리 조건을 만족할 때만 허용된다.
   변환기는 외부 바이너리(ffmpeg 등)를 자식으로 호출하는 로컬 스크립트이며
   빌드·런타임 의존성이 아니다(§11).

### 9.4 재생 정책(나중 구현, 미리 고정)

1. 동시 스트림 상한 `4`(`AUDIO_MAX_STREAMS`). 용도 고정:
   `0=BGM, 1=타격, 2=피격/가드, 3=UI/환호`. 채널 스틸링: 새 `fire`가 가득 찬 슬롯을 요구하면
   가장 오래된 비BGM 스트림을 `stop()` 후 재사용한다.
2. `fire(id)`는 SWF프레임 경계에서만 수집하고, `pump()`는 `onFrame`당 1회다.
   1 SWF프레임당 `writePcm`은 스트림당 최대 1회, `WRITE_CHUNK_FRAMES=4096` 상한 준수.
3. BGM 루프는 `ended` 이벤트가 아니라 SWF프레임 카운터로 래핑한다
   (이벤트 의존 금지, §9.2-3).

### 9.5 호스트 오디오 작업(본 이슈 범위 밖 — 분리 명시)

SF2000에 `globalThis.audio`를 마운트하는 작업
(`ffi.rs` 등록 + 링/스레드 + `platforms.ts`에 `audio.pcm` 추가)은
본 리라이트의 선행 조건이 아니다. M5의 게스트 측 준비(매니페스트·펌프·심어)가
완료된 뒤 별도 이슈로 진행한다. 본 계약의 수락 테스트는 모두 무음 상태에서 통과해야 한다.

---

## 10. 마일스톤 순서·수락 테스트·골든/리플레이 전략

### M0 — 범위 확정·스캐폴드(수용: 목록·금지선)

- 산출: 이식 장면 목록(`tests/ranger-scope.test.ts`의 상수
  `IN_SCOPE: string[]/OUT_OF_SCOPE: string[]`),
  `LINKAGE`·`ALLOWED_KEYS` 초안, 무시 경로 확인, 아래 4종 인벤토리:
  (a) ClipActions·이벤트 핸들러 인벤토리
  (PlaceObject2 ClipActions 존재·종류, DoAction 대입 `onEnterFrame/onLoad` 등 전수, §5.6-3),
  (b) 키 인벤토리(`Key.isDown` 인자·키코드 상수 전수, §5.9-1),
  (c) 외부 상호작용 인벤토리
  (`loadMovie/loadVariables/XML/SharedObject/fscommand/getURL` 등 유무, §5.10 U-1),
  (d) 사운드 도달 가능성·사용 인벤토리(36개 중 실제 발화분, §9.3-1).
  4종 인벤토리 없이 M1에 진입하지 않는다.
- 수락: `bun test tests/ranger-scope.test.ts` — 범위 외 `attachMovie` ID 참조 시
  쿡이 실패함을 단언. 작업 트리에 `*.swf`·무시 경로 위반 파일이 없음을
  `git status --porcelain`으로 확인한다.

### M1 — 좌표·스케줄러·RNG·매니페스트 골격(수용: 단위 테스트)

- 산출: `sim/fixed/scheduler/rng/input/ids` + `pak.json` 골격 +
  `tests/ranger-coords.test.ts` + `tests/ranger-doc-examples.test.ts`(§6.6).
- 수락:
  `bun test tests/ranger-coords.test.ts tests/ranger-scheduler.test.ts tests/ranger-input.test.ts`
  (스케줄러 처음 10개 `[0,0,1,0,1,0,0,1,0,1]`, 5틱=2스텝, 120틱=48스텝 정확;
  입력 2회 소비 press-release-press 판별 + `pendingForTest()` 0 단언 +
  동일 스텝 전달·스텝당 단일 소비 단언, §3.2–3.4),
  `tests/ranger-cook.test.ts`(ID 안정·2회 쿡 바이트 동등·`tools/` import 금지),
  `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` 통과(§6.6).

### M2 — 타이틀→전투 진입+정적 골든(수용: 픽셀 해시)

- 산출: 타이틀 장면 + `START` 전이 + 전투 HUD 골격(무음).
- 수락: `hosts/sim/sim.ts runScenario({app:"ranger",hz:60,seconds:3,script:[{at:1.0,press:BTN.START}]})`
  후 `treeHasText(tree,"SCORE ")` true.
  골든: `tests/goldens/ranger-title.hashes.json`에 3프레임 해시 고정,
  `bun tools/tape.ts replay ranger-title tests/tapes/ranger-title.tape.json --assert …` 통과.

### M3 — 전투 슬라이스(이동·콤보·데미지·히트스톱, 무음)

- 산출: `sim/{flow,ai,collide}.ts` + 변형 바인딩 + 풀·배치 바인딩.
- 수락: 기존 `tests/ranger-sim.test.ts` 확장 시나리오(전진·3연타·킥·헤비·후퇴)가
  `score>0`, `GAME OVER` 없음, 재실행 해시 동등.
  `tests/ranger-perf.test.ts`(§8.4) 통과. `U-1/U-2/U-4` 카운터 0.

### M4 — 적 2체·투사체·가드·점프·클리어/오버(무음 완성)

- 산출: 전투 완성. `phase` 전이(title/fight/clear/over) 전부 도달 가능.
- 수락: 4개 시나리오(클리어 루트·오버 루트·가드 루트·점프 회피)의
  테이프+해시 4종 고정. 어느 루트도 `unsupportedCounters`의 U-1/U-2/U-4 없이 종료.

### M5 — 오디오 에셋 준비(여전히 무음 합격)

- 산출: M0 인벤토리에서 범위 내로 확정된 사운드의 WAV(§9.3, 기본 로컬) +
  `pak.json`에 `audio:wav.*` 등록(커밋은 §1.3 제3항 조건 충족 시) +
  `sim/sound.ts`(수집기) + `pump()` 배선.
- 수락: 오디오 마운트 유/무(sim host flag) 두 조건에서 픽셀 해시 바이트 동등
  (`tests/audio-sim` 패턴: `docs/AUDIO.md`의 music 선례를 따른다).
  `decodeWav` 전수 통과. `requires`에 `audio.pcm` 없음 단언.

### M6 — SF2000 실기 패키징(수용: 부트·입력)

- 산출: `dist/ranger.pocket` (`bun tools/pocket.ts build --target sf2000 …`).
- 수락: UniFrog 실기(또는 승인된 실기 동등 harness)에서
  부트→타이틀→`START`→전투→공격 1회까지 D-pad+버튼으로 도달.
  오디오는 요구하지 않는다. 30Hz 제시·정적 스킵과 충돌하는 바인딩이 없음을
  M3 perf 테스트로 사전 보장한다.

### 골든/리플레이 전략(전 마일스톤 공통)

1. 모든 게임플레이 수락은 입력 테이프(`tests/tapes/ranger-*.tape.json`,
   `{at:초,press/hold}` 가상초 단위) + RNG 시드 + `unsupportedCounters` 덤프의 3점 세트로 기록한다.
2. 해시는 `runScenario(...).hashes`의 FNV-1a 프레임버퍼 해시이며,
   `tests/tapes/ranger-*.hashes.json`에 고정한다. 재실행은 바이트 동등이어야 한다.
3. `hz=60`이 정본이다. 저레이트(`hz=30` 등) subsampling 주장은 하지 않는다 —
   SWF 스케줄러(§3.2)가 호스트틱 기준이므로 레이트를 바꾸면 궤적이 달라진다.
   CI는 60으로만 실행한다.
4. 효과음·BGM은 궤적에 포함하지 않는다(§9.2). 오디오 로그는 별도 아티팩트로 분리한다.

---

## 11. 추출·디컴파일 도구는 선택적 로컬 툴링(런타임 의존 금지)

1. 허용(전부 로컬·수동·선택): JPEXS FFDec(벡터/행렬/스크립트 열람),
   swfdump(swftools 태그 덤프), flasm(AVM1 확인용),
   목적 제작 AVM1 태그·액션 덤퍼(DoAction/PlaceObject2/ClipActions 목록화),
   `ffdec.jar` 렌더 익스포트,
   `tools/ranger-cook/*.ts`(안정 ID·래스터·매니페스트 생성),
   ffmpeg(§9.3 MP3→WAV, 로컬 자식 프로세스 호출).
   RABCDAsm은 AVM2/ABC용이므로 AVM1 분석·확인 도구로 사용하지 않는다.
2. 금지: 위 도구를 `package.json dependencies/devDependencies`에 추가,
   빌드(`tools/build.ts`)·런타임(`apps/ranger/**`, `framework/**`)에서 import·spawn,
   CI 필수 경로에 포함. `bun install`만으로 M1–M4 테스트가 통과해야 한다.
3. 쿡 입력 SWF 경로는 `RANGER_SWF` 환경변수 또는 명령행 인자로만 전달한다.
   코드에 절대경로·한글 파일명을 하드코딩하지 않는다.
   이 문서의 파일명 표기는 연산자 측 원본 참조(예시)이며 코드에 복사하지 않는다.

---

## 12. 저장소 점검에서 발견된 미해결 질문

1. `Color.setTransform` 임의 행렬의 실사용 빈도: 100,512개 액션 중 색행렬 사용이
   틴트 2–3종으로 수렴하는지, 아니면 장면마다 다른 행렬인지 M0 스캔에서 확정해야 한다.
   본 계약은 수렴을 가정하고 틴트 변형 대체(§5.7)를 명시했으나, 발산 시 시트 수 상한(§8.1-2)과 충돌한다.
2. 한글 베이크드 폰트: `text.glyphs.baked` 슬롯(`MAX_FONT_SLOTS=24`)에 한글 자모 커버리지가 있는지
   미확인이다. M2 전에 `ui:font.*` 아틀라스의 실제 커버리지를 조사하고,
   미지원이면 영어 UI 문자열로 고정할지(선행 `battle.tsx`는 영어) 한글 아틀라스 추가 이슈를 분리할지 결정해야 한다.
3. `upload_img_entry` vs `upload_texture` 선택: `hosts/sf2000/src/pak.rs`는
   `ui:img.*`에 IMG-entry 경로를 우선한다. 쿡 PNG를 IMG-entry(v2, PSM_T8+RLE+플래그)로
   인코딩할지, 단순한 `upload_texture`용 raw로 둘지 M1에서 측정 후 고정해야 한다.
   본 계약은 PSM 규칙(§4.4)만 고정하고 인코딩 선택은 M1 결정으로 남긴다.
4. `setSprite` 아틀라스 격자 제약: `frames/cols/step` 메타는 확인됐으나
   비균등 셀·행별 프레임 수 상이·1px 개터와의 상호작용이 문서화되어 있지 않다.
   M1에서 코어(`engine/core`) 동작을 실측해 셀 패킹 규칙(§4.4-3)을 확정해야 한다.
5. 30Hz 제시 + DrawList 정적 스킵과 24Hz 스케줄러의 상호작용:
   `retro_run`의 `tick_index & 1` 제시는 게임 로직과 독립이나,
   히트스톱·깜빡임이 제시 경계와 겹치면 체감 12Hz로 떨어질 수 있다.
   M3에서 SWF 전진 패턴 `[0,0,1,0,1]`(5호스트틱당 2프레임, §3.2)과
   제시 2틱 주기의 겹침을 실측해야 한다.
6. `__simHz=60` 고정 vs `normalizeHz` 약수 정책:
   `framework/src/clock.ts`의 `VALID_HZ`는 60의 약수만 허용하므로 24는 허용되지 않는다.
   본 계약은 이를 회피하기 위해 SWF 시간을 앱 내부 카운터로 분리(§3.1)했으나,
   `after()` 기반 UI 타이머와 SWF 카운터의 장시간 위상 어긋남(반올림 오차)을
   M4 장기(60초) 리플레이에서 검증해야 한다.
7. 루트 19프레임 중 실제 도달 가능 프레임: 정적 분석상 19프레임이나
   플레이 도달 분기는 M0에서 확정해야 한다. 본 계약의 M2–M4 범위는
   타이틀·전투·클리어·오버 4위상만을 가정한다.
8. 무손실 비트맵 3종의 용도·해상도: 배경 여부·알파 유무·재사용 위치가 미확인이다.
   M1 쿡 스캔에서 `b<id>` 3종의 크기·PSM을 확정해야 한다.

---

## Definition of Done(체크리스트)

- [ ] 이 규칙 작성 작업에서는 이 문서 한 파일만 생성/수정한다.
      그 외 파일의 신규·수정·삭제·포맷 변경이 없으며, 아무것도 커밋하지 않는다.
- [ ] §2.1의 `GX/GY/GW/GH/OX/OY/S=8/15`가 상수·테스트로 고정되고 근사 스케일이 없다.
- [ ] §3.2의 정수 스케줄러(처음 10개 `[0,0,1,0,1,0,0,1,0,1]`, 5틱=2스텝,
      120틱=48스텝)가 단위 테스트로 고정되고 부동소수 누적이 없다.
- [ ] §3.4의 호스트-레이트 엣지 누산이 있고, 2회 소비 press-release-press 판별 테스트와
      소비 후 `pendingForTest() === 0` 단언이 있으며, 단순 OR 래치가 남아 있지 않다.
      전진 스텝 맨 처음에 `swfConsume()` 1회로 만든 불변 스냅샷이 같은 스텝의 모든 소비자에
      전달되고(동일 값 수신 단언), 스텝당 2회 소비·스텝 끝부분 소비·원시 입력 직접 사용이 없다.
      게임 조작은 스냅샷에서만 처리되고 `onButtonPress` 게임 액션이 없다.
- [ ] §3.5의 `Math.random/Date.now/setTimeout` 금지가 코드·테스트로 강제된다.
- [ ] §4.2의 안정 ID(`v<id>/v<id>p<i>/b<id>/s<id>`)·§4.6의 pak 키 접두가 고정되고,
      원본 SWF가 저장소 밖에 있으며, 파생 PNG·WAV는 §1.3 제3항 조건 없이
      커밋·재배포되지 않고, 전역 `*.mp3` 무시가 없다.
- [ ] §5의 전 매핑표가 `sim/*.ts` 인터페이스로 해소되고,
      타임라인·이벤트 실행 순서는 M0 인벤토리 뒤에 확정되며 편차가 명시되고,
      onEnterFrame 부재 주장이 없으며, U-1/U-2/U-4 카운터가 게임플레이 경로에서 0이다.
- [ ] §5.9의 키 매핑이 잠정치로 표시되고 M0 키 인벤토리가 선행 조건이며,
      BTN 값·SF2000 물리 매핑이 실측과 일치한다.
- [ ] §6의 `checked mirror` 펜스가 테스트 파일 대응 절과 바이트 동일하고,
      `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json`이 통과하며,
      스케치 펜스는 전부 검사 제외 표시다. 마크다운 자체가 `tsc` 검사 대상이라는 주장이 없다.
- [ ] §7의 생성물/손작성 분리가 import 그래프 테스트로 강제된다.
- [ ] §8의 잠정 게이트가 잠정치로 표시되고 단위가 구분되며
      현행 `apps/ranger` 실측치가 기준점으로 기록되고,
      프레임당 할당 금지가 `ranger-perf` 테스트로 강제된다.
- [ ] §9의 silent-first(`requires`에 `audio.pcm` 없음, 마운트 유/무 픽셀 동등)가 테스트로 강제되고,
      WAV 변환은 범위 내 사운드에만 로컬로 수행된다.
- [ ] §10의 M0 4종 인벤토리가 M1 진입 조건이며, M0–M6 순서대로 테이프+해시+시드가 고정되고,
      정본 `hz=60` 리플레이가 바이트 동등이다.
- [ ] §11의 도구 분리(AVM1용 도구만, RABCDAsm 없음, `dependencies` 미추가·런타임 미참조·
      `RANGER_SWF`/인자 경로)가 지켜진다.
- [ ] §12의 8개 질문이 M0–M4 각 마일스톤에 배정되고 미해결 채로 M6을 통과하지 않는다.
