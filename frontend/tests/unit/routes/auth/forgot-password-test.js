import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';

module('Unit | Route | auth/forgot-password', function (hooks) {
    setupTest(hooks);

    test('the email query param does not refresh the model', function (assert) {
        const route = this.owner.lookup('route:auth/forgot-password');

        assert.deepEqual(Object.keys(route.queryParams), ['email']);
        assert.false(route.queryParams.email.refreshModel);
    });

    test('leaving the page clears the form, a change of email in the URL does not', function (assert) {
        const route = this.owner.lookup('route:auth/forgot-password');
        let resets = 0;
        const controller = { reset: () => resets++ };

        route.resetController(controller, false);
        assert.strictEqual(resets, 0);

        route.resetController(controller, true);
        assert.strictEqual(resets, 1);
    });
});
