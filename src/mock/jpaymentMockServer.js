import { createJPaymentMockApp } from "./jpaymentMock.js";

if (String(process.env.NODE_ENV || "").trim().toLowerCase() === "production") {
  console.error("Refusing to start the J-Payment mock when NODE_ENV=production.");
  process.exit(1);
}

const port = Number(process.env.JPAYMENT_MOCK_PORT || 5099);
const { app, config } = createJPaymentMockApp();
const { appBase, secret } = config();

app.listen(port, "127.0.0.1", () => {
  console.log(`J-Payment mock on http://127.0.0.1:${port}`);
  console.log(`Callbacks go to ${appBase}/api/payment/callback/<secret>`);
  console.log(secret ? "Notify secret is set." : "WARNING: JPAYMENT_CALLBACK_QUERY_SECRET is empty; settle will fail.");
});
