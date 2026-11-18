# test-server

Express + Sequelize API for the AEROLOG flight-report backend (test copy). Payments go through J-Payment / Robot Payment (link checkout, server callback, acsgate stop).

## Local J-Payment mock

The mock is a separate process. It is not started by `npm start`, and the API keeps calling `https://credit.j-payment.co.jp` unless you opt in. `NODE_ENV=production` refuses to boot if `JPAYMENT_MOCK` or `JPAYMENT_BASE_URL` is set, and the mock process refuses to start in production.

```bash
# terminal 1 — API (development only)
NODE_ENV=development \
JPAYMENT_MOCK=true \
JPAYMENT_MOCK_BASE_URL=http://127.0.0.1:5099 \
JPAYMENT_AID=100001 \
JPAYMENT_CALLBACK_QUERY_SECRET=your-long-random-secret \
PAYMENT_FRONTEND_RETURN_URL=http://127.0.0.1:5099/mock/frontend-return \
npm start

# terminal 2 — mock
JPAYMENT_MOCK_APP_BASE=http://127.0.0.1:5000 \
JPAYMENT_CALLBACK_QUERY_SECRET=your-long-random-secret \
npm run jpayment:mock
```

`JPAYMENT_MOCK_BASE_URL` on the API does nothing by itself. You can instead set `JPAYMENT_BASE_URL=http://127.0.0.1:5099` (non-production only) without the flag.

Open `http://127.0.0.1:5099` for auto-charge buttons and the acsgate / refund failure switches.

| What you want to try | What to do |
| --- | --- |
| Checkout form (`am`, `actp`, `acam`, `ac4`, `cod`, `uid`, …) | Init a card checkout in the API and open its `checkoutUrl`. The auto-post lands on the mock page and lists those fields. |
| Success: server callback, then browser return | **Pay success (rst=1)**. The mock GETs `/api/payment/callback/<secret>?gid&rst&acid&cod&am&uid…`, then redirects the browser to `/api/payment/return` with the same payment fields and **no secret**. The return must not be what marks the order paid. |
| Forged paid return | **Browser return only**. No kickback is sent. The order stays pending. |
| Initial failure | **Pay fail (rst=2)**. |
| Auto-renew rst=1 / 2 / 3 / 4 | On the mock home page, next to the `acid`: **rst=1 success**, **rst=3 retry**, **rst=2 final fail**, **rst=4 user stop**. These are server callbacks only (new `gid`, same `acid` and original `cod`). |
| Retry, then a successful charge | **rst=3 then rst=1**. Renewal stays on after rst=3, and rst=1 extends the period. |
| Stop auto-charge | The API calls `POST /gateway/acsgate.aspx` (`aid`, `acid`, `cmd=1`). Default body is `OK`. On the home page set **acsgate** to `er003`, `er051`, `er024`, `empty`, `unexpected` (`USER ORDER SERVER`), or `timeout` (holds the socket; pair with `stop delay ms`). A second stop of an already-stopped acid returns `ER024`. |
| Refund / cancel | Set **gateway.aspx** to `ok` (`gid,1,…` comma body), `er033`, or `empty`. The API uses this for admin refund (`jb=CANCEL`). |
| Card change | `POST /api/subscription/change-card/init` returns a mock URL (`/link/creditcard/auto-charge/update?aid=`). Submit `acid` and a mock last4. Nothing is sent back to the API; this server does not handle a card-change kickback. |

`npm test` covers the mock contract (callback secret, return URL, rst=3 then rst=1, acsgate bodies, cancel body, card change) and the production guard.

`npm run jpayment:exercise` runs the API and the mock against a local MySQL/MariaDB (`DB_*` or the defaults in the script) and walks checkout, forged return, retry-then-success, card change, a failed stop, the stop-retry worker, and refund. It is not part of `npm test`.
