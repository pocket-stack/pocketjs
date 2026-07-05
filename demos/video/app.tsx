// Minimal end-to-end demo of the native <Video> component: a 480×272 H.264
// stream decoded on the PSP Media Engine (scePsmfPlayer), streamed from the dev
// host over PSPLink as host0:/clip.pmf, composited as a NON-fullscreen flex
// child while the rest of the UI redraws at 60 fps.
//
// Build + run: see DESIGN.md "Video" (encode clip.pmf, start usbhostfs_pc,
//   bun scripts/psp.ts video, load the EBOOT over PSPLink).

import { Text, View, Video } from "@pocketjs/framework/components";

export default function VideoDemo() {
  return (
    <View class="w-full h-full flex-col items-center justify-center gap-3 bg-slate-950">
      <Text class="text-base text-slate-100 font-bold tracking-wide">
        PocketJS · Native Video
      </Text>

      <View class="rounded-xl overflow-hidden shadow-md border-slate-800">
        {/* 384×218 keeps the 480×272 (≈16:9) aspect; the Media Engine decodes
            full-res and the GE scales it into this laid-out rect. */}
        <Video src="host0:/clip.pmf" loop autoplay style={{ width: 384, height: 218 }} />
      </View>

      <Text class="text-xs text-slate-500 tracking-wide">
        480×272 H.264 · Media Engine · host0:/clip.pmf
      </Text>
    </View>
  );
}
