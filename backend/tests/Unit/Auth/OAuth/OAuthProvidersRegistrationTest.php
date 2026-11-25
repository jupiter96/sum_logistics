<?php

namespace Tests\Unit\Auth\OAuth;

use App\Auth\OAuth\Drivers\FacebookDriver;
use App\Providers\AppServiceProvider;
use sum_logistics\Auth\OAuth\OAuthProviderRegistry;
use Tests\TestCase;

/**
 * Covers AppServiceProvider::registerOAuthProviders(): Facebook joins the providers
 * core-api ships and replaces none of them.
 */
class OAuthProvidersRegistrationTest extends TestCase
{
    public function test_facebook_is_offered_next_to_the_providers_core_api_ships(): void
    {
        $ids = array_column($this->app->make(OAuthProviderRegistry::class)->definitions(), 'id');

        foreach (['facebook', 'google', 'microsoft', 'github', 'apple'] as $id) {
            $this->assertContains($id, $ids);
        }
        $this->assertSame(FacebookDriver::class, config('oauth.providers.facebook.driver'));
    }

    public function test_the_rest_of_the_oauth_config_is_left_alone(): void
    {
        $this->assertNotNull(config('oauth.ttl.handoff'));
        $this->assertNotNull(config('oauth.console_callback_path'));
    }

    public function test_a_provider_core_api_defines_under_the_same_id_wins(): void
    {
        config(['oauth.providers.facebook' => ['driver' => 'CoreApiFacebookDriver']]);

        (new AppServiceProvider($this->app))->boot();

        $this->assertSame('CoreApiFacebookDriver', config('oauth.providers.facebook.driver'));
    }
}
