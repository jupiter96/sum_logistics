import { module, test } from 'qunit';
import { setupTest } from '@summit_logistics/console/tests/helpers';

module('Unit | Route | virtual/index', function (hooks) {
    setupTest(hooks);

    // The theme service sets the current (leaf) route's body classes, and `body.virtual`
    // is what lets a public page scroll.
    test('public pages keep the virtual body class, with or without a nested path', function (assert) {
        assert.deepEqual(this.owner.lookup('route:virtual/index').bodyClassNames, ['virtual']);
        assert.deepEqual(this.owner.lookup('route:virtual/path').bodyClassNames, ['virtual']);
    });
});
