<?php

/*
|--------------------------------------------------------------------------
| API performance
|--------------------------------------------------------------------------
|
| Switches for what PerformanceServiceProvider sets up. Each can be turned off
| on its own, without a code change, should it ever get in the way.
|
*/

return [
    /*
    | Answer a SELECT that already ran in the same GET request from memory.
    | Any write empties it. See App\Database\ReadMemo.
    */
    'memoize_reads' => env('DB_MEMOIZE_READS', true),

    /*
    | When a lookup is made for one row of a list after another, make it for the
    | rest of the list at once. Needs memoize_reads. See App\Database\ReadBatcher.
    */
    'batch_reads' => env('DB_BATCH_READS', true),

    /*
    | Do not store a session for public API requests that authenticate with a token
    | and send no session cookie. See App\Http\Middleware\StartSession.
    */
    'stateless_api_sessions' => env('API_STATELESS_SESSIONS', true),
];
