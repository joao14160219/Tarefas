const crypto = require("crypto");

const SESSION_COOKIE = "jofa_session";
const SESSION_DURATION_SECONDS = 60 * 60 * 24 * 7;

const USERS = {
  joao: { key: "joao", name: "João Pedro", passwordEnv: "LOGIN_JOAO_PASSWORD" },
  rafael: { key: "rafael", name: "Rafael Palma", passwordEnv: "LOGIN_RAFAEL_PASSWORD" },
};

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie || "";
  return cookieHeader.split(";").reduce((acc, part) => {
    const trimmed = part.trim();
    if (!trimmed) return acc;
    const separator = trimmed.indexOf("=");
    const key = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
    const value = separator >= 0 ? trimmed.slice(separator + 1) : "";
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function createSessionValue(payload) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    const error = new Error("Missing SESSION_SECRET in Vercel environment variables");
    error.status = 500;
    throw error;
  }

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", sessionSecret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function readSession(req) {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) {
    const error = new Error("Missing SESSION_SECRET in Vercel environment variables");
    error.status = 500;
    throw error;
  }

  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (!raw) return null;

  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", sessionSecret)
    .update(encodedPayload)
    .digest("base64url");

  if (signature.length !== expectedSignature.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload?.key || !payload?.name) return null;
    return payload;
  } catch {
    return null;
  }
}

function setSessionCookie(res, value) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DURATION_SECONDS}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      const session = readSession(req);
      if (!session) {
        return json(res, 401, { error: "Not authenticated" });
      }
      return json(res, 200, { user: session });
    }

    if (req.method === "POST") {
      const body = await parseBody(req);
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const user = USERS[username];

      if (!user) {
        return json(res, 401, { error: "Usuario invalido" });
      }

      const expectedPassword = process.env[user.passwordEnv];
      if (!expectedPassword) {
        return json(res, 500, { error: `Missing ${user.passwordEnv} in Vercel environment variables` });
      }

      if (password !== expectedPassword) {
        return json(res, 401, { error: "Senha incorreta" });
      }

      const payload = { key: user.key, name: user.name };
      const sessionValue = createSessionValue(payload);
      setSessionCookie(res, sessionValue);
      return json(res, 200, { user: payload });
    }

    if (req.method === "DELETE") {
      clearSessionCookie(res);
      return json(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return json(res, error.status || 500, {
      error: error.message || "Unexpected auth API error",
    });
  }
};
