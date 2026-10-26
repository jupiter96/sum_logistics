import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';

module('Unit | Route | console/account', function (hooks) {
    setupTest(hooks);

    test('it exists', function (assert) {
        let route = this.owner.lookup('route:console/account');
        assert.ok(route);
    });
});
