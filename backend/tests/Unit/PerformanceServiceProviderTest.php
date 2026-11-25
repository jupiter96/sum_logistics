<?php

namespace Tests\Unit;

use App\Database\MySqlConnection;
use App\Database\ReadBatcher;
use App\Database\ReadMemo;
use Illuminate\Routing\Events\PreparingResponse;
use sum_logistics\LaravelMysqlSpatial\MysqlConnection as SpatialMysqlConnection;
use Tests\TestCase;

/**
 * What PerformanceServiceProvider puts in place.
 */
class PerformanceServiceProviderTest extends TestCase
{
    public function test_mysql_connections_use_the_memo_and_stay_spatial(): void
    {
        // Connecting is deferred until the first query, so no server is needed.
        $connection = $this->app['db.factory']->make([
            'driver'    => 'mysql',
            'host'      => '127.0.0.1',
            'database'  => 'test',
            'username'  => 'test',
            'password'  => 'test',
            'charset'   => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
            'prefix'    => '',
        ], 'mysql');

        $this->assertInstanceOf(MySqlConnection::class, $connection);
        $this->assertInstanceOf(SpatialMysqlConnection::class, $connection);
        $this->assertSame('mysql', $connection->getName());
        $this->assertSame('test', $connection->getDatabaseName());
        $this->assertSame($this->app->make(ReadMemo::class), (new \ReflectionProperty($connection, 'readMemo'))->getValue($connection));
    }

    public function test_the_memo_learns_from_responses_while_it_is_enabled(): void
    {
        $batcher = new class () extends ReadBatcher {
            public array $learned = [];

            public function learn(string $source, array $rows): void
            {
                $this->learned[] = [$source, $rows];
            }
        };
        $memo  = $this->app->make(ReadMemo::class);
        $model = (new class () extends \Illuminate\Database\Eloquent\Model {
        })->forceFill(['uuid' => 'a']);

        event(new PreparingResponse(request(), [$model]));
        $memo->enable($batcher);
        event(new PreparingResponse(request(), [$model]));
        $memo->disable();

        $this->assertSame([[get_class($model), [['uuid' => 'a']]]], $batcher->learned);
    }
}
