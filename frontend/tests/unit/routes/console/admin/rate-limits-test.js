import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';

module('Unit | Route | console/admin/rate-limits', function (hooks) {
    setupTest(hooks);

    test('it exists', function (assert) {
        let route = this.owner.lookup('route:console/admin/rate-limits');
        assert.ok(route);
    });
});
