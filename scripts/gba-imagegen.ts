#!/usr/bin/env bun

import { $ } from "bun";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type AssetKind = "sprite-sheet" | "tileset" | "character" | "items";

type ParsedArgs = {
  cwd: string;
  out: string;
  kind: AssetKind;
  theme: string;
  extraPrompt: string[];
  port?: number;
  timeoutMs: number;
  dryRun: boolean;
  json: boolean;
};

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type CapturedImage = {
  result?: string;
  savedPath?: string;
  revisedPrompt?: string | null;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_THEME = "original top-down handheld adventure RPG";
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000;

function usageText(): string {
  return [
    "usage:",
    "  bun imagegen --out <path.png> [options]",
    "",
    "options:",
    "  --kind <sprite-sheet|tileset|character|items>  Asset prompt profile (default: sprite-sheet)",
    "  --theme <text>                                Art direction seed (default: original top-down handheld adventure RPG)",
    "  --extra <text>                                Additional prompt detail; repeatable",
    "  --cwd <dir>                                   Workspace for the Codex app-server turn (default: repo root)",
    "  --port <port>                                 Local app-server port (default: free port)",
    "  --timeout-ms <ms>                             Turn timeout (default: 360000)",
    "  --dry-run                                     Print the generated prompt without starting app-server",
    "  --json                                        Emit machine-readable JSON on stdout",
    "",
    "examples:",
    "  bun imagegen --out static/games/boardroom/imagegen/source.png",
    "  bun imagegen --out /tmp/gba-sheet.png --theme \"rainy port town\" --json",
  ].join("\n");
}

function usage(): never {
  throw new Error(usageText());
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usageText());
    process.exit(0);
  }

  let cwd = REPO_ROOT;
  let out: string | undefined;
  let kind: AssetKind = "sprite-sheet";
  let theme = DEFAULT_THEME;
  const extraPrompt: string[] = [];
  let port: number | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let dryRun = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) usage();

    if (arg === "--cwd") {
      cwd = parseValue(args[++index], arg);
    } else if (arg === "--out") {
      out = parseValue(args[++index], arg);
    } else if (arg === "--kind") {
      kind = parseKind(parseValue(args[++index], arg));
    } else if (arg === "--theme") {
      theme = parseValue(args[++index], arg);
    } else if (arg === "--extra") {
      extraPrompt.push(parseValue(args[++index], arg));
    } else if (arg === "--port") {
      port = parsePort(parseValue(args[++index], arg), arg);
    } else if (arg === "--timeout-ms") {
      timeoutMs = parsePositiveInt(parseValue(args[++index], arg), arg);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--json") {
      json = true;
    } else {
      usage();
    }
  }

  if (!out) usage();
  const resolvedCwd = resolve(cwd);
  return {
    cwd: resolvedCwd,
    out: resolveOutputPath(resolvedCwd, out),
    kind,
    theme,
    extraPrompt,
    port,
    timeoutMs,
    dryRun,
    json,
  };
}

function parseValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseKind(value: string): AssetKind {
  if (value === "sprite-sheet" || value === "tileset" || value === "character" || value === "items") return value;
  throw new Error(`--kind must be sprite-sheet, tileset, character, or items`);
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${flag} must be an integer TCP port between 1024 and 65535`);
  }
  return port;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function resolveOutputPath(cwd: string, out: string): string {
  const resolved = isAbsolute(out) ? out : resolve(cwd, out);
  if (!resolved.toLowerCase().endsWith(".png")) throw new Error("--out must end with .png");
  return resolved;
}

function log(opts: Pick<ParsedArgs, "json">, message: string): void {
  if (!opts.json) console.error(message);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

async function findFreePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok");
    },
  });
  const port = server.port;
  await server.stop();
  if (port === undefined) throw new Error("Bun did not assign a free port");
  return port;
}

async function waitForReadyz(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/readyz`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // keep polling until the app-server is ready or timeout expires
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function codexVersion(): Promise<string> {
  return (await $`codex --version`.quiet().text()).trim();
}

function spawnAppServer(opts: Pick<ParsedArgs, "cwd" | "port">, tokenPath: string): Bun.Subprocess<"ignore", "ignore", "ignore"> {
  const port = opts.port;
  if (port === undefined) throw new Error("spawnAppServer requires a port");
  return Bun.spawn(
    [
      "codex",
      "app-server",
      "--listen",
      `ws://127.0.0.1:${port}`,
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      tokenPath,
    ],
    {
      cwd: opts.cwd,
      stdout: "ignore",
      stderr: "ignore",
    },
  );
}

async function stopProcess(proc: Bun.Subprocess<"ignore", "ignore", "ignore">): Promise<void> {
  proc.kill();
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => true),
    sleep(1500).then(() => false),
  ]);
  if (exited) return;
  proc.kill(9);
  await Promise.race([
    proc.exited.catch(() => undefined),
    sleep(1500),
  ]);
}

class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private completedTurn: unknown;
  private turnWaiters: Array<(value: unknown) => void> = [];
  private agentText = "";
  private commandOutputs: string[] = [];
  private capturedImage: CapturedImage | undefined;

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => this.handleMessage(String(event.data));
  }

  static async connect(port: number, token: string): Promise<RpcClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    } as unknown as string[]);

    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("timed out opening app-server websocket")), 10_000);
      ws.onopen = () => {
        clearTimeout(timeout);
        resolveOpen();
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        rejectOpen(new Error("failed to open app-server websocket"));
      };
    });

    return new RpcClient(ws);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
  }

  initialize(): Promise<unknown> {
    return this.request("initialize", {
      clientInfo: { name: "pocketjs-gba-imagegen", title: "PocketJS GBA ImageGen", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
  }

  waitForTurn(timeoutMs: number): Promise<unknown> {
    if (this.completedTurn) return Promise.resolve(this.completedTurn);
    return new Promise((resolveTurn, rejectTurn) => {
      const timeout = setTimeout(() => rejectTurn(new Error("timed out waiting for turn/completed")), timeoutMs);
      this.turnWaiters.push((value) => {
        clearTimeout(timeout);
        resolveTurn(value);
      });
    });
  }

  summary(): { agentText: string; commandOutputs: string[]; image?: CapturedImage } {
    return {
      agentText: this.agentText.trim(),
      commandOutputs: this.commandOutputs.map((output) => output.trim()).filter(Boolean),
      image: this.capturedImage,
    };
  }

  close(): void {
    this.ws.close();
  }

  private handleMessage(raw: string): void {
    const message = JSON.parse(raw) as JsonRpcMessage;
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined) && !message.method) {
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ""}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.respondToServerRequest(message);
      return;
    }

    if (message.method === "item/agentMessage/delta") {
      const params = message.params as { delta?: string };
      this.agentText += params.delta ?? "";
    } else if (message.method === "item/commandExecution/outputDelta") {
      const params = message.params as { delta?: string };
      if (params.delta) this.commandOutputs.push(params.delta);
    } else if (message.method === "item/completed") {
      const params = message.params as { item?: unknown };
      this.captureThreadItem(params.item);
      const item = params.item as { type?: string; aggregatedOutput?: string | null } | undefined;
      if (item?.type === "commandExecution" && item.aggregatedOutput) this.commandOutputs.push(item.aggregatedOutput);
    } else if (message.method === "rawResponseItem/completed") {
      const params = message.params as { item?: unknown };
      this.captureRawResponseItem(params.item);
    } else if (message.method === "turn/completed") {
      this.completedTurn = message.params;
      const items = (message.params as { turn?: { items?: unknown[] } })?.turn?.items ?? [];
      for (const item of items) this.captureThreadItem(item);
      for (const waiter of this.turnWaiters.splice(0)) waiter(message.params);
    } else if (message.method === "error") {
      const params = message.params as { error?: { message?: string } };
      throw new Error(`app-server error: ${params.error?.message ?? JSON.stringify(message.params)}`);
    }
  }

  private captureThreadItem(item: unknown): void {
    const image = item as { type?: string; result?: string; savedPath?: string; revisedPrompt?: string | null } | undefined;
    if (image?.type !== "imageGeneration") return;
    this.capturedImage = {
      result: image.result ?? this.capturedImage?.result,
      savedPath: image.savedPath ?? this.capturedImage?.savedPath,
      revisedPrompt: image.revisedPrompt ?? this.capturedImage?.revisedPrompt ?? null,
    };
  }

  private captureRawResponseItem(item: unknown): void {
    const image = item as { type?: string; result?: string; savedPath?: string; revised_prompt?: string | null } | undefined;
    if (image?.type !== "image_generation_call") return;
    this.capturedImage = {
      result: image.result ?? this.capturedImage?.result,
      savedPath: image.savedPath ?? this.capturedImage?.savedPath,
      revisedPrompt: image.revised_prompt ?? this.capturedImage?.revisedPrompt ?? null,
    };
  }

  private respondToServerRequest(message: JsonRpcMessage): void {
    const id = message.id;
    if (id === undefined) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result: { decision: "denied" } }));
  }
}

function buildAssetPrompt(opts: Pick<ParsedArgs, "kind" | "theme" | "extraPrompt">): string {
  const profiles: Record<AssetKind, string[]> = {
    "sprite-sheet": [
      "Include a compact source sheet with both reusable terrain tiles and one walking character.",
      "Terrain cells: grass, alternate grass, dirt path, tree or shrub, water, stone wall, roof, door, sign, flower, fence.",
      "Character cells: one generic 16x16 adventurer, down/up/left/right, two walk frames per facing, separated with clear gutters.",
    ],
    tileset: [
      "Include only reusable top-down terrain and prop tiles.",
      "Tile concepts: grass, alternate grass, dirt path, tree or shrub, water, cliff or wall, roof, door, sign, flower, fence, floor.",
      "Each cell should read cleanly when downsampled or cropped into 8x8 GBA background tiles.",
    ],
    character: [
      "Include only one generic walking character sprite sheet.",
      "Show down/up/left/right facings, two walk frames per facing, with identical scale and clean gutters.",
      "The sprite should remain readable as a 16x16 GBA OBJ.",
    ],
    items: [
      "Include only small RPG item and UI-adjacent object icons.",
      "Icon concepts: potion, key, coin, berry, scroll, gem, bag, small tool, map marker, sparkle.",
      "Each icon should remain readable as a 16x16 GBA-style sprite.",
    ],
  };

  return [
    "Create one original raster source image for GBA asset production.",
    `Theme: ${opts.theme}.`,
    "",
    "Asset profile:",
    ...profiles[opts.kind].map((line) => `- ${line}`),
    "",
    "Style constraints:",
    "- Original pixel art; do not imitate any existing game, franchise, character, logo, or trademarked creature.",
    "- GBA-friendly 4bpp look: about 15 visible colors per palette bank, BGR555-friendly flat colors, strong silhouettes.",
    "- Top-down handheld cartridge RPG perspective; orthographic, readable at small sizes.",
    "- Crisp hard-edged pixels with no blur, antialiasing, painterly brushwork, photo texture, lighting bloom, text, watermark, labels, UI, or mockup frame.",
    "- Plain light neutral background and generous gutters so a build script can crop cells deterministically.",
    "- Keep the composition as a source sheet, not a screenshot of gameplay.",
    ...(opts.extraPrompt.length > 0 ? ["", "Additional direction:", ...opts.extraPrompt.map((line) => `- ${line}`)] : []),
  ].join("\n");
}

function buildTurnPrompt(assetPrompt: string): string {
  return [
    "Use the imagegen skill and the built-in image_gen tool for this task.",
    "",
    "Call image_gen exactly once with the prompt below. Do not browse. Do not edit files. Do not run commands unless the tool call fails and you need to inspect the local environment.",
    "The driving CLI will capture the image_generation result from the Codex app-server event stream and write the PNG itself.",
    "",
    "Image prompt:",
    "```",
    assetPrompt,
    "```",
  ].join("\n");
}

function extractThreadId(response: unknown): string {
  const value = response as { thread?: { id?: string }; threadId?: string; id?: string };
  const threadId = value.thread?.id ?? value.threadId ?? value.id;
  if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(response)}`);
  return threadId;
}

function assertTurnCompleted(response: unknown): void {
  const turn = (response as { turn?: { status?: string; error?: { message?: string } | null } }).turn;
  if (turn?.status === "failed") throw new Error(`Codex turn failed: ${turn.error?.message ?? JSON.stringify(turn.error)}`);
  if (turn?.status && turn.status !== "completed") throw new Error(`Codex turn ended with status ${turn.status}`);
}

function decodeImageResult(image: CapturedImage): Buffer {
  if (image.result) {
    const marker = "base64,";
    const base64 = image.result.includes(marker) ? image.result.slice(image.result.indexOf(marker) + marker.length) : image.result;
    const bytes = Buffer.from(base64, "base64");
    if (isPng(bytes)) return bytes;
  }

  if (image.savedPath && existsSync(image.savedPath)) {
    const bytes = readFileSync(image.savedPath);
    if (isPng(bytes)) return bytes;
  }

  throw new Error("imagegen completed, but no PNG result was available in app-server events");
}

function isPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

async function run(opts: ParsedArgs): Promise<{
  out: string;
  bytes: number;
  port?: number;
  codexVersion?: string;
  revisedPrompt?: string | null;
  assetPrompt: string;
  agentText?: string;
}> {
  const assetPrompt = buildAssetPrompt(opts);
  if (opts.dryRun) {
    return { out: opts.out, bytes: 0, assetPrompt };
  }

  const tempDir = mkdtempSync(resolve(tmpdir(), "pocketjs-gba-imagegen-"));
  const token = randomToken();
  const tokenPath = resolve(tempDir, "app-server-token");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);

  const port = opts.port ?? (await findFreePort());
  const appServerOpts = { ...opts, port };
  let appServer: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
  let rpc: RpcClient | undefined;

  try {
    const version = await codexVersion();
    log(opts, `gba-imagegen: starting ${version} app-server on ws://127.0.0.1:${port}`);
    appServer = spawnAppServer(appServerOpts, tokenPath);
    await waitForReadyz(port, 30_000);

    rpc = await RpcClient.connect(port, token);
    await rpc.initialize();

    log(opts, "gba-imagegen: starting imagegen turn");
    const threadResponse = await rpc.request("thread/start", {
      cwd: opts.cwd,
      runtimeWorkspaceRoots: [opts.cwd],
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: true,
      threadSource: "user",
      experimentalRawEvents: true,
    });
    const threadId = extractThreadId(threadResponse);

    await rpc.request("turn/start", {
      threadId,
      cwd: opts.cwd,
      runtimeWorkspaceRoots: [opts.cwd],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      input: [{ type: "text", text: buildTurnPrompt(assetPrompt), text_elements: [] }],
    });

    const completed = await rpc.waitForTurn(opts.timeoutMs);
    assertTurnCompleted(completed);
    const summary = rpc.summary();
    if (!summary.image) {
      const details = [summary.agentText, ...summary.commandOutputs].filter(Boolean).join("\n").trim();
      throw new Error(`Codex turn completed without an image_generation result${details ? `:\n${details}` : ""}`);
    }

    const bytes = decodeImageResult(summary.image);
    mkdirSync(dirname(opts.out), { recursive: true });
    await Bun.write(opts.out, bytes);
    const written = statSync(opts.out).size;
    log(opts, `gba-imagegen: wrote ${opts.out} (${written} bytes)`);

    return {
      out: opts.out,
      bytes: written,
      port,
      codexVersion: version,
      revisedPrompt: summary.image.revisedPrompt ?? null,
      assetPrompt,
      agentText: summary.agentText || undefined,
    };
  } finally {
    rpc?.close();
    if (appServer) await stopProcess(appServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const result = await run(opts);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (opts.dryRun) {
    console.log(result.assetPrompt);
  } else {
    console.log(`generated ${result.out}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
