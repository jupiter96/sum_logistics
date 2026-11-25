<?php

namespace Tests\Unit\Http\Middleware;

use App\Http\Middleware\StartSession;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Session\Middleware\StartSession as BaseStartSession;
use Tests\TestCase;

/**
 * API clients that send a token and no session cookie get a session for the request only.
 */
class StartSessionTest extends TestCase
{
    /**
     * Send a request through the middleware.
     *
     * @return array{cookie: bool, stored: bool} whether a cookie was set, and the session stored
     */
    private function send(string $uri, array $headers = [], bool $withCookie = false): array
    {
        $session = $this->app['session']->driver();
        $handler = $session->getHandler();
        $session->flush();
        $session->setId(null);

        $request = Request::create($uri, 'GET', [], $withCookie ? [config('session.cookie') => str_repeat('a', 40)] : []);
        $request->headers->add($headers);
        $this->app->instance('request', $request);

        $response = $this->app->make(BaseStartSession::class)->handle($request, function (Request $request) {
            // What core-api does: the session has to work while the request runs.
            $request->session()->put('company', 'company-uuid');
            $this->assertSame('company-uuid', session('company'));

            return new Response();
        });

        $this->assertSame($handler, $session->getHandler(), 'The next request of this worker stores its session again.');

        return [
            'cookie' => collect($response->headers->getCookies())->contains(fn ($cookie) => $cookie->getName() === config('session.cookie')),
            'stored' => $handler->read($session->getId()) !== '',
        ];
    }

    public function test_core_api_gets_this_middleware(): void
    {
        $this->assertInstanceOf(StartSession::class, $this->app->make(BaseStartSession::class));
    }

    public function test_a_public_request_with_a_token_stores_nothing(): void
    {
        $this->assertSame(['cookie' => false, 'stored' => false], $this->send('/v1/orders', ['Authorization' => 'Bearer flb_live_x']));
        $this->assertSame(['cookie' => false, 'stored' => false], $this->send('/storefront/v1/products', ['Authorization' => 'Bearer flb_live_x']));
    }

    public function test_basic_authentication_counts_as_a_token(): void
    {
        $this->assertSame(['cookie' => false, 'stored' => false], $this->send('/v1/orders', ['PHP_AUTH_USER' => 'flb_live_x', 'Authorization' => 'Basic ' . base64_encode('flb_live_x:')]));
    }

    public function test_the_console_keeps_its_session(): void
    {
        $stored = ['cookie' => true, 'stored' => true];

        $this->assertSame($stored, $this->send('/int/v1/users/me', ['Authorization' => 'Bearer 1|token']));
        $this->assertSame($stored, $this->send('/v1/orders', ['Authorization' => 'Bearer flb_live_x'], true), 'A client that sends the cookie back');
        $this->assertSame($stored, $this->send('/v1/orders'), 'A client without a token');
        $this->assertSame($stored, $this->send('/auth/something', ['Authorization' => 'Bearer x']), 'Not an API route');
    }

    public function test_it_can_be_switched_off(): void
    {
        config(['performance.stateless_api_sessions' => false]);

        $this->assertSame(['cookie' => true, 'stored' => true], $this->send('/v1/orders', ['Authorization' => 'Bearer flb_live_x']));
    }
}
