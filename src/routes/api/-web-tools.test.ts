/// <reference types="node" />

import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";

import { assertSafeResponse, responseBody, routeRequest } from "./-route-test-helpers.ts";
import { handleWebToolsPost } from "./web-tools.ts";

afterEach(() => vi.restoreAllMocks());

describe("POST /api/web-tools", () => {
  test("requires a same-origin API session before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const request = await routeRequest(
      "web-tools",
      JSON.stringify({ tool: "weather", location: "杭州" }),
    );

    const response = await handleWebToolsPost(request);

    assert.equal(response.status, 401);
    assert.equal((await responseBody(response)).code, "SESSION_REQUIRED");
    assert.equal(fetchMock.mock.calls.length, 0);
    assertSafeResponse(response);
  });

  test("queries only fixed Open-Meteo hosts and returns a compact forecast", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              name: "杭州",
              admin1: "浙江",
              country: "中国",
              latitude: 30.25,
              longitude: 120.17,
              timezone: "Asia/Shanghai",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          timezone: "Asia/Shanghai",
          current: {
            temperature_2m: 28,
            apparent_temperature: 30,
            precipitation: 0,
            weather_code: 1,
            wind_speed_10m: 6,
          },
          daily: {
            time: ["2026-08-27"],
            weather_code: [1],
            temperature_2m_max: [31],
            temperature_2m_min: [24],
            precipitation_probability_max: [20],
          },
        }),
      );
    const response = await handleWebToolsPost(
      await routeRequest("web-tools", JSON.stringify({ tool: "weather", location: "杭州" }), {
        authenticated: true,
      }),
    );
    const payload = await responseBody(response);

    assert.equal(response.status, 200);
    assert.equal((payload.result as { provider: string }).provider, "Open-Meteo");
    assert.equal(fetchMock.mock.calls.length, 2);
    assert.equal(
      new URL(String(fetchMock.mock.calls[0]?.[0])).hostname,
      "geocoding-api.open-meteo.com",
    );
    assert.equal(new URL(String(fetchMock.mock.calls[1]?.[0])).hostname, "api.open-meteo.com");
    assertSafeResponse(response);
  });

  test("parses current-news RSS without exposing arbitrary fetch URLs", async () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><title>示例资讯 &amp; 更新</title><link>https://news.example/item</link><pubDate>Thu, 27 Aug 2026 08:00:00 GMT</pubDate><source>示例媒体</source></item></channel></rss>`;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(rss, { status: 200, headers: { "Content-Type": "application/rss+xml" } }),
      );
    const response = await handleWebToolsPost(
      await routeRequest("web-tools", JSON.stringify({ tool: "news", query: "人工智能" }), {
        authenticated: true,
      }),
    );
    const payload = await responseBody(response);
    const result = payload.result as { items: Array<{ title: string; link: string }> };

    assert.equal(response.status, 200);
    assert.equal(result.items[0]?.title, "示例资讯 & 更新");
    assert.equal(result.items[0]?.link, "https://news.example/item");
    assert.equal(new URL(String(fetchMock.mock.calls[0]?.[0])).hostname, "cn.bing.com");
    assertSafeResponse(response);
  });

  test("offers a fixed-host general web search", async () => {
    const rss = `<?xml version="1.0"?><rss><channel><item><title>Open-Meteo 文档</title><link>https://open-meteo.com/en/docs</link><description>开放天气接口</description></item></channel></rss>`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(rss));
    const response = await handleWebToolsPost(
      await routeRequest("web-tools", JSON.stringify({ tool: "search", query: "天气 API" }), {
        authenticated: true,
      }),
    );
    const payload = await responseBody(response);

    assert.equal(response.status, 200);
    assert.equal((payload.result as { provider: string }).provider, "Bing Search RSS");
    assert.equal(new URL(String(fetchMock.mock.calls[0]?.[0])).hostname, "cn.bing.com");
    assertSafeResponse(response);
  });

  test("falls back to fixed-host Wikipedia search when Bing rejects the Worker", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(
        Response.json({
          query: {
            search: [
              {
                pageid: 123,
                title: "Open-Meteo",
                snippet: "一个开源的&lt;b&gt;天气 API&lt;/b&gt;",
                timestamp: "2026-08-27T00:00:00Z",
              },
            ],
          },
        }),
      );
    const response = await handleWebToolsPost(
      await routeRequest("web-tools", JSON.stringify({ tool: "search", query: "Open-Meteo" }), {
        authenticated: true,
      }),
    );
    const payload = await responseBody(response);
    const result = payload.result as {
      provider: string;
      items: Array<{ link: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(result.provider, "Wikipedia Search");
    assert.equal(result.items[0]?.link, "https://zh.wikipedia.org/?curid=123");
    assert.equal(new URL(String(fetchMock.mock.calls[1]?.[0])).hostname, "zh.wikipedia.org");
    assertSafeResponse(response);
  });

  test("uses Wikimedia REST when both Bing and Chinese Wikipedia are unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockResolvedValueOnce(new Response("timeout", { status: 504 }))
      .mockResolvedValueOnce(
        Response.json({
          pages: [
            {
              id: 456,
              title: "Open-Meteo",
              description: "Open source weather API",
              excerpt: "Weather forecasts",
            },
          ],
        }),
      );
    const response = await handleWebToolsPost(
      await routeRequest("web-tools", JSON.stringify({ tool: "search", query: "Open-Meteo" }), {
        authenticated: true,
      }),
    );
    const payload = await responseBody(response);
    const result = payload.result as { provider: string; items: Array<{ link: string }> };

    assert.equal(response.status, 200);
    assert.equal(result.provider, "Wikimedia Search");
    assert.equal(result.items[0]?.link, "https://en.wikipedia.org/?curid=456");
    assert.equal(new URL(String(fetchMock.mock.calls[2]?.[0])).hostname, "api.wikimedia.org");
    assertSafeResponse(response);
  });
});
