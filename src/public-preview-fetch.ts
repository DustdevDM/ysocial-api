import { Resolver } from "node:dns/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import ipaddr from "ipaddr.js";

const MAX_REDIRECTS = 3;
const TIMEOUT = 6000;
const MAX_OUTBOUND = 12;
const ipv6Global = "2000::";
let active = 0;

export function canPreviewUrl(url: URL) {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    !url.port &&
    url.hostname.includes(".") &&
    !ipaddr.isValid(url.hostname)
  );
}

export function isPublicPreviewAddress(address: string) {
  const ip = ipaddr.parse(address);
  if (ip.range() !== "unicast") return false;
  return (
    ip instanceof ipaddr.IPv4 || ip.match(ipaddr.IPv6.parse(ipv6Global), 3)
  );
}

async function resolvePublicAddress(hostname: string, signal: AbortSignal) {
  const resolver = new Resolver({ timeout: 1500, tries: 1 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const [ipv4, ipv6] = await Promise.all([
      resolver.resolve4(hostname).catch(() => []),
      resolver.resolve6(hostname).catch(() => []),
    ]);
    signal.throwIfAborted();
    const addresses = [...ipv4, ...ipv6];
    if (!addresses.every(isPublicPreviewAddress)) return null;
    const address = addresses[0];
    return address ? { address, family: ipv4.length ? 4 : 6 } : null;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export async function fetchPublicPreview(
  initial: URL,
  {
    accept,
    types,
    byteLimit,
    allowPartial = false,
    sameHost = false,
  }: {
    accept: string;
    types: ReadonlySet<string>;
    byteLimit: number;
    allowPartial?: boolean;
    sameHost?: boolean;
  },
) {
  if (active >= MAX_OUTBOUND) return;
  active++;
  const signal = AbortSignal.timeout(TIMEOUT);
  let url = initial;
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      if (
        !canPreviewUrl(url) ||
        (sameHost && url.hostname !== initial.hostname)
      )
        return;
      const destination = await resolvePublicAddress(url.hostname, signal);
      if (!destination) return;
      const get = url.protocol === "https:" ? httpsGet : httpGet;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        get(
          url,
          {
            agent: false,
            family: destination.family,
            // Keep the original hostname for Host and TLS, and pin the validated IP.
            lookup: (_name, _options, done) =>
              done(null, destination.address, destination.family),
            signal,
            headers: {
              Accept: accept,
              "Accept-Encoding": "identity",
              "User-Agent": "YSocial Link Preview",
            },
          },
          resolve,
        ).once("error", reject);
      });
      try {
        const status = response.statusCode ?? 0;
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          response.headers.location
        ) {
          const next = URL.parse(response.headers.location, url);
          if (!next) return;
          url = next;
          continue;
        }
        const type = response.headers["content-type"]
          ?.split(";")[0]
          .trim()
          .toLowerCase();
        if (
          status !== 200 ||
          !type ||
          !types.has(type) ||
          (response.headers["content-encoding"] &&
            response.headers["content-encoding"] !== "identity")
        )
          return;
        const chunks: Buffer[] = [];
        let remaining = byteLimit;
        for await (const chunk of response) {
          if (!Buffer.isBuffer(chunk)) return;
          if (chunk.length > remaining && !allowPartial) return;
          chunks.push(chunk.subarray(0, remaining));
          remaining -= chunk.length;
          if (allowPartial && remaining <= 0) break;
        }
        return { url, type, body: Buffer.concat(chunks) };
      } finally {
        response.destroy();
      }
    }
  } finally {
    active--;
  }
}
