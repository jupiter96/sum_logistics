import { module, test } from 'qunit';
import { initialize } from '@summit_logistics/console/instance-initializers/initialize-registries';

module('Unit | Instance Initializer | initialize-registries', function () {
    test('it creates the console registries', function (assert) {
        let created;
        const appInstance = {
            lookup(name) {
                assert.strictEqual(name, 'service:universe/registry-service');
                return {
                    createRegistries(registries) {
                        created = registries;
                    },
                };
            },
        };

        initialize(appInstance);

        assert.ok(created.includes('@summit_logistics/console'), 'the console registry is created');
        assert.ok(created.includes('auth:login'), 'the login registry is created');
        assert.ok(
            created.every((name) => typeof name === 'string'),
            'every registry is named with a string'
        );
        assert.strictEqual(new Set(created).size, created.length, 'no registry is registered twice');
    });
});
