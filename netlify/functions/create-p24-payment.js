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

function getSiteUrl(event) {
  const configuredUrl = process.env.SITE_URL || process.env.URL;
  const origin = event.headers.origin || event.headers.Origin;

  return String(configuredUrl || origin || "https://rimtech-shop.netlify.app").replace(/\/$/, "");
}

function getP24BaseUrl() {
  return process.env.P24_MODE === "production"
    ? P24_PRODUCTION_URL
    : P24_SANDBOX_URL;
}

function normalizePhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");

  if (digits.length === 9) {
    return `48${digits}`;
  }

  return digits.slice(0, 12);
}

async function loadCatalog(siteUrl) {
  const response = await fetch(`${siteUrl}/data/products.json`);

  if (!response.ok) {
    throw new Error("Nie udało się pobrać katalogu produktów.");
  }

  const data = await response.json();
  return Array.isArray(data.products) ? data.products : [];
}

function buildVerifiedItems(cartItems, catalogProducts) {
  if (!Array.isArray(cartItems) || !cartItems.length) {
    throw new Error("Koszyk jest pusty.");
  }

  return cartItems.map(item => {
    const product = catalogProducts.find(productItem => {
      return productItem.slug === item.slug && productItem.active;
    });

    if (!product) {
      throw new Error(`Produkt ${item.slug || ""} nie istnieje albo jest nieaktywny.`);
    }

    const quantity = Math.max(1, Math.min(20, Number(item.quantity || 1)));
    const price = Number(product.price || 0);

    if (!price || price < 0) {
      throw new Error(`Produkt ${product.title} ma nieprawidłową cenę.`);
    }

    return {
      slug: product.slug,
      title: product.title,
      quantity,
      price,
      amount: Math.round(price * 100)
    };
  });
}

function validateCustomer(customer) {
  const requiredFields = ["firstName", "lastName", "email", "phone", "address", "postalCode", "city"];

  for (const field of requiredFields) {
    if (!customer || !String(customer[field] || "").trim()) {
      throw new Error("Uzupełnij wszystkie wymagane dane do zamówienia.");
    }
  }

  if (!String(customer.email).includes("@")) {
    throw new Error("Podaj poprawny adres e-mail.");
  }
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
    const body = JSON.parse(event.body || "{}");
    const customer = body.customer || {};
    const cartItems = body.items || [];

    validateCustomer(customer);

    const siteUrl = getSiteUrl(event);
    const catalogProducts = await loadCatalog(siteUrl);
    const verifiedItems = buildVerifiedItems(cartItems, catalogProducts);

    const amount = verifiedItems.reduce((sum, item) => {
      return sum + item.amount * item.quantity;
    }, 0);

    if (!amount || amount < 100) {
      throw new Error("Kwota zamówienia jest nieprawidłowa.");
    }

    const currency = "PLN";
    const sessionId = `rtd-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    const p24BaseUrl = getP24BaseUrl();

    const sign = createSign({
      sessionId,
      merchantId,
      amount,
      currency,
      crc
    });

    const description = `Zamówienie Rimtech Dynamics ${sessionId}`;

    const payload = {
      merchantId,
      posId,
      sessionId,
      amount,
      currency,
      description,
      email: String(customer.email).trim(),
      client: `${String(customer.firstName).trim()} ${String(customer.lastName).trim()}`.slice(0, 40),
      address: String(customer.address).trim().slice(0, 80),
      zip: String(customer.postalCode).trim().slice(0, 10),
      city: String(customer.city).trim().slice(0, 50),
      country: "PL",
      phone: normalizePhone(customer.phone),
      language: "pl",
      urlReturn: `${siteUrl}/order-success.html?sessionId=${encodeURIComponent(sessionId)}`,
      urlStatus: `${siteUrl}/.netlify/functions/p24-status`,
      waitForResult: true,
      sign
    };

    const auth = Buffer.from(`${posId}:${apiKey}`).toString("base64");

    const p24Response = await fetch(`${p24BaseUrl}/api/v1/transaction/register`, {
      method: "POST",
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

    if (!p24Response.ok || !p24Data.data || !p24Data.data.token) {
      return jsonResponse(502, {
        error: "Przelewy24 nie przyjęło transakcji.",
        details: p24Data
      });
    }

    return jsonResponse(200, {
      sessionId,
      amount,
      currency,
      paymentUrl: `${p24BaseUrl}/trnRequest/${p24Data.data.token}`
    });
  } catch (error) {
    return jsonResponse(400, {
      error: error.message || "Nie udało się utworzyć płatności."
    });
  }
};
