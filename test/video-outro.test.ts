import { describe, expect, test } from "bun:test";
import { parseProbeOutput } from "../skills/pocketjs-video-outro/scripts/make-outro.ts";

describe("parseProbeOutput", () => {
  test("reads an iPhone HDR MOV with audio and data streams", () => {
    const result = parseProbeOutput(JSON.stringify({
      streams: [
        {
          codec_type: "video",
          width: 1920,
          height: 1080,
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          color_space: "bt2020nc",
          color_transfer: "arib-std-b67",
          color_primaries: "bt2020",
          color_range: "tv",
          side_data_list: [
            { side_data_type: "DOVI configuration record" },
            { side_data_type: "Ambient viewing environment" },
          ],
        },
        { codec_type: "audio" },
        { codec_type: "audio" },
        { codec_type: "data" },
      ],
      format: { duration: "77.200000" },
    }));

    expect(result).toEqual({
      w: 1920,
      h: 1080,
      fps: 30,
      dur: 77.2,
      audioStreams: 2,
      colorSpace: "bt2020nc",
      colorTransfer: "arib-std-b67",
      colorPrimaries: "bt2020",
      colorRange: "tv",
    });
  });

  test("falls back to the average frame rate", () => {
    const result = parseProbeOutput(JSON.stringify({
      streams: [
        { codec_type: "video", width: "1080", height: "1920", r_frame_rate: "0/0", avg_frame_rate: "30000/1001" },
      ],
      format: { duration: 12.5 },
    }));

    expect(result.fps).toBeCloseTo(29.97, 2);
  });

  test("rejects incomplete metadata", () => {
    expect(() => parseProbeOutput('{"streams":[],"format":{}}')).toThrow(
      "could not probe input width/height/fps/duration",
    );
  });
});
