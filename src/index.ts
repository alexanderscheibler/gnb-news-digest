import { Client } from '@neondatabase/serverless';

export interface Env {
  NEON_DB_URL: string;
  RESEND_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  FRONTEND_URL: string;
  API_URL: string;
  APP_MASTER_KEY: string; // 64-character hex string
}

interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
}

// Deterministic response helper
const jsonResponse = (data: Record<string, any>, status: number): Response => {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
};

// === CRYPTO HELPERS ===

async function hashEmail(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.toLowerCase().trim());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function encryptEmail(email: string, hexKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(email);

  // 12-byte nonce for AES-GCM
  const nonce = crypto.getRandomValues(new Uint8Array(12));

  // Parse hex key into Uint8Array safely
  const keyBytes = hexKey.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || [];
  const keyBuffer = new Uint8Array(keyBytes);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    'AES-GCM',
    false,
    ['encrypt']
  );

  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    cryptoKey,
    data
  );

  // Combine nonce + ciphertext + auth tag into one array
  const combined = new Uint8Array(nonce.length + encryptedBuffer.byteLength);
  combined.set(nonce, 0);
  combined.set(new Uint8Array(encryptedBuffer), nonce.length);

  // Convert to Base64 (browser/worker safe)
  return btoa(String.fromCharCode(...combined));
}

// === MAIN ROUTER ===

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/subscribe') {
      return await handleSubscribe(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/confirm') {
      return await handleConfirm(url.searchParams, env);
    }
    if (request.method === 'GET' && url.pathname === '/api/unsubscribe') {
      return await handleUnsubscribe(url.searchParams, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

// === HANDLERS ===

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.formData();
    const rawEmail = body.get('email')?.toString();
    const lang = body.get('language')?.toString();
    const turnstileToken = body.get('cf-turnstile-response')?.toString();

    if (!rawEmail || !lang || !turnstileToken) {
      return jsonResponse({ error: 'Missing required fields' }, 400);
    }

    // 1. Verify Turnstile
    const turnstileData = new FormData();
    turnstileData.append('secret', env.TURNSTILE_SECRET_KEY);
    turnstileData.append('response', turnstileToken);

    const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: turnstileData
    });

    // Using type assertion to avoid generic type errors in strict TS configs
    const turnstileOutcome = (await turnstileRes.json()) as TurnstileResponse;
    if (!turnstileOutcome.success) {
      return jsonResponse({ error: 'CAPTCHA verification failed' }, 403);
    }

    // 2. Prepare Cryptography
    const cleanEmail = rawEmail.toLowerCase().trim();
    const emailHash = await hashEmail(cleanEmail);
    const encryptedEmail = await encryptEmail(cleanEmail, env.APP_MASTER_KEY);

    // 3. Insert into Neon using the Serverless Driver
    const client = new Client({ connectionString: env.NEON_DB_URL });
    await client.connect();

    const result = await client.query(
      `INSERT INTO subscribers (email_hash, encrypted_email, language) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (email_hash) DO UPDATE SET language = EXCLUDED.language 
       RETURNING token, confirmed`,
      [emailHash, encryptedEmail, lang]
    );

    const subscriber = result.rows[0];
    await client.end();

    // 4. Send Double Opt-in Email via Resend
    if (!subscriber.confirmed) {
      const confirmLink = `${env.API_URL}/api/confirm?token=${subscriber.token}`;
      const emailBody = lang === 'fr'
        ? `Cliquez ici pour confirmer: ${confirmLink}`
        : `Click here to confirm: ${confirmLink}`;

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: 'onboarding@resend.dev',
          to: rawEmail, // Plaintext used here for dispatch; disappears from memory after
          subject: lang === 'fr' ? 'Confirmez votre inscription' : 'Confirm your subscription',
          html: `<p>${emailBody}</p>`
        })
      });

      // Verify errors
      // if (!emailRes.ok) {
      //   const errorText = await emailRes.text();
      //   console.error("RESEND ERROR:", errorText);
      // }
    }

    return Response.redirect(`${env.FRONTEND_URL}/check-email.html`, 302);
  } catch (error) {
    console.error(error);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}

async function handleConfirm(params: URLSearchParams, env: Env): Promise<Response> {
  const token = params.get('token');
  if (!token) return new Response('Invalid token', { status: 400 });

  const client = new Client({ connectionString: env.NEON_DB_URL });
  await client.connect();
  await client.query(`UPDATE subscribers SET confirmed = TRUE WHERE token = $1`, [token]);
  await client.end();

  return Response.redirect(`${env.FRONTEND_URL}/success.html`, 302);
}

async function handleUnsubscribe(params: URLSearchParams, env: Env): Promise<Response> {
  const token = params.get('token');
  if (!token) return new Response('Invalid token', { status: 400 });

  const client = new Client({ connectionString: env.NEON_DB_URL });
  await client.connect();
  await client.query(`DELETE FROM subscribers WHERE token = $1`, [token]);
  await client.end();

  return Response.redirect(`${env.FRONTEND_URL}/goodbye.html`, 302);
}