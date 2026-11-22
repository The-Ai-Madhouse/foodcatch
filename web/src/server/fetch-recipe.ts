import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "@/lib/private-address";

/**
 * Fetches a recipe page the user pasted (docs/ui.md §27), defensively: only http(s) on the
 * standard ports, never an address on this machine or a private network (checked again after
 * every redirect), at most 4 redirects, 10 s and 3 MB, and only HTML. The page is returned as
 * text and only ever parsed, never executed.
 */

export class RecipeFetchError extends Error {
  constructor(
    message: string,
    readonly reason: "url" | "blocked" | "network" | "status" | "type" | "size",
  ) {
    super(message);
  }
}

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

/** The URL if it may be fetched, else an error saying why. */
export async function checkUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RecipeFetchError(
      "Det ligner ikke et link. Kopiér hele adressen fra browseren.",
      "url",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RecipeFetchError("Linket skal starte med https:// eller http://.", "url");
  }
  if (url.username || url.password || (url.port && url.port !== "80" && url.port !== "443")) {
    throw new RecipeFetchError("Det link kan vi ikke åbne.", "blocked");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new RecipeFetchError("Det link kan vi ikke åbne.", "blocked");
  }
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new RecipeFetchError(`Vi kunne ikke finde siden ${host}.`, "network");
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new RecipeFetchError("Det link kan vi ikke åbne.", "blocked");
  }
  return url;
}

/** The page's HTML and its final URL. */
export async function fetchRecipePage(raw: string): Promise<{ html: string; url: URL }> {
  let url = await checkUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          // A browser-like request: many recipe sites answer bots with an empty page.
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "da-DK,da;q=0.9,en;q=0.6",
        },
        cache: "no-store",
      });
    } catch {
      throw new RecipeFetchError("Siden svarede ikke. Prøv igen om lidt.", "network");
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      if (!next) break;
      url = await checkUrl(new URL(next, url).toString());
      continue;
    }
    if (!response.ok) {
      throw new RecipeFetchError(`Siden svarede med fejl ${response.status}.`, "status");
    }
    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw new RecipeFetchError("Linket peger ikke på en webside.", "type");
    }
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_BYTES) throw new RecipeFetchError("Siden er for stor til at læse.", "size");
    const reader = response.body?.getReader();
    if (!reader) return { html: "", url };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new RecipeFetchError("Siden er for stor til at læse.", "size");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    return { html: new TextDecoder("utf-8").decode(bytes), url };
  }
  throw new RecipeFetchError("Siden sendte os videre for mange gange.", "network");
}
