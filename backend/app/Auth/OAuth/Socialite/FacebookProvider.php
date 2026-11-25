<?php

namespace App\Auth\OAuth\Socialite;

use GuzzleHttp\RequestOptions;
use Laravel\Socialite\Two\FacebookProvider as BaseFacebookProvider;
use sum_logistics\Auth\OAuth\Socialite\Concerns\ServerSidePkce;

/**
 * Socialite's Facebook provider, driven from server-side state instead of the session.
 */
class FacebookProvider extends BaseFacebookProvider
{
    use ServerSidePkce;

    /**
     * The profile fields to ask the Graph API for.
     *
     * Narrower than Socialite's default, which also asks for gender and the profile link:
     * neither is used here, and both need permissions this app does not request.
     *
     * @var array<int, string>
     */
    protected $fields = ['id', 'name', 'email', 'picture.width(256)'];

    /**
     * Ask Facebook for an access token for the app itself, not for a person.
     *
     * Facebook issues one only when the app id and secret are right, which makes it the
     * way to check them without signing anyone in. The credentials go in the request
     * body, so they cannot end up in a URL in a log.
     *
     * @return array<string, mixed>
     */
    public function requestAppAccessToken(): array
    {
        $response = $this->getHttpClient()->post($this->getTokenUrl(), [
            RequestOptions::FORM_PARAMS => [
                'client_id'     => $this->clientId,
                'client_secret' => $this->clientSecret,
                'grant_type'    => 'client_credentials',
            ],
        ]);

        $data = json_decode((string) $response->getBody(), true);

        return is_array($data) ? $data : [];
    }
}
