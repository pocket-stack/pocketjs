/** @jsxImportSource @pocketjs/aot */
// aot/demo-shendiao/game.tsx — 《神雕旧事》: a fan-made (同人) mini-RPG in
// three segments, authored in the @pocketjs/aot TS DSL and compiled to
// GBA / Game Boy / NES. All dialogue is original text written for this demo
// (plot-inspired; nothing is quoted from the novel). The only quoted couplet
// is 元好问's public-domain 《摸鱼儿·雁丘词》 line.
//
// Title map auto-opens a segment menu (map onEnter); each segment ends by
// warping back to the title. Design doc: scratchpad/shendiao-design.md.
import {
  addVar,
  ascii,
  choose,
  defineGame,
  defineMap,
  giveItem,
  hasFlag,
  lockPlayer,
  releasePlayer,
  say,
  script,
  setFlag,
  setVar,
  tile,
  Trigger,
  varEq,
  varGe,
  varGt,
  varLe,
  varLt,
  wait,
  warpTo,
} from "@pocketjs/aot";
import { condor, guoJing, jinlun, wuxia, xiaoLongNv, yangGuo } from "./assets.ts";

/* eslint-disable @typescript-eslint/no-unused-vars */
void yangGuo; // player = sprite id 0 (declared first in assets.ts)

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------
const TitleMenu = script(function* () {
  yield lockPlayer();
  if (yield hasFlag("s1_done"))
    if (yield hasFlag("s2_done"))
      if (yield hasFlag("s3_done"))
        if (!(yield hasFlag("epilogue"))) {
          yield say("三段旧事，到此为止。");
          yield say("问世间，情是何物？");
          yield say("直教生死相许。");
          yield say("少年，江湖是你的了。");
          yield setFlag("epilogue");
        }
  yield say("神雕旧事，三段可看。");
  const c = yield choose(["剑冢神雕", "断肠之约", "襄阳大战", "问世间情"] as const);
  switch (c) {
    case 0:
      yield warpTo("valley:spawn");
      yield say("断臂之痛，深谷之中。");
      break;
    case 1:
      yield warpTo("cliff:spawn");
      yield say("十六年后，断肠崖前。");
      yield say("杨过：龙儿，我来了。");
      break;
    case 2:
      yield warpTo("xiangyang:spawn");
      yield say("蒙古大军，围困襄阳。");
      yield say("高台烈火，郭襄在上。");
      yield say("杨过：襄儿，我来了！");
      break;
    case 3:
      yield say("问世间，情是何物？");
      yield say("直教生死相许。");
      break;
  }
  yield releasePlayer();
});

const TitleCondor = script(function* () {
  yield say("雕：……！");
});

// ---------------------------------------------------------------------------
// Segment 1 — 剑冢神雕
// ---------------------------------------------------------------------------
const CondorTalk = script(function* () {
  yield lockPlayer();
  if (!(yield hasFlag("s1_gall"))) {
    yield say("雕：……！");
    yield say("神雕飞来，放下蛇胆。");
    yield giveItem("蛇胆");
    yield say("杨过：多谢雕兄！");
    yield say("雕兄看了看石门。");
    yield setFlag("s1_gall");
  } else if (!(yield hasFlag("s1_sword"))) {
    yield say("雕兄看了看石门。");
  } else if (!(yield hasFlag("s1_done"))) {
    yield say("雕：……！");
    yield say("神雕跃入山洪之中。");
    yield say("杨过：要我在洪水中练剑？");
    yield setVar("train", 0);
    while (yield varLt("train", 3)) {
      const c = yield choose(["挥剑", "歇息"] as const);
      switch (c) {
        case 0:
          yield addVar("train", 1);
          if (yield varEq("train", 1)) yield say("水势如山，剑要脱手。");
          if (yield varEq("train", 2)) yield say("双足生根，剑势渐定。");
          if (yield varEq("train", 3)) yield say("一剑挥出，山洪为之分开！");
          break;
        case 1:
          yield say("杨过：歇一歇。");
          yield wait(60);
          break;
      }
    }
    yield say("杨过：剑重如山，心定如铁。");
    yield say("从此江湖，有一神雕侠。");
    yield setFlag("s1_done");
    yield say("剑冢神雕，到此为止。");
    yield warpTo("title:spawn");
  } else {
    yield say("雕：……！");
  }
  yield releasePlayer();
});

const ValleyDoor = script(function* () {
  yield lockPlayer();
  yield say("石门之后，正是剑冢。");
  yield warpTo("tomb:spawn");
  yield releasePlayer();
});

const TombDoor = script(function* () {
  yield lockPlayer();
  yield warpTo("valley:door_front");
  yield releasePlayer();
});

const MoundHeavy = script(function* () {
  yield lockPlayer();
  if (yield hasFlag("s1_sword")) {
    yield say("石刻：重剑。");
  } else {
    yield say("黑铁大剑，重不可当。");
    const c = yield choose(["拔剑", "再看"] as const);
    switch (c) {
      case 0:
        yield say("杨过运力，重剑离石！");
        yield giveItem("玄铁重剑");
        yield say("杨过：好剑，好重的剑！");
        yield setFlag("s1_sword");
        break;
      case 1:
        break;
    }
  }
  yield releasePlayer();
});

// ---------------------------------------------------------------------------
// Segment 2 — 断肠之约
// ---------------------------------------------------------------------------
const CliffEdge = script(function* () {
  yield lockPlayer();
  yield say("崖下深谷，深不见底。");
  yield say("日出日落，无人前来。");
  yield setVar("edge", 0);
  while (yield varEq("edge", 0)) {
    const c = yield choose(["再等", "大喊", "纵身一跃"] as const);
    switch (c) {
      case 0:
        yield say("风过崖前，只有花落。");
        yield wait(90);
        break;
      case 1:
        yield say("杨过：龙儿！龙儿！");
        yield say("空谷回声，声声是空。");
        break;
      case 2:
        yield say("杨过：问世间，情是何物！");
        yield say("龙儿不来，我何必独活！");
        yield say("纵身一跃，直坠深谷。");
        yield warpTo("pool:spawn");
        yield say("谷底寒潭，白花满谷。");
        yield say("潭边有人，一身白衣。");
        yield setVar("edge", 1);
        break;
    }
  }
  yield releasePlayer();
});

const Reunion = script(function* () {
  yield lockPlayer();
  if (yield hasFlag("s2_done")) {
    yield say("小龙女：过儿。");
    yield releasePlayer();
    return;
  }
  yield say("小龙女：过儿。");
  yield say("杨过：龙儿！真的是你！");
  yield say("小龙女：我等了你十六年。");
  yield say("小龙女：寒潭之下，");
  yield say("我用古墓功法活了下来。");
  yield say("杨过：我以为今生，再见不到你。");
  yield say("小龙女：过儿，你可恨我？");
  const c = yield choose(["不恨", "恨过", "只想你"] as const);
  switch (c) {
    case 0:
      yield say("杨过：不恨。你在，就好。");
      break;
    case 1:
      yield say("杨过：恨你独去，恨我独活。");
      yield say("小龙女：过儿，是我不好。");
      break;
    case 2:
      yield say("杨过：十六年，日日想你。");
      break;
  }
  yield say("小龙女：此后生死，再不分离。");
  yield say("杨过：好。回古墓，回家去。");
  yield setFlag("s2_done");
  yield say("断肠之约，到此为止。");
  yield warpTo("title:spawn");
  yield releasePlayer();
});

// ---------------------------------------------------------------------------
// Segment 3 — 襄阳大战
// ---------------------------------------------------------------------------
const GuoJingTalk = script(function* () {
  yield say("郭靖：过儿，你来了！");
  yield say("襄阳生死，在此一战。");
  yield say("杨过：郭伯伯，看我救襄儿。");
});

const XlnWarn = script(function* () {
  yield say("小龙女：小心金轮法王。");
});

// Scripted turn-based boss battle. Balance (design §4.4): 杨过 50 HP vs
// 法王 60 HP; 黯然销魂掌 16 dmg costs 1 气, 玄铁剑法 9 dmg free, 调息 +12 HP
// (cap 50) +1 气; enemy hits 8, every 3rd turn 14. Sword-spam alone loses —
// the 气 economy is the puzzle. Losing soft-resets the segment.
const Battle = script(function* () {
  yield lockPlayer();
  yield say("法王：杨过！十六年不见，");
  yield say("今日再分高下！");
  yield say("杨过：放了襄儿，再分高下！");
  yield say("重掌要气，调息回气。");
  yield setVar("yg_hp", 50);
  yield setVar("fw_hp", 60);
  yield setVar("qi", 1);
  yield setVar("turn", 0);
  yield setVar("low_told", 0);

  while (yield varGt("fw_hp", 0)) {
    const c = yield choose(["黯然销魂掌", "玄铁剑法", "运气调息"] as const);
    switch (c) {
      case 0:
        if (yield varGe("qi", 1)) {
          yield addVar("qi", -1);
          yield addVar("fw_hp", -16);
          yield say("黯然销魂，一掌击出！");
          yield say("法王中掌，连退三步！");
        } else {
          yield say("内力不足！");
        }
        break;
      case 1:
        yield addVar("fw_hp", -9);
        yield say("重剑一挥，势如山洪！");
        break;
      case 2:
        yield addVar("yg_hp", 12);
        if (yield varGt("yg_hp", 50)) yield setVar("yg_hp", 50);
        yield addVar("qi", 1);
        yield say("杨过调息，气力渐回。");
        break;
    }
    if (yield varLe("fw_hp", 0)) break;

    if (yield varLe("fw_hp", 20))
      if (yield varEq("low_told", 0)) {
        yield say("法王气息渐乱！");
        yield setVar("low_told", 1);
      }

    yield addVar("turn", 1);
    if (yield varGe("turn", 3)) {
      yield setVar("turn", 0);
      yield say("法王：龙象神功！");
      yield say("力大如山，杨过连退三步！");
      yield addVar("yg_hp", -14);
    } else {
      yield say("法王：金轮，去！");
      yield say("金轮飞来，火光四起！");
      yield addVar("yg_hp", -8);
    }
    if (yield varLe("yg_hp", 0)) {
      yield say("杨过力尽，眼前一黑…");
      yield say("神雕飞来，救走杨过。");
      yield say("胜败常事，再来一次！");
      yield warpTo("xiangyang:spawn");
      yield releasePlayer();
      return;
    }
  }

  yield say("黯然销魂掌，天下无双！");
  yield say("法王：好掌法……我败了。");
  yield say("法王坠地，高台火起！");
  yield say("杨过飞身上台，救下郭襄。");
  yield say("郭襄：我就知道，大哥哥会来！");
  yield say("军前一人，正是大汗蒙哥。");
  yield say("杨过飞起一石，正中大汗！");
  yield say("大汗坠马，蒙古退兵！");
  yield say("郭靖：为国为民，才是真大侠。");
  yield say("杨过：有郭伯伯在，襄阳不亡。");
  yield setFlag("s3_done");
  yield say("襄阳大战，到此为止。");
  yield warpTo("title:spawn");
  yield releasePlayer();
});

// ---------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------
const LEGEND = {
  ".": tile("grass"),
  ":": tile("path"),
  s: tile("gravel"),
  "*": tile("flower"),
  "=": tile("bridge"),
  "^": tile("stairs"),
  _: tile("cave_floor"),
  P: tile("platform"),
  O: tile("gate"),
  "#": tile("cliff"),
  X: tile("chasm"),
  "~": tile("water"),
  "%": tile("rapids"),
  T: tile("pine"),
  W: tile("tomb_wall"),
  D: tile("stone_door"),
  "!": tile("sword_mound"),
  M: tile("stele"),
  C: tile("city_wall"),
  b: tile("banner_song"),
  m: tile("banner_mongol"),
  t: tile("torch"),
  f: tile("fire"),
  A: tile("tent"),
} as const;

const pick = <K extends keyof typeof LEGEND>(...keys: K[]): Pick<typeof LEGEND, K> => {
  const out = {} as Pick<typeof LEGEND, K>;
  for (const k of keys) out[k] = LEGEND[k];
  return out;
};

export const Title = defineMap("title")
  .tileset(wuxia)
  .layer(
    ascii`
      ################
      #T.T........T.T#
      #..*...M....*..#
      #......:.......#
      #..T...:...T...#
      #......:.....~~#
      #T.....:....~~~#
      #..*...:.....~~#
      #..T...:...T...#
      #......:.......#
      #T.T...:....T.T#
      ################
    `.legend(pick("#", "T", ".", "*", ":", "~", "M")),
  )
  .spawn("spawn").at(7, 10).facing("up")
  .npc("condor").sprite(condor).at(9, 2).facing("down").talk(TitleCondor)
  .entities(<Trigger id="stele" at={[7, 2]} onTalk={TitleMenu} />)
  .onEnter(TitleMenu)
  .done();

export const Valley = defineMap("valley")
  .tileset(wuxia)
  .layer(
    ascii`
      ######%%########D#######
      #....s%%s.......:......#
      #.T..s%%s..T....:..T...#
      #....s%%s.......:......#
      #..T.s%%s....*..:....T.#
      #....s%%s.......:......#
      #.T..s==s....:::::....T#
      #....s%%s....:.........#
      #.T..s%%s..*.:...T.....#
      #....s%%s....:....*....#
      #..T.s%%s....:..T......#
      #....s%%s....:.....T...#
      #.T..s%%s....:.........#
      ########################
    `.legend(pick("#", ".", "s", "%", "=", "D", ":", "T", "*")),
  )
  .spawn("spawn").at(13, 12).facing("up")
  .entrance("door_front").at(16, 1).facing("down")
  .npc("condor").sprite(condor).at(14, 10).facing("left").talk(CondorTalk)
  .sign("山洪之声，水花四起。").at(8, 4)
  .entities(<Trigger id="door" at={[16, 0]} onTalk={ValleyDoor} />)
  .done();

export const Tomb = defineMap("tomb")
  .tileset(wuxia)
  .layer(
    ascii`
      WWWWWWWWWWWWWWWWWWWW
      W__________________W
      W__!___!____!___!__W
      W__________________W
      W__________________W
      W__________________W
      W__________________W
      W__________________W
      W_____M____________W
      WWWWWWWWWDWWWWWWWWWW
    `.legend(pick("W", "_", "!", "M", "D")),
  )
  .spawn("spawn").at(9, 8).facing("up")
  .sign("石刻：利剑。少年以之，败尽强手。").at(3, 2)
  .sign("石刻：软剑。剑不在此，弃之深谷。").at(7, 2)
  .sign("石刻：木剑。大道至此，草木皆剑。").at(16, 2)
  .sign("剑冢。天下之剑，尽在此地。").at(6, 8)
  .entities(
    <>
      <Trigger id="mound_heavy" at={[12, 2]} onTalk={MoundHeavy} />
      <Trigger id="door" at={[9, 9]} onTalk={TombDoor} />
    </>,
  )
  .done();

export const Cliff = defineMap("cliff")
  .tileset(wuxia)
  .layer(
    ascii`
      ####################
      #T.T....:.....*..T.#
      #..*....:..T.......#
      #T......:......*..T#
      #...T...:...T......#
      #*......:.......*..#
      #...*...:....*.....#
      #T......:......T...#
      #....*.M:*.........#
      #..*....:..*....*..#
      #XXXXXXXXXXXXXXXXXX#
      #XXXXXXXXXXXXXXXXXX#
      #XXXXXXXXXXXXXXXXXX#
      ####################
    `.legend(pick("#", "T", ".", "*", ":", "M", "X")),
  )
  .spawn("spawn").at(8, 1).facing("down")
  .sign("石上旧字：「十六年后，在此重逢。」").at(7, 8)
  .sign("崖前白花，开了，落了。").at(13, 6)
  .entities(<Trigger id="edge" at={[8, 10]} onTalk={CliffEdge} />)
  .done();

export const Pool = defineMap("pool")
  .tileset(wuxia)
  .layer(
    ascii`
      ####################
      #..*....*....*...T.#
      #.*......s.....*...#
      #....sss~~sss...*..#
      #..*.s~~~~~~s......#
      #....s~~~~~~s..*...#
      #.*..s~~~~~~s......#
      #....sss~~sss..T...#
      #..*....s.s..*.....#
      #.T...*.....*....*.#
      #........*.......T.#
      ####################
    `.legend(pick("#", ".", "*", "s", "~", "T")),
  )
  .spawn("spawn").at(9, 2).facing("down")
  .npc("xiao_long_nv").sprite(xiaoLongNv).at(13, 5).facing("left").talk(Reunion)
  .done();

export const Xiangyang = defineMap("xiangyang")
  .tileset(wuxia)
  .layer(
    ascii`
      CCCCCCCCCCCbOObCCCCCCCCCCC
      CCCCCCCCCCCtOOtCCCCCCCCCCC
      #...........::...........#
      #...........::...........#
      #...........::...........#
      #...........::...t....t..#
      #...........::....PPPP...#
      #...........::...^PPPP...#
      #...........::....PPPP...#
      #...........::...ffffff..#
      #...........::...........#
      #...........::...........#
      #..m........::......m....#
      #.AAA.......::....AAA....#
      #.AAA...m...::....AAA..m.#
      #.AAA.......::....AAA....#
      #...........::...........#
      ##########################
    `.legend(pick("C", "b", "O", "t", "#", ".", ":", "m", "A", "P", "^", "f")),
  )
  .spawn("spawn").at(12, 3).facing("down")
  .npc("guo_jing").sprite(guoJing).at(11, 3).facing("right").talk(GuoJingTalk)
  .npc("xiao_long_nv").sprite(xiaoLongNv).at(14, 3).facing("left").talk(XlnWarn)
  .npc("jinlun").sprite(jinlun).at(15, 7).facing("left").talk(Battle)
  .sign("郭襄：大哥哥，不要救我！先破蒙古大军！小心法王！").at(18, 7)
  .done();

export default defineGame({
  title: "SHENDIAO JIUSHI",
  start: "title:spawn",
  textMode: "cjk16",
  maps: [Title, Valley, Tomb, Cliff, Pool, Xiangyang],
  sprites: ["yang_guo", "xiao_long_nv", "condor", "guo_jing", "jinlun"],
  items: ["蛇胆", "玄铁重剑"],
  flags: ["s1_gall", "s1_sword", "s1_done", "s2_done", "s3_done", "epilogue"],
  vars: ["train", "edge", "yg_hp", "fw_hp", "qi", "turn", "low_told"],
});
