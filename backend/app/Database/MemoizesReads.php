<?php

namespace App\Database;

/**
 * For a database connection: answers repeated SELECTs from a ReadMemo, and empties it on
 * anything that may change data.
 */
trait MemoizesReads
{
    private ?ReadMemo $readMemo = null;

    public function useReadMemo(?ReadMemo $memo): static
    {
        $this->readMemo = $memo;

        return $this;
    }

    public function select($query, $bindings = [], $useReadPdo = true)
    {
        if (!$this->mayMemoize((string) $query, (bool) $useReadPdo)) {
            return parent::select($query, $bindings, $useReadPdo);
        }

        return $this->readMemo->remember(
            (string) $this->getName(),
            (string) $query,
            $this->prepareBindings($bindings),
            fn (string $sql, array $values) => parent::select($sql, $values, $useReadPdo)
        );
    }

    /**
     * Inside a transaction, or asked of the write connection, a repeated read may be
     * deliberate. Laravel asks about the schema on the write connection.
     */
    private function mayMemoize(string $query, bool $useReadPdo): bool
    {
        return (bool) $this->readMemo?->isEnabled()
            && $this->transactionLevel() === 0
            && !$this->pretending()
            && ($useReadPdo || ReadMemo::isAboutSchema($query));
    }

    public function statement($query, $bindings = [])
    {
        try {
            return parent::statement($query, $bindings);
        } finally {
            $this->readMemo?->flush();
        }
    }

    public function affectingStatement($query, $bindings = [])
    {
        try {
            return parent::affectingStatement($query, $bindings);
        } finally {
            $this->readMemo?->flush();
        }
    }

    public function unprepared($query)
    {
        try {
            return parent::unprepared($query);
        } finally {
            $this->readMemo?->flush();
        }
    }

    public function beginTransaction()
    {
        $this->readMemo?->flush();

        parent::beginTransaction();
    }
}
