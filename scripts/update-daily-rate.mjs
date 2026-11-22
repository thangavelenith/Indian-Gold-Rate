// scripts/update-daily-rate.mjs
// Zero-dependency Node 20+ script for GitHub Actions.
// Fetches India's fixed daily retail gold rate with resilient text-regex parsing,
// multi-source fallback (MJDTA -> IBJA -> Morning Spot Lock), sanity guardrails,
// and authenticated Google OAuth2 write to Firebase Realtime Database (/dailyRate.json).

import crypto from 'node:crypto';

const TROY_OZ_GRAMS = 31.1034768;
const DEFAULT_IMPORT_DUTY_PCT = 15.0;
const FIREBASE_DB_URL = (
  process.env.FIREBASE_DB_URL ||
  'https://indian-gold-rate-default-rtdb.asia-southeast1.firebasedatabase.app'
).trim().replace(/\/+$/, '');

function nowIstLabel() {
  return (
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date()) + ' IST'
  );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        ...(options.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res;
  } finally {
    clearTimeout(id);
  }
}

function htmlToPlainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIndianNumber(raw) {
  if (!raw) return NaN;
  const cleaned = String(raw).replace(/,/g, '').trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

// ==================== LIVE SPOT REFERENCE (FOR SANITY CHECK & FALLBACK) ====================
async function fetchLiveSpotReference() {
  let xauUsd = null;
  let usdInr = null;

  try {
    const res = await fetchWithTimeout('https://api.gold-api.com/price/XAU');
    const data = await res.json();
    if (Number.isFinite(Number(data?.price)) && Number(data.price) > 500) {
      xauUsd = Number(data.price);
    }
  } catch (err) {
    console.warn('gold-api.com failed:', err.message);
  }

  if (xauUsd === null) {
    try {
      const res = await fetchWithTimeout(
        'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json'
      );
      const data = await res.json();
      const p = Number(data?.xau?.usd);
      if (Number.isFinite(p) && p > 500) xauUsd = p;
    } catch (err) {
      console.warn('currency-api CDN failed:', err.message);
    }
  }

  try {
    const res = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD');
    const data = await res.json();
    const r = Number(data?.rates?.INR);
    if (Number.isFinite(r) && r > 20) usdInr = r;
  } catch (err) {
    console.warn('open.er-api.com failed:', err.message);
  }

  if (usdInr === null) {
    try {
      const res = await fetchWithTimeout(
        'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR'
      );
      const data = await res.json();
      const r = Number(data?.rates?.INR);
      if (Number.isFinite(r) && r > 20) usdInr = r;
    } catch (err) {
      console.warn('frankfurter.dev failed:', err.message);
    }
  }

  if (xauUsd && usdInr) {
    const base24k = (xauUsd * usdInr) / TROY_OZ_GRAMS;
    const landed24k = base24k * (1 + DEFAULT_IMPORT_DUTY_PCT / 100);
    const landed22k = landed24k * (22 / 24);
    return {
      rate22k: Number(landed22k.toFixed(2)),
      rate24k: Number(landed24k.toFixed(2)),
    };
  }
  return null;
}

// ==================== SOURCE 1: MJDTA (CHENNAI / TAMIL NADU RETAIL) ====================
async function fetchMjdtaRate() {
  const res = await fetchWithTimeout('https://thejewellersassociation.org/');
  const html = await res.text();
  const text = htmlToPlainText(html);

  // Match label semantically (resilient to HTML/CSS table redesigns)
  // Example visible text: "1 Gm Gold 22Kt 11465.00 (-45)"
  const match22 = text.match(
    /1\s*Gm\s*Gold\s*22\s*Kt[^0-9]{0,25}([\d,]{4,8}(?:\.\d{1,2})?)/i
  );
  if (!match22) {
    throw new Error('Could not find 22Kt 1g rate in MJDTA text');
  }

  const rate22k = parseIndianNumber(match22[1]);
  if (!Number.isFinite(rate22k) || rate22k < 1000) {
    throw new Error(`Invalid MJDTA 22K rate parsed: ${match22[1]}`);
  }

  const rate24k = Number((rate22k * (24 / 22)).toFixed(2));
  const timeMatch = text.match(/Update\s*Time\s*:\s*([0-9/\-]+\s+(?:Morning|Afternoon|Evening)?\s*[0-9:]+\s*(?:AM|PM)?)/i);
  const updatedAt = timeMatch ? `${timeMatch[1].trim()} IST` : nowIstLabel();

  return {
    rate22k,
    rate24k,
    source: 'MJDTA (Chennai / TN Retail)',
    updatedAt,
  };
}

// ==================== SOURCE 2: IBJA (INDIA NATIONAL BENCHMARK) ====================
async function fetchIbjaRate() {
  const res = await fetchWithTimeout('https://ibjarates.com/');
  const html = await res.text();
  const text = htmlToPlainText(html);

  // Pattern A: 1-gram ticker text ("999 Purity 12953 (1 Gram) ... 916 Purity 11865 (1 Gram)")
  const m999Gram = text.match(/999\s*Purity[^0-9]{0,20}([\d,]{4,7}(?:\.\d{1,2})?)\s*\(\s*1\s*Gram/i);
  const m916Gram = text.match(/916\s*Purity[^0-9]{0,20}([\d,]{4,7}(?:\.\d{1,2})?)\s*\(\s*1\s*Gram/i);

  if (m999Gram && m916Gram) {
    const rate24k = parseIndianNumber(m999Gram[1]);
    const rate22k = parseIndianNumber(m916Gram[1]);
    if (rate22k > 1000 && rate24k > rate22k) {
      return {
        rate22k,
        rate24k,
        source: 'IBJA (India Benchmark)',
        updatedAt: nowIstLabel(),
      };
    }
  }

  // Pattern B: 10-gram AM/PM table ("Gold 999 129985 129531 ... Gold 916 119066 118650")
  const m999Ten = text.match(/Gold\s*999[^0-9]{0,20}([\d,]{5,8})(?:[^0-9]{1,15}([\d,]{5,8}))?/i);
  const m916Ten = text.match(/Gold\s*916[^0-9]{0,20}([\d,]{5,8})(?:[^0-9]{1,15}([\d,]{5,8}))?/i);

  if (m999Ten && m916Ten) {
    // Prefer PM value (group 2) if published, else AM value (group 1)
    const raw24 = parseIndianNumber(m999Ten[2] || m999Ten[1]);
    const raw22 = parseIndianNumber(m916Ten[2] || m916Ten[1]);
    const rate24k = Number((raw24 / 10).toFixed(2));
    const rate22k = Number((raw22 / 10).toFixed(2));
    if (rate22k > 1000 && rate24k > rate22k) {
      return {
        rate22k,
        rate24k,
        source: 'IBJA (India Benchmark)',
        updatedAt: nowIstLabel(),
      };
    }
  }

  throw new Error('Could not parse IBJA 999/916 rates');
}

// ==================== SANITY-CHECK GUARDRAILS ====================
function isSaneRate(candidate, spotRef) {
  if (!candidate) return false;
  const { rate22k, rate24k } = candidate;
  if (!Number.isFinite(rate22k) || !Number.isFinite(rate24k)) return false;
  if (rate22k <= 1000 || rate24k <= rate22k) return false;

  if (spotRef && spotRef.rate22k > 1000) {
    const deviation = Math.abs(rate22k - spotRef.rate22k) / spotRef.rate22k;
    if (deviation > 0.18) {
      console.warn(
        `Sanity check failed for ${candidate.source}: parsed 22K ₹${rate22k} deviates ${(
          deviation * 100
        ).toFixed(1)}% from live spot ref ₹${spotRef.rate22k}`
      );
      return false;
    }
  }
  return true;
}

// ==================== GOOGLE OAUTH2 ACCESS TOKEN (ZERO DEPENDENCIES) ====================
function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getFirebaseAccessToken(serviceAccount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: serviceAccount.client_email,
    scope:
      'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const unsignedJwt = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload)
  )}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = signer
    .sign(serviceAccount.private_key, 'base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const assertion = `${unsignedJwt}.${signature}`;

  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  const tokenData = await res.json();
  if (!tokenData.access_token) {
    throw new Error('OAuth2 token exchange did not return an access_token');
  }
  return tokenData.access_token;
}

// ==================== MAIN EXECUTION ====================
async function main() {
  const rawSa = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawSa) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT repository secret.');
  }

  const serviceAccount = JSON.parse(rawSa);
  const spotRef = await fetchLiveSpotReference();
  console.log('Live spot reference (22K/24K):', spotRef);

  let selected = null;

  // 1. Try MJDTA (Chennai / TN Retail)
  try {
    const mjdta = await fetchMjdtaRate();
    if (isSaneRate(mjdta, spotRef)) {
      selected = mjdta;
      console.log('Selected MJDTA rate:', selected);
    }
  } catch (err) {
    console.warn('MJDTA fetch/parse failed:', err.message);
  }

  // 2. Fallback to IBJA
  if (!selected) {
    try {
      const ibja = await fetchIbjaRate();
      if (isSaneRate(ibja, spotRef)) {
        selected = ibja;
        console.log('Selected IBJA fallback rate:', selected);
      }
    } catch (err) {
      console.warn('IBJA fetch/parse failed:', err.message);
    }
  }

  // 3. Final Fallback: Session Spot Lock (never fails as long as spot APIs work)
  if (!selected && spotRef) {
    selected = {
      rate22k: spotRef.rate22k,
      rate24k: spotRef.rate24k,
      source: 'Session Spot Lock (Auto)',
      updatedAt: nowIstLabel(),
    };
    console.log('Using Session Spot Lock fallback:', selected);
  }

  if (!selected) {
    throw new Error('All gold rate sources failed — skipping Firebase write to protect existing data.');
  }

  const accessToken = await getFirebaseAccessToken(serviceAccount);
  const targetUrl = `${FIREBASE_DB_URL}/dailyRate.json`;

  const putRes = await fetchWithTimeout(targetUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(selected),
  });

  const saved = await putRes.json();
  console.log('Successfully updated Firebase RTDB /dailyRate.json:', saved);
}

main().catch((err) => {
  console.error('Update failed:', err);
  process.exit(1);
});
      
