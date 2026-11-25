<?php

namespace App\Database;

/**
 * Turns a query per row into a query per list.
 *
 * Serializing a list asks one question about every row: the payload of order 1, of order 2,
 * and so on. When a question is asked about a second row, this asks it for the rows still
 * to come as well, in one statement, and ReadMemo answers the rest from that.
 *
 * It recognises "rows of a list" by value, not by model: a uuid that was read from some
 * column leads to the other uuids in that column. Guessing wrong costs a few rows that
 * nobody asks for. It cannot change an answer, because every answer is still stored under
 * the exact statement it belongs to.
 */
class ReadBatcher
{
    /** Keys asked for in one statement. */
    public const MAX_KEYS = 100;

    /** Rows a statement should return at most, judging by what its question returned so far. */
    public const MAX_ROWS = 1000;

    /** Where a statement takes one row per key, the batch stops at this many. */
    private const MAX_ROWS_PER_KEY = 4;

    /** Uuids remembered per request, counted once per column they were read from. */
    public const MAX_UUIDS = 20000;

    /** Columns considered as the origin of one uuid. */
    private const MAX_ORIGINS = 12;

    /** A request that writes this often while it reads gains nothing from reading ahead. */
    private const MAX_INTERRUPTIONS = 3;

    private const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';

    /** A uuid, or a name with one in it: the settings key `user.<uuid>.locale`. */
    private const VALUE = '/^([\w.:-]*?)(' . self::UUID . ')([\w.:-]*)$/D';

    /** @var array<int, array{0: string, 1: array<int, object|array<string, mixed>>}> results not looked through yet */
    private array $unread = [];

    /** @var array<string, int> long texts (a statement, a column of a result) by the number that stands for them */
    private array $numbers = [];

    /** @var array<int, array<string, true>> origin => the uuids in it, in order */
    private array $values = [];

    /** @var array<string, array<int, true>> uuid => its origins */
    private array $origins = [];

    /** @var array<string, array{0: int, 1: int}> question => keys asked for, rows returned */
    private array $questions = [];

    /** @var array<int, array<string, true>> statement => the uuids already asked for */
    private array $asked = [];

    private int $uuids = 0;

    private int $interruptions = 0;

    private int $batches = 0;

    /**
     * Forget everything.
     */
    public function reset(): void
    {
        $this->unread  = $this->numbers = $this->values = $this->origins = $this->questions = $this->asked = [];
        $this->uuids = $this->interruptions = $this->batches = 0;
    }

    /**
     * Run every statement alone from now on.
     */
    public function stop(): void
    {
        $this->interruptions = self::MAX_INTERRUPTIONS;
    }

    /**
     * Answers were thrown away. Which uuids belong together is still true.
     */
    public function interrupt(): void
    {
        if ($this->asked !== []) {
            $this->asked = [];
            $this->interruptions++;
        }
    }

    /**
     * Statements run for several keys since reset().
     */
    public function batches(): int
    {
        return $this->batches;
    }

    /**
     * Take note of rows, and of what they have in common: the statement that read them, or
     * the class of the models made from them.
     *
     * @param array<int, object|array<string, mixed>> $rows
     */
    public function learn(string $source, array $rows): void
    {
        if ($rows !== [] && count($rows) <= self::MAX_ROWS && $this->uuids < self::MAX_UUIDS) {
            $this->unread[] = [$source, $rows];
        }
    }

    /**
     * What to do about a statement nobody asked before: run it alone, or for more keys.
     *
     * @param array<int|string, mixed> $bindings
     *
     * @return array{0: array{key: array<string, mixed>, values: array<int, string>}|null, 1: array<int, string>} the batch, and the questions this statement belongs to
     */
    public function plan(string $connection, string $sql, array $bindings): array
    {
        if ($this->interruptions >= self::MAX_INTERRUPTIONS || !array_is_list($bindings) || !($select = KeyedSelect::parse($sql))) {
            return [null, []];
        }

        $this->index();

        $batch     = null;
        $next      = [];
        $most      = 0;
        $questions = [];

        foreach ($select->keys as $key) {
            $value  = $bindings[$key['positions'][0]] ?? null;
            $others = $bindings;

            foreach ($key['positions'] as $position) {
                $value = ($bindings[$position] ?? null) === $value ? $value : null;
                unset($others[$position]);
            }

            if (!is_string($value) || !preg_match(self::VALUE, $value, $matches)) {
                continue;
            }

            [, $prefix, $uuid, $suffix]     = $matches;
            $statement                      = $this->number(implode("\0", [$connection, $sql, $prefix, $suffix, serialize($others)]));
            $this->asked[$statement][$uuid] = true;

            foreach ($this->origins[$uuid] ?? [] as $origin => $true) {
                $question    = $statement . ':' . $origin;
                $questions[] = $question;

                if (!isset($this->questions[$question])) {
                    continue; // The first row of a list; there may be no second.
                }

                [$keys, $rows] = $this->questions[$question];
                $waiting       = array_diff_key($this->values[$origin], $this->asked[$statement]);
                $taken         = min(count($waiting), self::MAX_KEYS - 1, intdiv(self::MAX_ROWS * $keys, max(1, $rows)) - 1);

                if ($taken > $most) {
                    $most  = $taken;
                    $uuids = [$uuid, ...array_slice(array_keys($waiting), 0, $taken)];
                    $batch = ['key' => $key, 'values' => array_map(static fn ($one) => $prefix . $one . $suffix, $uuids)];
                    $next  = [$statement, $uuids];
                }
            }
        }

        if ($batch !== null) {
            $this->batches++;
            $this->asked[$next[0]] += array_fill_keys($next[1], true);
        }

        return [$batch, $questions];
    }

    /**
     * Note how many rows a question returned for how many keys.
     *
     * @param array<int, string> $questions from plan()
     */
    public function answered(array $questions, int $keys, int $rows): void
    {
        foreach ($questions as $question) {
            [$keysBefore, $rowsBefore]  = $this->questions[$question] ?? [0, 0];
            $this->questions[$question] = [$keysBefore + $keys, $rowsBefore + $rows];
        }
    }

    /**
     * The statement for a batch, and its bindings.
     *
     * @param array{key: array<string, mixed>, values: array<int, string>} $batch
     * @param array<int, mixed>                                            $bindings
     *
     * @return array{0: string, 1: array<int, mixed>}
     */
    public function statement(array $batch, array $bindings): array
    {
        return KeyedSelect::forMany($batch['key'], $bindings, $batch['values'], $this->limit($batch));
    }

    /**
     * The bindings of the statement for one of its keys.
     *
     * @param array{key: array<string, mixed>, values: array<int, string>} $batch
     * @param array<int, mixed>                                            $bindings
     *
     * @return array<int, mixed>
     */
    public function bindingsFor(string $value, array $batch, array $bindings): array
    {
        foreach ($batch['key']['positions'] as $position) {
            $bindings[$position] = $value;
        }

        return $bindings;
    }

    /**
     * Hand out the rows of a batch, leaving out keys whose own statement might list them
     * differently. Null when the rows do not tell: there were too many, or the database
     * compares keys in a way that plain equality does not cover.
     *
     * @param array{key: array<string, mixed>, values: array<int, string>} $batch
     * @param array<int, object>                                           $rows
     *
     * @return array<string, array<int, object>>|null rows by key
     */
    public function divide(array $batch, array $rows): ?array
    {
        $attribute = $batch['key']['attribute'];
        $divided   = array_fill_keys($batch['values'], []);
        $limit     = $this->limit($batch);

        if ($limit !== null && count($rows) >= $limit) {
            return null;
        }

        foreach ($rows as $row) {
            $value = is_object($row) ? $row->{$attribute} ?? null : null;

            if (!is_string($value) || !isset($divided[$value])) {
                return null;
            }
            $divided[$value][] = $row;
        }

        if ($batch['key']['count']) {
            return array_map(static fn ($found) => [(object) ['aggregate' => $found === [] ? 0 : $found[0]->aggregate]], $divided);
        }

        return array_filter($divided, fn ($found) => count($found) < 2 || $this->isSettled($batch['key'], $found));
    }

    /**
     * Whether a database would list several rows in this order however many it was asked for.
     *
     * Rows that compare equal may come in any order, and `limit 1` may take any of them. A
     * join, or an EXISTS, is read from whichever side is cheaper. Rows of one table come in
     * the order of its primary key.
     *
     * @param array<string, mixed>  $key
     * @param array<int, object>    $rows
     */
    private function isSettled(array $key, array $rows): bool
    {
        if ($key['single']) {
            return false;
        }

        if ($key['order'] === []) {
            return !$key['joined'];
        }

        $previous = null;

        foreach ($rows as $row) {
            $current = [];
            foreach ($key['order'] as $column) {
                $value     = (string) ($row->{$column} ?? '');
                $current[] = $value;

                // Text that differs may still compare equal. Numbers and dates do not.
                if (!preg_match('/^[\d .:-]*$/D', $value)) {
                    return false;
                }
            }
            if ($current === $previous) {
                return false;
            }
            $previous = $current;
        }

        return true;
    }

    /**
     * Without its `limit 1` a statement might return a whole table.
     *
     * @param array{key: array<string, mixed>, values: array<int, string>} $batch
     */
    private function limit(array $batch): ?int
    {
        return $batch['key']['single'] && !$batch['key']['unique'] ? self::MAX_ROWS_PER_KEY * count($batch['values']) + 1 : null;
    }

    /**
     * Look through what was read since the last time.
     */
    private function index(): void
    {
        foreach ($this->unread as [$source, $rows]) {
            $family = KeyedSelect::family($source) . "\0";
            $origin = [];

            foreach ($rows as $row) {
                foreach ($row as $column => $value) {
                    if (!is_string($value) || strlen($value) !== 36 || $value[8] !== '-' || !preg_match('/^' . self::UUID . '$/D', $value)) {
                        continue;
                    }

                    $number = $origin[$column] ??= $this->number($family . $column);

                    if (!isset($this->values[$number][$value]) && $this->uuids < self::MAX_UUIDS && count($this->origins[$value] ?? []) < self::MAX_ORIGINS) {
                        $this->values[$number][$value]  = true;
                        $this->origins[$value][$number] = true;
                        $this->uuids++;
                    }
                }
            }
        }

        $this->unread = [];
    }

    private function number(string $text): int
    {
        return $this->numbers[$text] ??= count($this->numbers) + 1;
    }
}
