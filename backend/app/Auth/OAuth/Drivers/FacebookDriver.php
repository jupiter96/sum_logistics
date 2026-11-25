<?php

namespace App\Auth\OAuth\Drivers;

use App\Auth\OAuth\Socialite\FacebookProvider;
use GuzzleHttp\Exception\GuzzleException;
use GuzzleHttp\Exception\RequestException;
use Laravel\Socialite\Two\User as SocialiteUser;
use sum_logistics\Auth\OAuth\AbstractOAuthProviderDriver;
use sum_logistics\Auth\OAuth\CredentialCheck;
use sum_logistics\Auth\OAuth\Exceptions\OAuthProviderNotConfiguredException;
use sum_logistics\Auth\OAuth\OAuthUserProfile;

/**
 * Facebook Login.
 *
 * Registered in config/oauth-providers.php. Everything else - routes, the sign-in button,
 * the admin form, account linking - comes from core-api's provider registry.
 */
class FacebookDriver extends AbstractOAuthProviderDriver
{
    /**
     * Graph API error codes for a wrong app secret (1) or an app id Facebook does not
     * know (101).
     */
    private const INVALID_CLIENT_CODES = [1, 101];

    /**
     * Graph API error codes for an outage (2) or a rate limit (4, 17, 341, 613). They say
     * nothing about the credentials.
     */
    private const TEMPORARY_CODES = [2, 4, 17, 341, 613];

    public static function id(): string
    {
        return 'facebook';
    }

    public static function label(): string
    {
        return 'Facebook';
    }

    public static function icon(): string
    {
        return 'facebook';
    }

    public static function configSchema(): array
    {
        return [
            'client_id' => [
                'label'       => 'App ID',
                'placeholder' => '1234567890123456',
                'required'    => true,
                'help'        => 'Facebook gives each person a different ID per app. Switching to another app later unlinks everyone who signs in with Facebook.',
            ],
            'client_secret' => [
                'label'       => 'App Secret',
                'placeholder' => '32-character app secret',
                'secret'      => true,
                'required'    => true,
            ],
        ];
    }

    protected function socialiteProviderClass(): string
    {
        return FacebookProvider::class;
    }

    protected function scopes(): array
    {
        return ['public_profile', 'email'];
    }

    protected function normalize(SocialiteUser $user, array $callbackPayload): OAuthUserProfile
    {
        return new OAuthUserProfile(
            self::id(),
            (string) $user->getId(),
            $user->getEmail(),
            // Facebook returns an address without saying whether it verified it, and an
            // unknown verification state is never "verified". So a Facebook sign-in does
            // not link itself to an existing account with the same address: that person
            // signs in once and links Facebook from their account settings.
            false,
            $user->getName(),
            $user->getAvatar()
        );
    }

    /**
     * Facebook reports errors as an object with a numeric code rather than an RFC 6749
     * error string, so the shared check cannot tell bad credentials from a refused code.
     * This asks for an app access token instead, which only valid credentials get.
     *
     * It does not cover the callback URL: Facebook checks that in the browser.
     */
    public function verifyCredentials(string $redirectUri): CredentialCheck
    {
        try {
            /** @var FacebookProvider $provider */
            $provider = $this->build($redirectUri);
            $response = $provider->requestAppAccessToken();
        } catch (OAuthProviderNotConfiguredException $e) {
            return CredentialCheck::InvalidClient;
        } catch (RequestException $e) {
            return $this->classifyRefusal($e);
        } catch (GuzzleException $e) {
            return CredentialCheck::Unreachable;
        }

        $token = $response['access_token'] ?? null;

        return is_string($token) && $token !== '' ? CredentialCheck::Verified : CredentialCheck::Inconclusive;
    }

    private function classifyRefusal(RequestException $e): CredentialCheck
    {
        $response = $e->getResponse();
        $status   = $response?->getStatusCode() ?? 0;

        if ($status < 400 || $status >= 500) {
            return CredentialCheck::Unreachable;
        }

        $body  = json_decode((string) $response->getBody(), true);
        $error = is_array($body) && is_array($body['error'] ?? null) ? $body['error'] : [];
        $code  = $error['code'] ?? null;

        if (($error['is_transient'] ?? false) === true || in_array($code, self::TEMPORARY_CODES, true)) {
            return CredentialCheck::Unreachable;
        }

        return in_array($code, self::INVALID_CLIENT_CODES, true) ? CredentialCheck::InvalidClient : CredentialCheck::Inconclusive;
    }
}
