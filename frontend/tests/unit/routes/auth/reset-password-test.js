import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';
import Service from '@ember/service';

module('Unit | Route | auth/reset-password', function (hooks) {
    setupTest(hooks);

    test('model validates the link as a password reset link', async function (assert) {
        class FetchStub extends Service {
            get(path, params) {
                return Promise.resolve({ path, params });
            }
        }
        this.owner.register('service:fetch', FetchStub);

        const route = this.owner.lookup('route:auth/reset-password');
        const model = await route.model({ id: 'code_1' });

        assert.strictEqual(model.path, 'auth/validate-verification');
        assert.deepEqual(model.params, { id: 'code_1', for: 'password_reset' }, 'a link issued for something else is not valid here');
    });

    test('setupController says so when the link is no longer valid', async function (assert) {
        const route = this.owner.lookup('route:auth/reset-password');
        const controller = { code: '123456' };

        await route.setupController(controller, { is_valid: false });

        assert.true(controller.isLinkInvalid);
        assert.notOk(controller.brand, 'no brand is loaded for an invalid link');
    });

    test('setupController loads the brand when the link is valid', async function (assert) {
        const route = this.owner.lookup('route:auth/reset-password');
        route.store.findRecord = (type, id) => Promise.resolve(`${type}:${id}`);

        const controller = {};
        await route.setupController(controller, { is_valid: true });

        assert.false(controller.isLinkInvalid);
        assert.strictEqual(controller.brand, 'brand:1');
    });

    test('setupController asks for the code only when the link did not carry it', async function (assert) {
        const route = this.owner.lookup('route:auth/reset-password');
        route.store.findRecord = () => Promise.resolve();

        const withCode = { code: '123456' };
        await route.setupController(withCode, { is_valid: true });
        assert.true(withCode.hasCodeFromLink);

        const withoutCode = {};
        await route.setupController(withoutCode, { is_valid: true });
        assert.false(withoutCode.hasCodeFromLink);
    });

    test('leaving the page forgets the passwords', function (assert) {
        const route = this.owner.lookup('route:auth/reset-password');
        let resets = 0;
        const controller = { reset: () => resets++ };

        route.resetController(controller, false);
        assert.strictEqual(resets, 0);

        route.resetController(controller, true);
        assert.strictEqual(resets, 1);
    });
});
