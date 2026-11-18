import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, it } from "node:test";
import { createJPaymentMockApp } from "../src/mock/jpaymentMock.js";
import {
  JPAYMENT_REAL_ORIGIN,
  assertJPaymentEndpointsAllowed,
  isJPaymentMockEnabled,
  jpayAutoChargeStopUrl,
  jpayLinkCheckoutUrl,
  jpaymentOrigin,
} from "../src/utils/jpaymentEndpoints.js";

const ORIGINAL = {
  NODE_ENV: process.env.NODE_ENV,
  JPAYMENT_MOCK: process.env.JPAYMENT_MOCK,
  JPAYMENT_MOCK_BASE_URL: process.env.JPAYMENT_MOCK_BASE_URL,
  JPAYMENT_BASE_URL: process.env.JPAYMENT_BASE_URL,
};

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("J-Payment endpoint switch", () => {
  it("stays on the real host unless the mock is opted in", () => {
    delete process.env.JPAYMENT_MOCK;
    process.env.NODE_ENV = "development";
    process.env.JPAYMENT_MOCK_BASE_URL = "http://127.0.0.1:5099";
    delete process.env.JPAYMENT_BASE_URL;
    assert.equal(isJPaymentMockEnabled(), false);
    assert.equal(jpaymentOrigin(), JPAYMENT_REAL_ORIGIN);
    assert.equal(jpayLinkCheckoutUrl(), `${JPAYMENT_REAL_ORIGIN}/link/creditcard`);
    assert.doesNotThrow(() => assertJPaymentEndpointsAllowed());
  });

  it("points at the mock only when JPAYMENT_MOCK is set, and refuses that in production", () => {
    process.env.NODE_ENV = "development";
    process.env.JPAYMENT_MOCK = "true";
    process.env.JPAYMENT_MOCK_BASE_URL = "http://127.0.0.1:5099";
    assert.equal(jpayAutoChargeStopUrl(), "http://127.0.0.1:5099/gateway/acsgate.aspx");
    assert.equal(jpayLinkCheckoutUrl(), "http://127.0.0.1:5099/link/creditcard");

    process.env.NODE_ENV = "production";
    assert.throws(() => assertJPaymentEndpointsAllowed(), /not allowed when NODE_ENV=production/);

    delete process.env.JPAYMENT_MOCK;
    process.env.JPAYMENT_BASE_URL = "http://127.0.0.1:5099";
    assert.throws(() => assertJPaymentEndpointsAllowed(), /not allowed when NODE_ENV=production/);
  });
});

describe("mock gateway", () => {
  it("takes the checkout form, sends a secret callback, and keeps the secret off the browser return", async () => {
    const hits = [];
    const stub = http.createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>OK</body></html>");
    });
    const stubPort = await listen(stub);
    const secret = "notify-secret-value";
    const { app, store } = createJPaymentMockApp({
      appBase: `http://127.0.0.1:${stubPort}`,
      secret,
    });
    const mockServer = http.createServer(app);
    const mockPort = await listen(mockServer);
    const mockBase = `http://127.0.0.1:${mockPort}`;
    try {
      const posted = await fetch(`${mockBase}/link/creditcard`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          aid: "100001",
          am: "1320",
          tx: "0",
          sf: "0",
          jb: "CAPTURE",
          cod: "ORD_1_personal_monthly_1",
          uid: "uidtoken",
          actp: "4",
          acam: "1320",
          ac4: "2026/12/01",
          inm: "個人プラン・月額払い",
        }),
      });
      const html = await posted.text();
      for (const key of ["1320", "ORD_1_personal_monthly_1", "actp", "acam", "2026/12/01", "uidtoken"]) {
        assert.equal(html.includes(key), true, key);
      }

      const settled = await fetch(`${mockBase}/mock/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cod: "ORD_1_personal_monthly_1", rst: "1", mode: "callback-and-return" }),
      });
      const body = await settled.json();
      assert.equal(settled.status, 200);
      assert.equal(hits.length, 1);
      const callback = new URL(hits[0], `http://127.0.0.1:${stubPort}`);
      assert.equal(callback.pathname, `/api/payment/callback/${encodeURIComponent(secret)}`);
      assert.equal(callback.searchParams.get("rst"), "1");
      assert.equal(callback.searchParams.get("cod"), "ORD_1_personal_monthly_1");
      assert.equal(callback.searchParams.get("am"), "1320");
      assert.equal(callback.searchParams.get("uid"), "uidtoken");
      assert.ok(callback.searchParams.get("gid"));
      assert.ok(callback.searchParams.get("acid"));
      assert.equal(callback.searchParams.get("s"), null);
      assert.equal(body.returnUrl.includes(secret), false);
      assert.equal(body.returnUrl.includes("rst=1"), true);
      assert.equal(body.returnUrl.includes("/api/payment/return"), true);
      assert.equal(body.callback.url.includes(secret), false);

      const before = hits.length;
      const forged = await fetch(`${mockBase}/mock/settle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cod: "ORD_1_personal_monthly_1", rst: "1", mode: "return-only" }),
      });
      const forgedBody = await forged.json();
      assert.equal(forged.status, 200);
      assert.equal(hits.length, before);
      assert.equal(forgedBody.callback, null);
      assert.equal(forgedBody.returnUrl.includes("rst=1"), true);

      const acid = body.params.acid;
      const renew = await fetch(`${mockBase}/mock/auto-renew/retry-then-success`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acid }),
      });
      const renewBody = await renew.json();
      assert.equal(renew.status, 200);
      assert.equal(renewBody.first.params.rst, "3");
      assert.equal(renewBody.second.params.rst, "1");
      assert.equal(renewBody.first.params.acid, acid);
      assert.notEqual(renewBody.first.params.gid, renewBody.second.params.gid);
      assert.equal(hits.length, 3);
      const third = new URL(hits[2], `http://127.0.0.1:${stubPort}`);
      assert.equal(third.searchParams.get("rst"), "1");
      assert.equal(third.searchParams.get("acid"), acid);
      assert.equal(third.pathname.includes(secret), true);

      const stopped = await fetch(`${mockBase}/gateway/acsgate.aspx`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ aid: "100001", acid, cmd: "1" }),
      });
      assert.equal(await stopped.text(), "OK");
      const again = await fetch(`${mockBase}/gateway/acsgate.aspx`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ aid: "100001", acid, cmd: "1" }),
      });
      assert.equal(await again.text(), "ER024");

      store.controls.nextStop = "er003";
      const er = await fetch(`${mockBase}/gateway/acsgate.aspx`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ aid: "100001", acid, cmd: "1" }),
      });
      assert.equal(await er.text(), "ER003");

      store.controls.nextStop = "empty";
      const empty = await fetch(`${mockBase}/gateway/acsgate.aspx`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ aid: "100001", acid, cmd: "1" }),
      });
      assert.equal(await empty.text(), "");

      store.controls.nextStop = "unexpected";
      const odd = await fetch(`${mockBase}/gateway/acsgate.aspx`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ aid: "100001", acid, cmd: "1" }),
      });
      assert.equal(await odd.text(), "USER ORDER SERVER");

      store.controls.nextCancel = "ok";
      const gid = body.params.gid;
      const cancel = await fetch(`${mockBase}/gateway/gateway.aspx`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ aid: "100001", jb: "CANCEL", rt: "1", tid: gid }),
      });
      const cancelText = await cancel.text();
      assert.equal(cancelText.split(",")[1], "1");

      const card = await fetch(`${mockBase}/link/creditcard/auto-charge/update?aid=100001`);
      assert.equal((await card.text()).includes("acid"), true);
      const updated = await fetch(`${mockBase}/link/creditcard/auto-charge/update`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ aid: "100001", acid, card_last4: "4242" }),
      });
      assert.equal(updated.status, 200);
      assert.equal(store.charges.get(acid).cardLast4, "4242");
    } finally {
      await close(mockServer);
      await close(stub);
    }
  });
});
