<?php

namespace Tests\Unit\Database;

use App\Database\ReadBatcher;
use App\Database\ReadMemo;
use Illuminate\Container\Container;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Database\QueryException;
use PHPUnit\Framework\TestCase;

/**
 * Repeated SELECTs are answered from memory within a request; lookups made row by row are
 * batched, and every answer is the one its own statement would have given.
 */
class ReadMemoTest extends TestCase
{
    private ReadMemo $memo;

    private ReadBatcher $batcher;

    /** @var array<int, array{0: string, 1: array<int, mixed>}> what reached the database */
    private array $ran = [];

    /** @var array<string, array<int, object>> table => rows */
    private array $tables = [];

    protected function setUp(): void
    {
        parent::setUp();

        $this->memo    = new ReadMemo();
        $this->batcher = new ReadBatcher();

        foreach (range(1, 5) as $i) {
            $this->tables['orders'][]   = (object) ['uuid' => $this->uuid($i), 'payload_uuid' => $this->uuid(100 + $i), 'company_uuid' => $this->uuid(999)];
            $this->tables['payloads'][] = (object) ['uuid' => $this->uuid(100 + $i), 'name' => "Payload $i"];
            foreach (range(1, 2) as $j) {
                $this->tables['entities'][] = (object) ['uuid' => $this->uuid(200 + 10 * $i + $j), 'payload_uuid' => $this->uuid(100 + $i), 'created_at' => "2026-01-0$j 00:00:00"];
            }
        }
    }

    private function uuid(int $n): string
    {
        return sprintf('00000000-0000-4000-8000-%012d', $n);
    }

    /**
     * A database that understands `select … from table where column = ? | in (…)`.
     */
    private function select(string $sql, array $bindings = []): array
    {
        return $this->memo->remember('mysql', $sql, $bindings, function (string $sql, array $bindings) {
            $this->ran[] = [$sql, $bindings];
            preg_match('/from `(\w+)`(?: where `(?:\w+`\.`)?(\w+)` (?:=|in))?/', $sql, $parts);
            $rows = array_map(fn ($row) => clone $row, $this->tables[$parts[1]]);

            if (isset($parts[2])) {
                $rows = array_values(array_filter($rows, fn ($row) => in_array($row->{$parts[2]}, $bindings, true)));
            }
            if (str_contains($sql, 'count(*)')) {
                $counts = array_count_values(array_column($rows, $parts[2]));
                if (!str_contains($sql, 'group by')) {
                    return [(object) ['aggregate' => count($rows)]];
                }

                return array_map(fn ($key, $n) => (object) ['batched_key' => $key, 'aggregate' => $n], array_keys($counts), $counts);
            }

            return preg_match('/limit (\d+)$/', $sql, $limit) ? array_slice($rows, 0, (int) $limit[1]) : $rows;
        });
    }

    private function orders(): array
    {
        return $this->select('select * from `orders`');
    }

    private function payload(string $uuid): array
    {
        return $this->select('select * from `payloads` where `payloads`.`uuid` = ? limit 1', [$uuid]);
    }

    public function test_off_until_enabled_and_after_disabled(): void
    {
        $this->orders();
        $this->orders();
        $this->assertCount(2, $this->ran);

        $this->memo->enable();
        $this->orders();
        $this->memo->disable();
        $this->orders();
        $this->assertCount(4, $this->ran);
    }

    public function test_a_repeated_statement_runs_once(): void
    {
        $this->memo->enable();
        $first = $this->orders();

        $this->assertEquals($first, $this->orders());
        $this->assertCount(1, $this->ran);
        $this->assertSame(1, $this->memo->hits());
    }

    public function test_changing_a_row_does_not_change_the_memo(): void
    {
        $this->memo->enable();
        $this->orders()[0]->uuid = 'changed';
        $this->orders()[0]->uuid = 'changed again';

        $this->assertSame($this->uuid(1), $this->orders()[0]->uuid);
    }

    public function test_bindings_and_connection_tell_statements_apart(): void
    {
        $this->memo->enable();
        $run = fn () => [(object) ['n' => count($this->ran)]];

        foreach ([['a', [1]], ['a', ['1']], ['a', [true]], ['a', [null]], ['a', ['']], ['a', ['1', '1']], ['a', ['11']], ['b', [1]]] as [$connection, $bindings]) {
            $this->memo->remember($connection, 'select * from `t` where `x` = ?', $bindings, function () use ($run) {
                $this->ran[] = ['', []];

                return $run();
            });
        }

        $this->assertCount(8, $this->ran);
    }

    public function test_some_statements_are_never_repeated(): void
    {
        $this->memo->enable();

        foreach (['select uuid() as x', 'select rand() as x', 'select * from `t` for update', 'select * from `t` lock in share mode', 'show tables', 'insert into `t` values (1)'] as $sql) {
            foreach ([1, 2] as $_) {
                $this->memo->remember('mysql', $sql, [], function () {
                    $this->ran[] = ['', []];

                    return [];
                });
            }
        }

        $this->assertCount(12, $this->ran);
    }

    public function test_flush_forgets_rows_but_not_the_schema(): void
    {
        $this->memo->enable();
        $schema = fn () => $this->memo->remember('mysql', 'select * from information_schema.tables where table_name = ?', ['orders'], function () {
            $this->ran[] = ['schema', []];

            return [(object) ['table_name' => 'orders']];
        });

        $schema();
        $this->orders();
        $this->memo->flush();
        $schema();
        $this->orders();

        $this->assertSame(['schema', 'select * from `orders`', 'select * from `orders`'], array_column($this->ran, 0));
    }

    public function test_a_table_that_was_not_there_is_looked_up_again(): void
    {
        $this->memo->enable();
        $rows = [[], [(object) ['table_name' => 'orders']]];
        $next = function () use (&$rows) {
            return array_shift($rows) ?? [];
        };
        $ask = fn () => $this->memo->remember('mysql', 'select * from information_schema.tables', [], $next);

        $this->assertSame([], $ask());
        $this->assertCount(1, $ask());
    }

    public function test_the_second_lookup_is_made_for_the_rest_of_the_list(): void
    {
        $this->memo->enable($this->batcher);

        foreach ($this->orders() as $i => $order) {
            $this->assertSame('Payload ' . ($i + 1), $this->payload($order->payload_uuid)[0]->name);
        }

        $this->assertSame([
            ['select * from `orders`', []],
            ['select * from `payloads` where `payloads`.`uuid` = ? limit 1', [$this->uuid(101)]],
            ['select * from `payloads` where `payloads`.`uuid` in (?, ?, ?, ?)', [$this->uuid(102), $this->uuid(103), $this->uuid(104), $this->uuid(105)]],
        ], $this->ran);
        $this->assertSame(1, $this->batcher->batches());
    }

    public function test_one_lookup_stays_one_lookup(): void
    {
        $this->memo->enable($this->batcher);
        $this->payload($this->orders()[0]->payload_uuid);

        $this->assertSame([$this->uuid(101)], $this->ran[1][1]);
    }

    public function test_keys_that_do_not_exist_are_answered_too(): void
    {
        $this->tables['payloads'] = array_slice($this->tables['payloads'], 0, 3);
        $this->memo->enable($this->batcher);

        $found = array_map(fn ($order) => count($this->payload($order->payload_uuid)), $this->orders());

        $this->assertSame([1, 1, 1, 0, 0], $found);
        $this->assertCount(3, $this->ran);
    }

    public function test_children_keep_their_order(): void
    {
        $this->memo->enable($this->batcher);

        foreach ($this->orders() as $order) {
            $rows = $this->select('select * from `entities` where `entities`.`payload_uuid` = ? order by `created_at` asc', [$order->payload_uuid]);
            $this->assertSame(['2026-01-01 00:00:00', '2026-01-02 00:00:00'], array_column($rows, 'created_at'));
        }

        $this->assertCount(3, $this->ran);
    }

    public function test_children_that_tie_are_asked_for_one_by_one(): void
    {
        foreach ($this->tables['entities'] as $entity) {
            $entity->created_at = '2026-01-01 00:00:00';
        }
        $this->memo->enable($this->batcher);

        foreach ($this->orders() as $order) {
            $this->select('select * from `entities` where `entities`.`payload_uuid` = ? order by `created_at` asc', [$order->payload_uuid]);
        }

        $single = array_filter($this->ran, fn ($statement) => str_contains($statement[0], '`payload_uuid` = ?'));
        $this->assertCount(5, $single);
    }

    public function test_counts(): void
    {
        $this->tables['entities'] = array_slice($this->tables['entities'], 0, 7);
        $this->memo->enable($this->batcher);

        $counts = array_map(
            fn ($order) => $this->select('select count(*) as aggregate from `entities` where `entities`.`payload_uuid` = ?', [$order->payload_uuid])[0]->aggregate,
            $this->orders()
        );

        $this->assertSame([2, 2, 2, 1, 0], $counts);
        $this->assertCount(3, $this->ran);
    }

    public function test_a_lookup_by_a_name_with_a_uuid_in_it(): void
    {
        $this->tables['settings'] = array_map(fn ($i) => (object) ['key' => 'user.' . $this->uuid($i) . '.locale', 'value' => "$i"], range(1, 5));
        $this->memo->enable($this->batcher);

        foreach ($this->orders() as $i => $order) {
            $this->assertSame((string) ($i + 1), $this->select('select * from `settings` where `key` = ? limit 1', ["user.{$order->uuid}.locale"])[0]->value);
        }

        $this->assertCount(3, $this->ran);
        $this->assertSame('select * from `settings` where `key` in (?, ?, ?, ?) limit 17', $this->ran[2][0]);
    }

    public function test_one_of_several_rows_is_asked_for_by_itself(): void
    {
        $this->memo->enable($this->batcher);
        $sql = 'select * from `entities` where `entities`.`payload_uuid` = ? limit 1';

        foreach ($this->orders() as $i => $order) {
            $this->assertSame($this->uuid(200 + 10 * ($i + 1) + 1), $this->select($sql, [$order->payload_uuid])[0]->uuid);
        }

        $this->assertCount(5, array_filter($this->ran, fn ($statement) => $statement[0] === $sql));
    }

    public function test_a_key_the_database_matches_loosely_is_not_batched(): void
    {
        // As with a case-insensitive collation: the row found has another spelling.
        $this->memo->enable($this->batcher);
        $orders = $this->orders();
        $asked  = [];

        foreach ($orders as $order) {
            $rows = $this->memo->remember('mysql', 'select * from `payloads` where `uuid` = ? limit 1', [$order->payload_uuid], function ($sql, $bindings) use (&$asked) {
                $asked[] = $bindings;

                return array_map(fn ($uuid) => (object) ['uuid' => strtoupper($uuid) . 'X'], $bindings);
            });
            $this->assertSame(strtoupper($order->payload_uuid) . 'X', $rows[0]->uuid);
        }

        $this->assertSame([1, 4, 1, 1, 1, 1], array_map('count', $asked));
    }

    public function test_when_a_batch_fails_every_lookup_runs_as_it_was_written(): void
    {
        $before    = Container::getInstance();
        $container = Container::setInstance(new Container());
        $reported  = [];
        $handler   = $this->createMock(ExceptionHandler::class);
        $handler->method('report')->willReturnCallback(function ($e) use (&$reported) {
            $reported[] = $e->getMessage();
        });
        $container->instance(ExceptionHandler::class, $handler);

        try {
            $this->memo->enable($this->batcher);

            foreach ($this->orders() as $order) {
                $rows = $this->memo->remember('mysql', 'select * from `payloads` where `uuid` = ? limit 1', [$order->payload_uuid], function ($sql, $bindings) {
                    return count($bindings) > 1
                        ? throw new QueryException('mysql', $sql, $bindings, new \Exception('no such thing'))
                        : [(object) ['uuid' => $bindings[0]]];
                });
                $this->assertSame($order->payload_uuid, $rows[0]->uuid);
            }
        } finally {
            Container::setInstance($before);
        }

        $this->assertCount(1, $reported, 'Once, and no batch is tried again in this request.');
    }

    public function test_a_write_empties_it_and_batches_start_over(): void
    {
        $this->memo->enable($this->batcher);
        $orders = $this->orders();
        $this->payload($orders[0]->payload_uuid);
        $this->payload($orders[1]->payload_uuid);

        $this->tables['payloads'][2]->name = 'Renamed';
        $this->memo->flush();

        $this->assertSame('Renamed', $this->payload($orders[2]->payload_uuid)[0]->name);
    }

    public function test_a_request_that_keeps_writing_is_not_read_ahead_for(): void
    {
        $this->memo->enable($this->batcher);

        foreach ($this->orders() as $order) {
            $this->payload($order->payload_uuid);
            $this->memo->flush();
        }

        $this->assertLessThanOrEqual(2, $this->batcher->batches());
        $this->assertSame([$this->uuid(105)], end($this->ran)[1]);
    }

    public function test_large_children_are_asked_for_in_smaller_batches(): void
    {
        $this->tables['entities'] = [];
        foreach (range(1, 5) as $i) {
            foreach (range(1, 400) as $j) {
                $this->tables['entities'][] = (object) ['uuid' => $this->uuid(10000 * $i + $j), 'payload_uuid' => $this->uuid(100 + $i)];
            }
        }
        $this->memo->enable($this->batcher);

        foreach ($this->orders() as $order) {
            $this->assertCount(400, $this->select('select * from `entities` where `entities`.`payload_uuid` = ?', [$order->payload_uuid]));
        }

        $this->assertSame([0, 1, 2, 2], array_map(fn ($statement) => count($statement[1]), $this->ran));
    }

    public function test_nothing_carries_over_to_the_next_request(): void
    {
        $this->memo->enable($this->batcher);
        $orders = $this->orders();
        $this->payload($orders[0]->payload_uuid);
        $this->payload($orders[1]->payload_uuid);
        $this->memo->disable();

        $this->ran = [];
        $this->memo->enable($this->batcher);
        $this->payload($orders[2]->payload_uuid);

        $this->assertSame([[$this->uuid(103)]], array_column($this->ran, 1));
        $this->assertSame(0, $this->batcher->batches());
    }
}
