/**
 * End-to-end exercise of the payment fixes against the local J-Payment mock.
 * Requires MySQL/MariaDB. Not part of `npm test`.
 *
 *   DB_HOST=127.0.0.1 DB_USER=drone DB_PASS=drone DB_NAME=drone_flight npm run jpayment:exercise
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "mock-notify-secret-0123456789";
const APP_PORT = "5055";
const MOCK_PORT = "5099";
const APP = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const ADMIN_EMAIL = "admin-mock@example.com";
const ADMIN_PASSWORD = "admin-mock-pass";

const env = {
  ...process.env,
  NODE_ENV: "development",
  PORT: APP_PORT,
  DB_HOST: process.env.DB_HOST || "127.0.0.1",
  DB_PORT: process.env.DB_PORT || "3306",
  DB_USER: process.env.DB_USER || "drone",
  DB_PASS: process.env.DB_PASS || "drone",
  DB_NAME: process.env.DB_NAME || "drone_flight",
  JWT_SECRET: process.env.JWT_SECRET || "exercise-jwt-secret",
  JPAYMENT_AID: "100001",
  JPAYMENT_CALLBACK_QUERY_SECRET: SECRET,
  JPAYMENT_MOCK: "true",
  JPAYMENT_MOCK_BASE_URL: MOCK,
  JPAYMENT_MOCK_APP_BASE: APP,
  JPAYMENT_MOCK_PORT: MOCK_PORT,
  BACKEND_PUBLIC_BASE_URL: APP,
  PAYMENT_FRONTEND_RETURN_URL: `${MOCK}/mock/frontend-return`,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  PAYMENT_AUTO_CHARGE_STOP_RETRY_WORKER_ENABLED: "false",
  PAYMENT_BANK_FREE_AUTO_RENEW_WORKER_ENABLED: "false",
};
delete env.DATABASE_URL;
delete env.JPAYMENT_BASE_URL;
Object.assign(process.env, env);

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function spawnNode(script) {
  const child = spawn(process.execPath, [script], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  const take = (chunk) => {
    logs += chunk.toString();
    if (logs.length > 30000) logs = logs.slice(-30000);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  child.logs = () => logs;
  return child;
}

async function waitOk(url, child) {
  for (let i = 0; i < 90; i += 1) {
    if (child && child.exitCode != null) {
      throw new Error(`${url} process exited ${child.exitCode}\n${child.logs()}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for ${url}\n${child ? child.logs() : ""}`);
}

async function api(pathname, { method = "GET", token, body } = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function checkoutFields(html) {
  const fields = {};
  for (const match of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
    fields[match[1]] = match[2]
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  const action = html.match(/action="([^"]+)"/)?.[1] || "";
  return { action, fields };
}

function tomorrowAc4() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

async function mockPost(pathname, body) {
  const res = await fetch(`${MOCK}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const children = [];
function shutdown() {
  for (const child of children) {
    if (child.exitCode == null) child.kill("SIGTERM");
  }
}

async function main() {
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    user: env.DB_USER,
    password: env.DB_PASS,
    database: env.DB_NAME,
  });
  await conn.query("SELECT 1");
  await conn.end();

  // Migrations ALTER Users before sequelize.sync() creates it. On an empty database,
  // create the model tables first so the existing migration can alter them.
  const { sequelize } = await import("../src/config/db.js");
  await import("../src/models/index.js");
  await sequelize.sync();

  const appProc = spawnNode("app.js");
  const mockProc = spawnNode("src/mock/jpaymentMockServer.js");
  children.push(appProc, mockProc);
  await waitOk(`${APP}/health`, appProc);
  await waitOk(`${MOCK}/health`, mockProc);

  const email = `mock-${Date.now()}@example.com`;
  const password = "mock-pass-123";
  const registered = await api("/api/users/register", {
    method: "POST",
    body: { name: "Mock User", email, password },
  });
  assert(registered.status === 201, `register ${registered.status} ${registered.text}`);
  const logged = await api("/api/users/login", { method: "POST", body: { email, password } });
  assert(logged.status === 200 && logged.json?.token, `login ${logged.status} ${logged.text}`);
  const token = logged.json.token;
  const userId = logged.json.user.id;

  const ac4 = tomorrowAc4();
  const trial = await api("/api/payment/checkout/init", {
    method: "POST",
    token,
    body: { planType: "trial", accountType: "personal", ac4 },
  });
  assert(trial.status === 201, `trial init ${trial.status} ${trial.text}`);
  const trialPage = await fetch(trial.json.checkoutUrl);
  const trialHtml = await trialPage.text();
  const trialForm = checkoutFields(trialHtml);
  assert(trialForm.action.startsWith(`${MOCK}/link/creditcard`), `trial action ${trialForm.action}`);
  assert(trialForm.fields.ac4 === ac4.replaceAll("/", "/"), `ac4 field ${trialForm.fields.ac4}`);
  const trialPosted = await fetch(trialForm.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(trialForm.fields),
  });
  const trialMockHtml = await trialPosted.text();
  assert(trialMockHtml.includes(ac4), "mock checkout page did not show ac4");

  const init = await api("/api/payment/checkout/init", {
    method: "POST",
    token,
    body: { planType: "monthly", accountType: "personal" },
  });
  assert(init.status === 201, `init ${init.status} ${init.text}`);
  const page = await fetch(init.json.checkoutUrl);
  const form = checkoutFields(await page.text());
  assert(form.action === `${MOCK}/link/creditcard`, `checkout action ${form.action}`);
  assert(form.fields.am === "1320", `am ${form.fields.am}`);
  assert(form.fields.actp === "4", `actp ${form.fields.actp}`);
  assert(form.fields.acam === "1320", `acam ${form.fields.acam}`);
  const { jpaymentAc1Code } = await import("../src/utils/subscriptionRenewalPeriod.js");
  const expectedAc1 = jpaymentAc1Code(init.json.order.periodStartAt, "monthly");
  assert(form.fields.ac1 === expectedAc1, `ac1 ${form.fields.ac1} expected ${expectedAc1}`);
  assert(!trialForm.fields.ac1, "trial checkout must not send ac1");
  assert(form.fields.cod.startsWith("ORD_"), `cod ${form.fields.cod}`);
  assert(form.fields.uid.length > 8, "missing uid");
  const posted = await fetch(form.action, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form.fields),
  });
  assert((await posted.text()).includes(form.fields.cod), "mock page missing cod");

  const paid = await mockPost("/mock/settle", {
    cod: form.fields.cod,
    rst: "1",
    mode: "callback-and-return",
  });
  assert(paid.status === 200 && paid.json?.ok, `settle ${paid.status} ${paid.text}`);
  assert(paid.json.callback.status === 200, `callback ${paid.json.callback.status} ${paid.json.callback.body}`);
  assert(!paid.json.returnUrl.includes(SECRET), "return URL contains the notify secret");
  const orderAfterCallback = await api(`/api/payment/order/${encodeURIComponent(form.fields.cod)}`, { token });
  assert(orderAfterCallback.json.status === "paid", `status after callback ${orderAfterCallback.json?.status}`);
  assert(orderAfterCallback.json.autoRenew === true, "autoRenew should be on after checkout");
  assert(orderAfterCallback.json.recurringToken, "missing acid");
  const returned = await fetch(paid.json.returnUrl, { redirect: "manual" });
  assert(returned.status === 302, `return status ${returned.status}`);
  assert(String(returned.headers.get("location")).includes("/mock/frontend-return?r="), "frontend redirect missing result token");
  const stillPaid = await api(`/api/payment/order/${encodeURIComponent(form.fields.cod)}`, { token });
  assert(stillPaid.json.status === "paid", "browser return changed the paid order");

  const forgedInit = await api("/api/payment/checkout/init", {
    method: "POST",
    token,
    body: { planType: "monthly", accountType: "personal" },
  });
  assert(forgedInit.status === 201, `forged init ${forgedInit.status} ${forgedInit.text}`);
  const forgedForm = checkoutFields(await (await fetch(forgedInit.json.checkoutUrl)).text());
  const forged = await fetch(
    `${APP}/api/payment/return?uid=${encodeURIComponent(forgedForm.fields.uid)}&gid=1&rst=1&am=1320&cod=${encodeURIComponent(forgedForm.fields.cod)}`,
    { redirect: "manual" }
  );
  assert(forged.status === 302, `forged return ${forged.status}`);
  const forgedOrder = await api(`/api/payment/order/${encodeURIComponent(forgedForm.fields.cod)}`, { token });
  assert(forgedOrder.json.status === "pending", `forged return marked order ${forgedOrder.json.status}`);

  const acid = stillPaid.json.recurringToken;
  const retry = await mockPost("/mock/auto-renew", { acid, rst: "3" });
  assert(retry.status === 200 && retry.json?.callback?.status === 200, `rst=3 ${retry.status} ${retry.text}`);
  const afterRetry = await api(`/api/payment/order/${encodeURIComponent(form.fields.cod)}`, { token });
  assert(afterRetry.json.status === "paid", `rst=3 status ${afterRetry.json.status}`);
  assert(afterRetry.json.autoRenew === true, "rst=3 disabled autoRenew");
  assert(String(afterRetry.json.renewFailureCode || "").length > 0, "rst=3 did not record a failure code");
  const listAfterRetry = await api("/api/payment/orders", { token });
  const paidAfterRetry = listAfterRetry.json.orders.filter((row) => row.status === "paid");
  assert(paidAfterRetry.length === 1, `expected 1 paid order after rst=3, got ${paidAfterRetry.length}`);

  const success = await mockPost("/mock/auto-renew", { acid, rst: "1" });
  assert(success.status === 200 && success.json?.callback?.status === 200, `rst=1 ${success.status} ${success.text}`);
  const listAfterRenew = await api("/api/payment/orders", { token });
  const paidRows = listAfterRenew.json.orders.filter((row) => row.status === "paid");
  const expiredRows = listAfterRenew.json.orders.filter((row) => row.status === "expired");
  assert(paidRows.length === 1, `expected 1 paid after renew, got ${paidRows.length}`);
  assert(expiredRows.some((row) => row.cod === form.fields.cod), "original order was not expired");
  assert(
    new Date(paidRows[0].periodEndAt).getTime() > new Date(expiredRows.find((row) => row.cod === form.fields.cod).periodEndAt).getTime(),
    "renewed period did not move forward"
  );

  const card = await api("/api/subscription/change-card/init", { method: "POST", token, body: {} });
  assert(card.status === 200, `change-card ${card.status} ${card.text}`);
  assert(
    String(card.json.changeCardUrl).startsWith(`${MOCK}/link/creditcard/auto-charge/update`),
    `changeCardUrl ${card.json?.changeCardUrl}`
  );
  const cardPost = await fetch(card.json.changeCardUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ aid: "100001", acid, card_last4: "4242" }),
  });
  assert(cardPost.status === 200, `card post ${cardPost.status}`);
  const state = await (await fetch(`${MOCK}/mock/state`)).json();
  assert(state.charges.find((row) => row.acid === acid)?.cardLast4 === "4242", "card last4 was not stored");

  const controlsFail = await mockPost("/mock/controls", { nextStop: "er003", nextCancel: "ok" });
  assert(controlsFail.status === 200, `controls ${controlsFail.status}`);
  const stopFail = await api("/api/subscription/auto-renew", {
    method: "PATCH",
    token,
    body: { autoRenew: false },
  });
  assert(stopFail.status === 502, `stop fail status ${stopFail.status} ${stopFail.text}`);
  const subStillOn = await api("/api/subscription/me", { token });
  assert(subStillOn.json.autoRenew === true, "failed stop cleared autoRenew");
  const activeCod = paidRows[0].cod;
  const activeOrder = await api(`/api/payment/order/${encodeURIComponent(activeCod)}`, { token });
  assert(activeOrder.json.renewFailureCode === "STOP_API_FAILED", `failure code ${activeOrder.json.renewFailureCode}`);
  assert(activeOrder.json.stopRequested === false, "stop was marked requested after ER003");
  const notStopped = await (await fetch(`${MOCK}/mock/state`)).json();
  assert(notStopped.charges.find((row) => row.acid === acid)?.stopped === false, "ER003 still marked the acid stopped");

  const { PaymentOrder } = await import("../src/models/paymentOrder.model.js");
  const { jstDateOnlyString } = await import("../src/utils/autoChargeStop.js");
  const { runAutoChargeStopRetryBatch } = await import("../src/jobs/autoChargeStopRetry.worker.js");
  await PaymentOrder.update(
    { renewNextRetryAt: jstDateOnlyString() },
    { where: { id: activeOrder.json.id } }
  );
  await mockPost("/mock/controls", { nextStop: "ok" });
  const batch = await runAutoChargeStopRetryBatch();
  assert(batch.stopped === 1, `retry batch ${JSON.stringify(batch)}`);
  const afterWorker = await api(`/api/payment/order/${encodeURIComponent(activeCod)}`, { token });
  assert(afterWorker.json.autoRenew === false, "worker left autoRenew on");
  assert(afterWorker.json.stopRequested === true, "worker did not mark stopRequested");
  const stopped = await (await fetch(`${MOCK}/mock/state`)).json();
  assert(stopped.charges.find((row) => row.acid === acid)?.stopped === true, "worker did not stop the acid");

  const admin = await api("/api/users/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  assert(admin.status === 200 && admin.json?.token, `admin login ${admin.status} ${admin.text}`);
  const refund = await api(
    `/api/user/users/${userId}/payment-orders/${activeOrder.json.id}/gateway-refund`,
    { method: "POST", token: admin.json.token, body: {} }
  );
  assert(refund.status === 200, `refund ${refund.status} ${refund.text}`);
  const refunded = await api(`/api/payment/order/${encodeURIComponent(activeCod)}`, { token });
  assert(refunded.json.status === "cancelled", `refund status ${refunded.json.status}`);

  await sequelize.close();
  console.log("jpayment mock exercise ok");
  console.log(
    JSON.stringify(
      {
        checkoutCallbackPaid: true,
        browserReturnDidNotPay: true,
        retryThenSuccessExtended: true,
        cardChangeUrl: card.json.changeCardUrl,
        stopFailureKeptAutoRenew: true,
        stopRetryWorkerStoppedGateway: true,
        refundCancelled: true,
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error(err);
    for (const child of children) {
      if (child.logs) console.error(child.logs());
    }
    process.exitCode = 1;
  })
  .finally(() => {
    shutdown();
  });
