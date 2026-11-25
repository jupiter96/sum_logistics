import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';
import Service from '@ember/service';

const STRONG = 'Tr0ub4dor&3';

module('Unit | Controller | auth/reset-password', function (hooks) {
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
            serverErrors = [];
            success(message) {
                this.successes.push(message);
            }
            serverError(error) {
                this.serverErrors.push(error);
            }
        }
        this.owner.register('service:fetch', FetchStub);
        this.owner.register('service:notifications', NotificationsStub);

        this.controller = this.owner.lookup('controller:auth/reset-password');
        this.notifications = this.owner.lookup('service:notifications');
        this.transitions = [];
        Object.defineProperty(this.controller.router, 'transitionTo', {
            configurable: true,
            value: (route) => {
                this.transitions.push(route);
                return Promise.resolve();
            },
        });

        this.controller.model = { id: 'link_1' };
        Object.assign(this.controller, { code: '123456', password: STRONG, password_confirmation: STRONG });
    });

    test('resetPassword posts the reset and transitions to login', async function (assert) {
        this.controller.code = ' 123456 ';

        await this.controller.resetPassword.perform({ preventDefault() {} });

        assert.deepEqual(this.posted, [
            {
                path: 'auth/reset-password',
                body: { link: 'link_1', code: '123456', password: STRONG, password_confirmation: STRONG },
            },
        ]);
        assert.strictEqual(this.notifications.successes.length, 1);
        assert.deepEqual(this.transitions, ['auth.login']);
    });

    test('resetPassword reports a server error and does not transition', async function (assert) {
        this.postRejectsWith = new Error('This password has appeared in a data breach. Please choose a different one.');

        await this.controller.resetPassword.perform();

        assert.deepEqual(this.notifications.serverErrors, [this.postRejectsWith]);
        assert.deepEqual(this.transitions, [], 'stays on the reset screen on error');
    });

    test('a password the server would refuse is not sent', async function (assert) {
        const refused = [
            { password: 'newpass', password_confirmation: 'newpass' },
            { password_confirmation: `${STRONG}x` },
            { password: '', password_confirmation: '' },
            { code: '' },
            { code: undefined },
        ];

        for (const values of refused) {
            Object.assign(this.controller, { code: '123456', password: STRONG, password_confirmation: STRONG }, values);
            assert.false(this.controller.isReady, JSON.stringify(values));
            await this.controller.resetPassword.perform();
        }

        assert.deepEqual(this.posted, []);
    });

    test('requirements follow what is typed', function (assert) {
        const met = () => this.controller.requirements.filter(({ isMet }) => isMet).map(({ key }) => key);

        Object.assign(this.controller, { password: 'abcdefgh', password_confirmation: '' });
        assert.deepEqual(met(), ['length']);

        Object.assign(this.controller, { password: STRONG, password_confirmation: 'other' });
        assert.deepEqual(met(), ['length', 'mixed-case', 'number', 'symbol']);

        this.controller.password_confirmation = STRONG;
        assert.deepEqual(met(), ['length', 'mixed-case', 'number', 'symbol', 'match']);
        assert.true(
            this.controller.requirements.every(({ label }) => label.length > 0),
            'each has something to show'
        );

        Object.assign(this.controller, { password: '', password_confirmation: '' });
        assert.deepEqual(met(), [], 'two empty passwords do not count as matching');
    });

    test('the passwords can be shown and hidden', function (assert) {
        assert.false(this.controller.isPasswordVisible);
        this.controller.togglePasswordVisibility();
        assert.true(this.controller.isPasswordVisible);
        this.controller.togglePasswordVisibility();
        assert.false(this.controller.isPasswordVisible);
    });

    test('reset forgets what was typed', function (assert) {
        Object.assign(this.controller, { isPasswordVisible: true, isLinkInvalid: true, hasCodeFromLink: true });

        this.controller.reset();

        assert.strictEqual(this.controller.code, undefined);
        assert.strictEqual(this.controller.password, undefined);
        assert.strictEqual(this.controller.password_confirmation, undefined);
        assert.false(this.controller.isPasswordVisible);
        assert.false(this.controller.isLinkInvalid);
        assert.false(this.controller.hasCodeFromLink);
    });
});
