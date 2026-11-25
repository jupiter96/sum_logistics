<?php

namespace App\Database;

use Closure;
use Illuminate\Database\QueryException;

/**
 * Answers a SELECT that already ran in this request from memory.
 *
 * List endpoints ask for the same rows over and over while serializing: the same company,
 * the same settings, every avatar file of a type once per record. Within one read-only
 * request the answer cannot change by this request's doing, so it is fetched once. Given a
 * ReadBatcher, rows that will be asked for one by one are fetched together as well.
 *
 * It only works between enable() and disable(), which OptimizeReads calls around a GET
 * request. Any write empties it (see MemoizesReads), so a request that writes and reads
 * back always sees its own write.
 */
class ReadMemo
{
    /** Rows kept per request. */
    public const MAX_ROWS_KEPT = 20000;

    /** Larger results are not kept: they are unlikely to repeat and cost memory. */
    public const MAX_ROWS = 500;

    /** How long an answer is repeated, in seconds: a request that waits for a change must see it. */
    public const TTL = 5;

    /** How long a worker trusts what it read about the schema, in seconds. */
    public const SCHEMA_TTL = 60;

    /** Statements whose answer may differ each time, or that take locks. */
    private const VOLATILE = '/\b(?:rand|uuid|uuid_short|sleep|last_insert_id|found_rows|row_count|get_lock|release_lock|is_free_lock|is_used_lock)\s*\(|\bfor\s+(?:update|share)\b|\block\s+in\s+share\s+mode\b|\binto\s+(?:outfile|dumpfile|@)/i';

    /** Statements that ask about tables and columns rather than data. */
    private const SCHEMA = '/\binformation_schema\b/i';

    private bool $enabled = false;

    private ?ReadBatcher $batcher = null;

    /** @var array<string, array{0: float, 1: array<int, mixed>}> when it was read, and what */
    private array $results = [];

    /** @var array<string, array{0: float, 1: array<int, mixed>}> until when it is trusted, and what */
    private array $schema = [];

    private int $kept = 0;

    private int $hits = 0;

    public function enable(?ReadBatcher $batcher = null): void
    {
        $this->flush();
        $batcher?->reset();

        $this->batcher = $batcher;
        $this->hits    = 0;
        $this->enabled = true;
    }

    public function disable(): void
    {
        $this->flush();
        $this->batcher?->reset();

        $this->batcher = null;
        $this->enabled = false;
    }

    public function isEnabled(): bool
    {
        return $this->enabled;
    }

    public static function isAboutSchema(string $sql): bool
    {
        return preg_match(self::SCHEMA, $sql) === 1;
    }

    /**
     * Forget every row read so far. What is known about the schema stays.
     */
    public function flush(): void
    {
        $this->results = [];
        $this->kept    = 0;
        $this->batcher?->interrupt();
    }

    /**
     * Take a hint from models that may not have been read from the database in this
     * request: list endpoints keep theirs in the cache.
     */
    public function learnFrom(mixed $response): void
    {
        if ($this->enabled && $this->batcher !== null) {
            foreach (ResponseModels::in($response) as $class => $models) {
                $this->batcher->learn($class, array_map(static fn ($model) => $model->getAttributes(), $models));
            }
        }
    }

    /**
     * Statements answered from memory since enable().
     */
    public function hits(): int
    {
        return $this->hits;
    }

    /**
     * Run a SELECT, or repeat the answer it gave earlier in this request.
     *
     * @param array<int|string, mixed>                                      $bindings as prepared for PDO
     * @param Closure(string, array<int|string, mixed>): array<int, mixed>  $run
     *
     * @return array<int, mixed>
     */
    public function remember(string $connection, string $sql, array $bindings, Closure $run): array
    {
        $key = $this->enabled ? $this->key($connection, $sql, $bindings) : null;

        if ($key === null) {
            return $run($sql, $bindings);
        }

        if (self::isAboutSchema($sql)) {
            return $this->rememberSchema($key, fn () => $run($sql, $bindings));
        }

        if (isset($this->results[$key]) && $this->results[$key][0] > microtime(true) - self::TTL) {
            $this->hits++;

            return $this->copy($this->results[$key][1]);
        }

        [$batch, $questions] = $this->batcher?->plan($connection, $sql, $bindings) ?? [null, []];

        if ($batch !== null && ($rows = $this->runBatch($connection, $sql, $bindings, $batch, $questions, $run)) !== null) {
            return $rows;
        }

        $rows = $run($sql, $bindings);

        $this->batcher?->answered($questions, 1, count($rows));

        // A copy, as the caller may change what it is given.
        $copy = $this->copy($rows);
        $this->batcher?->learn($sql, $copy);
        $this->keep($key, $copy);

        return $rows;
    }

    /**
     * Ask for several keys at once and keep each answer under the statement for its key.
     *
     * @param array<int, mixed>                                            $bindings
     * @param array{key: array<string, mixed>, values: array<int, string>} $batch
     * @param array<int, string>                                           $questions
     * @param Closure(string, array<int|string, mixed>): array<int, mixed> $run
     *
     * @return array<int, mixed>|null the rows for the key asked about, null when they could not be told apart
     */
    private function runBatch(string $connection, string $sql, array $bindings, array $batch, array $questions, Closure $run): ?array
    {
        try {
            $rows = $run(...$this->batcher->statement($batch, $bindings));
        } catch (QueryException $e) {
            // The statement as it was written may well succeed.
            $this->batcher?->stop();
            report($e);

            return null;
        }

        $divided = $this->batcher?->divide($batch, $rows);

        $this->batcher?->answered($questions, count($batch['values']), count($rows));

        if ($divided === null) {
            return null;
        }

        if (!$batch['key']['count']) {
            $this->batcher?->learn($sql, $rows);
        }

        foreach ($divided as $value => $found) {
            $this->keep((string) $this->key($connection, $sql, $this->batcher->bindingsFor((string) $value, $batch, $bindings)), $found);
        }

        $asked = $divided[$batch['values'][0]] ?? null;

        return $asked === null ? null : $this->copy($asked);
    }

    /**
     * @param array<int, mixed> $rows
     */
    private function keep(string $key, array $rows): void
    {
        // Running the statement may have ended the request; only keep what still counts.
        if (!$this->enabled || count($rows) > self::MAX_ROWS || $this->kept + count($rows) > self::MAX_ROWS_KEPT) {
            return;
        }

        $this->kept         += max(1, count($rows));
        $this->results[$key] = [microtime(true), $rows];
    }

    /**
     * Schema lookups repeat on every request, so they are kept a little longer. Only an
     * answer that found something is: "no such table" must not outlive a migration.
     *
     * @param Closure(): array<int, mixed> $run
     *
     * @return array<int, mixed>
     */
    private function rememberSchema(string $key, Closure $run): array
    {
        $now = microtime(true);

        if (isset($this->schema[$key]) && $this->schema[$key][0] > $now) {
            $this->hits++;

            return $this->copy($this->schema[$key][1]);
        }

        $rows = $run();

        if ($rows !== []) {
            $this->schema[$key] = [$now + self::SCHEMA_TTL, $this->copy($rows)];
        } else {
            unset($this->schema[$key]);
        }

        return $rows;
    }

    /**
     * @param array<int|string, mixed> $bindings
     */
    private function key(string $connection, string $sql, array $bindings): ?string
    {
        if (!preg_match('/^\s*\(?\s*select\b/i', $sql) || preg_match(self::VOLATILE, $sql)) {
            return null;
        }

        $key = $connection . "\0" . $sql;

        foreach ($bindings as $name => $value) {
            if ($value !== null && !is_scalar($value)) {
                return null;
            }
            // Length-prefixed and typed, so no two lists of values look the same.
            $text = is_bool($value) ? (string) (int) $value : (string) $value;
            $key .= "\0" . $name . gettype($value)[0] . strlen($text) . ':' . $text;
        }

        return $key;
    }

    /**
     * Rows are objects, so hand out copies: a caller changing one must not change the memo.
     *
     * @param array<int, mixed> $rows
     *
     * @return array<int, mixed>
     */
    private function copy(array $rows): array
    {
        return array_map(static fn ($row) => is_object($row) ? clone $row : $row, $rows);
    }
}
