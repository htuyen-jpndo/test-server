import express from "express";

/**
 * Local stand-in for J-Payment / Robot Payment link checkout, kickback, acsgate, and card change.
 * Not started by the API process. Never bind this in production (the CLI refuses NODE_ENV=production).
 */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readFields(req) {
  const src = { ...(req.query || {}), ...(req.body || {}) };
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (value == null) continue;
    out[key] = Array.isArray(value) ? String(value[0]) : String(value);
  }
  return out;
}

function taOf(am, tx, sf) {
  const n = Number(am || 0) + Number(tx || 0) + Number(sf || 0);
  return Number.isFinite(n) ? String(Math.trunc(n)) : "0";
}

export function createJPaymentMockApp(options = {}) {
  const store = {
    seq: 1000000,
    checkouts: new Map(),
    charges: new Map(),
    controls: {
      nextStop: "ok",
      nextCancel: "ok",
      stopDelayMs: 0,
    },
  };

  function config() {
    const appBase = String(options.appBase || process.env.JPAYMENT_MOCK_APP_BASE || "http://127.0.0.1:5000")
      .trim()
      .replace(/\/+$/, "");
    const secret = String(options.secret ?? process.env.JPAYMENT_CALLBACK_QUERY_SECRET ?? "").trim();
    const secretIn = String(options.secretIn || process.env.JPAYMENT_MOCK_SECRET_IN || "path")
      .trim()
      .toLowerCase();
    return { appBase, secret, secretIn };
  }

  function nextId() {
    store.seq += 1;
    return String(store.seq);
  }

  function callbackUrl(params) {
    const { appBase, secret, secretIn } = config();
    if (!secret) {
      const err = new Error("JPAYMENT_CALLBACK_QUERY_SECRET is not set on the mock");
      err.statusCode = 500;
      throw err;
    }
    const path =
      secretIn === "query"
        ? `${appBase}/api/payment/callback`
        : `${appBase}/api/payment/callback/${encodeURIComponent(secret)}`;
    const url = new URL(path);
    if (secretIn === "query") url.searchParams.set("s", secret);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  function returnUrl(params) {
    const { appBase } = config();
    const url = new URL(`${appBase}/api/payment/return`);
    for (const key of ["gid", "rst", "ap", "ec", "god", "cod", "am", "tx", "sf", "ta", "acid", "uid"]) {
      const value = params[key];
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  function buildResult(checkout, rst) {
    const gid = nextId();
    const acid = rst === "1" && (checkout.actp || checkout.acam) ? nextId() : checkout.acid || "";
    const params = {
      gid,
      rst: String(rst),
      ap: rst === "1" ? "123456" : "",
      ec: rst === "1" ? "" : "G055",
      god: nextId(),
      cod: checkout.cod,
      am: checkout.am || "0",
      tx: checkout.tx || "0",
      sf: checkout.sf || "0",
      ta: taOf(checkout.am, checkout.tx, checkout.sf),
      acid,
      uid: checkout.uid || "",
      actp: checkout.actp || "",
      acam: checkout.acam || "",
    };
    if (rst === "1" && acid) {
      store.charges.set(acid, {
        acid,
        aid: checkout.aid,
        gid,
        cod: checkout.cod,
        uid: checkout.uid || "",
        am: checkout.am || "0",
        acam: checkout.acam || checkout.am || "0",
        actp: checkout.actp || "",
        ac4: checkout.ac4 || "",
        stopped: false,
        cardLast4: null,
      });
      checkout.acid = acid;
      checkout.gid = gid;
    }
    checkout.lastRst = String(rst);
    return params;
  }

  function renewParams(charge, rst) {
    const gid = nextId();
    return {
      gid,
      rst: String(rst),
      cod: charge.cod,
      acid: charge.acid,
      ec: rst === "1" ? "" : "G055",
      am: charge.acam || charge.am || "0",
      tx: "0",
      sf: "0",
      ta: charge.acam || charge.am || "0",
      uid: charge.uid || "",
      ap: rst === "1" ? "123456" : "",
      god: nextId(),
    };
  }

  function redactUrl(url) {
    const { secret } = config();
    if (!secret) return url;
    return String(url).split(secret).join("[REDACTED]").split(encodeURIComponent(secret)).join("[REDACTED]");
  }

  async function sendCallback(params) {
    const url = callbackUrl(params);
    const response = await fetch(url);
    const body = await response.text();
    return { url: redactUrl(url), status: response.status, body: body.slice(0, 500) };
  }

  function layout(title, body) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 880px; color: #1a1a1a; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; }
  td, th { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { width: 140px; background: #f6f6f6; }
  button, .btn { margin: 0 8px 8px 0; padding: 8px 12px; }
  .warn { background: #fff6e8; border: 1px solid #e6c98a; padding: 10px 12px; }
  .err { background: #fdecec; border: 1px solid #e3a0a0; padding: 10px 12px; }
  code { font-size: 0.95em; }
  nav a { margin-right: 12px; }
</style></head>
<body>
<nav><a href="/">Mock home</a></nav>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
  }

  function paramTable(fields) {
    const keys = [
      "aid", "am", "tx", "sf", "jb", "cod", "uid", "actp", "acam", "actx", "acsf", "ac1", "ac4", "inm", "iid2", "acid", "gid",
    ];
    const rows = keys
      .filter((key) => fields[key] != null && fields[key] !== "")
      .map((key) => `<tr><th>${esc(key)}</th><td><code>${esc(fields[key])}</code></td></tr>`)
      .join("");
    return `<table>${rows || "<tr><td>(no fields)</td></tr>"}</table>`;
  }

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mock: true });
  });

  app.get("/", (_req, res) => {
    const charges = [...store.charges.values()];
    const checkouts = [...store.checkouts.values()];
    const chargeRows = charges
      .map(
        (c) => `<tr>
          <td><code>${esc(c.acid)}</code></td>
          <td><code>${esc(c.cod)}</code></td>
          <td>${esc(c.acam)}</td>
          <td>${c.stopped ? "stopped" : "active"}</td>
          <td>${esc(c.cardLast4 || "")}</td>
          <td>
            <form method="post" action="/mock/auto-renew" style="display:inline">
              <input type="hidden" name="acid" value="${esc(c.acid)}" />
              <input type="hidden" name="rst" value="1" />
              <button>rst=1 success</button>
            </form>
            <form method="post" action="/mock/auto-renew" style="display:inline">
              <input type="hidden" name="acid" value="${esc(c.acid)}" />
              <input type="hidden" name="rst" value="3" />
              <button>rst=3 retry</button>
            </form>
            <form method="post" action="/mock/auto-renew" style="display:inline">
              <input type="hidden" name="acid" value="${esc(c.acid)}" />
              <input type="hidden" name="rst" value="2" />
              <button>rst=2 final fail</button>
            </form>
            <form method="post" action="/mock/auto-renew" style="display:inline">
              <input type="hidden" name="acid" value="${esc(c.acid)}" />
              <input type="hidden" name="rst" value="4" />
              <button>rst=4 user stop</button>
            </form>
            <form method="post" action="/mock/auto-renew/retry-then-success" style="display:inline">
              <input type="hidden" name="acid" value="${esc(c.acid)}" />
              <button>rst=3 then rst=1</button>
            </form>
          </td>
        </tr>`
      )
      .join("");
    res.type("html").send(
      layout(
        "J-Payment mock",
        `<p class="warn">Local only. The API uses this host only when <code>JPAYMENT_MOCK=true</code> (refused in production) or <code>JPAYMENT_BASE_URL</code> points here.</p>
        <h2>Next acsgate / gateway.aspx result</h2>
        <form method="post" action="/mock/controls">
          <label>acsgate <select name="nextStop">
            ${["ok", "er003", "er024", "er051", "empty", "unexpected", "timeout"]
              .map(
                (v) =>
                  `<option value="${v}"${store.controls.nextStop === v ? " selected" : ""}>${v}</option>`
              )
              .join("")}
          </select></label>
          <label>gateway.aspx <select name="nextCancel">
            ${["ok", "er033", "empty"]
              .map(
                (v) =>
                  `<option value="${v}"${store.controls.nextCancel === v ? " selected" : ""}>${v}</option>`
              )
              .join("")}
          </select></label>
          <label>stop delay ms <input name="stopDelayMs" value="${esc(store.controls.stopDelayMs)}" size="6" /></label>
          <button>Save</button>
        </form>
        <p>Current: stop=<code>${esc(store.controls.nextStop)}</code>, cancel=<code>${esc(store.controls.nextCancel)}</code>, delay=<code>${esc(store.controls.stopDelayMs)}</code></p>
        <h2>Checkouts</h2>
        <ul>${checkouts.map((c) => `<li><code>${esc(c.cod)}</code> am=${esc(c.am)} rst=${esc(c.lastRst || "pending")}</li>`).join("") || "<li>none yet</li>"}</ul>
        <h2>Auto-charge (acid)</h2>
        <table><tr><th>acid</th><th>cod</th><th>acam</th><th>stop</th><th>card</th><th>Send kickback</th></tr>
        ${chargeRows || "<tr><td colspan=6>none yet — complete a checkout first</td></tr>"}</table>
        <p>Card change: <a href="/link/creditcard/auto-charge/update">/link/creditcard/auto-charge/update</a></p>`
      )
    );
  });

  app.get("/mock/state", (_req, res) => {
    res.json({
      controls: store.controls,
      checkouts: [...store.checkouts.values()],
      charges: [...store.charges.values()],
    });
  });

  app.post("/mock/controls", (req, res) => {
    const fields = readFields(req);
    if (fields.nextStop) store.controls.nextStop = fields.nextStop;
    if (fields.nextCancel) store.controls.nextCancel = fields.nextCancel;
    if (fields.stopDelayMs != null && fields.stopDelayMs !== "") {
      const n = Number(fields.stopDelayMs);
      store.controls.stopDelayMs = Number.isFinite(n) && n >= 0 ? n : 0;
    }
    if (req.is("application/json") || fields.format === "json") {
      return res.json({ ok: true, controls: store.controls });
    }
    return res.redirect(303, "/");
  });

  function checkoutPage(checkout, extra = "") {
    return layout(
      "Mock checkout",
      `${extra}
      <p>Choose an outcome. <strong>Callback + return</strong> sends the server kickback (with the notify secret), then redirects the browser to <code>/api/payment/return</code> without the secret. <strong>Browser return only</strong> skips the kickback — the API must leave the order unpaid.</p>
      ${paramTable(checkout)}
      <form method="post" action="/mock/settle">
        <input type="hidden" name="cod" value="${esc(checkout.cod)}" />
        <input type="hidden" name="rst" value="1" />
        <input type="hidden" name="mode" value="callback-and-return" />
        <button>Pay success (rst=1) — callback then return</button>
      </form>
      <form method="post" action="/mock/settle">
        <input type="hidden" name="cod" value="${esc(checkout.cod)}" />
        <input type="hidden" name="rst" value="2" />
        <input type="hidden" name="mode" value="callback-and-return" />
        <button>Pay fail (rst=2) — callback then return</button>
      </form>
      <form method="post" action="/mock/settle">
        <input type="hidden" name="cod" value="${esc(checkout.cod)}" />
        <input type="hidden" name="rst" value="1" />
        <input type="hidden" name="mode" value="return-only" />
        <button>Browser return only (rst=1, no callback)</button>
      </form>`
    );
  }

  function rememberCheckout(fields) {
    const cod = String(fields.cod || "").trim();
    if (!cod) return null;
    const existing = store.checkouts.get(cod);
    const checkout = {
      aid: fields.aid || existing?.aid || "",
      am: fields.am || existing?.am || "",
      tx: fields.tx || existing?.tx || "0",
      sf: fields.sf || existing?.sf || "0",
      jb: fields.jb || existing?.jb || "",
      cod,
      uid: fields.uid || existing?.uid || "",
      actp: fields.actp || existing?.actp || "",
      acam: fields.acam || existing?.acam || "",
      actx: fields.actx || existing?.actx || "",
      acsf: fields.acsf || existing?.acsf || "",
      ac4: fields.ac4 || existing?.ac4 || "",
      inm: fields.inm || existing?.inm || "",
      iid2: fields.iid2 || existing?.iid2 || "",
      acid: existing?.acid || "",
      gid: existing?.gid || "",
      lastRst: existing?.lastRst || "",
    };
    store.checkouts.set(cod, checkout);
    return checkout;
  }

  app.post("/link/creditcard", (req, res) => {
    const checkout = rememberCheckout(readFields(req));
    if (!checkout) return res.status(400).type("html").send(layout("Mock checkout", "<p class='err'>Missing cod</p>"));
    res.type("html").send(checkoutPage(checkout));
  });

  app.get("/link/creditcard", (_req, res) => {
    res
      .status(200)
      .type("html")
      .send(layout("Mock checkout", "<p>POST the link form (aid, am, cod, uid, actp, acam, ac4, …) here.</p>"));
  });

  async function settle(req, res) {
    const fields = readFields(req);
    const checkout = store.checkouts.get(String(fields.cod || "").trim());
    if (!checkout) {
      return res.status(404).json({ error: "Unknown cod. Post the checkout form first." });
    }
    const rst = String(fields.rst || "1").trim();
    const mode = fields.mode === "return-only" ? "return-only" : "callback-and-return";
    const params = buildResult(checkout, rst);
    let callback = null;
    if (mode === "callback-and-return") {
      try {
        callback = await sendCallback(params);
      } catch (err) {
        const message = err?.message || String(err);
        if (req.is("application/json") || fields.format === "json") {
          return res.status(502).json({ ok: false, error: message, params });
        }
        return res
          .status(502)
          .type("html")
          .send(checkoutPage(checkout, `<p class="err">Callback failed: ${esc(message)}</p>`));
      }
      if (callback.status >= 400) {
        if (req.is("application/json") || fields.format === "json") {
          return res.status(502).json({ ok: false, callback, params, returnUrl: returnUrl(params) });
        }
        return res
          .status(502)
          .type("html")
          .send(
            checkoutPage(
              checkout,
              `<p class="err">Callback HTTP ${callback.status}. Body: <code>${esc(callback.body)}</code></p>`
            )
          );
      }
    }
    const back = returnUrl(params);
    if (req.is("application/json") || fields.format === "json") {
      return res.json({ ok: true, mode, params, callback, returnUrl: back });
    }
    return res.redirect(302, back);
  }

  app.post("/mock/settle", (req, res) => {
    settle(req, res).catch((err) => {
      console.error("[jpayment-mock] settle", err);
      res.status(500).json({ error: err?.message || "settle failed" });
    });
  });

  async function sendRenew(acid, rst) {
    const charge = store.charges.get(String(acid || "").trim());
    if (!charge) {
      const err = new Error("Unknown acid");
      err.statusCode = 404;
      throw err;
    }
    const params = renewParams(charge, rst);
    const callback = await sendCallback(params);
    return { params, callback };
  }

  app.post("/mock/auto-renew", (req, res) => {
    const fields = readFields(req);
    sendRenew(fields.acid, fields.rst || "1")
      .then((result) => {
        if (req.is("application/json") || fields.format === "json") return res.json({ ok: true, ...result });
        const bad = result.callback.status >= 400;
        return res
          .status(bad ? 502 : 200)
          .type("html")
          .send(
            layout(
              "Auto-renew kickback",
              `<p>Sent rst=${esc(result.params.rst)} gid=${esc(result.params.gid)} acid=${esc(result.params.acid)}</p>
               <p>Callback HTTP ${result.callback.status}</p>
               <pre>${esc(result.callback.body)}</pre>
               <p><a href="/">Back</a></p>`
            )
          );
      })
      .catch((err) => {
        res.status(err.statusCode || 500).json({ error: err?.message || "auto-renew failed" });
      });
  });

  app.post("/mock/auto-renew/retry-then-success", (req, res) => {
    const fields = readFields(req);
    sendRenew(fields.acid, "3")
      .then(async (first) => {
        const second = await sendRenew(fields.acid, "1");
        const payload = { ok: first.callback.status < 400 && second.callback.status < 400, first, second };
        if (req.is("application/json") || fields.format === "json") return res.json(payload);
        return res.type("html").send(
          layout(
            "Retry then success",
            `<p>rst=3 HTTP ${first.callback.status}, then rst=1 HTTP ${second.callback.status} (gid ${esc(second.params.gid)})</p>
             <p><a href="/">Back</a></p>`
          )
        );
      })
      .catch((err) => {
        res.status(err.statusCode || 500).json({ error: err?.message || "retry-then-success failed" });
      });
  });

  app.get("/mock/frontend-return", (req, res) => {
    const r = req.query.r != null ? String(req.query.r) : "";
    res.type("html").send(
      layout(
        "Mock frontend return",
        `<p>The API redirected here with result token <code>${esc(r || "(none)")}</code>.</p>
         <p>This page is only a stand-in for <code>PAYMENT_FRONTEND_RETURN_URL</code>.</p>`
      )
    );
  });

  async function acsgate(req, res) {
    const fields = readFields(req);
    const mode = store.controls.nextStop;
    const delay = Number(store.controls.stopDelayMs) || 0;
    if (mode === "timeout") {
      await new Promise((resolve) => setTimeout(resolve, delay > 0 ? delay : 20000));
      if (!res.writableEnded) res.socket?.destroy();
      return;
    }
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (mode === "empty") return res.status(200).type("text/plain").send("");
    if (mode === "er003") return res.status(200).type("text/plain").send("ER003");
    if (mode === "er051") return res.status(200).type("text/plain").send("ER051");
    if (mode === "unexpected") return res.status(200).type("text/plain").send("USER ORDER SERVER");
    const acid = String(fields.acid || "").trim();
    const cmd = String(fields.cmd || "").trim();
    if (!acid || cmd !== "1") return res.status(200).type("text/plain").send("ER051");
    const charge = store.charges.get(acid);
    if (!charge) return res.status(200).type("text/plain").send("ER072");
    if (charge.stopped || mode === "er024") {
      charge.stopped = true;
      return res.status(200).type("text/plain").send("ER024");
    }
    charge.stopped = true;
    return res.status(200).type("text/plain").send("OK");
  }

  app.post("/gateway/acsgate.aspx", (req, res) => {
    acsgate(req, res).catch((err) => res.status(500).type("text/plain").send(err?.message || "error"));
  });
  app.get("/gateway/acsgate.aspx", (req, res) => {
    acsgate(req, res).catch((err) => res.status(500).type("text/plain").send(err?.message || "error"));
  });

  app.post("/gateway/gateway.aspx", (req, res) => {
    const fields = readFields(req);
    const mode = store.controls.nextCancel;
    if (mode === "empty") return res.status(200).type("text/plain").send("");
    if (mode === "er033") return res.status(200).type("text/plain").send("ER033");
    const tid = String(fields.tid || "").trim();
    const charge = [...store.charges.values()].find((c) => c.gid === tid);
    const am = charge?.am || "0";
    const cod = charge?.cod || "";
    const god = "1";
    // rt=1 comma body: gid,rst,ap,ec,god,cod,am,tx,sf,ta,id,ps
    const line = [tid || "0", "1", "654321", "", god, cod, am, "0", "0", am, "", ""].join(",");
    return res.status(200).type("text/plain").send(line);
  });

  function cardChangePage(fields, message = "") {
    return layout(
      "Mock card change",
      `${message}
      <p>The API only hands the browser this link with <code>aid</code>. J-Payment then asks for the auto-charge number. This page does not call the API — card updates stay on the mock charge record.</p>
      ${paramTable(fields)}
      <form method="post" action="/link/creditcard/auto-charge/update">
        <input type="hidden" name="aid" value="${esc(fields.aid || "")}" />
        <p><label>acid <input name="acid" value="${esc(fields.acid || "")}" required /></label></p>
        <p><label>gid <input name="gid" value="${esc(fields.gid || "")}" /></label></p>
        <p><label>new card last4 (mock only) <input name="card_last4" value="" maxlength="4" pattern="[0-9]{4}" required /></label></p>
        <button>Update card</button>
      </form>`
    );
  }

  app.get("/link/creditcard/auto-charge/update", (req, res) => {
    res.type("html").send(cardChangePage(readFields(req)));
  });

  app.post("/link/creditcard/auto-charge/update", (req, res) => {
    const fields = readFields(req);
    const acid = String(fields.acid || "").trim();
    const charge = acid ? store.charges.get(acid) : null;
    if (!charge) {
      return res
        .status(404)
        .type("html")
        .send(cardChangePage(fields, `<p class="err">Unknown acid ${esc(acid)}</p>`));
    }
    const last4 = String(fields.card_last4 || "").trim();
    if (!/^\d{4}$/.test(last4)) {
      return res.status(400).type("html").send(cardChangePage(fields, `<p class="err">card_last4 must be 4 digits</p>`));
    }
    charge.cardLast4 = last4;
    if (fields.gid) charge.gidNoted = fields.gid;
    return res.type("html").send(
      layout(
        "Card updated",
        `<p>acid <code>${esc(acid)}</code> card last4 is now <code>${esc(last4)}</code>. No kickback was sent.</p>
         <p><a href="/">Back</a></p>`
      )
    );
  });

  return { app, store, config };
}
