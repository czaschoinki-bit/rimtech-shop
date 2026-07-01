const crypto = require("crypto");

const P24_SANDBOX_URL = "https://sandbox.przelewy24.pl";
const P24_PRODUCTION_URL = "https://secure.przelewy24.pl";

function jsonResponse(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  };
}

function createSign(params) {
  return crypto
    .createHash("sha384")
    .update(JSON.stringify(params))
    .digest("hex");
}

function getP24BaseUrl() {
  return process.env.P24_MODE === "production"
    ? P24_PRODUCTION_URL
    : P24_SANDBOX_URL;
}

function isNotificationSignValid(notification, crc) {
  const sign = createSign({
    merchantId: Number(notification.merchantId),
    posId: Number(notification.posId),
    sessionId: String(notification.sessionId),
    amount: Number(notification.amount),
    originAmount: Number(notification.originAmount),
    currency: String(notification.currency),
    orderId: Number(notification.orderId),
    methodId: Number(notification.methodId),
    statement: String(notification.statement),
    crc
  });

  return sign === notification.sign;
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      error: "Method not allowed"
    });
  }

  const merchantId = Number(process.env.P24_MERCHANT_ID);
  const posId = Number(process.env.P24_POS_ID || process.env.P24_MERCHANT_ID);
  const apiKey = process.env.P24_API_KEY;
  const crc = process.env.P24_CRC;

  if (!merchantId || !posId || !apiKey || !crc) {
    return jsonResponse(500, {
      error: "Brakuje konfiguracji Przelewy24 w zmiennych środowiskowych Netlify."
    });
  }

  try {
    const notification = JSON.parse(event.body || "{}");

    if (!isNotificationSignValid(notification, crc)) {
      return jsonResponse(400, {
        error: "Nieprawidłowy podpis powiadomienia Przelewy24."
      });
    }

    const amount = Number(notification.amount);
    const currency = String(notification.currency || "PLN");
    const sessionId = String(notification.sessionId);
    const orderId = Number(notification.orderId);

    const verifySign = createSign({
      sessionId,
      orderId,
      amount,
      currency,
      crc
    });

    const payload = {
      merchantId,
      posId,
      sessionId,
      amount,
      currency,
      orderId,
      sign: verifySign
    };

    const auth = Buffer.from(`${posId}:${apiKey}`).toString("base64");
    const p24BaseUrl = getP24BaseUrl();

    const p24Response = await fetch(`${p24BaseUrl}/api/v1/transaction/verify`, {
      method: "PUT",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const p24Text = await p24Response.text();
    let p24Data;

    try {
      p24Data = JSON.parse(p24Text);
    } catch (error) {
      p24Data = {
        raw: p24Text
      };
    }

    if (!p24Response.ok) {
      return jsonResponse(502, {
        error: "Nie udało się zweryfikować płatności w Przelewy24.",
        details: p24Data
      });
    }

    return jsonResponse(200, {
      status: "verified",
      sessionId,
      orderId,
      details: p24Data
    });
  } catch (error) {
    return jsonResponse(400, {
      error: error.message || "Nie udało się obsłużyć statusu płatności."
    });
  }
};
