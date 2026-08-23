// Demo authentication.
//
// Scope is deliberate: this gates the dashboard behind a login so judges see a
// real product shell, without pretending to be production identity. Passwords
// are salted+hashed (never stored or compared in plaintext), sessions are
// signed HMAC cookies with an expiry, and comparisons are constant-time.
//
// What this is NOT: a user store, password reset, rate-limited brute-force
// protection, or anything you should copy into a real system.

import crypto from "node:crypto";

const SESSION_TTL = 12 * 60 * 60 * 1000;

// A stable secret keeps sessions valid across restarts; a random one is fine
// for a demo, it just means everyone is logged out on redeploy.
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString("hex");
}

function makeUser({ username, password, name, role }) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { username, name, role, salt, hash: hash(password, salt) };
}

// Seeded demo accounts. The password is intentionally published in the UI —
// this is a public demo, and pretending otherwise would just lock judges out.
export const DEMO_CREDENTIALS = { username: "operator", password: "portsense" };

const users = new Map(
  [
    makeUser({ username: "operator", password: "portsense", name: "Duty Operator", role: "operator" }),
    makeUser({ username: "supervisor", password: "portsense", name: "Terminal Supervisor", role: "supervisor" }),
  ].map((u) => [u.username, u])
);

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function verifyCredentials(username, password) {
  const user = users.get(String(username || "").toLowerCase().trim());
  if (!user) return null;
  if (!timingSafeEqual(hash(String(password || ""), user.salt), user.hash)) return null;
  return { username: user.username, name: user.name, role: user.role };
}

// --- signed session cookie -------------------------------------------------

function sign(payload) {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}

export function createSession(user) {
  const body = Buffer.from(
    JSON.stringify({ u: user.username, n: user.name, r: user.role, exp: Date.now() + SESSION_TTL })
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function readSession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  // Verify before parsing — never trust the payload of an unsigned token.
  if (!timingSafeEqual(sign(body), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return { username: data.u, name: data.n, role: data.r };
  } catch {
    return null;
  }
}

export const COOKIE = "portsense_session";

export function cookieHeader(token, { clear = false } = {}) {
  const parts = [
    `${COOKIE}=${clear ? "" : token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    clear ? "Max-Age=0" : `Max-Age=${Math.floor(SESSION_TTL / 1000)}`,
  ];
  // Render terminates TLS, so mark Secure in production only — otherwise the
  // cookie would be dropped over plain http on localhost.
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
    })
  );
}

export function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return readSession(cookies[COOKIE]);
}

// Express middleware: API routes get 401 JSON, page routes get redirected.
export function requireAuth({ api = false } = {}) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (user) {
      req.user = user;
      return next();
    }
    if (api) return res.status(401).json({ error: "authentication required" });
    return res.redirect("/login");
  };
}
