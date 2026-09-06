/** Cache only the public app shell and build assets. Never API/model traffic. */
export function isAppNavigation(url: URL, mode: string, method: string, origin: string) {
  return method === "GET" && mode === "navigate" && url.origin === origin && url.pathname === "/";
}

export function isPrecachedAsset(
  url: URL,
  method: string,
  origin: string,
  assets: readonly string[],
) {
  return method === "GET" && url.origin === origin && !url.search && assets.includes(url.pathname);
}
