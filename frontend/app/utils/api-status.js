/**
 * Probing and classifying API endpoints for the API Status page. Plain functions, no
 * Ember, so every rule here is unit tested on its own.
 */

/** A response slower than this is flagged even when it succeeds. */
export const SLOW_MS = 2000;

/** A request still waiting after this long counts as failed. */
export const TIMEOUT_MS = 20000;

/** Checks in flight at once. Pacing (below) decides how fast new ones start. */
export const CONCURRENCY = 3;

/** The API's default limit, used when the live settings cannot be read. */
export const DEFAULT_RATE_LIMIT = { max_attempts: 120, decay_minutes: 1 };

/** Share of the rate-limit budget a run may use, so the console keeps working meanwhile. */
export const RATE_LIMIT_SHARE = 0.5;

const MESSAGE_LENGTH = 300;

/**
 * Sends one GET and reports what came back. Never throws: a network failure or timeout
 * is a result too.
 *
 * @param {String} url
 * @param {Object} options headers, credentials, timeoutMs, signal (to cancel), fetchImpl, now
 * @return {Promise<Object>} { httpStatus, statusText, ms, bytes, isJson, body, retryAfter } or { error, timedOut, ms }
 */
export async function probe(url, { headers = {}, credentials, timeoutMs = TIMEOUT_MS, signal, fetchImpl, now = defaultNow } = {}) {
    const request = fetchImpl ?? ((...args) => window.fetch(...args));
    const controller = new AbortController();
    const abort = () => controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    if (signal?.aborted) {
        abort();
    } else {
        signal?.addEventListener?.('abort', abort);
    }

    const started = now();
    try {
        const response = await request(url, { method: 'GET', headers, credentials, mode: 'cors', signal: controller.signal });
        const text = await response.text();
        const { isJson, body } = parseBody(text);

        return {
            httpStatus: response.status,
            statusText: response.statusText ?? '',
            ms: Math.round(now() - started),
            bytes: text.length,
            isJson,
            body,
            retryAfter: response.headers?.get?.('retry-after') ?? null,
        };
    } catch (error) {
        return { error, timedOut, ms: Math.round(now() - started) };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
    }
}

/**
 * Turns a probe result into a state for the page:
 * - `ok`: answered 2xx with JSON in good time,
 * - `warning`: the endpoint answered but something needs a look (slow, not JSON,
 *   no permission for this account, rate limited),
 * - `failed`: unreachable, timed out, signed out, missing, a bad request or a server error.
 *
 * @param {Object} result from probe()
 * @param {Object} options slowMs
 * @return {Object} { state, label, message }
 */
export function classify(result = {}, { slowMs = SLOW_MS } = {}) {
    if (result.timedOut) {
        return { state: 'failed', label: 'Timed out', message: `No answer within ${formatDuration(TIMEOUT_MS)}.` };
    }

    if (result.error || !result.httpStatus) {
        const reason = result.error?.message ?? String(result.error ?? 'Request failed.');
        return { state: 'failed', label: 'Unreachable', message: `${reason} The API server may be down, or CORS is blocking the console.` };
    }

    const status = result.httpStatus;
    const message = describeBody(result);

    if (status >= 200 && status < 300) {
        if (!result.isJson) {
            return { state: 'warning', label: 'Not JSON', message: 'Answered, but the response is not JSON.' };
        }
        if (result.ms >= slowMs) {
            return { state: 'warning', label: 'Slow', message: `Answered in ${formatDuration(result.ms)}, slower than ${formatDuration(slowMs)}.` };
        }
        return { state: 'ok', label: 'OK', message: null };
    }

    if (status === 401) {
        return { state: 'failed', label: 'Unauthorized', message: message ?? 'The API did not accept your session. Sign in again and re-run.' };
    }

    if (status === 403) {
        return { state: 'warning', label: 'Forbidden', message: message ?? 'The endpoint works, but your account is not allowed to use it.' };
    }

    if (status === 404) {
        return { state: 'failed', label: 'Not found', message: message ?? 'No such route on the API server. The extension may not be installed.' };
    }

    if (status === 429) {
        const wait = Number(result.retryAfter);
        const retry = Number.isFinite(wait) && wait > 0 ? ` Try again in ${wait}s.` : '';
        return { state: 'warning', label: 'Rate limited', message: `The API rate limit was reached.${retry}` };
    }

    if (status >= 500) {
        return { state: 'failed', label: 'Server error', message: message ?? `HTTP ${status}` };
    }

    return { state: 'failed', label: `HTTP ${status}`, message: message ?? (result.statusText || null) };
}

/**
 * Counts results by state and sums up response times.
 *
 * @param {Array} results classified results; entries without a state are ignored
 * @return {Object} { ok, warning, failed, checked, averageMs, slowestMs }
 */
export function summarize(results = []) {
    const counts = { ok: 0, warning: 0, failed: 0 };
    const times = [];

    for (const result of results) {
        if (!result || !(result.state in counts)) {
            continue;
        }
        counts[result.state]++;
        if (Number.isFinite(result.ms) && result.httpStatus) {
            times.push(result.ms);
        }
    }

    return {
        ...counts,
        checked: counts.ok + counts.warning + counts.failed,
        averageMs: times.length ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length) : null,
        slowestMs: times.length ? Math.max(...times) : null,
    };
}

/**
 * Milliseconds between the starts of two checks, so a run uses at most RATE_LIMIT_SHARE
 * of the API's rate limit. 0 when limiting is off or unlimited.
 *
 * @param {Object|null} response the `rate-limits/settings` response, or null when unreadable
 * @return {Number}
 */
export function paceFromRateLimits(response) {
    const settings = response?.settings ?? DEFAULT_RATE_LIMIT;

    if (settings.enabled === false) {
        return 0;
    }

    const maxAttempts = settings.max_attempts === undefined ? DEFAULT_RATE_LIMIT.max_attempts : settings.max_attempts;
    const decayMinutes = Number(settings.decay_minutes) > 0 ? Number(settings.decay_minutes) : DEFAULT_RATE_LIMIT.decay_minutes;

    if (maxAttempts === null || !(Number(maxAttempts) > 0)) {
        return 0;
    }

    return Math.ceil((decayMinutes * 60000) / Math.max(1, Number(maxAttempts) * RATE_LIMIT_SHARE));
}

/**
 * Resolves a path typed into the custom check against the API host. Refuses anything
 * that would leave the API server, since the request carries the session token.
 *
 * @param {String} input e.g. `int/v1/orders?limit=1` or `/health`
 * @param {String} host e.g. `https://api.example.com`
 * @return {Object} { url, path } or { error }
 */
export function resolveApiPath(input, host) {
    const value = String(input ?? '').trim();

    if (!value) {
        return { error: 'Enter a path, for example int/v1/orders?limit=1.' };
    }

    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//') || value.includes('\\')) {
        return { error: 'Enter a path on the API server, not a full URL.' };
    }

    let base;
    let url;
    try {
        base = new URL(`${String(host ?? '').replace(/\/+$/, '')}/`);
        url = new URL(value.replace(/^\/+/, ''), base);
    } catch (error) {
        return { error: 'That path could not be turned into a URL.' };
    }

    if (url.origin !== base.origin) {
        return { error: 'Enter a path on the API server, not a full URL.' };
    }

    return { url: url.toString(), path: `${url.pathname}${url.search}` };
}

/**
 * Joins the API host and a catalog path.
 */
export function apiUrl(host, path = '') {
    return `${String(host ?? '').replace(/\/+$/, '')}/${path}`;
}

export function formatDuration(ms) {
    if (!Number.isFinite(ms)) {
        return '—';
    }
    if (ms < 1000) {
        return `${Math.round(ms)} ms`;
    }
    if (ms < 60000) {
        return `${(ms / 1000).toFixed(1)} s`;
    }
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) {
        return '—';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseBody(text) {
    if (text === '') {
        return { isJson: true, body: null };
    }
    try {
        return { isJson: true, body: JSON.parse(text) };
    } catch (error) {
        return { isJson: false, body: null };
    }
}

// The error the API put in the body, in the shapes ember-core's fetch service reads.
function describeBody({ body } = {}) {
    let message = null;

    if (Array.isArray(body?.errors) && body.errors.length) {
        const first = body.errors[0];
        message = typeof first === 'string' ? first : (first?.message ?? first?.detail ?? null);
    } else if (typeof body?.error === 'string') {
        message = body.error;
    } else if (typeof body?.error?.message === 'string') {
        message = body.error.message;
    } else if (typeof body?.message === 'string') {
        message = body.message;
    }

    if (!message) {
        return null;
    }

    return message.length > MESSAGE_LENGTH ? `${message.slice(0, MESSAGE_LENGTH - 1)}…` : message;
}

function defaultNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
