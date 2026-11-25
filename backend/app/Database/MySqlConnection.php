<?php

namespace App\Database;

use sum_logistics\LaravelMysqlSpatial\MysqlConnection as SpatialMysqlConnection;

/**
 * The spatial MySQL connection core-api uses, with repeated reads answered from memory.
 */
class MySqlConnection extends SpatialMysqlConnection
{
    use MemoizesReads;
}
