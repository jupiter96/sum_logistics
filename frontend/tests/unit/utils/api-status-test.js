import { module, test } from 'qunit';
import { API_STATUS_GROUPS } from '@summit_logistics/console/utils/api-status-catalog';
import { apiUrl, classify, formatBytes, formatDuration, paceFromRateLimits, probe, resolveApiPath, summarize } from '@summit_logistics/console/utils/api-status';

function fakeResponse(status, text = '', { statusText = '', retryAfter = null } = {}) {
    return {
        status,
        statusText,
        headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) },
        text: () => Promise.resolve(text),
    };
}

function clock(...times) {
    const queue = [...times];
    return () => queue.shift();
}

module('Unit | Utility | api-status', function () {
    module('classify', function () {
        test('a fast JSON 2xx is ok', function (assert) {
            assert.deepEqual(classify({ httpStatus: 200, ms: 120, isJson: true }), { state: 'ok', label: 'OK', message: null });
            assert.strictEqual(classify({ httpStatus: 204, ms: 5, isJson: true }).state, 'ok');
        });

        test('a slow or non-JSON 2xx is a warning', function (assert) {
            const slow = classify({ httpStatus: 200, ms: 2500, isJson: true });
            assert.strictEqual(slow.state, 'warning');
            assert.strictEqual(slow.label, 'Slow');
            assert.strictEqual(slow.message, 'Answered in 2.5 s, slower than 2.0 s.');
            assert.strictEqual(classify({ httpStatus: 200, ms: 300, isJson: true }, { slowMs: 200 }).label, 'Slow', 'threshold is configurable');
            assert.strictEqual(classify({ httpStatus: 200, ms: 10, isJson: false }).label, 'Not JSON');
        });

        test('auth, permission, missing and throttled answers', function (assert) {
            assert.deepEqual(classify({ httpStatus: 401, isJson: true, body: { error: 'Unauthenticated.' } }), { state: 'failed', label: 'Unauthorized', message: 'Unauthenticated.' });
            assert.strictEqual(classify({ httpStatus: 401, isJson: false }).message, 'The API did not accept your session. Sign in again and re-run.');

            const forbidden = classify({ httpStatus: 403, isJson: true, body: { errors: ['User is not authorized to view settings'] } });
            assert.strictEqual(forbidden.state, 'warning', 'the endpoint works; this account may not use it');
            assert.strictEqual(forbidden.message, 'User is not authorized to view settings');

            assert.deepEqual(classify({ httpStatus: 404, isJson: false }), {
                state: 'failed',
                label: 'Not found',
                message: 'No such route on the API server. The extension may not be installed.',
            });

            assert.deepEqual(classify({ httpStatus: 429, retryAfter: '7' }), { state: 'warning', label: 'Rate limited', message: 'The API rate limit was reached. Try again in 7s.' });
            assert.strictEqual(classify({ httpStatus: 429 }).message, 'The API rate limit was reached.');
        });

        test('server errors and bad requests fail with the API message', function (assert) {
            assert.deepEqual(classify({ httpStatus: 500, isJson: true, body: { message: 'SQLSTATE[42S02]: Base table not found' } }), {
                state: 'failed',
                label: 'Server error',
                message: 'SQLSTATE[42S02]: Base table not found',
            });
            assert.strictEqual(classify({ httpStatus: 502, isJson: false }).message, 'HTTP 502');
            assert.deepEqual(classify({ httpStatus: 422, isJson: true, body: { errors: [{ message: 'The limit must be a number.' }] } }), {
                state: 'failed',
                label: 'HTTP 422',
                message: 'The limit must be a number.',
            });
            assert.strictEqual(classify({ httpStatus: 400, statusText: 'Bad Request', isJson: false }).message, 'Bad Request');
            assert.strictEqual(classify({ httpStatus: 500, isJson: true, body: { message: 'x'.repeat(400) } }).message.length, 300, 'long messages are cut');
        });

        test('network failures and timeouts fail', function (assert) {
            const unreachable = classify({ error: new TypeError('Failed to fetch'), ms: 3 });
            assert.strictEqual(unreachable.state, 'failed');
            assert.strictEqual(unreachable.label, 'Unreachable');
            assert.true(unreachable.message.startsWith('Failed to fetch'));

            assert.deepEqual(classify({ error: new Error('aborted'), timedOut: true }), { state: 'failed', label: 'Timed out', message: 'No answer within 20.0 s.' });
        });
    });

    module('probe', function () {
        test('it sends a GET with the given headers and reports status, timing and size', async function (assert) {
            const calls = [];
            const fetchImpl = (url, init) => {
                calls.push({ url, init });
                return Promise.resolve(fakeResponse(200, '{"ok":true}', { statusText: 'OK' }));
            };

            const result = await probe('https://api.test/health', { headers: { Authorization: 'Bearer t' }, credentials: 'include', fetchImpl, now: clock(100, 142.4) });

            assert.strictEqual(calls[0].url, 'https://api.test/health');
            assert.strictEqual(calls[0].init.method, 'GET');
            assert.deepEqual(calls[0].init.headers, { Authorization: 'Bearer t' });
            assert.strictEqual(calls[0].init.credentials, 'include');
            assert.deepEqual(result, { httpStatus: 200, statusText: 'OK', ms: 42, bytes: 11, isJson: true, body: { ok: true }, retryAfter: null });
        });

        test('it reads error bodies and non-JSON bodies without throwing', async function (assert) {
            const html = await probe('u', { fetchImpl: () => Promise.resolve(fakeResponse(502, '<html>Bad gateway</html>')), now: clock(0, 1) });
            assert.strictEqual(html.httpStatus, 502);
            assert.false(html.isJson);
            assert.strictEqual(html.body, null);

            const throttled = await probe('u', { fetchImpl: () => Promise.resolve(fakeResponse(429, '', { retryAfter: '30' })), now: clock(0, 1) });
            assert.strictEqual(throttled.retryAfter, '30');
            assert.true(throttled.isJson, 'an empty body is fine');
        });

        test('a network error becomes a result', async function (assert) {
            const result = await probe('u', { fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')), now: clock(0, 5) });
            assert.strictEqual(result.error.message, 'Failed to fetch');
            assert.false(result.timedOut);
            assert.strictEqual(result.ms, 5);
        });

        test('it gives up after the timeout and can be cancelled', async function (assert) {
            const hang = (url, init) =>
                new Promise((resolve, reject) => {
                    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                });

            const timedOut = await probe('u', { fetchImpl: hang, timeoutMs: 10 });
            assert.true(timedOut.timedOut);

            const controller = new AbortController();
            const pending = probe('u', { fetchImpl: hang, signal: controller.signal });
            controller.abort();
            const cancelled = await pending;
            assert.false(cancelled.timedOut, 'a cancel is not a timeout');
            assert.strictEqual(cancelled.error.name, 'AbortError');
        });
    });

    test('paceFromRateLimits keeps a run to half of the rate limit', function (assert) {
        assert.strictEqual(paceFromRateLimits(null), 1000, 'unreadable settings: the 120 a minute default');
        assert.strictEqual(paceFromRateLimits({ settings: { enabled: true, max_attempts: 600, decay_minutes: 1 } }), 200);
        assert.strictEqual(paceFromRateLimits({ settings: { enabled: true, max_attempts: 60, decay_minutes: 2 } }), 4000);
        assert.strictEqual(paceFromRateLimits({ settings: { enabled: false, max_attempts: 60 } }), 0, 'limiting off');
        assert.strictEqual(paceFromRateLimits({ settings: { enabled: true, max_attempts: null } }), 0, 'unlimited');
        assert.strictEqual(paceFromRateLimits({ settings: { enabled: true } }), 1000, 'missing values use the defaults');
    });

    test('resolveApiPath only allows paths on the API server', function (assert) {
        const host = 'https://api.test';
        assert.deepEqual(resolveApiPath('int/v1/orders?limit=1', host), { url: 'https://api.test/int/v1/orders?limit=1', path: '/int/v1/orders?limit=1' });
        assert.deepEqual(resolveApiPath('  /health ', `${host}/`), { url: 'https://api.test/health', path: '/health' });
        assert.strictEqual(resolveApiPath('int/v1/users/me', 'https://example.test/api').url, 'https://example.test/api/int/v1/users/me', 'keeps a host path');

        for (const input of ['https://evil.test/x', '//evil.test/x', 'javascript:alert(1)', '\\\\evil.test', 'mailto:a@b.test']) {
            assert.ok(resolveApiPath(input, host).error, `refuses ${input}`);
        }
        assert.strictEqual(resolveApiPath('   ', host).error, 'Enter a path, for example int/v1/orders?limit=1.');
    });

    test('summarize counts states and times only answered requests', function (assert) {
        const summary = summarize([
            { state: 'ok', httpStatus: 200, ms: 100 },
            { state: 'ok', httpStatus: 200, ms: 300 },
            { state: 'warning', httpStatus: 403, ms: 50 },
            { state: 'failed', ms: 20000 },
            { state: 'pending' },
            undefined,
        ]);

        assert.deepEqual(summary, { ok: 2, warning: 1, failed: 1, checked: 4, averageMs: 150, slowestMs: 300 });
        assert.deepEqual(summarize([]), { ok: 0, warning: 0, failed: 0, checked: 0, averageMs: null, slowestMs: null });
    });

    test('formatting helpers', function (assert) {
        assert.strictEqual(apiUrl('https://api.test/', 'int/v1/x'), 'https://api.test/int/v1/x');
        assert.strictEqual(apiUrl('https://api.test', ''), 'https://api.test/');
        assert.strictEqual(formatDuration(42.4), '42 ms');
        assert.strictEqual(formatDuration(1530), '1.5 s');
        assert.strictEqual(formatDuration(139000), '2m 19s');
        assert.strictEqual(formatDuration(120000), '2m');
        assert.strictEqual(formatDuration(null), '—');
        assert.strictEqual(formatBytes(512), '512 B');
        assert.strictEqual(formatBytes(2048), '2.0 KB');
        assert.strictEqual(formatBytes(3 * 1024 * 1024), '3.0 MB');
    });

    test('the catalog only reads, and each path appears once', function (assert) {
        const checks = API_STATUS_GROUPS.flatMap((group) => group.checks);
        const paths = checks.map((check) => check.path);
        // Exports, downloads and secret reveals act through GET; the rest call paid or third-party services.
        const unsafe = /(^|\/)(export|download|secret)(\/|\?|$)|socket-token|link-app|whois|blog|geocod|places\/(search|lookup)|stripe/;

        assert.ok(checks.length > 100, 'covers every module');
        assert.strictEqual(new Set(paths).size, paths.length, 'no duplicates');
        assert.strictEqual(new Set(API_STATUS_GROUPS.map((group) => group.id)).size, API_STATUS_GROUPS.length, 'unique group ids');

        for (const check of checks) {
            assert.false(check.path.startsWith('/'), `${check.path} is relative to the API host`);
            assert.notOk(check.method, `${check.path} has no method: every check is a GET`);
            assert.ok(check.label, `${check.path} has a label`);
            assert.notOk(unsafe.test(check.path), `${check.path} has no side effects or paid lookups`);
        }
    });
});
