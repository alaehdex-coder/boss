// POST /api/signup — early-access signups from the landing page.
//
// Storage and notification are both optional and switched on by env vars:
//   Upstash Redis (Vercel Marketplace): KV_REST_API_URL + KV_REST_API_TOKEN
//                                   or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   Email via Resend:                   RESEND_API_KEY + SIGNUP_NOTIFY_TO (+ SIGNUP_NOTIFY_FROM)
// Every signup is also written to the function log.

const BUSINESS_TYPES = ["Retail or shop", "Food and drink", "Services", "Online business", "Other"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const redisUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const body = typeof req.body === "string" ? safeParse(req.body) : req.body || {};

  // Honeypot: bots fill the hidden field. Pretend success so they move on.
  if (body.company_site) return res.status(200).json({ ok: true });

  const name = String(body.name || "").trim().slice(0, 100);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
  const business = BUSINESS_TYPES.includes(body.business) ? body.business : "Other";

  if (!name) return res.status(400).json({ error: "Enter your name so we know who to reply to." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid work email to get early access." });

  const signup = { name, email, business, at: new Date().toISOString() };
  console.log("signup", JSON.stringify(signup));

  try {
    const isNew = await store(signup);
    if (isNew) await notify(signup);
  } catch (err) {
    console.error("signup failed", err);
    return res.status(502).json({ error: "We couldn’t save your signup. Please try again in a moment." });
  }

  return res.status(200).json({ ok: true });
}

// Returns true when the email was not already on the list.
async function store(signup) {
  if (!redisUrl || !redisToken) return true;
  const r = await fetch(`${redisUrl}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${redisToken}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["HSETNX", "boss:signups", signup.email, JSON.stringify(signup)],
    ]),
  });
  if (!r.ok) throw new Error(`Redis responded ${r.status}`);
  const [result] = await r.json();
  if (result.error) throw new Error(`Redis: ${result.error}`);
  return result.result === 1;
}

async function notify(signup) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.SIGNUP_NOTIFY_TO;
  if (!key || !to) return;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.SIGNUP_NOTIFY_FROM || "BOSS <onboarding@resend.dev>",
      to: to.split(",").map((s) => s.trim()),
      reply_to: signup.email,
      subject: `New BOSS early-access signup: ${signup.name}`,
      text: `Name: ${signup.name}\nEmail: ${signup.email}\nBusiness: ${signup.business}\nAt: ${signup.at}`,
    }),
  });
  // The signup is already stored, so a failed email is logged rather than shown to the visitor.
  if (!r.ok) console.error("notify failed", r.status, await r.text());
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
