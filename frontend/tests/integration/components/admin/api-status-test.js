import { module, test } from 'qunit';
import { setupRenderingTest } from '@summit_logistics/console/tests/helpers';
import { render, click, fillIn, findAll, waitUntil } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';
import Service from '@ember/service';
import { CHECKS, GROUPS } from '@summit_logistics/console/components/admin/api-status';

const HOST = 'https://api.test';
const PLATFORM = GROUPS.find((group) => group.id === 'platform');

function statesIn(group) {
    return findAll(`[data-test-group="${group}"] [data-test-check]`).map((row) => row.dataset.testState);
}

function renderPage() {
    return render(hbs`<div id="next-view-section-subheader-actions"></div><Admin::ApiStatus />`);
}

module('Integration | Component | admin/api-status', function (hooks) {
    setupRenderingTest(hooks);

    hooks.beforeEach(function () {
        const context = this;
        this.calls = [];
        this.routes = {};
        this.hang = false;
        this.rateLimits = { settings: { enabled: false } };

        // The page probes with window.fetch to see status codes; answer from this.routes by path.
        this.originalFetch = window.fetch;
        window.fetch = (url, init) => {
            context.calls.push({ url, init });
            if (context.hang) {
                return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
            }
            const reply = context.routes[url.slice(HOST.length)] ?? { status: 200, body: { ok: true } };
            if (reply instanceof Error) {
                return Promise.reject(reply);
            }
            return Promise.resolve(new Response(JSON.stringify(reply.body ?? {}), { status: reply.status, headers: { 'Content-Type': 'application/json' } }));
        };

        class FetchStub extends Service {
            host = HOST;
            credentials = 'include';
            getHeaders() {
                return { 'Content-Type': 'application/json', Authorization: 'Bearer session-token' };
            }
            get(path) {
                return path === 'rate-limits/settings' ? Promise.resolve(context.rateLimits) : Promise.reject(new Error(`unexpected GET ${path}`));
            }
        }
        class NotificationsStub extends Service {
            messages = [];
            success(message) {
                this.messages.push(['success', message]);
            }
            warning(message) {
                this.messages.push(['warning', message]);
            }
            error(message) {
                this.messages.push(['error', message]);
            }
        }

        this.owner.register('service:fetch', FetchStub);
        this.owner.register('service:notifications', NotificationsStub);
        this.notifications = () => this.owner.lookup('service:notifications').messages;
        this.runPlatform = async () => {
            const before = this.notifications().length;
            await click('[data-test-run-group="platform"]');
            await waitUntil(() => this.notifications().length > before, { timeout: 5000 });
        };
    });

    hooks.afterEach(function () {
        window.fetch = this.originalFetch;
    });

    test('it lists every check as not run until asked', async function (assert) {
        await renderPage();

        assert.dom('[data-test-check]').exists({ count: CHECKS.length });
        assert.dom('[data-test-check="/health"]').hasAttribute('data-test-state', 'idle');
        assert.dom('[data-test-check="/health"]').containsText('Not run');
        assert.dom('[data-test-check="/health"]').containsText('GET /health');
        assert.dom('[data-test-host]').hasText(HOST);
        assert.dom('[data-test-stat="total"] [data-test-stat-value]').hasText(String(CHECKS.length));
        assert.dom('#next-view-section-subheader-actions [data-test-run-all]').exists('actions live in the header');
        assert.dom('[data-test-run-problems]').doesNotExist();
        assert.strictEqual(this.calls.length, 0, 'nothing is requested on load');
    });

    test('running a group checks each endpoint with the session and reports each result', async function (assert) {
        this.routes = {
            '/health': { status: 404 },
            '/int/v1/lookup/currencies': { status: 500, body: { message: 'Redis connection refused' } },
            '/int/v1/lookup/countries': { status: 403, body: { errors: ['No permission'] } },
            '/int/v1/auth/oauth/providers': new TypeError('Failed to fetch'),
        };
        await renderPage();
        await this.runPlatform();

        assert.strictEqual(this.calls.length, PLATFORM.checks.length, 'one request per check in the group');
        assert.true(
            this.calls.every(
                ({ url, init }) => url.startsWith(`${HOST}/`) && init.method === 'GET' && init.headers.Authorization === 'Bearer session-token' && init.credentials === 'include'
            ),
            'GETs to the API host with the session'
        );

        assert.dom('[data-test-check="/"]').hasAttribute('data-test-state', 'ok');
        assert.dom('[data-test-check="/"] [data-test-check-status]').hasText('200');
        assert.dom('[data-test-check="/health"]').hasAttribute('data-test-state', 'failed');
        assert.dom('[data-test-check="/health"] [data-test-check-label]').hasText('Not found');
        assert.dom('[data-test-check="/int/v1/lookup/currencies"] [data-test-check-label]').hasText('Server error');
        assert.dom('[data-test-check="/int/v1/lookup/currencies"] [data-test-check-message]').hasText('Redis connection refused');
        assert.dom('[data-test-check="/int/v1/lookup/countries"]').hasAttribute('data-test-state', 'warning');
        assert.dom('[data-test-check="/int/v1/lookup/countries"] [data-test-check-message]').hasText('No permission');
        assert.dom('[data-test-check="/int/v1/auth/oauth/providers"] [data-test-check-label]').hasText('Unreachable');
        assert.dom('[data-test-check="/int/v1/users/me"]').hasAttribute('data-test-state', 'idle', 'other groups did not run');

        assert.dom('[data-test-group="platform"] [data-test-group-headline]').hasText('3 failed, 1 warning');
        assert.dom('[data-test-stat="ok"] [data-test-stat-value]').hasText('4');
        assert.dom('[data-test-stat="warning"] [data-test-stat-value]').hasText('1');
        assert.dom('[data-test-stat="failed"] [data-test-stat-value]').hasText('3');
        assert.dom('[data-test-pace]').hasText('Rate limiting is off, so checks run 3 at a time.');
        assert.dom('[data-test-last-run]').exists();
        assert.deepEqual(this.notifications(), [['error', '3 of 8 endpoints failed.']]);
    });

    test('the problems filter and re-running only the problems', async function (assert) {
        this.routes = { '/health': { status: 500 }, '/int/v1/lookup/countries': { status: 403 } };
        await renderPage();
        await this.runPlatform();

        await click('[data-test-filter="problems"]');
        assert.dom('[data-test-filter="problems"]').hasAttribute('aria-pressed', 'true');
        assert.dom('[data-test-check]').exists({ count: 2 }, 'only the warning and the failure');
        assert.dom('[data-test-group]').exists({ count: 1 }, 'groups without problems are hidden');

        this.routes = {};
        const callsBefore = this.calls.length;
        await click('[data-test-run-problems]');
        await waitUntil(() => this.notifications().length === 2, { timeout: 5000 });

        assert.strictEqual(this.calls.length - callsBefore, 2, 'only the two problems were re-checked');
        assert.deepEqual(this.notifications()[1], ['success', 'All 2 endpoints are working.']);
        assert.dom('[data-test-no-problems]').exists();
        assert.dom('[data-test-run-problems]').doesNotExist();
    });

    test('a run is paced to half of the API rate limit', async function (assert) {
        this.rateLimits = { settings: { enabled: true, max_attempts: 120, decay_minutes: 1 } };
        await renderPage();

        await click('[data-test-run-group="customer-portal"]');
        await waitUntil(() => this.notifications().length === 1, { timeout: 5000 });

        assert.dom('[data-test-pace]').containsText('about 60 requests a minute');
        assert.dom('[data-test-check="/customer-portal/int/v1/settings/config"]').hasAttribute('data-test-state', 'ok');
    });

    test('Stop cancels the requests in flight and puts the rows back', async function (assert) {
        this.hang = true;
        await renderPage();

        await click('[data-test-run-group="routing"]');
        await waitUntil(() => statesIn('routing').every((state) => state === 'running'), { timeout: 5000 });
        assert.dom('[data-test-progress]').containsText('Checking 0 of 2');
        assert.dom('[data-test-run-all]').doesNotExist('no second run while one is going');

        await click('[data-test-stop]');
        await waitUntil(() => statesIn('routing').every((state) => state === 'idle'), { timeout: 5000 });

        assert.true(
            this.calls.every(({ init }) => init.signal.aborted),
            'the requests were aborted'
        );
        assert.dom('[data-test-progress]').doesNotExist();
        assert.dom('[data-test-run-all]').exists();
        assert.deepEqual(this.notifications(), [], 'a stopped run is not reported');
    });

    test('the custom check stays on the API host and shows the response', async function (assert) {
        this.routes = { '/int/v1/orders?limit=1': { status: 200, body: { orders: [{ id: 'order_1' }] } } };
        await renderPage();

        await fillIn('[data-test-custom-path]', 'https://evil.test/steal');
        await click('[data-test-custom-send]');
        assert.dom('[data-test-custom-result]').hasAttribute('data-test-state', 'failed');
        assert.dom('[data-test-custom-result]').containsText('Invalid path');
        assert.strictEqual(this.calls.length, 0, 'the session token never left the API host');

        await fillIn('[data-test-custom-path]', 'int/v1/orders?limit=1');
        await click('[data-test-custom-send]');
        await waitUntil(() => document.querySelector('[data-test-custom-preview]'), { timeout: 5000 });

        assert.strictEqual(this.calls[0].url, `${HOST}/int/v1/orders?limit=1`);
        assert.dom('[data-test-custom-result]').hasAttribute('data-test-state', 'ok');
        assert.dom('[data-test-custom-result]').containsText('HTTP 200');
        assert.dom('[data-test-custom-preview]').containsText('"order_1"');
    });
});
