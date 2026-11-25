<?php

namespace App\Database;

/**
 * A SELECT simple enough that asking it for many keys at once is the same as asking it
 * once per key:
 *
 *     select * from `places` where `places`.`uuid` = ? and `places`.`deleted_at` is null limit 1
 *
 * That is what Eloquent writes when it loads or counts a relation. Anything else — OR,
 * subqueries with values, functions, grouping, a limit that cuts a list — is not parsed,
 * and so never batched.
 */
final class KeyedSelect
{
    /** The column in which a batched count() carries the key. */
    public const COUNT_KEY = 'batched_key';

    private const IDENTIFIER = '(?:`[^`]+`|"[^"]+")(?:\.(?:`[^`]+`|"[^"]+"))?';

    /** The last one is how core-api and Fleet-Ops write a display name. */
    private const COLUMN = '(?:\*|' . self::IDENTIFIER . '\.\*|' . self::IDENTIFIER . '(?: as ' . self::IDENTIFIER . ')?'
        . '|(?i:concat)\((?:[\w.]+|\'[^\']*\')(?:, (?:[\w.]+|\'[^\']*\'))*\) (?i:as) \w+)';

    /** The last one is how Eloquent asks whether a related row exists. */
    private const CONDITION = '(?:'
        . self::IDENTIFIER . ' (?:(?:=|!=|<>|<=|>=|<|>|like|not like) \?|(?:not )?in \((?:\?|\d+)(?:, (?:\?|\d+))*\)|is (?:not )?null)'
        . '|exists \(select \* from ' . self::IDENTIFIER . ' where ' . self::IDENTIFIER . ' = ' . self::IDENTIFIER . '(?: and ' . self::IDENTIFIER . ' is (?:not )?null)*\)'
        . ')';

    /** Conditions that all have to hold; parentheses around some of them change nothing. */
    private const CONDITIONS = '(?:' . self::CONDITION . '|(?<group>\((?:' . self::CONDITION . '|(?&group))(?: and (?:' . self::CONDITION . '|(?&group)))*\)))'
        . '(?: and (?:' . self::CONDITION . '|(?&group)))*';

    private const COUNT = 'count(*) as aggregate';

    /** A longer statement already lists many keys. */
    private const MAX_LENGTH = 4096;

    /** Parsed statements kept per worker. */
    private const MAX_PARSED = 1000;

    /** @var array<string, self|false> */
    private static array $parsed = [];

    /**
     * Each key says where its value is among the bindings, the text between those places,
     * and how to tell from a row which value it belongs to. `single` is set when the
     * statement takes one row, `unique` when there is no second, `count` when it only
     * counts rows. `order` lists what rows are sorted by, `joined` is set when other
     * tables have a say in which rows there are.
     *
     * @param array<int, array{positions: array<int, int>, text: array<int, string>, attribute: string, single: bool, unique: bool, count: bool, order: array<int, string>, joined: bool}> $keys
     */
    private function __construct(public readonly array $keys)
    {
    }

    /**
     * Null when the statement is not of this kind.
     */
    public static function parse(string $sql): ?self
    {
        if (strlen($sql) > self::MAX_LENGTH) {
            return null;
        }

        if (!array_key_exists($sql, self::$parsed)) {
            if (count(self::$parsed) >= self::MAX_PARSED) {
                self::$parsed = [];
            }
            self::$parsed[$sql] = self::read($sql) ?? false;
        }

        return self::$parsed[$sql] ?: null;
    }

    /**
     * The same text for every way of asking one question: for one key or many, with the
     * limit of a lookup or without.
     */
    public static function family(string $sql): string
    {
        return preg_replace(['/ limit \d+$/', '/ = \?/', '/ in \(\?(?:, \?)+\)/'], ['', ' in (?)', ' in (?)'], $sql) ?? $sql;
    }

    /**
     * The statement asking for several keys, and its bindings.
     *
     * @param array{positions: array<int, int>, text: array<int, string>} $key
     * @param array<int, mixed>                                            $bindings of the statement for one key
     * @param array<int, string>                                           $values
     *
     * @return array{0: string, 1: array<int, mixed>}
     */
    public static function forMany(array $key, array $bindings, array $values, ?int $limit = null): array
    {
        foreach (array_reverse($key['positions']) as $position) {
            array_splice($bindings, $position, 1, $values);
        }

        $list = ' in (' . implode(', ', array_fill(0, count($values), '?')) . ')';

        return [implode($list, $key['text']) . ($limit === null ? '' : ' limit ' . $limit), $bindings];
    }

    private static function read(string $sql): ?self
    {
        $id     = self::IDENTIFIER;
        $column = self::COLUMN;

        $matched = preg_match(
            '/^select (?<columns>' . preg_quote(self::COUNT, '/') . "|$column(?:, $column)*) from (?<table>$id)(?<joins>(?: inner join $id on $id = $id)*)"
            . ' where (?<where>' . self::CONDITIONS . ')'
            . "(?<order> order by $id(?: asc| desc)?(?:, $id(?: asc| desc)?)*)?(?<limit> limit 1)?$/D",
            $sql,
            $parts,
            PREG_OFFSET_CAPTURE
        );

        if (!$matched) {
            return null;
        }

        [$columns, $table, $joins] = [$parts['columns'][0], $parts['table'][0], $parts['joins'][0]];
        [$where, $start]           = $parts['where'];

        $count   = $columns === self::COUNT;
        $single  = ($parts['limit'][0] ?? '') !== '';
        $ordered = ($parts['order'][0] ?? '') !== '';

        if ($count && ($single || $ordered)) {
            return null;
        }

        $order = [];

        preg_match_all("/$id/", $parts['order'][0] ?? '', $sorted);
        foreach ($sorted[0] as $name) {
            if (($order[] = self::attribute($name, $columns, $table, $joins)) === null) {
                return null; // Nothing to tell from which rows could change places.
            }
        }

        $keys = [];

        foreach (self::places($where, $start) as $name => $places) {
            $attribute = $count ? self::COUNT_KEY : self::attribute($name, $columns, $table, $joins);
            $unique    = $attribute === 'uuid' && self::isOn($name, $table, $joins);

            // `limit 1` takes the first of several rows, and sorting them all to find out
            // which are first could take far longer than asking once per key.
            if ($attribute === null || ($single && !$unique && $ordered)) {
                continue;
            }

            $text = [];
            $from = 0;
            foreach ($places as [$begin, $end]) {
                $text[] = substr($sql, $from, $begin - $from);
                $from   = $end;
            }
            $text[] = substr($sql, $from, $single ? -strlen(' limit 1') : null);

            if ($count) {
                $text[0] = "select $name as {$name[0]}" . self::COUNT_KEY . "{$name[0]}, " . substr($text[0], strlen('select '));
                $text[count($text) - 1] .= " group by $name";
            }

            $keys[] = [
                'positions' => array_keys($places),
                'text'      => $text,
                'attribute' => $attribute,
                'single'    => $single,
                'unique'    => $unique,
                'count'     => $count,
                'order'     => $order,
                'joined'    => $joins !== '' || str_contains($where, 'exists ('),
            ];
        }

        return $keys === [] ? null : new self($keys);
    }

    /**
     * Where a column is compared with one value: by column, then by the position of that
     * value among the bindings, the beginning and the end of ` = ?` or ` in (?)`.
     *
     * @return array<string, array<int, array{0: int, 1: int}>>
     */
    private static function places(string $where, int $start): array
    {
        $places   = [];
        $position = 0;

        preg_match_all('/' . self::CONDITION . '/', $where, $conditions, PREG_OFFSET_CAPTURE);

        foreach ($conditions[0] as [$condition, $offset]) {
            if (preg_match('/^(' . self::IDENTIFIER . ')(?: = \?| in \(\?\))$/D', $condition, $matches)) {
                $begin                          = $start + $offset + strlen($matches[1]);
                $places[$matches[1]][$position] = [$begin, $start + $offset + strlen($condition)];
            }
            $position += substr_count($condition, '?');
        }

        return $places;
    }

    /**
     * The name under which a row carries a column, or null when it may not.
     */
    private static function attribute(string $column, string $columns, string $table, string $joins): ?string
    {
        $name  = self::bare($column);
        $own   = self::isOn($column, $table, $joins);
        $found = null;

        preg_match_all('/' . self::COLUMN . '/', $columns, $items);

        foreach ($items[0] as $item) {
            if (str_ends_with($item, '*')) {
                if ($own && ($item === '*' ? $joins === '' : self::bare(substr($item, 0, -2)) === self::bare($table))) {
                    $found = $name;
                }
                continue;
            }

            [$source, $alias] = array_pad(preg_split('/ as /i', $item), 2, null);
            $alias            = self::bare($alias ?? $source);

            if ($source === $column || ($own && self::bare($source) === $name && self::isOn($source, $table, $joins))) {
                $found ??= $alias;
            } elseif ($alias === $found) {
                return null; // Overwritten by another column of that name.
            }
        }

        return $found;
    }

    /**
     * Whether a column belongs to the table the statement selects from.
     */
    private static function isOn(string $column, string $table, string $joins): bool
    {
        $position = strrpos($column, '.');

        return $position === false ? $joins === '' : self::bare(substr($column, 0, $position)) === self::bare($table);
    }

    /**
     * The last part of an identifier, without quotes.
     */
    private static function bare(string $identifier): string
    {
        $position = strrpos($identifier, '.');

        return trim($position === false ? $identifier : substr($identifier, $position + 1), '`"');
    }
}
