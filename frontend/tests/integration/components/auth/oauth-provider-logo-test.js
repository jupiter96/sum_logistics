import { module, test } from 'qunit';
import { setupRenderingTest } from '@summit_logistics/console/tests/helpers';
import { render } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';

module('Integration | Component | auth/oauth-provider-logo', function (hooks) {
    setupRenderingTest(hooks);

    test('google gets its full-colour G, never a single-colour icon', async function (assert) {
        await render(hbs`<Auth::OauthProviderLogo @provider="google" @icon="google" />`);

        const fills = [...this.element.querySelectorAll('path')].map((path) => path.getAttribute('fill'));

        assert.deepEqual(fills, ['#EA4335', '#4285F4', '#FBBC05', '#34A853']);
        assert.dom('.svg-inline--fa').doesNotExist();
    });

    test('microsoft gets its four-colour logo', async function (assert) {
        await render(hbs`<Auth::OauthProviderLogo @provider="microsoft" @icon="microsoft" />`);

        const fills = [...this.element.querySelectorAll('rect')].map((rect) => rect.getAttribute('fill'));

        assert.deepEqual(fills, ['#F25022', '#7FBA00', '#00A4EF', '#FFB900']);
    });

    test('facebook gets its blue disc, with a white f in either theme', async function (assert) {
        await render(hbs`<Auth::OauthProviderLogo @provider="facebook" @icon="facebook" />`);

        assert.dom('.oauth-provider-logo-facebook path').hasAttribute('fill', '#0866FF');
        assert.dom('.oauth-provider-logo-facebook circle').hasAttribute('fill', '#FFFFFF');
        assert.dom('.svg-inline--fa').doesNotExist();
    });

    test('apple, github and any later provider use their brand icon', async function (assert) {
        await render(hbs`<Auth::OauthProviderLogo @provider="github" @icon="github" />`);

        assert.dom('.oauth-provider-logo-github .svg-inline--fa').exists();
    });

    test('it is hidden from screen readers; the button text names the provider', async function (assert) {
        await render(hbs`<Auth::OauthProviderLogo @provider="google" />`);

        assert.dom('.oauth-provider-logo').hasAttribute('aria-hidden', 'true');
    });
});
