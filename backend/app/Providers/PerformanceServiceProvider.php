<?php

namespace App\Providers;

use App\Database\MySqlConnection;
use App\Database\ReadBatcher;
use App\Database\ReadMemo;
use App\Http\Middleware\StartSession;
use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Routing\Events\PreparingResponse;
use Illuminate\Session\Middleware\StartSession as BaseStartSession;
use Illuminate\Session\SessionManager;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\ServiceProvider;

/**
 * Wires up what config/performance.php describes.
 */
class PerformanceServiceProvider extends ServiceProvider
{
    public function register()
    {
        $this->app->singleton(ReadMemo::class);
        $this->app->singleton(ReadBatcher::class);

        // core-api's connection factory builds MySQL connections from this when bound.
        $this->app->bind('db.connection.mysql', function ($app, array $parameters) {
            return (new MySqlConnection(...array_values($parameters)))->useReadMemo($app->make(ReadMemo::class));
        });

        $this->app->singleton(BaseStartSession::class, function ($app) {
            return new StartSession($app->make(SessionManager::class), fn () => $app->make(CacheFactory::class));
        });
    }

    public function boot()
    {
        // Resolved here so that every request a worker serves shares the same two.
        $memo = $this->app->make(ReadMemo::class);
        $this->app->make(ReadBatcher::class);

        Event::listen(PreparingResponse::class, fn (PreparingResponse $event) => $memo->learnFrom($event->response));
    }
}
