export type Language = "zh" | "en";
export type Direction = "up" | "down" | "left" | "right";

export interface AppDescriptor {
  id: string;
  zh: string;
  en: string;
  icon: string;
}

export const APP_CATALOG: readonly AppDescriptor[] = [
  { id: "contacts", zh: "名片夹", en: "Contacts", icon: "C" },
  { id: "messages", zh: "信息", en: "Messages", icon: "M" },
  { id: "calendar", zh: "日历", en: "Calendar", icon: "D" },
  { id: "alarms", zh: "闹钟", en: "Alarms", icon: "A" },
  { id: "notes", zh: "记事本", en: "Notes", icon: "N" },
  { id: "calculator", zh: "计算器", en: "Calculator", icon: "=" },
  { id: "files", zh: "文件管理", en: "Files", icon: "F" },
  { id: "gallery", zh: "多媒体", en: "Gallery", icon: "G" },
  { id: "music", zh: "铃声", en: "Tones", icon: "♪" },
  { id: "snake", zh: "贪吃蛇", en: "Snake", icon: "S" },
  { id: "connectivity", zh: "连接管理", en: "Connectivity", icon: "W" },
  { id: "sensors", zh: "传感器", en: "Sensors", icon: "I" },
  { id: "hardware", zh: "硬件中心", en: "Hardware", icon: "H" },
  { id: "settings", zh: "设置", en: "Settings", icon: "⚙" },
] as const;

export const KEYPAD = [
  "1234567890",
  "qwertyuiop",
  "asdfghjkl_",
  "zxcvbnm.-@",
  "!#$%&*+=?^",
] as const;

export function nextLanguage(language: Language): Language {
  return language === "zh" ? "en" : "zh";
}

export function moveGrid(
  index: number,
  direction: Direction,
  itemCount: number,
  columns: number,
): number {
  if (itemCount <= 0 || columns <= 0) return 0;
  index = ((index % itemCount) + itemCount) % itemCount;
  const rowStart = Math.floor(index / columns) * columns;
  const rowLength = Math.min(columns, itemCount - rowStart);
  const column = index - rowStart;

  if (direction === "left") {
    return rowStart + ((column - 1 + rowLength) % rowLength);
  }
  if (direction === "right") {
    return rowStart + ((column + 1) % rowLength);
  }

  const rows = Math.ceil(itemCount / columns);
  const step = direction === "up" ? -1 : 1;
  let row = Math.floor(index / columns);
  for (let attempt = 0; attempt < rows; attempt += 1) {
    row = (row + step + rows) % rows;
    const candidate = row * columns + column;
    if (candidate < itemCount) return candidate;
  }
  return index;
}

export function appendKey(text: string, key: string, limit = 63): string {
  if (!key || text.length >= limit) return text;
  return text + key.slice(0, Math.max(0, limit - text.length));
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "operator"; value: "+" | "-" | "*" | "/" }
  | { kind: "left" }
  | { kind: "right" };

function tokenize(expression: string): Token[] | null {
  if (!/^[\d+\-*/().\s]+$/.test(expression)) return null;
  const result: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (/[\d.]/.test(character)) {
      const match = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
      if (!match) return null;
      const value = Number(match[0]);
      if (!Number.isFinite(value)) return null;
      result.push({ kind: "number", value });
      index += match[0].length;
      continue;
    }
    if (character === "(") result.push({ kind: "left" });
    else if (character === ")") result.push({ kind: "right" });
    else result.push({ kind: "operator", value: character as "+" | "-" | "*" | "/" });
    index += 1;
  }
  return result;
}

export function calculate(expression: string): string {
  const tokens = tokenize(expression);
  if (!tokens?.length) return "ERR";
  const values: number[] = [];
  const operators: Array<"+" | "-" | "*" | "/" | "("> = [];
  const precedence = (operator: string) => (operator === "*" || operator === "/" ? 2 : 1);
  const apply = (): boolean => {
    const operator = operators.pop();
    const right = values.pop();
    const left = values.pop();
    if (!operator || operator === "(" || left === undefined || right === undefined) return false;
    const value =
      operator === "+" ? left + right
        : operator === "-" ? left - right
          : operator === "*" ? left * right
            : right === 0 ? Number.NaN : left / right;
    if (!Number.isFinite(value)) return false;
    values.push(value);
    return true;
  };

  let expectValue = true;
  for (const token of tokens) {
    if (token.kind === "number") {
      if (!expectValue) return "ERR";
      values.push(token.value);
      expectValue = false;
    } else if (token.kind === "left") {
      if (!expectValue) return "ERR";
      operators.push("(");
    } else if (token.kind === "right") {
      if (expectValue) return "ERR";
      while (operators.length && operators[operators.length - 1] !== "(") {
        if (!apply()) return "ERR";
      }
      if (operators.pop() !== "(") return "ERR";
    } else {
      if (expectValue) return "ERR";
      while (
        operators.length
        && operators[operators.length - 1] !== "("
        && precedence(operators[operators.length - 1]) >= precedence(token.value)
      ) {
        if (!apply()) return "ERR";
      }
      operators.push(token.value);
      expectValue = true;
    }
  }
  if (expectValue) return "ERR";
  while (operators.length) {
    if (operators[operators.length - 1] === "(" || !apply()) return "ERR";
  }
  if (values.length !== 1 || !Number.isFinite(values[0])) return "ERR";
  return String(Number(values[0].toFixed(8)));
}

export function shouldPersistWifi(connected: boolean, explicitYes: boolean): boolean {
  return connected && explicitYes;
}

export interface Point {
  x: number;
  y: number;
}

export interface SnakeState {
  body: Point[];
  direction: Direction;
  food: Point;
  score: number;
  alive: boolean;
}

function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

export function moveSnake(state: SnakeState, width: number, height: number): SnakeState {
  if (!state.alive || width <= 1 || height <= 1 || state.body.length === 0) return state;
  const head = state.body[0];
  const delta =
    state.direction === "left" ? { x: -1, y: 0 }
      : state.direction === "right" ? { x: 1, y: 0 }
        : state.direction === "up" ? { x: 0, y: -1 }
          : { x: 0, y: 1 };
  const nextHead = {
    x: (head.x + delta.x + width) % width,
    y: (head.y + delta.y + height) % height,
  };
  const ate = nextHead.x === state.food.x && nextHead.y === state.food.y;
  const collisionBody = ate ? state.body : state.body.slice(0, -1);
  if (collisionBody.some((point) => point.x === nextHead.x && point.y === nextHead.y)) {
    return { ...state, alive: false };
  }
  const body = [nextHead, ...state.body];
  if (!ate) body.pop();
  let food = state.food;
  if (ate) {
    const occupied = new Set(body.map(pointKey));
    const start = (state.score * 17 + 11) % (width * height);
    for (let offset = 0; offset < width * height; offset += 1) {
      const slot = (start + offset) % (width * height);
      const candidate = { x: slot % width, y: Math.floor(slot / width) };
      if (!occupied.has(pointKey(candidate))) {
        food = candidate;
        break;
      }
    }
  }
  return {
    ...state,
    body,
    food,
    score: state.score + (ate ? 1 : 0),
  };
}
