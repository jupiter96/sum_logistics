<?php

namespace App\Database;

use Illuminate\Contracts\Pagination\Paginator;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\Resources\Json\JsonResource;
use Illuminate\Http\Resources\Json\ResourceCollection;

/**
 * The models a controller answered with, before they are serialized.
 */
final class ResponseModels
{
    /** More than this is not worth looking through. */
    public const MAX = 2000;

    /** @var array<int, Model> by object id, so that each is taken once */
    private array $models = [];

    private function __construct()
    {
    }

    /**
     * @return array<class-string<Model>, array<int, Model>> including those of relations that are already loaded
     */
    public static function in(mixed $response): array
    {
        $found = new self();
        $found->visit($response);

        $byClass = [];
        foreach ($found->models as $model) {
            $byClass[get_class($model)][] = $model;
        }

        return $byClass;
    }

    private function visit(mixed $value): void
    {
        if (count($this->models) >= self::MAX) {
            return;
        }

        if ($value instanceof Model) {
            $this->visitModel($value);
        } elseif ($value instanceof ResourceCollection) {
            $this->visit($value->collection ?? null);
        } elseif ($value instanceof JsonResource) {
            $this->visit($value->resource);
        } elseif ($value instanceof Paginator) {
            $this->visit($value->items());
        } elseif (is_array($value) || $value instanceof \Illuminate\Support\Collection) {
            foreach ($value as $item) {
                if (is_object($item) || is_array($item)) {
                    $this->visit($item);
                }
            }
        }
    }

    private function visitModel(Model $model): void
    {
        $id = spl_object_id($model);

        if (!isset($this->models[$id])) {
            $this->models[$id] = $model;

            foreach ($model->getRelations() as $related) {
                $this->visit($related);
            }
        }
    }
}
