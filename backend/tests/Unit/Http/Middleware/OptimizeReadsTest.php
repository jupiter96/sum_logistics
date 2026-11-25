<?php

namespace Tests\Unit\Http\Middleware;

use App\Database\ReadMemo;
use App\Http\Middleware\OptimizeReads;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Tests\TestCase;

/**
 * Reads are optimized while an API GET request is served, and at no other time.
 */
class OptimizeReadsTest extends TestCase
{
    private function isEnabledDuring(string $method, string $uri): bool
    {
        $enabled = null;

        $this->app->make(OptimizeReads::class)->handle(Request::create($uri, $method), function () use (&$enabled) {
            $enabled = $this->app->make(ReadMemo::class)->isEnabled();

            return new Response();
        });

        $this->assertFalse($this->app->make(ReadMemo::class)->isEnabled(), 'Nothing carries over to the next request.');

        return $enabled;
    }

    public function test_only_api_reads_are_optimized(): void
    {
        $expected = [
            'GET /v1/orders'              => true,
            'GET /v1/orders/order_1'      => true,
            'HEAD /v1/orders'             => true,
            'GET /int/v1/orders'          => true,
            'GET /storefront/v1/products' => true,
            'POST /v1/orders'             => false,
            'PUT /v1/orders/order_1'      => false,
            'PATCH /v1/orders/order_1'    => false,
            'DELETE /v1/orders/order_1'   => false,
            'GET /health'                 => false,
            'GET /v10/orders'             => false,
        ];

        foreach ($expected as $request => $enabled) {
            $this->assertSame($enabled, $this->isEnabledDuring(...explode(' ', $request)), $request);
        }
    }

    public function test_it_can_be_switched_off(): void
    {
        config(['performance.memoize_reads' => false]);

        $this->assertFalse($this->isEnabledDuring('GET', '/v1/orders'));
    }

    public function test_a_failing_request_leaves_nothing_behind(): void
    {
        try {
            $this->app->make(OptimizeReads::class)->handle(Request::create('/v1/orders'), fn () => throw new \RuntimeException('failed'));
            $this->fail('Expected the exception to be passed on.');
        } catch (\RuntimeException) {
        }

        $this->assertFalse($this->app->make(ReadMemo::class)->isEnabled());
    }

    public function test_every_request_goes_through_it(): void
    {
        $this->assertTrue($this->app->make(\Illuminate\Contracts\Http\Kernel::class)->hasMiddleware(OptimizeReads::class));
    }
}
