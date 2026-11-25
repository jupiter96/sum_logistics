<?php

namespace Tests\Unit\Database;

use App\Database\ResponseModels;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Pagination\LengthAwarePaginator;
use PHPUnit\Framework\TestCase;

/**
 * Which models a response is made of.
 */
class ResponseModelsTest extends TestCase
{
    private function model(string $uuid): ResponseModelsOrder
    {
        return (new ResponseModelsOrder())->forceFill(['uuid' => $uuid]);
    }

    private function uuids(mixed $response): array
    {
        return array_map(fn ($models) => array_map(fn ($model) => $model->uuid, $models), ResponseModels::in($response));
    }

    public function test_every_way_to_answer_with_models(): void
    {
        [$a, $b]  = [$this->model('a'), $this->model('b')];
        $expected = [ResponseModelsOrder::class => ['a', 'b']];

        $this->assertSame($expected, $this->uuids([$a, $b]));
        $this->assertSame($expected, $this->uuids(collect([$a, $b])));
        $this->assertSame($expected, $this->uuids(JsonResource::collection([$a, $b])));
        $this->assertSame($expected, $this->uuids(['orders' => [new JsonResource($a), new JsonResource($b)]]));
        $this->assertSame($expected, $this->uuids(new LengthAwarePaginator([$a, $b], 2, 10, 1)));
        $this->assertSame([ResponseModelsOrder::class => ['a']], $this->uuids(new JsonResource($a)));
    }

    public function test_loaded_relations_are_included_and_loops_end(): void
    {
        $order  = $this->model('a');
        $driver = (new ResponseModelsDriver())->forceFill(['uuid' => 'd']);
        $order->setRelation('driver', $driver);
        $order->setRelation('missing', null);
        $driver->setRelation('orders', collect([$order]));

        $this->assertSame([ResponseModelsOrder::class => ['a'], ResponseModelsDriver::class => ['d']], $this->uuids([$order, $order]));
    }

    public function test_other_responses_have_none(): void
    {
        foreach ([null, 'text', 5, ['a' => 1], new \stdClass(), new JsonResource(null)] as $response) {
            $this->assertSame([], ResponseModels::in($response));
        }
    }
}

class ResponseModelsOrder extends Model
{
}

class ResponseModelsDriver extends Model
{
}
