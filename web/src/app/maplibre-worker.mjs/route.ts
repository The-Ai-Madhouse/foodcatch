import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * MapLibre's web worker, served from our own origin. MapLibre 6 looks for it next to its own
 * module, which does not exist once the module is bundled, so `StoreMap` points `setWorkerUrl`
 * here. Generated once at build time.
 */
export const dynamic = "force-static";

export async function GET(): Promise<Response> {
  const file = path.join(process.cwd(), "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs");
  const body = await readFile(file);
  return new Response(body, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
