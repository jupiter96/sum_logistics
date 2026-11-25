<?php

namespace Tests\Unit\Database;

use App\Database\KeyedSelect;
use Illuminate\Database\Connection;
use Illuminate\Database\Eloquent\Builder as EloquentBuilder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Database\Query\Builder;
use Illuminate\Database\Query\Grammars\MySqlGrammar;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * Which statements may be asked for many keys at once, in the SQL Laravel writes for MySQL.
 */
class KeyedSelectTest extends TestCase
{
    private function builder(): Builder
    {
        $connection = new Connection(fn () => null);

        return new Builder($connection, new MySqlGrammar());
    }

    /**
     * What a model of the given uuid runs when it loads a relation.
     *
     * @param \Closure(KeyedSelectOrder): \Illuminate\Database\Eloquent\Relations\Relation $relation
     */
    private function relationSql(\Closure $relation): string
    {
        $resolver = new class ($this->builder()->getConnection()) implements \Illuminate\Database\ConnectionResolverInterface {
            public function __construct(private Connection $connection)
            {
            }

            public function connection($name = null)
            {
                $this->connection->setQueryGrammar(new MySqlGrammar());

                return $this->connection;
            }

            public function getDefaultConnection()
            {
                return 'mysql';
            }

            public function setDefaultConnection($name)
            {
            }
        };

        $before = Model::getConnectionResolver();
        Model::setConnectionResolver($resolver);

        try {
            $query = $relation((new KeyedSelectOrder())->forceFill(['uuid' => 'order', 'place_uuid' => 'place']));
            $query = $query instanceof \Illuminate\Database\Eloquent\Relations\Relation ? $query->getQuery() : $query;

            return $query instanceof EloquentBuilder ? $query->toBase()->toSql() : $query->toSql();
        } finally {
            $before ? Model::setConnectionResolver($before) : Model::unsetConnectionResolver();
        }
    }

    public function test_belongs_to(): void
    {
        $sql = $this->relationSql(fn ($order) => $order->belongsTo(KeyedSelectPlace::class, 'place_uuid', 'uuid')->getQuery()->limit(1));

        $this->assertSame('select * from `places` where `places`.`uuid` = ? and `places`.`deleted_at` is null limit 1', $sql);

        [$key] = KeyedSelect::parse($sql)->keys;
        $this->assertTrue($key['single']);
        $this->assertTrue($key['unique']);
        $this->assertSame('uuid', $key['attribute']);

        $this->assertSame(
            ['select * from `places` where `places`.`uuid` in (?, ?, ?) and `places`.`deleted_at` is null', ['a', 'b', 'c']],
            KeyedSelect::forMany($key, ['a'], ['a', 'b', 'c'])
        );
    }

    public function test_eager_loaded_belongs_to(): void
    {
        $sql   = 'select * from `places` where `places`.`uuid` in (?) and `places`.`deleted_at` is null';
        [$key] = KeyedSelect::parse($sql)->keys;

        $this->assertFalse($key['single']);
        $this->assertSame('select * from `places` where `places`.`uuid` in (?, ?) and `places`.`deleted_at` is null', KeyedSelect::forMany($key, ['a'], ['a', 'b'])[0]);
    }

    public function test_has_many(): void
    {
        $sql   = $this->relationSql(fn ($order) => $order->hasMany(KeyedSelectPlace::class, 'order_uuid', 'uuid')->orderBy('created_at', 'desc'));
        [$key] = KeyedSelect::parse($sql)->keys;

        $this->assertSame('order_uuid', $key['attribute']);
        $this->assertSame(['created_at'], $key['order']);
        $this->assertSame(
            'select * from `places` where `places`.`order_uuid` in (?, ?) and `places`.`order_uuid` is not null and `places`.`deleted_at` is null order by `created_at` desc',
            KeyedSelect::forMany($key, ['a'], ['a', 'b'])[0]
        );
    }

    public function test_morph_many_keeps_the_type(): void
    {
        $sql    = $this->relationSql(fn ($order) => $order->morphMany(KeyedSelectPlace::class, 'subject', 'subject_type', 'subject_uuid', 'uuid'));
        $keys   = KeyedSelect::parse($sql)->keys;
        $byName = array_column($keys, null, 'attribute');

        $this->assertSame(['subject_type', 'subject_uuid'], array_keys($byName));
        $this->assertStringContainsString('`places`.`subject_type` = ?', $sql);

        [$many, $bindings] = KeyedSelect::forMany($byName['subject_uuid'], ['Order', 'a'], ['a', 'b']);
        $this->assertStringContainsString('`places`.`subject_type` = ? and `places`.`subject_uuid` in (?, ?)', $many);
        $this->assertSame(['Order', 'a', 'b'], $bindings);
    }

    public function test_belongs_to_many_is_told_apart_by_the_pivot(): void
    {
        $sql = 'select `roles`.*, `model_has_roles`.`model_uuid` as `pivot_model_uuid`, `model_has_roles`.`role_id` as `pivot_role_id` from `roles` inner join `model_has_roles` on `roles`.`id` = `model_has_roles`.`role_id` where `model_has_roles`.`model_uuid` = ? and `model_has_roles`.`model_type` = ? and `roles`.`deleted_at` is null';
        $key = KeyedSelect::parse($sql)->keys[0];

        $this->assertSame('pivot_model_uuid', $key['attribute']);
        $this->assertTrue($key['joined']);
        $this->assertStringContainsString('where `model_has_roles`.`model_uuid` in (?, ?) and `model_has_roles`.`model_type` = ?', KeyedSelect::forMany($key, ['a', 't'], ['a', 'b'])[0]);
    }

    public function test_has_many_through(): void
    {
        $sql = 'select `places`.*, `waypoints`.`payload_uuid` as `laravel_through_key` from `places` inner join `waypoints` on `waypoints`.`place_uuid` = `places`.`uuid` where `waypoints`.`payload_uuid` = ? and `waypoints`.`deleted_at` is null and `places`.`deleted_at` is null';

        $this->assertSame('laravel_through_key', KeyedSelect::parse($sql)->keys[0]['attribute']);
    }

    public function test_count(): void
    {
        $sql = 'select count(*) as aggregate from `entities` where `entities`.`payload_uuid` = ? and `entities`.`payload_uuid` is not null and `entities`.`deleted_at` is null';
        $key = KeyedSelect::parse($sql)->keys[0];

        $this->assertTrue($key['count']);
        $this->assertSame(
            'select `entities`.`payload_uuid` as `batched_key`, count(*) as aggregate from `entities` where `entities`.`payload_uuid` in (?, ?) and `entities`.`payload_uuid` is not null and `entities`.`deleted_at` is null group by `entities`.`payload_uuid`',
            KeyedSelect::forMany($key, ['a'], ['a', 'b'])[0]
        );
    }

    public function test_listed_columns(): void
    {
        $sql = "select `uuid`, `name`, CONCAT(vehicles.year, ' ', vehicles.make) AS display_name from `vehicles` where `vehicles`.`uuid` = ? and `vehicles`.`deleted_at` is null limit 1";

        $this->assertSame('uuid', KeyedSelect::parse($sql)->keys[0]['attribute']);
        $this->assertNull(KeyedSelect::parse('select `name` from `vehicles` where `vehicles`.`uuid` = ? limit 1'), 'Rows do not say which key they are for');
    }

    public function test_the_same_column_twice_and_parentheses_around_and(): void
    {
        $sql   = 'select * from `company_users` where `company_users`.`user_uuid` in (?) and ((`company_users`.`company_uuid` = ? and `company_users`.`user_uuid` in (?))) and `company_users`.`deleted_at` is null';
        $keys  = array_column(KeyedSelect::parse($sql)->keys, null, 'attribute');
        $found = $keys['user_uuid'];

        $this->assertSame([0, 2], $found['positions']);
        $this->assertSame(
            ['select * from `company_users` where `company_users`.`user_uuid` in (?, ?) and ((`company_users`.`company_uuid` = ? and `company_users`.`user_uuid` in (?, ?))) and `company_users`.`deleted_at` is null', ['a', 'b', 'c', 'a', 'b']],
            KeyedSelect::forMany($found, ['a', 'c', 'a'], ['a', 'b'])
        );
    }

    public function test_the_row_exists_scope(): void
    {
        $sql = 'select * from `drivers` where `drivers`.`uuid` = ? and `drivers`.`deleted_at` is null and exists (select * from `users` where `drivers`.`user_uuid` = `users`.`uuid`) limit 1';

        $this->assertTrue(KeyedSelect::parse($sql)->keys[0]['joined']);
    }

    public function test_a_limited_lookup_by_a_column_that_is_not_unique_stays_limited(): void
    {
        $key = KeyedSelect::parse('select * from `settings` where `key` = ? limit 1')->keys[0];

        $this->assertTrue($key['single']);
        $this->assertFalse($key['unique']);
        $this->assertSame('select * from `settings` where `key` in (?, ?) limit 9', KeyedSelect::forMany($key, ['a'], ['a', 'b'], 9)[0]);
    }

    public static function notKeyed(): array
    {
        return [
            'or'                             => ['select * from `t` where `uuid` = ? or `name` = ?'],
            'or in parentheses'              => ['select * from `t` where `uuid` = ? and (`a` = ? or `b` = ?)'],
            'not'                            => ['select * from `t` where `uuid` = ? and not (`a` = ?)'],
            'first of several, sorted'       => ['select * from `positions` where `subject_uuid` = ? order by `created_at` desc limit 1'],
            'a longer limit'                 => ['select * from `t` where `uuid` = ? limit 10'],
            'offset'                         => ['select * from `t` where `uuid` = ? limit 1 offset 1'],
            'group by'                       => ['select `uuid` from `t` where `uuid` = ? group by `uuid`'],
            'distinct'                       => ['select distinct `uuid` from `t` where `uuid` = ?'],
            'union'                          => ['(select * from `t` where `uuid` = ?) union (select * from `t` where `uuid` = ?)'],
            'left join'                      => ['select `t`.* from `t` left join `s` on `s`.`id` = `t`.`id` where `t`.`uuid` = ?'],
            'subquery with a value'          => ['select * from `t` where `uuid` = ? and exists (select * from `s` where `s`.`x` = `t`.`x` and `s`.`y` = ?)'],
            'function'                       => ['select * from `t` where lower(`uuid`) = ?'],
            'aggregate other than count'     => ['select sum(`x`) as aggregate from `t` where `uuid` = ?'],
            'lock'                           => ['select * from `t` where `uuid` = ? for update'],
            'several keys already'           => ['select * from `t` where `uuid` in (?, ?)'],
            'raw sql'                        => ['select * from t where uuid = ?'],
            'sorted by something not read'   => ['select `uuid`, `fk` from `t` where `fk` = ? order by `created_at` desc'],
            'sorted by an expression'        => ['select * from `t` where `fk` = ? order by FIELD(`status`, 1)'],
            'all columns of two tables'      => ['select * from `t` inner join `s` on `s`.`id` = `t`.`id` where `t`.`uuid` = ?'],
            'key overwritten by an alias'    => ['select `t`.*, `s`.`uuid` as `uuid` from `t` inner join `s` on `s`.`id` = `t`.`id` where `t`.`uuid` = ?'],
            'no condition'                   => ['select * from `t`'],
            'not a select'                   => ['update `t` set `a` = ? where `uuid` = ?'],
            'too long'                       => ['select * from `t` where `uuid` = ? and `x` in (' . implode(', ', array_fill(0, 2000, '?')) . ')'],
        ];
    }

    #[DataProvider('notKeyed')]
    public function test_anything_else_is_left_alone(string $sql): void
    {
        $this->assertNull(KeyedSelect::parse($sql));
    }

    public function test_family_is_the_same_for_one_key_and_many(): void
    {
        $expected = KeyedSelect::family('select * from `t` where `uuid` = ? limit 1');

        $this->assertSame($expected, KeyedSelect::family('select * from `t` where `uuid` in (?)'));
        $this->assertSame($expected, KeyedSelect::family('select * from `t` where `uuid` in (?, ?, ?)'));
        $this->assertNotSame($expected, KeyedSelect::family('select * from `t` where `other` = ?'));
    }
}

class KeyedSelectOrder extends Model
{
    public $incrementing  = false;
    protected $table      = 'orders';
    protected $primaryKey = 'uuid';
    protected $keyType    = 'string';
}

class KeyedSelectPlace extends Model
{
    use SoftDeletes;

    public $incrementing  = false;
    protected $table      = 'places';
    protected $primaryKey = 'uuid';
    protected $keyType    = 'string';
}
