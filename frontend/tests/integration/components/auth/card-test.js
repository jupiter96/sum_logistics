import { module, test } from 'qunit';
import { setupRenderingTest } from '@summit_logistics/console/tests/helpers';
import { render } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';

module('Integration | Component | auth/card', function (hooks) {
    setupRenderingTest(hooks);

    test('it shows the title, subtitle, icon and content', async function (assert) {
        await render(hbs`<Auth::Card @title="Forgot your password?" @subtitle="We will send you a link." @icon="lock" data-test-card><p data-test-content>Form</p></Auth::Card>`);

        assert.dom('[data-test-card] h2').hasText('Forgot your password?');
        assert.dom('[data-test-card]').containsText('We will send you a link.');
        assert.dom('[data-test-card] .fa-lock').exists();
        assert.dom('[data-test-card] [data-test-content]').hasText('Form');
    });

    test('the subtitle and icon are optional', async function (assert) {
        await render(hbs`<Auth::Card @title="Sign in" data-test-card />`);

        assert.dom('[data-test-card] h2').hasText('Sign in');
        assert.dom('[data-test-card] p').doesNotExist();
        assert.dom('[data-test-card] .svg-inline--fa').doesNotExist();
    });
});
