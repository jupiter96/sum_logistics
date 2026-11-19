import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';
import Service from '@ember/service';
import { settled } from '@ember/test-helpers';

module('Unit | Controller | auth/two-fa', function (hooks) {
    setupTest(hooks);

    test('handleCodeExpired flags expiry and stops the countdown', function (assert) {
        const controller = this.owner.lookup('controller:auth/two-fa');
        controller.isCodeExpired = false;
        controller.countdownReady = true;

        controller.handleCodeExpired();

        assert.true(controller.isCodeExpired);
        assert.false(controller.countdownReady);
    });

    test('getExpirationDateFromClientToken decodes the expiry from a base64 client token', function (assert) {
        const controller = this.owner.lookup('controller:auth/two-fa');
        const token = btoa('2024-01-01T00:00:00|session-payload');

        const result = controller.getExpirationDateFromClientToken(token);

        assert.true(result instanceof Date, 'returns a Date for a pipe-delimited token');
        assert.strictEqual(controller.getExpirationDateFromClientToken(btoa('no-delimiter')), null, 'null when the token has no expiry segment');
    });

    test('verifyCode short-circuits with an error when the client token is missing', async function (assert) {
        class NotificationsStub extends Service {
            error() {
                this.errored = true;
            }
            success() {}
        }
        this.owner.register('service:notifications', NotificationsStub);

        const controller = this.owner.lookup('controller:auth/two-fa');
        controller.clientToken = null;

        await controller.verifyCode();

        assert.true(this.owner.lookup('service:notifications').errored, 'reports an invalid-session error');
    });
});

module('Unit | Controller | auth/two-fa | verification flow', function (hooks) {
    setupTest(hooks);

    hooks.beforeEach(function () {
        this.posted = [];
        this.postResponse = { authToken: 'auth-token' };
        this.postRejectsWith = null;
        const context = this;

        class FetchStub extends Service {
            post(path, payload) {
                context.posted.push({ path, payload });
                return context.postRejectsWith ? Promise.reject(context.postRejectsWith) : Promise.resolve(context.postResponse);
            }
        }
        class NotificationsStub extends Service {
            errors = [];
            successes = [];
            infos = [];
            warnings = [];
            error(message) {
                this.errors.push(message);
            }
            success(message) {
                this.successes.push(message);
            }
            info(message) {
                this.infos.push(message);
            }
            warning(message) {
                this.warnings.push(message);
            }
        }
        class SessionStub extends Service {
            authenticated = [];
            persisted = [];
            store = {
                persist: (data) => {
                    this.persisted.push(data);
                    return Promise.resolve();
                },
            };
            authenticate(authenticator, credentials) {
                this.authenticated.push({ authenticator, credentials });
                return Promise.resolve();
            }
        }

        this.owner.register('service:fetch', FetchStub);
        this.owner.register('service:notifications', NotificationsStub);
        this.owner.register('service:session', SessionStub);

        this.build = () => {
            const controller = this.owner.lookup('controller:auth/two-fa');
            this.transitions = [];
            Object.defineProperty(controller.router, 'transitionTo', {
                configurable: true,
                value: (routeName) => {
                    this.transitions.push(routeName);
                    return Promise.resolve(routeName);
                },
            });
            return controller;
        };
        this.notifications = () => this.owner.lookup('service:notifications');
    });

    test('verifyCode posts the code, authenticates and lands in the console', async function (assert) {
        const controller = this.build();
        controller.token = 'tok';
        controller.clientToken = 'client-tok';
        controller.identity = 'jane@example.org';
        controller.verificationCode = '123456';

        await controller.verifyCode();

        assert.deepEqual(this.posted, [{ path: 'two-fa/verify', payload: { token: 'tok', code: '123456', clientToken: 'client-tok', identity: 'jane@example.org' } }]);
        assert.deepEqual(this.owner.lookup('service:session').authenticated, [
            { authenticator: 'authenticator:sum_logistics', credentials: { authToken: 'auth-token', identity: 'jane@example.org' } },
        ]);
        assert.deepEqual(this.transitions, ['console']);
        assert.strictEqual(this.notifications().successes.length, 1, 'success is reported');
    });

    test('verifyCode prevents the form from submitting itself', async function (assert) {
        const controller = this.build();
        controller.clientToken = 'client-tok';
        let prevented = false;

        await controller.verifyCode({ preventDefault: () => (prevented = true) });

        assert.true(prevented);
    });

    test('an expired code is reported as information rather than an error', async function (assert) {
        this.postRejectsWith = new Error('Verification code has expired');
        const controller = this.build();
        controller.clientToken = 'client-tok';
        controller.verificationCode = '123456';

        await controller.verifyCode();

        assert.strictEqual(this.notifications().infos.length, 1, 'the user is told the code lapsed');
        assert.strictEqual(this.notifications().errors.length, 0, 'and it is not framed as a failure');
        assert.deepEqual(this.transitions, [], 'nothing navigates');
    });

    test('any other verification failure is reported as an error', async function (assert) {
        this.postRejectsWith = new Error('invalid code');
        const controller = this.build();
        controller.clientToken = 'client-tok';
        controller.verificationCode = '123456';

        await controller.verifyCode();

        assert.strictEqual(this.notifications().errors.length, 1);
        assert.strictEqual(this.notifications().infos.length, 0);
        assert.false(controller.isVerifying, 'the code can be corrected and checked again');
    });

    test('too many wrong codes sends the user back to sign in again', async function (assert) {
        this.postRejectsWith = new Error('Too many failed verification attempts. Please sign in again.');
        const controller = this.build();
        controller.clientToken = 'client-tok';
        controller.verificationCode = '123456';

        await controller.verifyCode();

        assert.deepEqual(this.notifications().errors, [controller.intl.t('auth.two-fa.verify-code.too-many-attempts-notification')]);
        assert.strictEqual(this.transitions.at(-1), 'auth.login', 'the dead 2FA session is abandoned');
    });

    test('handleOtpInput stores the code and immediately verifies it', async function (assert) {
        const controller = this.build();
        controller.clientToken = 'client-tok';

        controller.handleOtpInput('654321');

        assert.strictEqual(controller.verificationCode, '654321');
        await settled();
        assert.strictEqual(this.posted.at(-1).payload.code, '654321', 'the entered code is submitted without a further click');
    });

    test('resendCode restarts the countdown with the new client token', async function (assert) {
        const expiry = new Date('2026-03-01T12:00:00');
        this.postResponse = { clientToken: btoa(`2026-03-01T12:00:00|session`) };
        const controller = this.build();
        controller.identity = 'jane@example.org';
        controller.token = 'tok';
        controller.isCodeExpired = true;

        await controller.resendCode();

        assert.deepEqual(this.posted, [{ path: 'two-fa/resend', payload: { identity: 'jane@example.org', token: 'tok' } }]);
        assert.strictEqual(controller.clientToken, this.postResponse.clientToken);
        assert.true(controller.countdownReady, 'the countdown restarts');
        assert.false(controller.isCodeExpired, 'and the expiry flag is cleared');
        assert.true(controller.twoFactorSessionExpiresAfter instanceof Date, 'the new expiry is decoded');
        assert.strictEqual(this.notifications().successes.length, 1);
        assert.ok(expiry instanceof Date);
    });

    test('asking for a code instead switches an authenticator app user to the code that was sent', async function (assert) {
        this.postResponse = { clientToken: btoa(`2026-03-01T12:00:00|session`), method: 'email' };
        const controller = this.build();
        controller.identity = 'jane@example.org';
        controller.token = 'tok';
        controller.method = 'authenticator_app';
        controller.useRecoveryCode = true;
        const event = {
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
        };

        await controller.resendCode(event);

        assert.true(event.defaultPrevented, 'the link does not navigate');
        assert.strictEqual(controller.method, 'email');
        assert.false(controller.isAuthenticatorApp);
        assert.false(controller.useRecoveryCode);
        assert.true(controller.countdownReady, 'a sent code counts down');
        assert.deepEqual(this.owner.lookup('service:session').persisted, [{ identity: 'jane@example.org', token: 'tok', clientToken: this.postResponse.clientToken, method: 'email' }]);
    });

    test('an authenticator app user can switch to a recovery code and back', async function (assert) {
        const controller = this.build();
        controller.method = 'authenticator_app';
        controller.verificationCode = '123';

        assert.true(controller.isAuthenticatorApp);

        controller.toggleRecoveryCode();
        assert.true(controller.useRecoveryCode);
        assert.strictEqual(controller.verificationCode, '', 'the half-typed code is cleared');

        controller.toggleRecoveryCode();
        assert.false(controller.useRecoveryCode);
    });

    test('a recovery code is verified like any other code', async function (assert) {
        const controller = this.build();
        controller.token = 'tok';
        controller.clientToken = 'client';
        controller.identity = 'jane@example.org';
        controller.method = 'authenticator_app';
        controller.useRecoveryCode = true;
        controller.verificationCode = 'k7d2m-9xq4p';

        await controller.verifyCode();

        assert.deepEqual(this.posted, [{ path: 'two-fa/verify', payload: { token: 'tok', code: 'k7d2m-9xq4p', clientToken: 'client', identity: 'jane@example.org' } }]);
        assert.deepEqual(this.transitions, ['console']);
    });

    test('a resend that returns no client token is reported as a failure', async function (assert) {
        this.postResponse = {};
        const controller = this.build();

        await controller.resendCode();

        assert.strictEqual(this.notifications().errors.length, 1);
        assert.false(controller.countdownReady, 'the countdown stays stopped');
    });

    test('a failed resend request is reported as a failure', async function (assert) {
        this.postRejectsWith = new Error('resend unavailable');
        const controller = this.build();

        await controller.resendCode();

        assert.strictEqual(this.notifications().errors.length, 1);
        assert.false(controller.countdownReady);
    });

    test('cancelTwoFactor invalidates the session and returns to login', async function (assert) {
        const controller = this.build();
        controller.identity = 'jane@example.org';
        controller.token = 'tok';

        await controller.cancelTwoFactor();

        assert.deepEqual(this.posted, [{ path: 'two-fa/invalidate', payload: { identity: 'jane@example.org', token: 'tok' } }]);
        assert.deepEqual(this.transitions, ['auth.login']);
    });

    test('convertUtcToClientTime reads the server stamp as UTC in every browser', function (assert) {
        const controller = this.build();
        const moment = Date.UTC(2026, 2, 1, 12, 0, 0);

        assert.strictEqual(controller.convertUtcToClientTime('2026-03-01 12:00:00').getTime(), moment, "the server's zone-less format is UTC");
        assert.strictEqual(controller.convertUtcToClientTime('2026-03-01T12:00:00').getTime(), moment, 'with a T as well');
        assert.strictEqual(controller.convertUtcToClientTime('2026-03-01 12:00:00.250').getTime(), moment + 250, 'fractions of a second are kept');
        assert.strictEqual(controller.convertUtcToClientTime('2026-03-01T12:00:00Z').getTime(), moment, 'a stamp in UTC is not shifted again');
        assert.strictEqual(controller.convertUtcToClientTime('2026-03-01T21:00:00+09:00').getTime(), moment, 'a stamp with an offset is read as written');
        assert.true(Number.isNaN(controller.convertUtcToClientTime('not a date').getTime()), 'an unreadable stamp is an Invalid Date');
    });

    test('an incomplete code is not sent, so it does not use up an attempt', async function (assert) {
        const controller = this.build();
        controller.clientToken = 'client-tok';

        controller.verificationCode = '12345';
        await controller.verifyCode();
        controller.verificationCode = '';
        await controller.verifyCode();

        assert.deepEqual(this.posted, [], 'nothing reaches the server');
        assert.deepEqual(this.notifications().warnings, [
            controller.intl.t('auth.two-fa.verify-code.enter-code-notification', { length: 6 }),
            controller.intl.t('auth.two-fa.verify-code.enter-code-notification', { length: 6 }),
        ]);
    });

    test('a pasted code with spaces or dashes is sent as its digits', async function (assert) {
        const controller = this.build();
        controller.token = 'tok';
        controller.clientToken = 'client-tok';
        controller.identity = 'jane@example.org';
        controller.verificationCode = ' 123-456 ';

        await controller.verifyCode();

        assert.strictEqual(this.posted[0].payload.code, '123456');
    });

    test('a second check while one is in flight is ignored', async function (assert) {
        let release;
        const context = this;
        this.owner.lookup('service:fetch').post = (path, payload) => {
            context.posted.push({ path, payload });
            return new Promise((resolve) => (release = () => resolve({ authToken: 'auth-token' })));
        };
        const controller = this.build();
        controller.clientToken = 'client-tok';
        controller.verificationCode = '123456';

        const first = controller.verifyCode();
        assert.true(controller.isVerifying, 'the first check is running');
        await controller.verifyCode();
        assert.strictEqual(this.posted.length, 1, 'the auto-submit and a click do not both reach the server');

        release();
        await first;
        assert.false(controller.isVerifying);
        assert.deepEqual(this.transitions, ['console']);
        assert.deepEqual(this.notifications().errors, [], 'no stray "verification failed" after a successful sign-in');
    });

    test('updateOtp keeps the code in step with the field and checks a pasted code', async function (assert) {
        const controller = this.build();
        controller.clientToken = 'client-tok';

        controller.updateOtp('123');
        assert.strictEqual(controller.verificationCode, '123', 'the Verify button submits what is in the field');
        await settled();
        assert.deepEqual(this.posted, [], 'a partial code is not checked');

        controller.updateOtp('123456');
        await settled();
        assert.deepEqual(this.posted, [], 'six characters are left to the field, which completes itself');

        controller.updateOtp('123 456');
        await settled();
        assert.strictEqual(this.posted.at(-1).payload.code, '123456', 'a pasted code with a space is checked');
    });

    test('a resent code whose expiry cannot be read does not start a countdown', async function (assert) {
        this.postResponse = { clientToken: btoa('not-a-timestamp|session'), method: 'sms' };
        const controller = this.build();
        controller.identity = 'jane@example.org';
        controller.token = 'tok';

        await controller.resendCode();

        assert.strictEqual(controller.twoFactorSessionExpiresAfter, null);
        assert.false(controller.countdownReady, 'a countdown with no end would call the new code expired at once');
        assert.strictEqual(this.notifications().successes.length, 1, 'the code was still sent');
    });
});

module('Unit | Controller | auth/two-fa | client token expiry', function (hooks) {
    setupTest(hooks);

    hooks.beforeEach(function () {
        this.controller = this.owner.lookup('controller:auth/two-fa');
        // The token is base64 of "<expiry>|<identifier>".
        this.token = (contents) => window.btoa(contents);
    });

    test('a token carrying a parseable expiry yields that date', function (assert) {
        const expiry = this.controller.getExpirationDateFromClientToken(this.token('2026-05-06 14:30:00|session-1'));

        assert.true(expiry instanceof Date, 'the expiry is handed back as a Date');
    });

    test('a token whose expiry cannot be read yields no expiry', function (assert) {
        assert.strictEqual(
            this.controller.getExpirationDateFromClientToken(this.token('not-a-timestamp|session-1')),
            null,
            'an unparseable stamp is treated as no expiry rather than an invalid Date'
        );
    });

    test('a token with no separator yields no expiry', function (assert) {
        assert.strictEqual(this.controller.getExpirationDateFromClientToken(this.token('sessiononly')), null);
    });

    test('a missing or non-string token yields no expiry', function (assert) {
        assert.strictEqual(this.controller.getExpirationDateFromClientToken(undefined), null, 'no token');
        assert.strictEqual(this.controller.getExpirationDateFromClientToken(''), null, 'an empty token');
        assert.strictEqual(this.controller.getExpirationDateFromClientToken(12345), null, 'a non-string token');
    });

    test('a token that is not valid base64 yields no expiry instead of throwing', function (assert) {
        assert.strictEqual(this.controller.getExpirationDateFromClientToken('!!!'), null);
    });
});
