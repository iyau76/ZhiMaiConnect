import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  API_LIMITS,
  SafeApiError,
  apiErrorResponse,
  apiJson,
  enforceRateLimit,
  parseJsonRequest,
  readResponseTextLimited,
  requireApiSession,
  startUpstreamRequest,
  type UpstreamRequest,
} from "../../lib/api-security.server";

const webToolBodySchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("weather"), location: z.string().trim().min(1).max(100) }).strict(),
  z.object({ tool: z.literal("news"), query: z.string().trim().min(2).max(120) }).strict(),
  z.object({ tool: z.literal("search"), query: z.string().trim().min(2).max(120) }).strict(),
]);

const WEATHER_CODES: Record<number, string> = {
  0: "晴",
  1: "大致晴朗",
  2: "局部多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "较强毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴强冰雹",
};

async function readFixedUpstream(url: string, request: Request, service: string, maxBytes: number) {
  let upstream: UpstreamRequest | undefined;
  try {
    upstream = await startUpstreamRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json, application/rss+xml, text/xml",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
        },
      },
      {
        timeoutMs: 12_000,
        timeoutMessage: `${service}响应超时`,
        unavailableMessage: `无法连接${service}`,
        requestSignal: request.signal,
      },
    );
    if (!upstream.response.ok) {
      console.warn(`[web-tools:${service}] upstream status=${upstream.response.status}`);
      throw new SafeApiError(502, "UPSTREAM_REJECTED", `${service}暂时不可用`);
    }
    return await readResponseTextLimited(upstream.response, maxBytes);
  } finally {
    upstream?.dispose();
  }
}

function parseJson<T>(raw: string, service: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", `${service}返回了无效数据`);
  }
}

async function weather(location: string, request: Request) {
  const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geocodeUrl.searchParams.set("name", location);
  geocodeUrl.searchParams.set("count", "1");
  geocodeUrl.searchParams.set("language", "zh");
  geocodeUrl.searchParams.set("format", "json");
  const geocode = parseJson<{
    results?: Array<{
      name?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      timezone?: unknown;
      admin1?: unknown;
      country?: unknown;
    }>;
  }>(
    await readFixedUpstream(geocodeUrl.toString(), request, "地点检索服务", 128 * 1024),
    "地点检索服务",
  );
  const place = geocode.results?.[0];
  if (!place || typeof place.latitude !== "number" || typeof place.longitude !== "number") {
    throw new SafeApiError(404, "UPSTREAM_INVALID_RESPONSE", "没有找到这个地点");
  }

  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(place.latitude));
  forecastUrl.searchParams.set("longitude", String(place.longitude));
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
  );
  forecastUrl.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  );
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("forecast_days", "5");
  const forecast = parseJson<{
    timezone?: unknown;
    current?: Record<string, unknown>;
    daily?: {
      time?: unknown[];
      weather_code?: unknown[];
      temperature_2m_max?: unknown[];
      temperature_2m_min?: unknown[];
      precipitation_probability_max?: unknown[];
    };
  }>(await readFixedUpstream(forecastUrl.toString(), request, "天气服务", 256 * 1024), "天气服务");

  const currentCode = Number(forecast.current?.weather_code);
  const days = Array.isArray(forecast.daily?.time)
    ? forecast.daily.time.slice(0, 5).map((date, index) => {
        const code = Number(forecast.daily?.weather_code?.[index]);
        return {
          date: String(date).slice(0, 10),
          condition: WEATHER_CODES[code] ?? `天气代码 ${code}`,
          temperatureMax: Number(forecast.daily?.temperature_2m_max?.[index]),
          temperatureMin: Number(forecast.daily?.temperature_2m_min?.[index]),
          precipitationProbability: Number(forecast.daily?.precipitation_probability_max?.[index]),
        };
      })
    : [];

  return {
    provider: "Open-Meteo",
    location: [place.name, place.admin1, place.country]
      .filter((value) => typeof value === "string")
      .join("，"),
    timezone: typeof forecast.timezone === "string" ? forecast.timezone : place.timezone,
    current: {
      condition: WEATHER_CODES[currentCode] ?? `天气代码 ${currentCode}`,
      temperature: Number(forecast.current?.temperature_2m),
      apparentTemperature: Number(forecast.current?.apparent_temperature),
      precipitation: Number(forecast.current?.precipitation),
      windSpeed: Number(forecast.current?.wind_speed_10m),
    },
    days,
    retrievedAt: new Date().toISOString(),
  };
}

function decodeXml(value: string) {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();
}

function xmlElement(block: string, name: string) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? decodeXml(match[1] ?? "") : "";
}

function safeNewsUrl(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function stripMarkup(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clippedString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseRss(raw: string) {
  return [...raw.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
    .slice(0, 8)
    .map((match) => {
      const block = match[1] ?? "";
      const link = safeNewsUrl(xmlElement(block, "link"));
      return {
        title: xmlElement(block, "title").slice(0, 240),
        source: xmlElement(block, "source").slice(0, 100),
        publishedAt: xmlElement(block, "pubDate").slice(0, 100),
        snippet: stripMarkup(xmlElement(block, "description")).slice(0, 360),
        link,
      };
    })
    .filter((item) => item.title && item.link);
}

async function news(query: string, request: Request) {
  const providers = [
    {
      name: "Bing 资讯检索",
      url: `https://cn.bing.com/search?q=${encodeURIComponent(`${query} 最新消息`)}&format=rss&setlang=zh-cn`,
    },
    {
      name: "Google News RSS",
      url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
    },
  ];
  let lastError: unknown;
  for (const provider of providers) {
    try {
      const raw = await readFixedUpstream(provider.url, request, provider.name, 512 * 1024);
      const items = parseRss(raw);
      if (items.length) {
        return { provider: provider.name, query, items, retrievedAt: new Date().toISOString() };
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof SafeApiError) throw lastError;
  throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "近期资讯服务没有返回可用结果");
}

async function webSearch(query: string, request: Request) {
  try {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss&setlang=zh-cn`;
    const raw = await readFixedUpstream(url, request, "Bing 网页检索", 512 * 1024);
    const items = parseRss(raw);
    if (items.length) {
      return { provider: "Bing Search RSS", query, items, retrievedAt: new Date().toISOString() };
    }
  } catch {
    // Some Worker networks are rejected by Bing. Continue with a fixed-host,
    // no-key reference search instead of exposing arbitrary URL fetching.
  }

  try {
    const wikiUrl = new URL("https://zh.wikipedia.org/w/api.php");
    wikiUrl.searchParams.set("action", "query");
    wikiUrl.searchParams.set("list", "search");
    wikiUrl.searchParams.set("srsearch", query);
    wikiUrl.searchParams.set("srlimit", "8");
    wikiUrl.searchParams.set("utf8", "1");
    wikiUrl.searchParams.set("format", "json");
    const wiki = parseJson<{
      query?: {
        search?: Array<{
          pageid?: unknown;
          title?: unknown;
          snippet?: unknown;
          timestamp?: unknown;
        }>;
      };
    }>(
      await readFixedUpstream(wikiUrl.toString(), request, "中文百科检索服务", 512 * 1024),
      "中文百科检索服务",
    );
    const items = (wiki.query?.search ?? [])
      .slice(0, 8)
      .map((item) => ({
        title: clippedString(item.title, 240),
        source: "中文维基百科",
        publishedAt: clippedString(item.timestamp, 100),
        snippet: stripMarkup(clippedString(item.snippet, 600)).slice(0, 360),
        link:
          typeof item.pageid === "number" && Number.isFinite(item.pageid)
            ? `https://zh.wikipedia.org/?curid=${item.pageid}`
            : "",
      }))
      .filter((item) => item.title && item.link);
    if (items.length) {
      return { provider: "Wikipedia Search", query, items, retrievedAt: new Date().toISOString() };
    }
  } catch {
    // Some networks cannot reach zh.wikipedia.org. Continue through Wikimedia's
    // fixed-host REST API instead of accepting an arbitrary search endpoint.
  }

  const wikimediaUrl = new URL("https://api.wikimedia.org/core/v1/wikipedia/en/search/page");
  wikimediaUrl.searchParams.set("q", query);
  wikimediaUrl.searchParams.set("limit", "8");
  const wikimedia = parseJson<{
    pages?: Array<{
      id?: unknown;
      title?: unknown;
      excerpt?: unknown;
      description?: unknown;
    }>;
  }>(
    await readFixedUpstream(wikimediaUrl.toString(), request, "Wikimedia 检索服务", 512 * 1024),
    "Wikimedia 检索服务",
  );
  const items = (wikimedia.pages ?? [])
    .slice(0, 8)
    .map((item) => ({
      title: clippedString(item.title, 240),
      source: "Wikipedia",
      publishedAt: "",
      snippet: stripMarkup(
        [clippedString(item.description, 240), clippedString(item.excerpt, 600)]
          .filter(Boolean)
          .join(" · "),
      ).slice(0, 360),
      link:
        typeof item.id === "number" && Number.isFinite(item.id)
          ? `https://en.wikipedia.org/?curid=${item.id}`
          : "",
    }))
    .filter((item) => item.title && item.link);
  if (!items.length) {
    throw new SafeApiError(502, "UPSTREAM_INVALID_RESPONSE", "网页检索服务没有返回可用结果");
  }
  return { provider: "Wikimedia Search", query, items, retrievedAt: new Date().toISOString() };
}

export async function handleWebToolsPost(request: Request): Promise<Response> {
  try {
    requireApiSession(request);
    await enforceRateLimit(request, "web-tools", 24);
    const body = await parseJsonRequest(request, webToolBodySchema, API_LIMITS.webToolRequestBytes);
    const result =
      body.tool === "weather"
        ? await weather(body.location, request)
        : body.tool === "news"
          ? await news(body.query, request)
          : await webSearch(body.query, request);
    return apiJson({ ok: true, result });
  } catch (error) {
    if (!(error instanceof SafeApiError)) console.error("[web-tools] unexpected internal failure");
    return apiErrorResponse(error);
  }
}

export const Route = createFileRoute("/api/web-tools")({
  server: { handlers: { POST: ({ request }) => handleWebToolsPost(request) } },
});
