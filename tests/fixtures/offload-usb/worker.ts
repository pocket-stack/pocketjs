import { dispatchOffload } from "../../../tools/offload-provider.ts";
declare const self: {
  onmessage(event: { data: any }): void;
  postMessage(data: unknown): void;
};
self.onmessage = async ({ data }) => {
  if (data.init) return;
  self.postMessage(
    await dispatchOffload(
      {
        "test.delay": async (payload: string) => {
          await Bun.sleep(180);
          return payload;
        },
        "test.echo": (payload: string) => payload,
        "test.image": () => ({
          width: 16,
          height: 16,
          format: "r5g6b5",
          pixels: new Uint8Array(512).fill(42),
        }),
        "test.crash": () => {
          process.exit(1);
        },
      },
      data,
    ),
  );
};
