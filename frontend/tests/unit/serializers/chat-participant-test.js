import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';

module('Unit | Serializer | chat-participant', function (hooks) {
    setupTest(hooks);

    test('serialize keeps scalar attributes', function (assert) {
        const store = this.owner.lookup('service:store');
        const json = store.createRecord('chat-participant', { name: 'Jane', email: 'jane@example.org' }).serialize();

        assert.strictEqual(json.name, 'Jane');
        assert.strictEqual(json.email, 'jane@example.org');
    });
});
