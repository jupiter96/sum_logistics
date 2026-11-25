import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';
import Service from '@ember/service';
import { RESEND_COOLDOWN_SECONDS } from '@summit_logistics/console/controllers/auth/forgot-password';

module('Unit | Controller | auth/forgot-password', function (hooks) {
    setupTest(hooks);

    hooks.beforeEach(function () {
        const context = this;
        this.posted = [];
        this.postRejectsWith = null;

        class FetchStub extends Service {
            post(path, body) {
                context.posted.push({ path, body });
                return context.postRejectsWith ? Promise.reject(context.postRejectsWith) : Promise.resolve();
            }
        }
        class NotificationsStub extends Service {
            successes = [];
            warnings = [];
            serverErrors = [];
            success(message) {
                this.successes.push(message);
            }
            warning(message) {
                this.warnings.push(message);
            }
            serverError(error) {
                this.serverErrors.push(error);
            }
        }
        this.owner.register('service:fetch', FetchStub);
        this.owner.register('service:notifications', NotificationsStub);

        this.controller = this.owner.lookup('controller:auth/forgot-password');
        this.notifications = this.owner.lookup('service:notifications');

        // Stand in for the passing of time.
        this.realNow = Date.now;
        this.now = this.realNow();
        Date.now = () => this.now;
        this.wait = (seconds) => {
            this.now += seconds * 1000;
            this.controller.updateCooldown();
        };
    });

    hooks.afterEach(function () {
        Date.now = this.realNow;
        this.controller.stopCooldown();
    });

    test('sendSecureLink posts the email and flags the link as sent', async function (assert) {
        this.controller.email = ' jane@example.org ';

        await this.controller.sendSecureLink.perform({ preventDefault() {} });

        assert.deepEqual(this.posted, [{ path: 'auth/get-magic-reset-link', body: { email: 'jane@example.org' } }]);
        assert.strictEqual(this.notifications.successes.length, 1);
        assert.true(this.controller.isSent);
    });

    test('sendSecureLink keeps the form from submitting itself, and works without an event', async function (assert) {
        let prevented = false;
        this.controller.email = 'jane@example.org';

        await this.controller.sendSecureLink.perform({ preventDefault: () => (prevented = true) });
        assert.true(prevented);

        this.controller.reset();
        this.controller.email = 'john@example.org';
        await this.controller.sendSecureLink.perform();
        assert.strictEqual(this.posted.length, 2);
    });

    test('sendSecureLink surfaces a server error and stays unsent', async function (assert) {
        this.postRejectsWith = new Error('nope');
        this.controller.email = 'jane@example.org';

        await this.controller.sendSecureLink.perform();

        assert.deepEqual(this.notifications.serverErrors, [this.postRejectsWith]);
        assert.false(this.controller.isSent);
        assert.true(this.controller.canResend, 'a failed request can be tried again at once');
    });

    test('an empty email is not sent', async function (assert) {
        this.controller.email = '   ';

        await this.controller.sendSecureLink.perform();

        assert.deepEqual(this.posted, []);
        assert.strictEqual(this.notifications.warnings.length, 1);
        assert.false(this.controller.isSent);
    });

    test('the link can only be sent again once the API would', async function (assert) {
        this.controller.email = 'jane@example.org';
        await this.controller.sendSecureLink.perform();

        assert.false(this.controller.canResend);
        assert.strictEqual(this.controller.secondsUntilResend, RESEND_COOLDOWN_SECONDS);
        assert.strictEqual(this.controller.resendCountdown, '5:00');

        this.wait(241);
        assert.strictEqual(this.controller.resendCountdown, '0:59');

        this.wait(59);
        assert.true(this.controller.canResend);
        assert.strictEqual(this.controller.cooldownTimer, null, 'the countdown stops');

        await this.controller.sendSecureLink.perform();
        assert.strictEqual(this.posted.length, 2);
        assert.false(this.controller.canResend, 'and starts over');
    });

    test('asking again for the same address goes back to the sent page without asking the API', async function (assert) {
        this.controller.email = 'jane@example.org';
        await this.controller.sendSecureLink.perform();
        this.controller.reset();
        this.wait(60);

        this.controller.email = 'Jane@Example.org';
        await this.controller.sendSecureLink.perform();

        assert.strictEqual(this.posted.length, 1, 'the API would ignore it');
        assert.true(this.controller.isSent);
        assert.strictEqual(this.controller.resendCountdown, '4:00');
        assert.strictEqual(this.notifications.successes.length, 1, 'nothing new is claimed');
    });

    test('a different address can be tried at once, and the first one corrected', async function (assert) {
        this.controller.email = 'jame@example.org';
        await this.controller.sendSecureLink.perform();

        this.controller.changeEmail();
        assert.false(this.controller.isSent);
        assert.strictEqual(this.controller.email, 'jame@example.org', 'kept, so a typo can be corrected');

        this.controller.email = 'jane@example.org';
        await this.controller.sendSecureLink.perform();
        assert.strictEqual(this.posted.length, 2);
        assert.true(this.controller.isSent);
    });

    test('reset leaves an empty form', async function (assert) {
        this.controller.email = 'jane@example.org';
        await this.controller.sendSecureLink.perform();

        this.controller.reset();

        assert.false(this.controller.isSent);
        assert.strictEqual(this.controller.email, undefined);
        assert.strictEqual(this.controller.cooldownTimer, null);
    });
});
