<?php

namespace App\Http\Middleware;

use App\Database\ReadBatcher;
use App\Database\ReadMemo;
use Illuminate\Http\Request;

/**
 * Saves queries while an API GET request is served: repeated SELECTs are answered from
 * memory, and lookups made row by row are made for the whole list.
 *
 * Only for GET and HEAD. A request that changes something keeps reading from the database.
 */
class OptimizeReads
{
    public function __construct(private ReadMemo $memo, private ReadBatcher $batcher)
    {
    }

    public function handle(Request $request, \Closure $next)
    {
        if (!config('performance.memoize_reads') || !$this->appliesTo($request)) {
            return $next($request);
        }

        // Workers are reused, so whatever happens nothing may carry over to the next request.
        try {
            $this->memo->enable(config('performance.batch_reads') ? $this->batcher : null);

            return $next($request);
        } finally {
            $this->memo->disable();
        }
    }

    protected function appliesTo(Request $request): bool
    {
        return $request->isMethodCacheable() && $request->is('v1/*', '*/v1/*');
    }
}
