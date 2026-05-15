// sends a message to LLM

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 60_000;

async function chatCompletion({
  apiKey,
  model,
  messages,
  temperature = 0.2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available. Node.js 18 or newer is required.');
  }
  if (!apiKey) {
    const e = new Error('OpenAI analysis is not configured. Please set OPENAI_API_KEY.');
    e.code = 'openai_not_configured';
    e.status = 400;
    throw e;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(
        `OpenAI request failed (${res.status}): ${(text || 'no body').slice(0, 500)}`
      );
      err.status = res.status;
      err.code = 'openai_http_error';
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      const e = new Error(`OpenAI request timed out after ${timeoutMs} ms.`);
      e.code = 'openai_timeout';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chatCompletion };
