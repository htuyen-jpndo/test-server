/**
 * Some notify agents append gateway params with a second literal `?` after `?s=secret`
 * (e.g. `.../callback?s=TOKEN?gid=...&rst=1`). That is not a valid query string; Express
 * then omits or mis-binds keys like `gid`. Normalize by turning extra `?` into `&`.
 *
 * Express runs its built-in `query` middleware *before* user `app.use` handlers, so it
 * caches a wrong `req.query` on the malformed URL. After we fix `req.url`, we must
 * re-parse `req.query` using the app's `query parser fn` or the stale object remains.
 */
export function normalizeDoubleQuestionQuery(req, _res, next) {
  let fixed = false;
  for (const key of ["url", "originalUrl"]) {
    const u = req[key];
    if (typeof u !== "string" || u.indexOf("?") === -1) continue;
    const q0 = u.indexOf("?");
    const afterFirst = u.slice(q0 + 1);
    if (!afterFirst.includes("?")) continue;
    req[key] = u.slice(0, q0 + 1) + afterFirst.split("?").join("&");
    fixed = true;
  }

  if (fixed) {
    if (req._parsedUrl) delete req._parsedUrl;
    const parseFn =
      typeof req.app?.get === "function" ? req.app.get("query parser fn") : null;
    const u = req.url;
    const qIdx = typeof u === "string" ? u.indexOf("?") : -1;
    const rawQs = qIdx === -1 ? "" : u.slice(qIdx + 1);
    if (typeof parseFn === "function") {
      req.query = parseFn(rawQs);
    }
  }

  next();
}
