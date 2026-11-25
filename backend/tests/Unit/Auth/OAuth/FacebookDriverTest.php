<?php

namespace Tests\Unit\Auth\OAuth;

use App\Auth\OAuth\Drivers\FacebookDriver;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Request as PsrRequest;
use GuzzleHttp\Psr7\Response;
use Illuminate\Http\Request;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use sum_logistics\Auth\OAuth\CredentialCheck;
use sum_logistics\Auth\OAuth\IdTokenVerifier;
use sum_logistics\Auth\OAuth\OAuthProviderConfig;

/**
 * Covers what Facebook does differently from the providers core-api ships: the profile
 * fields, the missing email verification and the shape of its errors.
 */
class FacebookDriverTest extends TestCase
{
    private const REDIRECT_URI = 'https://api.example.com/int/v1/auth/oauth/facebook/callback';

    /**
     * Requests sent through the last driver made by driver().
     *
     * @var array<int, array<string, mixed>>
     */
    private array $sent = [];

    /**
     * @param array<int, mixed>    $responses
     * @param array<string, mixed> $values
     */
    private function driver(array $responses = [], array $values = []): FacebookDriver
    {
        $this->sent = [];
        $stack      = HandlerStack::create(new MockHandler($responses));
        $stack->push(Middleware::history($this->sent));

        $config = new OAuthProviderConfig('facebook', array_merge([
            'enabled'       => true,
            'client_id'     => '1234567890',
            'client_secret' => 'app-secret',
        ], $values));

        $driver = new FacebookDriver($config, Request::create('/'), $this->createStub(IdTokenVerifier::class));

        return $driver->useHttpClient(new Client(['handler' => $stack]));
    }

    private function json(array $body, int $status = 200): Response
    {
        return new Response($status, ['Content-Type' => 'application/json'], json_encode($body));
    }

    /**
     * @return array<string, string>
     */
    private function sentForm(int $index): array
    {
        parse_str((string) $this->sent[$index]['request']->getBody(), $form);

        return $form;
    }

    public function test_describes_itself_to_the_console(): void
    {
        $this->assertSame('facebook', FacebookDriver::id());
        $this->assertSame('Facebook', FacebookDriver::label());
        $this->assertSame('facebook', FacebookDriver::icon());

        $schema = FacebookDriver::configSchema();

        // The admin form only accepts client_id and client_secret (SaveOAuthConfigRequest).
        $this->assertSame(['client_id', 'client_secret'], array_keys($schema));
        $this->assertTrue($schema['client_secret']['secret'], 'the app secret is stored encrypted');
        $this->assertArrayNotHasKey('secret', $schema['client_id']);
        $this->assertTrue($schema['client_id']['required']);
        $this->assertTrue($schema['client_secret']['required']);
    }

    public function test_is_offered_only_when_switched_on_with_both_credentials(): void
    {
        $this->assertTrue($this->driver()->isEnabled());
        $this->assertFalse($this->driver([], ['enabled' => false])->isEnabled());
        $this->assertFalse($this->driver([], ['client_id' => null])->isEnabled());
        $this->assertFalse($this->driver([], ['client_secret' => ''])->isEnabled());
    }

    public function test_authorization_url_carries_state_and_pkce_but_no_secret(): void
    {
        $url = $this->driver()->authorizationUrl('the-state', 'the-verifier', self::REDIRECT_URI);

        $this->assertStringStartsWith('https://www.facebook.com/v', $url);
        $this->assertStringContainsString('/dialog/oauth?', $url);

        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);

        $this->assertSame('1234567890', $query['client_id']);
        $this->assertSame(self::REDIRECT_URI, $query['redirect_uri']);
        $this->assertSame('code', $query['response_type']);
        $this->assertSame('public_profile,email', $query['scope']);
        $this->assertSame('the-state', $query['state']);
        $this->assertSame('S256', $query['code_challenge_method']);
        $this->assertSame(rtrim(strtr(base64_encode(hash('sha256', 'the-verifier', true)), '+/', '-_'), '='), $query['code_challenge']);
        $this->assertStringNotContainsString('app-secret', $url);
    }

    public function test_exchange_returns_a_profile_whose_email_is_not_verified(): void
    {
        $driver = $this->driver([
            $this->json(['access_token' => 'EAAG-token', 'token_type' => 'bearer', 'expires_in' => 5183944]),
            $this->json(['id' => '10158000000000001', 'name' => 'Jane Doe', 'email' => 'jane@example.com', 'picture' => ['data' => ['url' => 'https://example.com/jane.jpg']]]),
        ]);

        $profile = $driver->exchange('the-code', 'the-verifier', self::REDIRECT_URI);

        $this->assertSame('facebook', $profile->provider);
        $this->assertSame('10158000000000001', $profile->providerUserId);
        $this->assertSame('jane@example.com', $profile->email);
        $this->assertSame('Jane Doe', $profile->name);
        $this->assertSame('https://example.com/jane.jpg', $profile->avatar);
        $this->assertFalse($profile->emailVerified, 'Facebook does not say it verified the address');
        $this->assertFalse($profile->hasVerifiedEmail(), 'so it never links itself to an existing account');

        $token = $this->sentForm(0);
        $this->assertSame('POST', $this->sent[0]['request']->getMethod());
        $this->assertSame('the-code', $token['code']);
        $this->assertSame('the-verifier', $token['code_verifier']);
        $this->assertSame('app-secret', $token['client_secret']);
        $this->assertSame(self::REDIRECT_URI, $token['redirect_uri']);

        parse_str($this->sent[1]['request']->getUri()->getQuery(), $profileQuery);
        $this->assertSame('id,name,email,picture.width(256)', $profileQuery['fields'], 'only what is used');
        $this->assertSame(hash_hmac('sha256', 'EAAG-token', 'app-secret'), $profileQuery['appsecret_proof']);
    }

    public function test_exchange_accepts_a_person_who_shares_no_email(): void
    {
        $driver = $this->driver([
            $this->json(['access_token' => 'EAAG-token', 'token_type' => 'bearer']),
            $this->json(['id' => '10158000000000002', 'name' => 'No Email']),
        ]);

        $profile = $driver->exchange('the-code', 'the-verifier', self::REDIRECT_URI);

        $this->assertSame('10158000000000002', $profile->providerUserId);
        $this->assertNull($profile->email);
        $this->assertNull($profile->avatar);
    }

    public function test_credential_check_asks_for_an_app_token_in_the_request_body(): void
    {
        $driver = $this->driver([$this->json(['access_token' => '1234567890|abc', 'token_type' => 'bearer'])]);

        $this->assertSame(CredentialCheck::Verified, $driver->verifyCredentials(self::REDIRECT_URI));

        $request = $this->sent[0]['request'];
        $this->assertCount(1, $this->sent);
        $this->assertSame('POST', $request->getMethod());
        $this->assertSame('graph.facebook.com', $request->getUri()->getHost());
        $this->assertSame('', $request->getUri()->getQuery(), 'the secret never goes in a URL');
        $this->assertSame(['client_id' => '1234567890', 'client_secret' => 'app-secret', 'grant_type' => 'client_credentials'], $this->sentForm(0));
    }

    public static function refusals(): array
    {
        $error = fn (int $code, string $message, array $extra = []): array => ['error' => ['message' => $message, 'type' => 'OAuthException', 'code' => $code, 'fbtrace_id' => 'A1'] + $extra];

        return [
            // As graph.facebook.com answers an app id that does not exist.
            'unknown app id'         => [400, $error(101, 'Invalid Client ID'), CredentialCheck::InvalidClient],
            'wrong app secret'       => [400, $error(1, 'Error validating client secret.'), CredentialCheck::InvalidClient],
            'rate limited'           => [400, $error(4, 'Application request limit reached'), CredentialCheck::Unreachable],
            'temporary outage'       => [400, $error(2, 'Service temporarily unavailable'), CredentialCheck::Unreachable],
            'marked as transient'    => [400, $error(1, 'An unknown error occurred', ['is_transient' => true]), CredentialCheck::Unreachable],
            'some other refusal'     => [400, $error(5, "This IP can't make requests for that application."), CredentialCheck::Inconclusive],
            'an error with no code'  => [400, ['error' => 'invalid_client'], CredentialCheck::Inconclusive],
            'not json'               => [403, [], CredentialCheck::Inconclusive],
            'a failure at Facebook'  => [503, [], CredentialCheck::Unreachable],
            'success without token'  => [200, ['token_type' => 'bearer'], CredentialCheck::Inconclusive],
        ];
    }

    #[DataProvider('refusals')]
    public function test_credential_check_reads_facebook_errors(int $status, array $body, CredentialCheck $expected): void
    {
        $driver = $this->driver([$this->json($body, $status)]);

        $this->assertSame($expected, $driver->verifyCredentials(self::REDIRECT_URI));
    }

    public function test_credential_check_without_a_network_or_a_secret(): void
    {
        $offline = $this->driver([new ConnectException('Could not resolve host', new PsrRequest('POST', 'https://graph.facebook.com'))]);
        $this->assertSame(CredentialCheck::Unreachable, $offline->verifyCredentials(self::REDIRECT_URI));

        $this->assertSame(CredentialCheck::InvalidClient, $this->driver([], ['client_secret' => null])->verifyCredentials(self::REDIRECT_URI));
    }
}
