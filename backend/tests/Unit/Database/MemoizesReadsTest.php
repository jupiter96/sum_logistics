<?php

namespace Tests\Unit\Database;

use App\Database\MemoizesReads;
use App\Database\ReadMemo;
use PHPUnit\Framework\TestCase;

/**
 * What a connection answers from memory, and what empties it.
 */
class MemoizesReadsTest extends TestCase
{
    private ReadMemo $memo;

    private MemoizesReadsConnection $connection;

    protected function setUp(): void
    {
        parent::setUp();

        $this->memo       = new ReadMemo();
        $this->connection = (new MemoizesReadsConnection())->useReadMemo($this->memo);
    }

    public function test_without_a_memo_or_with_it_off_every_read_reaches_the_database(): void
    {
        $this->connection->select('select 1');
        $this->connection->select('select 1');
        (new MemoizesReadsConnection())->select('select 1');

        $this->assertSame(2, $this->connection->reads);
    }

    public function test_a_repeated_read_is_answered_from_memory(): void
    {
        $this->memo->enable();
        $first = $this->connection->select('select 1');

        $this->assertEquals($first, $this->connection->select('select 1'));
        $this->assertSame(1, $this->connection->reads);
    }

    /**
     * @return array<string, array{0: \Closure}>
     */
    public static function writes(): array
    {
        return [
            'statement'          => [fn ($connection) => $connection->statement('insert into t values (1)')],
            'affectingStatement' => [fn ($connection) => $connection->affectingStatement('update t set x = 1')],
            'unprepared'         => [fn ($connection) => $connection->unprepared('delete from t')],
            'beginTransaction'   => [function ($connection) {
                $connection->beginTransaction();
                $connection->level = 0;
            }],
        ];
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('writes')]
    public function test_a_write_empties_it(\Closure $write): void
    {
        $this->memo->enable();
        $this->connection->select('select 1');
        $write($this->connection);
        $this->connection->select('select 1');

        $this->assertSame(2, $this->connection->reads);
    }

    public function test_a_failed_write_empties_it_too(): void
    {
        $this->memo->enable();
        $this->connection->select('select 1');
        $this->connection->fail = true;

        try {
            $this->connection->statement('insert into t values (1)');
            $this->fail('Expected the write to fail.');
        } catch (\RuntimeException) {
        }

        $this->connection->select('select 1');
        $this->assertSame(2, $this->connection->reads);
    }

    public function test_reads_in_a_transaction_reach_the_database(): void
    {
        $this->memo->enable();
        $this->connection->level = 1;
        $this->connection->select('select 1');
        $this->connection->select('select 1');

        $this->assertSame(2, $this->connection->reads);
    }

    public function test_reads_on_the_write_connection_reach_the_database_except_about_the_schema(): void
    {
        $this->memo->enable();

        foreach ([1, 2] as $_) {
            $this->connection->select('select 1', [], false);
            $this->connection->select('select * from information_schema.tables', [], false);
        }

        $this->assertSame(3, $this->connection->reads);
    }
}

/**
 * The parts of Illuminate's connection that the trait builds on.
 */
class MemoizesReadsBase
{
    public int $reads = 0;
    public int $level = 0;
    public bool $fail = false;

    public function select($query, $bindings = [], $useReadPdo = true)
    {
        $this->reads++;

        return [(object) ['answer' => $this->reads]];
    }

    public function statement($query, $bindings = [])
    {
        return $this->write();
    }

    public function affectingStatement($query, $bindings = [])
    {
        return $this->write();
    }

    public function unprepared($query)
    {
        return $this->write();
    }

    public function beginTransaction()
    {
        $this->level++;
    }

    public function transactionLevel()
    {
        return $this->level;
    }

    public function pretending()
    {
        return false;
    }

    public function getName()
    {
        return 'mysql';
    }

    public function prepareBindings(array $bindings)
    {
        return $bindings;
    }

    private function write()
    {
        return $this->fail ? throw new \RuntimeException('failed') : true;
    }
}

class MemoizesReadsConnection extends MemoizesReadsBase
{
    use MemoizesReads;
}
