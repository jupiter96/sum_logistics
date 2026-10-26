import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';

module('Unit | Adapter | application', function (hooks) {
    setupTest(hooks);

    // The application adapter is re-exported from @sum_logistics/ember-core; this
    // asserts it resolves and is wired into the container.
    test('it resolves from the container', function (assert) {
        const adapter = this.owner.lookup('adapter:application');
        assert.ok(adapter);
        assert.strictEqual(typeof adapter.urlForFindRecord, 'function');
    });
});
