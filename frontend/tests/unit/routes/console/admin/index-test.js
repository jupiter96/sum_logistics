import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';

module('Unit | Route | console/admin/index', function (hooks) {
    setupTest(hooks);

    test('it exists', function (assert) {
        let route = this.owner.lookup('route:console/admin/index');
        assert.ok(route);
    });
});
