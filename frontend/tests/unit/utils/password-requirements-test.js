import { module, test } from 'qunit';
import passwordRequirements from '@summit_logistics/console/utils/password-requirements';

function met(password) {
    return passwordRequirements(password)
        .filter(({ isMet }) => isMet)
        .map(({ key }) => key);
}

module('Unit | Utility | password-requirements', function () {
    test('lists every requirement, in order, met or not', function (assert) {
        assert.deepEqual(
            passwordRequirements('').map(({ key }) => key),
            ['length', 'mixed-case', 'number', 'symbol']
        );
        assert.deepEqual(met(''), []);
        assert.deepEqual(met(undefined), [], 'nothing typed yet');
        assert.deepEqual(met(null), []);
    });

    test('each requirement is met on its own', function (assert) {
        assert.deepEqual(met('abcdefgh'), ['length']);
        assert.deepEqual(met('abcdefg'), [], '7 characters are not enough');
        assert.deepEqual(met('aB'), ['mixed-case']);
        assert.deepEqual(met('AB'), [], 'both cases are needed');
        assert.deepEqual(met('7'), ['number']);
        assert.deepEqual(met('!'), ['symbol']);
        assert.deepEqual(met(' '), ['symbol'], 'a space counts, as it does on the server');
    });

    test('a password that meets them all', function (assert) {
        assert.deepEqual(met('Tr0ub4dor&3'), ['length', 'mixed-case', 'number', 'symbol']);
    });

    test('letters, numbers and symbols of any script count, as they do on the server', function (assert) {
        assert.deepEqual(met('éÉ'), ['mixed-case']);
        assert.deepEqual(met('한글'), [], 'a script without case has neither upper nor lower');
        assert.deepEqual(met('٣'), ['number']);
        assert.deepEqual(met('€'), ['symbol']);
        assert.deepEqual(met('😀😀😀😀'), ['symbol'], 'an emoji is one character, not two');
    });
});
